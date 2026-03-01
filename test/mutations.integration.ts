/**
 * Integration tests for edit and move tools.
 *
 * Requires OmniFocus running. Creates fixture data, mutates, verifies, cleans up.
 * Run with: node --test test/mutations.integration.ts
 *
 * Skip in CI: these tests talk to a live OmniFocus instance.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { addProject } from '../dist/tools/primitives/addProject.js';
import { addOmniFocusTask } from '../dist/tools/primitives/addOmniFocusTask.js';
import { removeItem } from '../dist/tools/primitives/removeItem.js';
import { queryOmnifocus } from '../dist/tools/primitives/queryOmnifocus.js';
import { executeBatchEdit } from '../dist/tools/primitives/batchEdit.js';
import { executeBatchMove } from '../dist/tools/primitives/batchMove.js';
import { resolveTargets } from '../dist/tools/targeting.js';

// ── Fixture tracking ─────────────────────────────────────────────────────

const TEST_PREFIX = 'MCP_MUTATION_TEST';
const PROJECT_A = `${TEST_PREFIX} Project A`;
const PROJECT_B = `${TEST_PREFIX} Project B`;
const TASK_1 = `${TEST_PREFIX} Task 1`;
const TASK_2 = `${TEST_PREFIX} Task 2`;
const TASK_3 = `${TEST_PREFIX} Task 3`;

let projectAId: string;
let projectBId: string;
let task1Id: string;
let task2Id: string;
let task3Id: string;

// Helper: query for a single item by name
async function findByName(entity: 'tasks' | 'projects', name: string) {
  const result = await queryOmnifocus({
    entity,
    where: { eq: [{ var: 'name' }, name] },
    select: ['id', 'name', 'flagged', 'dueDate', 'deferDate', 'status'],
  });
  assert.ok(result.success, `query for ${name} failed: ${result.error}`);
  return result.items?.[0];
}

// Helper: query a task with tags
async function findTaskWithTags(name: string) {
  const result = await queryOmnifocus({
    entity: 'tasks',
    where: { eq: [{ var: 'name' }, name] },
    select: ['id', 'name', 'flagged', 'dueDate', 'deferDate', 'tags', 'status', 'projectName'],
  });
  assert.ok(result.success, `query for ${name} failed: ${result.error}`);
  return result.items?.[0];
}

describe('mutations integration', () => {

  // ── Setup ──────────────────────────────────────────────────────────────
  before(async () => {
    // Create two test projects
    const pA = await addProject({ name: PROJECT_A });
    assert.ok(pA.success, `Failed to create ${PROJECT_A}: ${pA.error}`);
    projectAId = pA.projectId!;

    const pB = await addProject({ name: PROJECT_B });
    assert.ok(pB.success, `Failed to create ${PROJECT_B}: ${pB.error}`);
    projectBId = pB.projectId!;

    // Create test tasks in Project A
    const t1 = await addOmniFocusTask({ name: TASK_1, projectName: PROJECT_A });
    assert.ok(t1.success, `Failed to create ${TASK_1}: ${t1.error}`);
    task1Id = t1.taskId!;

    const t2 = await addOmniFocusTask({ name: TASK_2, projectName: PROJECT_A });
    assert.ok(t2.success, `Failed to create ${TASK_2}: ${t2.error}`);
    task2Id = t2.taskId!;

    const t3 = await addOmniFocusTask({ name: TASK_3, projectName: PROJECT_A });
    assert.ok(t3.success, `Failed to create ${TASK_3}: ${t3.error}`);
    task3Id = t3.taskId!;

    console.error(`[setup] Created: ${PROJECT_A} (${projectAId}), ${PROJECT_B} (${projectBId})`);
    console.error(`[setup] Tasks: ${task1Id}, ${task2Id}, ${task3Id}`);
  });

  // ── Teardown ───────────────────────────────────────────────────────────
  after(async () => {
    // Remove in reverse order: tasks first (move them back if needed), then projects
    for (const id of [task1Id, task2Id, task3Id]) {
      if (id) {
        try { await removeItem({ id, itemType: 'task' }); } catch { /* ignore */ }
      }
    }
    for (const id of [projectAId, projectBId]) {
      if (id) {
        try { await removeItem({ id, itemType: 'project' }); } catch { /* ignore */ }
      }
    }
    console.error('[teardown] Fixtures removed.');
  });

  // ── Edit: flag a task ──────────────────────────────────────────────────
  it('edit single: flag a task', async () => {
    const result = await executeBatchEdit({
      ids: [task1Id],
      entity: 'tasks',
      set: { flagged: true },
    });
    assert.ok(result.success, `Edit failed: ${result.error}`);

    const item = await findByName('tasks', TASK_1);
    assert.ok(item, 'Task not found after edit');
    assert.equal(item.flagged, true, 'Task should be flagged');

    // Unflag to reset
    await executeBatchEdit({ ids: [task1Id], entity: 'tasks', set: { flagged: false } });
  });

  // ── Edit: set and clear due date ───────────────────────────────────────
  it('edit dates: set due date then clear', async () => {
    const dueDate = '2026-06-15T12:00:00';
    const setResult = await executeBatchEdit({
      ids: [task1Id],
      entity: 'tasks',
      set: { dueDate },
    });
    assert.ok(setResult.success, `Set due date failed: ${setResult.error}`);

    let item = await findByName('tasks', TASK_1);
    assert.ok(item?.dueDate, 'Due date should be set');
    // Verify the date is approximately correct (same day)
    assert.ok(item.dueDate.startsWith('2026-06-15'), `Due date should be 2026-06-15, got ${item.dueDate}`);

    // Clear
    const clearResult = await executeBatchEdit({
      ids: [task1Id],
      entity: 'tasks',
      set: { dueDate: null },
    });
    assert.ok(clearResult.success, `Clear due date failed: ${clearResult.error}`);

    item = await findByName('tasks', TASK_1);
    assert.equal(item?.dueDate, null, 'Due date should be cleared');
  });

  // ── Edit: offset dates ─────────────────────────────────────────────────
  it('edit offset: shift due date by +7 days', async () => {
    // First set a known due date
    await executeBatchEdit({
      ids: [task2Id],
      entity: 'tasks',
      set: { dueDate: '2026-07-01T12:00:00' },
    });

    // Offset by +7
    const result = await executeBatchEdit({
      ids: [task2Id],
      entity: 'tasks',
      offset: { dueDate: { days: 7 } },
    });
    assert.ok(result.success, `Offset failed: ${result.error}`);

    const item = await findByName('tasks', TASK_2);
    assert.ok(item?.dueDate, 'Due date should still be set');
    assert.ok(item.dueDate.startsWith('2026-07-08'), `Due date should be ~2026-07-08, got ${item.dueDate}`);

    // Clean up
    await executeBatchEdit({ ids: [task2Id], entity: 'tasks', set: { dueDate: null } });
  });

  // ── Edit: add nonexistent tag → error ──────────────────────────────────
  it('edit tags: nonexistent tag → error', async () => {
    const result = await executeBatchEdit({
      ids: [task1Id],
      entity: 'tasks',
      addTags: [`${TEST_PREFIX}_NONEXISTENT_TAG_${Date.now()}`],
    });
    assert.equal(result.success, false, 'Should fail for nonexistent tag');
    assert.ok(result.results?.[0]?.error?.includes('Tag not found'), `Error should mention tag not found, got: ${JSON.stringify(result.results)}`);
  });

  // ── Edit: mark complete / active ───────────────────────────────────────
  it('edit mark: complete then reactivate', async () => {
    // Mark complete
    let result = await executeBatchEdit({
      ids: [task3Id],
      entity: 'tasks',
      mark: 'completed',
    });
    assert.ok(result.success, `Mark complete failed: ${result.error}`);

    // Verify: task should NOT appear in a normal (active-only) query
    let qr = await queryOmnifocus({
      entity: 'tasks',
      where: { eq: [{ var: 'name' }, TASK_3] },
      select: ['id', 'name'],
    });
    assert.ok(qr.success);
    assert.equal(qr.items?.length ?? 0, 0, 'Completed task should not appear in active query');

    // Mark active
    result = await executeBatchEdit({
      ids: [task3Id],
      entity: 'tasks',
      mark: 'active',
    });
    assert.ok(result.success, `Mark active failed: ${result.error}`);

    // Should be active again — visible in normal query
    const item = await findByName('tasks', TASK_3);
    assert.ok(item, 'Task should be active and visible again');
  });

  // ── Move: task to different project ────────────────────────────────────
  it('move task to different project', async () => {
    const result = await executeBatchMove({
      ids: [task1Id],
      entity: 'tasks',
      toProjectId: projectBId,
    });
    assert.ok(result.success, `Move failed: ${result.error}`);

    const item = await findTaskWithTags(TASK_1);
    assert.ok(item, 'Task should still exist');
    assert.equal(item.projectName, PROJECT_B, `Task should now be in ${PROJECT_B}`);

    // Move back to Project A for subsequent tests
    await executeBatchMove({ ids: [task1Id], entity: 'tasks', toProjectId: projectAId });
  });

  // ── Move: task to inbox ────────────────────────────────────────────────
  it('move task to inbox', async () => {
    const result = await executeBatchMove({
      ids: [task2Id],
      entity: 'tasks',
      toInbox: true,
    });
    assert.ok(result.success, `Move to inbox failed: ${result.error}`);

    const item = await findTaskWithTags(TASK_2);
    assert.ok(item, 'Task should exist');
    // In inbox, projectName should be null or "Inbox"
    assert.ok(!item.projectName || item.projectName === 'Inbox',
      `Task should be in inbox, got projectName: ${item.projectName}`);

    // Move back
    await executeBatchMove({ ids: [task2Id], entity: 'tasks', toProjectId: projectAId });
  });

  // ── Batch edit: multiple tasks ─────────────────────────────────────────
  it('batch edit: flag multiple tasks', async () => {
    // Use only task1 and task2 — task3 might be completed from mark test
    const result = await executeBatchEdit({
      ids: [task1Id, task2Id],
      entity: 'tasks',
      set: { flagged: true },
    });
    assert.ok(result.success, `Batch edit failed: ${result.error}`);
    assert.equal(result.results?.length, 2, 'Should have 2 results');
    assert.ok(result.results?.every(r => r.success), 'All should succeed');

    // Verify both flagged
    for (const name of [TASK_1, TASK_2]) {
      const item = await findByName('tasks', name);
      assert.equal(item?.flagged, true, `${name} should be flagged`);
    }

    // Unflag both
    await executeBatchEdit({
      ids: [task1Id, task2Id],
      entity: 'tasks',
      set: { flagged: false },
    });
  });

  // ── DryRun: query targeting ────────────────────────────────────────────
  it('dry run: query targeting previews without mutating', async () => {
    // Ensure task1 is unflagged for a clean baseline
    await executeBatchEdit({ ids: [task1Id], entity: 'tasks', set: { flagged: false } });

    let item = await findByName('tasks', TASK_1);
    assert.equal(item?.flagged, false, 'Task should not be flagged before dry run');

    // Resolve targets via query (same as what edit handler does)
    let resolved;
    try {
      resolved = await resolveTargets({
        query: {
          entity: 'tasks',
          where: { eq: [{ var: 'name' }, TASK_1] },
        },
      });
    } catch (e: any) {
      assert.fail(`resolveTargets threw: ${e.message}`);
    }
    assert.ok(resolved!.ids.length > 0, 'Should find at least one target');
    assert.ok(resolved.previews, 'Should have previews for query targeting');
    assert.ok(resolved.previews.some(p => p.name === TASK_1), 'Previews should include task name');

    // Verify nothing changed (we didn't call executeBatchEdit)
    item = await findByName('tasks', TASK_1);
    assert.equal(item?.flagged, false, 'Task should still not be flagged after dry-run resolve');
  });

});
