/**
 * Behavior-lock tests for the EventNode IR Registry.
 *
 * Verifies that defaultRuntime, collectRefs, and rewriteRefs return
 * correct results for all 19 EventNode kinds.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_NODE_IR, dispatchDefaultRuntime, dispatchCollectRefs, dispatchRewriteRefs } from '../dist/tools/query/eventNodeRegistry.js';
import { defaultRuntime, collectRefs, rewriteNode } from '../dist/tools/query/eventPlanUtils.js';

// ── Test fixtures ─────────────────────────────────────────────────────────

const doc = { kind: 'Document' as const };
const elemSpec = { kind: 'Elements' as const, parent: doc, classCode: 'FCft' };
const propSpec = { kind: 'Property' as const, parent: 0 as const, propCode: 'pnam' };
const byIdSpec = { kind: 'ByID' as const, parent: 0 as const, id: 'abc' };

const ALL_NODES = {
  Get:          { kind: 'Get' as const, specifier: elemSpec, effect: 'nonMutating' as const },
  Count:        { kind: 'Count' as const, specifier: elemSpec, effect: 'nonMutating' as const },
  Set:          { kind: 'Set' as const, specifier: propSpec, value: 1, effect: 'nonMutating' as const },
  Command:      { kind: 'Command' as const, fourCC: 'slct', target: byIdSpec, args: { to: 2 }, effect: 'sideEffective' as const },
  ForEach:      { kind: 'ForEach' as const, source: 0, body: [], collect: 0, effect: 'nonMutating' as const },
  Zip:          { kind: 'Zip' as const, columns: [{ name: 'id', ref: 0 }, { name: 'name', ref: 1 }] },
  ColumnValues: { kind: 'ColumnValues' as const, source: 0, field: 'id' },
  Flatten:      { kind: 'Flatten' as const, source: 0 },
  Filter:       { kind: 'Filter' as const, source: 0, predicate: true },
  SemiJoin:     { kind: 'SemiJoin' as const, source: 0, ids: 1 },
  HashJoin:     { kind: 'HashJoin' as const, source: 0, lookup: 1, sourceKey: 'id', lookupKey: 'id', fieldMap: { name: 'name' } },
  Sort:         { kind: 'Sort' as const, source: 0, by: 'name', dir: 'asc' as const },
  Limit:        { kind: 'Limit' as const, source: 0, n: 10 },
  Pick:         { kind: 'Pick' as const, source: 0, fields: ['id', 'name'] },
  Derive:       { kind: 'Derive' as const, source: 0, derivations: [{ var: 'status', entity: 'tasks' as const }] },
  Union:        { kind: 'Union' as const, left: 0, right: 1 },
  RowCount:     { kind: 'RowCount' as const, source: 0 },
  AddSwitch:    { kind: 'AddSwitch' as const, source: 0, column: 'status', cases: [], default: 'error' as const },
  SetOp:        { kind: 'SetOp' as const, left: 0, right: 1, op: 'intersect' as const },
} as const;

// ── Registry completeness ────────────────────────────────────────────────

describe('EVENT_NODE_IR — completeness', () => {
  it('has exactly 21 entries', () => {
    assert.equal(Object.keys(EVENT_NODE_IR).length, 21);
  });

  it('covers all EventNode kinds from fixtures', () => {
    for (const kind of Object.keys(ALL_NODES)) {
      assert.ok(kind in EVENT_NODE_IR, `missing registry entry for '${kind}'`);
    }
  });
});

// ── defaultRuntime parity ────────────────────────────────────────────────

describe('defaultRuntime — parity', () => {
  const expected: Record<string, string> = {
    Get: 'jxa', Count: 'jxa', Set: 'jxa', Command: 'jxa', ForEach: 'jxa',
    Zip: 'node', ColumnValues: 'node', Flatten: 'node', Filter: 'node',
    SemiJoin: 'node', HashJoin: 'node', Sort: 'node', Limit: 'node',
    Pick: 'node', Derive: 'node', Union: 'node', RowCount: 'node',
    AddSwitch: 'node', SetOp: 'node',
  };

  for (const [kind, node] of Object.entries(ALL_NODES)) {
    it(`${kind} → ${expected[kind]}`, () => {
      assert.equal(dispatchDefaultRuntime(node as any), expected[kind]);
      assert.equal(defaultRuntime(node as any), expected[kind]);
    });
  }
});

// ── collectRefs parity ──────────────────────────────────────────────────

describe('collectRefs — parity', () => {
  const expected: Record<string, number[]> = {
    Get:          [],        // Document specifier has no refs
    Count:        [],
    Set:          [0, 1],    // propSpec parent=0, value=1
    Command:      [0, 2],    // byIdSpec parent=0, args.to=2
    ForEach:      [0],
    Zip:          [0, 1],
    ColumnValues: [0],
    Flatten:      [0],
    Filter:       [0],
    SemiJoin:     [0, 1],
    HashJoin:     [0, 1],
    Sort:         [0],
    Limit:        [0],
    Pick:         [0],
    Derive:       [0],
    Union:        [0, 1],
    RowCount:     [0],
    AddSwitch:    [0],
    SetOp:        [0, 1],
  };

  for (const [kind, node] of Object.entries(ALL_NODES)) {
    it(`${kind} refs match`, () => {
      const registryRefs = dispatchCollectRefs(node as any);
      const legacyRefs = collectRefs(node as any);
      assert.deepEqual(registryRefs, expected[kind], `registry refs for ${kind}`);
      assert.deepEqual(legacyRefs, expected[kind], `legacy refs for ${kind}`);
    });
  }
});

// ── rewriteRefs round-trip ──────────────────────────────────────────────

describe('rewriteRefs — identity remap', () => {
  const identity = (r: number) => r;

  for (const [kind, node] of Object.entries(ALL_NODES)) {
    it(`${kind} identity remap preserves node`, () => {
      const registryResult = dispatchRewriteRefs(node as any, identity);
      const legacyResult = rewriteNode(node as any, identity);
      assert.deepEqual(registryResult, legacyResult);
    });
  }
});

describe('rewriteRefs — offset remap', () => {
  const offset = (r: number) => r + 10;

  it('Zip columns get remapped', () => {
    const result = dispatchRewriteRefs(ALL_NODES.Zip as any, offset) as typeof ALL_NODES.Zip;
    assert.deepEqual(result.columns, [{ name: 'id', ref: 10 }, { name: 'name', ref: 11 }]);
  });

  it('SemiJoin source and ids get remapped', () => {
    const result = dispatchRewriteRefs(ALL_NODES.SemiJoin as any, offset) as typeof ALL_NODES.SemiJoin;
    assert.equal(result.source, 10);
    assert.equal(result.ids, 11);
  });

  it('Union left and right get remapped', () => {
    const result = dispatchRewriteRefs(ALL_NODES.Union as any, offset) as typeof ALL_NODES.Union;
    assert.equal(result.left, 10);
    assert.equal(result.right, 11);
  });

  it('Set specifier and value get remapped', () => {
    const result = dispatchRewriteRefs(ALL_NODES.Set as any, offset) as any;
    assert.equal(result.specifier.parent, 10);
    assert.equal(result.value, 11);
  });

  it('Command target and args get remapped', () => {
    const result = dispatchRewriteRefs(ALL_NODES.Command as any, offset) as any;
    assert.equal(result.target.parent, 10);
    assert.equal(result.args.to, 12);
  });
});
