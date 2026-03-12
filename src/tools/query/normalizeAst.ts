/**
 * AST normalization pass.
 *
 * Transforms a lowered predicate AST to canonical form for stable pattern
 * matching in the planner and optimization passes.
 *
 * Transformations (applied recursively, bottom-up):
 *
 * 1. Flatten: `and(a, and(b, c))` → `and(a, b, c)`;
 *             `or(a, or(b, c))` → `or(a, b, c)`
 * 2. Collapse: `and(x)` → `x`; `or(x)` → `x`
 * 3. Double negation: `not(not(x))` → `x`
 * 4. LHS canonicalization: for comparisons, place the field reference (var)
 *    on the left and the constant on the right.
 *    - Symmetric ops (eq, neq, contains, startsWith, endsWith): swap args.
 *    - Ordering ops (gt, gte, lt, lte): swap args and flip the operator
 *      so that `gt(5, {var: "x"})` → `lt({var: "x"}, 5)`.
 * 5. Sort conjuncts/disjuncts within `and`/`or` by canonical tier:
 *    Tier 0 — simple comparisons (leaf-level): isNull, isNotNull,
 *              eq, neq, gt, gte, lt, lte, between, in,
 *              contains, startsWith, endsWith, matches
 *    Tier 1 — boolean NOT
 *    Tier 2 — nested boolean connectives (and, or)
 *    Tier 3 — structural predicates (container, containing)
 *    Tier 4 — aggregates (count)
 *
 *    Within tier 0: secondary sort by field name (id < index < name < α),
 *    then op name, then first literal value.
 *    Within tier 2: secondary sort by child count (ascending), then op name.
 *    Within tier 3: secondary sort by container type / child entity name.
 */

import type { LoweredExpr, FoldOp } from './fold.js';

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Normalize a lowered AST node to canonical form.
 * Idempotent: normalizing an already-normalized AST is a no-op.
 */
export function normalizeAst(node: LoweredExpr): LoweredExpr {
  // Primitives and leaves pass through unchanged
  if (node === null) return null;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return node;

  // Array literal — recurse into elements
  if (Array.isArray(node)) {
    return node.map(normalizeAst);
  }

  const obj = node as Record<string, unknown>;

  // Variable reference: {var: "name"} — pass through
  if ('var' in obj) return node;

  // Date literal: {type: "date", value: "..."} — pass through
  if ('type' in obj && obj.type === 'date') return node;

  // Op node
  if ('op' in obj) {
    const { op, args } = obj as { op: FoldOp; args: LoweredExpr[] };

    // Recurse first (bottom-up)
    const normArgs = args.map(normalizeAst);

    return normalizeOp(op, normArgs);
  }

  return node;
}

// ── Op normalization ──────────────────────────────────────────────────────

function normalizeOp(op: FoldOp, args: LoweredExpr[]): LoweredExpr {
  switch (op) {
    case 'and': {
      const flat = flattenSameOp(args, 'and');
      if (flat.length === 1) return flat[0];
      return { op: 'and', args: sortChildren(flat) };
    }

    case 'or': {
      const flat = flattenSameOp(args, 'or');
      if (flat.length === 1) return flat[0];
      return { op: 'or', args: sortChildren(flat) };
    }

    case 'not': {
      const inner = args[0];
      // Double negation elimination
      if (isOpNode(inner) && inner.op === 'not') {
        return inner.args[0];
      }
      return { op: 'not', args: [inner] };
    }

    // Single-element in → eq: {in: [var, ['x']]} → {eq: [var, 'x']}
    // Enables the tag-name semi-join shortcut for single-value in predicates.
    case 'in': {
      const [subject, collection] = args;
      if (Array.isArray(collection) && collection.length === 1) {
        return normalizeOp('eq', [subject, collection[0]]);
      }
      return { op, args };
    }

    // Symmetric comparisons: ensure field ref (var) on LHS
    case 'eq':
    case 'neq':
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      const [a, b] = args;
      if (isConstant(a) && isVar(b)) {
        return { op, args: [b, a] };
      }
      return { op, args };
    }

    // Ordering comparisons: ensure field ref on LHS, flip op if needed
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const [a, b] = args;
      if (isConstant(a) && isVar(b)) {
        return { op: flipOrdering(op as 'gt' | 'gte' | 'lt' | 'lte'), args: [b, a] };
      }
      return { op, args };
    }

    default:
      return { op, args };
  }
}

// ── Sorting ───────────────────────────────────────────────────────────────

/**
 * Sort children of and/or by canonical tier ordering.
 * Stable sort: equal keys preserve original relative order.
 */
function sortChildren(children: LoweredExpr[]): LoweredExpr[] {
  // Attach keys, sort, strip keys — preserves stability
  return children
    .map((c, i) => ({ node: c, key: childSortKey(c), idx: i }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.idx - b.idx)
    .map(({ node }) => node);
}

/**
 * Produce a lexicographically comparable sort key for a conjunct/disjunct.
 *
 * Key format: "<tier>_<op>_<field>_<value>"
 * All components are padded/prefixed for correct lexicographic ordering.
 */
function childSortKey(node: LoweredExpr): string {
  if (!isOpNode(node)) {
    // Bare primitives shouldn't appear here in practice, but handle gracefully
    return `0__${String(node)}`;
  }

  const { op } = node;
  const tier = String(opTier(op)).padStart(2, '0');
  const opPad = op.padEnd(12, '\x00');     // fixed-width for stable ordering
  const field = primaryFieldKey(node);
  const value = primaryLiteralKey(node);

  return `${tier}_${opPad}_${field}_${value}`;
}

/**
 * Assign a canonical tier to an op.
 *
 * 0 — simple comparisons (leaf-level predicates)
 * 1 — boolean NOT
 * 2 — boolean connectives (nested and/or)
 * 3 — structural predicates (container, containing)
 * 4 — aggregates (count)
 * 9 — unknown ops (sort last)
 */
function opTier(op: FoldOp): number {
  switch (op) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'between':
    case 'in':
    case 'contains':
    case 'startsWith':
    case 'endsWith':
    case 'matches':
    case 'isNull':
    case 'isNotNull':
      return 0;

    case 'not':
      return 1;

    case 'and':
    case 'or':
      return 2;

    case 'container':
    case 'containing':
      return 3;

    case 'count':
      return 4;

    default:
      return 9;
  }
}

/**
 * Primary field key for within-tier sorting.
 *
 * - For simple comparisons: the field name of the first var ref,
 *   using the canonical field ordering (id < index < name < everything else α).
 * - For boolean connectives (and/or): child count, padded.
 * - For structural predicates: the container type / child entity string.
 * - For others: empty string.
 */
function primaryFieldKey(node: { op: FoldOp; args: LoweredExpr[] }): string {
  const { op, args } = node;

  // Boolean connectives: sort by child count (fewer children first)
  if (op === 'and' || op === 'or') {
    return String(args.length).padStart(4, '0') + '_' + op;
  }

  // Structural: sort by container type / child entity name
  if (op === 'container' || op === 'containing') {
    const typeArg = args[0];
    return typeof typeArg === 'string' ? typeArg : '';
  }

  // For all other ops: first var reference in args
  for (const arg of args) {
    if (isVar(arg)) return fieldNameKey(arg.var);
  }

  return '';
}

/**
 * Primary literal key for within-field sorting.
 * Returns the first string/number/boolean literal found in args.
 */
function primaryLiteralKey(node: { op: FoldOp; args: LoweredExpr[] }): string {
  for (const arg of node.args) {
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number') return String(arg).padStart(20, '0');
    if (typeof arg === 'boolean') return String(arg);
  }
  return '';
}

/**
 * Canonical ordering key for a field name.
 * id < index < name < everything else (alphabetical).
 */
function fieldNameKey(name: string): string {
  switch (name) {
    case 'id':    return '0_id';
    case 'index': return '1_index';
    case 'name':  return '2_name';
    default:      return `3_${name}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function isOpNode(node: LoweredExpr): node is { op: FoldOp; args: LoweredExpr[] } {
  return (
    typeof node === 'object' &&
    node !== null &&
    !Array.isArray(node) &&
    'op' in (node as object)
  );
}

function isVar(node: LoweredExpr): node is { var: string } {
  return (
    typeof node === 'object' &&
    node !== null &&
    !Array.isArray(node) &&
    'var' in (node as object)
  );
}

/**
 * Returns true for values that are not variable references:
 * primitive literals, date literals, and array literals.
 * These are "constants" for the purpose of LHS canonicalization.
 */
function isConstant(node: LoweredExpr): boolean {
  if (node === null) return true;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return true;
  if (Array.isArray(node)) return true;
  // Date literal: {type: "date", value: "..."}
  if (typeof node === 'object' && 'type' in (node as object)) return true;
  return false;
}

function flattenSameOp(args: LoweredExpr[], op: FoldOp): LoweredExpr[] {
  const result: LoweredExpr[] = [];
  for (const arg of args) {
    if (isOpNode(arg) && arg.op === op) {
      result.push(...arg.args);
    } else {
      result.push(arg);
    }
  }
  return result;
}

function flipOrdering(op: 'gt' | 'gte' | 'lt' | 'lte'): 'gt' | 'gte' | 'lt' | 'lte' {
  switch (op) {
    case 'gt':  return 'lt';
    case 'gte': return 'lte';
    case 'lt':  return 'gt';
    case 'lte': return 'gte';
  }
}
