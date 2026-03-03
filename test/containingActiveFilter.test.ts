/**
 * Tests for containing() active-filter injection.
 *
 * Bug: the containing() operator does NOT inject the active filter for
 * the child entity into its sub-scan. This means completed/dropped tasks
 * (or hidden tags, inactive projects) can match as children, producing
 * incorrect results.
 *
 * Expected: when querying `projects where containing('tasks', predicate)`,
 * the child task scan should include `not(effectivelyCompleted) AND
 * not(effectivelyDropped)` in its predicate — same as the active filter
 * that queryOmnifocus injects for top-level task queries.
 *
 * These tests inspect the SetIR plan structure (no OmniFocus needed).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSetIrPlan } from '../dist/tools/query/executionUnits/orchestrator.js';
import { lowerExpr }      from '../dist/tools/query/lower.js';
import { normalizeAst }   from '../dist/tools/query/normalizeAst.js';
import type { LoweredExpr } from '../dist/tools/query/fold.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively collect all Filter nodes from a SetIR tree. */
function collectFilters(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  const results: any[] = [];
  if (node.kind === 'Filter') results.push(node);
  for (const val of Object.values(node)) {
    results.push(...collectFilters(val));
  }
  return results;
}

/** Check if a predicate tree contains a specific {var: name} reference. */
function predicateReferencesVar(pred: any, varName: string): boolean {
  if (!pred || typeof pred !== 'object') return false;
  if (Array.isArray(pred)) return pred.some(p => predicateReferencesVar(p, varName));
  if ('var' in pred) return pred.var === varName;
  if ('op' in pred && Array.isArray(pred.args)) {
    return pred.args.some((a: any) => predicateReferencesVar(a, varName));
  }
  return false;
}

/** Build a containing() predicate, lower it, and produce a SetIR plan. */
function buildContainingPlan(
  parentEntity: 'projects' | 'tags' | 'folders',
  childEntity: string,
  childWhere: unknown,
): any {
  const compact = { containing: [childEntity, childWhere] };
  const lowered = normalizeAst(lowerExpr(compact as any) as LoweredExpr) as LoweredExpr;
  return buildSetIrPlan({
    entity: parentEntity,
    op: 'get',
    predicate: lowered,
    select: ['name'],
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('containing() active-filter injection — child task scans', () => {

  it('projects containing flagged tasks: child filter includes effectivelyCompleted exclusion', () => {
    const plan = buildContainingPlan('projects', 'tasks', { eq: [{ var: 'flagged' }, true] });

    // Find all Filter nodes in the plan — there should be one over tasks
    // with the child predicate. It should also reference effectivelyCompleted.
    const filters = collectFilters(plan);
    const taskFilters = filters.filter((f: any) => f.entity === 'tasks');

    assert.ok(
      taskFilters.length > 0,
      'Expected at least one Filter node on entity "tasks" in the containing plan',
    );

    const hasCompletedExclusion = taskFilters.some((f: any) =>
      predicateReferencesVar(f.predicate, 'effectivelyCompleted'),
    );

    assert.ok(
      hasCompletedExclusion,
      'Child task filter should include not(effectivelyCompleted) to exclude completed tasks, ' +
      'but no task Filter references effectivelyCompleted. ' +
      `Task filter predicates: ${JSON.stringify(taskFilters.map((f: any) => f.predicate))}`,
    );
  });

  it('projects containing flagged tasks: child filter includes effectivelyDropped exclusion', () => {
    const plan = buildContainingPlan('projects', 'tasks', { eq: [{ var: 'flagged' }, true] });

    const filters = collectFilters(plan);
    const taskFilters = filters.filter((f: any) => f.entity === 'tasks');

    const hasDroppedExclusion = taskFilters.some((f: any) =>
      predicateReferencesVar(f.predicate, 'effectivelyDropped'),
    );

    assert.ok(
      hasDroppedExclusion,
      'Child task filter should include not(effectivelyDropped) to exclude dropped tasks, ' +
      'but no task Filter references effectivelyDropped. ' +
      `Task filter predicates: ${JSON.stringify(taskFilters.map((f: any) => f.predicate))}`,
    );
  });

  it('tags containing flagged tasks: child filter includes effectivelyCompleted exclusion', () => {
    const plan = buildContainingPlan('tags', 'tasks', { eq: [{ var: 'flagged' }, true] });

    const filters = collectFilters(plan);
    const taskFilters = filters.filter((f: any) => f.entity === 'tasks');

    assert.ok(
      taskFilters.length > 0,
      'Expected at least one Filter node on entity "tasks" in the containing plan for tags',
    );

    const hasCompletedExclusion = taskFilters.some((f: any) =>
      predicateReferencesVar(f.predicate, 'effectivelyCompleted'),
    );

    assert.ok(
      hasCompletedExclusion,
      'Child task filter for tags containing() should include not(effectivelyCompleted), ' +
      `but found: ${JSON.stringify(taskFilters.map((f: any) => f.predicate))}`,
    );
  });

  it('folders containing tasks (two-hop via projects): child filter includes effectivelyCompleted exclusion', () => {
    const plan = buildContainingPlan('folders', 'tasks', { eq: [{ var: 'flagged' }, true] });

    const filters = collectFilters(plan);
    const taskFilters = filters.filter((f: any) => f.entity === 'tasks');

    assert.ok(
      taskFilters.length > 0,
      'Expected at least one Filter node on entity "tasks" in the two-hop containing plan',
    );

    const hasCompletedExclusion = taskFilters.some((f: any) =>
      predicateReferencesVar(f.predicate, 'effectivelyCompleted'),
    );

    assert.ok(
      hasCompletedExclusion,
      'Two-hop containing (folders→projects→tasks) should inject active filter on child tasks. ' +
      `Task filter predicates: ${JSON.stringify(taskFilters.map((f: any) => f.predicate))}`,
    );
  });

  it('projects containing tasks with no explicit predicate: active filter alone is used', () => {
    // containing('tasks', true) — no user predicate, just "has any active tasks"
    const compact = { containing: ['tasks', null] };
    const lowered = normalizeAst(lowerExpr(compact as any) as LoweredExpr) as LoweredExpr;
    const plan = buildSetIrPlan({
      entity: 'projects',
      op: 'get',
      predicate: lowered,
      select: ['name'],
    });

    const filters = collectFilters(plan);
    const taskFilters = filters.filter((f: any) => f.entity === 'tasks');

    // When childPred is null/true, the active filter should still be injected
    // so that only active (non-completed, non-dropped) tasks count.
    const hasCompletedExclusion = taskFilters.some((f: any) =>
      predicateReferencesVar(f.predicate, 'effectivelyCompleted'),
    );

    assert.ok(
      hasCompletedExclusion,
      'Even with no explicit child predicate, the active filter should be injected ' +
      'so completed tasks do not count as matches. ' +
      `Filters found: ${JSON.stringify(taskFilters.map((f: any) => f.predicate))}`,
    );
  });
});

describe('containing() active-filter injection — child project scans', () => {

  it('folders containing active projects: child filter includes status check', () => {
    // folders where containing('projects', {flagged: true})
    const plan = buildContainingPlan('folders', 'projects', { eq: [{ var: 'flagged' }, true] });

    const filters = collectFilters(plan);
    const projectFilters = filters.filter((f: any) => f.entity === 'projects');

    // The active filter for projects is: status in ['Active', 'OnHold']
    // This is a computed var so it may appear differently — check for 'status' reference
    // Actually, the active filter for projects at the LoweredExpr level is:
    //   { op: 'in', args: [{ var: 'status' }, ['Active', 'OnHold']] }
    // But 'status' for projects is a computed var (uses effectiveStatus AE prop).
    // What matters is that the predicate references 'status'.
    const hasStatusFilter = projectFilters.some((f: any) =>
      predicateReferencesVar(f.predicate, 'status'),
    );

    assert.ok(
      hasStatusFilter,
      'Child project filter for folders containing() should include status in [Active, OnHold], ' +
      `but found: ${JSON.stringify(projectFilters.map((f: any) => f.predicate))}`,
    );
  });
});
