/**
 * Meta-test: verify every FoldOp dispatches through foldExpr on both backends.
 *
 * If a new op is added to operations.ts, the compile-time `never` assertion
 * in foldExpr catches missing switch cases. This test provides a runtime
 * safety net: it builds a minimal AST for every fold-reachable op and
 * confirms both backends handle it without throwing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileNodePredicate } from '../dist/tools/query/backends/nodeEval.js';
import { describeExpr } from '../dist/tools/query/backends/describer.js';
import { lowerExpr } from '../dist/tools/query/lower.js';
import { operations } from '../dist/tools/query/operations.js';

// ── Minimal compact-syntax AST per op ─────────────────────────────────
// Each entry is a compact-syntax expression that exercises the op.
// 'offset' is synthetic (not in operations.ts) so added separately.

const OP_SPECIMENS: Record<string, unknown> = {
  // Logical
  and:        { and: [{ eq: [{ var: 'name' }, 'a'] }, { eq: [{ var: 'name' }, 'b'] }] },
  or:         { or: [{ eq: [{ var: 'name' }, 'a'] }, { eq: [{ var: 'name' }, 'b'] }] },
  not:        { not: [{ eq: [{ var: 'name' }, 'a'] }] },

  // Comparison
  eq:         { eq: [{ var: 'name' }, 'test'] },
  neq:        { neq: [{ var: 'name' }, 'test'] },
  gt:         { gt: [{ var: 'estimatedMinutes' }, 10] },
  gte:        { gte: [{ var: 'estimatedMinutes' }, 10] },
  lt:         { lt: [{ var: 'estimatedMinutes' }, 10] },
  lte:        { lte: [{ var: 'estimatedMinutes' }, 10] },

  // Range
  between:    { between: [{ var: 'estimatedMinutes' }, 5, 30] },

  // Set membership
  in:         { in: [{ var: 'name' }, ['a', 'b']] },

  // Container / containing
  container:  { container: ['project', { eq: [{ var: 'name' }, 'X'] }] },
  containing: { containing: ['tasks', { eq: [{ var: 'name' }, 'X'] }] },

  // String/array ops
  contains:   { contains: [{ var: 'name' }, 'test'] },
  startsWith: { startsWith: [{ var: 'name' }, 'te'] },
  endsWith:   { endsWith: [{ var: 'name' }, 'st'] },
  matches:    { matches: [{ var: 'name' }, '^te.*'] },

  // Array functions
  count:      { gt: [{ count: [{ var: 'tags' }] }, 0] },

  // Null checks
  isNull:     { isNull: [{ var: 'dueDate' }] },
  isNotNull:  { isNotNull: [{ var: 'dueDate' }] },

  // Sugar (desugared by lower — doesn't reach fold, but should still work end-to-end)
  notIn:      { notIn: [{ var: 'name' }, ['a', 'b']] },
};

// Synthetic ops not in operations.ts but reaching fold
const SYNTHETIC_SPECIMENS: Record<string, unknown> = {
  offset:     { gte: [{ var: 'dueDate' }, { offset: { date: 'now', days: -3 } }] },
};

describe('foldOp coverage — every operations.ts op dispatches through foldExpr', () => {
  // Verify every op in operations.ts has a specimen
  it('all operations.ts ops have a test specimen', () => {
    const allOps = Object.keys(operations);
    const missing = allOps.filter(op => !(op in OP_SPECIMENS));
    assert.deepEqual(missing, [], `Missing specimens for ops: ${missing.join(', ')}`);
  });

  // Verify synthetic ops have specimens
  it('all synthetic ops (offset) have a test specimen', () => {
    assert.ok('offset' in SYNTHETIC_SPECIMENS);
  });

  // Describer backend: every op
  for (const [op, specimen] of [...Object.entries(OP_SPECIMENS), ...Object.entries(SYNTHETIC_SPECIMENS)]) {
    it(`describer handles "${op}"`, () => {
      const result = describeExpr(specimen);
      assert.equal(typeof result, 'string');
      assert.ok(result.length > 0, `describer returned empty string for "${op}"`);
    });
  }

  // NodeEval backend: every op (except container/containing which throw by design)
  const NODEEVAL_SKIP = new Set(['container', 'containing']);

  for (const [op, specimen] of [...Object.entries(OP_SPECIMENS), ...Object.entries(SYNTHETIC_SPECIMENS)]) {
    if (NODEEVAL_SKIP.has(op)) continue;

    it(`nodeEval compiles "${op}" without error`, () => {
      const ast = lowerExpr(specimen);
      // Should not throw during compilation
      const fn = compileNodePredicate(ast, 'tasks');
      assert.equal(typeof fn, 'function');
    });
  }
});
