/**
 * JXA Bulk-Read Script Generator.
 *
 * Thin wrappers around JxaEmitter that produce standalone JXA scripts
 * (IIFE + JSON.stringify). These are used by the executor for non-fused
 * execution paths (legacy executePlan, per-item reads, etc.).
 *
 * For fused execution, the compile step uses JxaEmitter directly to
 * produce fragments and compose them into batch scripts.
 */

import { JxaEmitter } from './emitters/jxaEmitter.js';
import type { EntityType } from './variables.js';
import type { ExecutionPlan } from './planner.js';
import type { BulkScan, MembershipScan } from './planTree.js';
import { getVarRegistry } from './variables.js';

const emitter = new JxaEmitter();

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Generate a JXA script for phase 1 bulk-read of entity properties.
 * Legacy entry point — used by old ExecutionPlan-based callers.
 */
export function generateBulkReadScript(plan: ExecutionPlan, includeCompleted = false): string {
  const registry = getVarRegistry(plan.entity);

  // Build columns from bulkVars
  const columns: string[] = [];
  for (const varName of plan.bulkVars) {
    const def = registry[varName];
    if (def) columns.push(def.nodeKey);
  }

  // Two-phase and project-scoped need id
  const includeId = plan.path === 'two-phase' || plan.path === 'project-scoped';
  if (includeId && !columns.includes('id')) columns.push('id');

  const node: BulkScan = {
    kind: 'BulkScan',
    entity: plan.entity,
    columns,
    projectScope: plan.projectScope,
    includeCompleted,
  };

  return emitter.wrapStandalone(emitter.propertyScan(node));
}

/**
 * Generate a JXA script for phase 2 per-item reads by ID.
 */
export function generatePerItemReadScript(ids: string[], perItemVars: Set<string>, entity: EntityType = 'tasks'): string {
  return emitter.wrapStandalone(emitter.perItemRead(ids, perItemVars, entity));
}

/**
 * Generate a JXA bulk-read script from a BulkScan plan node.
 */
export function generateBulkReadFromColumns(node: BulkScan): string {
  return emitter.wrapStandalone(emitter.propertyScan(node));
}

/**
 * Generate a JXA membership lookup script from a MembershipScan node.
 */
export function generateMembershipScript(node: MembershipScan): string {
  return emitter.wrapStandalone(emitter.membershipLookup(node));
}
