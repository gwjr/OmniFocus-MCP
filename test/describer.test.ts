import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeExpr, describeSort } from '../dist/tools/query/backends/describer.js';

describe('describeExpr — primitives', () => {
  it('describes string literal', () => {
    assert.equal(describeExpr('hello'), '"hello"');
  });

  it('describes number literal', () => {
    assert.equal(describeExpr(42), '42');
  });

  it('describes boolean literal', () => {
    assert.equal(describeExpr(true), 'true');
  });

  it('describes null', () => {
    assert.equal(describeExpr(null), 'null');
  });

  it('describes array', () => {
    assert.equal(describeExpr(['a', 'b']), '["a", "b"]');
  });
});

describe('describeExpr — special nodes', () => {
  it('describes var reference', () => {
    assert.equal(describeExpr({ var: 'name' }), 'name');
  });

  it('describes now var', () => {
    assert.equal(describeExpr({ var: 'now' }), 'now');
  });

  it('describes date literal', () => {
    assert.equal(describeExpr({ date: '2026-03-01' }), '2026-03-01');
  });
});

describe('describeExpr — offset', () => {
  it('describes days ago from now', () => {
    assert.equal(describeExpr({ offset: { date: 'now', days: -3 } }), '3 days ago');
  });

  it('describes days from now', () => {
    assert.equal(describeExpr({ offset: { date: 'now', days: 7 } }), '7 days from now');
  });

  it('describes 1 day ago (singular)', () => {
    assert.equal(describeExpr({ offset: { date: 'now', days: -1 } }), '1 day ago');
  });

  it('describes offset from a var', () => {
    assert.equal(
      describeExpr({ offset: { date: { var: 'dueDate' }, days: -1 } }),
      '1 day before dueDate'
    );
  });

  it('describes zero offset from now', () => {
    assert.equal(describeExpr({ offset: { date: 'now', days: 0 } }), 'now');
  });
});

describe('describeExpr — comparison ops', () => {
  it('describes eq', () => {
    assert.equal(
      describeExpr({ eq: [{ var: 'flagged' }, true] }),
      'flagged = true'
    );
  });

  it('describes neq', () => {
    assert.equal(
      describeExpr({ neq: [{ var: 'status' }, 'Dropped'] }),
      'status != "Dropped"'
    );
  });

  it('describes gt', () => {
    assert.equal(
      describeExpr({ gt: [{ var: 'estimatedMinutes' }, 30] }),
      'estimatedMinutes > 30'
    );
  });

  it('describes lte with offset', () => {
    assert.equal(
      describeExpr({ lte: [{ var: 'dueDate' }, { offset: { date: 'now', days: 7 } }] }),
      'dueDate <= 7 days from now'
    );
  });

  it('describes lt with now var', () => {
    assert.equal(
      describeExpr({ lt: [{ var: 'dueDate' }, { var: 'now' }] }),
      'dueDate < now'
    );
  });
});

describe('describeExpr — logical ops', () => {
  it('describes and', () => {
    const result = describeExpr({
      and: [
        { eq: [{ var: 'flagged' }, true] },
        { contains: [{ var: 'name' }, 'review'] }
      ]
    });
    assert.equal(result, '(flagged = true) AND (name contains "review")');
  });

  it('describes or', () => {
    const result = describeExpr({
      or: [
        { eq: [{ var: 'flagged' }, true] },
        { lt: [{ var: 'dueDate' }, { var: 'now' }] }
      ]
    });
    assert.equal(result, '(flagged = true) OR (dueDate < now)');
  });

  it('describes not', () => {
    assert.equal(
      describeExpr({ not: [{ contains: [{ var: 'tags' }, 'someday'] }] }),
      'NOT (tags contains "someday")'
    );
  });
});

describe('describeExpr — other ops', () => {
  it('describes in', () => {
    assert.equal(
      describeExpr({ in: [{ var: 'status' }, ['Available', 'Next']] }),
      'status in ["Available", "Next"]'
    );
  });

  it('describes between', () => {
    assert.equal(
      describeExpr({ between: [{ var: 'dueDate' }, { var: 'now' }, { offset: { date: 'now', days: 7 } }] }),
      'dueDate between now and 7 days from now'
    );
  });

  it('describes container', () => {
    assert.equal(
      describeExpr({ container: ['project', { contains: [{ var: 'name' }, 'PHS'] }] }),
      'in project where name contains "PHS"'
    );
  });

  it('describes contains (string)', () => {
    assert.equal(
      describeExpr({ contains: [{ var: 'name' }, 'review'] }),
      'name contains "review"'
    );
  });

  it('describes contains (tags)', () => {
    assert.equal(
      describeExpr({ contains: [{ var: 'tags' }, 'work'] }),
      'tags contains "work"'
    );
  });

  it('describes startsWith', () => {
    assert.equal(
      describeExpr({ startsWith: [{ var: 'name' }, 'Task'] }),
      'name starts with "Task"'
    );
  });

  it('describes endsWith', () => {
    assert.equal(
      describeExpr({ endsWith: [{ var: 'name' }, 'done'] }),
      'name ends with "done"'
    );
  });

  it('describes matches', () => {
    assert.equal(
      describeExpr({ matches: [{ var: 'name' }, '^Review.*'] }),
      'name matches "^Review.*"'
    );
  });
});

describe('describeExpr — complex expressions', () => {
  it('describes the full plan example', () => {
    const result = describeExpr({
      and: [
        { eq: [{ var: 'flagged' }, true] },
        { contains: [{ var: 'name' }, 'review'] },
        { lte: [{ var: 'dueDate' }, { offset: { date: 'now', days: 7 } }] },
        { contains: [{ var: 'tags' }, 'work'] }
      ]
    });
    assert.equal(
      result,
      '(flagged = true) AND (name contains "review") AND (dueDate <= 7 days from now) AND (tags contains "work")'
    );
  });
});

describe('describeSort', () => {
  it('describes sort with explicit direction', () => {
    assert.equal(describeSort({ by: 'dueDate', direction: 'asc' }), 'sorted by dueDate asc');
  });

  it('describes sort with default direction', () => {
    assert.equal(describeSort({ by: 'name' }), 'sorted by name asc');
  });

  it('describes desc sort', () => {
    assert.equal(describeSort({ by: 'modificationDate', direction: 'desc' }), 'sorted by modificationDate desc');
  });
});
