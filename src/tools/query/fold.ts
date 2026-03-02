/**
 * Generic fold over the lowered expression AST.
 *
 * Provides a typed AST, a pluggable backend interface, and a single
 * recursive fold function that dispatches to backend methods.
 */

import { type EntityType, isArrayVar } from './variables.js';

// ── Typed AST Nodes ─────────────────────────────────────────────────────

export type LoweredExpr =
  | string
  | number
  | boolean
  | null
  | { var: string }
  | { type: 'date'; value: string }
  | { op: string; args: LoweredExpr[] }
  | LoweredExpr[];

// ── Backend Interface ───────────────────────────────────────────────────

export interface ExprBackend<T> {
  // Leaves
  literal(value: string | number | boolean | null): T;
  variable(name: string, entity: EntityType): T;
  dateLiteral(isoDate: string): T;
  arrayLiteral(elements: T[]): T;

  // Logical
  and(args: T[]): T;
  or(args: T[]): T;
  not(arg: T): T;

  // Comparison (6 ops grouped)
  comparison(op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte', left: T, right: T): T;

  // Range
  between(value: T, low: T, high: T): T;

  // Set membership
  inArray(value: T, array: T): T;

  // String/array ops
  contains(haystack: T, needle: T, haystackIsArray: boolean): T;
  startsWith(str: T, prefix: T): T;
  endsWith(str: T, suffix: T): T;
  matches(str: T, pattern: string): T;

  // Date arithmetic
  offset(date: T, days: number): T;

  // Structural scoping
  container(
    type: 'project' | 'folder' | 'tag',
    subExpr: LoweredExpr,
    fromEntity: EntityType,
    toEntity: EntityType,
    fold: (node: LoweredExpr, entity: EntityType) => T
  ): T;
}

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
    const opNode = obj as { op: string; args: LoweredExpr[] };
    const { op, args } = opNode;

    // Helper to fold child nodes
    const f = (n: LoweredExpr) => foldExpr(n, backend, entity);

    switch (op) {
      case 'and':
        return backend.and(args.map(f));

      case 'or':
        return backend.or(args.map(f));

      case 'not':
        return backend.not(f(args[0]));

      case 'eq':
      case 'neq':
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        return backend.comparison(op, f(args[0]), f(args[1]));

      case 'between':
        return backend.between(f(args[0]), f(args[1]), f(args[2]));

      case 'in':
        return backend.inArray(f(args[0]), f(args[1]));

      case 'contains': {
        const haystackIsArray = isArrayVarNode(args[0], entity);
        return backend.contains(f(args[0]), f(args[1]), haystackIsArray);
      }

      case 'startsWith':
        return backend.startsWith(f(args[0]), f(args[1]));

      case 'endsWith':
        return backend.endsWith(f(args[0]), f(args[1]));

      case 'matches': {
        // Second arg is the raw pattern string (not folded)
        const pattern = args[1] as string;
        return backend.matches(f(args[0]), pattern);
      }

      case 'offset': {
        return backend.offset(f(args[0]), args[1] as number);
      }

      case 'container': {
        // args[0] is "project", "folder", or "tag"; args[1] is the sub-expression
        const containerType = args[0] as unknown as 'project' | 'folder' | 'tag';
        const subExpr = args[1];

        // Determine target entity for the container scope
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

      default:
        throw new Error(`Unknown operation in fold: "${op}"`);
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
