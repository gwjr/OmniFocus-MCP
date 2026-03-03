/**
 * Tests for the mergeSemiJoins EventPlan optimisation pass.
 *
 * Verifies that chains of SemiJoin nodes on the same field are collapsed
 * into a single SemiJoin with a SetOp-combined id set.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSemiJoins } from '../dist/tools/query/eventPlanMergeSemiJoins.js';
import { lowerExpr } from '../dist/tools/query/lower.js';
import { normalizeAst } from '../dist/tools/query/normalizeAst.js';
import { buildSetIrPlan } from '../dist/tools/query/executionUnits/orchestrator.js';
import { lowerSetIrToEventPlan } from '../dist/tools/query/lowerSetIrToEventPlan.js';
import { cseEventPlan } from '../dist/tools/query/eventPlanCSE.js';
import { pruneColumns } from '../dist/tools/query/eventPlanColumnPrune.js';
import { optimizeSetIr } from '../dist/tools/query/lowerToSetIr.js';
import { executeNodeUnit } from '../dist/tools/query/executionUnits/nodeUnit.js';
import type { EventPlan, EventNode, Ref } from '../dist/tools/query/eventPlan.js';
import type { LoweredExpr } from '../dist/tools/query/fold.js';
import type { TargetedEventPlan, ExecutionUnit } from '../dist/tools/query/targetedEventPlan.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function findNodes(plan: EventPlan, kind: EventNode['kind']): EventNode[] {
  return plan.nodes.filter(n => n.kind === kind);
}

/**
 * Build a minimal valid plan with chained SemiJoins.
 *
 * Structure:
 *   %0: Get(Elements(Document, 'FCft'))    — task elements
 *   %1: Get(Property(%0, 'ID  '))          — id column
 *   %2: Zip([{id, %1}])                    — source rows
 *   %3: Get(Elements(Document, 'FCpj'))    — project elements (for idsA)
 *   %4: Get(Property(%3, 'ID  '))          — project ids
 *   %5: ColumnValues(%2, 'id')             — idsA (tasks)  [unused, ids come from %4]
 *   Actually simpler: just use ColumnValues nodes for id sets.
 *
 * Simplified structure:
 *   %0: Zip([{id, ...}])                — rows (placeholder, not really executed)
 *   %1: Zip([{id, ...}])                — rows for idsA source
 *   %2: ColumnValues(%1, 'id')           — idsA
 *   %3: SemiJoin(%0, %2)                — inner SemiJoin
 *   %4: Zip([{id, ...}])                — rows for idsB source
 *   %5: ColumnValues(%4, 'id')           — idsB
 *   %6: SemiJoin(%3, %5, ...)           — outer SemiJoin
 */
function makeChainedSemiJoinPlan(
  outerExclude: boolean = false,
  innerField: string = 'id',
  outerField: string = 'id',
  innerArrayField: boolean = false,
): EventPlan {
  // Use Get nodes to create proper upstream refs
  const doc = { kind: 'Document' as const };
  const nodes: EventNode[] = [
    // %0: source rows
    { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
    { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
    { kind: 'Zip', columns: [{ name: 'id', ref: 1 as Ref }] },

    // %3: idsA source
    { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCpj' }, effect: 'nonMutating' },
    { kind: 'Get', specifier: { kind: 'Property', parent: 3 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
    { kind: 'Zip', columns: [{ name: 'id', ref: 4 as Ref }] },
    { kind: 'ColumnValues', source: 5 as Ref, field: 'id' },

    // %7: inner SemiJoin
    {
      kind: 'SemiJoin',
      source: 2 as Ref,
      ids: 6 as Ref,
      ...(innerField !== 'id' ? { field: innerField } : {}),
      ...(innerArrayField ? { arrayField: true } : {}),
    },

    // %8: idsB source
    { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCtg' }, effect: 'nonMutating' },
    { kind: 'Get', specifier: { kind: 'Property', parent: 8 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
    { kind: 'Zip', columns: [{ name: 'id', ref: 9 as Ref }] },
    { kind: 'ColumnValues', source: 10 as Ref, field: 'id' },

    // %12: outer SemiJoin
    {
      kind: 'SemiJoin',
      source: 7 as Ref,
      ids: 11 as Ref,
      ...(outerField !== 'id' ? { field: outerField } : {}),
      ...(outerExclude ? { exclude: true } : {}),
    },
  ];

  return { nodes, result: 12 };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('mergeSemiJoins', () => {

  it('merges two include-SemiJoins on id into SemiJoin + SetOp(intersect)', () => {
    const plan = makeChainedSemiJoinPlan(false);

    const before = findNodes(plan, 'SemiJoin').length;
    assert.equal(before, 2);

    const merged = mergeSemiJoins(plan);

    const semiJoins = findNodes(merged, 'SemiJoin');
    assert.equal(semiJoins.length, 1, 'Should collapse to 1 SemiJoin');

    const setOps = findNodes(merged, 'SetOp');
    assert.equal(setOps.length, 1, 'Should produce 1 SetOp');
    const setOp = setOps[0] as Extract<EventNode, { kind: 'SetOp' }>;
    assert.equal(setOp.op, 'intersect');
  });

  it('merges include + exclude SemiJoins into SemiJoin + SetOp(subtract)', () => {
    const plan = makeChainedSemiJoinPlan(true);

    const merged = mergeSemiJoins(plan);

    const semiJoins = findNodes(merged, 'SemiJoin');
    assert.equal(semiJoins.length, 1, 'Should collapse to 1 SemiJoin');

    const setOps = findNodes(merged, 'SetOp');
    assert.equal(setOps.length, 1, 'Should produce 1 SetOp');
    const setOp = setOps[0] as Extract<EventNode, { kind: 'SetOp' }>;
    assert.equal(setOp.op, 'subtract');
  });

  it('does not merge SemiJoins on different fields', () => {
    const plan = makeChainedSemiJoinPlan(false, 'projectId', 'id');

    const merged = mergeSemiJoins(plan);

    const semiJoins = findNodes(merged, 'SemiJoin');
    assert.equal(semiJoins.length, 2, 'Should keep 2 SemiJoins (different fields)');
    assert.equal(findNodes(merged, 'SetOp').length, 0, 'No SetOp produced');
  });

  it('does not merge when inner SemiJoin uses arrayField', () => {
    const plan = makeChainedSemiJoinPlan(false, 'tagIds', 'tagIds', true);

    const merged = mergeSemiJoins(plan);
    assert.equal(findNodes(merged, 'SemiJoin').length, 2, 'Should keep 2 (arrayField blocks merge)');
  });

  it('does not merge when inner is an exclude SemiJoin', () => {
    // Build a plan where inner is exclude — need to construct manually
    const doc = { kind: 'Document' as const };
    const nodes: EventNode[] = [
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 as Ref }] },
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCpj' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 3 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 4 as Ref }] },
      { kind: 'ColumnValues', source: 5 as Ref, field: 'id' },
      { kind: 'SemiJoin', source: 2 as Ref, ids: 6 as Ref, exclude: true },  // inner is EXCLUDE
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCtg' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 8 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 9 as Ref }] },
      { kind: 'ColumnValues', source: 10 as Ref, field: 'id' },
      { kind: 'SemiJoin', source: 7 as Ref, ids: 11 as Ref },  // outer is include
    ];
    const plan: EventPlan = { nodes, result: 12 };

    const merged = mergeSemiJoins(plan);
    assert.equal(findNodes(merged, 'SemiJoin').length, 2, 'Should keep 2 (inner exclude blocks merge)');
  });

  it('returns plan unchanged when no SemiJoin chains exist', () => {
    const doc = { kind: 'Document' as const };
    const plan: EventPlan = {
      nodes: [
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'id', ref: 1 as Ref }] },
        { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCpj' }, effect: 'nonMutating' },
        { kind: 'Get', specifier: { kind: 'Property', parent: 3 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
        { kind: 'Zip', columns: [{ name: 'id', ref: 4 as Ref }] },
        { kind: 'ColumnValues', source: 5 as Ref, field: 'id' },
        { kind: 'SemiJoin', source: 2 as Ref, ids: 6 as Ref },
      ],
      result: 7,
    };

    const merged = mergeSemiJoins(plan);
    assert.equal(merged.nodes.length, plan.nodes.length, 'Plan should be unchanged');
    assert.equal(findNodes(merged, 'SemiJoin').length, 1);
  });

  it('does not merge when inner SemiJoin has multiple consumers', () => {
    const doc = { kind: 'Document' as const };
    const nodes: EventNode[] = [
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 as Ref }] },
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCpj' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 3 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 4 as Ref }] },
      { kind: 'ColumnValues', source: 5 as Ref, field: 'id' },
      { kind: 'SemiJoin', source: 2 as Ref, ids: 6 as Ref },         // inner (%7)
      { kind: 'ColumnValues', source: 7 as Ref, field: 'id' },        // consumes inner (%8)
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCtg' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 9 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 10 as Ref }] },
      { kind: 'ColumnValues', source: 11 as Ref, field: 'id' },
      { kind: 'SemiJoin', source: 7 as Ref, ids: 12 as Ref },        // outer (%13, also consumes inner %7)
    ];
    const plan: EventPlan = { nodes, result: 13 };

    const merged = mergeSemiJoins(plan);
    // inner (ref 7) is consumed by both ref 8 (ColumnValues) and ref 13 (outer SemiJoin)
    assert.equal(findNodes(merged, 'SemiJoin').length, 2, 'Should keep 2 (multi-consumer)');
  });

  it('handles chain of 3 SemiJoins (merges one pair per pass)', () => {
    // Build: SemiJoin_C(SemiJoin_B(SemiJoin_A(src, idsA), idsB), idsC)
    // Single-pass merge should collapse the outermost pair (B+C), leaving 2.
    const doc = { kind: 'Document' as const };
    const nodes: EventNode[] = [
      // %0-2: source rows
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCft' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 1 as Ref }] },
      // %3-5: idsA
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCpj' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 3 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 4 as Ref }] },
      { kind: 'ColumnValues', source: 5 as Ref, field: 'id' },
      // %7: SemiJoin A
      { kind: 'SemiJoin', source: 2 as Ref, ids: 6 as Ref },
      // %8-10: idsB
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCtg' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 8 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 9 as Ref }] },
      { kind: 'ColumnValues', source: 10 as Ref, field: 'id' },
      // %12: SemiJoin B
      { kind: 'SemiJoin', source: 7 as Ref, ids: 11 as Ref },
      // %13-15: idsC
      { kind: 'Get', specifier: { kind: 'Elements', parent: doc, classCode: 'FCfl' }, effect: 'nonMutating' },
      { kind: 'Get', specifier: { kind: 'Property', parent: 13 as Ref, propCode: 'ID  ' }, effect: 'nonMutating' },
      { kind: 'Zip', columns: [{ name: 'id', ref: 14 as Ref }] },
      { kind: 'ColumnValues', source: 15 as Ref, field: 'id' },
      // %17: SemiJoin C (outermost)
      { kind: 'SemiJoin', source: 12 as Ref, ids: 16 as Ref },
    ];
    const plan: EventPlan = { nodes, result: 17 };

    assert.equal(findNodes(plan, 'SemiJoin').length, 3, 'Before: 3 SemiJoins');

    const merged = mergeSemiJoins(plan);
    const semiJoins = findNodes(merged, 'SemiJoin');
    const setOps = findNodes(merged, 'SetOp');

    // The linear scan merges from low to high index: first B+A (i=12), then C+merged(B,A) (i=17).
    // All three collapse into a single SemiJoin with nested SetOps.
    assert.equal(semiJoins.length, 1, 'After pass: all 3 SemiJoins collapse to 1');
    assert.equal(setOps.length, 2, 'Should produce 2 SetOps (one per merge)');
  });
});

// ── SetOp execution tests ──────────────────────────────────────────────────

describe('SetOp execution in nodeUnit', () => {

  it('intersect: computes left ∩ right', () => {
    const plan: TargetedEventPlan = {
      nodes: [
        { kind: 'Zip', columns: [] },                                             // %0 placeholder
        { kind: 'Zip', columns: [] },                                             // %1 placeholder
        { kind: 'SetOp', left: 0 as Ref, right: 1 as Ref, op: 'intersect' },    // %2
      ],
      result: 2,
      runtimes: [
        { kind: 'fixed', runtime: 'node' },
        { kind: 'fixed', runtime: 'node' },
        { kind: 'fixed', runtime: 'node' },
      ],
    };
    const unit: ExecutionUnit = { runtime: 'node', nodes: [2], result: 2 };
    const results = new Map<number, unknown>();
    results.set(0, ['a', 'b', 'c']);
    results.set(1, ['b', 'c', 'd']);

    const result = executeNodeUnit(unit, plan, results) as Set<string>;
    assert.ok(result instanceof Set);
    assert.deepEqual([...result].sort(), ['b', 'c']);
  });

  it('subtract: computes left \\ right', () => {
    const plan: TargetedEventPlan = {
      nodes: [
        { kind: 'Zip', columns: [] },
        { kind: 'Zip', columns: [] },
        { kind: 'SetOp', left: 0 as Ref, right: 1 as Ref, op: 'subtract' },
      ],
      result: 2,
      runtimes: [
        { kind: 'fixed', runtime: 'node' },
        { kind: 'fixed', runtime: 'node' },
        { kind: 'fixed', runtime: 'node' },
      ],
    };
    const unit: ExecutionUnit = { runtime: 'node', nodes: [2], result: 2 };
    const results = new Map<number, unknown>();
    results.set(0, ['a', 'b', 'c']);
    results.set(1, ['b', 'c', 'd']);

    const result = executeNodeUnit(unit, plan, results) as Set<string>;
    assert.ok(result instanceof Set);
    assert.deepEqual([...result].sort(), ['a']);
  });

  it('handles Set inputs', () => {
    const plan: TargetedEventPlan = {
      nodes: [
        { kind: 'Zip', columns: [] },
        { kind: 'Zip', columns: [] },
        { kind: 'SetOp', left: 0 as Ref, right: 1 as Ref, op: 'intersect' },
      ],
      result: 2,
      runtimes: [
        { kind: 'fixed', runtime: 'node' },
        { kind: 'fixed', runtime: 'node' },
        { kind: 'fixed', runtime: 'node' },
      ],
    };
    const unit: ExecutionUnit = { runtime: 'node', nodes: [2], result: 2 };
    const results = new Map<number, unknown>();
    results.set(0, new Set(['a', 'b', 'c']));
    results.set(1, new Set(['b', 'c', 'd']));

    const result = executeNodeUnit(unit, plan, results) as Set<string>;
    assert.ok(result instanceof Set);
    assert.deepEqual([...result].sort(), ['b', 'c']);
  });
});

// ── End-to-end: verify the pass fires on a realistic plan ──────────────

describe('mergeSemiJoins — realistic plans', () => {
  it('merges SemiJoins in a container(project) + project-exclusion plan', () => {
    const where = { container: ['project', { contains: [{ var: 'name' }, 'PHS'] }] };
    const ast = normalizeAst(lowerExpr(where) as LoweredExpr);

    let plan = buildSetIrPlan({ predicate: ast, entity: 'tasks', op: 'get', select: ['name'] });
    plan = optimizeSetIr(plan);
    const ep = lowerSetIrToEventPlan(plan, ['name']);
    const csed = cseEventPlan(ep);
    const pruned = pruneColumns(csed);

    const semiJoinsBefore = pruned.nodes.filter(n => n.kind === 'SemiJoin').length;
    const merged = mergeSemiJoins(pruned);
    const semiJoinsAfter = merged.nodes.filter(n => n.kind === 'SemiJoin').length;

    // Should have at least 1 fewer SemiJoin
    assert.ok(semiJoinsAfter < semiJoinsBefore,
      `Expected fewer SemiJoins: before=${semiJoinsBefore}, after=${semiJoinsAfter}`);

    // Should have at least 1 SetOp node
    const setOps = merged.nodes.filter(n => n.kind === 'SetOp').length;
    assert.ok(setOps >= 1, `Expected at least 1 SetOp, got ${setOps}`);
  });
});
