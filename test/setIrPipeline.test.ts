/**
 * Unit tests for the SetIR pipeline — lowerToSetIr → buildSetIrPlan → lowerSetIrToEventPlan.
 *
 * These are the tests that should have caught the integration-test failures:
 *   (1) op:'count' on tasks produces Difference(Count(...)) instead of Count(Difference(...))
 *   (2) {var: 'now'} lands in AE scan columns and causes "No property spec for tasks.now"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSetIrPlan,
  analyseColumnOverlap,
  isNativeCountEligible,
  buildNativeCountScript,
  isNativeExistsEligible,
  buildNativeExistsScript,
  compileQueryToSetIr,
  compileSetIrToEventPlan,
  compileQueryToEventPlan,
  optimizeEventPlanPipeline,
} from '../dist/tools/query/executionUnits/orchestrator.js';
import { lowerSetIrToEventPlan } from '../dist/tools/query/lowerSetIrToEventPlan.js';
import { canEnrichColumn } from '../dist/utils/omniJsEnrich.js';
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

describe('pass-composed query pipeline helpers', () => {
  it('compileQueryToSetIr matches buildSetIrPlan', () => {
    const params = { entity: 'tasks' as const, op: 'get' as const, predicate: { op: 'eq', args: [{ var: 'flagged' }, true] } as LoweredExpr, select: ['name'] };
    assert.deepEqual(
      compileQueryToSetIr(params),
      buildSetIrPlan(params),
    );
  });

  it('compileSetIrToEventPlan matches direct lowering', () => {
    const setIr = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: { op: 'eq', args: [{ var: 'flagged' }, true] }, select: ['name'] });
    assert.deepEqual(
      compileSetIrToEventPlan(setIr, ['name']),
      lowerSetIrToEventPlan(setIr, ['name']),
    );
  });

  it('compileQueryToEventPlan returns the optimized EventPlan pipeline output', () => {
    const params = {
      entity: 'tasks' as const,
      op: 'get' as const,
      predicate: { op: 'eq', args: [{ var: 'flagged' }, true] } as LoweredExpr,
      select: ['name'],
    };

    const setIr = optimizeSetIr(buildSetIrPlan(params));
    const eventPlan = lowerSetIrToEventPlan(setIr, ['name']);

    assert.deepEqual(
      compileQueryToEventPlan(params),
      optimizeEventPlanPipeline(eventPlan),
    );
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

// ── Scan subsumption pass ────────────────────────────────────────────────────
//
// When multiple Scan nodes for the same entity exist in the tree with
// different column subsets, the widenScansToUnion pass should widen all
// scans to the union of all column sets, enabling EventPlan CSE to
// deduplicate the resulting identical Get+Zip chains.

import { lowerToSetIr, optimizeSetIr } from '../dist/tools/query/lowerToSetIr.js';
import { cseEventPlan } from '../dist/tools/query/eventPlanCSE.js';
import { pruneColumns } from '../dist/tools/query/eventPlanColumnPrune.js';
import { mergeSemiJoins } from '../dist/tools/query/eventPlanMergeSemiJoins.js';
import { inspectEventPlan } from '../dist/tools/query/executionUnits/orchestrator.js';

function collectScans(node: any): { entity: string; columns: string[] }[] {
  const scans: { entity: string; columns: string[] }[] = [];
  if (!node || typeof node !== 'object') return scans;
  if (node.kind === 'Scan') scans.push({ entity: node.entity, columns: [...node.columns].sort() });
  for (const v of Object.values(node)) {
    scans.push(...collectScans(v));
  }
  return scans;
}

describe('optimizeSetIr — scan subsumption (widenScansToUnion)', () => {
  it('widens Scan(A,[id]) to Scan(A,[id,name]) when both exist', () => {
    // Simulate: Difference(Scan(A,[id,name]), Scan(A,[id]))
    // After optimization, both should have the same columns.
    const plan = optimizeSetIr({
      kind: 'Difference',
      left:  { kind: 'Scan', entity: 'projects', columns: ['id', 'name'] },
      right: { kind: 'Scan', entity: 'projects', columns: ['id'] },
    } as any);

    const scans = collectScans(plan);
    const projectScans = scans.filter(s => s.entity === 'projects');

    assert.equal(projectScans.length, 2, 'should have 2 project scans');
    for (const s of projectScans) {
      assert.ok(
        s.columns.includes('name'),
        `All project scans should include 'name' after widening, got [${s.columns}]`,
      );
      assert.ok(
        s.columns.includes('id'),
        `All project scans should include 'id', got [${s.columns}]`,
      );
    }
  });

  it('does not widen scans when all scans for an entity already have the same columns', () => {
    const plan = optimizeSetIr({
      kind: 'Intersect',
      left:  { kind: 'Scan', entity: 'tasks', columns: ['id', 'name'] },
      right: { kind: 'Scan', entity: 'tasks', columns: ['id', 'name'] },
    } as any);

    // mergeSameEntityScans collapses this to a single Scan
    assert.equal(plan.kind, 'Scan');
    assert.equal((plan as any).entity, 'tasks');
  });

  it('widens across different tree branches (Restriction + Difference)', () => {
    // Simulates: container('project', pred) on tasks with project exclusion
    //   Difference(
    //     Restriction(source=Scan(tasks,[id,projectId]),
    //                 lookup=Scan(projects,[id,name])),
    //     Scan(projects,[id])   ← should be widened to [id,name]
    //   )
    const plan = optimizeSetIr({
      kind: 'Difference',
      left: {
        kind: 'Restriction',
        source:   { kind: 'Scan', entity: 'tasks', columns: ['id', 'projectId'] },
        fkColumn: 'projectId',
        lookup:   { kind: 'Scan', entity: 'projects', columns: ['id', 'name'] },
      },
      right: { kind: 'Scan', entity: 'projects', columns: ['id'] },
    } as any);

    const projectScans = collectScans(plan).filter(s => s.entity === 'projects');
    assert.ok(projectScans.length >= 2, 'should have at least 2 project scans');

    // All project scans should now include 'name' (widened from the Restriction lookup)
    for (const s of projectScans) {
      assert.ok(
        s.columns.includes('name'),
        `Project scan should be widened to include 'name', got [${s.columns}]`,
      );
    }
  });

  it('does not widen scans across different entities', () => {
    const plan = optimizeSetIr({
      kind: 'Intersect',
      left:  { kind: 'Scan', entity: 'tasks', columns: ['id', 'name'] },
      right: { kind: 'Scan', entity: 'projects', columns: ['id'] },
    } as any);

    const scans = collectScans(plan);
    const taskScans = scans.filter(s => s.entity === 'tasks');
    const projectScans = scans.filter(s => s.entity === 'projects');

    // Tasks should keep [id, name], projects should keep [id]
    assert.equal(taskScans.length, 1);
    assert.deepEqual(taskScans[0].columns, ['id', 'name']);
    assert.equal(projectScans.length, 1);
    assert.deepEqual(projectScans[0].columns, ['id']);
  });

  it('widens 3+ scans of the same entity to the union of all column sets', () => {
    // Three scans with different columns should all be widened to [id, name, flagged]
    const plan = optimizeSetIr({
      kind: 'Intersect',
      left: {
        kind: 'Difference',
        left:  { kind: 'Scan', entity: 'tasks', columns: ['id', 'name'] },
        right: { kind: 'Scan', entity: 'tasks', columns: ['id', 'flagged'] },
      },
      right: { kind: 'Scan', entity: 'tasks', columns: ['id'] },
    } as any);

    const taskScans = collectScans(plan).filter(s => s.entity === 'tasks');
    // After merge-scan, some may collapse, but all surviving scans should have the full union
    for (const s of taskScans) {
      assert.ok(s.columns.includes('id'), `Scan should include 'id', got [${s.columns}]`);
      assert.ok(s.columns.includes('name'), `Scan should include 'name' after widening, got [${s.columns}]`);
      assert.ok(s.columns.includes('flagged'), `Scan should include 'flagged' after widening, got [${s.columns}]`);
    }
  });
});

// ── Task-only var optimisation: skip project-exclusion Difference ─────────────
//
// When every variable referenced in a task query's predicate and select list
// is task-only (absent from the project var registry), projects can never
// survive the filter. The Difference(tasks, projects) is a no-op and can be
// omitted, saving one AE round-trip.

function hasDifference(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.kind === 'Difference') return true;
  return Object.values(node).some(v => hasDifference(v));
}

describe('buildSetIrPlan — task-only var optimisation (skip Difference)', () => {
  it('includes Difference when predicate is null (no filter)', () => {
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: null });
    assert.ok(hasDifference(plan),
      'Null predicate passes all rows including projects — Difference required');
  });

  it('includes Difference when predicate is true (no filter)', () => {
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: true });
    assert.ok(hasDifference(plan),
      'True predicate passes all rows including projects — Difference required');
  });

  it('includes Difference when predicate uses a shared var (name)', () => {
    const pred: LoweredExpr = { op: 'contains', args: [{ var: 'name' }, 'foo'] };
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: pred });
    assert.ok(hasDifference(plan),
      'name exists on both tasks and projects — Difference required');
  });

  it('includes Difference when predicate uses a shared var (flagged)', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: pred });
    assert.ok(hasDifference(plan),
      'flagged exists on both tasks and projects — Difference required');
  });

  it('skips Difference when predicate uses task-only var (inInbox)', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'inInbox' }, true] };
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: pred });
    assert.ok(!hasDifference(plan),
      'inInbox is task-only — projects cannot match — Difference should be omitted');
  });

  it('skips Difference when predicate uses task-only var (blocked)', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'blocked' }, true] };
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: pred });
    assert.ok(!hasDifference(plan),
      'blocked is task-only — projects cannot match — Difference should be omitted');
  });

  it('skips Difference when predicate uses task-only var (projectName)', () => {
    const pred: LoweredExpr = { op: 'contains', args: [{ var: 'projectName' }, 'Test'] };
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: pred });
    assert.ok(!hasDifference(plan),
      'projectName is task-only — Difference should be omitted');
  });

  it('includes Difference when predicate mixes task-only and shared vars', () => {
    const pred: LoweredExpr = {
      op: 'and', args: [
        { op: 'eq', args: [{ var: 'inInbox' }, true] },
        { op: 'contains', args: [{ var: 'name' }, 'foo'] },
      ],
    };
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: pred });
    assert.ok(hasDifference(plan),
      'name is shared — one shared var is enough to require Difference');
  });

  it('includes Difference when select list contains a shared var', () => {
    // Predicate is task-only but select requests 'name' (shared)
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'inInbox' }, true] };
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: pred, select: ['name'] });
    assert.ok(hasDifference(plan),
      'select contains name (shared) — Difference required');
  });

  it('skips Difference when both predicate and select are task-only', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'inInbox' }, true] };
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'get', predicate: pred, select: ['projectName', 'inInbox'] });
    assert.ok(!hasDifference(plan),
      'All vars task-only — Difference should be omitted');
  });

  it('task-only optimisation also applies to op:count', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'inInbox' }, true] };
    const plan = buildSetIrPlan({ entity: 'tasks', op: 'count', predicate: pred });
    assert.equal(plan.kind, 'Count');
    assert.ok(!hasDifference(plan),
      'inInbox is task-only — no Difference needed even for count');
  });

  it('never affects non-task entities', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'hidden' }, true] };
    const plan = buildSetIrPlan({ entity: 'folders', op: 'get', predicate: pred });
    assert.ok(!hasDifference(plan),
      'Folders never get a Difference (only tasks do)');
  });
});

// ── Tag-name shortcut optimisation ──────────────────────────────────────────
//
// When a task query uses container('tag', eq(name, 'literal')), the optimizer
// rewrites the Restriction (which requires the expensive tagIds bulk read)
// into an Intersect with a TagNameTaskIds node (which uses the fast
// .whose({name:'literal'}).flattenedTasks.id() path).

function findNode(node: any, kind: string): any | null {
  if (!node || typeof node !== 'object') return null;
  if (node.kind === kind) return node;
  for (const v of Object.values(node)) {
    const found = findNode(v, kind);
    if (found) return found;
  }
  return null;
}

function hasNode(node: any, kind: string): boolean {
  return findNode(node, kind) !== null;
}

function hasTagIds(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.kind === 'Scan' && Array.isArray(node.columns) && node.columns.includes('tagIds')) return true;
  return Object.values(node).some(v => hasTagIds(v));
}

describe('optimizeSetIr — tag-name shortcut (tagNameShortcut)', () => {
  it('rewrites container(tag, eq(name, literal)) to TagNameTaskIds', () => {
    // Build a Restriction as produced by the container('tag', ...) lowering
    const plan = lowerToSetIr({
      predicate: { op: 'container', args: ['tag', { op: 'eq', args: [{ var: 'name' }, 'Work'] }] },
      entity: 'tasks',
      op: 'get',
    } as any);

    // Before optimization: should have a Restriction with tagIds FK
    assert.ok(hasNode(plan, 'Restriction'),
      'Unoptimized plan should have a Restriction node');
    assert.ok(hasTagIds(plan),
      'Unoptimized plan should reference tagIds');

    // After optimization: Restriction replaced with Intersect + TagNameTaskIds
    const optimized = optimizeSetIr(plan);
    assert.ok(!hasNode(optimized, 'Restriction'),
      'Optimized plan should NOT have a Restriction node');
    assert.ok(hasNode(optimized, 'TagNameTaskIds'),
      'Optimized plan should have a TagNameTaskIds node');

    const tagNode = findNode(optimized, 'TagNameTaskIds');
    assert.equal(tagNode.tagName, 'Work');
    assert.equal(tagNode.match, 'eq');
  });

  it('removes tagIds from Scan columns after rewrite', () => {
    const plan = lowerToSetIr({
      predicate: { op: 'container', args: ['tag', { op: 'eq', args: [{ var: 'name' }, 'Errands'] }] },
      entity: 'tasks',
      op: 'get',
    } as any);

    const optimized = optimizeSetIr(plan);
    assert.ok(!hasTagIds(optimized),
      'Optimized plan should not have tagIds in any Scan columns');
  });

  it('does NOT rewrite non-eq tag predicates (e.g. contains)', () => {
    const plan = lowerToSetIr({
      predicate: { op: 'container', args: ['tag', { op: 'contains', args: [{ var: 'name' }, 'Work'] }] },
      entity: 'tasks',
      op: 'get',
    } as any);

    const optimized = optimizeSetIr(plan);
    // contains(name, 'Work') is not a simple eq — shortcut should NOT fire
    assert.ok(!hasNode(optimized, 'TagNameTaskIds'),
      'Non-eq tag predicates should NOT trigger the shortcut');
    assert.ok(hasNode(optimized, 'Restriction'),
      'Non-eq tag predicate should keep the original Restriction');
  });

  it('does NOT rewrite negated tag name predicate: not(eq(name, x))', () => {
    const plan = lowerToSetIr({
      predicate: { op: 'container', args: ['tag', { op: 'not', args: [{ op: 'eq', args: [{ var: 'name' }, 'Work'] }] }] },
      entity: 'tasks',
      op: 'get',
    } as any);

    const optimized = optimizeSetIr(plan);
    assert.ok(!hasNode(optimized, 'TagNameTaskIds'),
      'Negated tag-name eq should NOT trigger the shortcut');
  });

  it('does NOT rewrite startsWith tag name predicate', () => {
    const plan = lowerToSetIr({
      predicate: { op: 'container', args: ['tag', { op: 'startsWith', args: [{ var: 'name' }, 'Wo'] }] },
      entity: 'tasks',
      op: 'get',
    } as any);

    const optimized = optimizeSetIr(plan);
    assert.ok(!hasNode(optimized, 'TagNameTaskIds'),
      'startsWith tag-name predicate should NOT trigger the shortcut');
  });

  it('does NOT rewrite container(project, eq(name, ...)) — only tag', () => {
    const plan = lowerToSetIr({
      predicate: { op: 'container', args: ['project', { op: 'eq', args: [{ var: 'name' }, 'MyProject'] }] },
      entity: 'tasks',
      op: 'get',
    } as any);

    const optimized = optimizeSetIr(plan);
    assert.ok(!hasNode(optimized, 'TagNameTaskIds'),
      'Project container should NOT trigger the tag-name shortcut');
    assert.ok(hasNode(optimized, 'Restriction'),
      'Project container should keep its Restriction');
  });

  it('round-trips through lowerSetIrToEventPlan without error', () => {
    const plan = lowerToSetIr({
      predicate: { op: 'container', args: ['tag', { op: 'eq', args: [{ var: 'name' }, 'Work'] }] },
      entity: 'tasks',
      op: 'get',
    } as any);

    const optimized = optimizeSetIr(plan);
    assert.doesNotThrow(
      () => lowerSetIrToEventPlan(optimized, undefined),
      'Optimized plan with TagNameTaskIds should lower to EventPlan without error',
    );
  });

  it('lowered EventPlan contains Whose specifier for tag lookup', () => {
    const plan = lowerToSetIr({
      predicate: { op: 'container', args: ['tag', { op: 'eq', args: [{ var: 'name' }, 'Work'] }] },
      entity: 'tasks',
      op: 'get',
    } as any);

    const optimized = optimizeSetIr(plan);
    const ep = lowerSetIrToEventPlan(optimized, undefined);

    // Find a Get node with a Whose specifier
    const whoseNode = ep.nodes.find(
      (n: any) => n.kind === 'Get' && n.specifier?.kind === 'Whose',
    );
    assert.ok(whoseNode, 'EventPlan should contain a Get(Whose) node for the tag lookup');
    const spec = (whoseNode as any).specifier;
    assert.equal(spec.match, 'eq');
    assert.equal(spec.value, 'Work');
  });
});

// ── Column overlap analysis ──────────────────────────────────────────────────
//
// analyseColumnOverlap determines which select columns are already read by
// the filter scan (shared) vs only needed for output (output-only).
// Used by the deferred enrichment path to decide whether per-item byIdentifier
// is cheaper than a full bulk scan.

describe('analyseColumnOverlap', () => {
  it('no overlap: all select columns are output-only', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'inInbox' }, true] };
    const result = analyseColumnOverlap(pred, ['name', 'dueDate', 'projectName']);

    assert.ok(result.filterColumns.has('inInbox'));
    assert.equal(result.filterColumns.size, 1);
    assert.deepEqual(result.sharedColumns, []);
    assert.deepEqual(result.outputOnlyColumns, ['name', 'dueDate', 'projectName']);
  });

  it('full overlap: all select columns are in the filter', () => {
    const pred: LoweredExpr = {
      op: 'and', args: [
        { op: 'eq', args: [{ var: 'name' }, 'test'] },
        { op: 'eq', args: [{ var: 'flagged' }, true] },
      ],
    };
    const result = analyseColumnOverlap(pred, ['name', 'flagged']);

    assert.ok(result.filterColumns.has('name'));
    assert.ok(result.filterColumns.has('flagged'));
    assert.deepEqual(result.sharedColumns, ['name', 'flagged']);
    assert.deepEqual(result.outputOnlyColumns, []);
  });

  it('partial overlap: some select columns are shared, some output-only', () => {
    const pred: LoweredExpr = {
      op: 'and', args: [
        { op: 'eq', args: [{ var: 'flagged' }, true] },
        { op: 'eq', args: [{ var: 'inInbox' }, true] },
      ],
    };
    const result = analyseColumnOverlap(pred, ['flagged', 'name', 'dueDate']);

    assert.deepEqual(result.sharedColumns, ['flagged']);
    assert.deepEqual(result.outputOnlyColumns, ['name', 'dueDate']);
  });

  it('null predicate (true): all filter columns are empty', () => {
    const result = analyseColumnOverlap(true, ['name', 'dueDate']);

    assert.equal(result.filterColumns.size, 0);
    assert.deepEqual(result.sharedColumns, []);
    assert.deepEqual(result.outputOnlyColumns, ['name', 'dueDate']);
  });

  it('null select: no select columns, all output empty', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'name' }, 'test'] };
    const result = analyseColumnOverlap(pred, undefined);

    assert.ok(result.filterColumns.has('name'));
    assert.deepEqual(result.sharedColumns, []);
    assert.deepEqual(result.outputOnlyColumns, []);
  });

  it('empty select array: same as null select', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'name' }, 'test'] };
    const result = analyseColumnOverlap(pred, []);

    assert.ok(result.filterColumns.has('name'));
    assert.deepEqual(result.sharedColumns, []);
    assert.deepEqual(result.outputOnlyColumns, []);
  });

  it('complex predicate: collects vars from all branches', () => {
    const pred: LoweredExpr = {
      op: 'or', args: [
        { op: 'eq', args: [{ var: 'flagged' }, true] },
        { op: 'and', args: [
          { op: 'contains', args: [{ var: 'name' }, 'test'] },
          { op: 'lt', args: [{ var: 'dueDate' }, { var: 'now' }] },
        ]},
      ],
    };
    const result = analyseColumnOverlap(pred, ['name', 'projectName', 'note']);

    assert.ok(result.filterColumns.has('flagged'));
    assert.ok(result.filterColumns.has('name'));
    assert.ok(result.filterColumns.has('dueDate'));
    assert.ok(result.filterColumns.has('now'));
    assert.deepEqual(result.sharedColumns, ['name']);
    assert.deepEqual(result.outputOnlyColumns, ['projectName', 'note']);
  });
});

// ── Deferred enrichment eligibility ──────────────────────────────────────────
//
// Tests verifying the conditions under which the deferred enrichment path
// is taken (small result set, many output-only columns, all enrichable).
// These test the eligibility check inputs — analyseColumnOverlap + canEnrichColumn
// — since executeQueryFromAst itself requires OmniFocus for execution.

describe('deferred enrichment eligibility — canEnrichColumn integration', () => {
  // Standard task output columns that should be enrichable via OmniJS
  const TASK_ENRICHABLE = [
    'name', 'note', 'flagged', 'dueDate', 'deferDate', 'projectName',
    'projectId', 'parentId', 'tags', 'estimatedMinutes', 'completionDate',
    'modificationDate', 'creationDate', 'taskStatus', 'status', 'blocked',
    'sequential', 'inInbox', 'hasChildren', 'childCount',
  ];

  for (const col of TASK_ENRICHABLE) {
    it(`tasks.${col} is enrichable via OmniJS`, () => {
      assert.ok(canEnrichColumn('tasks', col),
        `Expected canEnrichColumn('tasks', '${col}') to be true`);
    });
  }

  const PROJECT_ENRICHABLE = [
    'name', 'note', 'status', 'flagged', 'dueDate', 'deferDate',
    'completionDate', 'modificationDate', 'creationDate', 'estimatedMinutes',
    'sequential', 'taskCount', 'activeTaskCount', 'folderId', 'folderName',
  ];

  for (const col of PROJECT_ENRICHABLE) {
    it(`projects.${col} is enrichable via OmniJS`, () => {
      assert.ok(canEnrichColumn('projects', col),
        `Expected canEnrichColumn('projects', '${col}') to be true`);
    });
  }

  it('unknown column is not enrichable', () => {
    assert.ok(!canEnrichColumn('tasks', 'nonExistentColumn'));
  });

  it('perspectives entity is never enrichable', () => {
    assert.ok(!canEnrichColumn('perspectives' as any, 'name'));
  });
});

describe('deferred enrichment eligibility — scenario classification', () => {
  // Helper: simulate the inline eligibility check from executeQueryFromAst
  function isDeferredEnrichmentEligible(params: {
    op: 'get' | 'count' | 'exists';
    entity: string;
    select?: string[];
    limit?: number;
    predicate: LoweredExpr | true;
  }): boolean {
    const { op, entity, select, limit, predicate } = params;
    if (op !== 'get') return false;
    if (!select || select.length === 0) return false;
    if (limit == null || limit > 50) return false;
    if (entity === 'perspectives') return false;

    const overlap = analyseColumnOverlap(predicate, select);
    const outputOnly = overlap.outputOnlyColumns;

    return (
      outputOnly.length >= 3 &&
      outputOnly.every(col => canEnrichColumn(entity as any, col))
    );
  }

  it('eligible: op=get, limit=10, 4 output-only enrichable columns', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    assert.ok(isDeferredEnrichmentEligible({
      op: 'get', entity: 'tasks', limit: 10,
      select: ['name', 'dueDate', 'projectName', 'note'],
      predicate: pred,
    }));
  });

  it('eligible: limit at boundary (50)', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'inInbox' }, true] };
    assert.ok(isDeferredEnrichmentEligible({
      op: 'get', entity: 'tasks', limit: 50,
      select: ['name', 'dueDate', 'projectName', 'tags'],
      predicate: pred,
    }));
  });

  it('not eligible: op=count', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    assert.ok(!isDeferredEnrichmentEligible({
      op: 'count', entity: 'tasks', limit: 10,
      select: ['name', 'dueDate', 'projectName', 'note'],
      predicate: pred,
    }));
  });

  it('not eligible: op=exists', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    assert.ok(!isDeferredEnrichmentEligible({
      op: 'exists', entity: 'tasks', limit: 1,
      select: ['name', 'dueDate', 'projectName', 'note'],
      predicate: pred,
    }));
  });

  it('not eligible: no limit', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    assert.ok(!isDeferredEnrichmentEligible({
      op: 'get', entity: 'tasks',
      select: ['name', 'dueDate', 'projectName', 'note'],
      predicate: pred,
    }));
  });

  it('not eligible: limit > 50', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    assert.ok(!isDeferredEnrichmentEligible({
      op: 'get', entity: 'tasks', limit: 51,
      select: ['name', 'dueDate', 'projectName', 'note'],
      predicate: pred,
    }));
  });

  it('not eligible: no select', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    assert.ok(!isDeferredEnrichmentEligible({
      op: 'get', entity: 'tasks', limit: 10,
      predicate: pred,
    }));
  });

  it('not eligible: empty select', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    assert.ok(!isDeferredEnrichmentEligible({
      op: 'get', entity: 'tasks', limit: 10,
      select: [],
      predicate: pred,
    }));
  });

  it('not eligible: fewer than 3 output-only columns', () => {
    // flagged is in both predicate and select → shared. Only name and dueDate are output-only (2 < 3).
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    assert.ok(!isDeferredEnrichmentEligible({
      op: 'get', entity: 'tasks', limit: 10,
      select: ['flagged', 'name', 'dueDate'],
      predicate: pred,
    }));
  });

  it('not eligible: all select columns overlap with filter (0 output-only)', () => {
    const pred: LoweredExpr = {
      op: 'and', args: [
        { op: 'eq', args: [{ var: 'name' }, 'test'] },
        { op: 'eq', args: [{ var: 'flagged' }, true] },
      ],
    };
    assert.ok(!isDeferredEnrichmentEligible({
      op: 'get', entity: 'tasks', limit: 10,
      select: ['name', 'flagged'],
      predicate: pred,
    }));
  });

  it('not eligible: perspectives entity', () => {
    assert.ok(!isDeferredEnrichmentEligible({
      op: 'get', entity: 'perspectives', limit: 10,
      select: ['name', 'note', 'dueDate', 'flagged'],
      predicate: true,
    }));
  });

  it('eligible: project entity with output-only columns', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    assert.ok(isDeferredEnrichmentEligible({
      op: 'get', entity: 'projects', limit: 10,
      select: ['name', 'dueDate', 'folderId', 'folderName'],
      predicate: pred,
    }));
  });
});

// ── Filter-only plan construction ────────────────────────────────────────────
//
// When deferred enrichment runs, it builds a "filter-only" plan with a
// reduced select list (shared columns + id). Verify these plans are valid.

// ── container() with complex boolean predicates ─────────────────────────────
//
// Verifies that container() correctly handles or, not, and complex boolean
// predicates. The tag-name shortcut should only fire for simple eq(name, literal),
// NOT for or/not/and predicates.

describe('container() with complex boolean predicates', () => {
  // ── container('tag', or(eq(name, A), eq(name, B))) ─────────────────────
  // OR produces a Union of tag filter branches. tagNameShortcut should NOT fire
  // because the lookup predicate is or(...), not a simple eq(name, literal).

  it('container(tag, or(eq,eq)) produces Restriction with Union lookup before optimization', () => {
    const plan = lowerToSetIr({
      predicate: {
        op: 'container',
        args: ['tag', { op: 'or', args: [
          { op: 'eq', args: [{ var: 'name' }, 'Work'] },
          { op: 'eq', args: [{ var: 'name' }, 'Personal'] },
        ]}],
      },
      entity: 'tasks',
      op: 'get',
    } as any);

    assert.ok(hasNode(plan, 'Restriction'),
      'Unoptimized plan should have a Restriction node');
    assert.ok(hasTagIds(plan),
      'Unoptimized plan should reference tagIds (FK for tag container)');

    // The lookup subtree should contain a Union (from the OR)
    const restriction = findNode(plan, 'Restriction');
    assert.ok(hasNode(restriction.lookup, 'Union'),
      'Lookup subtree should contain a Union node (from OR predicate)');
  });

  it('container(tag, or(eq,eq)) does NOT trigger tagNameShortcut', () => {
    const plan = lowerToSetIr({
      predicate: {
        op: 'container',
        args: ['tag', { op: 'or', args: [
          { op: 'eq', args: [{ var: 'name' }, 'Work'] },
          { op: 'eq', args: [{ var: 'name' }, 'Personal'] },
        ]}],
      },
      entity: 'tasks',
      op: 'get',
    } as any);

    const optimized = optimizeSetIr(plan);
    // tagNameShortcut only fires for simple eq(name, literal) in the lookup filter.
    // An or(...) predicate is not a simple eq, so the shortcut must NOT fire.
    assert.ok(!hasNode(optimized, 'TagNameTaskIds'),
      'OR tag predicate should NOT trigger tagNameShortcut');
    assert.ok(hasNode(optimized, 'Restriction'),
      'Restriction should be preserved (shortcut did not fire)');
  });

  it('container(tag, or(eq,eq)) round-trips through lowerSetIrToEventPlan', () => {
    const plan = lowerToSetIr({
      predicate: {
        op: 'container',
        args: ['tag', { op: 'or', args: [
          { op: 'eq', args: [{ var: 'name' }, 'Work'] },
          { op: 'eq', args: [{ var: 'name' }, 'Personal'] },
        ]}],
      },
      entity: 'tasks',
      op: 'get',
    } as any);

    const optimized = optimizeSetIr(plan);
    assert.doesNotThrow(
      () => lowerSetIrToEventPlan(optimized, undefined),
      'container(tag, or(...)) should lower to EventPlan without error',
    );
  });

  // ── container('project', not(flagged)) ─────────────────────────────────
  // not(P) always produces Filter(Scan(projects,...), not(P)) in the lookup.
  // The Restriction source reads tasks.projectId.

  it('container(project, not(flagged)) produces Restriction with Filter lookup', () => {
    const plan = lowerToSetIr({
      predicate: {
        op: 'container',
        args: ['project', { op: 'not', args: [{ var: 'flagged' }] }],
      },
      entity: 'tasks',
      op: 'get',
    } as any);

    assert.ok(hasNode(plan, 'Restriction'),
      'Plan should have a Restriction node');

    const restriction = findNode(plan, 'Restriction');
    assert.equal(restriction.fkColumn, 'projectId',
      'FK column should be projectId');

    // The lookup should contain a Filter (from the not() predicate)
    assert.ok(hasNode(restriction.lookup, 'Filter'),
      'Lookup subtree should contain a Filter node (from not(flagged))');
  });

  it('container(project, not(flagged)) round-trips through lowerSetIrToEventPlan', () => {
    const plan = lowerToSetIr({
      predicate: {
        op: 'container',
        args: ['project', { op: 'not', args: [{ var: 'flagged' }] }],
      },
      entity: 'tasks',
      op: 'get',
    } as any);

    const optimized = optimizeSetIr(plan);
    assert.doesNotThrow(
      () => lowerSetIrToEventPlan(optimized, undefined),
      'container(project, not(flagged)) should lower to EventPlan without error',
    );
  });

  // ── container('folder', and(contains(name, 'A'), not(hidden))) ─────────
  // Two-hop Restriction: tasks → projects (projectId) → folders (folderId).
  // The folder lookup has an AND predicate which produces Intersect of two branches.

  it('container(folder, and(...)) produces nested Restrictions (tasks→projects→folders)', () => {
    const plan = lowerToSetIr({
      predicate: {
        op: 'container',
        args: ['folder', { op: 'and', args: [
          { op: 'contains', args: [{ var: 'name' }, 'Active'] },
          { op: 'not', args: [{ var: 'hidden' }] },
        ]}],
      },
      entity: 'tasks',
      op: 'get',
    } as any);

    // Should have at least 2 Restrictions: outer (tasks→projects) and inner (projects→folders)
    const outerRestriction = findNode(plan, 'Restriction');
    assert.ok(outerRestriction, 'Plan should have an outer Restriction node');
    assert.equal(outerRestriction.fkColumn, 'projectId',
      'Outer Restriction FK should be projectId (tasks→projects)');

    // The lookup of the outer Restriction should itself be a Restriction (projects→folders)
    const innerRestriction = findNode(outerRestriction.lookup, 'Restriction');
    assert.ok(innerRestriction, 'Lookup should contain inner Restriction (projects→folders)');
    assert.equal(innerRestriction.fkColumn, 'folderId',
      'Inner Restriction FK should be folderId (projects→folders)');
  });

  it('container(folder, and(...)) round-trips through lowerSetIrToEventPlan', () => {
    const plan = lowerToSetIr({
      predicate: {
        op: 'container',
        args: ['folder', { op: 'and', args: [
          { op: 'contains', args: [{ var: 'name' }, 'Active'] },
          { op: 'not', args: [{ var: 'hidden' }] },
        ]}],
      },
      entity: 'tasks',
      op: 'get',
    } as any);

    const optimized = optimizeSetIr(plan);
    assert.doesNotThrow(
      () => lowerSetIrToEventPlan(optimized, undefined),
      'container(folder, and(...)) should lower to EventPlan without error',
    );
  });

  // ── Verify tagNameShortcut ONLY fires for simple eq(name, literal) ─────

  it('tagNameShortcut fires for simple eq(name, literal)', () => {
    const plan = lowerToSetIr({
      predicate: { op: 'container', args: ['tag', { op: 'eq', args: [{ var: 'name' }, 'Work'] }] },
      entity: 'tasks',
      op: 'get',
    } as any);
    const optimized = optimizeSetIr(plan);
    assert.ok(hasNode(optimized, 'TagNameTaskIds'),
      'Simple eq(name, literal) should trigger tagNameShortcut');
  });

  it('tagNameShortcut does NOT fire for not(eq(name, literal))', () => {
    const plan = lowerToSetIr({
      predicate: { op: 'container', args: ['tag', { op: 'not', args: [
        { op: 'eq', args: [{ var: 'name' }, 'Work'] },
      ]}] },
      entity: 'tasks',
      op: 'get',
    } as any);
    const optimized = optimizeSetIr(plan);
    assert.ok(!hasNode(optimized, 'TagNameTaskIds'),
      'not(eq(name, literal)) should NOT trigger tagNameShortcut');
  });

  it('tagNameShortcut does NOT fire for and(eq(name, A), eq(name, B))', () => {
    const plan = lowerToSetIr({
      predicate: { op: 'container', args: ['tag', { op: 'and', args: [
        { op: 'eq', args: [{ var: 'name' }, 'Work'] },
        { op: 'eq', args: [{ var: 'name' }, 'Personal'] },
      ]}] },
      entity: 'tasks',
      op: 'get',
    } as any);
    const optimized = optimizeSetIr(plan);
    // The AND produces an Intersect in the lookup, which after merge-scan
    // becomes a single Filter. The filter predicate is and(eq(name,A), eq(name,B)),
    // not a simple eq — so the shortcut should NOT fire.
    assert.ok(!hasNode(optimized, 'TagNameTaskIds'),
      'and(eq(name, A), eq(name, B)) should NOT trigger tagNameShortcut');
  });
});

describe('deferred enrichment — filter-only plan validity', () => {
  it('filter-only plan with shared+id columns builds without error', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    const filterSelect = ['flagged', 'id'];  // shared + mandatory id
    const plan = buildSetIrPlan({
      entity: 'tasks', op: 'get', predicate: pred,
      select: filterSelect, limit: 10,
    });
    assert.doesNotThrow(
      () => lowerSetIrToEventPlan(plan, filterSelect),
      'Filter-only plan should lower to EventPlan without error',
    );
  });

  it('filter-only plan with id-only builds without error (no shared columns)', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'inInbox' }, true] };
    const filterSelect = ['id'];  // only mandatory id, no shared columns
    const plan = buildSetIrPlan({
      entity: 'tasks', op: 'get', predicate: pred,
      select: filterSelect, limit: 10,
    });
    assert.doesNotThrow(
      () => lowerSetIrToEventPlan(plan, filterSelect),
      'Filter-only plan with just id should lower without error',
    );
  });

  it('filter-only plan for projects builds without error', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    const filterSelect = ['flagged', 'id'];
    const plan = buildSetIrPlan({
      entity: 'projects', op: 'get', predicate: pred,
      select: filterSelect, limit: 10,
    });
    assert.doesNotThrow(
      () => lowerSetIrToEventPlan(plan, filterSelect),
      'Filter-only project plan should lower without error',
    );
  });

  it('filter-only plan reads fewer columns than a full plan', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };

    // Full plan: many output columns
    const fullSelect = ['name', 'dueDate', 'projectName', 'note', 'flagged'];
    const fullPlan = buildSetIrPlan({
      entity: 'tasks', op: 'get', predicate: pred,
      select: fullSelect, limit: 10,
    });

    // Filter-only plan: just shared + id
    const filterSelect = ['flagged', 'id'];
    const filterPlan = buildSetIrPlan({
      entity: 'tasks', op: 'get', predicate: pred,
      select: filterSelect, limit: 10,
    });

    // Count Scan columns in each plan
    const fullScans = collectScans(fullPlan).filter(s => s.entity === 'tasks');
    const filterScans = collectScans(filterPlan).filter(s => s.entity === 'tasks');

    // Filter plan should have fewer or equal columns in its task scans
    const fullMaxCols = Math.max(...fullScans.map(s => s.columns.length));
    const filterMaxCols = Math.max(...filterScans.map(s => s.columns.length));

    assert.ok(filterMaxCols <= fullMaxCols,
      `Filter-only plan should scan ≤ columns (${filterMaxCols}) vs full plan (${fullMaxCols})`);
  });
});

// ── Native count fast-path ───────────────────────────────────────────────────
//
// When op:'count' with predicate === true (no filter, includeCompleted=true),
// the orchestrator should skip the full SetIR → EventPlan pipeline and emit a
// native AE count via .length on the element specifier.

describe('native count fast-path — eligibility', () => {
  it('eligible: op=count, predicate=true, entity=tasks', () => {
    assert.ok(isNativeCountEligible({
      op: 'count', predicate: true, entity: 'tasks',
    }));
  });

  it('eligible: op=count, predicate=true, entity=projects', () => {
    assert.ok(isNativeCountEligible({
      op: 'count', predicate: true, entity: 'projects',
    }));
  });

  it('eligible: op=count, predicate=true, entity=tags', () => {
    assert.ok(isNativeCountEligible({
      op: 'count', predicate: true, entity: 'tags',
    }));
  });

  it('eligible: op=count, predicate=true, entity=folders', () => {
    assert.ok(isNativeCountEligible({
      op: 'count', predicate: true, entity: 'folders',
    }));
  });

  it('NOT eligible: op=count, predicate=true, entity=perspectives', () => {
    assert.ok(!isNativeCountEligible({
      op: 'count', predicate: true, entity: 'perspectives' as any,
    }));
  });

  it('NOT eligible: op=count with a filter predicate', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    assert.ok(!isNativeCountEligible({
      op: 'count', predicate: pred, entity: 'tasks',
    }));
  });

  it('NOT eligible: op=get (even with predicate=true)', () => {
    assert.ok(!isNativeCountEligible({
      op: 'get', predicate: true, entity: 'tasks',
    }));
  });

  it('NOT eligible: op=exists (even with predicate=true)', () => {
    assert.ok(!isNativeCountEligible({
      op: 'exists', predicate: true, entity: 'tasks',
    }));
  });
});

describe('native count fast-path — JXA script generation', () => {
  it('tasks: script subtracts flattenedProjects.length', () => {
    const script = buildNativeCountScript('tasks');
    assert.ok(script.includes('flattenedTasks.length'), 'should read flattenedTasks.length');
    assert.ok(script.includes('flattenedProjects.length'), 'should subtract flattenedProjects.length');
    assert.ok(script.includes('-'), 'should contain subtraction operator');
  });

  it('projects: script reads flattenedProjects.length only', () => {
    const script = buildNativeCountScript('projects');
    assert.ok(script.includes('flattenedProjects.length'), 'should read flattenedProjects.length');
    assert.ok(!script.includes('flattenedTasks'), 'should not reference flattenedTasks');
    // No subtraction
    assert.ok(!script.includes(' - '), 'should not subtract anything');
  });

  it('tags: script reads flattenedTags.length', () => {
    const script = buildNativeCountScript('tags');
    assert.ok(script.includes('flattenedTags.length'), 'should read flattenedTags.length');
  });

  it('folders: script reads flattenedFolders.length', () => {
    const script = buildNativeCountScript('folders');
    assert.ok(script.includes('flattenedFolders.length'), 'should read flattenedFolders.length');
  });

  it('all scripts are valid JXA IIFEs', () => {
    for (const entity of ['tasks', 'projects', 'tags', 'folders'] as const) {
      const script = buildNativeCountScript(entity);
      assert.ok(script.startsWith('(function()'), `${entity} script should be an IIFE`);
      assert.ok(script.includes('Application(\'OmniFocus\')'), `${entity} script should reference OmniFocus`);
      assert.ok(script.includes('JSON.stringify'), `${entity} script should JSON.stringify the result`);
    }
  });

  it('throws for unknown entity', () => {
    assert.throws(
      () => buildNativeCountScript('unknown' as any),
      /unknown entity/,
    );
  });
});

// ── Native exists fast-path ───────────────────────────────────────────────────
//
// When op:'exists' with predicate === true (no filter), the orchestrator skips
// the full pipeline and dispatches the native AE exists command (coredoex) via
// .exists() on the collection specifier for non-task entities. For tasks, falls
// back to length arithmetic to exclude project root tasks.

describe('native exists fast-path — eligibility', () => {
  it('eligible: op=exists, predicate=true, entity=tasks', () => {
    assert.ok(isNativeExistsEligible({ op: 'exists', predicate: true, entity: 'tasks' }));
  });

  it('eligible: op=exists, predicate=true, entity=projects', () => {
    assert.ok(isNativeExistsEligible({ op: 'exists', predicate: true, entity: 'projects' }));
  });

  it('eligible: op=exists, predicate=true, entity=tags', () => {
    assert.ok(isNativeExistsEligible({ op: 'exists', predicate: true, entity: 'tags' }));
  });

  it('eligible: op=exists, predicate=true, entity=folders', () => {
    assert.ok(isNativeExistsEligible({ op: 'exists', predicate: true, entity: 'folders' }));
  });

  it('NOT eligible: op=exists, predicate=true, entity=perspectives', () => {
    assert.ok(!isNativeExistsEligible({ op: 'exists', predicate: true, entity: 'perspectives' as any }));
  });

  it('NOT eligible: op=exists with a filter predicate', () => {
    const pred: LoweredExpr = { op: 'eq', args: [{ var: 'flagged' }, true] };
    assert.ok(!isNativeExistsEligible({ op: 'exists', predicate: pred, entity: 'tasks' }));
  });

  it('NOT eligible: op=count (even with predicate=true)', () => {
    assert.ok(!isNativeExistsEligible({ op: 'count', predicate: true, entity: 'tasks' }));
  });

  it('NOT eligible: op=get (even with predicate=true)', () => {
    assert.ok(!isNativeExistsEligible({ op: 'get', predicate: true, entity: 'tasks' }));
  });
});

describe('native exists fast-path — JXA script generation', () => {
  it('tasks: script subtracts flattenedProjects.length and compares > 0', () => {
    const script = buildNativeExistsScript('tasks');
    assert.ok(script.includes('flattenedTasks.length'), 'should read flattenedTasks.length');
    assert.ok(script.includes('flattenedProjects.length'), 'should subtract flattenedProjects.length');
    assert.ok(script.includes('> 0'), 'should compare result > 0');
  });

  it('projects: script dispatches native .exists() on flattenedProjects', () => {
    const script = buildNativeExistsScript('projects');
    assert.ok(script.includes('flattenedProjects.exists()'), 'should dispatch native AE exists on flattenedProjects');
    assert.ok(!script.includes('flattenedTasks'), 'should not reference flattenedTasks');
    assert.ok(!script.includes(' - '), 'should not subtract anything');
    assert.ok(!script.includes('.length'), 'should not use .length comparison');
  });

  it('tags: script dispatches native .exists() on flattenedTags', () => {
    const script = buildNativeExistsScript('tags');
    assert.ok(script.includes('flattenedTags.exists()'), 'should dispatch native AE exists on flattenedTags');
    assert.ok(!script.includes('.length'), 'should not use .length comparison');
  });

  it('folders: script dispatches native .exists() on flattenedFolders', () => {
    const script = buildNativeExistsScript('folders');
    assert.ok(script.includes('flattenedFolders.exists()'), 'should dispatch native AE exists on flattenedFolders');
    assert.ok(!script.includes('.length'), 'should not use .length comparison');
  });

  it('all scripts are valid JXA IIFEs returning JSON.stringify(boolean)', () => {
    for (const entity of ['tasks', 'projects', 'tags', 'folders'] as const) {
      const script = buildNativeExistsScript(entity);
      assert.ok(script.startsWith('(function()'), `${entity} script should be an IIFE`);
      assert.ok(script.includes("Application('OmniFocus')"), `${entity} script should reference OmniFocus`);
      assert.ok(script.includes('JSON.stringify'), `${entity} script should JSON.stringify the result`);
    }
  });

  it('throws for unknown entity', () => {
    assert.throws(
      () => buildNativeExistsScript('unknown' as any),
      /unknown entity/,
    );
  });
});

// ── containing() scan widening: execution unit count ─────────────────────────
//
// A containing('tasks', pred) query on projects must produce exactly 2
// execution units through the full pipeline:
//   Unit 1 (jxa):  one fused bulk read covering all task+project columns
//   Unit 2 (node): Node-side filtering, SemiJoins, result assembly
//
// Regression test: before widenScansToUnion traversed Restriction.lookup,
// the tasks Scan nodes inside the lookup were not widened to the same column
// set, causing CSE to fail to deduplicate them — producing 6 JXA units
// (one per property) instead of the expected 2.

function buildContainingProjectPlan(userPred: LoweredExpr) {
  // Inject active filter for projects (mirrors queryOmnifocus.ts)
  const activePred: LoweredExpr = { op: 'in', args: [{ var: 'status' }, ['Active', 'OnHold']] };
  const fullPred: LoweredExpr = { op: 'and', args: [userPred, activePred] };

  let plan = buildSetIrPlan({
    entity:    'projects',
    op:        'get',
    predicate: fullPred,
    select:    ['name', 'status'],
  });
  plan = optimizeSetIr(plan);
  const ep     = lowerSetIrToEventPlan(plan, ['name', 'status']);
  const csed   = cseEventPlan(ep);
  const pruned = pruneColumns(csed);
  return mergeSemiJoins(pruned);
}

describe('containing() query — execution unit count', () => {
  it('containing(tasks, flagged=true) on projects produces 2 execution units', () => {
    const userPred: LoweredExpr = {
      op: 'containing',
      args: ['tasks', { op: 'eq', args: [{ var: 'flagged' }, true] }],
    };
    const ep = buildContainingProjectPlan(userPred);
    const { units } = inspectEventPlan(ep);

    assert.equal(units.length, 2,
      `Expected 2 execution units (1 jxa + 1 node), got ${units.length}. ` +
      `If this regresses to 6, widenScansToUnion is not traversing Restriction.lookup.`);
    assert.equal(units[0].runtime, 'jxa',  'First unit should be jxa (bulk AE read)');
    assert.equal(units[1].runtime, 'node', 'Second unit should be node (Node-side ops)');
  });

  it('containing(tasks, and(flagged, contains(name,...))) on projects produces 2 execution units', () => {
    const userPred: LoweredExpr = {
      op: 'containing',
      args: ['tasks', {
        op: 'and', args: [
          { op: 'eq', args: [{ var: 'flagged' }, true] },
          { op: 'contains', args: [{ var: 'name' }, 'review'] },
        ],
      }],
    };
    const ep = buildContainingProjectPlan(userPred);
    const { units } = inspectEventPlan(ep);

    assert.equal(units.length, 2,
      `Expected 2 execution units, got ${units.length}. ` +
      `Complex containing() predicate should still fuse into 2 units.`);
  });

  it('all tasks Scans in containing() plan have the same column set after optimizeSetIr', () => {
    const userPred: LoweredExpr = {
      op: 'containing',
      args: ['tasks', { op: 'eq', args: [{ var: 'flagged' }, true] }],
    };
    const activePred: LoweredExpr = { op: 'in', args: [{ var: 'status' }, ['Active', 'OnHold']] };
    const fullPred: LoweredExpr = { op: 'and', args: [userPred, activePred] };

    let plan = buildSetIrPlan({
      entity: 'projects', op: 'get', predicate: fullPred, select: ['name', 'status'],
    });
    plan = optimizeSetIr(plan);

    const taskScans = collectScans(plan).filter(s => s.entity === 'tasks');
    if (taskScans.length > 1) {
      const firstCols = JSON.stringify(taskScans[0].columns);
      for (const s of taskScans) {
        assert.equal(
          JSON.stringify(s.columns),
          firstCols,
          `All tasks Scans should have the same column set after widenScansToUnion; ` +
          `got [${s.columns}] vs [${taskScans[0].columns}]`,
        );
      }
    }
    // If there is only 1 tasks Scan (already merged), that is also correct.
    assert.ok(taskScans.length >= 1, 'Should have at least 1 tasks Scan in the plan');
  });
});
