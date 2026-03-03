/**
 * Tests for the EventPlan column pruning pass.
 *
 * Verifies that columns injected by the lowering pass (for active filters
 * and project exclusion) are pruned when a downstream Pick doesn't need them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pruneColumns } from '../dist/tools/query/eventPlanColumnPrune.js';
import { cseEventPlan } from '../dist/tools/query/eventPlanCSE.js';
import { buildSetIrPlan } from '../dist/tools/query/executionUnits/orchestrator.js';
import { optimizeSetIr } from '../dist/tools/query/lowerToSetIr.js';
import { lowerSetIrToEventPlan } from '../dist/tools/query/lowerSetIrToEventPlan.js';
import type { EventPlan, EventNode, Ref } from '../dist/tools/query/eventPlan.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function findNodes(plan: EventPlan, kind: EventNode['kind']): EventNode[] {
  return plan.nodes.filter(n => n.kind === kind);
}

function findOne(plan: EventPlan, kind: EventNode['kind']): EventNode {
  const matches = findNodes(plan, kind);
  assert.equal(matches.length, 1, `Expected 1 ${kind}, found ${matches.length}`);
  return matches[0];
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('pruneColumns', () => {

  it('prunes Zip columns not referenced by downstream Pick', () => {
    // Plan: Get(Elements) → Get(name) → Get(completed) → Zip[name, completed] → Pick[name]
    const plan: EventPlan = {
      nodes: [
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCco' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'name', ref: 1 }, { name: 'completed', ref: 2 }] },
        { kind: 'Pick', source: 3 as Ref, fields: ['name'] },
      ],
      result: 4,
    };

    const pruned = pruneColumns(plan);

    // Zip should only have the 'name' column
    const zip = findOne(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>;
    assert.deepEqual(
      zip.columns.map(c => c.name),
      ['name'],
      'Zip should only keep name column',
    );

    // The dead Get(completed) should be removed
    const gets = findNodes(pruned, 'Get');
    // Should have Elements + name only (completed removed)
    assert.equal(gets.length, 2, 'dead Get(completed) should be removed');

    // Compaction: plan should be shorter
    assert.ok(pruned.nodes.length < plan.nodes.length, 'plan should be compacted');
  });

  it('preserves all columns when no Pick node is present', () => {
    // Plan: Get(Elements) → Get(name) → Get(completed) → Zip[name, completed]
    const plan: EventPlan = {
      nodes: [
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCco' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'name', ref: 1 }, { name: 'completed', ref: 2 }] },
      ],
      result: 3,
    };

    const pruned = pruneColumns(plan);

    // Nothing should change — result is Zip, all columns needed
    const zip = findOne(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>;
    assert.deepEqual(
      zip.columns.map(c => c.name),
      ['name', 'completed'],
    );
    assert.equal(pruned.nodes.length, plan.nodes.length);
  });

  it('preserves columns needed by Filter predicate', () => {
    // Plan: Get(Elements) → Get(name) → Get(completed) → Zip[name, completed]
    //   → Filter(predicate uses completed) → Pick[name]
    const plan: EventPlan = {
      nodes: [
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCco' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'name', ref: 1 }, { name: 'completed', ref: 2 }] },
        { kind: 'Filter', source: 3 as Ref, predicate: { op: 'not', args: [{ var: 'completed' }] }, entity: 'tasks' },
        { kind: 'Pick', source: 4 as Ref, fields: ['name'] },
      ],
      result: 5,
    };

    const pruned = pruneColumns(plan);

    // Both columns should be preserved: name for Pick, completed for Filter
    const zip = findOne(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>;
    const colNames = zip.columns.map(c => c.name);
    assert.ok(colNames.includes('name'), 'name needed by Pick');
    assert.ok(colNames.includes('completed'), 'completed needed by Filter predicate');
  });

  it('preserves columns needed by Sort', () => {
    // Plan: Zip[name, dueDate] → Sort(by: dueDate) → Pick[name]
    const plan: EventPlan = {
      nodes: [
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCdd' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'name', ref: 1 }, { name: 'dueDate', ref: 2 }] },
        { kind: 'Sort', source: 3 as Ref, by: 'dueDate', dir: 'asc' },
        { kind: 'Pick', source: 4 as Ref, fields: ['name'] },
      ],
      result: 5,
    };

    const pruned = pruneColumns(plan);

    const zip = findOne(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>;
    const colNames = zip.columns.map(c => c.name);
    assert.ok(colNames.includes('name'), 'name needed by Pick');
    assert.ok(colNames.includes('dueDate'), 'dueDate needed by Sort');
  });

  it('preserves id column needed by SemiJoin', () => {
    // Plan: Zip[name, id, completed] → Filter → SemiJoin → Pick[name]
    const plan: EventPlan = {
      nodes: [
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCco' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'name', ref: 1 }, { name: 'id', ref: 2 }, { name: 'completed', ref: 3 }] },
        { kind: 'SemiJoin', source: 4 as Ref, ids: 2 as Ref, exclude: true },
        { kind: 'Pick', source: 5 as Ref, fields: ['name'] },
      ],
      result: 6,
    };

    const pruned = pruneColumns(plan);

    const zip = findOne(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>;
    const colNames = zip.columns.map(c => c.name);
    assert.ok(colNames.includes('name'), 'name needed by Pick');
    assert.ok(colNames.includes('id'), 'id needed by SemiJoin');
    assert.ok(!colNames.includes('completed'), 'completed is dead — not needed by anything');
  });

  it('prunes multiple dead columns', () => {
    // Zip[name, completed, dropped, flagged] → Pick[name]
    const plan: EventPlan = {
      nodes: [
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCco' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCdr' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCfl' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [
          { name: 'name', ref: 1 },
          { name: 'completed', ref: 2 },
          { name: 'dropped', ref: 3 },
          { name: 'flagged', ref: 4 },
        ] },
        { kind: 'Pick', source: 5 as Ref, fields: ['name'] },
      ],
      result: 6,
    };

    const pruned = pruneColumns(plan);

    const zip = findOne(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>;
    assert.deepEqual(zip.columns.map(c => c.name), ['name']);

    // Should have removed 3 dead Get nodes (completed, dropped, flagged)
    const gets = findNodes(pruned, 'Get');
    assert.equal(gets.length, 2, 'only Elements + name Get should survive');

    // Total plan: Elements, Get(name), Zip, Pick = 4 nodes (down from 7)
    assert.equal(pruned.nodes.length, 4);
  });

  it('handles empty plan', () => {
    const plan: EventPlan = { nodes: [], result: 0 };
    const pruned = pruneColumns(plan);
    assert.deepEqual(pruned, plan);
  });

  it('handles plan with no Zip nodes', () => {
    // FallbackScan: Get(Elements) → Filter
    const plan: EventPlan = {
      nodes: [
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Filter', source: 0 as Ref, predicate: { var: 'flagged' }, entity: 'tasks' },
      ],
      result: 1,
    };

    const pruned = pruneColumns(plan);
    assert.equal(pruned.nodes.length, plan.nodes.length, 'no change for Zip-free plan');
  });

  it('preserves Derive dependency columns', () => {
    // Zip[completed, dropped, blocked, dueDate] → Derive(status) → Pick[status]
    const plan: EventPlan = {
      nodes: [
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCco' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCdr' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCbl' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCdd' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [
          { name: 'completed', ref: 1 },
          { name: 'dropped', ref: 2 },
          { name: 'blocked', ref: 3 },
          { name: 'dueDate', ref: 4 },
          { name: 'name', ref: 5 },
        ] },
        { kind: 'Derive', source: 6 as Ref, derivations: [{ var: 'status', entity: 'tasks' }] },
        { kind: 'Pick', source: 7 as Ref, fields: ['status'] },
      ],
      result: 8,
    };

    const pruned = pruneColumns(plan);

    // status depends on: completed, dropped, blocked, dueDate
    // name is NOT needed — should be pruned
    const zip = findOne(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>;
    const colNames = zip.columns.map(c => c.name);
    assert.ok(colNames.includes('completed'), 'status dependency');
    assert.ok(colNames.includes('dropped'), 'status dependency');
    assert.ok(colNames.includes('blocked'), 'status dependency');
    assert.ok(colNames.includes('dueDate'), 'status dependency');
    assert.ok(!colNames.includes('name'), 'name is dead — not needed');
  });

  it('end-to-end: pipeline preserves active-filter and project-exclusion columns', () => {
    // Task query with active filter (not includeCompleted) and select: ['name'].
    // The pipeline injects effectivelyCompleted/effectivelyDropped for the active
    // filter, and id for the project-exclusion Difference node. All injected
    // columns ARE needed, so pruneColumns should preserve them.
    const activeFilter = {
      op: 'and' as const,
      args: [
        { op: 'not' as const, args: [{ var: 'effectivelyCompleted' }] },
        { op: 'not' as const, args: [{ var: 'effectivelyDropped' }] },
      ],
    };

    let setIr = buildSetIrPlan({
      predicate: activeFilter,
      entity: 'tasks',
      op: 'get',
      select: ['name'],
    });
    setIr = optimizeSetIr(setIr);
    const ep = lowerSetIrToEventPlan(setIr, ['name']);
    const csed = cseEventPlan(ep);
    const pruned = pruneColumns(csed);

    const pick = findOne(pruned, 'Pick') as Extract<EventNode, { kind: 'Pick' }>;
    assert.deepEqual(pick.fields, ['name']);

    // Find all Zip nodes — there may be more than one (tasks + projects scans)
    const zips = findNodes(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>[];
    const taskZip = zips.find(z => z.columns.some(c => c.name === 'name'));
    assert.ok(taskZip, 'should have a Zip with the name column');
    const colNames = taskZip!.columns.map(c => c.name);
    assert.ok(colNames.includes('name'), 'user-selected column');
    assert.ok(colNames.includes('id'), 'needed by project-exclusion SemiJoin');
  });

  it('propagates needed columns through Union to both sides', () => {
    // Plan: two Zip branches (left with [name, flagged], right with [name, completed])
    //   → Union → Pick[name]
    // Both Zips should prune to just [name] since Pick only needs name.
    const plan: EventPlan = {
      nodes: [
        // Left branch
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCfl' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'name', ref: 1 }, { name: 'flagged', ref: 2 }] },
        // Right branch
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 4 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 4 as Ref, propCode: 'FCco' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'name', ref: 5 }, { name: 'completed', ref: 6 }] },
        // Union + Pick
        { kind: 'Union', left: 3 as Ref, right: 7 as Ref },
        { kind: 'Pick', source: 8 as Ref, fields: ['name'] },
      ],
      result: 9,
    };

    const pruned = pruneColumns(plan);

    // Both Zips should only have the 'name' column
    const zips = findNodes(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>[];
    assert.equal(zips.length, 2, 'should have two Zip nodes');
    for (const zip of zips) {
      assert.deepEqual(
        zip.columns.map(c => c.name),
        ['name'],
        'Zip should only keep name column after Union propagation',
      );
    }

    // Dead Get nodes (flagged, completed) should be removed
    const gets = findNodes(pruned, 'Get');
    // 2 Elements + 2 name = 4 Gets (flagged and completed removed)
    assert.equal(gets.length, 4, 'dead property Gets should be removed');
  });

  it('Union preserves id column for row deduplication', () => {
    // Plan: two Zip branches (left with [id, name, flagged], right with [id, name, completed])
    //   → Union → Pick[name]
    // execUnion uses row.id for deduplication, so id must survive even though
    // Pick only requests name. The Union handler must propagate id to both sides.
    const plan: EventPlan = {
      nodes: [
        // Left branch
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCfl' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }, { name: 'flagged', ref: 3 }] },
        // Right branch
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 5 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 5 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 5 as Ref, propCode: 'FCco' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'id', ref: 6 }, { name: 'name', ref: 7 }, { name: 'completed', ref: 8 }] },
        // Union + Pick
        { kind: 'Union', left: 4 as Ref, right: 9 as Ref },
        { kind: 'Pick', source: 10 as Ref, fields: ['name'] },
      ],
      result: 11,
    };

    const pruned = pruneColumns(plan);

    // Both Zips should have 'id' (for Union dedup) and 'name' (for Pick), not 'flagged'/'completed'
    const zips = findNodes(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>[];
    assert.equal(zips.length, 2, 'should have two Zip nodes');
    for (const zip of zips) {
      const colNames = zip.columns.map(c => c.name);
      assert.ok(colNames.includes('id'), 'id must be preserved for Union row deduplication');
      assert.ok(colNames.includes('name'), 'name needed by Pick');
      assert.ok(!colNames.includes('flagged') && !colNames.includes('completed'),
        'dead columns should be pruned');
    }
  });

  it('id is pruned when not needed by any join, union, or output', () => {
    // Simple plan: Scan(tasks, [effectivelyCompleted]) → Filter → Pick[effectivelyCompleted]
    // No SemiJoin, no Union, no cross-entity Enrich — id only came from lowerScan's
    // unconditional injection. The pruner should eliminate it.
    const plan: EventPlan = {
      nodes: [
        // 0: Get(Elements)
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        // 1: Get(id) — injected by lowerScan unconditionally
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
        // 2: Get(effectivelyCompleted)
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCck' }, effect: 'nonMutating' },
        // 3: Zip[id, effectivelyCompleted]
        { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'effectivelyCompleted', ref: 2 }] },
        // 4: Filter(effectivelyCompleted)
        { kind: 'Filter', source: 3 as Ref, predicate: { var: 'effectivelyCompleted' }, entity: 'tasks' },
        // 5: Pick[effectivelyCompleted] — id not requested
        { kind: 'Pick', source: 4 as Ref, fields: ['effectivelyCompleted'] },
      ],
      result: 5,
    };

    const pruned = pruneColumns(plan);

    const zip = findOne(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>;
    const colNames = zip.columns.map(c => c.name);
    assert.ok(!colNames.includes('id'), 'id should be pruned — not needed by any join or output');
    assert.ok(colNames.includes('effectivelyCompleted'), 'effectivelyCompleted needed by Filter and Pick');

    // The Get(id) node should also be removed
    const gets = findNodes(pruned, 'Get');
    const hasIdGet = gets.some(g =>
      g.kind === 'Get' &&
      g.specifier.kind === 'Property' &&
      (g.specifier as { propCode: string }).propCode === 'ID  '
    );
    assert.ok(!hasIdGet, 'dead Get(id) should be removed from plan');
  });

  it('RowCount prunes all upstream Zip columns (no forced id)', () => {
    // Plan: Get(Elements) → Get(name) → Get(flagged) → Get(id) → Zip[name, flagged, id] → RowCount
    // RowCount only needs the array length — it requires NO column values.
    // The pruner propagates an empty needed set so all columns are dead.
    //
    // In practice, RowCount(Zip) without an intervening Filter can only occur
    // when predicate===true, which is already short-circuited via the native
    // fast-path before reaching pruneColumns. This test verifies the pruner
    // emits an empty needed set from RowCount, not a forced 'id'.
    const plan: EventPlan = {
      nodes: [
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCfl' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'name', ref: 1 }, { name: 'flagged', ref: 2 }, { name: 'id', ref: 3 }] },
        { kind: 'RowCount', source: 4 as Ref },
      ],
      result: 5,
    };

    const pruned = pruneColumns(plan);

    // Zip should have zero columns — RowCount forces no column requirements
    const zip = findOne(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>;
    assert.deepEqual(
      zip.columns.map(c => c.name),
      [],
      'RowCount propagates empty needed set — all Zip columns are dead',
    );

    // All Get nodes are pruned — no columns means no property reads, and the
    // Elements Get is also dead since no property Gets reference it.
    const gets = findNodes(pruned, 'Get');
    assert.equal(gets.length, 0, 'all Get nodes are dead — no columns needed');
  });

  it('RowCount with Filter preserves only filter predicate columns (no forced id)', () => {
    // Plan: Zip[name, flagged, id] → Filter(pred uses flagged) → RowCount
    // RowCount needs only row count; Filter needs only 'flagged' from its predicate.
    // 'id' is NOT needed by either — the fix removes it from RowCount's propagation.
    const plan: EventPlan = {
      nodes: [
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCfl' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'name', ref: 1 }, { name: 'flagged', ref: 2 }, { name: 'id', ref: 3 }] },
        { kind: 'Filter', source: 4 as Ref, predicate: { var: 'flagged' }, entity: 'tasks' },
        { kind: 'RowCount', source: 5 as Ref },
      ],
      result: 6,
    };

    const pruned = pruneColumns(plan);

    // Zip should keep only 'flagged' (from Filter predicate). 'name' and 'id' are dead.
    const zip = findOne(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>;
    const colNames = zip.columns.map(c => c.name);
    assert.ok(!colNames.includes('id'), 'id NOT needed — RowCount no longer forces id');
    assert.ok(colNames.includes('flagged'), 'flagged needed by Filter predicate');
    assert.ok(!colNames.includes('name'), 'name is dead — not needed by Filter or RowCount');
    assert.deepEqual(colNames, ['flagged'], 'only the filter predicate column survives');
  });

  it('prunes ForEach body Zip columns not needed downstream', () => {
    // Enrich pattern: source Zip[id,name] → ColumnValues(id) → ForEach body:
    //   body[0] = Get(ByID(Elements(Doc, FCft), forEachIdx=5))
    //   body[1] = Get(Property(0, note))
    //   body[2] = Get(Property(0, flagged))
    //   body[3] = Zip([{id,5}, {note,1}, {flagged,2}])
    // ForEach(source=4, body, collect=3)
    // HashJoin(source=3, lookup=5, sourceKey:id, lookupKey:id, fieldMap:{note:note})
    //   → only 'note' is pulled from the ForEach, so 'flagged' in the body is dead
    // Pick[name, note]
    const plan: EventPlan = {
      nodes: [
        // 0: Get(Elements)
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        // 1: Get(id)
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
        // 2: Get(name)
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        // 3: Zip[id, name]
        { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }] },
        // 4: ColumnValues(3, 'id')
        { kind: 'ColumnValues', source: 3 as Ref, field: 'id' },
        // 5: ForEach — body reads note+flagged, but only note needed
        { kind: 'ForEach',
          source: 4 as Ref,
          body: [
            // body[0]: Get(ByID(Elements(Doc, FCft), forEachIdx=5))
            { kind: 'Get', specifier: { kind: 'ByID', parent: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, id: 5 as Ref }, effect: 'nonMutating' },
            // body[1]: Get(Property(0, note))
            { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCno' }, effect: 'nonMutating' },
            // body[2]: Get(Property(0, flagged))
            { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCfl' }, effect: 'nonMutating' },
            // body[3]: Zip[id, note, flagged]
            { kind: 'Zip', columns: [{ name: 'id', ref: 5 as Ref }, { name: 'note', ref: 1 }, { name: 'flagged', ref: 2 }] },
          ],
          collect: 3,
          effect: 'nonMutating',
        },
        // 6: HashJoin(source=3, lookup=5, fieldMap:{note:note})
        { kind: 'HashJoin', source: 3 as Ref, lookup: 5 as Ref, sourceKey: 'id', lookupKey: 'id', fieldMap: { note: 'note' } },
        // 7: Pick[name, note]
        { kind: 'Pick', source: 6 as Ref, fields: ['name', 'note'] },
      ],
      result: 7,
    };

    const pruned = pruneColumns(plan);

    // Find the ForEach node
    const fe = findOne(pruned, 'ForEach') as Extract<EventNode, { kind: 'ForEach' }>;

    // Body Zip should only have 'id' and 'note' — 'flagged' pruned
    const bodyZip = fe.body[fe.collect] as Extract<EventNode, { kind: 'Zip' }>;
    assert.equal(bodyZip.kind, 'Zip');
    const bodyColNames = bodyZip.columns.map(c => c.name);
    assert.ok(bodyColNames.includes('id'), 'id needed by HashJoin lookupKey');
    assert.ok(bodyColNames.includes('note'), 'note needed by HashJoin fieldMap');
    assert.ok(!bodyColNames.includes('flagged'), 'flagged is dead — not in fieldMap');

    // Dead body Get(flagged) should be removed
    const bodyGets = fe.body.filter(n => n.kind === 'Get');
    // Should have: ByID + note = 2 Gets (flagged removed)
    assert.equal(bodyGets.length, 2, 'dead Get(flagged) removed from body');

    // Body should have 3 nodes total: ByID, note, Zip
    assert.equal(fe.body.length, 3, 'body compacted from 4 to 3 nodes');
  });

  it('preserves all ForEach body columns when all are needed', () => {
    // Same structure but HashJoin fieldMap needs both note and flagged
    const plan: EventPlan = {
      nodes: [
        { kind: 'Get', specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'pnam' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }] },
        { kind: 'ColumnValues', source: 3 as Ref, field: 'id' },
        { kind: 'ForEach',
          source: 4 as Ref,
          body: [
            { kind: 'Get', specifier: { kind: 'ByID', parent: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' }, id: 5 as Ref }, effect: 'nonMutating' },
            { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCno' }, effect: 'nonMutating' },
            { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'FCfl' }, effect: 'nonMutating' },
            { kind: 'Zip', columns: [{ name: 'id', ref: 5 as Ref }, { name: 'note', ref: 1 }, { name: 'flagged', ref: 2 }] },
          ],
          collect: 3,
          effect: 'nonMutating',
        },
        // Both note AND flagged pulled from ForEach
        { kind: 'HashJoin', source: 3 as Ref, lookup: 5 as Ref, sourceKey: 'id', lookupKey: 'id', fieldMap: { note: 'note', flagged: 'flagged' } },
        { kind: 'Pick', source: 6 as Ref, fields: ['name', 'note', 'flagged'] },
      ],
      result: 7,
    };

    const pruned = pruneColumns(plan);

    const fe = findOne(pruned, 'ForEach') as Extract<EventNode, { kind: 'ForEach' }>;
    const bodyZip = fe.body[fe.collect] as Extract<EventNode, { kind: 'Zip' }>;
    const bodyColNames = bodyZip.columns.map(c => c.name);
    assert.ok(bodyColNames.includes('id'), 'id preserved');
    assert.ok(bodyColNames.includes('note'), 'note preserved');
    assert.ok(bodyColNames.includes('flagged'), 'flagged preserved — in fieldMap');
    assert.equal(fe.body.length, 4, 'body unchanged — all columns needed');
  });

  it('end-to-end: prunes extra select columns not needed by Pick', () => {
    // Task query selecting [name, flagged] but Pick narrowed to [name].
    // Use predicate:true (no active filter) so no active-filter columns are
    // injected. The 'flagged' column should be prunable.
    //
    // Build the plan with select: ['name', 'flagged'], then replace the
    // pipeline-generated Pick[name,flagged] with Pick[name] to test pruning.
    let setIr = buildSetIrPlan({
      predicate: true,
      entity: 'tasks',
      op: 'get',
      select: ['name', 'flagged'],
    });
    setIr = optimizeSetIr(setIr);
    const ep = lowerSetIrToEventPlan(setIr, ['name', 'flagged']);

    // Replace the existing Pick to narrow to just ['name']
    for (let i = 0; i < ep.nodes.length; i++) {
      const n = ep.nodes[i];
      if (n.kind === 'Pick') {
        ep.nodes[i] = { ...n, fields: ['name'] };
      }
    }

    const csed = cseEventPlan(ep);
    const pruned = pruneColumns(csed);

    // The task-side Zip should have 'name' and 'id' (project exclusion) but not 'flagged'
    const zips = findNodes(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>[];
    const taskZip = zips.find(z => z.columns.some(c => c.name === 'name'));
    assert.ok(taskZip, 'should have a Zip with the name column');
    const colNames = taskZip!.columns.map(c => c.name);
    assert.ok(colNames.includes('name'), 'needed by Pick');
    assert.ok(colNames.includes('id'), 'needed by project-exclusion SemiJoin');
    assert.ok(!colNames.includes('flagged'), 'flagged is dead — pruned by Pick');
  });
});
