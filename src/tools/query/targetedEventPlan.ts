/**
 * TargetedEventPlan and ExecutionUnit
 *
 * After runtime assignment and optimization, an EventPlan is split into
 * ExecutionUnits — contiguous per-runtime subgraphs. Each ExecutionUnit
 * knows its runtime and the nodes it owns; codegens are per-unit.
 */

import type { EventNode, Ref, Runtime, RuntimeAllocation, Specifier } from './eventPlan.js';

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

// ── EU boundary bindings ─────────────────────────────────────────────────────

/**
 * How a cross-unit value enters an ExecutionUnit.
 *
 * - 'value': the producing unit serializes the value as JSON and this unit
 *   deserializes it with JSON.parse(). This is the common case and is a
 *   no-op for node→jxa or jxa→node transitions where the value is already
 *   JSON-safe (arrays, strings, numbers, nulls).
 *
 * - 'specifier': the value is an AE specifier (non-materializing Get) that
 *   cannot be JSON-serialized. The consuming JXA unit reconstructs the
 *   specifier from `spec` instead of deserializing a runtime value.
 */
export type Input =
  | { ref: Ref; kind: 'value' }
  | { ref: Ref; kind: 'specifier'; spec: Specifier };

/**
 * How a cross-unit value leaves an ExecutionUnit.
 *
 * - 'value': the producing unit includes the value in its JSON.stringify()
 *   return. This is the common case.
 *
 * - 'specifier': the value is an AE specifier that cannot be serialized.
 *   The producing unit omits it from the return value; the consuming unit
 *   reconstructs it from the specifier definition in its Input binding.
 */
export type Output =
  | { ref: Ref; kind: 'value' }
  | { ref: Ref; kind: 'specifier' };

// ── ExecutionUnit ─────────────────────────────────────────────────────────────

/**
 * A contiguous per-runtime subgraph produced by splitExecutionUnits().
 *
 * nodes: the EventNode slice owned by this unit (refs relative to the
 *        full plan — consumers resolve cross-unit refs via inputs).
 * inputs/outputs: the unit's boundary contract. Each entry describes how
 *        a cross-unit value is serialized (output) or deserialized (input).
 *        Often no-ops ('value' kind), but AE specifier refs require
 *        explicit reconstruction ('specifier' kind).
 * result: the ref whose value this unit exposes to downstream units.
 *
 * Each unit's codegen/executor is responsible for materializing its nodes
 * and returning the result value.
 */
export interface ExecutionUnit {
  runtime:    Runtime;
  nodes:      Ref[];        // refs into the full TargetedEventPlan
  inputs:     Input[];      // cross-unit input bindings
  outputs:    Output[];     // cross-unit output bindings
  result:     Ref;          // the ref this unit exposes downstream
  dependsOn:  ExecutionUnit[];
}
