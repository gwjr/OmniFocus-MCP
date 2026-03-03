/**
 * Tests for the `isNull` and `isNotNull` operators (#52).
 *
 * Syntax:
 *   {isNull: [{var: "dueDate"}]}      — true when dueDate is null/undefined
 *   {isNotNull: [{var: "dueDate"}]}   — true when dueDate has a value
 *
 * These are unary predicates — they take a single expression argument.
 * Expected to fold to null-checking logic in each backend:
 *   - NodeEval: `(value == null)` / `(value != null)`
 *   - JXA:      `(expr == null)` / `(expr != null)`
 *   - Describer: "dueDate is null" / "dueDate is not null"
 *
 * TDD: these tests are expected to FAIL until the operators are implemented
 * in operations.ts, lower.ts, fold.ts, and all backends.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Lowering tests ───────────────────────────────────────────────────────

import { lowerExpr, LowerError } from '../dist/tools/query/lower.js';
import type { LoweredExpr } from '../dist/tools/query/fold.js';

describe('lowerExpr — isNull operator', () => {
  it('lowers isNull to {op: "isNull", args: [varRef]}', () => {
    const result = lowerExpr({ isNull: [{ var: 'dueDate' }] });
    assert.deepEqual(result, {
      op: 'isNull',
      args: [{ var: 'dueDate' }]
    });
  });

  it('lowers isNotNull to {op: "isNotNull", args: [varRef]}', () => {
    const result = lowerExpr({ isNotNull: [{ var: 'dueDate' }] });
    assert.deepEqual(result, {
      op: 'isNotNull',
      args: [{ var: 'dueDate' }]
    });
  });

  it('lowers isNull nested in and', () => {
    const result = lowerExpr({
      and: [
        { isNull: [{ var: 'dueDate' }] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    assert.deepEqual(result, {
      op: 'and',
      args: [
        { op: 'isNull', args: [{ var: 'dueDate' }] },
        { op: 'eq', args: [{ var: 'flagged' }, true] }
      ]
    });
  });

  it('rejects isNull with 0 args', () => {
    assert.throws(
      () => lowerExpr({ isNull: [] }),
      (err: Error) => err instanceof LowerError
    );
  });

  it('rejects isNull with 2 args', () => {
    assert.throws(
      () => lowerExpr({ isNull: [{ var: 'dueDate' }, { var: 'name' }] }),
      (err: Error) => err instanceof LowerError
    );
  });

  it('rejects isNotNull with 0 args', () => {
    assert.throws(
      () => lowerExpr({ isNotNull: [] }),
      (err: Error) => err instanceof LowerError
    );
  });

  it('rejects isNotNull with 2 args', () => {
    assert.throws(
      () => lowerExpr({ isNotNull: [{ var: 'dueDate' }, { var: 'name' }] }),
      (err: Error) => err instanceof LowerError
    );
  });
});

// ── Describer tests ──────────────────────────────────────────────────────

import { describeExpr } from '../dist/tools/query/backends/describer.js';

describe('describeExpr — isNull / isNotNull', () => {
  it('describes isNull on a date field', () => {
    assert.equal(
      describeExpr({ isNull: [{ var: 'dueDate' }] }),
      'dueDate is null'
    );
  });

  it('describes isNotNull on a date field', () => {
    assert.equal(
      describeExpr({ isNotNull: [{ var: 'dueDate' }] }),
      'dueDate is not null'
    );
  });

  it('describes isNull on a string field', () => {
    assert.equal(
      describeExpr({ isNull: [{ var: 'name' }] }),
      'name is null'
    );
  });

  it('describes isNotNull combined with other predicates', () => {
    assert.equal(
      describeExpr({
        and: [
          { isNotNull: [{ var: 'dueDate' }] },
          { eq: [{ var: 'flagged' }, true] }
        ]
      }),
      '(dueDate is not null) AND (flagged = true)'
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

describe('nodeEval — isNull', () => {
  it('isNull: true when field is null', () => {
    assert.equal(evalRow({ isNull: [{ var: 'dueDate' }] }, { dueDate: null }), true);
  });

  it('isNull: true when field is undefined', () => {
    assert.equal(evalRow({ isNull: [{ var: 'dueDate' }] }, {}), true);
  });

  it('isNull: false when field has a date value', () => {
    assert.equal(
      evalRow({ isNull: [{ var: 'dueDate' }] }, { dueDate: '2026-03-01T00:00:00.000Z' }),
      false
    );
  });

  it('isNull: false when field has a string value', () => {
    assert.equal(evalRow({ isNull: [{ var: 'name' }] }, { name: 'Test' }), false);
  });

  it('isNull: false when field is zero (not null)', () => {
    assert.equal(
      evalRow({ isNull: [{ var: 'estimatedMinutes' }] }, { estimatedMinutes: 0 }),
      false
    );
  });

  it('isNull: false when field is false (not null)', () => {
    assert.equal(evalRow({ isNull: [{ var: 'flagged' }] }, { flagged: false }), false);
  });

  it('isNull: false when field is empty string (not null)', () => {
    // Empty string is NOT null — it's a valid string value.
    // This distinguishes isNull from "falsy" checks.
    assert.equal(evalRow({ isNull: [{ var: 'name' }] }, { name: '' }), false);
  });

  it('isNull: tags — true when tags is null', () => {
    assert.equal(evalRow({ isNull: [{ var: 'tags' }] }, { tags: null }), true);
  });

  it('isNull: tags — false when tags is empty array', () => {
    // Empty array is NOT null — it means "has tags property, but no tags assigned".
    // Use a separate check for "has no tags" if needed.
    assert.equal(evalRow({ isNull: [{ var: 'tags' }] }, { tags: [] }), false);
  });

  it('isNull: tags — false when tags has elements', () => {
    assert.equal(
      evalRow({ isNull: [{ var: 'tags' }] }, { tags: ['work'] }),
      false
    );
  });
});

describe('nodeEval — isNotNull', () => {
  it('isNotNull: false when field is null', () => {
    assert.equal(evalRow({ isNotNull: [{ var: 'dueDate' }] }, { dueDate: null }), false);
  });

  it('isNotNull: false when field is undefined', () => {
    assert.equal(evalRow({ isNotNull: [{ var: 'dueDate' }] }, {}), false);
  });

  it('isNotNull: true when field has a value', () => {
    assert.equal(
      evalRow({ isNotNull: [{ var: 'dueDate' }] }, { dueDate: '2026-03-01T00:00:00.000Z' }),
      true
    );
  });

  it('isNotNull: true when field is zero', () => {
    assert.equal(
      evalRow({ isNotNull: [{ var: 'estimatedMinutes' }] }, { estimatedMinutes: 0 }),
      true
    );
  });

  it('isNotNull: true when field is false', () => {
    assert.equal(evalRow({ isNotNull: [{ var: 'flagged' }] }, { flagged: false }), true);
  });

  it('isNotNull: true when field is empty string', () => {
    assert.equal(evalRow({ isNotNull: [{ var: 'name' }] }, { name: '' }), true);
  });
});

describe('nodeEval — isNull on projects entity', () => {
  it('isNull on folderName (per-item var)', () => {
    // Root-level projects have no folder — folderName is null
    assert.equal(
      evalRow({ isNull: [{ var: 'folderName' }] }, { folderName: null }, 'projects'),
      true
    );
  });

  it('isNotNull on folderName when project is in a folder', () => {
    assert.equal(
      evalRow({ isNotNull: [{ var: 'folderName' }] }, { folderName: 'Work' }, 'projects'),
      true
    );
  });
});

describe('nodeEval — isNull combined with other operators', () => {
  it('and: flagged AND has due date', () => {
    assert.equal(
      evalRow(
        { and: [{ eq: [{ var: 'flagged' }, true] }, { isNotNull: [{ var: 'dueDate' }] }] },
        { flagged: true, dueDate: '2026-03-01T00:00:00.000Z' }
      ),
      true
    );
    assert.equal(
      evalRow(
        { and: [{ eq: [{ var: 'flagged' }, true] }, { isNotNull: [{ var: 'dueDate' }] }] },
        { flagged: true, dueDate: null }
      ),
      false
    );
  });

  it('or: has due date OR is flagged', () => {
    assert.equal(
      evalRow(
        { or: [{ isNotNull: [{ var: 'dueDate' }] }, { eq: [{ var: 'flagged' }, true] }] },
        { flagged: false, dueDate: null }
      ),
      false
    );
    assert.equal(
      evalRow(
        { or: [{ isNotNull: [{ var: 'dueDate' }] }, { eq: [{ var: 'flagged' }, true] }] },
        { flagged: true, dueDate: null }
      ),
      true
    );
  });

  it('not(isNull) is equivalent to isNotNull', () => {
    const row1: Row = { dueDate: null };
    const row2: Row = { dueDate: '2026-03-01T00:00:00.000Z' };

    assert.equal(
      evalRow({ not: [{ isNull: [{ var: 'dueDate' }] }] }, row1),
      evalRow({ isNotNull: [{ var: 'dueDate' }] }, row1)
    );
    assert.equal(
      evalRow({ not: [{ isNull: [{ var: 'dueDate' }] }] }, row2),
      evalRow({ isNotNull: [{ var: 'dueDate' }] }, row2)
    );
  });
});

// ── JXA compiler tests ──────────────────────────────────────────────────

import { compileWhere } from '../dist/tools/query/backends/jxaCompiler.js';

function jxa(where: unknown, entity: 'tasks' | 'projects' | 'folders' | 'tags' = 'tasks') {
  return compileWhere(where, entity);
}

describe('jxaCompiler — isNull / isNotNull', () => {
  it('isNull compiles to null check', () => {
    const r = jxa({ isNull: [{ var: 'dueDate' }] });
    // Should produce something like: (item.dueDate == null)
    assert.match(r.condition, /==\s*null/);
  });

  it('isNotNull compiles to non-null check', () => {
    const r = jxa({ isNotNull: [{ var: 'dueDate' }] });
    // Should produce something like: (item.dueDate != null)
    assert.match(r.condition, /!=\s*null/);
  });

  it('isNull on string field', () => {
    const r = jxa({ isNull: [{ var: 'name' }] });
    assert.match(r.condition, /==\s*null/);
  });

  it('isNotNull combined with eq', () => {
    const r = jxa({
      and: [
        { isNotNull: [{ var: 'dueDate' }] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    // Should produce an && expression
    assert.match(r.condition, /&&/);
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

describe('planner — isNull / isNotNull', () => {
  it('isNull on easy var → broad path', () => {
    const tree = plan({ isNull: [{ var: 'dueDate' }] }, 'tasks');
    assert.equal(planPathLabel(tree), 'broad');
  });

  it('isNotNull on easy var → broad path', () => {
    const tree = plan({ isNotNull: [{ var: 'dueDate' }] }, 'tasks');
    assert.equal(planPathLabel(tree), 'broad');
  });

  it('BulkScan includes the referenced var in columns', () => {
    const tree = plan({ isNull: [{ var: 'dueDate' }] }, 'tasks');
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('dueDate'));
  });

  it('isNull on expensive var (note) → fallback', () => {
    const tree = plan({ isNull: [{ var: 'note' }] }, 'tasks');
    assert.equal(planPathLabel(tree), 'fallback');
  });

  it('isNull on per-item var → two-phase', () => {
    const tree = plan({ isNull: [{ var: 'folderName' }] }, 'projects');
    assert.equal(planPathLabel(tree), 'two-phase');
  });

  it('isNull combined with other predicates', () => {
    const tree = plan({
      and: [
        { isNull: [{ var: 'dueDate' }] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    }, 'tasks');
    assert.equal(planPathLabel(tree), 'broad');
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('dueDate'));
    assert.ok(scan.columns.includes('flagged'));
  });

  it('projects entity: isNull on dueDate → broad', () => {
    const tree = plan({ isNull: [{ var: 'dueDate' }] }, 'projects');
    assert.equal(planPathLabel(tree), 'broad');
  });
});

// ── VarCollector tests ───────────────────────────────────────────────────

import { collectVarsFromAst } from '../dist/tools/query/backends/varCollector.js';

describe('varCollector — isNull / isNotNull', () => {
  it('collects variable from isNull', () => {
    const ast = lower({ isNull: [{ var: 'dueDate' }] });
    const vars = collectVarsFromAst(ast, 'tasks');
    assert.ok(vars.has('dueDate'));
  });

  it('collects variable from isNotNull', () => {
    const ast = lower({ isNotNull: [{ var: 'estimatedMinutes' }] });
    const vars = collectVarsFromAst(ast, 'tasks');
    assert.ok(vars.has('estimatedMinutes'));
  });

  it('collects all vars from combined expression', () => {
    const ast = lower({
      and: [
        { isNull: [{ var: 'dueDate' }] },
        { isNotNull: [{ var: 'name' }] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    const vars = collectVarsFromAst(ast, 'tasks');
    assert.ok(vars.has('dueDate'));
    assert.ok(vars.has('name'));
    assert.ok(vars.has('flagged'));
  });
});
