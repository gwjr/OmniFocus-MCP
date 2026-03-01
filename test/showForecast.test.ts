import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bucketTasks } from '../dist/tools/primitives/showForecast.js';

describe('bucketTasks', () => {
  const today = '2026-03-01';
  const days = 3; // window: Mar 1 (today), Mar 2, Mar 3

  it('returns correct bucket count: Past + Today + (days-1) day buckets + Future', () => {
    const { buckets } = bucketTasks([], today, days);
    assert.equal(buckets.length, 5); // Past, Today, Mar 2, Mar 3, Future
    assert.equal(buckets[0].label, 'Past');
    assert.ok(buckets[1].label.startsWith('Today'));
    assert.equal(buckets[buckets.length - 1].label, 'Future');
  });

  it('buckets a task due today into Today', () => {
    const tasks = [{ id: 'a', dueDate: '2026-03-01T12:00:00.000Z', deferDate: null, plannedDate: null, flagged: false }];
    const { buckets } = bucketTasks(tasks, today, days);
    assert.equal(buckets[1].due, 1);
    assert.equal(buckets[1].taskIds.size, 1);
  });

  it('buckets a task due yesterday into Past', () => {
    const tasks = [{ id: 'a', dueDate: '2026-02-28T12:00:00.000Z', deferDate: null, plannedDate: null, flagged: false }];
    const { buckets } = bucketTasks(tasks, today, days);
    assert.equal(buckets[0].due, 1);
    assert.equal(buckets[0].taskIds.size, 1);
  });

  it('buckets a task due beyond the window into Future', () => {
    const tasks = [{ id: 'a', dueDate: '2026-03-10T12:00:00.000Z', deferDate: null, plannedDate: null, flagged: false }];
    const { buckets } = bucketTasks(tasks, today, days);
    const future = buckets[buckets.length - 1];
    assert.equal(future.due, 1);
  });

  it('separates due, planned, and deferred counts', () => {
    const tasks = [{
      id: 'a',
      dueDate: '2026-03-01T12:00:00.000Z',
      plannedDate: '2026-03-02T12:00:00.000Z',
      deferDate: '2026-03-03T12:00:00.000Z',
      flagged: false,
    }];
    const { buckets } = bucketTasks(tasks, today, days);
    assert.equal(buckets[1].due, 1);       // Today: due
    assert.equal(buckets[2].planned, 1);   // Mar 2: planned
    assert.equal(buckets[3].deferred, 1);  // Mar 3: deferred
  });

  it('deduplicates taskIds when multiple dates fall on same day', () => {
    const tasks = [{
      id: 'a',
      dueDate: '2026-03-01T10:00:00.000Z',
      plannedDate: '2026-03-01T14:00:00.000Z',
      deferDate: null,
      flagged: false,
    }];
    const { buckets } = bucketTasks(tasks, today, days);
    assert.equal(buckets[1].due, 1);
    assert.equal(buckets[1].planned, 1);
    assert.equal(buckets[1].taskIds.size, 1);
  });

  it('counts flagged tasks', () => {
    const tasks = [
      { id: 'a', dueDate: '2026-03-01T12:00:00.000Z', deferDate: null, plannedDate: null, flagged: true },
      { id: 'b', dueDate: '2026-03-01T12:00:00.000Z', deferDate: null, plannedDate: null, flagged: false },
      { id: 'c', dueDate: null, deferDate: null, plannedDate: null, flagged: true },
    ];
    const { flaggedCount } = bucketTasks(tasks, today, days);
    assert.equal(flaggedCount, 2);
  });

  it('task with all null dates appears in no bucket', () => {
    const tasks = [{ id: 'a', dueDate: null, deferDate: null, plannedDate: null, flagged: false }];
    const { buckets, totalUniqueTasks } = bucketTasks(tasks, today, days);
    for (const b of buckets) assert.equal(b.taskIds.size, 0);
    assert.equal(totalUniqueTasks, 0);
  });

  it('empty task list returns zeroed buckets', () => {
    const { buckets, flaggedCount, totalUniqueTasks } = bucketTasks([], today, days);
    assert.equal(flaggedCount, 0);
    assert.equal(totalUniqueTasks, 0);
    for (const b of buckets) {
      assert.equal(b.due, 0);
      assert.equal(b.planned, 0);
      assert.equal(b.deferred, 0);
    }
  });

  it('totalUniqueTasks counts across all buckets', () => {
    const tasks = [
      { id: 'a', dueDate: '2026-02-28T12:00:00.000Z', deferDate: null, plannedDate: null, flagged: false },
      { id: 'b', dueDate: '2026-03-01T12:00:00.000Z', deferDate: null, plannedDate: null, flagged: false },
      { id: 'c', dueDate: '2026-03-10T12:00:00.000Z', deferDate: null, plannedDate: null, flagged: false },
    ];
    const { totalUniqueTasks } = bucketTasks(tasks, today, days);
    assert.equal(totalUniqueTasks, 3);
  });

  it('task appearing in multiple buckets via different dates counted once in total', () => {
    const tasks = [{
      id: 'a',
      dueDate: '2026-02-28T12:00:00.000Z',
      plannedDate: '2026-03-01T12:00:00.000Z',
      deferDate: '2026-03-10T12:00:00.000Z',
      flagged: false,
    }];
    const { totalUniqueTasks } = bucketTasks(tasks, today, days);
    assert.equal(totalUniqueTasks, 1);
  });

  it('days=1 produces only Past, Today, Future', () => {
    const { buckets } = bucketTasks([], today, 1);
    assert.equal(buckets.length, 3);
    assert.equal(buckets[0].label, 'Past');
    assert.ok(buckets[1].label.startsWith('Today'));
    assert.equal(buckets[2].label, 'Future');
  });
});
