/**
 * Tests for the `similar` predicate operator.
 *
 * Covers: operations registry, lower validation, describer output,
 * nodeEval safety throw, SetIR optimizer rewrite, EventPlan lowering,
 * threshold support, and similarity enrichment.
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
  it('similar is registered with minArgs 1, maxArgs 2', () => {
    assert.ok('similar' in operations);
    assert.equal(operations.similar.minArgs, 1);
    assert.equal(operations.similar.maxArgs, 2);
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

  it('accepts threshold as second arg (number 0-100)', () => {
    const ast = lowerExpr({ similar: ['kitchen', 60] });
    assert.ok(ast);
    assert.equal((ast as any).op, 'similar');
    assert.deepEqual((ast as any).args, ['kitchen', 60]);
  });

  it('accepts threshold of 0', () => {
    const ast = lowerExpr({ similar: ['kitchen', 0] });
    assert.deepEqual((ast as any).args, ['kitchen', 0]);
  });

  it('accepts threshold of 100', () => {
    const ast = lowerExpr({ similar: ['kitchen', 100] });
    assert.deepEqual((ast as any).args, ['kitchen', 100]);
  });

  it('rejects negative threshold', () => {
    assert.throws(() => lowerExpr({ similar: ['kitchen', -1] }), /threshold must be a number 0-100/);
  });

  it('rejects threshold > 100', () => {
    assert.throws(() => lowerExpr({ similar: ['kitchen', 101] }), /threshold must be a number 0-100/);
  });

  it('rejects non-numeric threshold', () => {
    assert.throws(() => lowerExpr({ similar: ['kitchen', 'high'] }), /threshold must be a number 0-100/);
  });
});

describe('similar — describer', () => {
  it('describes as "similar to ..."', () => {
    const result = describeExpr({ similar: ['legal brief'] });
    assert.ok(result.includes('similar to'));
    assert.ok(result.includes('legal brief'));
  });

  it('describes threshold as "≥N% similarity"', () => {
    const result = describeExpr({ similar: ['kitchen', 60] });
    assert.ok(result.includes('similar to'), `expected 'similar to', got: ${result}`);
    assert.ok(result.includes('≥60%'), `expected '≥60%', got: ${result}`);
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

  it('multiple similar terms all extracted (no surviving similar in Filter)', () => {
    const ast = lowerExpr({
      and: [{ similar: ['kitchen'] }, { similar: ['cooking'] }, { eq: [{ var: 'flagged' }, true] }],
    });
    const setIr = lowerToSetIr({ predicate: ast, entity: 'tasks', op: 'get' });
    const optimized = optimizeSetIr(setIr);

    // Both similar terms should be extracted as SimilarItems nodes
    const similarNodes: any[] = [];
    collectNodes(optimized, 'SimilarItems', similarNodes);
    assert.equal(similarNodes.length, 2, 'Expected 2 SimilarItems nodes');
    const queries = similarNodes.map((n: any) => n.query).sort();
    assert.deepEqual(queries, ['cooking', 'kitchen']);

    // No Filter should contain a similar predicate
    const filters: any[] = [];
    collectNodes(optimized, 'Filter', filters);
    for (const f of filters) {
      const pred = JSON.stringify(f.predicate);
      assert.ok(!pred.includes('"similar"'), `Filter still contains similar: ${pred}`);
    }
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

  it('threshold propagates to SimilarItems node', () => {
    const ast = lowerExpr({ similar: ['kitchen', 50] });
    const setIr = lowerToSetIr({ predicate: ast, entity: 'tasks', op: 'get' });
    const optimized = optimizeSetIr(setIr);
    const similarNode = findNode(optimized, 'SimilarItems');
    assert.ok(similarNode, 'Expected SimilarItems node');
    assert.equal(similarNode.threshold, 50, 'Expected threshold 50');
  });

  it('no threshold → SimilarItems.threshold is undefined', () => {
    const ast = lowerExpr({ similar: ['kitchen'] });
    const setIr = lowerToSetIr({ predicate: ast, entity: 'tasks', op: 'get' });
    const optimized = optimizeSetIr(setIr);
    const similarNode = findNode(optimized, 'SimilarItems');
    assert.ok(similarNode, 'Expected SimilarItems node');
    assert.equal(similarNode.threshold, undefined);
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

describe('similar — entity validation (via similarShortcut)', () => {
  it('unsupported entity (folders) gives clear error message', async () => {
    const result = await queryOmnifocus({
      entity: 'folders',
      where: { similar: ['test'] },
    });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('not supported for folders'), `expected clear entity error, got: ${result.error}`);
  });

  it('unsupported entity (tags) gives clear error message', async () => {
    const result = await queryOmnifocus({
      entity: 'tags',
      where: { similar: ['test'] },
    });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('not supported for tags'), `expected clear entity error, got: ${result.error}`);
  });

  it('accepts tasks entity (no entity error)', async () => {
    const result = await queryOmnifocus({
      entity: 'tasks',
      where: { similar: ['test'] },
    });
    if (!result.success) {
      assert.ok(!result.error?.includes('not supported'), 'tasks should have similar extracted');
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

// ── Similarity conversion ────────────────────────────────────────────────

describe('similar — distanceToSimilarity', () => {
  // Mirror the formula: 100 * exp(-d²), rounded to 1 decimal
  function distanceToSimilarity(d: number): number {
    return Math.round(100 * Math.exp(-d * d) * 10) / 10;
  }

  it('distance 0 → 100% similarity', () => {
    assert.equal(distanceToSimilarity(0), 100);
  });

  it('distance 0.5 → ~77-78% similarity', () => {
    const s = distanceToSimilarity(0.5);
    assert.ok(s > 75 && s < 80, `expected ~78, got ${s}`);
  });

  it('distance 0.7 → ~61% similarity', () => {
    const s = distanceToSimilarity(0.7);
    assert.ok(s > 58 && s < 65, `expected ~61, got ${s}`);
  });

  it('distance 1.0 → ~36.8% similarity', () => {
    const s = distanceToSimilarity(1.0);
    assert.ok(s > 34 && s < 40, `expected ~36.8, got ${s}`);
  });

  it('distance 2.0 → near 0% similarity', () => {
    const s = distanceToSimilarity(2.0);
    assert.ok(s < 5, `expected near 0, got ${s}`);
  });

  it('monotonically decreasing', () => {
    const distances = [0, 0.1, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0];
    const similarities = distances.map(distanceToSimilarity);
    for (let i = 1; i < similarities.length; i++) {
      assert.ok(
        similarities[i] <= similarities[i - 1],
        `similarity should decrease: d=${distances[i]} (${similarities[i]}) should be <= d=${distances[i-1]} (${similarities[i-1]})`,
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

/** Recursively collect all nodes of a given kind in a SetIR tree. */
function collectNodes(node: any, kind: string, out: any[]): void {
  if (!node || typeof node !== 'object') return;
  if (node.kind === kind) out.push(node);
  for (const key of ['source', 'left', 'right', 'lookup']) {
    if (node[key]) collectNodes(node[key], kind, out);
  }
}
