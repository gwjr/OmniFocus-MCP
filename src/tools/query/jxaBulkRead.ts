/**
 * JXA Bulk-Read Script Generator.
 *
 * Thin wrappers around JxaEmitter that produce standalone JXA scripts
 * (IIFE + JSON.stringify). These are used by the executor for per-item
 * reads and non-fused execution paths.
 *
 * For fused execution, the compile step uses JxaEmitter directly to
 * produce fragments and compose them into batch scripts.
 */

import { JxaEmitter } from './emitters/jxaEmitter.js';
import type { EntityType } from './variables.js';
import type { BulkScan, MembershipScan } from './planTree.js';

const emitter = new JxaEmitter();

// ── Public API ──────────────────────────────────────────────────────────

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
