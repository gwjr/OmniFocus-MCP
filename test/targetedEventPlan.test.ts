import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventPlan, EventNode, Ref, Runtime } from '../dist/tools/query/eventPlan.js';
import type { TargetedEventPlan, Batch } from '../dist/tools/query/targetedEventPlan.js';
import { targetEventPlan } from '../dist/tools/query/targetedEventPlanLowering.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build an EventPlan from a list of nodes; result defaults to last node. */
function makePlan(nodes: EventNode[], result?: Ref): EventPlan {
  return { nodes, result: result ?? nodes.length - 1 };
}

/** Return the runtime assigned to the node at `ref` in the targeted plan. */
function nodeRuntime(plan: TargetedEventPlan, ref: Ref): Runtime {
  return plan.nodes[ref].runtime;
}

/** Return the batch index of the node at `ref` in the targeted plan. */
function batchOf(plan: TargetedEventPlan, ref: Ref): number {
  return plan.nodes[ref].batch;
}

/** Find a batch by its index. */
function getBatch(plan: TargetedEventPlan, index: number): Batch {
  const b = plan.batches.find(b => b.index === index);
  assert.ok(b, `batch ${index} not found`);
  return b;
}

// ── Specifier shortcuts ─────────────────────────────────────────────────

const doc = { kind: 'Document' as const };
const elements = (classCode: string): EventNode['kind'] extends string ? EventNode : never =>
  ({ kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode }, effect: 'nonMutating' }) as any;
const property = (parent: Ref, propCode: string): EventNode =>
  ({ kind: 'Get', specifier: { kind: 'Property', parent, propCode }, effect: 'nonMutating' });
const byID = (parent: Ref, id: string | Ref): EventNode =>
  ({ kind: 'Get', specifier: { kind: 'ByID', parent, id }, effect: 'nonMutating' });

// ── Runtime assignment ──────────────────────────────────────────────────

describe('targetEventPlan — runtime assignment', () => {

  it('Get(Elements) → jxa', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
    ]);
    const targeted = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 0), 'jxa');
  });

  it('Get(Property) with Elements parent → jxa', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
    ]);
    const targeted = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 1), 'jxa');
  });

  it('Filter → node', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }] },
      { kind: 'Filter', source: 2, predicate: { op: 'contains', args: [{ var: 'name' }, 'review'] } },
    ]);
    const targeted = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 3), 'node');
  });

  it('Zip → node', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }] },
    ]);
    const targeted = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 2), 'node');
  });

  it('Sort → node', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }] },
      { kind: 'Sort', source: 2, by: 'name', dir: 'asc' },
    ]);
    const targeted = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 3), 'node');
  });

  it('Limit → node', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }] },
      { kind: 'Limit', source: 1, n: 10 },
    ]);
    const targeted = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 2), 'node');
  });

  it('Pick → node', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }] },
      { kind: 'Pick', source: 2, fields: ['name'] },
    ]);
    const targeted = targetEventPlan(plan);
    assert.equal(nodeRuntime(targeted, 3), 'node');
  });

  it('Hint consumed — not in output nodes', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Hint', source: 0, runtime: 'omniJS' },
    ], 1);
    const targeted = targetEventPlan(plan);
    // No node in the output should have kind 'Hint'
    for (const node of targeted.nodes) {
      if (node != null) {
        assert.notEqual((node as any).kind, 'Hint');
      }
    }
  });

  it('Hint overrides default runtime', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Hint', source: 0, runtime: 'omniJS' },
    ], 1);
    const targeted = targetEventPlan(plan);
    // The Get(Elements) node at ref 0 should have runtime 'omniJS', not default 'jxa'
    assert.equal(nodeRuntime(targeted, 0), 'omniJS');
  });
});

// ── Batch grouping ──────────────────────────────────────────────────────

describe('targetEventPlan — batch grouping', () => {

  it('co-runtime jxa nodes → same batch', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
    ]);
    const targeted = targetEventPlan(plan);
    assert.equal(batchOf(targeted, 0), batchOf(targeted, 1));
    const batch = getBatch(targeted, batchOf(targeted, 0));
    assert.equal(batch.runtime, 'jxa');
  });

  it('jxa + node → separate batches', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }] },
    ]);
    const targeted = targetEventPlan(plan);
    const jxaBatch = batchOf(targeted, 0);
    const nodeBatch = batchOf(targeted, 2);
    assert.notEqual(jxaBatch, nodeBatch);
    assert.equal(getBatch(targeted, jxaBatch).runtime, 'jxa');
    assert.equal(getBatch(targeted, nodeBatch).runtime, 'node');
    assert.ok(targeted.batches.length >= 2);
  });

  it('batch dependsOn reflects data dependency', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }] },
    ]);
    const targeted = targetEventPlan(plan);
    const jxaBatchIdx = batchOf(targeted, 0);
    const nodeBatchIdx = batchOf(targeted, 2);
    const nodeBatch = getBatch(targeted, nodeBatchIdx);
    // The node batch depends on the jxa batch (Zip reads from Get nodes)
    assert.ok(
      nodeBatch.dependsOn.includes(jxaBatchIdx),
      `node batch dependsOn should include jxa batch index ${jxaBatchIdx}, got ${JSON.stringify(nodeBatch.dependsOn)}`
    );
  });

  it('mixed: jxa reads then node filter → correct batch structure', () => {
    const plan = makePlan([
      // 0: Get elements (ids)
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      // 1: Get property (name)
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      // 2: Get property (flagged)
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'FCfl' }, effect: 'nonMutating' },
      // 3: Zip
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }, { name: 'flagged', ref: 2 }] },
      // 4: Filter
      { kind: 'Filter', source: 3, predicate: { op: 'eq', args: [{ var: 'flagged' }, true] } },
    ]);
    const targeted = targetEventPlan(plan);

    // All 3 Get nodes should be in the same jxa batch
    const jxaBatchIdx = batchOf(targeted, 0);
    assert.equal(batchOf(targeted, 1), jxaBatchIdx);
    assert.equal(batchOf(targeted, 2), jxaBatchIdx);
    assert.equal(getBatch(targeted, jxaBatchIdx).runtime, 'jxa');
    assert.equal(getBatch(targeted, jxaBatchIdx).nodes.length, 3);

    // Zip and Filter should be in a node batch
    const nodeBatchIdx = batchOf(targeted, 3);
    assert.equal(batchOf(targeted, 4), nodeBatchIdx);
    assert.equal(getBatch(targeted, nodeBatchIdx).runtime, 'node');

    // node batch depends on jxa batch
    assert.ok(getBatch(targeted, nodeBatchIdx).dependsOn.includes(jxaBatchIdx));
  });

  it('result Ref preserved from EventPlan', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }] },
      { kind: 'Filter', source: 2, predicate: { op: 'contains', args: [{ var: 'name' }, 'review'] } },
    ], 3);
    const targeted = targetEventPlan(plan);
    assert.equal(targeted.result, 3);
  });

  it('result Ref adjusted when Hint wraps the result node', () => {
    // result points to Hint (ref 1), which sources Get (ref 0)
    // After Hint is consumed, result should still resolve correctly
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Hint', source: 0, runtime: 'omniJS' },
    ], 1);
    const targeted = targetEventPlan(plan);
    // The Hint is stripped; result should point to the sourced node (ref 0)
    assert.equal(targeted.result, 0);
  });
});
