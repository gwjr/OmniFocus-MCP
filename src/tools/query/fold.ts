/**
 * Generic fold over the lowered expression AST.
 *
 * Provides a typed AST, a pluggable backend interface, and a single
 * recursive fold function that dispatches to backend methods.
 */

import { type EntityType, isArrayVar } from './variables.js';
import { type RawOp } from './operations.js';

// ── FoldOp: all ops that reach foldExpr ──────────────────────────────────
// operations.ts ops minus desugared ones (notIn), plus synthetic ops (offset).

export type FoldOp = Exclude<RawOp, 'notIn'> | 'offset';

// ── Typed AST Nodes ─────────────────────────────────────────────────────

export type LoweredExpr =
  | string
  | number
  | boolean
  | null
  | { var: string }
  | { type: 'date'; value: string }
  | { op: FoldOp; args: LoweredExpr[] }
  | LoweredExpr[];

// ── Backend Interface ───────────────────────────────────────────────────

/** Leaf-node handlers (not operations). */
export interface LeafHandlers<T> {
  literal(value: string | number | boolean | null): T;
  variable(name: string, entity: EntityType): T;
  dateLiteral(isoDate: string): T;
  arrayLiteral(elements: T[]): T;
}

/** Per-op typed registry: each FoldOp maps to its handler signature. */
export type OpSpec<T> = {
  [K in FoldOp]:
    K extends 'and' | 'or'
      ? (args: T[]) => T :
    K extends 'not' | 'count' | 'isNull' | 'isNotNull' | 'similar'
      ? (arg: T) => T :
    K extends 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
         | 'in' | 'startsWith' | 'endsWith'
      ? (left: T, right: T) => T :
    K extends 'between'
      ? (value: T, low: T, high: T) => T :
    K extends 'contains'
      ? (haystack: T, needle: T, haystackIsArray: boolean) => T :
    K extends 'matches'
      ? (str: T, pattern: string) => T :
    K extends 'offset'
      ? (date: T, days: number) => T :
    K extends 'container'
      ? (type: 'project'|'folder'|'tag', subExpr: LoweredExpr,
         fromEntity: EntityType, toEntity: EntityType,
         fold: (node: LoweredExpr, entity: EntityType) => T) => T :
    K extends 'containing'
      ? (childEntity: EntityType, subExpr: LoweredExpr,
         fromEntity: EntityType,
         fold: (node: LoweredExpr, entity: EntityType) => T) => T :
    never;
};

/** Backend = leaf handlers + per-op handlers. */
export type ExprBackend<T> = LeafHandlers<T> & OpSpec<T>;

// ── Fold ────────────────────────────────────────────────────────────────

/**
 * Recursively fold a lowered AST node through a backend, producing a value of type T.
 */
export function foldExpr<T>(node: LoweredExpr, backend: ExprBackend<T>, entity: EntityType): T {
  // Primitives
  if (node === null) return backend.literal(null);
  if (node === undefined) throw new Error('Unexpected undefined in AST — check lowering');
  if (typeof node === 'string') return backend.literal(node);
  if (typeof node === 'number') return backend.literal(node);
  if (typeof node === 'boolean') return backend.literal(node);

  // Array literal
  if (Array.isArray(node)) {
    return backend.arrayLiteral(node.map(el => foldExpr(el, backend, entity)));
  }

  // Object nodes
  const obj = node as Record<string, unknown>;

  // Variable reference
  if ('var' in obj) {
    return backend.variable((obj as { var: string }).var, entity);
  }

  // Typed date literal
  if ('type' in obj && obj.type === 'date') {
    return backend.dateLiteral((obj as { type: 'date'; value: string }).value);
  }

  // Operation node
  if ('op' in obj) {
    const opNode = obj as { op: FoldOp; args: LoweredExpr[] };
    const { op, args } = opNode;

    // Helper to fold child nodes
    const f = (n: LoweredExpr) => foldExpr(n, backend, entity);

    switch (op) {
      // ── Variadic ──
      case 'and': case 'or':
        return backend[op](args.map(f));

      // ── Unary ──
      case 'not': case 'count': case 'isNull': case 'isNotNull': case 'similar':
        return backend[op](f(args[0]));

      // ── Binary (fold both) ──
      case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte':
      case 'in': case 'startsWith': case 'endsWith':
        return backend[op](f(args[0]), f(args[1]));

      // ── Ternary ──
      case 'between':
        return backend.between(f(args[0]), f(args[1]), f(args[2]));

      // ── Special arg prep ──
      case 'contains': {
        const haystackIsArray = isArrayVarNode(args[0], entity);
        return backend.contains(f(args[0]), f(args[1]), haystackIsArray);
      }

      case 'matches':
        return backend.matches(f(args[0]), args[1] as string);

      case 'offset':
        return backend.offset(f(args[0]), args[1] as number);

      case 'container': {
        const containerType = args[0] as unknown as 'project' | 'folder' | 'tag';
        const subExpr = args[1];
        const toEntityMap: Record<string, EntityType> = {
          project: 'projects',
          folder: 'folders',
          tag: 'tags',
        };
        const toEntity = toEntityMap[containerType];
        return backend.container(
          containerType,
          subExpr,
          entity,
          toEntity,
          (sub: LoweredExpr, ent: EntityType) => foldExpr(sub, backend, ent)
        );
      }

      case 'containing': {
        const childEntity = args[0] as unknown as EntityType;
        const subExpr = args[1];
        return backend.containing(
          childEntity,
          subExpr,
          entity,
          (sub: LoweredExpr, ent: EntityType) => foldExpr(sub, backend, ent)
        );
      }

      default: {
        const _exhaustive: never = op;
        throw new Error(`Unknown operation in fold: "${_exhaustive}"`);
      }
    }
  }

  throw new Error(`Unrecognized AST node in fold: ${JSON.stringify(node)}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Check if a node is a variable reference to an array-typed variable.
 */
function isArrayVarNode(node: LoweredExpr, entity: EntityType): boolean {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
  if (!('var' in node)) return false;
  return isArrayVar((node as { var: string }).var, entity);
}
