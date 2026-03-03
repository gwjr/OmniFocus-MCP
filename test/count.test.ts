/**
 * Tests for the `count()` array-length function (#54).
 *
 * Syntax: {count: [{var: "tags"}]}
 * Returns: a number (the length of the array variable)
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
