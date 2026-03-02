import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanTree, extractContainerScope } from '../dist/tools/query/planner.js';
import { lowerExpr } from '../dist/tools/query/lower.js';
import { planPathLabel, walkPlan } from '../dist/tools/query/planTree.js';
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

function findNode(tree: PlanNode, kind: string): PlanNode | null {
  let found: PlanNode | null = null;
  walkPlan(tree, n => {
    if (n.kind === kind) found = n;
    return n;
  });
  return found;
}

// ── Path selection ──────────────────────────────────────────────────────

describe('planner — path selection', () => {
  it('projects entity with easy vars → broad', () => {
    const tree = plan({ contains: [{ var: 'name' }, 'test'] }, 'projects');
    assert.equal(planPathLabel(tree), 'broad');
  });

  it('projects entity with chain var (folderId) → broad', () => {
    const tree = plan({ eq: [{ var: 'folderId' }, 'abc123'] }, 'projects');
    assert.equal(planPathLabel(tree), 'broad');
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('folderId'));
  });

  it('projects entity with per-item var (folderName) → two-phase', () => {
    const tree = plan({ contains: [{ var: 'folderName' }, 'Legal'] }, 'projects');
    assert.equal(planPathLabel(tree), 'two-phase');
    const enrich = findNode(tree, 'PerItemEnrich');
    assert.ok(enrich && enrich.kind === 'PerItemEnrich');
    assert.ok(enrich.perItemVars.has('folderName'));
  });

  it('projects entity with folder container → omnijs-fallback', () => {
    const tree = plan(
      { container: ['folder', { contains: [{ var: 'name' }, 'Legal'] }] },
      'projects'
    );
    assert.equal(planPathLabel(tree), 'omnijs-fallback');
  });

  it('folders entity with easy vars → broad', () => {
    const tree = plan({ contains: [{ var: 'name' }, 'Legal'] }, 'folders');
    assert.equal(planPathLabel(tree), 'broad');
  });

  it('folders entity with computed var (status) → broad (not two-phase)', () => {
    const tree = plan({ eq: [{ var: 'status' }, 'Active'] }, 'folders');
    assert.equal(planPathLabel(tree), 'broad');
    // Should have computedVars on BulkScan
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.computedVars?.has('status'));
    // Should have 'hidden' dependency in columns
    assert.ok(scan.columns.includes('hidden'));
  });

  it('folders entity with chain var (parentFolderId) → broad', () => {
    const tree = plan({ eq: [{ var: 'parentFolderId' }, 'abc123'] }, 'folders');
    assert.equal(planPathLabel(tree), 'broad');
  });

  it('folder container at any depth → omnijs-fallback', () => {
    const tree = plan(
      { and: [
        { container: ['folder', { eq: [{ var: 'name' }, 'Legal'] }] },
        { contains: [{ var: 'name' }, 'review'] }
      ]},
      'tasks'
    );
    assert.equal(planPathLabel(tree), 'omnijs-fallback');
  });

  it('folder container under or → omnijs-fallback', () => {
    const tree = plan(
      { or: [
        { container: ['folder', { eq: [{ var: 'name' }, 'Legal'] }] },
        { eq: [{ var: 'flagged' }, true] }
      ]},
      'tasks'
    );
    assert.equal(planPathLabel(tree), 'omnijs-fallback');
  });

  it('folder container under not → omnijs-fallback', () => {
    const tree = plan(
      { not: [{ container: ['folder', { eq: [{ var: 'name' }, 'Legal'] }] }] },
      'tasks'
    );
    assert.equal(planPathLabel(tree), 'omnijs-fallback');
  });

  it('expensive var (note) in where → omnijs-fallback', () => {
    const tree = plan({ contains: [{ var: 'note' }, 'important'] }, 'tasks');
    assert.equal(planPathLabel(tree), 'omnijs-fallback');
  });

  it('easy vars only → broad', () => {
    const tree = plan(
      { and: [{ eq: [{ var: 'flagged' }, true] }, { contains: [{ var: 'name' }, 'review'] }] },
      'tasks'
    );
    assert.equal(planPathLabel(tree), 'broad');
  });

  it('chain vars (projectName) → broad', () => {
    const tree = plan({ contains: [{ var: 'projectName' }, 'litigation'] }, 'tasks');
    assert.equal(planPathLabel(tree), 'broad');
  });

  it('reclassified task vars (tags, status, inInbox) → broad (not two-phase)', () => {
    // tags is now chain, status is computed, inInbox is easy
    const tree = plan({ eq: [{ var: 'inInbox' }, true] }, 'tasks');
    assert.equal(planPathLabel(tree), 'broad');
  });

  it('task status (computed) → broad with dependency columns', () => {
    const tree = plan({ eq: [{ var: 'status' }, 'Available'] }, 'tasks');
    assert.equal(planPathLabel(tree), 'broad');
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.computedVars?.has('status'));
    // Check status dependencies are in columns
    assert.ok(scan.columns.includes('completed'));
    assert.ok(scan.columns.includes('dropped'));
    assert.ok(scan.columns.includes('blocked'));
    assert.ok(scan.columns.includes('dueDate'));
  });

  it('task tags (chain) → broad', () => {
    const tree = plan({ contains: [{ var: 'tags' }, 'urgent'] }, 'tasks');
    assert.equal(planPathLabel(tree), 'broad');
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('tags'));
  });

  it('no where clause → broad', () => {
    const tree = plan(undefined, 'tasks');
    assert.equal(planPathLabel(tree), 'broad');
  });
});

// ── Project-scoped extraction ───────────────────────────────────────────

describe('planner — project-scoped extraction', () => {
  it('top-level project container → project-scoped', () => {
    const tree = plan(
      { container: ['project', { contains: [{ var: 'name' }, 'PHS'] }] },
      'tasks'
    );
    assert.equal(planPathLabel(tree), 'project-scoped');
  });

  it('project container in and → project-scoped with remainder', () => {
    const tree = plan(
      { and: [
        { container: ['project', { eq: [{ var: 'name' }, 'PHS'] }] },
        { eq: [{ var: 'flagged' }, true] }
      ]},
      'tasks'
    );
    assert.equal(planPathLabel(tree), 'project-scoped');
    // Should have a Filter (remainder)
    assert.ok(findNode(tree, 'Filter'));
  });

  it('project container under or → NOT extracted', () => {
    const tree = plan(
      { or: [
        { container: ['project', { eq: [{ var: 'name' }, 'PHS'] }] },
        { eq: [{ var: 'flagged' }, true] }
      ]},
      'tasks'
    );
    assert.notEqual(planPathLabel(tree), 'project-scoped');
  });

  it('project container under not → NOT extracted', () => {
    const tree = plan(
      { not: [{ container: ['project', { eq: [{ var: 'name' }, 'PHS'] }] }] },
      'tasks'
    );
    assert.notEqual(planPathLabel(tree), 'project-scoped');
  });

  it('nested project container in and → NOT extracted', () => {
    const tree = plan(
      { and: [
        { or: [
          { container: ['project', { eq: [{ var: 'name' }, 'PHS'] }] },
          { eq: [{ var: 'flagged' }, true] }
        ]},
        { contains: [{ var: 'name' }, 'review'] }
      ]},
      'tasks'
    );
    assert.notEqual(planPathLabel(tree), 'project-scoped');
  });
});

// ── Tags entity ─────────────────────────────────────────────────────────

describe('planner — tags entity', () => {
  it('tags with easy vars only → broad', () => {
    const tree = plan({ gt: [{ var: 'availableTaskCount' }, 0] }, 'tags');
    assert.equal(planPathLabel(tree), 'broad');
  });

  it('tags with no where → broad', () => {
    const tree = plan(undefined, 'tags');
    assert.equal(planPathLabel(tree), 'broad');
  });

  it('tags with per-item var (parentName) → two-phase', () => {
    const tree = plan({ contains: [{ var: 'parentName' }, 'Work'] }, 'tags');
    assert.equal(planPathLabel(tree), 'two-phase');
    const enrich = findNode(tree, 'PerItemEnrich');
    assert.ok(enrich && enrich.kind === 'PerItemEnrich');
    assert.ok(enrich.perItemVars.has('parentName'));
  });

  it('tags with expensive var (note) in where → omnijs-fallback', () => {
    const tree = plan({ contains: [{ var: 'note' }, 'important'] }, 'tags');
    assert.equal(planPathLabel(tree), 'omnijs-fallback');
  });

  it('tags with tag container → omnijs-fallback', () => {
    const tree = plan(
      { container: ['tag', { contains: [{ var: 'name' }, 'Work'] }] },
      'tags'
    );
    assert.equal(planPathLabel(tree), 'omnijs-fallback');
  });

  it('tags with tag container nested in and → omnijs-fallback', () => {
    const tree = plan(
      { and: [
        { container: ['tag', { contains: [{ var: 'name' }, 'Work'] }] },
        { gt: [{ var: 'availableTaskCount' }, 0] }
      ]},
      'tags'
    );
    assert.equal(planPathLabel(tree), 'omnijs-fallback');
  });

  it('tags with per-item var in select only → two-phase', () => {
    const tree = plan(
      { contains: [{ var: 'name' }, 'Work'] },
      'tags',
      ['name', 'parentName']
    );
    assert.equal(planPathLabel(tree), 'two-phase');
  });
});

// ── Expensive in select only ────────────────────────────────────────────

describe('planner — expensive in select only', () => {
  it('expensive var in select only → two-phase (not fallback)', () => {
    const tree = plan(
      { contains: [{ var: 'name' }, 'review'] },
      'tasks',
      ['name', 'note']
    );
    assert.equal(planPathLabel(tree), 'two-phase');
    const enrich = findNode(tree, 'PerItemEnrich');
    assert.ok(enrich && enrich.kind === 'PerItemEnrich');
    assert.ok(enrich.perItemVars.has('note'));
  });
});

// ── BulkScan columns ────────────────────────────────────────────────────

describe('planner — bulkVars population', () => {
  it('includes easy vars from where', () => {
    const tree = plan({ eq: [{ var: 'flagged' }, true] }, 'tasks');
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('flagged'));
  });

  it('includes chain vars from where', () => {
    const tree = plan({ contains: [{ var: 'projectName' }, 'PHS'] }, 'tasks');
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('projectName'));
  });

  it('includes easy select vars in bulk', () => {
    const tree = plan(
      { eq: [{ var: 'flagged' }, true] },
      'tasks',
      ['name', 'dueDate']
    );
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('name'));
    assert.ok(scan.columns.includes('dueDate'));
    assert.ok(scan.columns.includes('flagged'));
  });

  it('expands computed var deps into columns', () => {
    const tree = plan(undefined, 'tasks', ['status']);
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    // status depends on completed, dropped, blocked, dueDate
    assert.ok(scan.columns.includes('completed'));
    assert.ok(scan.columns.includes('dropped'));
    assert.ok(scan.columns.includes('blocked'));
    assert.ok(scan.columns.includes('dueDate'));
    assert.ok(scan.computedVars?.has('status'));
  });

  it('hasChildren computed var adds childCount dep', () => {
    const tree = plan(undefined, 'tasks', ['hasChildren']);
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    // childCount nodeKey is 'childCount' (bulk AE property is 'numberOfTasks')
    assert.ok(scan.columns.includes('childCount'));
    assert.ok(scan.computedVars?.has('hasChildren'));
  });
});

// ── Perspectives entity ─────────────────────────────────────────────────

describe('planner — perspectives entity', () => {
  it('perspectives with no where → omnijs-fallback', () => {
    const tree = plan(undefined, 'perspectives');
    assert.equal(planPathLabel(tree), 'omnijs-fallback');
  });

  it('perspectives with where clause → omnijs-fallback', () => {
    const tree = plan({ contains: [{ var: 'name' }, 'Flagged'] }, 'perspectives');
    assert.equal(planPathLabel(tree), 'omnijs-fallback');
  });
});

// ── extractContainerScope ───────────────────────────────────────────────

describe('extractContainerScope', () => {
  it('extracts top-level project container', () => {
    const ast = lowerExpr({ container: ['project', { contains: [{ var: 'name' }, 'PHS'] }] }) as LoweredExpr;
    const result = extractContainerScope(ast);
    assert.ok(result);
    assert.equal(result.remainder, true);
  });

  it('extracts from and', () => {
    const ast = lowerExpr({
      and: [
        { container: ['project', { eq: [{ var: 'name' }, 'PHS'] }] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    }) as LoweredExpr;
    const result = extractContainerScope(ast);
    assert.ok(result);
    const remainder = result.remainder as { op: string };
    assert.equal(remainder.op, 'eq');
  });

  it('returns null for folder container', () => {
    const ast = lowerExpr({ container: ['folder', { eq: [{ var: 'name' }, 'Legal'] }] }) as LoweredExpr;
    const result = extractContainerScope(ast);
    assert.equal(result, null);
  });

  it('returns null for non-container top-level', () => {
    const ast = lowerExpr({ eq: [{ var: 'flagged' }, true] }) as LoweredExpr;
    const result = extractContainerScope(ast);
    assert.equal(result, null);
  });

  it('returns null for container under or', () => {
    const ast = lowerExpr({
      or: [
        { container: ['project', { eq: [{ var: 'name' }, 'PHS'] }] },
        { eq: [{ var: 'flagged' }, true] }
      ]
    }) as LoweredExpr;
    const result = extractContainerScope(ast);
    assert.equal(result, null);
  });

  it('preserves and with 3+ remaining args', () => {
    const ast = lowerExpr({
      and: [
        { container: ['project', { eq: [{ var: 'name' }, 'PHS'] }] },
        { eq: [{ var: 'flagged' }, true] },
        { contains: [{ var: 'name' }, 'review'] }
      ]
    }) as LoweredExpr;
    const result = extractContainerScope(ast);
    assert.ok(result);
    const remainder = result.remainder as { op: string; args: unknown[] };
    assert.equal(remainder.op, 'and');
    assert.equal(remainder.args.length, 2);
  });
});
