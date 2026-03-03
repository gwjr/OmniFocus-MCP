/**
 * Tests for the `containing` operator (#49).
 *
 * The `containing` operator filters entities (typically projects) by the
 * existence of child entities (typically tasks) satisfying a predicate.
 *
 * Syntax:  { containing: ["tasks", predicate] }  on entity: "projects"
 * Meaning: projects where at least one active task satisfies predicate
 *
 * This is the reverse of `container`:
 *   container:  parent → child   (tasks in project where ...)
 *   containing: child → parent   (projects containing tasks where ...)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Describer tests ──────────────────────────────────────────────────────

import { describeExpr } from '../dist/tools/query/backends/describer.js';

describe('describeExpr — containing operator', () => {
  it('describes basic containing', () => {
    assert.equal(
      describeExpr({ containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] }),
      'containing tasks where flagged = true'
    );
  });

  it('describes containing with complex predicate', () => {
    assert.equal(
      describeExpr({
        containing: ['tasks', {
          and: [
            { eq: [{ var: 'flagged' }, true] },
            { lte: [{ var: 'dueDate' }, { offset: { date: 'now', days: 7 } }] }
          ]
        }]
      }),
      'containing tasks where (flagged = true) AND (dueDate <= 7 days from now)'
    );
  });

  it('describes containing combined with other predicates via and', () => {
    assert.equal(
      describeExpr({
        and: [
          { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
          { eq: [{ var: 'status' }, 'Active'] }
        ]
      }),
      '(containing tasks where flagged = true) AND (status = "Active")'
    );
  });

  it('describes containing with status predicate', () => {
    assert.equal(
      describeExpr({
        containing: ['tasks', { eq: [{ var: 'taskStatus' }, 'overdue'] }]
      }),
      'containing tasks where taskStatus = "overdue"'
    );
  });
});

// ── Lowering tests ───────────────────────────────────────────────────────

import { lowerExpr } from '../dist/tools/query/lower.js';
import { LowerError } from '../dist/tools/query/lower.js';

describe('lowerExpr — containing operator', () => {
  it('lowers containing to {op: "containing", args: ["tasks", loweredPredicate]}', () => {
    const result = lowerExpr({ containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] });
    assert.deepEqual(result, {
      op: 'containing',
      args: [
        'tasks',
        { op: 'eq', args: [{ var: 'flagged' }, true] }
      ]
    });
  });

  it('lowers containing with complex predicate', () => {
    const result = lowerExpr({
      containing: ['tasks', {
        and: [
          { eq: [{ var: 'flagged' }, true] },
          { contains: [{ var: 'name' }, 'review'] }
        ]
      }]
    });
    assert.deepEqual(result, {
      op: 'containing',
      args: [
        'tasks',
        {
          op: 'and',
          args: [
            { op: 'eq', args: [{ var: 'flagged' }, true] },
            { op: 'contains', args: [{ var: 'name' }, 'review'] }
          ]
        }
      ]
    });
  });

  it('rejects containing with wrong arg count (1 arg)', () => {
    assert.throws(
      () => lowerExpr({ containing: [{ eq: [{ var: 'flagged' }, true] }] }),
      (err: Error) => err instanceof LowerError
    );
  });

  it('rejects containing with wrong arg count (3 args)', () => {
    assert.throws(
      () => lowerExpr({ containing: ['tasks', { eq: [{ var: 'flagged' }, true] }, 'extra'] }),
      (err: Error) => err instanceof LowerError
    );
  });

  it('accepts any string as child entity (semantic validation is in planner)', () => {
    const result = lowerExpr({ containing: ['folders', { eq: [{ var: 'name' }, 'test'] }] });
    assert.ok(result);
    assert.deepStrictEqual((result as any).op, 'containing');
  });

  it('rejects containing with non-string child entity', () => {
    assert.throws(
      () => lowerExpr({ containing: [42, { eq: [{ var: 'flagged' }, true] }] }),
      (err: Error) => err instanceof LowerError
    );
  });
});
