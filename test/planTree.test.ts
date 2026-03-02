import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lowerExpr } from '../dist/tools/query/lower.js';
import { buildPlanTree } from '../dist/tools/query/planner.js';
import { optimize, walkPlan, planPathLabel } from '../dist/tools/query/planTree.js';
import { tagSemiJoinPass, extractTagPredicates } from '../dist/tools/query/optimizations/tagSemiJoin.js';
import { normalizePass } from '../dist/tools/query/optimizations/normalize.js';
import { crossEntityJoinPass } from '../dist/tools/query/optimizations/crossEntityJoin.js';
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

  it('tags (chain) → Filter(BulkScan) — no two-phase', () => {
    const tree = plan({ contains: [{ var: 'tags' }, 'waiting'] });
    assert.equal(tree.kind, 'Filter');
    if (tree.kind !== 'Filter') return;
    assert.equal(tree.source.kind, 'BulkScan');
  });

  it('status (computed) → Filter(BulkScan) with computedVars', () => {
    const tree = plan({ eq: [{ var: 'status' }, 'Available'] });
    assert.equal(tree.kind, 'Filter');
    if (tree.kind !== 'Filter') return;
    assert.equal(tree.source.kind, 'BulkScan');
    if (tree.source.kind !== 'BulkScan') return;
    assert.ok(tree.source.computedVars?.has('status'));
  });

  it('two-phase: projects.folderName (per-item) → Filter(PerItemEnrich(PreFilter(BulkScan)))', () => {
    const tree = plan({ contains: [{ var: 'folderName' }, 'Legal'] }, 'projects');
    assert.equal(tree.kind, 'Filter');
    if (tree.kind !== 'Filter') return;
    assert.equal(tree.source.kind, 'PerItemEnrich');
    if (tree.source.kind !== 'PerItemEnrich') return;
    assert.equal(tree.source.source.kind, 'PreFilter');
    if (tree.source.source.kind !== 'PreFilter') return;
    assert.equal(tree.source.source.source.kind, 'BulkScan');
  });

  it('two-phase: BulkScan includes id in columns', () => {
    const tree = plan({ contains: [{ var: 'folderName' }, 'Legal'] }, 'projects');
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('id'), 'columns should include id');
  });

  it('two-phase: PerItemEnrich has fallback to OmniJSScan', () => {
    const tree = plan({ contains: [{ var: 'folderName' }, 'Legal'] }, 'projects');
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

  it('tags (chain) in columns, not PerItemEnrich', () => {
    const tree = plan({ contains: [{ var: 'tags' }, 'work'] });
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('tags'));
    assert.equal(findNode(tree, 'PerItemEnrich'), null);
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

  it('tags plan (now chain) → broad', () => {
    assert.equal(
      planPathLabel(plan({ contains: [{ var: 'tags' }, 'x'] })),
      'broad'
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
  // tagSemiJoinPass matches Filter→PerItemEnrich→PreFilter→BulkScan.
  // After reclassification, tags is chain → no PerItemEnrich for tasks.
  // The pass is a no-op until rewritten to use ByIdEnrich.

  it('tags (chain) → no SemiJoin rewrite (no PerItemEnrich shape)', () => {
    const tree = plan({ contains: [{ var: 'tags' }, 'waiting'] });
    const rewritten = tagSemiJoinPass(tree);
    assert.equal(findNode(rewritten, 'SemiJoin'), null);
  });

  it('does NOT rewrite for non-tasks entity', () => {
    const tree = plan({ contains: [{ var: 'folderName' }, 'Legal'] }, 'projects');
    const rewritten = tagSemiJoinPass(tree);
    assert.equal(findNode(rewritten, 'SemiJoin'), null);
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
  it('tag query (chain) → broad after optimization', () => {
    const tree = plan({ contains: [{ var: 'tags' }, 'waiting'] });
    const rewritten = optimize(tree, [tagSemiJoinPass, normalizePass]);
    assert.equal(planPathLabel(rewritten), 'broad');
  });
});

// ── Self-Join Elimination Pass ───────────────────────────────────────────

import { selfJoinEliminationPass } from '../dist/tools/query/optimizations/selfJoinElimination.js';

describe('selfJoinEliminationPass', () => {
  it('rewrites tags.parentName CrossEntityJoin → SelfJoinEnrich', () => {
    const tree = plan(undefined, 'tags', ['name', 'parentName']);
    const withCEJ = crossEntityJoinPass(tree);
    assert.ok(findNode(withCEJ, 'CrossEntityJoin'), 'should have CrossEntityJoin before');

    const rewritten = selfJoinEliminationPass(withCEJ);
    assert.ok(findNode(rewritten, 'SelfJoinEnrich'), 'should have SelfJoinEnrich');
    assert.equal(findNode(rewritten, 'CrossEntityJoin'), null, 'CrossEntityJoin should be gone');
  });

  it('does NOT rewrite cross-entity joins (projects.folderName)', () => {
    const tree = plan(undefined, 'projects', ['name', 'folderName']);
    const withCEJ = crossEntityJoinPass(tree);
    assert.ok(findNode(withCEJ, 'CrossEntityJoin'), 'should have CrossEntityJoin');

    const rewritten = selfJoinEliminationPass(withCEJ);
    assert.ok(findNode(rewritten, 'CrossEntityJoin'), 'CrossEntityJoin should remain');
    assert.equal(findNode(rewritten, 'SelfJoinEnrich'), null, 'should NOT have SelfJoinEnrich');
  });

  it('SelfJoinEnrich has correct sourceKey/lookupKey/fieldMap', () => {
    const tree = plan(undefined, 'tags', ['name', 'parentName']);
    const withCEJ = crossEntityJoinPass(tree);
    const rewritten = selfJoinEliminationPass(withCEJ);
    const sje = findNode(rewritten, 'SelfJoinEnrich');
    assert.ok(sje && sje.kind === 'SelfJoinEnrich');
    assert.equal(sje.sourceKey, 'parentId');
    assert.equal(sje.lookupKey, 'id');
    assert.deepEqual(sje.fieldMap, { name: 'parentName' });
    assert.equal(sje.aggregation, null);
  });

  it('ensures only one BulkScan remains (no redundant lookup)', () => {
    const tree = plan(undefined, 'tags', ['name', 'parentName']);
    const withCEJ = crossEntityJoinPass(tree);
    const rewritten = selfJoinEliminationPass(withCEJ);
    const scanCount = countNodes(rewritten, 'BulkScan');
    assert.equal(scanCount, 1, 'should have exactly 1 BulkScan');
  });

  it('preserves plan path label after rewrite', () => {
    const tree = plan(undefined, 'tags', ['name', 'parentName']);
    const rewritten = optimize(tree, [crossEntityJoinPass, selfJoinEliminationPass, normalizePass]);
    assert.equal(planPathLabel(rewritten), 'broad');
  });
});

// ── Cross-Entity Join Pass ───────────────────────────────────────────────

describe('crossEntityJoinPass', () => {
  it('rewrites projects.folderName → CrossEntityJoin', () => {
    // projects with select: [name, status, folderName]
    // folderName is per-item, triggers two-phase → PerItemEnrich
    const tree = plan(undefined, 'projects', ['name', 'status', 'folderName']);
    assert.ok(findNode(tree, 'PerItemEnrich'), 'original should have PerItemEnrich');

    const rewritten = crossEntityJoinPass(tree);
    const cej = findNode(rewritten, 'CrossEntityJoin');
    assert.ok(cej, 'should have CrossEntityJoin');
    assert.ok(cej!.kind === 'CrossEntityJoin');
    assert.equal(cej!.sourceKey, 'folderId');
    assert.equal(cej!.lookupKey, 'id');
    assert.deepEqual(cej!.fieldMap, { name: 'folderName' });
  });

  it('removes PerItemEnrich when all vars resolved by join', () => {
    const tree = plan(undefined, 'projects', ['name', 'folderName']);
    const rewritten = optimize(tree, [crossEntityJoinPass, normalizePass]);
    assert.equal(findNode(rewritten, 'PerItemEnrich'), null, 'PerItemEnrich should be gone');
    assert.ok(findNode(rewritten, 'CrossEntityJoin'), 'should have CrossEntityJoin');
  });

  it('ensures folderId column added to BulkScan for projects.folderName', () => {
    const tree = plan(undefined, 'projects', ['name', 'folderName']);
    const rewritten = crossEntityJoinPass(tree);
    const scan = findNode(rewritten, 'BulkScan');
    // There should be at least one BulkScan with folderId
    let found = false;
    walkPlan(rewritten, n => {
      if (n.kind === 'BulkScan' && n.entity === 'projects' && n.columns.includes('folderId')) {
        found = true;
      }
      return n;
    });
    assert.ok(found, 'projects BulkScan should include folderId column');
  });

  it('rewrites folders.projectCount → CrossEntityJoin with count aggregation', () => {
    const tree = plan(undefined, 'folders', ['name', 'projectCount']);
    assert.ok(findNode(tree, 'PerItemEnrich'), 'original should have PerItemEnrich');

    const rewritten = crossEntityJoinPass(tree);
    const cej = findNode(rewritten, 'CrossEntityJoin');
    assert.ok(cej, 'should have CrossEntityJoin');
    assert.ok(cej!.kind === 'CrossEntityJoin');
    assert.equal(cej!.lookupKey, 'folderId');
    assert.deepEqual(cej!.fieldMap, { '*': 'projectCount' });
  });

  it('rewrites tags.parentName → CrossEntityJoin self-join', () => {
    const tree = plan(undefined, 'tags', ['name', 'parentName', 'availableTaskCount']);
    assert.ok(findNode(tree, 'PerItemEnrich'), 'original should have PerItemEnrich');

    const rewritten = crossEntityJoinPass(tree);
    const cej = findNode(rewritten, 'CrossEntityJoin');
    assert.ok(cej, 'should have CrossEntityJoin');
    assert.ok(cej!.kind === 'CrossEntityJoin');
    assert.equal(cej!.sourceKey, 'parentId');
    assert.equal(cej!.lookupKey, 'id');
    assert.deepEqual(cej!.fieldMap, { name: 'parentName' });
  });

  it('keeps PerItemEnrich for remaining non-resolvable per-item vars', () => {
    // projects with folderName (resolvable) + note (expensive, not resolvable)
    const tree = plan(undefined, 'projects', ['name', 'folderName', 'note']);
    const rewritten = crossEntityJoinPass(tree);
    assert.ok(findNode(rewritten, 'CrossEntityJoin'), 'should have CrossEntityJoin');
    const enrich = findNode(rewritten, 'PerItemEnrich');
    assert.ok(enrich && enrich.kind === 'PerItemEnrich', 'should still have PerItemEnrich');
    assert.ok(!enrich.perItemVars.has('folderName'), 'folderName should be removed');
    assert.ok(enrich.perItemVars.has('note'), 'note should remain');
  });

  it('does not rewrite tasks entity (no joins registered)', () => {
    // Tasks with easy/computed vars — no cross-entity join available
    const tree = plan({ eq: [{ var: 'flagged' }, true] }, 'tasks');
    const rewritten = crossEntityJoinPass(tree);
    assert.equal(findNode(rewritten, 'CrossEntityJoin'), null, 'should NOT have CrossEntityJoin');
  });

  it('lookup BulkScan for folders includes id and name', () => {
    const tree = plan(undefined, 'projects', ['name', 'folderName']);
    const rewritten = crossEntityJoinPass(tree);
    // Find the folders BulkScan (the lookup)
    let folderScan: PlanNode | null = null;
    walkPlan(rewritten, n => {
      if (n.kind === 'BulkScan' && n.entity === 'folders') folderScan = n;
      return n;
    });
    assert.ok(folderScan && folderScan.kind === 'BulkScan');
    assert.ok(folderScan.columns.includes('id'), 'should read id');
    assert.ok(folderScan.columns.includes('name'), 'should read name');
  });

  it('path label changes from two-phase to broad after rewrite', () => {
    const tree = plan(undefined, 'projects', ['name', 'status', 'folderName']);
    assert.equal(planPathLabel(tree), 'two-phase');
    const rewritten = optimize(tree, [crossEntityJoinPass, normalizePass]);
    assert.equal(planPathLabel(rewritten), 'broad');
  });
});
