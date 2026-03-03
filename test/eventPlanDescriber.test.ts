import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventPlan, EventNode, Ref } from '../dist/tools/query/eventPlan.js';
import { describeEventPlan, describeTargetedEventPlan, describeSpecifier, describeExecutionUnit } from '../dist/tools/query/eventPlanDescriber.js';
import { targetEventPlan, assignRuntimes, splitExecutionUnits } from '../dist/tools/query/targetedEventPlanLowering.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const doc = { kind: 'Document' as const };

function makePlan(nodes: EventNode[], result?: Ref): EventPlan {
  return { nodes, result: result ?? nodes.length - 1 };
}

// ── describeEventPlan ────────────────────────────────────────────────────

describe('describeEventPlan', () => {

  it('describes a single Get(Elements) node', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
    ]);
    const output = describeEventPlan(plan);
    assert.ok(output.includes('%0 = Get('), 'should contain SSA ref %0');
    assert.ok(output.includes("'FCft'"), 'should contain class code');
    assert.ok(output.includes('result: %0'), 'should show result ref');
  });

  it('describes a multi-node plan with Zip and Filter', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }] },
      { kind: 'Filter', source: 2, predicate: { op: 'contains', args: [{ var: 'name' }, 'review'] } },
    ]);
    const output = describeEventPlan(plan);
    assert.ok(output.includes('%0 = Get('), 'should have node 0');
    assert.ok(output.includes('%1 = Get('), 'should have node 1');
    assert.ok(output.includes('%2 = Zip('), 'should have Zip node');
    assert.ok(output.includes('%3 = Filter('), 'should have Filter node');
    assert.ok(output.includes('result: %3'), 'result should be last node');
  });

  it('does not throw on every EventNode kind', () => {
    // Exercise each node kind to verify exhaustive coverage
    const nodes: EventNode[] = [
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Count', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Set', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, value: 1, effect: 'nonMutating' },
      { kind: 'Command', fourCC: 'delt', target: { kind: 'ByID', parent: doc, id: 'abc' }, args: {}, effect: 'sideEffective' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }] },
      { kind: 'ColumnValues', source: 5, field: 'id' },
      { kind: 'Flatten', source: 6 },
      { kind: 'Filter', source: 5, predicate: { op: 'eq', args: [{ var: 'name' }, 'x'] } },
      { kind: 'SemiJoin', source: 5, ids: 0 },
      { kind: 'HashJoin', source: 5, lookup: 5, sourceKey: 'id', lookupKey: 'id', fieldMap: { name: 'joinedName' } },
      { kind: 'Sort', source: 5, by: 'name', dir: 'asc' },
      { kind: 'Limit', source: 5, n: 10 },
      { kind: 'Pick', source: 5, fields: ['id', 'name'] },
      { kind: 'Derive', source: 5, derivations: [{ var: 'status', entity: 'tasks' }] },
      { kind: 'ForEach', source: 0, body: [
        { kind: 'Get', specifier: { kind: 'Property', parent: 15, propCode: 'pnam' }, effect: 'nonMutating' },
      ], collect: 0, effect: 'nonMutating' },
    ];
    const plan = makePlan(nodes);
    // Should not throw
    const output = describeEventPlan(plan);
    assert.ok(typeof output === 'string');
    assert.ok(output.length > 0);
  });
});

// ── describeTargetedEventPlan ────────────────────────────────────────────

describe('describeTargetedEventPlan', () => {

  it('shows runtimeAllocation for each node (no units)', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }] },
    ]);
    const targeted = assignRuntimes(plan);
    const output = describeTargetedEventPlan(targeted);
    assert.ok(output.includes('[jxa proposed]'), 'Get should be jxa proposed');
    assert.ok(output.includes('[node proposed]'), 'Zip should be node proposed');
    assert.ok(output.includes('result: %1'), 'result should be last ref');
  });

  it('shows unit headers when units are provided', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }] },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const output = describeTargetedEventPlan(targeted, units);
    assert.ok(output.includes('unit 0 [jxa]'), 'should have jxa unit header');
    assert.ok(output.includes('unit 1 [node]'), 'should have node unit header');
  });

  it('shows fixed allocation for hinted nodes', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating', hint: 'jxa' } as any,
    ]);
    const { targeted } = targetEventPlan(plan);
    const output = describeTargetedEventPlan(targeted);
    assert.ok(output.includes('[jxa fixed]'), 'hinted node should show fixed allocation');
  });
});

// ── describeExecutionUnit ────────────────────────────────────────────────

describe('describeExecutionUnit', () => {

  it('renders a single jxa unit', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    assert.equal(units.length, 1);
    const output = describeExecutionUnit(units[0], targeted, 0);
    assert.ok(output.includes('unit 0 [jxa]'), 'should have unit header');
    assert.ok(output.includes('nodes: [%0, %1]'), 'should list node refs');
    assert.ok(output.includes('result: %1'), 'should show result ref');
  });

  it('renders cross-unit inputs and dependsOn', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }] },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const nodeUnit = units.find(u => u.runtime === 'node')!;
    assert.ok(nodeUnit, 'should have a node unit');
    const output = describeExecutionUnit(nodeUnit, targeted, 1);
    assert.ok(output.includes('inputs: [%1, %2]'), 'should show cross-unit inputs');
    assert.ok(output.includes('dependsOn: 1 unit(s)'), 'should show dependency count');
  });

  it('renders without unitIndex', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const output = describeExecutionUnit(units[0], targeted);
    assert.ok(output.startsWith('unit [jxa]'), 'should use generic label without index');
  });
});

// ── describeSpecifier ────────────────────────────────────────────────────

describe('describeSpecifier', () => {

  it('describes Document', () => {
    assert.equal(describeSpecifier({ kind: 'Document' }), 'Document');
  });

  it('describes Elements', () => {
    const result = describeSpecifier({ kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCft' });
    assert.equal(result, "Elements(Document, 'FCft')");
  });

  it('describes Property with Ref parent', () => {
    const result = describeSpecifier({ kind: 'Property', parent: 3 as any, propCode: 'pnam' });
    assert.equal(result, "Property(%3, 'pnam')");
  });

  it('describes ByID with string id', () => {
    const result = describeSpecifier({ kind: 'ByID', parent: { kind: 'Document' }, id: 'abc123' });
    assert.equal(result, "ByID(Document, 'abc123')");
  });

  it('describes ByID with Ref id', () => {
    const result = describeSpecifier({ kind: 'ByID', parent: { kind: 'Document' }, id: 5 });
    assert.equal(result, 'ByID(Document, %5)');
  });

  it('describes ByName', () => {
    const result = describeSpecifier({ kind: 'ByName', parent: { kind: 'Document' }, name: 'My Tag' });
    assert.equal(result, "ByName(Document, 'My Tag')");
  });

  it('describes ByIndex', () => {
    const result = describeSpecifier({ kind: 'ByIndex', parent: { kind: 'Document' }, index: 0 });
    assert.equal(result, 'ByIndex(Document, 0)');
  });

  it('describes nested specifiers', () => {
    const result = describeSpecifier({
      kind: 'Elements',
      parent: { kind: 'Elements', parent: { kind: 'Document' }, classCode: 'FCpr' },
      classCode: 'FCft',
    });
    assert.equal(result, "Elements(Elements(Document, 'FCpr'), 'FCft')");
  });
});
