import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventPlan, EventNode, Specifier } from '../dist/tools/query/eventPlan.js';
import { cseEventPlan } from '../dist/tools/query/eventPlanCSE.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Shorthand for a Document specifier. */
const Doc: Specifier = { kind: 'Document' };

/** Elements specifier over Document. */
function elements(classCode: string, parent: Specifier | number = Doc): Specifier {
  return { kind: 'Elements', parent, classCode };
}

/** Property specifier. */
function prop(propCode: string, parent: Specifier | number): Specifier {
  return { kind: 'Property', parent, propCode };
}

/** ByID specifier. */
function byId(id: string | number, parent: Specifier | number): Specifier {
  return { kind: 'ByID', parent, id };
}

/** Non-mutating Get node. */
function get(specifier: Specifier): EventNode {
  return { kind: 'Get', specifier, effect: 'nonMutating' };
}

/** Zip node. */
function zip(columns: { name: string; ref: number }[]): EventNode {
  return { kind: 'Zip', columns };
}

// ── CSE pass ─────────────────────────────────────────────────────────────

describe('eventPlan CSE', () => {

  it('no duplicates — plan unchanged', () => {
    // Two Get nodes with different specifiers: Elements(Doc,'FCft') vs Elements(Doc,'FCta')
    const plan: EventPlan = {
      nodes: [
        get(elements('FCft')),        // %0: flattenedTasks
        get(elements('FCta')),        // %1: flattenedTags
        zip([
          { name: 'tasks', ref: 0 },
          { name: 'tags',  ref: 1 },
        ]),
      ],
      result: 2,
    };

    const out = cseEventPlan(plan);

    // Both nodes kept — no unification
    assert.equal(out.nodes.length, 3);
    assert.equal(out.nodes[0].kind, 'Get');
    assert.equal(out.nodes[1].kind, 'Get');
    assert.equal(out.result, 2);
  });

  it('duplicate Elements nodes — unified', () => {
    // Two identical Get(Elements(Document,'FCft')) nodes
    const plan: EventPlan = {
      nodes: [
        get(elements('FCft')),        // %0
        get(elements('FCft')),        // %1 — duplicate of %0
        zip([
          { name: 'a', ref: 0 },
          { name: 'b', ref: 1 },
        ]),
      ],
      result: 2,
    };

    const out = cseEventPlan(plan);

    // The duplicate Get should be eliminated. The Zip columns that
    // referenced %1 should now reference %0 (the canonical node).
    const getNodes = out.nodes.filter(n => n.kind === 'Get');
    assert.equal(getNodes.length, 1, 'should have one Get after CSE');

    // The Zip's columns should both point to the canonical ref
    const zipNode = out.nodes.find(n => n.kind === 'Zip');
    assert.ok(zipNode && zipNode.kind === 'Zip');
    for (const col of zipNode.columns) {
      // Both columns should reference the same canonical Get
      assert.equal(col.ref, zipNode.columns[0].ref);
    }
  });

  it('duplicate Property nodes — unified', () => {
    // Get(Elements(Doc,'FCft')) then two identical Get(Property(%0,'pnam'))
    const plan: EventPlan = {
      nodes: [
        get(elements('FCft')),              // %0
        get(prop('pnam', 0)),               // %1: Property(%0, 'pnam')
        get(prop('pnam', 0)),               // %2: duplicate of %1
        zip([
          { name: 'names1', ref: 1 },
          { name: 'names2', ref: 2 },
        ]),
      ],
      result: 3,
    };

    const out = cseEventPlan(plan);

    const propGets = out.nodes.filter(n =>
      n.kind === 'Get' &&
      n.specifier.kind === 'Property'
    );
    assert.equal(propGets.length, 1, 'should have one Property Get after CSE');

    // Zip columns should both reference the canonical Property Get
    const zipNode = out.nodes.find(n => n.kind === 'Zip');
    assert.ok(zipNode && zipNode.kind === 'Zip');
    assert.equal(zipNode.columns[0].ref, zipNode.columns[1].ref);
  });

  it('ByID equality — same literal id', () => {
    const plan: EventPlan = {
      nodes: [
        get(elements('FCft')),                        // %0
        get(byId('abc123', 0)),                       // %1
        get(byId('abc123', 0)),                       // %2 — duplicate of %1
        zip([
          { name: 'a', ref: 1 },
          { name: 'b', ref: 2 },
        ]),
      ],
      result: 3,
    };

    const out = cseEventPlan(plan);

    const byIdGets = out.nodes.filter(n =>
      n.kind === 'Get' &&
      n.specifier.kind === 'ByID'
    );
    assert.equal(byIdGets.length, 1, 'duplicate ByID unified');

    const zipNode = out.nodes.find(n => n.kind === 'Zip');
    assert.ok(zipNode && zipNode.kind === 'Zip');
    assert.equal(zipNode.columns[0].ref, zipNode.columns[1].ref,
      'both Zip columns reference the canonical ByID');
  });

  it('ByID inequality — different literal ids not unified', () => {
    const plan: EventPlan = {
      nodes: [
        get(elements('FCft')),                        // %0
        get(byId('abc', 0)),                          // %1
        get(byId('def', 0)),                          // %2 — different id
        zip([
          { name: 'a', ref: 1 },
          { name: 'b', ref: 2 },
        ]),
      ],
      result: 3,
    };

    const out = cseEventPlan(plan);

    const byIdGets = out.nodes.filter(n =>
      n.kind === 'Get' &&
      n.specifier.kind === 'ByID'
    );
    assert.equal(byIdGets.length, 2, 'different ByID nodes both kept');
  });

  it('result Ref updated correctly after unification', () => {
    // Result points to node %1 which is a duplicate of %0 — after CSE
    // result should point to the canonical node.
    const plan: EventPlan = {
      nodes: [
        get(elements('FCft')),        // %0
        get(elements('FCft')),        // %1 — duplicate, but result points here
      ],
      result: 1,
    };

    const out = cseEventPlan(plan);

    const getNodes = out.nodes.filter(n => n.kind === 'Get');
    assert.equal(getNodes.length, 1, 'duplicate eliminated');

    // Find the index of the surviving Get node
    const canonIdx = out.nodes.findIndex(n => n.kind === 'Get');
    assert.equal(out.result, canonIdx,
      'result Ref rewritten to canonical node');
  });

  it('Zip column refs rewritten after unification', () => {
    // Three Get nodes: %0 and %2 are duplicates. Zip references all three.
    const plan: EventPlan = {
      nodes: [
        get(elements('FCft')),              // %0
        get(elements('FCta')),              // %1 — different
        get(elements('FCft')),              // %2 — duplicate of %0
        zip([
          { name: 'first',  ref: 0 },
          { name: 'second', ref: 1 },
          { name: 'third',  ref: 2 },      // should be rewritten to ref %0's canonical
        ]),
      ],
      result: 3,
    };

    const out = cseEventPlan(plan);

    const zipNode = out.nodes.find(n => n.kind === 'Zip');
    assert.ok(zipNode && zipNode.kind === 'Zip');

    // 'first' and 'third' should reference the same canonical node
    const firstCol  = zipNode.columns.find(c => c.name === 'first')!;
    const thirdCol  = zipNode.columns.find(c => c.name === 'third')!;
    assert.equal(firstCol.ref, thirdCol.ref,
      'third column ref rewritten to match first (canonical)');

    // 'second' should reference a different node (FCta, not unified)
    const secondCol = zipNode.columns.find(c => c.name === 'second')!;
    assert.notEqual(secondCol.ref, firstCol.ref,
      'second column ref unchanged (different specifier)');
  });
});
