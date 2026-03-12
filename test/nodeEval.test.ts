import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileNodePredicate, type Row, type RowFn } from '../dist/tools/query/backends/nodeEval.js';
import { lowerExpr } from '../dist/tools/query/lower.js';
import type { LoweredExpr } from '../dist/tools/query/fold.js';

// Helper: compile compact syntax to a predicate
function predicate(where: unknown, entity: 'tasks' | 'projects' | 'folders' | 'tags' = 'tasks', stubVars?: Set<string>): RowFn {
  const ast = lowerExpr(where) as LoweredExpr;
  return compileNodePredicate(ast, entity, stubVars ? { stubVars } : undefined);
}

// Helper: evaluate and return boolean
function evalRow(where: unknown, row: Row, entity: 'tasks' | 'projects' | 'folders' | 'tags' = 'tasks', stubVars?: Set<string>): boolean {
  return !!predicate(where, entity, stubVars)(row);
}

describe('nodeEval — literals', () => {
  it('true literal evaluates to true', () => {
    assert.equal(evalRow(true, {}), true);
  });

  it('false literal evaluates to false', () => {
    assert.equal(evalRow(false, {}), false);
  });

  it('null literal evaluates to false', () => {
    assert.equal(evalRow(null, {}), false);
  });

  it('non-empty string literal is truthy', () => {
    assert.equal(evalRow('hello', {}), true);
  });

  it('empty string literal is falsy', () => {
    assert.equal(evalRow('', {}), false);
  });
});

describe('nodeEval — variables', () => {
  it('reads string variable from row', () => {
    const fn = predicate({ var: 'name' });
    assert.equal(fn({ name: 'test' }), 'test');
  });

  it('reads boolean variable from row', () => {
    assert.equal(evalRow({ var: 'flagged' }, { flagged: true }), true);
    assert.equal(evalRow({ var: 'flagged' }, { flagged: false }), false);
  });

  it('reads date variable as ISO string', () => {
    const fn = predicate({ var: 'dueDate' });
    assert.equal(fn({ dueDate: '2026-03-01T00:00:00.000Z' }), '2026-03-01T00:00:00.000Z');
  });
});

describe('nodeEval — comparison eq/neq', () => {
  it('eq: string equality is case-insensitive', () => {
    assert.equal(evalRow({ eq: [{ var: 'name' }, 'TEST'] }, { name: 'test' }), true);
    assert.equal(evalRow({ eq: [{ var: 'name' }, 'TEST'] }, { name: 'Test' }), true);
    assert.equal(evalRow({ eq: [{ var: 'name' }, 'other'] }, { name: 'test' }), false);
  });

  it('eq: null == null is true', () => {
    assert.equal(evalRow({ eq: [{ var: 'dueDate' }, null] }, { dueDate: null }), true);
  });

  it('eq: null != non-null is false', () => {
    assert.equal(evalRow({ eq: [{ var: 'dueDate' }, null] }, { dueDate: '2026-01-01' }), false);
  });

  it('eq: boolean equality', () => {
    assert.equal(evalRow({ eq: [{ var: 'flagged' }, true] }, { flagged: true }), true);
    assert.equal(evalRow({ eq: [{ var: 'flagged' }, true] }, { flagged: false }), false);
  });

  it('eq: number equality', () => {
    assert.equal(evalRow({ eq: [{ var: 'estimatedMinutes' }, 30] }, { estimatedMinutes: 30 }), true);
    assert.equal(evalRow({ eq: [{ var: 'estimatedMinutes' }, 30] }, { estimatedMinutes: 60 }), false);
  });

  it('neq: string inequality', () => {
    assert.equal(evalRow({ neq: [{ var: 'name' }, 'test'] }, { name: 'test' }), false);
    assert.equal(evalRow({ neq: [{ var: 'name' }, 'test'] }, { name: 'other' }), true);
  });

  it('neq: null != non-null is true', () => {
    assert.equal(evalRow({ neq: [{ var: 'dueDate' }, null] }, { dueDate: '2026-01-01' }), true);
  });
});

describe('nodeEval — comparison gt/gte/lt/lte', () => {
  it('gt: number comparison', () => {
    assert.equal(evalRow({ gt: [{ var: 'estimatedMinutes' }, 30] }, { estimatedMinutes: 60 }), true);
    assert.equal(evalRow({ gt: [{ var: 'estimatedMinutes' }, 30] }, { estimatedMinutes: 30 }), false);
    assert.equal(evalRow({ gt: [{ var: 'estimatedMinutes' }, 30] }, { estimatedMinutes: 10 }), false);
  });

  it('gte: includes equal', () => {
    assert.equal(evalRow({ gte: [{ var: 'estimatedMinutes' }, 30] }, { estimatedMinutes: 30 }), true);
    assert.equal(evalRow({ gte: [{ var: 'estimatedMinutes' }, 30] }, { estimatedMinutes: 29 }), false);
  });

  it('lt/lte: number comparison', () => {
    assert.equal(evalRow({ lt: [{ var: 'estimatedMinutes' }, 60] }, { estimatedMinutes: 30 }), true);
    assert.equal(evalRow({ lte: [{ var: 'estimatedMinutes' }, 60] }, { estimatedMinutes: 60 }), true);
    assert.equal(evalRow({ lt: [{ var: 'estimatedMinutes' }, 60] }, { estimatedMinutes: 60 }), false);
  });

  it('returns false when either side is null', () => {
    assert.equal(evalRow({ gt: [{ var: 'estimatedMinutes' }, 30] }, { estimatedMinutes: null }), false);
    assert.equal(evalRow({ gt: [{ var: 'dueDate' }, { date: '2026-01-01' }] }, { dueDate: null }), false);
  });

  it('date comparison via timestamps', () => {
    assert.equal(
      evalRow({ gt: [{ var: 'dueDate' }, { date: '2026-01-01' }] }, { dueDate: '2026-06-01T00:00:00.000Z' }),
      true
    );
    assert.equal(
      evalRow({ lt: [{ var: 'dueDate' }, { date: '2026-01-01' }] }, { dueDate: '2025-06-01T00:00:00.000Z' }),
      true
    );
  });

  it('string comparison is case-insensitive', () => {
    assert.equal(evalRow({ gt: [{ var: 'name' }, 'A'] }, { name: 'B' }), true);
    assert.equal(evalRow({ gt: [{ var: 'name' }, 'a'] }, { name: 'B' }), true);
  });
});

describe('nodeEval — between', () => {
  it('between: inclusive range', () => {
    assert.equal(
      evalRow({ between: [{ var: 'estimatedMinutes' }, 10, 60] }, { estimatedMinutes: 30 }),
      true
    );
    assert.equal(
      evalRow({ between: [{ var: 'estimatedMinutes' }, 10, 60] }, { estimatedMinutes: 10 }),
      true
    );
    assert.equal(
      evalRow({ between: [{ var: 'estimatedMinutes' }, 10, 60] }, { estimatedMinutes: 60 }),
      true
    );
    assert.equal(
      evalRow({ between: [{ var: 'estimatedMinutes' }, 10, 60] }, { estimatedMinutes: 5 }),
      false
    );
  });

  it('between: returns false if value is null', () => {
    assert.equal(
      evalRow({ between: [{ var: 'estimatedMinutes' }, 10, 60] }, { estimatedMinutes: null }),
      false
    );
  });

  it('between: date range', () => {
    assert.equal(
      evalRow(
        { between: [{ var: 'dueDate' }, { date: '2026-01-01' }, { date: '2026-12-31' }] },
        { dueDate: '2026-06-15T00:00:00.000Z' }
      ),
      true
    );
    assert.equal(
      evalRow(
        { between: [{ var: 'dueDate' }, { date: '2026-01-01' }, { date: '2026-12-31' }] },
        { dueDate: '2025-06-15T00:00:00.000Z' }
      ),
      false
    );
  });
});

describe('nodeEval — logical', () => {
  it('and: all must be true', () => {
    assert.equal(
      evalRow({ and: [{ eq: [{ var: 'flagged' }, true] }, { contains: [{ var: 'name' }, 'review'] }] },
        { flagged: true, name: 'Weekly Review' }),
      true
    );
    assert.equal(
      evalRow({ and: [{ eq: [{ var: 'flagged' }, true] }, { contains: [{ var: 'name' }, 'review'] }] },
        { flagged: false, name: 'Weekly Review' }),
      false
    );
  });

  it('or: any must be true', () => {
    assert.equal(
      evalRow({ or: [{ eq: [{ var: 'flagged' }, true] }, { contains: [{ var: 'name' }, 'urgent'] }] },
        { flagged: false, name: 'urgent task' }),
      true
    );
  });

  it('not: inverts', () => {
    assert.equal(
      evalRow({ not: [{ eq: [{ var: 'flagged' }, true] }] }, { flagged: true }),
      false
    );
    assert.equal(
      evalRow({ not: [{ eq: [{ var: 'flagged' }, true] }] }, { flagged: false }),
      true
    );
  });

  it('and coerces to boolean (null is falsy)', () => {
    assert.equal(evalRow({ and: [null, true] }, {}), false);
  });

  it('or coerces to boolean (null is falsy)', () => {
    assert.equal(evalRow({ or: [null, false] }, {}), false);
    assert.equal(evalRow({ or: [null, true] }, {}), true);
  });

  it('not(null) is true', () => {
    assert.equal(evalRow({ not: [null] }, {}), true);
  });
});

describe('nodeEval — in (value in array)', () => {
  it('matches value in array', () => {
    assert.equal(
      evalRow({ in: [{ var: 'status' }, ['Available', 'Next']] }, { status: 'Available' }),
      true
    );
  });

  it('no match returns false', () => {
    assert.equal(
      evalRow({ in: [{ var: 'status' }, ['Available', 'Next']] }, { status: 'Blocked' }),
      false
    );
  });

  it('case-insensitive matching for strings', () => {
    assert.equal(
      evalRow({ in: [{ var: 'status' }, ['Available', 'Next']] }, { status: 'available' }),
      true
    );
  });
});

describe('nodeEval — string ops', () => {
  it('contains: case-insensitive', () => {
    assert.equal(evalRow({ contains: [{ var: 'name' }, 'Review'] }, { name: 'Weekly review' }), true);
    assert.equal(evalRow({ contains: [{ var: 'name' }, 'review'] }, { name: 'Weekly Review' }), true);
    assert.equal(evalRow({ contains: [{ var: 'name' }, 'missing'] }, { name: 'Weekly Review' }), false);
  });

  it('contains: returns false when haystack is null', () => {
    assert.equal(evalRow({ contains: [{ var: 'name' }, 'test'] }, { name: null }), false);
  });

  it('startsWith: case-insensitive', () => {
    assert.equal(evalRow({ startsWith: [{ var: 'name' }, 'Weekly'] }, { name: 'weekly review' }), true);
    assert.equal(evalRow({ startsWith: [{ var: 'name' }, 'daily'] }, { name: 'weekly review' }), false);
  });

  it('endsWith: case-insensitive', () => {
    assert.equal(evalRow({ endsWith: [{ var: 'name' }, 'Review'] }, { name: 'Weekly review' }), true);
    assert.equal(evalRow({ endsWith: [{ var: 'name' }, 'daily'] }, { name: 'weekly review' }), false);
  });

  it('matches: regex case-insensitive', () => {
    assert.equal(evalRow({ matches: [{ var: 'name' }, '^Weekly'] }, { name: 'weekly review' }), true);
    assert.equal(evalRow({ matches: [{ var: 'name' }, '^Daily'] }, { name: 'weekly review' }), false);
  });

  it('string ops return false for null haystack', () => {
    assert.equal(evalRow({ startsWith: [{ var: 'name' }, 'test'] }, { name: null }), false);
    assert.equal(evalRow({ endsWith: [{ var: 'name' }, 'test'] }, { name: null }), false);
    assert.equal(evalRow({ matches: [{ var: 'name' }, 'test'] }, { name: null }), false);
  });
});

describe('nodeEval — array contains (tags)', () => {
  it('finds tag in array (case-insensitive)', () => {
    assert.equal(
      evalRow({ contains: [{ var: 'tags' }, 'Work'] }, { tags: ['work', 'urgent'] }),
      true
    );
  });

  it('no match returns false', () => {
    assert.equal(
      evalRow({ contains: [{ var: 'tags' }, 'missing'] }, { tags: ['work', 'urgent'] }),
      false
    );
  });

  it('null array returns false', () => {
    assert.equal(
      evalRow({ contains: [{ var: 'tags' }, 'work'] }, { tags: null }),
      false
    );
  });
});

describe('nodeEval — offset', () => {
  it('offset from now produces timestamp', () => {
    const fn = predicate({ offset: { date: 'now', days: -3 } });
    const result = fn({}) as number;
    // Should be approximately 3 days ago
    const expected = Date.now() - 3 * 86400000;
    assert.ok(Math.abs(result - expected) < 1000);
  });

  it('offset from date literal', () => {
    const fn = predicate({ offset: { date: '2026-03-01', days: 5 } });
    const result = fn({}) as number;
    const expected = Date.parse('2026-03-01') + 5 * 86400000;
    assert.equal(result, expected);
  });

  it('offset with null date returns null', () => {
    const fn = predicate({ offset: { date: { var: 'dueDate' }, days: -1 } });
    const result = fn({ dueDate: null });
    assert.equal(result, null);
  });
});

describe('nodeEval — container (project)', () => {
  it('matches project by name', () => {
    assert.equal(
      evalRow(
        { container: ['project', { contains: [{ var: 'name' }, 'PHS'] }] },
        { projectName: 'PHS Project', projectId: 'p1' },
        'tasks'
      ),
      true
    );
  });

  it('no match when project name does not match', () => {
    assert.equal(
      evalRow(
        { container: ['project', { contains: [{ var: 'name' }, 'PHS'] }] },
        { projectName: 'Other Project', projectId: 'p2' },
        'tasks'
      ),
      false
    );
  });

  it('returns false when no project', () => {
    assert.equal(
      evalRow(
        { container: ['project', { contains: [{ var: 'name' }, 'PHS'] }] },
        { projectName: null, projectId: null },
        'tasks'
      ),
      false
    );
  });

  it('matches project by status (non-name field)', () => {
    // Bug: the stub row only had {name, id}, so status was undefined → false
    assert.equal(
      evalRow(
        { container: ['project', { eq: [{ var: 'status' }, 'Active'] }] },
        { projectName: 'My Project', projectId: 'p1', projectStatus: 'Active' },
        'tasks'
      ),
      true
    );
  });

  it('rejects project by status when status does not match', () => {
    assert.equal(
      evalRow(
        { container: ['project', { eq: [{ var: 'status' }, 'Active'] }] },
        { projectName: 'My Project', projectId: 'p1', projectStatus: 'OnHold' },
        'tasks'
      ),
      false
    );
  });

  it('matches project by flagged (boolean field)', () => {
    assert.equal(
      evalRow(
        { container: ['project', { eq: [{ var: 'flagged' }, true] }] },
        { projectName: 'My Project', projectId: 'p1', projectFlagged: true },
        'tasks'
      ),
      true
    );
  });

  it('rejects project by flagged when not flagged', () => {
    assert.equal(
      evalRow(
        { container: ['project', { eq: [{ var: 'flagged' }, true] }] },
        { projectName: 'My Project', projectId: 'p1', projectFlagged: false },
        'tasks'
      ),
      false
    );
  });
});

describe('nodeEval — container (folder) throws', () => {
  it('throws for folder container', () => {
    assert.throws(
      () => predicate(
        { container: ['folder', { eq: [{ var: 'name' }, 'Legal'] }] },
        'tasks'
      ),
      /Folder container evaluation is not supported/
    );
  });
});

describe('nodeEval — stubVars (two-phase)', () => {
  it('stubbed variable returns true', () => {
    const stubs = new Set(['tags']);
    assert.equal(
      evalRow(
        { contains: [{ var: 'tags' }, 'work'] },
        { tags: undefined },
        'tasks',
        stubs
      ),
      true
    );
  });

  it('non-stubbed variables work normally alongside stubs', () => {
    const stubs = new Set(['tags']);
    // name is not stubbed, tags is stubbed
    assert.equal(
      evalRow(
        { and: [{ contains: [{ var: 'name' }, 'review'] }, { contains: [{ var: 'tags' }, 'work'] }] },
        { name: 'Weekly Review', tags: undefined },
        'tasks',
        stubs
      ),
      true  // name matches, tags stubbed as true
    );
    assert.equal(
      evalRow(
        { and: [{ contains: [{ var: 'name' }, 'review'] }, { contains: [{ var: 'tags' }, 'work'] }] },
        { name: 'Other Task', tags: undefined },
        'tasks',
        stubs
      ),
      false  // name doesn't match, even though tags is true
    );
  });
});

describe('nodeEval — tag entity', () => {
  it('reads tag name variable', () => {
    const fn = predicate({ var: 'name' }, 'tags');
    // Raw variable access returns the value as-is; normalization happens in comparison ops
    assert.equal(fn({ name: 'Work' }), 'Work');
  });

  it('reads allowsNextAction boolean', () => {
    assert.equal(evalRow({ eq: [{ var: 'allowsNextAction' }, true] }, { allowsNextAction: true }, 'tags'), true);
    assert.equal(evalRow({ eq: [{ var: 'allowsNextAction' }, false] }, { allowsNextAction: false }, 'tags'), true);
  });

  it('reads hidden boolean', () => {
    assert.equal(evalRow({ eq: [{ var: 'hidden' }, true] }, { hidden: true }, 'tags'), true);
    assert.equal(evalRow({ eq: [{ var: 'hidden' }, false] }, { hidden: false }, 'tags'), true);
  });

  it('compares availableTaskCount', () => {
    assert.equal(
      evalRow({ gt: [{ var: 'availableTaskCount' }, 0] }, { availableTaskCount: 5 }, 'tags'),
      true
    );
    assert.equal(
      evalRow({ gt: [{ var: 'availableTaskCount' }, 0] }, { availableTaskCount: 0 }, 'tags'),
      false
    );
  });

  it('filters by name contains', () => {
    assert.equal(
      evalRow({ contains: [{ var: 'name' }, 'work'] }, { name: 'Work Projects' }, 'tags'),
      true
    );
    assert.equal(
      evalRow({ contains: [{ var: 'name' }, 'personal'] }, { name: 'Work Projects' }, 'tags'),
      false
    );
  });

  it('combined filter: active tags with tasks', () => {
    assert.equal(
      evalRow(
        { and: [{ eq: [{ var: 'hidden' }, false] }, { gt: [{ var: 'availableTaskCount' }, 0] }] },
        { hidden: false, availableTaskCount: 3 },
        'tags'
      ),
      true
    );
    assert.equal(
      evalRow(
        { and: [{ eq: [{ var: 'hidden' }, false] }, { gt: [{ var: 'availableTaskCount' }, 0] }] },
        { hidden: true, availableTaskCount: 3 },
        'tags'
      ),
      false
    );
  });
});

describe('nodeEval — tag container', () => {
  it('throws for tag container (structural traversal needs OmniJS)', () => {
    assert.throws(
      () => predicate(
        { container: ['tag', { contains: [{ var: 'name' }, 'Work'] }] },
        'tags'
      ),
      /not supported in NodeEval/
    );
  });

  it('throws for project container on tags entity', () => {
    assert.throws(
      () => predicate(
        { container: ['project', { contains: [{ var: 'name' }, 'PHS'] }] },
        'tags'
      ),
      /not valid for tags/
    );
  });

  it('throws for folder container on tags entity', () => {
    assert.throws(
      () => predicate(
        { container: ['folder', { eq: [{ var: 'name' }, 'Legal'] }] },
        'tags'
      ),
      /not valid for tags/
    );
  });
});

describe('nodeEval — computed var alias (taskStatus)', () => {
  // Regression: taskStatus has nodeKey='status', but AddSwitch writes to
  // 'taskStatus'. The variable lookup must use the var name for computed
  // vars, not the nodeKey.
  it('eq(taskStatus, "Completed") matches row with taskStatus column', () => {
    assert.equal(
      evalRow(
        { eq: [{ var: 'taskStatus' }, 'Completed'] },
        { taskStatus: 'Completed' }
      ),
      true
    );
  });

  it('eq(taskStatus, "Completed") rejects row with different status', () => {
    assert.equal(
      evalRow(
        { eq: [{ var: 'taskStatus' }, 'Completed'] },
        { taskStatus: 'Active' }
      ),
      false
    );
  });

  it('neq(taskStatus, "completed") excludes completed tasks', () => {
    assert.equal(
      evalRow(
        { neq: [{ var: 'taskStatus' }, 'completed'] },
        { taskStatus: 'Completed' }
      ),
      false  // "Completed" normalizes to "completed", matches → neq is false
    );
  });

  it('status alias also works (nodeKey = var name)', () => {
    assert.equal(
      evalRow(
        { eq: [{ var: 'status' }, 'Completed'] },
        { status: 'Completed' }
      ),
      true
    );
  });
});

describe('nodeEval — complex expressions', () => {
  it('flagged + due within 7 days', () => {
    const now = new Date();
    const inThreeDays = new Date(now.getTime() + 3 * 86400000).toISOString();
    const inTenDays = new Date(now.getTime() + 10 * 86400000).toISOString();

    assert.equal(
      evalRow(
        { and: [{ eq: [{ var: 'flagged' }, true] }, { lte: [{ var: 'dueDate' }, { offset: { date: 'now', days: 7 } }] }] },
        { flagged: true, dueDate: inThreeDays }
      ),
      true
    );
    assert.equal(
      evalRow(
        { and: [{ eq: [{ var: 'flagged' }, true] }, { lte: [{ var: 'dueDate' }, { offset: { date: 'now', days: 7 } }] }] },
        { flagged: true, dueDate: inTenDays }
      ),
      false
    );
  });

  it('nested and/or', () => {
    assert.equal(
      evalRow(
        { and: [
          { or: [
            { eq: [{ var: 'flagged' }, true] },
            { contains: [{ var: 'tags' }, 'urgent'] }
          ]},
          { contains: [{ var: 'name' }, 'review'] }
        ]},
        { flagged: false, tags: ['urgent'], name: 'Weekly Review' }
      ),
      true
    );
  });
});
