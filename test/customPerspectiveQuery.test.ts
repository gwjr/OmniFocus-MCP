import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  translateArchiveRules,
  customPerspectiveToQuery,
} from '../dist/tools/primitives/customPerspectiveQuery.js';

describe('translateArchiveRules', () => {
  it('maps completed availability to completed filter and includeCompleted', () => {
    const result = translateArchiveRules(
      [{ actionAvailability: 'completed' }],
      null,
    );

    assert.equal(result.includeCompleted, true);
    assert.deepEqual(result.where, { eq: [{ var: 'completed' }, true] });
  });

  it('ignores disabled rules', () => {
    const result = translateArchiveRules(
      [
        { disabledRule: { actionIsLeaf: true } },
        { actionAvailability: 'remaining' },
      ],
      'all',
    );

    assert.equal(result.where, undefined);
    assert.equal(result.includeCompleted, undefined);
  });

  it('maps within-focus to project/folder container OR by id', () => {
    const result = translateArchiveRules(
      [{ actionWithinFocus: ['proj1', 'folder1'] }],
      'all',
    );

    assert.deepEqual(result.where, {
      or: [
        { container: ['project', { in: [{ var: 'id' }, ['proj1', 'folder1']] }] },
        { container: ['folder', { in: [{ var: 'id' }, ['proj1', 'folder1']] }] },
      ],
    });
  });

  it('maps nested any/none aggregates from live archive shape', () => {
    const result = translateArchiveRules(
      [
        { actionAvailability: 'available' },
        {
          aggregateRules: [
            { actionHasTagWithStatus: 'onHold' },
          ],
          aggregateType: 'none',
        },
        { actionIsLeaf: true },
      ],
      'all',
      { onHoldTagNames: ['paused', 'waitingFor'] },
    );

    assert.deepEqual(result.where, {
      and: [
        { eq: [{ var: 'blocked' }, false] },
        { not: [{ or: [
          { contains: [{ var: 'tags' }, 'paused'] },
          { contains: [{ var: 'tags' }, 'waitingFor'] },
        ] }] },
        { eq: [{ var: 'hasChildren' }, false] },
      ],
    });
  });

  it('maps date-in-the-next defer rules to bounded date comparisons', () => {
    const result = translateArchiveRules(
      [{
        actionDateField: 'defer',
        actionDateIsInTheNext: {
          relativeAfterAmount: 2,
          relativeComponent: 'week',
        },
      }],
      'all',
    );

    assert.deepEqual(result.where, {
      and: [
        { isNotNull: [{ var: 'deferDate' }] },
        { gte: [{ var: 'deferDate' }, { var: 'now' }] },
        { lte: [{ var: 'deferDate' }, { offset: { date: 'now', days: 14 } }] },
      ],
    });
  });
});

describe('customPerspectiveToQuery', () => {
  it('converts a live-style custom perspective archive to task query params', () => {
    const query = customPerspectiveToQuery({
      id: 'biGtMGsZlgb',
      name: 'Active',
      type: 'custom',
      archivedTopLevelFilterAggregation: 'all',
      archivedFilterRules: [
        { actionAvailability: 'available' },
        {
          aggregateRules: [
            { actionHasTagWithStatus: 'onHold' },
          ],
          aggregateType: 'none',
        },
        { actionIsLeaf: true },
      ],
    }, { onHoldTagNames: ['paused', 'waitingFor'] });

    assert.equal(query.entity, 'tasks');
    assert.deepEqual(query.where, {
      and: [
        { eq: [{ var: 'blocked' }, false] },
        { not: [{ or: [
          { contains: [{ var: 'tags' }, 'paused'] },
          { contains: [{ var: 'tags' }, 'waitingFor'] },
        ] }] },
        { eq: [{ var: 'hasChildren' }, false] },
      ],
    });
    assert.equal(query.includeCompleted, undefined);
  });
});
