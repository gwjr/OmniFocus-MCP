/**
 * Unit tests for OmniJS ExecutionUnit codegen (emitOmniJsUnit).
 *
 * Verifies that emitOmniJsUnit produces valid-looking OmniJS script strings
 * for various node kinds and specifier types. OmniJS differs from JXA:
 *  - Global collections (flattenedTasks), not doc.flattenedTasks()
 *  - Property getters (item.name), not method calls (item.name())
 *  - IDs via item.id.primaryKey, not item.id().toString()
 *  - Array.from() for collections
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventPlan, EventNode, Ref, RuntimeAllocation } from '../dist/tools/query/eventPlan.js';
import type { TargetedEventPlan, TargetedNode, ExecutionUnit } from '../dist/tools/query/targetedEventPlan.js';
import { emitOmniJsUnit } from '../dist/tools/query/executionUnits/omniJsUnit.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const doc = { kind: 'Document' as const };

function makeTargetedNode(node: EventNode, runtime: string, kind: 'proposed' | 'fixed' = 'proposed'): TargetedNode {
  return { ...node, runtimeAllocation: { kind, runtime } as RuntimeAllocation } as TargetedNode;
}

function makeTargetedPlan(nodes: TargetedNode[], result?: Ref): TargetedEventPlan {
  return { nodes, result: result ?? nodes.length - 1 };
}

function makeOmniJsUnit(nodeRefs: Ref[], inputs: Ref[] = [], result?: Ref): ExecutionUnit {
  return {
    runtime: 'omniJS',
    nodes: nodeRefs,
    inputs,
    result: result ?? nodeRefs[nodeRefs.length - 1],
    dependsOn: [],
  };
}

// ── Get(Elements) ─────────────────────────────────────────────────────────

describe('emitOmniJsUnit — Get(Elements)', () => {

  it('emits Array.from() with OmniJS global for flattenedTasks', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit = makeOmniJsUnit([0]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    assert.ok(script.includes('Array.from(flattenedTasks)'), 'should use Array.from with global flattenedTasks');
    assert.ok(!script.includes('app.defaultDocument'), 'should NOT reference app.defaultDocument');
    assert.ok(!script.includes("Application('OmniFocus')"), 'should NOT reference Application');
  });

  it('emits correct globals for different class codes', () => {
    const codes: [string, string][] = [
      ['FCft', 'flattenedTasks'],
      ['FCfx', 'flattenedProjects'],
      ['FCff', 'flattenedFolders'],
      ['FCfc', 'flattenedTags'],
    ];

    for (const [classCode, expected] of codes) {
      const nodes: TargetedNode[] = [
        makeTargetedNode(
          { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode }, effect: 'nonMutating' },
          'omniJS',
        ),
      ];
      const plan = makeTargetedPlan(nodes, 0);
      const unit = makeOmniJsUnit([0]);

      const script = emitOmniJsUnit(unit, plan, new Map());
      assert.ok(script.includes(expected), `${classCode} should map to ${expected}`);
    }
  });
});

// ── Get(Property) — bulk property read ──────────────────────────────────

describe('emitOmniJsUnit — Get(Property)', () => {

  it('emits .map() with getter for bulk property read (name)', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit = makeOmniJsUnit([0, 1]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    assert.ok(script.includes('.map(function(x) { return x.name; })'), 'should map over items with getter access');
    assert.ok(!script.includes('.name()'), 'should NOT use method-call syntax');
  });

  it('emits .id.primaryKey for ID property', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit = makeOmniJsUnit([0, 1]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    assert.ok(script.includes('x.id.primaryKey'), 'should use id.primaryKey for ID property');
    assert.ok(!script.includes('.id().toString()'), 'should NOT use JXA-style id()');
  });
});

// ── Count ──────────────────────────────────────────────────────────────

describe('emitOmniJsUnit — Count', () => {

  it('emits .length for Count', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Count', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit = makeOmniJsUnit([0]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    assert.ok(script.includes('flattenedTasks.length'), 'Count should use .length on collection');
  });
});

// ── ByName / ByID / ByIndex ──────────────────────────────────────────────

describe('emitOmniJsUnit — specifier lookups', () => {

  it('emits .find() for ByName', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'ByName', parent: { kind: 'Elements', parent: doc, classCode: 'FCfc' }, name: 'Work' }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit = makeOmniJsUnit([0]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    assert.ok(script.includes('.find(function(x) { return x.name ==='), 'ByName should use .find() with name comparison');
    assert.ok(script.includes('"Work"'), 'should include the name literal');
  });

  it('emits .find() with id.primaryKey for ByID', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'ByID', parent: { kind: 'Elements', parent: doc, classCode: 'FCft' }, id: 'abc123' }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit = makeOmniJsUnit([0]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    assert.ok(script.includes('.find(function(x) { return x.id.primaryKey ==='), 'ByID should use .find() with id.primaryKey');
    assert.ok(script.includes('"abc123"'), 'should include the ID literal');
  });

  it('emits bracket access for ByIndex', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'ByIndex', parent: { kind: 'Elements', parent: doc, classCode: 'FCft' }, index: 0 }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit = makeOmniJsUnit([0]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    assert.ok(script.includes('[0]'), 'ByIndex should use bracket access');
  });
});

// ── Set ───────────────────────────────────────────────────────────────────

describe('emitOmniJsUnit — Set', () => {

  it('emits direct property assignment', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
      makeTargetedNode(
        { kind: 'Set', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, value: 0, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit = makeOmniJsUnit([0, 1]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    // Set should use direct assignment, not .set()
    assert.ok(script.includes('.name ='), 'Set should use direct property assignment');
    assert.ok(!script.includes('.set('), 'should NOT use JXA .set()');
  });
});

// ── Command ──────────────────────────────────────────────────────────────

describe('emitOmniJsUnit — Command', () => {

  it('emits method call on target', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
      makeTargetedNode(
        { kind: 'Command', fourCC: 'doIt', target: { kind: 'Elements', parent: doc, classCode: 'FCft' }, args: {}, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit = makeOmniJsUnit([0, 1]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    assert.ok(script.includes('.doIt('), 'Command should emit method call with fourCC as method name');
  });
});

// ── ForEach ──────────────────────────────────────────────────────────────

describe('emitOmniJsUnit — ForEach', () => {

  it('emits a for loop with accumulator', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
      makeTargetedNode(
        {
          kind: 'ForEach',
          source: 0,
          body: [
            { kind: 'Get', specifier: { kind: 'Property', parent: 1, propCode: 'pnam' }, effect: 'nonMutating' },
          ],
          collect: 0,
          effect: 'nonMutating',
        },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit = makeOmniJsUnit([0, 1]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    assert.ok(script.includes('var _acc'), 'ForEach should have an accumulator');
    assert.ok(script.includes('.length;'), 'ForEach should loop with .length');
    assert.ok(script.includes('.push('), 'ForEach should push to accumulator');
    assert.ok(script.includes('[].concat.apply'), 'ForEach should flatten results');
  });

  it('emits Zip inside ForEach body', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
      makeTargetedNode(
        {
          kind: 'ForEach',
          source: 0,
          body: [
            { kind: 'Get', specifier: { kind: 'Property', parent: 1, propCode: 'pnam' }, effect: 'nonMutating' },
            { kind: 'Zip', columns: [{ name: 'name', ref: 0 }] },
          ],
          collect: 1,
          effect: 'nonMutating',
        },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit = makeOmniJsUnit([0, 1]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    // Body Zip should produce an inline object literal
    assert.ok(script.includes('"name"'), 'body Zip should include field name');
  });
});

// ── IIFE wrapper ─────────────────────────────────────────────────────────

describe('emitOmniJsUnit — script structure', () => {

  it('wraps output in an IIFE with try/catch', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit = makeOmniJsUnit([0]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    assert.ok(script.includes('(() => {'), 'should be an arrow IIFE');
    assert.ok(script.includes('try {'), 'should have try block');
    assert.ok(script.includes('catch (error)'), 'should have catch block');
    assert.ok(script.includes('JSON.stringify'), 'should JSON.stringify the result');
    assert.ok(script.includes('})()'), 'should close and invoke the IIFE');
  });

  it('returns JSON.stringify of the result variable', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit = makeOmniJsUnit([0]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    assert.ok(script.includes('return JSON.stringify(_r0)'), 'should return JSON.stringify of result var');
  });
});

// ── Cross-unit inputs ────────────────────────────────────────────────────

describe('emitOmniJsUnit — cross-unit inputs', () => {

  it('uses input variable names for cross-unit refs', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'jxa',  // upstream JXA unit
      ),
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit = makeOmniJsUnit([1], [0]);
    const inputs = new Map<number, string>([[0, '_external0']]);

    const script = emitOmniJsUnit(unit, plan, inputs);
    assert.ok(script.includes('_external0'), 'should reference the cross-unit input variable');
  });
});

// ── Multi-export ─────────────────────────────────────────────────────────

describe('emitOmniJsUnit — multi-export', () => {

  it('returns an object keyed by ref when multiple exports requested', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 1);
    const unit = makeOmniJsUnit([0, 1]);

    const script = emitOmniJsUnit(unit, plan, new Map(), [0, 1]);
    // Multi-export should produce {"0": _r0, "1": _r1}
    assert.ok(script.includes('"0"'), 'multi-export should include ref "0" as key');
    assert.ok(script.includes('"1"'), 'multi-export should include ref "1" as key');
  });

  it('single export returns plain result (no object wrapper)', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit = makeOmniJsUnit([0]);

    const script = emitOmniJsUnit(unit, plan, new Map(), [0]);
    // Single export should return the result directly, not wrapped in an object
    assert.ok(script.includes('return JSON.stringify(_r0)'), 'single export should return plain result');
  });
});

// ── SSA ordering ─────────────────────────────────────────────────────────

describe('emitOmniJsUnit — SSA ordering', () => {

  it('emits multiple nodes in order with sequential var names', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
        'omniJS',
      ),
      makeTargetedNode(
        { kind: 'Count', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 2);
    const unit = makeOmniJsUnit([0, 1, 2]);

    const script = emitOmniJsUnit(unit, plan, new Map());
    const varMatches = script.match(/var _r\d+/g);
    assert.ok(varMatches, 'should have var declarations');
    assert.equal(varMatches.length, 3, 'should have exactly 3 var declarations');
  });
});

// ── Error handling ───────────────────────────────────────────────────────

describe('emitOmniJsUnit — error handling', () => {

  it('rejects non-omniJS runtime unit', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Zip', columns: [{ name: 'id', ref: 0 }] },
        'node',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit: ExecutionUnit = {
      runtime: 'node',
      nodes: [0],
      inputs: [],
      result: 0,
      dependsOn: [],
    };
    assert.throws(() => emitOmniJsUnit(unit, plan, new Map()), /expected runtime 'omniJS'/);
  });

  it('throws on unexpected node kind in OmniJS unit', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode({ kind: 'Zip', columns: [{ name: 'id', ref: 0 }] }, 'omniJS'),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit = makeOmniJsUnit([0]);
    assert.throws(() => emitOmniJsUnit(unit, plan, new Map()), /unexpected node kind/);
  });

  it('throws on unknown class code', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode(
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'XXXX' }, effect: 'nonMutating' },
        'omniJS',
      ),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit = makeOmniJsUnit([0]);
    assert.throws(() => emitOmniJsUnit(unit, plan, new Map()), /unknown class code/);
  });
});
