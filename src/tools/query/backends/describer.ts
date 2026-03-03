/**
 * Describer Backend.
 *
 * ExprBackend<string> that produces human-readable English descriptions
 * from lowered expression ASTs.
 *
 * The public API operates on compact syntax (pre-lowering) so descriptions
 * match what agents actually wrote. The backend walks the lowered form.
 */

import { type ExprBackend, type LoweredExpr, foldExpr } from '../fold.js';
import { type EntityType } from '../variables.js';
import { lowerExpr } from '../lower.js';

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Describe a compact-syntax expression as readable English.
 * Lowers to internal AST, then folds through the describer backend.
 */
export function describeExpr(node: unknown): string {
  // Handle the compact syntax directly for special nodes that
  // have nicer descriptions pre-lowering (offset, date)
  const preDesc = describeCompactNode(node);
  if (preDesc !== null) return preDesc;

  // Lower and fold
  const lowered = lowerExpr(node);
  const backend = new DescriberBackend();
  return foldExpr(lowered, backend, 'tasks');
}

/**
 * Describe a sort specification as a suffix string.
 */
export function describeSort(sort: { by: string; direction?: 'asc' | 'desc' }): string {
  return `sorted by ${sort.by} ${sort.direction || 'asc'}`;
}

// ── Pre-lowering Compact Syntax Description ─────────────────────────────

/**
 * Describe special compact-syntax nodes that are better described before lowering.
 * Returns null if the node should be lowered and folded normally.
 */
function describeCompactNode(node: unknown): string | null {
  if (node == null) return 'null';
  if (typeof node === 'string') return `"${node}"`;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'boolean') return String(node);

  if (Array.isArray(node)) {
    return `[${node.map(el => describeCompactNode(el) ?? describeExpr(el)).join(', ')}]`;
  }

  if (typeof node !== 'object') return String(node);

  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);

  // {var: "name"} → "name"
  if ('var' in obj) return String(obj.var);

  // {date: "2026-03-01"} → "2026-03-01"
  if ('date' in obj && keys.length === 1) return String(obj.date);

  // {offset: {date, days}} → human-readable
  if ('offset' in obj && keys.length === 1) {
    return describeOffset(obj.offset);
  }

  // {type: "date", value: "..."} — internal typed literal
  if ('type' in obj && 'value' in obj) return String(obj.value);

  // For operations, use the compact syntax keys for description
  if (keys.length === 1) {
    const opName = keys[0];
    const args = obj[opName];
    if (Array.isArray(args)) {
      return describeCompactOp(opName, args);
    }
  }

  return null;
}

function describeCompactOp(op: string, args: unknown[]): string | null {
  const d = (node: unknown) => describeCompactNode(node) ?? describeExpr(node);

  switch (op) {
    case 'and':
      return args.map(a => `(${d(a)})`).join(' AND ');
    case 'or':
      return args.map(a => `(${d(a)})`).join(' OR ');
    case 'not':
      return `NOT (${d(args[0])})`;
    case 'eq':
      return `${d(args[0])} = ${d(args[1])}`;
    case 'neq':
      return `${d(args[0])} != ${d(args[1])}`;
    case 'gt':
      return `${d(args[0])} > ${d(args[1])}`;
    case 'gte':
      return `${d(args[0])} >= ${d(args[1])}`;
    case 'lt':
      return `${d(args[0])} < ${d(args[1])}`;
    case 'lte':
      return `${d(args[0])} <= ${d(args[1])}`;
    case 'in':
      return `${d(args[0])} in ${d(args[1])}`;
    case 'between':
      return `${d(args[0])} between ${d(args[1])} and ${d(args[2])}`;
    case 'container':
      return `in ${args[0]} where ${d(args[1])}`;
    case 'containing':
      return `containing ${args[0]} where ${d(args[1])}`;
    case 'contains':
      return `${d(args[0])} contains ${d(args[1])}`;
    case 'startsWith':
      return `${d(args[0])} starts with ${d(args[1])}`;
    case 'endsWith':
      return `${d(args[0])} ends with ${d(args[1])}`;
    case 'matches':
      return `${d(args[0])} matches ${d(args[1])}`;
    case 'isNull':
      return `${d(args[0])} is null`;
    case 'isNotNull':
      return `${d(args[0])} is not null`;
    case 'notIn':
      return `${d(args[0])} not in ${d(args[1])}`;
    case 'count':
      return `count(${d(args[0])})`;
    default:
      return `${op}(${args.map(a => d(a)).join(', ')})`;
  }
}

function describeOffset(value: unknown): string {
  if (typeof value !== 'object' || value == null) return 'offset(?)';

  const offset = value as Record<string, unknown>;
  const days = offset.days as number;
  const dateField = offset.date;

  let base: string;
  if (dateField === 'now') {
    base = 'now';
  } else if (typeof dateField === 'object' && dateField != null && 'var' in (dateField as Record<string, unknown>)) {
    base = String((dateField as Record<string, unknown>).var);
  } else if (typeof dateField === 'string') {
    base = dateField;
  } else {
    base = '?';
  }

  const absDays = Math.abs(days);
  const unit = absDays === 1 ? 'day' : 'days';

  if (base === 'now') {
    if (days < 0) return `${absDays} ${unit} ago`;
    if (days > 0) return `${absDays} ${unit} from now`;
    return 'now';
  }

  if (days < 0) return `${absDays} ${unit} before ${base}`;
  if (days > 0) return `${absDays} ${unit} after ${base}`;
  return base;
}

// ── Describer Backend (for lowered AST fold) ────────────────────────────

class DescriberBackend implements ExprBackend<string> {
  literal(value: string | number | boolean | null): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return `"${value}"`;
    return String(value);
  }

  variable(name: string): string {
    return name;
  }

  dateLiteral(isoDate: string): string {
    return isoDate;
  }

  arrayLiteral(elements: string[]): string {
    return `[${elements.join(', ')}]`;
  }

  and(args: string[]): string {
    if (args.length === 0) return 'true';
    return args.map(a => `(${a})`).join(' AND ');
  }

  or(args: string[]): string {
    if (args.length === 0) return 'false';
    return args.map(a => `(${a})`).join(' OR ');
  }

  not(arg: string): string {
    return `NOT (${arg})`;
  }

  comparison(op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte', left: string, right: string): string {
    const symbol = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
    return `${left} ${symbol} ${right}`;
  }

  between(value: string, low: string, high: string): string {
    return `${value} between ${low} and ${high}`;
  }

  inArray(value: string, array: string): string {
    return `${value} in ${array}`;
  }

  contains(haystack: string, needle: string): string {
    return `${haystack} contains ${needle}`;
  }

  startsWith(str: string, prefix: string): string {
    return `${str} starts with ${prefix}`;
  }

  endsWith(str: string, suffix: string): string {
    return `${str} ends with ${suffix}`;
  }

  matches(str: string, pattern: string): string {
    return `${str} matches "${pattern}"`;
  }

  count(arg: string): string {
    return `count(${arg})`;
  }

  isNull(arg: string): string {
    return `${arg} is null`;
  }

  isNotNull(arg: string): string {
    return `${arg} is not null`;
  }

  offset(date: string, days: number): string {
    const absDays = Math.abs(days);
    const unit = absDays === 1 ? 'day' : 'days';
    if (date === 'now') {
      if (days < 0) return `${absDays} ${unit} ago`;
      if (days > 0) return `${absDays} ${unit} from now`;
      return 'now';
    }
    if (days < 0) return `${absDays} ${unit} before ${date}`;
    if (days > 0) return `${absDays} ${unit} after ${date}`;
    return date;
  }

  container(
    type: 'project' | 'folder' | 'tag',
    subExpr: LoweredExpr,
    _fromEntity: EntityType,
    toEntity: EntityType,
    fold: (node: LoweredExpr, entity: EntityType) => string
  ): string {
    return `in ${type} where ${fold(subExpr, toEntity)}`;
  }

  containing(
    childEntity: EntityType,
    subExpr: LoweredExpr,
    _fromEntity: EntityType,
    fold: (node: LoweredExpr, entity: EntityType) => string
  ): string {
    return `containing ${childEntity} where ${fold(subExpr, childEntity)}`;
  }
}
