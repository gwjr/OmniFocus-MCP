/**
 * TargetedEventPlan and ExecutionUnit
 *
 * After runtime assignment and optimization, an EventPlan is split into
 * ExecutionUnits — contiguous per-runtime subgraphs. Each ExecutionUnit
 * knows its runtime and the nodes it owns; codegens are per-unit.
 */

import type { EventNode, Ref, Runtime, RuntimeAllocation } from './eventPlan.js';

// ── TargetedNode ──────────────────────────────────────────────────────────────

/**
 * An EventNode annotated with its runtime allocation.
 * Every node in a TargetedEventPlan has a non-optional runtimeAllocation.
 */
export type TargetedNode = EventNode & { runtimeAllocation: RuntimeAllocation };

// ── TargetedEventPlan ────────────────────────────────────────────────────────

/**
 * An EventPlan where every node has been assigned a runtime.
 * This is the input to the optimization passes and the splitter.
 */
export interface TargetedEventPlan {
  nodes:  TargetedNode[];   // dense array, index = Ref (no null slots)
  result: Ref;
}

// ── ExecutionUnit ─────────────────────────────────────────────────────────────

/**
 * A contiguous per-runtime subgraph produced by splitExecutionUnits().
 *
 * nodes: the EventNode slice owned by this unit (refs relative to the
 *        full plan — consumers resolve cross-unit refs via inputs).
 * inputs: refs from other units whose values this unit consumes.
 * result: the ref whose value this unit exposes to downstream units.
 *
 * Each unit's codegen/executor is responsible for materializing its nodes
 * and returning the result value.
 */
export interface ExecutionUnit {
  runtime:    Runtime;
  nodes:      Ref[];        // refs into the full TargetedEventPlan
  inputs:     Ref[];        // cross-unit input refs (produced by upstream units)
  result:     Ref;          // the ref this unit exposes downstream
  dependsOn:  ExecutionUnit[];
}
