/**
 * Tests for the EventPlan column pruning pass.
 *
 * Verifies that columns injected by the lowering pass (for active filters
 * and project exclusion) are pruned when a downstream Pick doesn't need them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pruneColumns } from '../dist/tools/query/eventPlanColumnPrune.js';
import { lowerStrategy } from '../dist/tools/query/strategyToEventPlan.js';
import type { EventPlan, EventNode, Ref } from '../dist/tools/query/eventPlan.js';
import type { StrategyNode } from '../dist/tools/query/strategy.js';

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

  it('end-to-end: lowerStrategy + pruneColumns preserves needed injected columns', () => {
    // BulkScan(tasks, [name], includeCompleted:false) + Project[name]
    // Lowering injects effectivelyCompleted+effectivelyDropped (active filter) and id (project exclusion).
    // All injected columns ARE needed: effectivelyCompleted/effectivelyDropped by Filter, id by SemiJoin.
    // So nothing gets pruned — test verifies correctness.
    const strategy: StrategyNode = {
      kind: 'Project',
      source: {
        kind: 'BulkScan',
        entity: 'tasks',
        columns: ['name'],
        includeCompleted: false,
      },
      fields: ['name'],
    };

    const plan = lowerStrategy(strategy);
    const pruned = pruneColumns(plan);

    const pick = findOne(pruned, 'Pick') as Extract<EventNode, { kind: 'Pick' }>;
    assert.deepEqual(pick.fields, ['name']);

    const zip = findOne(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>;
    const colNames = zip.columns.map(c => c.name);
    assert.ok(colNames.includes('name'), 'user-selected column');
    assert.ok(colNames.includes('effectivelyCompleted'), 'needed by active filter');
    assert.ok(colNames.includes('effectivelyDropped'), 'needed by active filter');
    assert.ok(colNames.includes('id'), 'needed by project-exclusion SemiJoin');
  });

  it('end-to-end: prunes extra columns from includeCompleted:true task BulkScan', () => {
    // BulkScan(tasks, [name, flagged], includeCompleted:true) + Project[name]
    // Lowering injects id (for project exclusion). flagged is user-selected
    // but Pick only wants name. So flagged should be pruned.
    // id is needed by SemiJoin, so it stays.
    const strategy: StrategyNode = {
      kind: 'Project',
      source: {
        kind: 'BulkScan',
        entity: 'tasks',
        columns: ['name', 'flagged'],
        includeCompleted: true,
      },
      fields: ['name'],
    };

    const plan = lowerStrategy(strategy);
    const pruned = pruneColumns(plan);

    const zip = findOne(pruned, 'Zip') as Extract<EventNode, { kind: 'Zip' }>;
    const colNames = zip.columns.map(c => c.name);
    assert.ok(colNames.includes('name'), 'needed by Pick');
    assert.ok(colNames.includes('id'), 'needed by project-exclusion SemiJoin');
    assert.ok(!colNames.includes('flagged'), 'flagged is dead — pruned by Pick');
  });
});
