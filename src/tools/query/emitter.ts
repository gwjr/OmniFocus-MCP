/**
 * Emitter Interface — codegen abstraction for script generation.
 *
 * An Emitter produces ScriptFragments from plan nodes. Fragments are
 * composable bodies that can be wrapped standalone or fused into a
 * single composite script to save osascript invocations.
 */

import type { BulkScan, MembershipScan } from './strategy.js';
import type { EntityType } from './variables.js';

// ── Fragment ─────────────────────────────────────────────────────────────

export interface ScriptFragment {
  /** Script body text. Assumes runtime setup (app/doc) in scope.
   *  Ends with `return <value>;`. No JSON.stringify, no IIFE wrapper. */
  body: string;
  /** What this fragment produces. */
  resultType: 'rows' | 'idSet';
}

// ── Emitter Interface ────────────────────────────────────────────────────

export interface Emitter {
  /** Generate fragment for a BulkScan. */
  propertyScan(node: BulkScan): ScriptFragment;
  /** Generate fragment for a MembershipScan. */
  membershipLookup(node: MembershipScan): ScriptFragment;
  /** Generate fragment for per-item reads (data-dependent, not fusible). */
  perItemRead(ids: string[], perItemVars: Set<string>, entity: EntityType): ScriptFragment;
  /** Wrap a single fragment as a standalone script (IIFE + setup + JSON.stringify). */
  wrapStandalone(fragment: ScriptFragment): string;
  /** Fuse multiple fragments into one composite script. */
  wrapComposite(fragments: ScriptFragment[]): string;
}
