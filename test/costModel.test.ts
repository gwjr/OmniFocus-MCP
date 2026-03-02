/**
 * Unit tests for the cost model (runtimeCost, opCost).
 *
 * Verifies calibrated cost estimates for all runtimes and EventNode kinds.
 * Pure functions, no external dependencies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeCost, opCost } from '../dist/tools/query/costModel.js';
import type { EventNode } from '../dist/tools/query/eventPlan.js';

// ── runtimeCost ─────────────────────────────────────────────────────────

describe('runtimeCost', () => {

  it('jxa has IPC overhead (~50ms)', () => {
    assert.equal(runtimeCost('jxa'), 50);
  });

  it('omniJS has compilation overhead (~1700ms)', () => {
    assert.equal(runtimeCost('omniJS'), 1700);
  });

  it('node is free (0ms)', () => {
    assert.equal(runtimeCost('node'), 0);
  });

  it('omniJS > jxa > node', () => {
    assert.ok(runtimeCost('omniJS') > runtimeCost('jxa'));
    assert.ok(runtimeCost('jxa') > runtimeCost('node'));
  });
});

// ── opCost: AE ops in JXA ──────────────────────────────────────────────

describe('opCost — JXA AE ops', () => {

  it('Get returns fixed cost', () => {
    const cost = opCost('jxa', 'Get', 1000);
    assert.equal(cost, 160);
  });

  it('Count returns fixed cost', () => {
    assert.equal(opCost('jxa', 'Count', 500), 110);
  });

  it('Set returns fixed cost', () => {
    assert.equal(opCost('jxa', 'Set', 1), 150);
  });

  it('Command returns fixed cost', () => {
    assert.equal(opCost('jxa', 'Command', 1), 200);
  });

  it('ForEach scales linearly with cardinality', () => {
    const cost0 = opCost('jxa', 'ForEach', 0);
    const cost10 = opCost('jxa', 'ForEach', 10);
    const cost100 = opCost('jxa', 'ForEach', 100);

    assert.equal(cost0, 100);          // base cost only
    assert.equal(cost10, 100 + 10 * 75);
    assert.equal(cost100, 100 + 100 * 75);
    assert.ok(cost100 > cost10);
    assert.ok(cost10 > cost0);
  });
});

// ── opCost: node-side ops ───────────────────────────────────────────────

describe('opCost — node-side ops', () => {

  const nodeOps: EventNode['kind'][] = [
    'Zip', 'ColumnValues', 'Flatten', 'Filter', 'SemiJoin',
    'HashJoin', 'Sort', 'Limit', 'Pick', 'Derive',
  ];

  for (const kind of nodeOps) {
    it(`${kind} returns non-negative cost`, () => {
      const cost = opCost('node', kind, 100);
      assert.ok(cost >= 0, `${kind} cost should be >= 0`);
    });
  }

  it('all node-side ops are cheap relative to AE ops', () => {
    const getCost = opCost('jxa', 'Get', 1000);
    for (const kind of nodeOps) {
      const cost = opCost('node', kind, 1000);
      assert.ok(cost < getCost, `node ${kind} (${cost}ms) should be cheaper than JXA Get (${getCost}ms)`);
    }
  });

  it('Filter scales linearly with cardinality', () => {
    const cost100 = opCost('node', 'Filter', 100);
    const cost1000 = opCost('node', 'Filter', 1000);
    assert.ok(Math.abs(cost1000 / cost100 - 10) < 0.01, 'should scale 10x');
  });

  it('Sort scales as n*log(n)', () => {
    const cost100 = opCost('node', 'Sort', 100);
    const cost1000 = opCost('node', 'Sort', 1000);
    // 1000*log2(1000) / (100*log2(100)) ≈ 10 * 1.5 = 15
    assert.ok(cost1000 > cost100 * 10, 'Sort should scale super-linearly');
  });

  it('Sort with zero cardinality returns 0', () => {
    assert.equal(opCost('node', 'Sort', 0), 0);
  });

  it('Limit has constant cost', () => {
    const cost1 = opCost('node', 'Limit', 1);
    const cost10000 = opCost('node', 'Limit', 10000);
    assert.equal(cost1, cost10000, 'Limit cost should not depend on cardinality');
  });
});

// ── opCost: AE ops misassigned to node ──────────────────────────────────

describe('opCost — AE ops on node runtime (penalty)', () => {

  const aeOps: EventNode['kind'][] = ['Get', 'Count', 'Set', 'Command', 'ForEach'];

  for (const kind of aeOps) {
    it(`${kind} on node returns high penalty`, () => {
      const cost = opCost('node', kind, 100);
      assert.ok(cost >= 10000, `${kind} on node should return penalty (got ${cost})`);
    });
  }
});

// ── opCost: node-side ops in JXA context ────────────────────────────────

describe('opCost — node-side ops in JXA context (fallthrough)', () => {

  it('data-manipulation ops in JXA use nodeOpCost', () => {
    // When data ops are assigned to JXA, they should still use node costs
    // (they operate on in-memory arrays, no AE overhead)
    const nodeFilterCost = opCost('node', 'Filter', 500);
    const jxaFilterCost = opCost('jxa', 'Filter', 500);
    assert.equal(jxaFilterCost, nodeFilterCost, 'Filter in JXA should equal node cost');
  });
});

// ── opCost: omniJS uses same costs as JXA ───────────────────────────────

describe('opCost — omniJS', () => {

  it('AE ops in omniJS match JXA costs', () => {
    assert.equal(opCost('omniJS', 'Get', 100), opCost('jxa', 'Get', 100));
    assert.equal(opCost('omniJS', 'Set', 1), opCost('jxa', 'Set', 1));
  });

  it('node-side ops in omniJS match node costs', () => {
    assert.equal(opCost('omniJS', 'Filter', 500), opCost('node', 'Filter', 500));
    assert.equal(opCost('omniJS', 'Sort', 100), opCost('node', 'Sort', 100));
  });
});
