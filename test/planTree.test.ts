import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lowerExpr } from '../dist/tools/query/lower.js';
import { buildPlanTree } from '../dist/tools/query/planner.js';
import { optimize, walkPlan, planPathLabel } from '../dist/tools/query/planTree.js';
import { tagSemiJoinPass, extractTagPredicates } from '../dist/tools/query/optimizations/tagSemiJoin.js';
import { normalizePass } from '../dist/tools/query/optimizations/normalize.js';
import type { LoweredExpr } from '../dist/tools/query/fold.js';
import type { PlanNode } from '../dist/tools/query/planTree.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function lower(where: unknown): LoweredExpr {
  return (where != null ? lowerExpr(where) : true) as LoweredExpr;
}

function plan(where: unknown, entity: string = 'tasks', select?: string[]) {
  const ast = lower(where);
  return buildPlanTree(ast, entity as any, select, false);
}

/** Find the innermost node of a given kind */
function findNode(tree: PlanNode, kind: string): PlanNode | null {
  let found: PlanNode | null = null;
  walkPlan(tree, n => {
    if (n.kind === kind) found = n;
    return n;
  });
  return found;
}

/** Count nodes of a given kind */
function countNodes(tree: PlanNode, kind: string): number {
  let count = 0;
  walkPlan(tree, n => {
    if (n.kind === kind) count++;
    return n;
  });
  return count;
}

// ── Tree Construction ────────────────────────────────────────────────────

describe('buildPlanTree — tree shapes', () => {
  it('broad: easy vars only → BulkScan with Filter', () => {
    const tree = plan({ eq: [{ var: 'flagged' }, true] });
    assert.equal(tree.kind, 'Filter');
    if (tree.kind !== 'Filter') return;
    assert.equal(tree.source.kind, 'BulkScan');
  });

  it('broad: no where → bare BulkScan', () => {
    const tree = plan(undefined);
    assert.equal(tree.kind, 'BulkScan');
  });

  it('project-scoped: top-level project container → BulkScan with projectScope', () => {
    const tree = plan({ container: ['project', { contains: [{ var: 'name' }, 'PHS'] }] });
    // Should be a bare BulkScan (remainder is true, no filter needed)
    assert.equal(tree.kind, 'BulkScan');
    if (tree.kind !== 'BulkScan') return;
    assert.ok(tree.projectScope, 'should have projectScope');
  });

  it('project-scoped with remainder → Filter(BulkScan(projectScope))', () => {
    const tree = plan({
      and: [
        { container: ['project', { eq: [{ var: 'name' }, 'PHS'] }] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    assert.equal(tree.kind, 'Filter');
    if (tree.kind !== 'Filter') return;
    assert.equal(tree.source.kind, 'BulkScan');
    if (tree.source.kind !== 'BulkScan') return;
    assert.ok(tree.source.projectScope, 'should have projectScope');
  });

  it('two-phase: per-item vars → Filter(PerItemEnrich(PreFilter(BulkScan)))', () => {
    const tree = plan({ contains: [{ var: 'tags' }, 'waiting'] });
    assert.equal(tree.kind, 'Filter');
    if (tree.kind !== 'Filter') return;
    assert.equal(tree.source.kind, 'PerItemEnrich');
    if (tree.source.kind !== 'PerItemEnrich') return;
    assert.equal(tree.source.source.kind, 'PreFilter');
    if (tree.source.source.kind !== 'PreFilter') return;
    assert.equal(tree.source.source.source.kind, 'BulkScan');
  });

  it('two-phase: BulkScan includes id in columns', () => {
    const tree = plan({ contains: [{ var: 'tags' }, 'waiting'] });
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('id'), 'columns should include id');
  });

  it('two-phase: PerItemEnrich has fallback to OmniJSScan', () => {
    const tree = plan({ contains: [{ var: 'tags' }, 'waiting'] });
    const enrich = findNode(tree, 'PerItemEnrich');
    assert.ok(enrich && enrich.kind === 'PerItemEnrich');
    assert.equal(enrich.fallback.kind, 'OmniJSScan');
  });

  it('OmniJS fallback: perspectives → OmniJSScan', () => {
    const tree = plan(undefined, 'perspectives');
    assert.equal(tree.kind, 'OmniJSScan');
  });

  it('OmniJS fallback: expensive var (note) in where → OmniJSScan', () => {
    const tree = plan({ contains: [{ var: 'note' }, 'important'] });
    assert.equal(tree.kind, 'OmniJSScan');
  });

  it('OmniJS fallback: folder container → OmniJSScan', () => {
    const tree = plan({ container: ['folder', { eq: [{ var: 'name' }, 'Legal'] }] });
    assert.equal(tree.kind, 'OmniJSScan');
  });

  it('OmniJS fallback: tags entity with container → OmniJSScan', () => {
    const tree = plan(
      { container: ['tag', { contains: [{ var: 'name' }, 'Work'] }] },
      'tags'
    );
    assert.equal(tree.kind, 'OmniJSScan');
  });
});

describe('buildPlanTree — columns and vars', () => {
  it('includes easy vars from where + select in columns', () => {
    const tree = plan(
      { eq: [{ var: 'flagged' }, true] },
      'tasks',
      ['name', 'dueDate']
    );
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('flagged'));
    assert.ok(scan.columns.includes('name'));
    assert.ok(scan.columns.includes('dueDate'));
  });

  it('includes chain vars (projectName) in columns', () => {
    const tree = plan(
      { contains: [{ var: 'projectName' }, 'PHS'] },
      'tasks',
      ['name', 'projectName']
    );
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('projectName'));
  });

  it('per-item vars go to PerItemEnrich, not BulkScan columns', () => {
    const tree = plan({ contains: [{ var: 'tags' }, 'work'] });
    const enrich = findNode(tree, 'PerItemEnrich');
    assert.ok(enrich && enrich.kind === 'PerItemEnrich');
    assert.ok(enrich.perItemVars.has('tags'));
  });

  it('expensive var in select → PerItemEnrich (not fallback)', () => {
    const tree = plan(
      { contains: [{ var: 'name' }, 'review'] },
      'tasks',
      ['name', 'note']
    );
    const enrich = findNode(tree, 'PerItemEnrich');
    assert.ok(enrich && enrich.kind === 'PerItemEnrich');
    assert.ok(enrich.perItemVars.has('note'));
  });
});

describe('buildPlanTree — includeCompleted propagation', () => {
  it('propagates includeCompleted to BulkScan', () => {
    const ast = lower(undefined);
    const tree = buildPlanTree(ast, 'tasks', undefined, true);
    assert.ok(tree.kind === 'BulkScan');
    assert.equal(tree.includeCompleted, true);
  });

  it('propagates includeCompleted to OmniJSScan fallback', () => {
    const ast = lower({ contains: [{ var: 'note' }, 'test'] });
    const tree = buildPlanTree(ast, 'tasks', undefined, true);
    assert.ok(tree.kind === 'OmniJSScan');
    assert.equal(tree.includeCompleted, true);
  });
});

// ── planPathLabel ────────────────────────────────────────────────────────

describe('planPathLabel', () => {
  it('bare BulkScan → broad', () => {
    assert.equal(planPathLabel(plan(undefined)), 'broad');
  });

  it('BulkScan with projectScope → project-scoped', () => {
    assert.equal(
      planPathLabel(plan({ container: ['project', { eq: [{ var: 'name' }, 'X'] }] })),
      'project-scoped'
    );
  });

  it('two-phase plan → two-phase', () => {
    assert.equal(
      planPathLabel(plan({ contains: [{ var: 'tags' }, 'x'] })),
      'two-phase'
    );
  });

  it('OmniJS fallback → omnijs-fallback', () => {
    assert.equal(planPathLabel(plan(undefined, 'perspectives')), 'omnijs-fallback');
  });
});

// ── extractTagPredicates ────────────────────────────────────────────────

describe('extractTagPredicates', () => {
  it('single contains(tags, literal) → extracts tag name', () => {
    const ast = lower({ contains: [{ var: 'tags' }, 'waiting'] });
    const result = extractTagPredicates(ast);
    assert.deepEqual(result.tagNames, ['waiting']);
    assert.equal(result.remainder, null);
  });

  it('AND with tag contains + other → extracts tag, keeps remainder', () => {
    const ast = lower({
      and: [
        { contains: [{ var: 'tags' }, 'waiting'] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    const result = extractTagPredicates(ast);
    assert.deepEqual(result.tagNames, ['waiting']);
    assert.ok(result.remainder !== null);
    // remainder should be the flagged eq
    const rem = result.remainder as { op: string };
    assert.equal(rem.op, 'eq');
  });

  it('multiple tag contains in AND → extracts all', () => {
    const ast = lower({
      and: [
        { contains: [{ var: 'tags' }, 'a'] },
        { contains: [{ var: 'tags' }, 'b'] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    const result = extractTagPredicates(ast);
    assert.deepEqual(result.tagNames, ['a', 'b']);
    assert.ok(result.remainder !== null);
  });

  it('tag under OR → no extraction', () => {
    const ast = lower({
      or: [
        { contains: [{ var: 'tags' }, 'waiting'] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    const result = extractTagPredicates(ast);
    assert.deepEqual(result.tagNames, []);
  });

  it('tag under NOT → no extraction', () => {
    const ast = lower({ not: [{ contains: [{ var: 'tags' }, 'waiting'] }] });
    const result = extractTagPredicates(ast);
    assert.deepEqual(result.tagNames, []);
  });

  it('non-literal tag value → no extraction', () => {
    const ast = lower({ contains: [{ var: 'tags' }, { var: 'name' }] });
    const result = extractTagPredicates(ast);
    assert.deepEqual(result.tagNames, []);
  });

  it('case normalizes tag names to lowercase', () => {
    const ast = lower({ contains: [{ var: 'tags' }, 'Waiting'] });
    const result = extractTagPredicates(ast);
    assert.deepEqual(result.tagNames, ['waiting']);
  });
});

// ── Tag Semi-Join Rewrite ────────────────────────────────────────────────

describe('tagSemiJoinPass', () => {
  it('rewrites contains(tags, literal) → SemiJoin', () => {
    const tree = plan({ contains: [{ var: 'tags' }, 'waiting'] });
    const rewritten = tagSemiJoinPass(tree);

    // Should find a SemiJoin
    const sj = findNode(rewritten, 'SemiJoin');
    assert.ok(sj, 'should have SemiJoin');

    // Should find a MembershipScan
    const tms = findNode(rewritten, 'MembershipScan');
    assert.ok(tms, 'should have MembershipScan');
  });

  it('multi-tag AND → chained SemiJoins', () => {
    const tree = plan({
      and: [
        { contains: [{ var: 'tags' }, 'a'] },
        { contains: [{ var: 'tags' }, 'b'] },
      ]
    });
    const rewritten = tagSemiJoinPass(tree);
    const sjCount = countNodes(rewritten, 'SemiJoin');
    assert.equal(sjCount, 2, 'should have 2 SemiJoins');
  });

  it('tag + non-tag conjuncts → SemiJoin + Filter', () => {
    const tree = plan({
      and: [
        { contains: [{ var: 'tags' }, 'waiting'] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    const rewritten = tagSemiJoinPass(tree);
    assert.ok(findNode(rewritten, 'SemiJoin'), 'should have SemiJoin');
    assert.ok(findNode(rewritten, 'Filter'), 'should have Filter for remainder');
  });

  it('does NOT rewrite tags under OR', () => {
    const tree = plan({
      or: [
        { contains: [{ var: 'tags' }, 'waiting'] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    });
    // This will be two-phase (tags is per-item) but OR prevents extraction
    const rewritten = tagSemiJoinPass(tree);
    assert.equal(findNode(rewritten, 'SemiJoin'), null, 'should NOT have SemiJoin');
  });

  it('does NOT rewrite tags under NOT', () => {
    const tree = plan({
      not: [{ contains: [{ var: 'tags' }, 'waiting'] }]
    });
    const rewritten = tagSemiJoinPass(tree);
    assert.equal(findNode(rewritten, 'SemiJoin'), null, 'should NOT have SemiJoin');
  });

  it('does NOT rewrite for non-tasks entity', () => {
    // projects entity — tags doesn't exist there, this would be an error
    // Use a valid two-phase scenario on projects: folderName (per-item)
    const tree = plan({ contains: [{ var: 'folderName' }, 'Legal'] }, 'projects');
    const rewritten = tagSemiJoinPass(tree);
    assert.equal(findNode(rewritten, 'SemiJoin'), null, 'should NOT have SemiJoin');
  });

  it('preserves BulkScan id column after rewrite', () => {
    const tree = plan({ contains: [{ var: 'tags' }, 'waiting'] });
    const rewritten = tagSemiJoinPass(tree);
    const scan = findNode(rewritten, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('id'), 'BulkScan should include id');
  });

  it('tag + other per-item var → SemiJoin with PerItemEnrich for remaining', () => {
    // tags (per-item, rewritten) + status (per-item, kept)
    const tree = plan({
      and: [
        { contains: [{ var: 'tags' }, 'waiting'] },
        { eq: [{ var: 'status' }, 'Available'] }
      ]
    });
    const rewritten = optimize(tree, [tagSemiJoinPass, normalizePass]);
    assert.ok(findNode(rewritten, 'SemiJoin'), 'should have SemiJoin');
    const enrich = findNode(rewritten, 'PerItemEnrich');
    assert.ok(enrich && enrich.kind === 'PerItemEnrich', 'should have PerItemEnrich');
    assert.ok(!enrich.perItemVars.has('tags'), 'tags should be removed from perItemVars');
    assert.ok(enrich.perItemVars.has('status'), 'status should remain in perItemVars');
  });

  it('tags as only per-item var → no PerItemEnrich after rewrite + normalize', () => {
    const tree = plan({ contains: [{ var: 'tags' }, 'waiting'] });
    const rewritten = optimize(tree, [tagSemiJoinPass, normalizePass]);
    assert.equal(findNode(rewritten, 'PerItemEnrich'), null, 'PerItemEnrich should be eliminated');
  });

  it('tags in select only (not where) → no rewrite (no two-phase shape)', () => {
    // Only easy vars in where, tags in select triggers two-phase
    // But the PreFilter won't have tags in assumeTrue since it's select-only
    const tree = plan(
      { eq: [{ var: 'flagged' }, true] },
      'tasks',
      ['name', 'tags']
    );
    // Two-phase shape: Filter → PerItemEnrich → PreFilter → BulkScan
    // But the predicate doesn't contain tags, so extractTagPredicates finds nothing
    const rewritten = tagSemiJoinPass(tree);
    assert.equal(findNode(rewritten, 'SemiJoin'), null, 'should NOT rewrite select-only tags');
  });
});

// ── Normalize Pass ──────────────────────────────────────────────────────

describe('normalizePass', () => {
  it('drops empty PerItemEnrich', () => {
    // Manually build a tree with empty perItemVars
    const tree: PlanNode = {
      kind: 'PerItemEnrich',
      source: { kind: 'BulkScan', entity: 'tasks', columns: ['name'], includeCompleted: false },
      perItemVars: new Set(),
      entity: 'tasks',
      threshold: 20,
      fallback: { kind: 'OmniJSScan', entity: 'tasks', filterAst: true, includeCompleted: false },
    };
    const result = normalizePass(tree);
    assert.equal(result.kind, 'BulkScan');
  });

  it('removes PreFilter with no assumeTrue vars', () => {
    const tree: PlanNode = {
      kind: 'PreFilter',
      source: { kind: 'BulkScan', entity: 'tasks', columns: ['name'], includeCompleted: false },
      predicate: { op: 'eq', args: [{ var: 'flagged' }, true] },
      entity: 'tasks',
      assumeTrue: new Set(),
    };
    const result = normalizePass(tree);
    // Should convert to Filter
    assert.equal(result.kind, 'Filter');
  });

  it('merges adjacent Filters', () => {
    const tree: PlanNode = {
      kind: 'Filter',
      source: {
        kind: 'Filter',
        source: { kind: 'BulkScan', entity: 'tasks', columns: ['name', 'flagged'], includeCompleted: false },
        predicate: { op: 'eq', args: [{ var: 'flagged' }, true] },
        entity: 'tasks',
      },
      predicate: { op: 'contains', args: [{ var: 'name' }, 'test'] },
      entity: 'tasks',
    };
    const result = normalizePass(tree);
    assert.equal(result.kind, 'Filter');
    if (result.kind !== 'Filter') return;
    assert.equal(result.source.kind, 'BulkScan', 'inner Filter should be merged');
    // Predicate should be and(pred1, pred2)
    const pred = result.predicate as { op: string };
    assert.equal(pred.op, 'and');
  });
});

// ── walkPlan ────────────────────────────────────────────────────────────

describe('walkPlan', () => {
  it('visits all nodes bottom-up', () => {
    const tree = plan({ eq: [{ var: 'flagged' }, true] });
    const visited: string[] = [];
    walkPlan(tree, n => {
      visited.push(n.kind);
      return n;
    });
    // BulkScan visited first (bottom), then Filter
    assert.deepEqual(visited, ['BulkScan', 'Filter']);
  });

  it('can transform nodes', () => {
    const tree: PlanNode = {
      kind: 'Limit',
      source: { kind: 'BulkScan', entity: 'tasks', columns: ['name'], includeCompleted: false },
      count: 10,
    };
    const result = walkPlan(tree, n => {
      if (n.kind === 'Limit') return { ...n, count: 20 };
      return n;
    });
    assert.ok(result.kind === 'Limit');
    assert.equal(result.count, 20);
  });
});

// ── planPathLabel after optimization ────────────────────────────────────

describe('planPathLabel after optimization', () => {
  it('tag semi-join → semijoin', () => {
    const tree = plan({ contains: [{ var: 'tags' }, 'waiting'] });
    const rewritten = optimize(tree, [tagSemiJoinPass, normalizePass]);
    assert.equal(planPathLabel(rewritten), 'semijoin');
  });
});
