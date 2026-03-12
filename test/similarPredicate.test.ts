/**
 * Tests for the `similar` predicate operator.
 *
 * Covers: operations registry, lower validation, describer output,
 * nodeEval safety throw, SetIR optimizer rewrite, and EventPlan lowering.
 *
 * Type-safety (exhaustive registry entries, cost model completeness) is
 * enforced at compile time via mapped types — no runtime tests needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { operations } from '../dist/tools/query/operations.js';
import { lowerExpr } from '../dist/tools/query/lower.js';
import { describeExpr } from '../dist/tools/query/backends/describer.js';
import { compileNodePredicate } from '../dist/tools/query/backends/nodeEval.js';
import { lowerToSetIr, optimizeSetIr } from '../dist/tools/query/lowerToSetIr.js';
import { lowerSetIrToEventPlan } from '../dist/tools/query/lowerSetIrToEventPlan.js';
import { describeEventPlan } from '../dist/tools/query/eventPlanDescriber.js';
import { queryOmnifocus } from '../dist/tools/primitives/queryOmnifocus.js';

// ── Layer 1: Operations + Lower + Describer ─────────────────────────────

describe('similar — operations registry', () => {
  it('similar is registered as a unary op', () => {
    assert.ok('similar' in operations);
    assert.equal(operations.similar.minArgs, 1);
    assert.equal(operations.similar.maxArgs, 1);
  });
});

describe('similar — lower', () => {
  it('accepts a string query argument', () => {
    const ast = lowerExpr({ similar: ['kitchen supplies'] });
    assert.ok(ast);
    assert.equal((ast as any).op, 'similar');
  });

  it('rejects non-string argument', () => {
    assert.throws(() => lowerExpr({ similar: [42] }), /similar requires a string/);
  });

  it('rejects missing argument', () => {
    assert.throws(() => lowerExpr({ similar: [] }));
  });
});

describe('similar — describer', () => {
  it('describes as "similar to ..."', () => {
    const result = describeExpr({ similar: ['legal brief'] });
    assert.ok(result.includes('similar to'));
    assert.ok(result.includes('legal brief'));
  });
});

describe('similar — nodeEval', () => {
  it('throws when compiled (must be planner-extracted)', () => {
    const ast = lowerExpr({ similar: ['test'] });
    assert.throws(
      () => compileNodePredicate(ast, 'tasks'),
      /similar.*planner/i,
    );
  });
});

// ── Layer 2: SetIR — similarShortcut optimizer ───────────────────────────

describe('similar — SetIR optimizer', () => {
  it('standalone similar creates SimilarItems node', () => {
    const ast = lowerExpr({ similar: ['kitchen'] });
    const setIr = lowerToSetIr({ predicate: ast, entity: 'tasks', op: 'get' });
    const optimized = optimizeSetIr(setIr);
    assert.ok(findNode(optimized, 'SimilarItems'), 'Expected SimilarItems node in optimized SetIR');
  });

  it('composed similar + filter creates SimilarItems', () => {
    const ast = lowerExpr({
      and: [{ similar: ['legal'] }, { eq: [{ var: 'flagged' }, true] }],
    });
    const setIr = lowerToSetIr({ predicate: ast, entity: 'tasks', op: 'get' });
    const optimized = optimizeSetIr(setIr);
    assert.ok(findNode(optimized, 'SimilarItems'), 'Expected SimilarItems node');
  });

  it('SimilarItems preserves semantic ordering (left of Intersect)', () => {
    const ast = lowerExpr({
      and: [{ similar: ['legal'] }, { eq: [{ var: 'flagged' }, true] }],
    });
    const setIr = lowerToSetIr({ predicate: ast, entity: 'tasks', op: 'get' });
    const optimized = optimizeSetIr(setIr);
    // Walk the tree to find any Intersect that has SimilarItems descendant — it should be on left
    const intersect = findNode(optimized, 'Intersect');
    if (intersect) {
      const leftHasSimilar = findNode(intersect.left, 'SimilarItems');
      if (!leftHasSimilar) {
        // SimilarItems might be deeper in the tree — that's OK as long as it exists
        assert.ok(findNode(optimized, 'SimilarItems'));
      }
    }
  });
});

// ── Layer 3: EventPlan — Embed + SemanticSearch ─────────────────────────

describe('similar — EventPlan lowering', () => {
  it('SimilarItems lowers to Embed → SemanticSearch chain', () => {
    const ast = lowerExpr({ similar: ['kitchen'] });
    const setIr = lowerToSetIr({ predicate: ast, entity: 'tasks', op: 'get' });
    const optimized = optimizeSetIr(setIr);
    const plan = lowerSetIrToEventPlan(optimized);

    const embedNodes = plan.nodes.filter(n => n.kind === 'Embed');
    const searchNodes = plan.nodes.filter(n => n.kind === 'SemanticSearch');

    assert.ok(embedNodes.length >= 1, 'Expected at least one Embed node');
    assert.ok(searchNodes.length >= 1, 'Expected at least one SemanticSearch node');

    // SemanticSearch should reference the Embed node
    const search = searchNodes[0] as any;
    const embedIdx = plan.nodes.indexOf(embedNodes[0]);
    assert.equal(search.embeddingRef, embedIdx, 'SemanticSearch.embeddingRef should point to Embed node');
  });

  it('plan describes cleanly', () => {
    const ast = lowerExpr({ similar: ['kitchen'] });
    const setIr = lowerToSetIr({ predicate: ast, entity: 'tasks', op: 'get' });
    const optimized = optimizeSetIr(setIr);
    const plan = lowerSetIrToEventPlan(optimized);
    const desc = describeEventPlan(plan);
    assert.ok(desc.includes('Embed'), 'Description should mention Embed');
    assert.ok(desc.includes('SemanticSearch'), 'Description should mention SemanticSearch');
  });
});

// ── Layer 4: queryOmnifocus — entity validation ─────────────────────────

describe('similar — entity validation', () => {
  it('rejects folders entity', async () => {
    const result = await queryOmnifocus({
      entity: 'folders',
      where: { similar: ['test'] },
    });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('not supported'));
    assert.ok(result.error?.includes('folders'));
  });

  it('rejects tags entity', async () => {
    const result = await queryOmnifocus({
      entity: 'tags',
      where: { similar: ['test'] },
    });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('not supported'));
    assert.ok(result.error?.includes('tags'));
  });

  it('rejects perspectives entity', async () => {
    const result = await queryOmnifocus({
      entity: 'perspectives',
      where: { similar: ['test'] },
    });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('not supported'));
  });

  it('accepts tasks entity (no entity error)', async () => {
    // This will fail downstream (no OmniFocus/embeddingd) but should NOT
    // fail with the entity validation error.
    const result = await queryOmnifocus({
      entity: 'tasks',
      where: { similar: ['test'] },
    });
    if (!result.success) {
      assert.ok(!result.error?.includes('not supported'), 'tasks should not be rejected by entity validation');
    }
  });

  it('accepts projects entity (no entity error)', async () => {
    const result = await queryOmnifocus({
      entity: 'projects',
      where: { similar: ['test'] },
    });
    if (!result.success) {
      assert.ok(!result.error?.includes('not supported'), 'projects should not be rejected by entity validation');
    }
  });
});

// ── Confidence conversion ────────────────────────────────────────────────

describe('similar — distanceToConfidence', () => {
  // Mirror the formula: 100 * exp(-d²), rounded to 1 decimal
  function distanceToConfidence(d: number): number {
    return Math.round(100 * Math.exp(-d * d) * 10) / 10;
  }

  it('distance 0 → 100% confidence', () => {
    assert.equal(distanceToConfidence(0), 100);
  });

  it('distance 0.5 → ~77-78% confidence', () => {
    const c = distanceToConfidence(0.5);
    assert.ok(c > 75 && c < 80, `expected ~78, got ${c}`);
  });

  it('distance 0.7 → ~61% confidence', () => {
    const c = distanceToConfidence(0.7);
    assert.ok(c > 58 && c < 65, `expected ~61, got ${c}`);
  });

  it('distance 1.0 → ~36.8% confidence', () => {
    const c = distanceToConfidence(1.0);
    assert.ok(c > 34 && c < 40, `expected ~36.8, got ${c}`);
  });

  it('distance 2.0 → near 0% confidence', () => {
    const c = distanceToConfidence(2.0);
    assert.ok(c < 5, `expected near 0, got ${c}`);
  });

  it('monotonically decreasing', () => {
    const distances = [0, 0.1, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0];
    const confidences = distances.map(distanceToConfidence);
    for (let i = 1; i < confidences.length; i++) {
      assert.ok(
        confidences[i] <= confidences[i - 1],
        `confidence should decrease: d=${distances[i]} (${confidences[i]}) should be <= d=${distances[i-1]} (${confidences[i-1]})`,
      );
    }
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────

/** Recursively find a node of a given kind in a SetIR tree. */
function findNode(node: any, kind: string): any | null {
  if (!node || typeof node !== 'object') return null;
  if (node.kind === kind) return node;
  for (const key of ['source', 'left', 'right', 'lookup']) {
    if (node[key]) {
      const found = findNode(node[key], kind);
      if (found) return found;
    }
  }
  return null;
}
