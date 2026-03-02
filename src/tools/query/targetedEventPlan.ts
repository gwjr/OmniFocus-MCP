/**
 * TargetedEventPlan
 *
 * Takes the runtime-agnostic EventPlan SSA graph and assigns each node a
 * runtime, groups co-runtime nodes into batches, and produces an
 * execution-ordered TargetedEventPlan.
 *
 * This is a separate data structure from EventPlan — runtime annotations are
 * NOT part of the EventPlan IR.
 */

import type { EventNode, Ref, Runtime } from './eventPlan.js';

// ── TargetedEventPlan structure ───────────────────────────────────────────────

export interface Batch {
  index:     number;
  runtime:   Runtime;
  nodes:     Ref[];       // topologically ordered within batch
  dependsOn: number[];    // batch indices whose output this batch consumes
}

export interface TargetedEventPlan {
  nodes:   Array<EventNode & { runtime: Runtime; batch: number }>;
  batches: Batch[];
  result:  Ref;
}
