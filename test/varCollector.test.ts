import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectVars } from '../dist/tools/query/backends/varCollector.js';

describe('varCollector', () => {
  it('collects single variable', () => {
    const vars = collectVars({ var: 'name' }, 'tasks');
    assert.deepEqual(vars, new Set(['name']));
  });

  it('collects from comparison', () => {
    const vars = collectVars({ eq: [{ var: 'flagged' }, true] }, 'tasks');
    assert.deepEqual(vars, new Set(['flagged']));
  });

  it('collects from contains', () => {
    const vars = collectVars({ contains: [{ var: 'name' }, 'test'] }, 'tasks');
    assert.deepEqual(vars, new Set(['name']));
  });

  it('collects from tags contains', () => {
    const vars = collectVars({ contains: [{ var: 'tags' }, 'work'] }, 'tasks');
    assert.deepEqual(vars, new Set(['tags']));
  });

  it('collects from and', () => {
    const vars = collectVars({
      and: [
        { eq: [{ var: 'flagged' }, true] },
        { contains: [{ var: 'name' }, 'review'] }
      ]
    }, 'tasks');
    assert.deepEqual(vars, new Set(['flagged', 'name']));
  });

  it('collects from or', () => {
    const vars = collectVars({
      or: [
        { eq: [{ var: 'status' }, 'Available'] },
        { eq: [{ var: 'status' }, 'Next'] }
      ]
    }, 'tasks');
    assert.deepEqual(vars, new Set(['status']));
  });

  it('collects from not', () => {
    const vars = collectVars({ not: [{ contains: [{ var: 'tags' }, 'someday'] }] }, 'tasks');
    assert.deepEqual(vars, new Set(['tags']));
  });

  it('collects from between', () => {
    const vars = collectVars({
      between: [{ var: 'dueDate' }, { var: 'now' }, { offset: { date: 'now', days: 7 } }]
    }, 'tasks');
    assert.deepEqual(vars, new Set(['dueDate', 'now']));
  });

  it('collects from in', () => {
    const vars = collectVars({ in: [{ var: 'status' }, ['Available', 'Next']] }, 'tasks');
    assert.deepEqual(vars, new Set(['status']));
  });

  it('collects from offset with var base', () => {
    const vars = collectVars({ offset: { date: { var: 'dueDate' }, days: -1 } }, 'tasks');
    assert.deepEqual(vars, new Set(['dueDate']));
  });

  it('collects from container (project) — switches entity', () => {
    const vars = collectVars(
      { container: ['project', { contains: [{ var: 'name' }, 'PHS'] }] },
      'tasks'
    );
    // 'name' inside container is a project var, not a task var
    assert.deepEqual(vars, new Set(['name']));
  });

  it('collects from complex expression', () => {
    const vars = collectVars({
      and: [
        { container: ['folder', { eq: [{ var: 'name' }, 'Legal'] }] },
        { lt: [{ var: 'dueDate' }, { var: 'now' }] },
        { contains: [{ var: 'tags' }, 'urgent'] }
      ]
    }, 'tasks');
    assert.deepEqual(vars, new Set(['name', 'dueDate', 'now', 'tags']));
  });

  it('returns empty set for literal expression', () => {
    const vars = collectVars(true, 'tasks');
    assert.deepEqual(vars, new Set());
  });

  it('returns empty set for null', () => {
    const vars = collectVars(null, 'tasks');
    assert.deepEqual(vars, new Set());
  });

  it('collects from matches', () => {
    const vars = collectVars({ matches: [{ var: 'name' }, '^Review'] }, 'tasks');
    assert.deepEqual(vars, new Set(['name']));
  });

  it('collects tag entity vars', () => {
    const vars = collectVars(
      { and: [{ gt: [{ var: 'availableTaskCount' }, 0] }, { eq: [{ var: 'hidden' }, false] }] },
      'tags'
    );
    assert.deepEqual(vars, new Set(['availableTaskCount', 'hidden']));
  });

  it('collects tag name from contains', () => {
    const vars = collectVars({ contains: [{ var: 'name' }, 'Work'] }, 'tags');
    assert.deepEqual(vars, new Set(['name']));
  });

  it('collects tag per-item var (parentName)', () => {
    const vars = collectVars(
      { contains: [{ var: 'parentName' }, 'Context'] },
      'tags'
    );
    assert.deepEqual(vars, new Set(['parentName']));
  });

  it('collects from tag container — switches entity to tags', () => {
    const vars = collectVars(
      { container: ['tag', { contains: [{ var: 'name' }, 'Work'] }] },
      'tags'
    );
    assert.deepEqual(vars, new Set(['name']));
  });

  it('collects from startsWith/endsWith', () => {
    const vars = collectVars({
      and: [
        { startsWith: [{ var: 'name' }, 'Task'] },
        { endsWith: [{ var: 'projectName' }, 'done'] }
      ]
    }, 'tasks');
    assert.deepEqual(vars, new Set(['name', 'projectName']));
  });
});
