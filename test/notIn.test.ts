/**
 * Tests for the `notIn` operator (#53).
 *
 * Syntax: {notIn: [{var: "taskStatus"}, ["completed", "dropped"]]}
 *
 * `notIn` is syntactic sugar — it should fold to `not(in(...))`.
 * This means no new backend methods are needed; it's a lowering-level rewrite.
 *
 * Implementation options:
 *   A) Lower-time rewrite: lowerExpr transforms {notIn: [a, b]} → {op: "not", args: [{op: "in", args: [a, b]}]}
 *   B) Fold-time rewrite: foldExpr handles "notIn" by calling backend.not(backend.inArray(a, b))
 *
 * Either approach produces the same result for all backends. These tests
 * verify the observable behavior regardless of which approach is taken.
 *
 * TDD: these tests are expected to FAIL until the operator is implemented.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Lowering tests ───────────────────────────────────────────────────────

import { lowerExpr, LowerError } from '../dist/tools/query/lower.js';
import type { LoweredExpr } from '../dist/tools/query/fold.js';

describe('lowerExpr — notIn operator', () => {
  it('lowers notIn to not(in(...)) or {op: "notIn", args: [...]}', () => {
    const result = lowerExpr({ notIn: [{ var: 'taskStatus' }, ['completed', 'dropped']] });

    // Accept either desugared form (not wrapping in) or direct notIn op.
    // The implementation may desugar at lower time or at fold time.
    if ('op' in (result as any)) {
      const node = result as { op: string; args: any[] };
      if (node.op === 'not') {
        // Desugared at lower time: {op:"not", args:[{op:"in", args:[...]}]}
        assert.equal(node.args.length, 1);
        const inner = node.args[0] as { op: string; args: any[] };
        assert.equal(inner.op, 'in');
        assert.deepEqual(inner.args[0], { var: 'taskStatus' });
        assert.deepEqual(inner.args[1], ['completed', 'dropped']);
      } else if (node.op === 'notIn') {
        // Kept as notIn for fold-time rewrite
        assert.deepEqual(node.args[0], { var: 'taskStatus' });
        assert.deepEqual(node.args[1], ['completed', 'dropped']);
      } else {
        assert.fail(`Unexpected op: ${node.op}`);
      }
    } else {
      assert.fail('Expected an {op, args} node from lowering');
    }
  });

  it('lowers notIn with string array', () => {
    const result = lowerExpr({ notIn: [{ var: 'status' }, ['Active', 'OnHold']] });
    // Should lower successfully (either form)
    assert.ok(result != null);
  });

  it('rejects notIn with 1 arg', () => {
    assert.throws(
      () => lowerExpr({ notIn: [{ var: 'status' }] }),
      (err: Error) => err instanceof LowerError
    );
  });

  it('rejects notIn with 3 args', () => {
    assert.throws(
      () => lowerExpr({ notIn: [{ var: 'status' }, ['a'], 'extra'] }),
      (err: Error) => err instanceof LowerError
    );
  });

  it('rejects notIn with non-array second arg', () => {
    // Like `in`, the second arg must be an array literal
    assert.throws(
      () => lowerExpr({ notIn: [{ var: 'status' }, 'Active'] }),
      (err: Error) => err instanceof LowerError
    );
  });
});

// ── Describer tests ──────────────────────────────────────────────────────

import { describeExpr } from '../dist/tools/query/backends/describer.js';

describe('describeExpr — notIn', () => {
  it('describes notIn', () => {
    const result = describeExpr({ notIn: [{ var: 'taskStatus' }, ['completed', 'dropped']] });
    // Should produce either:
    //   "taskStatus not in [\"completed\", \"dropped\"]"  (direct)
    //   "NOT (taskStatus in [\"completed\", \"dropped\"])" (desugared)
    // Accept either form
    assert.ok(
      result.includes('not in') || result.includes('NOT'),
      `Expected "not in" or "NOT" in description, got: ${result}`
    );
    assert.ok(
      result.includes('taskStatus'),
      `Expected "taskStatus" in description, got: ${result}`
    );
  });

  it('describes notIn combined with other predicates', () => {
    const result = describeExpr({
      and: [
        { notIn: [{ var: 'taskStatus' }, ['completed', 'dropped']] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    assert.ok(result.includes('flagged'));
    assert.ok(result.includes('taskStatus'));
  });
});

// ── NodeEval tests ───────────────────────────────────────────────────────

import { compileNodePredicate, type Row, type RowFn } from '../dist/tools/query/backends/nodeEval.js';

function predicate(where: unknown, entity: 'tasks' | 'projects' | 'folders' | 'tags' = 'tasks'): RowFn {
  const ast = lowerExpr(where) as LoweredExpr;
  return compileNodePredicate(ast, entity);
}

function evalRow(where: unknown, row: Row, entity: 'tasks' | 'projects' | 'folders' | 'tags' = 'tasks'): boolean {
  return !!predicate(where, entity)(row);
}

describe('nodeEval — notIn', () => {
  it('notIn: excludes values in the array', () => {
    assert.equal(
      evalRow(
        { notIn: [{ var: 'status' }, ['completed', 'dropped']] },
        { status: 'completed' }
      ),
      false
    );
    assert.equal(
      evalRow(
        { notIn: [{ var: 'status' }, ['completed', 'dropped']] },
        { status: 'dropped' }
      ),
      false
    );
  });

  it('notIn: includes values not in the array', () => {
    assert.equal(
      evalRow(
        { notIn: [{ var: 'status' }, ['completed', 'dropped']] },
        { status: 'Available' }
      ),
      true
    );
  });

  it('notIn: case-insensitive matching', () => {
    assert.equal(
      evalRow(
        { notIn: [{ var: 'status' }, ['Completed', 'Dropped']] },
        { status: 'completed' }
      ),
      false
    );
    assert.equal(
      evalRow(
        { notIn: [{ var: 'status' }, ['completed']] },
        { status: 'COMPLETED' }
      ),
      false
    );
  });

  it('notIn: null value is not in the array', () => {
    // null is never equal to any string in the array
    // The behavior depends on whether not(in(null, [...])) = not(false) = true
    // or whether null propagates. in(null, [...]) returns false (no match),
    // so not(false) = true. This matches SQL WHERE col NOT IN (...) semantics
    // where NULL rows are excluded (return false for NULL).
    // However, the NodeEval `in` uses normalize(null) → null, and null !== anything → false.
    // not(false) = true. So notIn returns true for null values.
    // This may or may not be the desired behavior — documenting it here.
    const result = evalRow(
      { notIn: [{ var: 'status' }, ['Active', 'OnHold']] },
      { status: null }
    );
    // Note: in most query engines, NOT IN with NULL returns UNKNOWN/false.
    // Our current `in` returns false for null, so not(false) = true.
    // If this behavior changes, update this test.
    assert.equal(result, true);
  });

  it('notIn: is equivalent to not(in(...))', () => {
    const row1: Row = { status: 'Available' };
    const row2: Row = { status: 'completed' };
    const row3: Row = { status: 'dropped' };

    const values = ['completed', 'dropped'];

    for (const row of [row1, row2, row3]) {
      const notInResult = evalRow({ notIn: [{ var: 'status' }, values] }, row);
      const notOfInResult = evalRow({ not: [{ in: [{ var: 'status' }, values] }] }, row);
      assert.equal(
        notInResult, notOfInResult,
        `notIn and not(in(...)) should agree for status="${row.status}"`
      );
    }
  });

  it('notIn: combined with other predicates', () => {
    // Find flagged tasks that are NOT completed or dropped
    assert.equal(
      evalRow(
        {
          and: [
            { eq: [{ var: 'flagged' }, true] },
            { notIn: [{ var: 'status' }, ['completed', 'dropped']] }
          ]
        },
        { flagged: true, status: 'Available' }
      ),
      true
    );
    assert.equal(
      evalRow(
        {
          and: [
            { eq: [{ var: 'flagged' }, true] },
            { notIn: [{ var: 'status' }, ['completed', 'dropped']] }
          ]
        },
        { flagged: true, status: 'completed' }
      ),
      false
    );
  });

  it('notIn: works on projects entity', () => {
    assert.equal(
      evalRow(
        { notIn: [{ var: 'status' }, ['Done', 'Dropped']] },
        { status: 'Active' },
        'projects'
      ),
      true
    );
    assert.equal(
      evalRow(
        { notIn: [{ var: 'status' }, ['Done', 'Dropped']] },
        { status: 'Done' },
        'projects'
      ),
      false
    );
  });
});

// ── JXA compiler tests ──────────────────────────────────────────────────

import { compileWhere } from '../dist/tools/query/backends/jxaCompiler.js';

function jxa(where: unknown, entity: 'tasks' | 'projects' | 'folders' | 'tags' = 'tasks') {
  return compileWhere(where, entity);
}

describe('jxaCompiler — notIn', () => {
  it('compiles notIn to negated _inArr', () => {
    const r = jxa({ notIn: [{ var: 'status' }, ['completed', 'dropped']] });
    // Since notIn desugars to not(in(...)), should produce:
    // (!(_inArr(item.status, ["completed","dropped"])))
    assert.match(r.condition, /_inArr/);
    assert.match(r.condition, /!/);
  });

  it('compiles notIn combined with eq', () => {
    const r = jxa({
      and: [
        { eq: [{ var: 'flagged' }, true] },
        { notIn: [{ var: 'status' }, ['completed', 'dropped']] }
      ]
    });
    assert.match(r.condition, /&&/);
    assert.match(r.condition, /_inArr/);
  });
});

// ── Planner tests ────────────────────────────────────────────────────────

import { buildPlanTree } from '../dist/tools/query/planner.js';
import { planPathLabel } from '../dist/tools/query/strategy.js';

function lower(where: unknown): LoweredExpr {
  return (where != null ? lowerExpr(where) : true) as LoweredExpr;
}

function plan(where: unknown, entity: string = 'tasks') {
  const ast = lower(where);
  return buildPlanTree(ast, entity as any, undefined, false);
}

describe('planner — notIn', () => {
  it('notIn on easy var → broad path (sugar, no special handling needed)', () => {
    // notIn desugars to not(in(...)), which uses only easy vars → broad
    const tree = plan({ notIn: [{ var: 'status' }, ['completed', 'dropped']] }, 'tasks');
    assert.equal(planPathLabel(tree), 'broad');
  });

  it('notIn on projects entity → broad path', () => {
    const tree = plan({ notIn: [{ var: 'status' }, ['Done', 'Dropped']] }, 'projects');
    assert.equal(planPathLabel(tree), 'broad');
  });
});

// ── VarCollector tests ───────────────────────────────────────────────────

import { collectVarsFromAst } from '../dist/tools/query/backends/varCollector.js';

describe('varCollector — notIn', () => {
  it('collects variable from notIn', () => {
    const ast = lower({ notIn: [{ var: 'status' }, ['completed', 'dropped']] });
    const vars = collectVarsFromAst(ast, 'tasks');
    assert.ok(vars.has('status'));
  });

  it('collects all vars from combined expression', () => {
    const ast = lower({
      and: [
        { notIn: [{ var: 'status' }, ['completed', 'dropped']] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    const vars = collectVarsFromAst(ast, 'tasks');
    assert.ok(vars.has('status'));
    assert.ok(vars.has('flagged'));
  });
});
