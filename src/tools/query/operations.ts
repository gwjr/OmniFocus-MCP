/**
 * Operation metadata registry.
 * Defines validation rules for each operation. Compilation logic is in compiler.ts.
 *
 * 17 operations in compact syntax: op name is the object key, args are the value.
 * e.g. {and: [expr, expr]}, {contains: [varRef, "pattern"]}
 */

export interface OpMeta {
  /** Minimum number of arguments (for array-valued ops) */
  minArgs: number;
  /** Maximum number of arguments (-1 = unlimited) */
  maxArgs: number;
  /** Brief description for error messages */
  description: string;
}

export const operations: Record<string, OpMeta> = {
  // Logical
  and:          { minArgs: 2, maxArgs: -1, description: 'Logical AND (2+ boolean args)' },
  or:           { minArgs: 2, maxArgs: -1, description: 'Logical OR (2+ boolean args)' },
  not:          { minArgs: 1, maxArgs: 1,  description: 'Logical NOT (1 boolean arg)' },

  // Comparison
  eq:           { minArgs: 2, maxArgs: 2,  description: 'Equals (2 args)' },
  neq:          { minArgs: 2, maxArgs: 2,  description: 'Not equals (2 args)' },
  gt:           { minArgs: 2, maxArgs: 2,  description: 'Greater than (2 args)' },
  gte:          { minArgs: 2, maxArgs: 2,  description: 'Greater than or equal (2 args)' },
  lt:           { minArgs: 2, maxArgs: 2,  description: 'Less than (2 args)' },
  lte:          { minArgs: 2, maxArgs: 2,  description: 'Less than or equal (2 args)' },

  // Range
  between:      { minArgs: 3, maxArgs: 3,  description: 'Between range (inclusive): {between: [value, min, max]}' },

  // Value-in-array
  in:           { minArgs: 2, maxArgs: 2,  description: 'Value in array ({in: [valueExpr, [array]]})' },

  // Container scoping
  container:    { minArgs: 2, maxArgs: 2,  description: 'Container scoping ({container: ["project"|"folder"|"tag", expr]})' },
  containing:   { minArgs: 2, maxArgs: 2,  description: 'Reverse container ({containing: ["tasks"|"projects", predicate]}) — parent entities containing matching children' },

  // String (case-insensitive) — contains is polymorphic (string or array)
  contains:     { minArgs: 2, maxArgs: 2,  description: 'String/array contains (case-insensitive)' },
  startsWith:   { minArgs: 2, maxArgs: 2,  description: 'String starts with (case-insensitive)' },
  endsWith:     { minArgs: 2, maxArgs: 2,  description: 'String ends with (case-insensitive)' },
  matches:      { minArgs: 2, maxArgs: 2,  description: 'Regex match (case-insensitive)' },

  // Array functions
  count:        { minArgs: 1, maxArgs: 1,  description: 'Array length ({count: [arrayExpr]}) — returns 0 for null/non-array' },

  // Null checks
  isNull:       { minArgs: 1, maxArgs: 1,  description: 'True when value is null/undefined ({isNull: [expr]})' },
  isNotNull:    { minArgs: 1, maxArgs: 1,  description: 'True when value is not null/undefined ({isNotNull: [expr]})' },

  // Set non-membership (sugar for not(in(...)))
  notIn:        { minArgs: 2, maxArgs: 2,  description: 'Value not in array ({notIn: [valueExpr, [array]]}) — desugars to not(in(...))' },
};

// Note: 'offset' is a special node type (object with named fields), not an array-args op.
// It's handled directly by the compiler's node dispatch, not through this registry.

export const ALL_OPS = Object.keys(operations).sort();

/**
 * Validate argument count for an operation.
 * Returns an error message string if invalid, null if valid.
 */
export function validateArgCount(op: string, argCount: number, path: string): string | null {
  const meta = operations[op];
  if (!meta) return null; // unknown op handled elsewhere

  if (argCount < meta.minArgs) {
    return `Operation "${op}" requires at least ${meta.minArgs} argument${meta.minArgs !== 1 ? 's' : ''}, got ${argCount} at ${path}`;
  }
  if (meta.maxArgs !== -1 && argCount > meta.maxArgs) {
    return `Operation "${op}" requires at most ${meta.maxArgs} argument${meta.maxArgs !== 1 ? 's' : ''}, got ${argCount} at ${path}`;
  }
  return null;
}
