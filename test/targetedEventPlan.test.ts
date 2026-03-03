import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventPlan, EventNode, Ref, Runtime, RuntimeAllocation } from '../dist/tools/query/eventPlan.js';
import type { TargetedEventPlan, ExecutionUnit } from '../dist/tools/query/targetedEventPlan.js';
import { targetEventPlan, assignRuntimes, splitExecutionUnits } from '../dist/tools/query/targetedEventPlanLowering.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build an EventPlan from a list of nodes; result defaults to last node. */
function makePlan(nodes: EventNode[], result?: Ref): EventPlan {
  return { nodes, result: result ?? nodes.length - 1 };
}

/** Return the runtime assigned to the node at `ref` in the targeted plan. */
function nodeRuntime(plan: TargetedEventPlan, ref: Ref): Runtime {
  return plan.nodes[ref].runtimeAllocation.runtime;
}

/** Return the runtimeAllocation for the node at `ref`. */
function nodeAllocation(plan: TargetedEventPlan, ref: Ref): RuntimeAllocation {
  return plan.nodes[ref].runtimeAllocation;
}

/** Find which ExecutionUnit owns the given ref. */
function unitOf(units: ExecutionUnit[], ref: Ref): ExecutionUnit {
  const u = units.find(u => u.nodes.includes(ref));
  assert.ok(u, `no unit contains ref ${ref}`);
  return u;
}

// ── Specifier shortcuts ─────────────────────────────────────────────────

const doc = { kind: 'Document' as const };
const elements = (classCode: string): EventNode =>
  ({ kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode }, effect: 'nonMutating' }) as any;
const property = (parent: Ref, propCode: string): EventNode =>
  ({ kind: 'Get', specifier: { kind: 'Property', parent, propCode }, effect: 'nonMutating' });

// ── Runtime assignment ──────────────────────────────────────────────────

describe('targetEventPlan — runtime assignment', () => {

  it('Get(Elements) → jxa', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
    ]);
    const { targeted } = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 0), 'jxa');
  });

  it('Get(Property) with Elements parent → jxa', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
    ]);
    const { targeted } = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 1), 'jxa');
  });

  it('Filter → node', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }] },
      { kind: 'Filter', source: 3, predicate: { op: 'contains', args: [{ var: 'name' }, 'review'] } },
    ]);
    const { targeted } = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 4), 'node');
  });

  it('Zip → node', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }] },
    ]);
    const { targeted } = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 3), 'node');
  });

  it('Sort → node', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }] },
      { kind: 'Sort', source: 3, by: 'name', dir: 'asc' },
    ]);
    const { targeted } = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 4), 'node');
  });

  it('Limit → node', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 }] },
      { kind: 'Limit', source: 2, n: 10 },
    ]);
    const { targeted } = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 3), 'node');
  });

  it('Pick → node', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }] },
      { kind: 'Pick', source: 3, fields: ['name'] },
    ]);
    const { targeted } = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 4), 'node');
  });

  it('Hint consumed — no node has kind Hint', () => {
    // Hints are now inline annotations (Hinted<T>), not separate Hint nodes.
    // The targeted plan should contain no node with kind 'Hint'.
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating', hint: 'omniJS' } as any,
    ]);
    const { targeted } = targetEventPlan(plan);
    for (const node of targeted.nodes) {
      if (node != null) {
        assert.notEqual((node as any).kind, 'Hint');
      }
    }
  });

  it('Hint overrides default runtime — allocation is fixed', () => {
    // A Get(Elements) node with hint:'omniJS' should produce a fixed allocation,
    // not the default proposed:'jxa'.
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating', hint: 'omniJS' } as any,
    ]);
    const { targeted } = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 0), 'omniJS');
    assert.deepEqual(nodeAllocation(targeted, 0), { kind: 'fixed', runtime: 'omniJS' });
  });

  it('Un-hinted node gets proposed allocation', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
    ]);
    const { targeted } = targetEventPlan(plan);
    assert.deepEqual(nodeAllocation(targeted, 0), { kind: 'proposed', runtime: 'jxa' });
  });

  it('Hint field is stripped from targeted node', () => {
    // After assignRuntimes the hint property must be absent from the output node,
    // consumed into runtimeAllocation.
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating', hint: 'omniJS' } as any,
    ]);
    const { targeted } = targetEventPlan(plan);
    assert.ok(!('hint' in targeted.nodes[0]), 'hint field should be stripped from TargetedNode');
  });

  it('result Ref is preserved (single hinted node at ref 0)', () => {
    // With inline hints there is no extra Hint node; result stays at ref 0.
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating', hint: 'omniJS' } as any,
    ]);
    const { targeted } = targetEventPlan(plan);
    assert.equal(targeted.result, 0);
  });
});

// ── ExecutionUnit grouping ───────────────────────────────────────────────

describe('targetEventPlan — ExecutionUnit grouping', () => {

  it('co-runtime jxa nodes → same ExecutionUnit', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
    ]);
    const { units } = targetEventPlan(plan);
    const u0 = unitOf(units, 0);
    const u1 = unitOf(units, 1);
    assert.strictEqual(u0, u1, 'both Get nodes should be in the same ExecutionUnit');
    assert.equal(u0.runtime, 'jxa');
  });

  it('jxa + node → separate ExecutionUnits', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }] },
    ]);
    const { units } = targetEventPlan(plan);
    const jxaUnit = unitOf(units, 0);
    const nodeUnit = unitOf(units, 3);
    assert.notStrictEqual(jxaUnit, nodeUnit, 'Get and Zip should be in different ExecutionUnits');
    assert.equal(jxaUnit.runtime, 'jxa');
    assert.equal(nodeUnit.runtime, 'node');
    assert.ok(units.length >= 2);
  });

  it('ExecutionUnit dependsOn reflects data dependency', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }] },
    ]);
    const { units } = targetEventPlan(plan);
    const jxaUnit = unitOf(units, 0);
    const nodeUnit = unitOf(units, 3);
    assert.ok(
      nodeUnit.dependsOn.includes(jxaUnit),
      `node unit dependsOn should include jxa unit`
    );
  });

  it('mixed: jxa reads then node filter → correct ExecutionUnit structure', () => {
    const plan = makePlan([
      // 0: Get elements
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      // 1: Get property (id)
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
      // 2: Get property (name)
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      // 3: Get property (flagged)
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'FCfl' }, effect: 'nonMutating' },
      // 4: Zip
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }, { name: 'flagged', ref: 3 }] },
      // 5: Filter
      { kind: 'Filter', source: 4, predicate: { op: 'eq', args: [{ var: 'flagged' }, true] } },
    ]);
    const { units } = targetEventPlan(plan);

    // All 4 Get nodes should be in the same jxa ExecutionUnit
    const jxaUnit = unitOf(units, 0);
    assert.strictEqual(unitOf(units, 1), jxaUnit, 'ref 1 should share jxa unit');
    assert.strictEqual(unitOf(units, 2), jxaUnit, 'ref 2 should share jxa unit');
    assert.strictEqual(unitOf(units, 3), jxaUnit, 'ref 3 should share jxa unit');
    assert.equal(jxaUnit.runtime, 'jxa');
    assert.equal(jxaUnit.nodes.length, 4);

    // Zip and Filter should be in a node ExecutionUnit
    const nodeUnit = unitOf(units, 4);
    assert.strictEqual(unitOf(units, 5), nodeUnit, 'ref 5 should share node unit');
    assert.equal(nodeUnit.runtime, 'node');

    // node unit depends on jxa unit
    assert.ok(nodeUnit.dependsOn.includes(jxaUnit), 'node unit dependsOn should include jxa unit');
  });

  it('result Ref preserved from EventPlan', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }] },
      { kind: 'Filter', source: 3, predicate: { op: 'contains', args: [{ var: 'name' }, 'review'] } },
    ], 4);
    const { targeted } = targetEventPlan(plan);
    assert.equal(targeted.result, 4);
  });

  it('ExecutionUnit inputs lists cross-unit refs', () => {
    // Zip at ref 3 consumes refs 1 and 2 which belong to the jxa unit.
    // The node unit's inputs should therefore include refs 1 and 2.
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }] },
    ]);
    const { units } = targetEventPlan(plan);
    const nodeUnit = unitOf(units, 3);
    const inputRefs = nodeUnit.inputs.map(i => i.ref);
    assert.ok(inputRefs.includes(1), 'node unit inputs should include ref 1');
    assert.ok(inputRefs.includes(2), 'node unit inputs should include ref 2');
  });

  it('hinted node lands in its own runtime ExecutionUnit', () => {
    // A Get node hinted to omniJS sits between two jxa Gets.
    // It should end up in an omniJS ExecutionUnit.
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating', hint: 'omniJS' } as any,
    ]);
    const { units } = targetEventPlan(plan);
    const jxaUnit  = unitOf(units, 0);
    const omniUnit = unitOf(units, 1);
    assert.notStrictEqual(jxaUnit, omniUnit);
    assert.equal(jxaUnit.runtime,  'jxa');
    assert.equal(omniUnit.runtime, 'omniJS');
  });
});

// ── assignRuntimes / splitExecutionUnits individually ───────────────────

describe('assignRuntimes', () => {

  it('produces one TargetedNode per input node', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }] },
    ]);
    const targeted = assignRuntimes(plan);
    assert.equal(targeted.nodes.length, 2);
  });

  it('every output node has runtimeAllocation', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }] },
    ]);
    const targeted = assignRuntimes(plan);
    for (const node of targeted.nodes) {
      assert.ok('runtimeAllocation' in node, 'every targeted node must have runtimeAllocation');
    }
  });

  it('result is preserved', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }] },
    ], 0);
    const targeted = assignRuntimes(plan);
    assert.equal(targeted.result, 0);
  });
});

describe('splitExecutionUnits', () => {

  it('single-runtime plan → single unit', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
    ]);
    const targeted = assignRuntimes(plan);
    const units = splitExecutionUnits(targeted);
    assert.equal(units.length, 1);
    assert.equal(units[0].runtime, 'jxa');
    assert.equal(units[0].nodes.length, 2);
  });

  it('single unit has no dependsOn', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
    ]);
    const targeted = assignRuntimes(plan);
    const units = splitExecutionUnits(targeted);
    assert.equal(units[0].dependsOn.length, 0);
  });

  it('unit result is last node in its node list', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }] },
    ]);
    const targeted = assignRuntimes(plan);
    const units = splitExecutionUnits(targeted);
    for (const unit of units) {
      const lastNode = unit.nodes[unit.nodes.length - 1];
      assert.equal(unit.result, lastNode);
    }
  });
});
