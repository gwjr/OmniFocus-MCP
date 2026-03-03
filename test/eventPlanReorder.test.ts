import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventNode, EventPlan, Ref } from '../dist/tools/query/eventPlan.js';
import { reorderEventPlan } from '../dist/tools/query/eventPlanReorder.js';
import { describeEventPlan } from '../dist/tools/query/eventPlanDescriber.js';

// ── Helpers (same pattern as eventPlanCSE.test.ts) ───────────────────────

const Doc = { kind: 'Document' as const };

function elements(classCode: string, parent: any = Doc) {
  return { kind: 'Elements' as const, parent, classCode };
}

function prop(propCode: string, parent: any) {
  return { kind: 'Property' as const, parent, propCode };
}

function get(specifier: any): EventNode {
  return { kind: 'Get', specifier, effect: 'nonMutating' };
}

function zip(columns: { name: string; ref: Ref }[]): EventNode {
  return { kind: 'Zip', columns };
}

function filter(source: Ref, predicate: any, entity?: string): EventNode {
  return { kind: 'Filter', source, predicate, entity } as EventNode;
}

function sort(source: Ref, by: string): EventNode {
  return { kind: 'Sort', source, by, dir: 'asc' } as EventNode;
}

function pick(source: Ref, fields: string[]): EventNode {
  return { kind: 'Pick', source, fields };
}

function makePlan(nodes: EventNode[], result?: Ref): EventPlan {
  return { nodes, result: result ?? nodes.length - 1 };
}

/** Get node kinds from a plan in order. */
function kinds(plan: EventPlan): string[] {
  return plan.nodes.map(n => n.kind);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('reorderEventPlan', () => {

  it('no-op: already-optimal order (JXA then node)', () => {
    // %0 Get(Elements), %1 Get(Prop ID), %2 Get(Prop pnam), %3 Zip
    const plan = makePlan([
      get(elements('FCft')),
      get(prop('ID  ', 0 as Ref)),
      get(prop('pnam', 0 as Ref)),
      zip([{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }]),
    ]);

    const result = reorderEventPlan(plan);

    // Should be identical — no reordering needed
    assert.deepStrictEqual(kinds(result), ['Get', 'Get', 'Get', 'Zip']);
    assert.equal(result.result, 3);
  });

  it('hoists trailing JXA Get before intervening Zip', () => {
    // The folderName pattern:
    // %0 Get(Elements), %1 Get(Prop ID), %2 Get(Prop pnam),
    // %3 Zip([id:%1, name:%2]),   ← node
    // %4 Get(Property(Property(%0, ctnr), ID))   ← jxa, deps on %0 only
    // %5 Zip([id:%1, name:%2, folderId:%4])  ← node, combines all columns
    const plan = makePlan([
      get(elements('FCfx')),                            // %0 jxa
      get(prop('ID  ', 0 as Ref)),                      // %1 jxa, dep: %0
      get(prop('pnam', 0 as Ref)),                      // %2 jxa, dep: %0
      zip([{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }]),  // %3 node, dep: %1,%2
      get(prop('ID  ', prop('ctnr', 0 as Ref))),        // %4 jxa, dep: %0
      zip([{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }, { name: 'folderId', ref: 4 }]),  // %5 node
    ]);

    const result = reorderEventPlan(plan);

    // All JXA nodes should come before node ops
    assert.deepStrictEqual(kinds(result), ['Get', 'Get', 'Get', 'Get', 'Zip', 'Zip']);

    // Result (the final Zip) should be last
    const resultNode = result.nodes[result.result];
    assert.equal(resultNode.kind, 'Zip');
    const zipNode = resultNode as Extract<EventNode, { kind: 'Zip' }>;
    assert.equal(zipNode.columns.length, 3);
    // All column refs should point to nodes before the Zip
    for (const col of zipNode.columns) {
      assert.ok(col.ref < result.result, `Zip column ${col.name} ref ${col.ref} should be before result Zip`);
    }
  });

  it('consolidates two independent JXA groups with intervening node op', () => {
    // %0 Get(Elements FCft),  %1 Get(Prop ID, %0)   ← jxa group 1
    // %2 Zip([id: %1])                               ← node
    // %3 Get(Elements FCfx),  %4 Get(Prop ID, %3)   ← jxa group 2 (independent)
    // %5 Zip([id: %4])                               ← node
    const plan = makePlan([
      get(elements('FCft')),                           // %0 jxa
      get(prop('ID  ', 0 as Ref)),                     // %1 jxa, dep: %0
      zip([{ name: 'id', ref: 1 }]),                   // %2 node, dep: %1
      get(elements('FCfx')),                           // %3 jxa (independent)
      get(prop('ID  ', 3 as Ref)),                     // %4 jxa, dep: %3
      zip([{ name: 'id', ref: 4 }]),                   // %5 node, dep: %4
    ]);

    const result = reorderEventPlan(plan);

    // All 4 JXA Gets should be consecutive, then the 2 Zips
    const k = kinds(result);
    const jxaRun = k.filter(k => k === 'Get');
    const nodeRun = k.filter(k => k === 'Zip');
    assert.equal(jxaRun.length, 4);
    assert.equal(nodeRun.length, 2);
    // All Gets before all Zips
    const lastGetIdx = k.lastIndexOf('Get');
    const firstZipIdx = k.indexOf('Zip');
    assert.ok(lastGetIdx < firstZipIdx, 'all Gets should precede all Zips');
  });

  it('respects dependency barrier: node op that JXA depends on stays before it', () => {
    // %0 Get(Elements), %1 Get(Prop ID, %0)
    // %2 Zip([id: %1])           ← node
    // %3 ColumnValues(%2, 'id')  ← node, dep: %2
    // %4 ForEach(%3, body: [...])  ← jxa, dep: %3
    const plan = makePlan([
      get(elements('FCft')),                           // %0 jxa
      get(prop('ID  ', 0 as Ref)),                     // %1 jxa, dep: %0
      zip([{ name: 'id', ref: 1 }]),                   // %2 node, dep: %1
      { kind: 'ColumnValues', source: 2, field: 'id' } as EventNode,  // %3 node, dep: %2
      {                                                 // %4 jxa, dep: %3
        kind: 'ForEach',
        source: 3,
        body: [get(prop('pnam', 4 as Ref))],
        collect: 0,
        effect: 'nonMutating',
      } as EventNode,
    ]);

    const result = reorderEventPlan(plan);

    // The ForEach (%4 jxa) MUST come after ColumnValues (%3 node)
    // because it depends on it. The reorder can't hoist it.
    const forEachIdx = result.nodes.findIndex(n => n.kind === 'ForEach');
    const cvIdx = result.nodes.findIndex(n => n.kind === 'ColumnValues');
    assert.ok(cvIdx < forEachIdx, 'ColumnValues must precede ForEach');

    // ForEach body should have the body-local ref updated to new ForEach index
    const fe = result.nodes[forEachIdx] as Extract<EventNode, { kind: 'ForEach' }>;
    const bodyGet = fe.body[0] as Extract<EventNode, { kind: 'Get' }>;
    assert.equal(
      (bodyGet.specifier as any).parent,
      forEachIdx,
      'body-local ref to ForEach should be updated to new index',
    );
  });

  it('preserves mutation ordering between Set nodes', () => {
    // %0 Get(Elements)
    // %1 Set(%0, 'pnam', value=<ref to some literal>)   ← mutating
    // %2 Get(Prop ID, %0)                                ← nonMutating
    // %3 Set(%0, 'pnam', value=<ref to some literal>)   ← mutating
    // Mutation order must be %1 before %3.
    const plan = makePlan([
      get(elements('FCft')),                           // %0 jxa
      { kind: 'Get', specifier: prop('pnam', 0 as Ref), effect: 'nonMutating' } as EventNode,  // %1 jxa
      {                                                 // %2 jxa, MUTATING
        kind: 'Set',
        specifier: prop('pnam', 0 as Ref),
        value: 1,
        effect: 'sideEffective',
      } as EventNode,
      get(prop('ID  ', 0 as Ref)),                     // %3 jxa, nonMutating
      {                                                 // %4 jxa, MUTATING
        kind: 'Set',
        specifier: prop('pnam', 0 as Ref),
        value: 3,
        effect: 'sideEffective',
      } as EventNode,
    ]);

    const result = reorderEventPlan(plan);

    // Both Sets must maintain relative order
    const setIndices = result.nodes
      .map((n, i) => n.kind === 'Set' ? i : -1)
      .filter(i => i >= 0);
    assert.equal(setIndices.length, 2);
    assert.ok(setIndices[0] < setIndices[1], 'first Set must precede second Set');
  });

  it('result ref maps correctly after renumbering', () => {
    // %0 Get(Elements), %1 Get(Prop pnam, %0), %2 Zip([name: %1])
    // %3 Sort(%2, by: name)
    // Result is %3 (Sort)
    const plan = makePlan([
      get(elements('FCft')),
      get(prop('pnam', 0 as Ref)),
      zip([{ name: 'name', ref: 1 }]),
      sort(2, 'name'),
    ]);

    const result = reorderEventPlan(plan);

    // The result should point to the Sort node
    const resultNode = result.nodes[result.result];
    assert.equal(resultNode.kind, 'Sort');
  });

  it('single-node plan is returned unchanged', () => {
    const plan = makePlan([get(elements('FCft'))]);
    const result = reorderEventPlan(plan);
    assert.strictEqual(result, plan);
  });

  it('handles Pick node correctly (node-runtime, keeps position)', () => {
    // %0 Get(Elements), %1 Get(Prop ID, %0), %2 Get(Prop pnam, %0)
    // %3 Zip([id: %1, name: %2])
    // %4 Pick(%3, [name])
    // All node ops (%3, %4) should stay after JXA ops
    const plan = makePlan([
      get(elements('FCft')),
      get(prop('ID  ', 0 as Ref)),
      get(prop('pnam', 0 as Ref)),
      zip([{ name: 'id', ref: 1 }, { name: 'name', ref: 2 }]),
      pick(3, ['name']),
    ]);

    const result = reorderEventPlan(plan);

    // Already optimal: JXA (0,1,2) then node (3,4)
    assert.deepStrictEqual(kinds(result), ['Get', 'Get', 'Get', 'Zip', 'Pick']);
    assert.equal(result.result, 4);
  });
});
