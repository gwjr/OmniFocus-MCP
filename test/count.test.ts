/**
 * Tests for the `count()` array-length function (#54).
 *
 * Syntax: {count: [{var: "tags"}]}
 * Returns: a number (the length of the array variable)
 *
 * `count` is a value-producing function, not a predicate. It composes with
 * comparison operators to form predicates:
 *   {gt: [{count: [{var: "tags"}]}, 0]}   — tasks with at least one tag
 *   {eq: [{count: [{var: "tags"}]}, 3]}   — tasks with exactly 3 tags
 *
 * This is analogous to `offset` — a unary function that transforms a value
 * and returns a derived value, composed into larger expressions.
 *
 * Implementation options for JXA:
 *   A) Fold-level: add `count` case to ExprBackend, each backend implements it
 *   B) Variable-level: register `tagCount` as a chain var with JXA accessor
 *      `tasks.tags.count()` — but this only works if the Apple Events bulk
 *      accessor returns per-item counts (unverified).
 *
 * TDD: these tests are expected to FAIL until the operator is implemented.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Lowering tests ───────────────────────────────────────────────────────

import { lowerExpr, LowerError } from '../dist/tools/query/lower.js';
import type { LoweredExpr } from '../dist/tools/query/fold.js';

describe('lowerExpr — count function', () => {
  it('lowers count to {op: "count", args: [varRef]}', () => {
    const result = lowerExpr({ count: [{ var: 'tags' }] });
    assert.deepEqual(result, {
      op: 'count',
      args: [{ var: 'tags' }]
    });
  });

  it('lowers count nested inside a comparison', () => {
    const result = lowerExpr({ gt: [{ count: [{ var: 'tags' }] }, 0] });
    assert.deepEqual(result, {
      op: 'gt',
      args: [
        { op: 'count', args: [{ var: 'tags' }] },
        0
      ]
    });
  });

  it('lowers count inside and with comparison', () => {
    const result = lowerExpr({
      and: [
        { gt: [{ count: [{ var: 'tags' }] }, 0] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    assert.deepEqual(result, {
      op: 'and',
      args: [
        { op: 'gt', args: [{ op: 'count', args: [{ var: 'tags' }] }, 0] },
        { op: 'eq', args: [{ var: 'flagged' }, true] }
      ]
    });
  });

  it('rejects count with 0 args', () => {
    assert.throws(
      () => lowerExpr({ count: [] }),
      (err: Error) => err instanceof LowerError
    );
  });

  it('rejects count with 2 args', () => {
    assert.throws(
      () => lowerExpr({ count: [{ var: 'tags' }, { var: 'name' }] }),
      (err: Error) => err instanceof LowerError
    );
  });
});

// ── Describer tests ──────────────────────────────────────────────────────

import { describeExpr } from '../dist/tools/query/backends/describer.js';

describe('describeExpr — count function', () => {
  it('describes count of tags', () => {
    const result = describeExpr({ count: [{ var: 'tags' }] });
    // Accept "count of tags", "count(tags)", "tags count", etc.
    assert.ok(
      result.includes('count') && result.includes('tags'),
      `Expected description mentioning "count" and "tags", got: ${result}`
    );
  });

  it('describes count in a comparison', () => {
    const result = describeExpr({ gt: [{ count: [{ var: 'tags' }] }, 0] });
    assert.ok(
      result.includes('count') && result.includes('tags') && result.includes('0'),
      `Expected "count(...tags...) > 0" form, got: ${result}`
    );
  });

  it('describes count in a complex expression', () => {
    const result = describeExpr({
      and: [
        { gt: [{ count: [{ var: 'tags' }] }, 0] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    assert.ok(result.includes('count'));
    assert.ok(result.includes('flagged'));
  });

  it('describes count with eq', () => {
    const result = describeExpr({ eq: [{ count: [{ var: 'tags' }] }, 3] });
    assert.ok(
      result.includes('count') && result.includes('3'),
      `Expected "count(...) = 3" form, got: ${result}`
    );
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

function evalValue(where: unknown, row: Row, entity: 'tasks' | 'projects' | 'folders' | 'tags' = 'tasks'): unknown {
  const ast = lowerExpr(where) as LoweredExpr;
  return compileNodePredicate(ast, entity)(row);
}

describe('nodeEval — count function (value)', () => {
  it('count returns array length', () => {
    assert.equal(evalValue({ count: [{ var: 'tags' }] }, { tags: ['work', 'urgent'] }), 2);
  });

  it('count returns 0 for empty array', () => {
    assert.equal(evalValue({ count: [{ var: 'tags' }] }, { tags: [] }), 0);
  });

  it('count returns 0 for null', () => {
    assert.equal(evalValue({ count: [{ var: 'tags' }] }, { tags: null }), 0);
  });

  it('count returns 0 for undefined', () => {
    assert.equal(evalValue({ count: [{ var: 'tags' }] }, {}), 0);
  });

  it('count returns correct length for many tags', () => {
    assert.equal(
      evalValue({ count: [{ var: 'tags' }] }, { tags: ['a', 'b', 'c', 'd', 'e'] }),
      5
    );
  });
});

describe('nodeEval — count in comparisons', () => {
  it('gt(count(tags), 0): true when tags has elements', () => {
    assert.equal(
      evalRow({ gt: [{ count: [{ var: 'tags' }] }, 0] }, { tags: ['work'] }),
      true
    );
  });

  it('gt(count(tags), 0): false when tags is empty', () => {
    assert.equal(
      evalRow({ gt: [{ count: [{ var: 'tags' }] }, 0] }, { tags: [] }),
      false
    );
  });

  it('gt(count(tags), 0): false when tags is null', () => {
    assert.equal(
      evalRow({ gt: [{ count: [{ var: 'tags' }] }, 0] }, { tags: null }),
      false
    );
  });

  it('eq(count(tags), 2): true when exactly 2 tags', () => {
    assert.equal(
      evalRow({ eq: [{ count: [{ var: 'tags' }] }, 2] }, { tags: ['a', 'b'] }),
      true
    );
  });

  it('eq(count(tags), 2): false when not 2 tags', () => {
    assert.equal(
      evalRow({ eq: [{ count: [{ var: 'tags' }] }, 2] }, { tags: ['a'] }),
      false
    );
  });

  it('gte(count(tags), 3): true when >= 3 tags', () => {
    assert.equal(
      evalRow({ gte: [{ count: [{ var: 'tags' }] }, 3] }, { tags: ['a', 'b', 'c'] }),
      true
    );
    assert.equal(
      evalRow({ gte: [{ count: [{ var: 'tags' }] }, 3] }, { tags: ['a', 'b'] }),
      false
    );
  });

  it('lte(count(tags), 1): single tag or none', () => {
    assert.equal(
      evalRow({ lte: [{ count: [{ var: 'tags' }] }, 1] }, { tags: ['a'] }),
      true
    );
    assert.equal(
      evalRow({ lte: [{ count: [{ var: 'tags' }] }, 1] }, { tags: [] }),
      true
    );
    assert.equal(
      evalRow({ lte: [{ count: [{ var: 'tags' }] }, 1] }, { tags: ['a', 'b'] }),
      false
    );
  });

  it('combined: flagged tasks with at least one tag', () => {
    assert.equal(
      evalRow(
        {
          and: [
            { eq: [{ var: 'flagged' }, true] },
            { gt: [{ count: [{ var: 'tags' }] }, 0] }
          ]
        },
        { flagged: true, tags: ['work'] }
      ),
      true
    );
    assert.equal(
      evalRow(
        {
          and: [
            { eq: [{ var: 'flagged' }, true] },
            { gt: [{ count: [{ var: 'tags' }] }, 0] }
          ]
        },
        { flagged: true, tags: [] }
      ),
      false
    );
  });
});

describe('nodeEval — count type validation', () => {
  it('count on non-array var (name) throws at runtime', () => {
    // count({var:"name"}) where name is a string, not an array.
    // Non-null non-array values are a type error — 0 would be misleading
    // (it would imply the item has an empty collection, not that the field
    // is the wrong type). Throw to surface the programming error.
    assert.throws(
      () => evalValue({ count: [{ var: 'name' }] }, { name: 'hello' }),
      (err: Error) => err instanceof Error
    );
  });

  it('count on boolean var throws at runtime', () => {
    assert.throws(
      () => evalValue({ count: [{ var: 'flagged' }] }, { flagged: true }),
      (err: Error) => err instanceof Error
    );
  });
});

// ── JXA compiler tests ──────────────────────────────────────────────────

import { compileWhere } from '../dist/tools/query/backends/jxaCompiler.js';

function jxa(where: unknown, entity: 'tasks' | 'projects' | 'folders' | 'tags' = 'tasks') {
  return compileWhere(where, entity);
}

describe('jxaCompiler — count function', () => {
  it('count(tags) compiles to a length expression', () => {
    const r = jxa({ gt: [{ count: [{ var: 'tags' }] }, 0] });
    // Should produce something involving .length or .count()
    assert.ok(
      r.condition.includes('length') || r.condition.includes('count'),
      `Expected length or count in JXA output, got: ${r.condition}`
    );
  });

  it('count in combined expression', () => {
    const r = jxa({
      and: [
        { gt: [{ count: [{ var: 'tags' }] }, 0] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    assert.match(r.condition, /&&/);
  });
});

// Pending verification: does `tasks.tags.count()` in Apple Events return
// per-item arrays like `tasks.tags.name()` does? If yes, a chain-variable
// approach (`tagCount` mapped to `.tags.count()` or `.numberOfTags`) could
// be used in BulkScan for optimal performance.
describe('jxaCompiler — count via chain variable accessor (pending AE verification)', { skip: 'pending verification that tags.count() returns per-task array in JXA' }, () => {
  it('tagCount accessor produces correct JXA expression', () => {
    // If implemented as a chain variable, this would be:
    //   taskJxaAccessors.tagCount = v => `${v}.tags.length`
    // and used via {var: "tagCount"} instead of {count: [{var: "tags"}]}
    //
    // This test verifies the accessor IF it exists.
    const r = jxa({ gt: [{ var: 'tagCount' }, 0] });
    assert.ok(
      r.condition.includes('tags') && (r.condition.includes('length') || r.condition.includes('count')),
      `Expected tags length/count accessor, got: ${r.condition}`
    );
  });
});

// ── Planner tests ────────────────────────────────────────────────────────

import { buildPlanTree } from '../dist/tools/query/planner.js';
import { planPathLabel, walkPlan } from '../dist/tools/query/strategy.js';
import type { StrategyNode } from '../dist/tools/query/strategy.js';

function lower(where: unknown): LoweredExpr {
  return (where != null ? lowerExpr(where) : true) as LoweredExpr;
}

function plan(where: unknown, entity: string = 'tasks', select?: string[]) {
  const ast = lower(where);
  return buildPlanTree(ast, entity as any, select, false);
}

function findNode(tree: StrategyNode, kind: string): StrategyNode | null {
  let found: StrategyNode | null = null;
  walkPlan(tree, n => {
    if (n.kind === kind) found = n;
    return n;
  });
  return found;
}

describe('planner — count function', () => {
  it('gt(count(tags), 0) → broad path (tags is a chain var)', () => {
    const tree = plan({ gt: [{ count: [{ var: 'tags' }] }, 0] }, 'tasks');
    assert.equal(planPathLabel(tree), 'broad');
  });

  it('BulkScan includes tags in columns', () => {
    const tree = plan({ gt: [{ count: [{ var: 'tags' }] }, 0] }, 'tasks');
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('tags'), 'BulkScan should include tags column');
  });

  it('count combined with other predicates', () => {
    const tree = plan({
      and: [
        { gt: [{ count: [{ var: 'tags' }] }, 0] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    }, 'tasks');
    assert.equal(planPathLabel(tree), 'broad');
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('tags'));
    assert.ok(scan.columns.includes('flagged'));
  });

  it('count in select + where', () => {
    // count(tags) in where, plus tags in select — should not duplicate
    const tree = plan(
      { gt: [{ count: [{ var: 'tags' }] }, 0] },
      'tasks',
      ['name', 'tags']
    );
    assert.equal(planPathLabel(tree), 'broad');
  });
});

// ── VarCollector tests ───────────────────────────────────────────────────

import { collectVarsFromAst } from '../dist/tools/query/backends/varCollector.js';

describe('varCollector — count function', () => {
  it('collects inner variable from count(tags)', () => {
    const ast = lower({ count: [{ var: 'tags' }] });
    const vars = collectVarsFromAst(ast, 'tasks');
    assert.ok(vars.has('tags'), 'should collect "tags" from count({var:"tags"})');
  });

  it('collects all vars from expression with count', () => {
    const ast = lower({
      and: [
        { gt: [{ count: [{ var: 'tags' }] }, 0] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    const vars = collectVarsFromAst(ast, 'tasks');
    assert.ok(vars.has('tags'));
    assert.ok(vars.has('flagged'));
  });

  it('count does not introduce phantom variables', () => {
    const ast = lower({ gt: [{ count: [{ var: 'tags' }] }, 0] });
    const vars = collectVarsFromAst(ast, 'tasks');
    // Should only have 'tags', not 'count' or any phantom
    assert.ok(vars.has('tags'));
    assert.equal(vars.size, 1, `expected only 1 var (tags), got: ${[...vars].join(', ')}`);
  });
});
