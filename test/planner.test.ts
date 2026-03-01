import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planExecution, extractContainerScope } from '../dist/tools/query/planner.js';
import { lowerExpr } from '../dist/tools/query/lower.js';
import type { LoweredExpr } from '../dist/tools/query/fold.js';

describe('planner — path selection', () => {
  it('projects entity with easy vars → broad', () => {
    const plan = planExecution({ contains: [{ var: 'name' }, 'test'] }, 'projects');
    assert.equal(plan.path, 'broad');
  });

  it('projects entity with per-item var (folderId) → two-phase', () => {
    const plan = planExecution(
      { contains: [{ var: 'folderName' }, 'Legal'] },
      'projects'
    );
    assert.equal(plan.path, 'two-phase');
    assert.ok(plan.perItemVars?.has('folderName'));
  });

  it('projects entity with folder container → omnijs-fallback', () => {
    const plan = planExecution(
      { container: ['folder', { contains: [{ var: 'name' }, 'Legal'] }] },
      'projects'
    );
    assert.equal(plan.path, 'omnijs-fallback');
  });

  it('folders entity → omnijs-fallback', () => {
    const plan = planExecution({ eq: [{ var: 'name' }, 'Legal'] }, 'folders');
    assert.equal(plan.path, 'omnijs-fallback');
  });

  it('folder container at any depth → omnijs-fallback', () => {
    const plan = planExecution(
      { and: [
        { container: ['folder', { eq: [{ var: 'name' }, 'Legal'] }] },
        { contains: [{ var: 'name' }, 'review'] }
      ]},
      'tasks'
    );
    assert.equal(plan.path, 'omnijs-fallback');
  });

  it('folder container under or → omnijs-fallback', () => {
    const plan = planExecution(
      { or: [
        { container: ['folder', { eq: [{ var: 'name' }, 'Legal'] }] },
        { eq: [{ var: 'flagged' }, true] }
      ]},
      'tasks'
    );
    assert.equal(plan.path, 'omnijs-fallback');
  });

  it('folder container under not → omnijs-fallback', () => {
    const plan = planExecution(
      { not: [{ container: ['folder', { eq: [{ var: 'name' }, 'Legal'] }] }] },
      'tasks'
    );
    assert.equal(plan.path, 'omnijs-fallback');
  });

  it('expensive var (note) in where → omnijs-fallback', () => {
    const plan = planExecution(
      { contains: [{ var: 'note' }, 'important'] },
      'tasks'
    );
    assert.equal(plan.path, 'omnijs-fallback');
  });

  it('easy vars only → broad', () => {
    const plan = planExecution(
      { and: [{ eq: [{ var: 'flagged' }, true] }, { contains: [{ var: 'name' }, 'review'] }] },
      'tasks'
    );
    assert.equal(plan.path, 'broad');
  });

  it('chain vars (projectName) → broad', () => {
    const plan = planExecution(
      { contains: [{ var: 'projectName' }, 'litigation'] },
      'tasks'
    );
    assert.equal(plan.path, 'broad');
  });

  it('per-item vars (tags) → two-phase', () => {
    const plan = planExecution(
      { contains: [{ var: 'tags' }, 'urgent'] },
      'tasks'
    );
    assert.equal(plan.path, 'two-phase');
    assert.ok(plan.perItemVars?.has('tags'));
    assert.ok(plan.stubVars?.has('tags'));
  });

  it('per-item vars (status) → two-phase', () => {
    const plan = planExecution(
      { eq: [{ var: 'status' }, 'Available'] },
      'tasks'
    );
    assert.equal(plan.path, 'two-phase');
    assert.ok(plan.perItemVars?.has('status'));
  });

  it('mixed easy + per-item → two-phase with correct sets', () => {
    const plan = planExecution(
      { and: [{ contains: [{ var: 'name' }, 'review'] }, { contains: [{ var: 'tags' }, 'work'] }] },
      'tasks'
    );
    assert.equal(plan.path, 'two-phase');
    assert.ok(plan.bulkVars.has('name'));
    assert.ok(plan.perItemVars?.has('tags'));
    assert.ok(plan.stubVars?.has('tags'));
  });

  it('no where clause → broad', () => {
    const plan = planExecution(undefined, 'tasks');
    assert.equal(plan.path, 'broad');
  });
});

describe('planner — project-scoped extraction', () => {
  it('top-level project container → project-scoped', () => {
    const plan = planExecution(
      { container: ['project', { contains: [{ var: 'name' }, 'PHS'] }] },
      'tasks'
    );
    assert.equal(plan.path, 'project-scoped');
    assert.ok(plan.projectScope);
  });

  it('project container in and → project-scoped with remainder', () => {
    const plan = planExecution(
      { and: [
        { container: ['project', { eq: [{ var: 'name' }, 'PHS'] }] },
        { eq: [{ var: 'flagged' }, true] }
      ]},
      'tasks'
    );
    assert.equal(plan.path, 'project-scoped');
    assert.ok(plan.projectScope);
    // Remainder should be the flagged eq
    assert.notEqual(plan.filterAst, true);
  });

  it('project container under or → NOT extracted (broad or two-phase)', () => {
    const plan = planExecution(
      { or: [
        { container: ['project', { eq: [{ var: 'name' }, 'PHS'] }] },
        { eq: [{ var: 'flagged' }, true] }
      ]},
      'tasks'
    );
    // Should not extract — or means the container is not universally required
    assert.notEqual(plan.path, 'project-scoped');
  });

  it('project container under not → NOT extracted', () => {
    const plan = planExecution(
      { not: [{ container: ['project', { eq: [{ var: 'name' }, 'PHS'] }] }] },
      'tasks'
    );
    assert.notEqual(plan.path, 'project-scoped');
  });

  it('nested project container in and → NOT extracted', () => {
    const plan = planExecution(
      { and: [
        { or: [
          { container: ['project', { eq: [{ var: 'name' }, 'PHS'] }] },
          { eq: [{ var: 'flagged' }, true] }
        ]},
        { contains: [{ var: 'name' }, 'review'] }
      ]},
      'tasks'
    );
    // Container is inside an or, not at top level of and
    assert.notEqual(plan.path, 'project-scoped');
  });
});

describe('planner — tags entity', () => {
  it('tags with easy vars only → broad', () => {
    const plan = planExecution(
      { gt: [{ var: 'availableTaskCount' }, 0] },
      'tags'
    );
    assert.equal(plan.path, 'broad');
  });

  it('tags with no where → broad', () => {
    const plan = planExecution(undefined, 'tags');
    assert.equal(plan.path, 'broad');
  });

  it('tags with per-item var (parentName) → two-phase', () => {
    const plan = planExecution(
      { contains: [{ var: 'parentName' }, 'Work'] },
      'tags'
    );
    assert.equal(plan.path, 'two-phase');
    assert.ok(plan.perItemVars?.has('parentName'));
  });

  it('tags with expensive var (note) in where → omnijs-fallback', () => {
    const plan = planExecution(
      { contains: [{ var: 'note' }, 'important'] },
      'tags'
    );
    assert.equal(plan.path, 'omnijs-fallback');
  });

  it('tags with tag container → omnijs-fallback', () => {
    const plan = planExecution(
      { container: ['tag', { contains: [{ var: 'name' }, 'Work'] }] },
      'tags'
    );
    assert.equal(plan.path, 'omnijs-fallback');
  });

  it('tags with tag container nested in and → omnijs-fallback', () => {
    const plan = planExecution(
      { and: [
        { container: ['tag', { contains: [{ var: 'name' }, 'Work'] }] },
        { gt: [{ var: 'availableTaskCount' }, 0] }
      ]},
      'tags'
    );
    assert.equal(plan.path, 'omnijs-fallback');
  });

  it('tags with per-item var in select only → two-phase', () => {
    const plan = planExecution(
      { contains: [{ var: 'name' }, 'Work'] },
      'tags',
      ['name', 'parentName']
    );
    assert.equal(plan.path, 'two-phase');
    assert.ok(plan.perItemVars?.has('parentName'));
  });
});

describe('planner — expensive in select only', () => {
  it('expensive var in select only → two-phase (not fallback)', () => {
    const plan = planExecution(
      { contains: [{ var: 'name' }, 'review'] },
      'tasks',
      ['name', 'note']
    );
    // 'note' is expensive but only in select, not in where
    // Name is easy, so the where can be evaluated without fallback
    assert.equal(plan.path, 'two-phase');
    assert.ok(plan.perItemVars?.has('note'));
  });
});

describe('planner — bulkVars population', () => {
  it('includes easy vars from where', () => {
    const plan = planExecution(
      { eq: [{ var: 'flagged' }, true] },
      'tasks'
    );
    assert.ok(plan.bulkVars.has('flagged'));
  });

  it('includes chain vars from where', () => {
    const plan = planExecution(
      { contains: [{ var: 'projectName' }, 'PHS'] },
      'tasks'
    );
    assert.ok(plan.bulkVars.has('projectName'));
  });

  it('includes easy select vars in bulk', () => {
    const plan = planExecution(
      { eq: [{ var: 'flagged' }, true] },
      'tasks',
      ['name', 'dueDate']
    );
    assert.ok(plan.bulkVars.has('name'));
    assert.ok(plan.bulkVars.has('dueDate'));
    assert.ok(plan.bulkVars.has('flagged'));
  });
});

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
    // Remainder should be the eq node
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
    // Remainder should still be an and with 2 args
    const remainder = result.remainder as { op: string; args: unknown[] };
    assert.equal(remainder.op, 'and');
    assert.equal(remainder.args.length, 2);
  });
});
