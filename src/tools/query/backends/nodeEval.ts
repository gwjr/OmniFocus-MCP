/**
 * Node-side Evaluator Backend.
 *
 * ExprBackend<(row: Row) => unknown> that produces closures for evaluating
 * expressions against bulk-read row objects in Node.js.
 *
 * Each method returns a function that takes a row and returns a value.
 * The top-level result should be coerced to boolean via !!.
 */

import { type ExprBackend, type LoweredExpr, foldExpr } from '../fold.js';
import { getVarRegistry, type EntityType } from '../variables.js';

// ── Types ───────────────────────────────────────────────────────────────

export type Row = Record<string, unknown>;
export type RowFn = (row: Row) => unknown;

// ── Public API ──────────────────────────────────────────────────────────

export interface NodeEvalOptions {
  /** Variables to stub as true (for two-phase filtering) */
  stubVars?: Set<string>;
}

/**
 * Create a NodeEval backend instance.
 */
export function createNodeEvalBackend(options?: NodeEvalOptions): ExprBackend<RowFn> {
  return new NodeEvalBackend(options);
}

/**
 * Compile a lowered AST into a row predicate function.
 */
export function compileNodePredicate(
  ast: LoweredExpr,
  entity: EntityType,
  options?: NodeEvalOptions
): RowFn {
  const backend = new NodeEvalBackend(options);
  return foldExpr(ast, backend, entity);
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Convert a value to a timestamp (milliseconds since epoch), or null.
 * Handles Date objects, ISO 8601 strings, and numbers (pass through).
 */
function toTime(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  return null;
}

/**
 * Normalize a value for comparison. Converts dates to timestamps
 * and strings to lowercase for case-insensitive comparison.
 */
// ISO 8601 date pattern — only match actual date strings, not words like "Monday"
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function normalize(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    // Only parse as date if it looks like ISO 8601
    if (ISO_DATE_RE.test(v)) {
      const t = toTime(v);
      if (t !== null) return t;
    }
    return v.toLowerCase();
  }
  // Date objects, etc.
  const t = toTime(v);
  if (t !== null) return t;
  return v;
}

/**
 * Null-safe equality. Dates compared by timestamp, strings case-insensitive.
 */
function safeEq(a: unknown, b: unknown): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  return na === nb;
}

/**
 * Null-safe ordered comparison. Returns null if either side is null.
 */
function safeCompare(a: unknown, b: unknown): number | null {
  const na = normalize(a);
  const nb = normalize(b);
  if (na == null || nb == null) return null;
  if (typeof na === 'number' && typeof nb === 'number') return na - nb;
  if (typeof na === 'string' && typeof nb === 'string') return na < nb ? -1 : na > nb ? 1 : 0;
  return null;
}

// ── NodeEval Backend ────────────────────────────────────────────────────

class NodeEvalBackend {
  private stubVars: Set<string>;

  constructor(options?: NodeEvalOptions) {
    this.stubVars = options?.stubVars ?? new Set();
  }

  // ── Leaves ──────────────────────────────────────────────────────────

  literal(value: string | number | boolean | null): RowFn {
    return () => value;
  }

  variable(name: string, entity: EntityType): RowFn {
    // Stubbed variables return true (for two-phase filtering)
    if (this.stubVars.has(name)) {
      return () => true;
    }

    // Special: 'now' returns current timestamp
    if (name === 'now') {
      const now = Date.now();
      return () => now;
    }

    // Look up the variable definition to get the row key.
    // For computed vars, AddSwitch writes to the var name (e.g. 'taskStatus'),
    // not the nodeKey (e.g. 'status'). Use the var name for computed vars
    // to match the column name in the row.
    const registry = getVarRegistry(entity);
    const varDef = registry[name];
    if (!varDef) {
      throw new Error(`Unknown variable "${name}" for entity "${entity}"`);
    }

    const key = varDef.cost === 'computed' ? name : varDef.nodeKey;
    return (row) => row[key];
  }

  dateLiteral(isoDate: string): RowFn {
    const ts = Date.parse(isoDate);
    return () => ts;
  }

  arrayLiteral(elements: RowFn[]): RowFn {
    return (row) => elements.map(fn => fn(row));
  }

  // ── Logical ─────────────────────────────────────────────────────────

  and(args: RowFn[]): RowFn {
    return (row) => args.every(fn => !!fn(row));
  }

  or(args: RowFn[]): RowFn {
    return (row) => args.some(fn => !!fn(row));
  }

  not(arg: RowFn): RowFn {
    return (row) => !arg(row);
  }

  // ── Comparison ──────────────────────────────────────────────────────

  eq(left: RowFn, right: RowFn): RowFn {
    return (row) => safeEq(left(row), right(row));
  }

  neq(left: RowFn, right: RowFn): RowFn {
    return (row) => !safeEq(left(row), right(row));
  }

  gt(left: RowFn, right: RowFn): RowFn {
    return (row) => { const c = safeCompare(left(row), right(row)); return c !== null && c > 0; };
  }

  gte(left: RowFn, right: RowFn): RowFn {
    return (row) => { const c = safeCompare(left(row), right(row)); return c !== null && c >= 0; };
  }

  lt(left: RowFn, right: RowFn): RowFn {
    return (row) => { const c = safeCompare(left(row), right(row)); return c !== null && c < 0; };
  }

  lte(left: RowFn, right: RowFn): RowFn {
    return (row) => { const c = safeCompare(left(row), right(row)); return c !== null && c <= 0; };
  }

  // ── Range ───────────────────────────────────────────────────────────

  between(value: RowFn, low: RowFn, high: RowFn): RowFn {
    return (row) => {
      const v = normalize(value(row));
      const lo = normalize(low(row));
      const hi = normalize(high(row));
      if (v == null || lo == null || hi == null) return false;
      return v >= lo && v <= hi;
    };
  }

  // ── Set Membership ──────────────────────────────────────────────────

  'in'(value: RowFn, array: RowFn): RowFn {
    // Pre-normalize static arrays at compile time
    const staticArr = tryStaticArray(array);
    if (staticArr) {
      const normalized = staticArr.map(normalize);
      return (row) => {
        const nv = normalize(value(row));
        return normalized.includes(nv);
      };
    }
    return (row) => {
      const v = value(row);
      const arr = array(row);
      if (!Array.isArray(arr)) return false;
      const nv = normalize(v);
      return arr.some(el => normalize(el) === nv);
    };
  }

  // ── String/Array Ops ────────────────────────────────────────────────

  contains(haystack: RowFn, needle: RowFn, haystackIsArray: boolean): RowFn {
    if (haystackIsArray) {
      return (row) => {
        const arr = haystack(row);
        if (arr === true) return true;  // stub → permissive
        const n = needle(row);
        if (!Array.isArray(arr) || n == null) return false;
        const ln = typeof n === 'string' ? n.toLowerCase() : n;
        return arr.some(el => (typeof el === 'string' ? el.toLowerCase() : el) === ln);
      };
    }
    return (row) => {
      const h = haystack(row);
      if (h === true) return true;  // stub → permissive
      const n = needle(row);
      if (h == null || typeof h !== 'string') return false;
      if (n == null) return false;
      return h.toLowerCase().includes(String(n).toLowerCase());
    };
  }

  startsWith(str: RowFn, prefix: RowFn): RowFn {
    return (row) => {
      const s = str(row);
      if (s === true) return true;  // stub → permissive
      const p = prefix(row);
      if (s == null || typeof s !== 'string') return false;
      if (p == null) return false;
      return s.toLowerCase().startsWith(String(p).toLowerCase());
    };
  }

  endsWith(str: RowFn, suffix: RowFn): RowFn {
    return (row) => {
      const s = str(row);
      if (s === true) return true;  // stub → permissive
      const sfx = suffix(row);
      if (s == null || typeof s !== 'string') return false;
      if (sfx == null) return false;
      return s.toLowerCase().endsWith(String(sfx).toLowerCase());
    };
  }

  matches(str: RowFn, pattern: string): RowFn {
    const re = new RegExp(pattern, 'i');
    return (row) => {
      const s = str(row);
      if (s === true) return true;  // stub → permissive
      if (s == null || typeof s !== 'string') return false;
      return re.test(s);
    };
  }

  // ── Null Checks ─────────────────────────────────────────────────────

  isNull(arg: RowFn): RowFn {
    return (row) => arg(row) == null;
  }

  isNotNull(arg: RowFn): RowFn {
    return (row) => arg(row) != null;
  }

  // ── Array Functions ──────────────────────────────────────────────────

  count(arg: RowFn): RowFn {
    return (row) => {
      const v = arg(row);
      if (v == null) return 0;
      if (!Array.isArray(v)) throw new Error(`count() requires an array, got ${typeof v}`);
      return v.length;
    };
  }

  // ── Date Arithmetic ─────────────────────────────────────────────────

  offset(date: RowFn, days: number): RowFn {
    const ms = days * 86400000;
    return (row) => {
      const t = toTime(date(row));
      if (t === null) return null;
      return t + ms;
    };
  }

  // ── Container Scoping ───────────────────────────────────────────────

  container(
    type: 'project' | 'folder' | 'tag',
    subExpr: LoweredExpr,
    _fromEntity: EntityType,
    toEntity: EntityType,
    fold: (node: LoweredExpr, entity: EntityType) => RowFn
  ): RowFn {
    // Tag containers require structural traversal not available in bulk-read rows.
    // The planner routes these to OmniJS fallback.
    if (type === 'tag') {
      throw new Error('Tag container evaluation is not supported in NodeEval — use OmniJS fallback');
    }

    // Project/folder containers are not valid for tags entity
    if (_fromEntity === 'tags') {
      throw new Error(`"container" with "${type}" is not valid for tags`);
    }

    if (type === 'project') {
      // For project containers, construct a virtual project row from the task's
      // project-prefixed fields.  The task row carries chain properties like
      // `projectName`, `projectId`, and may carry additional enriched fields
      // such as `projectStatus`, `projectFlagged`, etc.  We iterate the project
      // variable registry and map each nodeKey to the corresponding
      // `project`-prefixed key on the task row.
      const predicate = fold(subExpr, toEntity);
      const projRegistry = getVarRegistry('projects');
      const fieldMap: { projKey: string; nodeKey: string }[] = [];
      for (const [, varDef] of Object.entries(projRegistry)) {
        const nodeKey = varDef.nodeKey;
        const projKey = 'project' + nodeKey.charAt(0).toUpperCase() + nodeKey.slice(1);
        fieldMap.push({ projKey, nodeKey });
      }
      return (row) => {
        const projName = row.projectName;
        if (projName == null) return false;
        const projRow: Row = {};
        for (const { projKey, nodeKey } of fieldMap) {
          const val = row[projKey];
          if (val !== undefined) projRow[nodeKey] = val;
        }
        return !!predicate(projRow);
      };
    }

    if (type === 'folder') {
      // Folder containers require structural traversal not available in bulk-read rows.
      // The planner should route folder-container queries to OmniJS fallback.
      throw new Error('Folder container evaluation is not supported in NodeEval — use OmniJS fallback');
    }

    throw new Error(`Unknown container type: "${type}"`);
  }

  containing(): RowFn {
    throw new Error('"containing" should be extracted by the planner before NodeEval');
  }

  similar(_arg: RowFn): RowFn {
    throw new Error('similar() requires the semantic index — must be extracted by the planner before NodeEval');
  }
}

/**
 * Try to extract a static array from a RowFn. If the function is a constant
 * (always returns the same array regardless of row), return it.
 */
function tryStaticArray(fn: RowFn): unknown[] | null {
  try {
    const val = fn({});
    return Array.isArray(val) ? val : null;
  } catch {
    return null;
  }
}
