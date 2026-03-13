/**
 * Unit tests for Node ExecutionUnit executor (executeNodeUnit)
 * and orchestrator (executeTargetedPlan with node-only plans).
 *
 * Verifies all in-memory ops with mock data: Zip, Filter, SemiJoin,
 * HashJoin, Sort, Limit, Pick, ColumnValues, Flatten, Derive.
 * Also tests the orchestrator's topoSort, result threading, and
 * multi-unit execution for pure-node plans (no JXA/OmniJS).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventNode, Ref, RuntimeAllocation } from '../dist/tools/query/eventPlan.js';
import type { TargetedEventPlan, TargetedNode, ExecutionUnit, Input } from '../dist/tools/query/targetedEventPlan.js';
import { executeNodeUnit } from '../dist/tools/query/executionUnits/nodeUnit.js';
import {
  executeTargetedPlan,
  computeExportedRefs,
  unpackResult,
  buildInputMap,
  compileEventPlanToTargetedPlan,
  executeEventPlanPipeline,
} from '../dist/tools/query/executionUnits/orchestrator.js';
import { splitExecutionUnits } from '../dist/tools/query/targetedEventPlanLowering.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const doc = { kind: 'Document' as const };

function makeTargetedNode(node: EventNode, runtime: string, kind: 'proposed' | 'fixed' = 'proposed'): TargetedNode {
  return { ...node, runtimeAllocation: { kind, runtime } as RuntimeAllocation } as TargetedNode;
}

function makeTargetedPlan(nodes: TargetedNode[], result?: Ref): TargetedEventPlan {
  return { nodes, result: result ?? nodes.length - 1 };
}

/** Convert Ref[] to Input[] (all 'value' kind). */
function vi(...refs: Ref[]): Input[] {
  return refs.map(ref => ({ ref, kind: 'value' as const }));
}

/** Placeholder JXA node at index 0 for plans that need an upstream ref. */
const jxaPlaceholder: TargetedNode = makeTargetedNode(
  { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
  'jxa',
);

// ── Zip ──────────────────────────────────────────────────────────────────

describe('executeNodeUnit — Zip', () => {

  it('zips columns into row objects', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' }, 'jxa'),
      makeTargetedNode({ kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }] }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 2);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [2], inputs: vi(0, 1), outputs: [], result: 2, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, ['id1', 'id2', 'id3']);
    results.set(1, ['Task A', 'Task B', 'Task C']);

    const value = executeNodeUnit(unit, plan, results);
    assert.deepEqual(value, [
      { id: 'id1', name: 'Task A' },
      { id: 'id2', name: 'Task B' },
      { id: 'id3', name: 'Task C' },
    ]);
  });

  it('returns empty array for empty columns', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode({ kind: 'Zip', columns: [] }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [0], inputs: vi(), outputs: [], result: 0, dependsOn: [] };

    const value = executeNodeUnit(unit, plan, new Map());
    assert.deepEqual(value, []);
  });
});

// ── Filter ───────────────────────────────────────────────────────────────

describe('executeNodeUnit — Filter', () => {

  it('filters rows by equality predicate', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Filter', source: 0, entity: 'tasks', predicate: { op: 'eq', args: [{ var: 'flagged' }, true] } }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { id: 'id1', name: 'Buy milk', flagged: true },
      { id: 'id2', name: 'Review PR', flagged: false },
      { id: 'id3', name: 'Ship feature', flagged: true },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 2);
    assert.equal(value[0].name, 'Buy milk');
    assert.equal(value[1].name, 'Ship feature');
  });

  it('null predicate passes through all rows (defensive)', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Filter', source: 0, predicate: null as any }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    const rows = [
      { id: 'id1', name: 'A' },
      { id: 'id2', name: 'B' },
    ];
    results.set(0, rows);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 2, 'null predicate should pass all rows through');
  });

  it('true predicate passes through all rows (defensive)', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Filter', source: 0, predicate: true as any }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    const rows = [
      { id: 'id1', name: 'A' },
      { id: 'id2', name: 'B' },
    ];
    results.set(0, rows);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 2, 'true predicate should pass all rows through');
  });

  it('filters rows by string contains predicate', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Filter', source: 0, entity: 'tasks', predicate: { op: 'contains', args: [{ var: 'name' }, 'review'] } }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { name: 'Code Review' },
      { name: 'Buy groceries' },
      { name: 'Review PR' },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 2);
    assert.equal(value[0].name, 'Code Review');
    assert.equal(value[1].name, 'Review PR');
  });
});

// ── SemiJoin ─────────────────────────────────────────────────────────────

describe('executeNodeUnit — SemiJoin', () => {

  it('filters rows by id Set membership', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' }, 'jxa'),
      makeTargetedNode({ kind: 'SemiJoin', source: 0, ids: 1 }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 2);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [2], inputs: vi(0, 1), outputs: [], result: 2, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { id: 'id1', name: 'A' },
      { id: 'id2', name: 'B' },
      { id: 'id3', name: 'C' },
    ]);
    results.set(1, new Set(['id1', 'id3']));

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 2);
    assert.equal(value[0].id, 'id1');
    assert.equal(value[1].id, 'id3');
  });

  it('accepts array of ids (not just Set)', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' }, 'jxa'),
      makeTargetedNode({ kind: 'SemiJoin', source: 0, ids: 1 }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 2);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [2], inputs: vi(0, 1), outputs: [], result: 2, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [{ id: 'a', name: 'X' }, { id: 'b', name: 'Y' }]);
    results.set(1, ['b']);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 1);
    assert.equal(value[0].id, 'b');
  });
});

// ── Sort ─────────────────────────────────────────────────────────────────

describe('executeNodeUnit — Sort', () => {

  it('sorts rows ascending by string field', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Sort', source: 0, by: 'name', dir: 'asc' }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [{ name: 'Charlie' }, { name: 'Alice' }, { name: 'Bob' }]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.deepEqual(value.map((r: any) => r.name), ['Alice', 'Bob', 'Charlie']);
  });

  it('sorts rows descending', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Sort', source: 0, by: 'name', dir: 'desc' }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [{ name: 'A' }, { name: 'C' }, { name: 'B' }]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.deepEqual(value.map((r: any) => r.name), ['C', 'B', 'A']);
  });

  it('nulls sort last', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Sort', source: 0, by: 'dueDate', dir: 'asc' }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { name: 'No date', dueDate: null },
      { name: 'Has date', dueDate: '2026-01-01' },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value[0].name, 'Has date');
    assert.equal(value[1].name, 'No date');
  });

  it('sorts by numeric field', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Sort', source: 0, by: 'estimatedMinutes', dir: 'asc' }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { name: 'Big', estimatedMinutes: 120 },
      { name: 'Small', estimatedMinutes: 15 },
      { name: 'Medium', estimatedMinutes: 45 },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.deepEqual(value.map((r: any) => r.name), ['Small', 'Medium', 'Big']);
  });

  it('does not mutate original array', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Sort', source: 0, by: 'name', dir: 'asc' }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const original = [{ name: 'B' }, { name: 'A' }];
    const results = new Map<number, unknown>();
    results.set(0, original);

    executeNodeUnit(unit, plan, results);
    assert.equal(original[0].name, 'B', 'original array should not be mutated');
  });
});

// ── Limit ────────────────────────────────────────────────────────────────

describe('executeNodeUnit — Limit', () => {

  it('limits rows', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Limit', source: 0, n: 2 }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 2);
    assert.equal(value[0].id, '1');
    assert.equal(value[1].id, '2');
  });

  it('returns all rows when limit exceeds count', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Limit', source: 0, n: 100 }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [{ id: '1' }, { id: '2' }]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 2);
  });
});

// ── Pick ─────────────────────────────────────────────────────────────────

describe('executeNodeUnit — Pick', () => {

  it('projects fields from rows', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Pick', source: 0, fields: ['name'] }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { id: '1', name: 'A', flagged: true },
      { id: '2', name: 'B', flagged: false },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.deepEqual(value, [{ name: 'A' }, { name: 'B' }]);
  });

  it('picks multiple fields', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Pick', source: 0, fields: ['id', 'name'] }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [{ id: '1', name: 'A', flagged: true, dueDate: null }]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.deepEqual(value, [{ id: '1', name: 'A' }]);
  });
});

// ── ColumnValues ─────────────────────────────────────────────────────────

describe('executeNodeUnit — ColumnValues', () => {

  it('extracts a column from rows', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'ColumnValues', source: 0, field: 'id' }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [{ id: 'a', name: 'X' }, { id: 'b', name: 'Y' }]);

    const value = executeNodeUnit(unit, plan, results);
    assert.deepEqual(value, ['a', 'b']);
  });
});

// ── Flatten ──────────────────────────────────────────────────────────────

describe('executeNodeUnit — Flatten', () => {

  it('flattens nested arrays', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Flatten', source: 0 }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [['a', 'b'], [], ['c']]);

    const value = executeNodeUnit(unit, plan, results);
    assert.deepEqual(value, ['a', 'b', 'c']);
  });

  it('handles empty input', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Flatten', source: 0 }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, []);

    const value = executeNodeUnit(unit, plan, results);
    assert.deepEqual(value, []);
  });
});

// ── HashJoin ─────────────────────────────────────────────────────────────

describe('executeNodeUnit — HashJoin', () => {

  it('joins source rows with lookup rows (direct mode)', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCff' }, effect: 'nonMutating' }, 'jxa'),
      makeTargetedNode({
        kind: 'HashJoin',
        source: 0,
        lookup: 1,
        sourceKey: 'folderId',
        lookupKey: 'id',
        fieldMap: { name: 'folderName' },
      }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 2);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [2], inputs: vi(0, 1), outputs: [], result: 2, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { id: 'p1', name: 'Project A', folderId: 'f1' },
      { id: 'p2', name: 'Project B', folderId: 'f2' },
      { id: 'p3', name: 'Project C', folderId: null },
    ]);
    results.set(1, [
      { id: 'f1', name: 'Work' },
      { id: 'f2', name: 'Personal' },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 3);
    assert.equal(value[0].folderName, 'Work');
    assert.equal(value[1].folderName, 'Personal');
    assert.equal(value[2].folderName, null);
  });

  it('null-fills unmatched foreign keys', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCff' }, effect: 'nonMutating' }, 'jxa'),
      makeTargetedNode({
        kind: 'HashJoin',
        source: 0,
        lookup: 1,
        sourceKey: 'folderId',
        lookupKey: 'id',
        fieldMap: { name: 'folderName' },
      }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 2);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [2], inputs: vi(0, 1), outputs: [], result: 2, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [{ id: 'p1', folderId: 'f_nonexistent' }]);
    results.set(1, [{ id: 'f1', name: 'Work' }]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value[0].folderName, null, 'unmatched FK should produce null');
  });

  it('count-aggregation mode with wildcard fieldMap', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' }, 'jxa'),
      makeTargetedNode({
        kind: 'HashJoin',
        source: 0,
        lookup: 1,
        sourceKey: 'id',
        lookupKey: 'folderId',
        fieldMap: { '*': 'projectCount' },
      }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 2);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [2], inputs: vi(0, 1), outputs: [], result: 2, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { id: 'f1', name: 'Work' },
      { id: 'f2', name: 'Personal' },
    ]);
    results.set(1, [
      { folderId: 'f1' },
      { folderId: 'f1' },
      { folderId: 'f1' },
      { folderId: 'f2' },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value[0].projectCount, 3);
    assert.equal(value[1].projectCount, 1);
  });

  it('count-aggregation returns 0 for unmatched keys', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' }, 'jxa'),
      makeTargetedNode({
        kind: 'HashJoin',
        source: 0,
        lookup: 1,
        sourceKey: 'id',
        lookupKey: 'folderId',
        fieldMap: { '*': 'projectCount' },
      }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 2);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [2], inputs: vi(0, 1), outputs: [], result: 2, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [{ id: 'f1', name: 'Empty folder' }]);
    results.set(1, []); // no projects

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value[0].projectCount, 0);
  });
});

// ── Derive ───────────────────────────────────────────────────────────────

describe('executeNodeUnit — Derive', () => {

  it('derives taskStatus from bulk booleans', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({
        kind: 'Derive',
        source: 0,
        derivations: [{ var: 'status', entity: 'tasks' }],
      }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { completed: true, dropped: false, blocked: false, dueDate: null },
      { completed: false, dropped: true, blocked: false, dueDate: null },
      { completed: false, dropped: false, blocked: true, dueDate: null },
      { completed: false, dropped: false, blocked: false, dueDate: null },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value[0].status, 'Completed');
    assert.equal(value[1].status, 'Dropped');
    assert.equal(value[2].status, 'Blocked');
    assert.equal(value[3].status, 'Next');
  });

  it('derives folderStatus from hidden flag', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({
        kind: 'Derive',
        source: 0,
        derivations: [{ var: 'status', entity: 'folders' }],
      }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { name: 'Active', hidden: false },
      { name: 'Hidden', hidden: true },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value[0].status, 'Active');
    assert.equal(value[1].status, 'Dropped');
  });

  it('skips unknown derivation specs gracefully', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({
        kind: 'Derive',
        source: 0,
        derivations: [{ var: 'nonexistent', entity: 'tasks' }],
      }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [{ name: 'A' }]);

    // Should not throw
    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 1);
    assert.equal(value[0].nonexistent, undefined);
  });
});

// ── Multi-op pipeline ────────────────────────────────────────────────────

describe('executeNodeUnit — multi-op pipeline', () => {

  it('chains Zip -> Filter -> Sort -> Limit', () => {
    const nodes: TargetedNode[] = [
      // 0, 1: external JXA refs (ids, names)
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' }, 'jxa'),
      // 2: Zip
      makeTargetedNode({ kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }] }, 'node'),
      // 3: Filter
      makeTargetedNode({ kind: 'Filter', source: 2, entity: 'tasks', predicate: { op: 'startsWith', args: [{ var: 'name' }, 'T'] } }, 'node'),
      // 4: Sort
      makeTargetedNode({ kind: 'Sort', source: 3, by: 'name', dir: 'asc' }, 'node'),
      // 5: Limit
      makeTargetedNode({ kind: 'Limit', source: 4, n: 2 }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 5);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [2, 3, 4, 5], inputs: vi(0, 1), outputs: [], result: 5, dependsOn: [] };

    const results = new Map<number, unknown>();
    results.set(0, ['id1', 'id2', 'id3', 'id4', 'id5']);
    results.set(1, ['Task C', 'Apple', 'Task A', 'Banana', 'Task B']);

    const value = executeNodeUnit(unit, plan, results) as any[];
    // Filter keeps: Task C, Task A, Task B
    // Sort asc: Task A, Task B, Task C
    // Limit 2: Task A, Task B
    assert.equal(value.length, 2);
    assert.equal(value[0].name, 'Task A');
    assert.equal(value[1].name, 'Task B');
  });

  it('chains Zip -> HashJoin -> Pick', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder, // 0: project ids/names
      makeTargetedNode({ kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCff' }, effect: 'nonMutating' }, 'jxa'), // 1: folder data
      // 2: Zip projects
      makeTargetedNode({ kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'folderId', ref: 0 }] }, 'node'),
      // 3: HashJoin with folders
      makeTargetedNode({
        kind: 'HashJoin', source: 2, lookup: 1,
        sourceKey: 'folderId', lookupKey: 'id', fieldMap: { name: 'folderName' },
      }, 'node'),
      // 4: Pick
      makeTargetedNode({ kind: 'Pick', source: 3, fields: ['id', 'folderName'] }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 4);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [2, 3, 4], inputs: vi(0, 1), outputs: [], result: 4, dependsOn: [] };

    const results = new Map<number, unknown>();
    results.set(0, ['p1', 'p2']);
    results.set(1, [{ id: 'p1', name: 'Work' }, { id: 'p2', name: 'Personal' }]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 2);
    // Each row should only have id and folderName
    for (const row of value) {
      const keys = Object.keys(row);
      assert.ok(keys.includes('id'));
      assert.ok(keys.includes('folderName'));
      assert.ok(!keys.includes('folderId'), 'folderId should be stripped by Pick');
    }
  });
});

// ── Error handling ───────────────────────────────────────────────────────

describe('executeNodeUnit — error handling', () => {

  it('rejects non-node runtime unit', () => {
    const nodes: TargetedNode[] = [jxaPlaceholder];
    const plan = makeTargetedPlan(nodes, 0);
    const unit: ExecutionUnit = { runtime: 'jxa', nodes: [0], inputs: vi(), outputs: [], result: 0, dependsOn: [] };
    assert.throws(() => executeNodeUnit(unit, plan, new Map()), /expected runtime 'node'/);
  });

  it('throws on unexpected node kind in Node unit', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode({ kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [0], inputs: vi(), outputs: [], result: 0, dependsOn: [] };
    assert.throws(() => executeNodeUnit(unit, plan, new Map()), /unexpected node kind/);
  });

  it('throws on unresolved ref', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Sort', source: 0, by: 'name', dir: 'asc' }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [] };
    // Don't set ref 0 in results
    assert.throws(() => executeNodeUnit(unit, plan, new Map()), /unresolved ref/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Orchestrator smoke tests (node-only plans — no JXA/OmniJS round-trips)
// ══════════════════════════════════════════════════════════════════════════

describe('executeTargetedPlan — single node unit', () => {

  it('executes a Zip-only plan and returns result', async () => {
    // Build a plan where node 0 and 1 are "pre-resolved" JXA results,
    // and node 2 is a Zip that runs in Node.
    // We can't pre-seed results in executeTargetedPlan (it builds its own
    // results map), so we need a fully self-contained node-only plan.
    //
    // A Zip with zero columns is the simplest self-contained node plan.
    const nodes: TargetedNode[] = [
      makeTargetedNode({ kind: 'Zip', columns: [] }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 0);

    const result = await executeTargetedPlan(plan);
    assert.deepEqual(result.value, []);
    assert.equal(result.timings.length, 1);
    assert.equal(result.timings[0].runtime, 'node');
  });
});

describe('executeTargetedPlan — multi-node unit', () => {

  it('coalesces same-runtime nodes into one unit and chains ops', async () => {
    // splitExecutionUnits coalesces consecutive same-runtime nodes.
    // Zip→Flatten both run in node, so they become one unit internally.
    const nodes: TargetedNode[] = [
      makeTargetedNode({ kind: 'Zip', columns: [] }, 'node'),
      makeTargetedNode({ kind: 'Flatten', source: 0 }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);

    // Verify coalescing — both nodes in one unit
    const units = splitExecutionUnits(plan);
    assert.equal(units.length, 1, 'same-runtime nodes should coalesce');
    assert.deepEqual(units[0].nodes, [0, 1]);

    const result = await executeTargetedPlan(plan);
    assert.deepEqual(result.value, []);
    assert.equal(result.timings.length, 1, 'one unit = one timing entry');
  });

  it('chains Zip → Limit through the orchestrator', async () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode({ kind: 'Zip', columns: [] }, 'node'),
      makeTargetedNode({ kind: 'Limit', source: 0, n: 5 }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 1);

    const result = await executeTargetedPlan(plan);
    assert.deepEqual(result.value, []);
  });
});

describe('pass-composed execution helpers', () => {

  it('compileEventPlanToTargetedPlan targets a node-only EventPlan', () => {
    const eventPlan = {
      nodes: [
        { kind: 'Zip', columns: [] },
        { kind: 'Limit', source: 0, n: 1 },
      ],
      result: 1,
    } as const;

    const targeted = compileEventPlanToTargetedPlan(eventPlan);
    assert.equal(targeted.nodes[0].runtimeAllocation.runtime, 'node');
    assert.equal(targeted.nodes[1].runtimeAllocation.runtime, 'node');
  });

  it('executeEventPlanPipeline executes a node-only EventPlan', async () => {
    const eventPlan = {
      nodes: [
        { kind: 'Zip', columns: [] },
        { kind: 'Limit', source: 0, n: 1 },
      ],
      result: 1,
    } as const;

    const result = await executeEventPlanPipeline(eventPlan);
    assert.deepEqual(result.value, []);
    assert.equal(result.timings.length, 1);
    assert.equal(result.timings[0].runtime, 'node');
  });

  it('repeated executeEventPlanPipeline calls do not leak state', async () => {
    const eventPlan = {
      nodes: [
        { kind: 'Zip', columns: [] },
        { kind: 'Limit', source: 0, n: 1 },
      ],
      result: 1,
    } as const;

    const first = await executeEventPlanPipeline(eventPlan);
    const second = await executeEventPlanPipeline(eventPlan);

    assert.deepEqual(first.value, []);
    assert.deepEqual(second.value, []);
    assert.equal(first.timings[0].runtime, 'node');
    assert.equal(second.timings[0].runtime, 'node');
  });
});

describe('executeTargetedPlan — result shape', () => {

  it('returns OrchestratorResult with value and timings', async () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode({ kind: 'Zip', columns: [] }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 0);

    const result = await executeTargetedPlan(plan);
    assert.ok('value' in result, 'result should have value');
    assert.ok('timings' in result, 'result should have timings');
    assert.ok(Array.isArray(result.timings), 'timings should be an array');
    for (const t of result.timings) {
      assert.ok('runtime' in t, 'timing entry should have runtime');
      assert.ok('refs' in t, 'timing entry should have refs');
      assert.ok('ms' in t, 'timing entry should have ms');
      assert.ok(typeof t.ms === 'number', 'ms should be a number');
    }
  });

  it('timings record node units as runtime "node"', async () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode({ kind: 'Zip', columns: [] }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 0);

    const result = await executeTargetedPlan(plan);
    assert.equal(result.timings[0].runtime, 'node');
    assert.deepEqual(result.timings[0].refs, [0]);
  });
});

describe('executeTargetedPlan — error handling', () => {

  it('rejects unsupported runtime', async () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode({ kind: 'Zip', columns: [] }, 'bogus' as any),
    ];
    const plan = makeTargetedPlan(nodes, 0);

    // Build a fake unit with unsupported runtime
    await assert.rejects(
      () => executeTargetedPlan(plan),
      /unsupported runtime/,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Regression tests: cross-unit multi-ref export (bug #15)
//
// The orchestrator originally only stored unit.result for each unit.
// Downstream Node units that consumed multiple refs from an upstream JXA
// unit would fail because only one ref was populated in the results map.
// These tests exercise computeExportedRefs, unpackResult, and
// buildInputMap — the three functions that implement the fix.
// ══════════════════════════════════════════════════════════════════════════

describe('computeExportedRefs — cross-unit export detection', () => {

  it('includes unit.result even when no downstream consumers exist', () => {
    const unitA: ExecutionUnit = {
      runtime: 'jxa', nodes: [0, 1], inputs: vi(), outputs: [], result: 1, dependsOn: [],
    };
    const refs = computeExportedRefs(unitA, [unitA]);
    assert.deepEqual(refs, [1], 'should include unit.result');
  });

  it('includes refs consumed by downstream units', () => {
    // JXA unit produces refs 0 (elements) and 1 (names).
    // Node unit consumes both 0 and 1 for a Zip.
    const unitA: ExecutionUnit = {
      runtime: 'jxa', nodes: [0, 1], inputs: vi(), outputs: [], result: 1, dependsOn: [],
    };
    const unitB: ExecutionUnit = {
      runtime: 'node', nodes: [2], inputs: vi(0, 1), outputs: [], result: 2, dependsOn: [unitA],
    };
    const refs = computeExportedRefs(unitA, [unitA, unitB]);
    assert.deepEqual(refs, [0, 1], 'should export both refs consumed by unitB');
  });

  it('does not include refs not consumed by any downstream unit', () => {
    // JXA unit has nodes [0, 1, 2], but downstream only needs ref 2
    const unitA: ExecutionUnit = {
      runtime: 'jxa', nodes: [0, 1, 2], inputs: vi(), outputs: [], result: 2, dependsOn: [],
    };
    const unitB: ExecutionUnit = {
      runtime: 'node', nodes: [3], inputs: vi(2), outputs: [], result: 3, dependsOn: [unitA],
    };
    const refs = computeExportedRefs(unitA, [unitA, unitB]);
    assert.deepEqual(refs, [2], 'should only export ref 2 (result and consumed)');
  });

  it('exports refs consumed by multiple downstream units', () => {
    const unitA: ExecutionUnit = {
      runtime: 'jxa', nodes: [0, 1, 2], inputs: vi(), outputs: [], result: 2, dependsOn: [],
    };
    const unitB: ExecutionUnit = {
      runtime: 'node', nodes: [3], inputs: vi(0, 2), outputs: [], result: 3, dependsOn: [unitA],
    };
    const unitC: ExecutionUnit = {
      runtime: 'node', nodes: [4], inputs: vi(1, 2), outputs: [], result: 4, dependsOn: [unitA],
    };
    const refs = computeExportedRefs(unitA, [unitA, unitB, unitC]);
    assert.deepEqual(refs, [0, 1, 2], 'should export all three consumed refs');
  });

  it('returns sorted refs for deterministic codegen', () => {
    const unitA: ExecutionUnit = {
      runtime: 'jxa', nodes: [0, 1, 2], inputs: vi(), outputs: [], result: 0, dependsOn: [],
    };
    const unitB: ExecutionUnit = {
      runtime: 'node', nodes: [3], inputs: vi(2, 1), outputs: [], result: 3, dependsOn: [unitA],
    };
    const refs = computeExportedRefs(unitA, [unitA, unitB]);
    // result=0 plus consumed 1,2 → sorted [0, 1, 2]
    assert.deepEqual(refs, [0, 1, 2]);
    // Verify sorted
    for (let i = 1; i < refs.length; i++) {
      assert.ok(refs[i] > refs[i - 1], 'refs should be in ascending order');
    }
  });
});

describe('unpackResult — multi-ref unpacking', () => {

  it('unpacks multi-export object into results map', () => {
    const unit: ExecutionUnit = {
      runtime: 'jxa', nodes: [0, 1], inputs: vi(), outputs: [], result: 1, dependsOn: [],
    };
    const results = new Map<number, unknown>();
    const rawResult = { '0': ['id1', 'id2'], '1': ['Task A', 'Task B'] };

    unpackResult(unit, [0, 1], rawResult, results);

    assert.deepEqual(results.get(0), ['id1', 'id2'], 'ref 0 should be unpacked');
    assert.deepEqual(results.get(1), ['Task A', 'Task B'], 'ref 1 should be unpacked');
  });

  it('unpacks single-export as plain result at unit.result', () => {
    const unit: ExecutionUnit = {
      runtime: 'jxa', nodes: [0], inputs: vi(), outputs: [], result: 0, dependsOn: [],
    };
    const results = new Map<number, unknown>();
    const rawResult = ['id1', 'id2', 'id3'];

    unpackResult(unit, [0], rawResult, results);

    assert.deepEqual(results.get(0), ['id1', 'id2', 'id3']);
  });

  it('handles null and undefined values in multi-export', () => {
    const unit: ExecutionUnit = {
      runtime: 'jxa', nodes: [0, 1, 2], inputs: vi(), outputs: [], result: 2, dependsOn: [],
    };
    const results = new Map<number, unknown>();
    const rawResult = { '0': null, '1': undefined, '2': [1, 2, 3] };

    unpackResult(unit, [0, 1, 2], rawResult, results);

    assert.equal(results.get(0), null, 'null should be stored');
    assert.equal(results.get(1), undefined, 'undefined should be stored');
    assert.deepEqual(results.get(2), [1, 2, 3]);
  });

  it('multi-export with 3+ refs populates all entries', () => {
    const unit: ExecutionUnit = {
      runtime: 'jxa', nodes: [0, 1, 2, 3], inputs: vi(), outputs: [], result: 3, dependsOn: [],
    };
    const results = new Map<number, unknown>();
    const rawResult = {
      '0': ['a', 'b'],
      '1': ['x', 'y'],
      '2': [true, false],
      '3': [{ id: 'a', name: 'x', flagged: true }, { id: 'b', name: 'y', flagged: false }],
    };

    unpackResult(unit, [0, 1, 2, 3], rawResult, results);

    assert.equal(results.size, 4, 'all 4 refs should be in results');
    assert.deepEqual(results.get(0), ['a', 'b']);
    assert.deepEqual(results.get(1), ['x', 'y']);
    assert.deepEqual(results.get(2), [true, false]);
    assert.equal((results.get(3) as any[]).length, 2);
  });
});

describe('buildInputMap — cross-unit input serialisation', () => {

  it('serialises upstream results as JSON.parse() expressions', () => {
    const unit: ExecutionUnit = {
      runtime: 'jxa', nodes: [2], inputs: vi(0, 1), outputs: [], result: 2, dependsOn: [],
    };
    const results = new Map<number, unknown>();
    results.set(0, ['id1', 'id2']);
    results.set(1, ['Task A', 'Task B']);

    const inputs = buildInputMap(unit, results);

    assert.equal(inputs.size, 2, 'should have 2 input mappings');
    // Each input should be a JSON.parse() expression containing the serialised value
    const input0 = inputs.get(0)!;
    const input1 = inputs.get(1)!;
    assert.ok(input0.startsWith('JSON.parse('), 'input 0 should be JSON.parse expression');
    assert.ok(input1.startsWith('JSON.parse('), 'input 1 should be JSON.parse expression');
    // The inner string should be valid JSON containing the original values
    assert.ok(input0.includes('id1'), 'input 0 should contain serialised id1');
    assert.ok(input1.includes('Task A'), 'input 1 should contain serialised Task A');
  });

  it('throws on unresolved input ref', () => {
    const unit: ExecutionUnit = {
      runtime: 'jxa', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [],
    };
    const results = new Map<number, unknown>(); // ref 0 not set

    assert.throws(() => buildInputMap(unit, results), /unresolved input ref/);
  });

  it('handles null and empty array values', () => {
    const unit: ExecutionUnit = {
      runtime: 'node', nodes: [2], inputs: vi(0, 1), outputs: [], result: 2, dependsOn: [],
    };
    const results = new Map<number, unknown>();
    results.set(0, null);
    results.set(1, []);

    const inputs = buildInputMap(unit, results);
    assert.equal(inputs.size, 2);
    assert.ok(inputs.get(0)!.includes('null'), 'null should be serialised');
    assert.ok(inputs.get(1)!.includes('[]'), 'empty array should be serialised');
  });
});

describe('cross-unit multi-ref regression — end-to-end handoff', () => {

  it('computeExportedRefs + unpackResult round-trip populates all downstream inputs', () => {
    // Simulate the orchestrator's actual flow:
    // 1. JXA unit [0,1] produces elements and names
    // 2. Node unit [2] consumes both for a Zip
    // This is the exact pattern that was broken before task #15.

    const unitA: ExecutionUnit = {
      runtime: 'jxa', nodes: [0, 1], inputs: vi(), outputs: [], result: 1, dependsOn: [],
    };
    const unitB: ExecutionUnit = {
      runtime: 'node', nodes: [2], inputs: vi(0, 1), outputs: [], result: 2, dependsOn: [unitA],
    };
    const allUnits = [unitA, unitB];

    // Step 1: compute what unitA must export
    const exports = computeExportedRefs(unitA, allUnits);
    assert.deepEqual(exports, [0, 1], 'unitA should export both refs');

    // Step 2: simulate JXA returning a multi-export result
    const results = new Map<number, unknown>();
    const jxaRawResult = { '0': ['id1', 'id2'], '1': ['Task A', 'Task B'] };
    unpackResult(unitA, exports, jxaRawResult, results);

    // Step 3: verify both refs are available for unitB
    assert.ok(results.has(0), 'ref 0 should be in results for unitB');
    assert.ok(results.has(1), 'ref 1 should be in results for unitB');

    // Step 4: verify buildInputMap can consume both refs
    const inputs = buildInputMap(unitB, results);
    assert.equal(inputs.size, 2, 'unitB should get 2 inputs from upstream');
    assert.ok(inputs.has(0), 'input 0 should be mapped');
    assert.ok(inputs.has(1), 'input 1 should be mapped');

    // Step 5: verify we can feed these into executeNodeUnit
    const nodes: TargetedNode[] = [
      makeTargetedNode({ kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' }, 'jxa'),
      makeTargetedNode({ kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' }, 'jxa'),
      makeTargetedNode({ kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }] }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 2);
    const value = executeNodeUnit(unitB, plan, results);
    assert.deepEqual(value, [
      { id: 'id1', name: 'Task A' },
      { id: 'id2', name: 'Task B' },
    ]);
  });

  it('single-export path still works (no regression from multi-export fix)', () => {
    // When only unit.result is consumed downstream, exports has length 1,
    // and unpackResult should store the raw value directly (not as an object).

    const unitA: ExecutionUnit = {
      runtime: 'jxa', nodes: [0], inputs: vi(), outputs: [], result: 0, dependsOn: [],
    };
    const unitB: ExecutionUnit = {
      runtime: 'node', nodes: [1], inputs: vi(0), outputs: [], result: 1, dependsOn: [unitA],
    };
    const allUnits = [unitA, unitB];

    const exports = computeExportedRefs(unitA, allUnits);
    assert.deepEqual(exports, [0], 'single-export case');

    const results = new Map<number, unknown>();
    unpackResult(unitA, exports, ['id1', 'id2', 'id3'], results);

    assert.deepEqual(results.get(0), ['id1', 'id2', 'id3'], 'single export stores raw array');
  });
});

// ── Filter+Limit fusion ─────────────────────────────────────────────────

describe('executeNodeUnit — Filter+Limit fusion', () => {

  it('produces correct results for Filter→Limit(1) (exists pattern)', () => {
    // Simulate the op:exists pattern: Filter → Limit(1)
    // The Filter should short-circuit after the first matching row.
    const nodes: TargetedNode[] = [
      jxaPlaceholder,                                                                 // 0: upstream rows
      makeTargetedNode({ kind: 'Filter', source: 0, entity: 'tasks', predicate: { op: 'eq', args: [{ var: 'flagged' }, true] } }, 'node'),  // 1: Filter
      makeTargetedNode({ kind: 'Limit', source: 1, n: 1 }, 'node'),                  // 2: Limit(1)
    ];
    const plan = makeTargetedPlan(nodes, 2);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1, 2], inputs: vi(0), outputs: [], result: 2, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { id: 'id1', name: 'A', flagged: false },
      { id: 'id2', name: 'B', flagged: true },
      { id: 'id3', name: 'C', flagged: true },
      { id: 'id4', name: 'D', flagged: true },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 1, 'should return exactly 1 row');
    assert.equal(value[0].id, 'id2', 'should return the first matching row');
  });

  it('produces correct results for Filter→Limit(2)', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Filter', source: 0, entity: 'tasks', predicate: { op: 'eq', args: [{ var: 'flagged' }, true] } }, 'node'),
      makeTargetedNode({ kind: 'Limit', source: 1, n: 2 }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 2);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1, 2], inputs: vi(0), outputs: [], result: 2, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { id: 'id1', flagged: false },
      { id: 'id2', flagged: true },
      { id: 'id3', flagged: false },
      { id: 'id4', flagged: true },
      { id: 'id5', flagged: true },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 2, 'should return exactly 2 rows');
    assert.equal(value[0].id, 'id2');
    assert.equal(value[1].id, 'id4');
  });

  it('returns fewer rows when not enough matches exist', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Filter', source: 0, entity: 'tasks', predicate: { op: 'eq', args: [{ var: 'flagged' }, true] } }, 'node'),
      makeTargetedNode({ kind: 'Limit', source: 1, n: 5 }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 2);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1, 2], inputs: vi(0), outputs: [], result: 2, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { id: 'id1', flagged: false },
      { id: 'id2', flagged: true },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 1, 'should return all matching rows when fewer than limit');
    assert.equal(value[0].id, 'id2');
  });

  it('does NOT fuse when Filter has multiple consumers', () => {
    // Filter at ref 1 consumed by both Limit(ref 2) and Pick(ref 3)
    // The fusion should not occur because the Filter is consumed by two nodes.
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Filter', source: 0, entity: 'tasks', predicate: { op: 'eq', args: [{ var: 'flagged' }, true] } }, 'node'),  // 1
      makeTargetedNode({ kind: 'Limit', source: 1, n: 1 }, 'node'),                  // 2
      makeTargetedNode({ kind: 'Pick', source: 1, fields: ['id'] }, 'node'),          // 3
    ];
    const plan = makeTargetedPlan(nodes, 2);
    // Unit includes all three node-side ops; Filter consumed by both Limit and Pick
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1, 2, 3], inputs: vi(0), outputs: [], result: 2, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { id: 'id1', name: 'A', flagged: false },
      { id: 'id2', name: 'B', flagged: true },
      { id: 'id3', name: 'C', flagged: true },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    // Even without fusion, Limit should produce 1 row
    assert.equal(value.length, 1);
    assert.equal(value[0].id, 'id2');

    // The Pick at ref 3 should see ALL filtered rows (not short-circuited)
    const pickResult = results.get(3) as any[];
    assert.equal(pickResult.length, 2, 'Pick should see all filtered rows (no short-circuit)');
  });

  it('fuses null-predicate Filter with Limit (identity filter)', () => {
    const nodes: TargetedNode[] = [
      jxaPlaceholder,
      makeTargetedNode({ kind: 'Filter', source: 0, predicate: null as any }, 'node'),
      makeTargetedNode({ kind: 'Limit', source: 1, n: 2 }, 'node'),
    ];
    const plan = makeTargetedPlan(nodes, 2);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1, 2], inputs: vi(0), outputs: [], result: 2, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { id: 'id1' },
      { id: 'id2' },
      { id: 'id3' },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    assert.equal(value.length, 2, 'fused null-predicate Filter+Limit should return 2 rows');
    assert.equal(value[0].id, 'id1');
    assert.equal(value[1].id, 'id2');
  });

  it('does NOT fuse when Sort is between Filter and Limit', () => {
    // Filter → Sort → Limit: Limit's source is Sort, not Filter.
    // Fusion must NOT fire because Sort needs all filtered rows to sort correctly.
    const nodes: TargetedNode[] = [
      jxaPlaceholder,                                                                         // 0
      makeTargetedNode({ kind: 'Filter', source: 0, entity: 'tasks', predicate: { op: 'eq', args: [{ var: 'flagged' }, true] } }, 'node'),  // 1
      makeTargetedNode({ kind: 'Sort', source: 1, by: 'name', dir: 'asc' }, 'node'),         // 2
      makeTargetedNode({ kind: 'Limit', source: 2, n: 1 }, 'node'),                          // 3
    ];
    const plan = makeTargetedPlan(nodes, 3);
    const unit: ExecutionUnit = { runtime: 'node', nodes: [1, 2, 3], inputs: vi(0), outputs: [], result: 3, dependsOn: [] };
    const results = new Map<number, unknown>();
    results.set(0, [
      { id: 'id1', name: 'Zebra', flagged: true },
      { id: 'id2', name: 'Apple', flagged: true },
      { id: 'id3', name: 'Mango', flagged: false },
    ]);

    const value = executeNodeUnit(unit, plan, results) as any[];
    // Sort should see both flagged rows, sort them, then Limit takes the first
    assert.equal(value.length, 1);
    assert.equal(value[0].name, 'Apple', 'Sort must see all filtered rows before Limit — Apple comes first alphabetically');
  });
});
