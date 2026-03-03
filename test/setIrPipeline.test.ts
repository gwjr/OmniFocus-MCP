/**
 * Unit tests for the SetIR pipeline — lowerToSetIr → buildSetIrPlan → lowerSetIrToEventPlan.
 *
 * These are the tests that should have caught the integration-test failures:
 *   (1) op:'count' on tasks produces Difference(Count(...)) instead of Count(Difference(...))
 *   (2) {var: 'now'} lands in AE scan columns and causes "No property spec for tasks.now"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSetIrPlan }        from '../dist/tools/query/executionUnits/orchestrator.js';
import { lowerSetIrToEventPlan } from '../dist/tools/query/lowerSetIrToEventPlan.js';
import type { LoweredExpr }      from '../dist/tools/query/fold.js';

// ── Bug 1: count ordering ─────────────────────────────────────────────────────
//
// For op:'count' on tasks, the correct SetIR plan is:
//   Count(Difference(filterPlan, Scan(projects)))
// NOT:
//   Difference(Count(filterPlan), Scan(projects))
//
// The second form crashes at runtime because Difference's SemiJoin executor
// calls .filter() on the Count result (a number, not a Row[]).

describe('buildSetIrPlan — op:count on tasks', () => {
  it('outermost node is Count, not Difference', () => {
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'count', predicate: null });
    assert.equal(plan.kind, 'Count',
      `Expected Count at top level, got ${plan.kind}. ` +
      `(Difference(Count(...)) is the wrong order — Count must be outer.)`);
  });

  it('Count source includes project exclusion (Difference)', () => {
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'count', predicate: null });
    assert.equal(plan.kind, 'Count');
    // The source should contain a Difference node (project exclusion)
    const src = (plan as Extract<typeof plan, { kind: 'Count' }>).source;
    assert.equal(src.kind, 'Difference',
      `Expected Count's source to be Difference (project exclusion), got ${src.kind}`);
  });

  it('Difference subtracts the projects scan', () => {
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'count', predicate: null });
    assert.equal(plan.kind, 'Count');
    const src = (plan as Extract<typeof plan, { kind: 'Count' }>).source;
    assert.equal(src.kind, 'Difference');
    const diff = src as Extract<typeof src, { kind: 'Difference' }>;
    assert.equal(diff.right.kind, 'Scan');
    assert.equal((diff.right as any).entity, 'projects');
  });

  it('plan round-trips through lowerSetIrToEventPlan without error', () => {
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'count', predicate: null });
    assert.doesNotThrow(() => lowerSetIrToEventPlan(plan, undefined),
      'lowerSetIrToEventPlan should not throw for count-tasks plan');
  });
});

describe('buildSetIrPlan — op:count on projects (no project exclusion)', () => {
  it('outermost node is Count', () => {
    const plan = buildSetIrPlan({ entity: 'projects', op: 'count', predicate: null });
    assert.equal(plan.kind, 'Count');
  });
});

// ── Count → RowCount produces a number, not a Row[] ──────────────────────────
//
// SetIR Count lowers to EventPlan RowCount, which returns a number.
// queryOmnifocus.ts must handle this rather than asserting Array.isArray.

describe('lowerSetIrToEventPlan — Count node produces RowCount', () => {
  it('Count(Scan) lowers to an EventPlan ending in RowCount', () => {
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'count', predicate: null });
    assert.equal(plan.kind, 'Count');
    const ep = lowerSetIrToEventPlan(plan, undefined);
    // The last node in the EventPlan should be RowCount
    const lastNode = ep.nodes[ep.result];
    assert.equal(lastNode.kind, 'RowCount',
      `Expected last EventPlan node to be RowCount, got ${lastNode.kind}`);
  });
});

// ── Bug 2: {var:'now'} treated as AE property ─────────────────────────────────
//
// 'now' is a virtual runtime variable (appleEventsProperty: null in variables.ts).
// It is handled by nodeEval as a special case, not read from Apple Events.
// When a predicate references {var: 'now'}, it must NOT appear in Scan columns,
// otherwise lowerSetIrToEventPlan calls propSpec('tasks', 'now') which throws.

describe('buildSetIrPlan — predicate with {var: now}', () => {
  const nowPred: LoweredExpr = {
    op: 'lt',
    args: [{ var: 'dueDate' }, { var: 'now' }],
  };

  it('does not throw during lowerSetIrToEventPlan', () => {
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: nowPred });
    assert.doesNotThrow(
      () => lowerSetIrToEventPlan(plan, undefined),
      `Expected no "No property spec for tasks.now" error`
    );
  });

  it('does not throw for between(dueDate, now, offset)', () => {
    const betweenPred: LoweredExpr = {
      op: 'between',
      args: [
        { var: 'dueDate' },
        { var: 'now' },
        { op: 'offset', args: [{ var: 'now' }, 30] },
      ],
    };
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: betweenPred });
    assert.doesNotThrow(
      () => lowerSetIrToEventPlan(plan, undefined),
      `Expected no propSpec error when predicate references 'now'`
    );
  });

  it('Scan nodes in the plan do not include now as a column', () => {
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: nowPred });

    function findScanColumns(node: any): string[][] {
      const results: string[][] = [];
      if (!node || typeof node !== 'object') return results;
      if (node.kind === 'Scan') results.push(node.columns);
      for (const val of Object.values(node)) {
        results.push(...findScanColumns(val));
      }
      return results;
    }

    const allColumns = findScanColumns(plan).flat();
    assert.ok(!allColumns.includes('now'),
      `'now' should not appear in any Scan columns; found in: ${JSON.stringify(allColumns)}`);
  });
});
