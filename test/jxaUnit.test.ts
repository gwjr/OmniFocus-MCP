/**
 * Unit tests for JXA ExecutionUnit codegen (emitJxaUnit).
 *
 * Verifies that emitJxaUnit produces valid-looking JXA script strings
 * for various node kinds and specifier types.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EventPlan, EventNode, Ref, RuntimeAllocation } from '../dist/tools/query/eventPlan.js';
import type { TargetedEventPlan, TargetedNode, ExecutionUnit } from '../dist/tools/query/targetedEventPlan.js';
import { targetEventPlan } from '../dist/tools/query/targetedEventPlanLowering.js';
import { emitJxaUnit } from '../dist/tools/query/executionUnits/jxaUnit.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const doc = { kind: 'Document' as const };

function makePlan(nodes: EventNode[], result?: Ref): EventPlan {
  return { nodes, result: result ?? nodes.length - 1 };
}

function makeTargetedNode(node: EventNode, runtime: string, kind: 'proposed' | 'fixed' = 'proposed'): TargetedNode {
  return { ...node, runtimeAllocation: { kind, runtime } as RuntimeAllocation } as TargetedNode;
}

function makeTargetedPlan(nodes: TargetedNode[], result?: Ref): TargetedEventPlan {
  return { nodes, result: result ?? nodes.length - 1 };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('emitJxaUnit', () => {

  it('emits a valid JXA IIFE for a single Get(Elements)', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;
    assert.ok(jxaUnit, 'should have a jxa unit');

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    assert.ok(script.includes('Application(\'OmniFocus\')'), 'should reference OmniFocus app');
    assert.ok(script.includes('app.defaultDocument'), 'should access defaultDocument');
    assert.ok(script.includes('flattenedTasks'), 'should use flattenedTasks collection');
    assert.ok(script.includes('JSON.stringify'), 'should JSON.stringify the result');
    assert.ok(script.startsWith('(function()'), 'should be an IIFE');
  });

  // ── Regression: premature AE collection materialisation (bug #14) ──────
  //
  // Get(Elements) must NOT append () — it produces an AE specifier reference
  // that downstream Property reads chain onto. Calling () materialises the
  // collection as a JS array, breaking bulk reads like .name().
  //
  // Correct:   var _r0 = doc.flattenedTasks;    var _r1 = _r0.name();
  // Was buggy: var _r0 = doc.flattenedTasks();   var _r1 = _r0.name();

  it('Get(Elements) does not materialise with () — Get(Property) does', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());

    // Elements: no parens — keeps AE specifier alive for chaining
    assert.ok(
      script.includes('doc.flattenedTasks;'),
      'Get(Elements) should assign without () — AE specifier, not materialised array',
    );
    assert.ok(
      !script.includes('doc.flattenedTasks()'),
      'Get(Elements) must NOT call () — would prematurely materialise the collection',
    );

    // Property: has parens — materialises the bulk read
    assert.ok(
      script.includes('.name()'),
      'Get(Property) should call () to materialise the bulk property read',
    );
  });

  it('emits Property access with correct accessor name', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    assert.ok(script.includes('.name'), 'should use .name accessor for pnam');
  });

  it('emits Count as .length', () => {
    const plan = makePlan([
      { kind: 'Count', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    assert.ok(script.includes('.length'), 'Count should use .length');
  });

  it('emits ByName specifier', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'ByName', parent: { kind: 'Elements', parent: doc, classCode: 'FCfc' }, name: 'Work' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    assert.ok(script.includes('byName("Work")'), 'should use byName with the tag name');
  });

  it('emits ByID specifier with string id', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'ByID', parent: { kind: 'Elements', parent: doc, classCode: 'FCft' }, id: 'abc123' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    assert.ok(script.includes('byId("abc123")'), 'should use byId with the ID');
  });

  it('emits ByIndex specifier', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'ByIndex', parent: { kind: 'Elements', parent: doc, classCode: 'FCft' }, index: 0 }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    assert.ok(script.includes('[0]'), 'should use bracket index access');
  });

  it('emits Set with value ref', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Set', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, value: 0, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    assert.ok(script.includes('.set('), 'Set should use .set()');
  });

  it('emits different collection accessors for different class codes', () => {
    // Projects
    const planProjects = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCfx' }, effect: 'nonMutating' },
    ]);
    const { targeted: t1, units: u1 } = targetEventPlan(planProjects);
    const s1 = emitJxaUnit(u1[0], t1, new Map());
    assert.ok(s1.includes('flattenedProjects'), 'FCfx should map to flattenedProjects');

    // Folders
    const planFolders = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCff' }, effect: 'nonMutating' },
    ]);
    const { targeted: t2, units: u2 } = targetEventPlan(planFolders);
    const s2 = emitJxaUnit(u2[0], t2, new Map());
    assert.ok(s2.includes('flattenedFolders'), 'FCff should map to flattenedFolders');

    // Tags
    const planTags = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCfc' }, effect: 'nonMutating' },
    ]);
    const { targeted: t3, units: u3 } = targetEventPlan(planTags);
    const s3 = emitJxaUnit(u3[0], t3, new Map());
    assert.ok(s3.includes('flattenedTags'), 'FCfc should map to flattenedTags');
  });

  it('rejects non-jxa runtime unit', () => {
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
    assert.throws(() => emitJxaUnit(unit, plan, new Map()), /expected runtime 'jxa'/);
  });

  it('throws on unexpected node kind in JXA unit', () => {
    const nodes: TargetedNode[] = [
      makeTargetedNode({ kind: 'Zip', columns: [{ name: 'id', ref: 0 }] }, 'jxa'),
    ];
    const plan = makeTargetedPlan(nodes, 0);
    const unit: ExecutionUnit = { runtime: 'jxa', nodes: [0], inputs: [], result: 0, dependsOn: [] };
    assert.throws(() => emitJxaUnit(unit, plan, new Map()), /unexpected node kind/);
  });

  it('uses cross-unit input refs', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
    ]);
    const { targeted } = targetEventPlan(plan);

    // Simulate: ref 0 is in a different unit, ref 1 is in this unit
    const unit: ExecutionUnit = {
      runtime: 'jxa',
      nodes: [1],
      inputs: [0],
      result: 1,
      dependsOn: [],
    };
    const inputs = new Map<number, string>([[0, '_external0']]);
    const script = emitJxaUnit(unit, targeted, inputs);
    assert.ok(script.includes('_external0'), 'should reference the cross-unit input variable');
  });

  // ── Regression: FCtg tag chain emission (bug #16) ──────────────────────
  //
  // Get(Property(elemRef, FCtg)) must emit `_r0.tags.name()` (chain accessor),
  // NOT `_r0.FCtg()` (raw FourCC) or `_r0.tags()` (missing .name chain).
  // The `tags` property on tasks is a chain accessor that returns nested
  // string arrays via `.tags.name()`.

  it('emits .tags.name() for FCtg property (not raw FourCC)', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'FCtg' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    // Must use chain accessor: .tags.name() — not .FCtg() or .tags()
    assert.ok(script.includes('.tags.name()'), 'FCtg should emit .tags.name() chain accessor');
    assert.ok(!script.includes('.FCtg'), 'should NOT emit raw FourCC code');
  });

  it('FCtg chain accessor materialises with () like other properties', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'FCtg' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    // The Property-kind Get node should materialise with () — check that
    // the tags chain ends with ()
    const match = script.match(/\.tags\.name\(\)/);
    assert.ok(match, 'chain accessor should be materialised with ()');
  });

  // ── Regression: project status value transform (#23) ────────────────────
  //
  // Get(Property(elemRef, FCPS)) must apply a post-read .map() transform
  // that maps raw Apple Events status strings ("active status", "done status",
  // etc.) to the domain model strings ("Active", "Done", etc.).
  // Without the transform, the Filter predicate `status in ['Active','OnHold']`
  // sees "active status" and rejects all projects.

  it('emits value transform for effectiveStatus (FCPS)', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCfx' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'FCPS' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    // Should include a .map() transform after effectiveStatus()
    assert.ok(script.includes('.effectiveStatus()'), 'should call .effectiveStatus()');
    assert.ok(script.includes('.map(function(v)'), 'should apply post-read .map() transform');
    assert.ok(script.includes('"active status":"Active"'), 'should map "active status" to "Active"');
    assert.ok(script.includes('"done status":"Done"'), 'should map "done status" to "Done"');
    assert.ok(script.includes('"on hold status":"OnHold"'), 'should map "on hold status" to "OnHold"');
    assert.ok(script.includes('"dropped status":"Dropped"'), 'should map "dropped status" to "Dropped"');
  });

  it('emits value transform for status (FCPs) — same mapping', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCfx' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'FCPs' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    assert.ok(script.includes('.map(function(v)'), 'should apply post-read .map() transform for status too');
    assert.ok(script.includes('"active status":"Active"'), 'should map "active status" to "Active"');
  });

  it('date properties get ISO string transform', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'FCDd' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    assert.ok(script.includes('.toISOString()'), 'date properties should get ISO string transform');
  });

  it('ID properties get string coercion transform', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'ID  ' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    assert.ok(script.includes('.toString()'), 'ID properties should get string coercion transform');
  });

  it('simple property without transform has no .map() suffix', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'FCfl' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    // flagged() should not have a .map() suffix
    assert.ok(script.includes('.flagged()'), 'should call .flagged()');
    // Check that the flagged line doesn't have .map after it
    const flaggedLine = script.split('\n').find(l => l.includes('.flagged()'));
    assert.ok(flaggedLine, 'should have a line with .flagged()');
    assert.ok(!flaggedLine!.includes('.map('), 'flagged should not have a .map() transform');
  });

  it('emits multiple nodes in SSA order', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
      { kind: 'Count', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;
    assert.equal(jxaUnit.nodes.length, 3, 'all 3 nodes should be in the jxa unit');

    const script = emitJxaUnit(jxaUnit, targeted, new Map());
    // Should have 3 var declarations (one per node)
    const varMatches = script.match(/var _r\d+/g);
    assert.ok(varMatches, 'should have var declarations');
    assert.equal(varMatches.length, 3, 'should have exactly 3 var declarations');
  });

  it('multi-export returns object keyed by ref string', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0, propCode: 'pnam' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map(), [0, 1]);
    // Multi-export should produce {"0": _r0, "1": _r1}
    assert.ok(script.includes('"0"'), 'multi-export should include ref "0" as key');
    assert.ok(script.includes('"1"'), 'multi-export should include ref "1" as key');
  });

  it('single export returns plain result (no object wrapper)', () => {
    const plan = makePlan([
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
    ]);
    const { targeted, units } = targetEventPlan(plan);
    const jxaUnit = units.find(u => u.runtime === 'jxa')!;

    const script = emitJxaUnit(jxaUnit, targeted, new Map(), [0]);
    // Single export should return the variable directly, not wrapped in an object
    assert.ok(script.includes('return JSON.stringify(_r0)'), 'single export should return plain result');
    assert.ok(!script.includes('"0":'), 'single export should NOT wrap in object');
  });
});

