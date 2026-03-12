/**
 * Lowering pass: compact syntax → internal {op, args} AST.
 *
 * Compact syntax uses the op name as the object key:
 *   {contains: [{var: "name"}, "test"]}
 *
 * Internal AST uses {op, args} nodes:
 *   {op: "contains", args: [{var: "name"}, "test"]}
 *
 * Special compact nodes:
 *   {var: "name"}        → {var: "name"}           (pass-through)
 *   {date: "2026-03-01"} → {type: "date", value: "2026-03-01"}
 *   {offset: {date: "now", days: -3}} → {op: "offset", args: [dateExpr, days]}
 *
 * The lowering is recursive and preserves primitives unchanged.
 */

import { operations, validateArgCount } from './operations.js';
import type { LoweredExpr, FoldOp } from './fold.js';

export class LowerError extends Error {
  constructor(message: string, public path: string, public node: unknown) {
    super(message);
    this.name = 'LowerError';
  }
}

/**
 * Lower a compact-syntax expression tree into internal {op, args} AST.
 */
export function lowerExpr(node: unknown, path = 'where'): LoweredExpr {
  // null / undefined → pass through
  if (node == null) return null;

  // Primitives pass through
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return node;
  if (typeof node === 'boolean') return node;

  // Array → recurse into elements
  if (Array.isArray(node)) {
    return node.map((el, i) => lowerExpr(el, `${path}[${i}]`));
  }

  // Object nodes — dispatch on shape
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj);

    // Reject old-style {op, args} with helpful error
    if ('op' in obj) {
      throw new LowerError(
        `Old-style {op: "${obj.op}", args: [...]} syntax is no longer supported. ` +
        `Use compact syntax instead: {"${obj.op}": [...]}. ` +
        `Example: {contains: [{var: "name"}, "test"]}`,
        path,
        node
      );
    }

    // {var: "name"} — variable reference, pass through
    if ('var' in obj) {
      if (typeof obj.var !== 'string') {
        throw new LowerError('Variable reference "var" must be a string', path, node);
      }
      return { var: obj.var };
    }

    // {date: "2026-03-01"} — date literal → {type: "date", value: "..."}
    if ('date' in obj && keys.length === 1) {
      if (typeof obj.date !== 'string') {
        throw new LowerError(
          'Date literal "date" must be a string (e.g. {date: "2026-03-01"})',
          path, node
        );
      }
      return { type: 'date', value: obj.date };
    }

    // {offset: {date: ..., days: N}} — offset date producer
    if ('offset' in obj && keys.length === 1) {
      return lowerOffset(obj.offset, path);
    }

    // {type: "date", value: "..."} — internal typed literal, pass through
    // (for internal use / round-tripping)
    if ('type' in obj && 'value' in obj) {
      return node as LoweredExpr;
    }

    // Single-key object where key is a known op → {op, args}
    if (keys.length === 1) {
      const opName = keys[0];
      if (opName in operations) {
        const args = obj[opName];
        if (!Array.isArray(args)) {
          throw new LowerError(
            `Operation "${opName}" value must be an array of arguments. ` +
            `Got ${typeof args}. Example: {${opName}: [arg1, arg2]}`,
            path, node
          );
        }
        // Recurse into args
        const loweredArgs = args.map((a: unknown, i: number) =>
          lowerExpr(a, `${path}.${opName}[${i}]`)
        );

        // Validate arg count
        const argError = validateArgCount(opName, loweredArgs.length, path);
        if (argError) throw new LowerError(argError, path, node);

        // Type-specific validation
        if (opName === 'in') {
          if (!Array.isArray(loweredArgs[1])) {
            throw new LowerError(
              'Second argument to "in" must be an array literal (e.g. ["Active","OnHold"]). ' +
              'For container scoping, use "container" instead.',
              `${path}.in[1]`, node
            );
          }
        }
        if (opName === 'notIn') {
          if (!Array.isArray(loweredArgs[1])) {
            throw new LowerError(
              'Second argument to "notIn" must be an array literal (e.g. ["Active","OnHold"]).',
              `${path}.notIn[1]`, node
            );
          }
          // Desugar notIn to not(in(...)) at lower time
          return { op: 'not', args: [{ op: 'in', args: loweredArgs }] };
        }
        if (opName === 'matches') {
          if (typeof loweredArgs[1] !== 'string') {
            throw new LowerError(
              'Second argument to "matches" must be a regex pattern string',
              `${path}.matches[1]`, node
            );
          }
        }
        if (opName === 'container') {
          if (typeof loweredArgs[0] !== 'string' || (loweredArgs[0] !== 'project' && loweredArgs[0] !== 'folder' && loweredArgs[0] !== 'tag')) {
            throw new LowerError(
              'First argument to "container" must be "project", "folder", or "tag"',
              `${path}.container[0]`, node
            );
          }
        }
        if (opName === 'containing') {
          if (typeof loweredArgs[0] !== 'string') {
            throw new LowerError(
              'First argument to "containing" must be a child entity name (e.g. "tasks", "projects")',
              `${path}.containing[0]`, node
            );
          }
        }
        if (opName === 'similar') {
          if (typeof loweredArgs[0] !== 'string') {
            throw new LowerError(
              'similar requires a string query argument (e.g. {similar: ["search terms"]})',
              `${path}.similar[0]`, node
            );
          }
          if (loweredArgs.length > 1) {
            if (typeof loweredArgs[1] !== 'number' || loweredArgs[1] < 0 || loweredArgs[1] > 100) {
              throw new LowerError(
                'similar threshold must be a number 0-100 (e.g. {similar: ["query", 60]})',
                `${path}.similar[1]`, node
              );
            }
          }
        }

        return { op: opName as FoldOp, args: loweredArgs };
      }
    }

    // Unknown shape
    const knownOps = Object.keys(operations).join(', ');
    throw new LowerError(
      `Unrecognized node shape with key${keys.length > 1 ? 's' : ''} "${keys.join('", "')}". ` +
      `Expected: {var: "field"}, {date: "YYYY-MM-DD"}, {offset: {...}}, ` +
      `or an operation: {${knownOps}}`,
      path, node
    );
  }

  throw new LowerError(`Unsupported node type: ${typeof node}`, path, node);
}

// ── Offset Lowering ──────────────────────────────────────────────────────

function lowerOffset(value: unknown, parentPath: string): LoweredExpr {
  const path = `${parentPath}.offset`;

  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    throw new LowerError(
      'Offset must be an object with {date, days} fields. ' +
      'Example: {offset: {date: "now", days: -3}}',
      path, value
    );
  }

  const offset = value as Record<string, unknown>;

  if (!('date' in offset)) {
    throw new LowerError(
      'Offset requires a "date" field. ' +
      'Example: {offset: {date: "now", days: -3}}',
      path, value
    );
  }

  if (!('days' in offset)) {
    throw new LowerError(
      'Offset requires a "days" field (integer). ' +
      'Example: {offset: {date: "now", days: -3}}',
      path, value
    );
  }

  if (typeof offset.days !== 'number' || !Number.isInteger(offset.days)) {
    throw new LowerError(
      `Offset "days" must be an integer, got ${JSON.stringify(offset.days)}`,
      path, value
    );
  }

  // Lower the date field:
  // - "now" → {var: "now"}
  // - "YYYY-MM-DD" string → {type: "date", value: "..."}
  // - {var: "field"} → pass through
  let datePart: unknown;
  if (typeof offset.date === 'string') {
    if (offset.date === 'now') {
      datePart = { var: 'now' };
    } else {
      datePart = { type: 'date', value: offset.date };
    }
  } else if (
    typeof offset.date === 'object' && offset.date != null &&
    'var' in (offset.date as Record<string, unknown>)
  ) {
    datePart = offset.date;
  } else {
    throw new LowerError(
      'Offset "date" must be "now", a "YYYY-MM-DD" string, or {var: "fieldName"}. ' +
      `Got ${JSON.stringify(offset.date)}`,
      path, value
    );
  }

  // Produce internal offset node
  return { op: 'offset', args: [datePart as LoweredExpr, offset.days as number] };
}
