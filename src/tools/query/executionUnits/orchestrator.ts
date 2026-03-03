/**
 * ExecutionUnit Orchestrator.
 *
 * Wires JXA and Node ExecutionUnits together into a runnable pipeline.
 *
 * Pipeline:
 *   StrategyNode → lowerStrategy → cseEventPlan → assignRuntimes
 *   → splitExecutionUnits → topoSort
 *   → fuse JXA units into composite osascript calls where possible
 *   → execute units in dependency order
 *   → thread results between units via shared results map
 *   → return final result
 */

import type { EventPlan, Ref } from '../eventPlan.js';
import type { TargetedEventPlan } from '../targetedEventPlan.js';
import type { ExecutionUnit } from '../targetedEventPlan.js';
import type { StrategyNode } from '../strategy.js';
import { assignRuntimes, splitExecutionUnits } from '../targetedEventPlanLowering.js';
import { lowerStrategy } from '../strategyToEventPlan.js';
import { cseEventPlan } from '../eventPlanCSE.js';
import { pruneColumns } from '../eventPlanColumnPrune.js';
import { emitJxaUnit } from './jxaUnit.js';
import { emitOmniJsUnit } from './omniJsUnit.js';
import { executeNodeUnit } from './nodeUnit.js';
import { executeJXA } from '../../../utils/scriptExecution.js';

// ── Topological sort ────────────────────────────────────────────────────

/**
 * Topologically sort ExecutionUnits by dependsOn, returning an execution
 * order where each unit appears after all its dependencies.
 */
function topoSort(units: ExecutionUnit[]): ExecutionUnit[] {
  const visited = new Set<ExecutionUnit>();
  const order: ExecutionUnit[] = [];

  function visit(unit: ExecutionUnit): void {
    if (visited.has(unit)) return;
    visited.add(unit);
    for (const dep of unit.dependsOn) {
      visit(dep);
    }
    order.push(unit);
  }

  for (const unit of units) {
    visit(unit);
  }

  return order;
}

// ── JXA-first schedule reordering ────────────────────────────────────────

/**
 * Reorder a topo-sorted schedule to group JXA units together, enabling
 * fusion into fewer osascript round-trips.
 *
 * Problem: topoSort respects dependencies but doesn't optimize for runtime
 * grouping. A JXA leaf unit may appear after an unrelated Node unit,
 * breaking the consecutive-JXA-run that the fusion pass needs.
 *
 * Solution: partition the schedule into waves. Within each wave, hoist all
 * JXA units whose dependencies are already satisfied ahead of non-JXA
 * units. This is safe because a JXA unit with satisfied deps can execute
 * before an unrelated Node unit without violating the dependency graph.
 */
export function fuseSchedule(sorted: ExecutionUnit[]): ExecutionUnit[] {
  const scheduled = new Set<ExecutionUnit>();
  const result: ExecutionUnit[] = [];

  // Iterate: in each pass, extract all ready units, JXA first.
  const remaining = new Set(sorted);

  while (remaining.size > 0) {
    // Find all units whose dependencies are satisfied
    const readyJxa: ExecutionUnit[] = [];
    const readyOther: ExecutionUnit[] = [];

    for (const unit of sorted) {
      if (!remaining.has(unit)) continue;
      const allDepsSatisfied = unit.dependsOn.every(dep => scheduled.has(dep));
      if (allDepsSatisfied) {
        if (unit.runtime === 'jxa') {
          readyJxa.push(unit);
        } else {
          readyOther.push(unit);
        }
      }
    }

    // Schedule JXA units first (so they fuse), then others
    for (const unit of readyJxa) {
      result.push(unit);
      scheduled.add(unit);
      remaining.delete(unit);
    }
    for (const unit of readyOther) {
      result.push(unit);
      scheduled.add(unit);
      remaining.delete(unit);
    }

    // Safety: if no progress was made, break to avoid infinite loop
    if (readyJxa.length === 0 && readyOther.length === 0) {
      // Shouldn't happen with a valid DAG, but push remaining in original order
      for (const unit of sorted) {
        if (remaining.has(unit)) {
          result.push(unit);
        }
      }
      break;
    }
  }

  return result;
}

// ── Exported refs ────────────────────────────────────────────────────────

/**
 * Compute the set of refs within a unit that are consumed by downstream
 * units. These are the refs the unit must return to the orchestrator.
 *
 * Always includes the unit's result ref. Also includes any internal ref
 * that appears in another unit's inputs list.
 */
export function computeExportedRefs(unit: ExecutionUnit, allUnits: ExecutionUnit[]): Ref[] {
  const nodeSet = new Set(unit.nodes);
  const exported = new Set<Ref>();
  exported.add(unit.result);

  for (const other of allUnits) {
    if (other === unit) continue;
    for (const inp of other.inputs) {
      if (nodeSet.has(inp)) {
        exported.add(inp);
      }
    }
  }

  // Return sorted for deterministic codegen
  return [...exported].sort((a, b) => a - b);
}

// ── JXA fusion ──────────────────────────────────────────────────────────

/**
 * Fuse multiple JXA units into a single composite osascript invocation.
 * Returns an array of results in the same order as the input units.
 *
 * Each unit becomes an IIFE slot in the composite script:
 *   (function() { var app = ...; var _r = []; _r[0] = ...; return JSON.stringify(_r); })()
 */
async function executeFusedJxaUnits(
  units: ExecutionUnit[],
  allUnits: ExecutionUnit[],
  plan: TargetedEventPlan,
  results: Map<Ref, unknown>,
): Promise<void> {
  if (units.length === 0) return;

  if (units.length === 1) {
    // Single unit — run standalone
    await executeSingleJxaUnit(units[0], allUnits, plan, results);
    return;
  }

  // Generate per-unit script bodies
  const perUnitExports: Ref[][] = [];
  const bodies: string[] = [];
  for (const unit of units) {
    const exports = computeExportedRefs(unit, allUnits);
    perUnitExports.push(exports);
    const inputs = buildInputMap(unit, results);
    const script = emitJxaUnit(unit, plan, inputs, exports);
    bodies.push(script);
  }

  // Build composite script: run each unit script as a slot, collect results
  const slots = bodies.map((body, i) =>
    `  _r[${i}] = JSON.parse((${body}));`
  ).join('\n');

  const compositeScript = `(function() {
  var _r = [];
${slots}
  return JSON.stringify(_r);
})()`;

  const rawResults = await executeJXA(compositeScript);

  // Distribute results to each unit's exported refs
  if (!Array.isArray(rawResults)) {
    throw new Error('orchestrator: composite JXA script did not return an array');
  }

  for (let i = 0; i < units.length; i++) {
    unpackResult(units[i], perUnitExports[i], rawResults[i], results);
  }
}

async function executeSingleJxaUnit(
  unit: ExecutionUnit,
  allUnits: ExecutionUnit[],
  plan: TargetedEventPlan,
  results: Map<Ref, unknown>,
): Promise<void> {
  const exports = computeExportedRefs(unit, allUnits);
  const inputs = buildInputMap(unit, results);
  const script = emitJxaUnit(unit, plan, inputs, exports);
  const rawResult = await executeJXA(script);
  unpackResult(unit, exports, rawResult, results);
}

// ── OmniJS execution ─────────────────────────────────────────────────────

/**
 * Execute a single OmniJS unit by wrapping the generated script in a JXA
 * evaluateJavascript() call. The OmniJS script returns JSON.stringify(result),
 * so the JXA bridge receives a JSON string which we parse back.
 */
async function executeSingleOmniJsUnit(
  unit: ExecutionUnit,
  allUnits: ExecutionUnit[],
  plan: TargetedEventPlan,
  results: Map<Ref, unknown>,
): Promise<void> {
  const exports = computeExportedRefs(unit, allUnits);
  const inputs = buildInputMap(unit, results);
  const omniScript = emitOmniJsUnit(unit, plan, inputs, exports);

  // Wrap in JXA: call evaluateJavascript() on OmniFocus, which runs the
  // OmniJS script inside the app. The OmniJS script returns a JSON string
  // via JSON.stringify(); evaluateJavascript() returns that string to JXA.
  const escaped = omniScript.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  const jxaWrapper = `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var raw = app.evaluateJavascript('${escaped}');
  return JSON.stringify(JSON.parse(raw));
})()`;

  const rawResult = await executeJXA(jxaWrapper);
  unpackResult(unit, exports, rawResult, results);
}

// ── Result unpacking ─────────────────────────────────────────────────────

/**
 * Unpack a unit's raw result into the shared results map.
 *
 * When exports has >1 ref, the raw result is an object keyed by ref string.
 * When exports has ≤1 ref, the raw result is the single value directly.
 */
export function unpackResult(
  unit: ExecutionUnit,
  exports: Ref[],
  rawResult: unknown,
  results: Map<Ref, unknown>,
): void {
  if (exports.length > 1) {
    // Multi-export: rawResult is { "refNum": value, ... }
    const map = rawResult as Record<string, unknown>;
    for (const ref of exports) {
      results.set(ref, map[String(ref)]);
    }
  } else {
    results.set(unit.result, rawResult);
  }
}

// ── Input mapping ───────────────────────────────────────────────────────

/**
 * Build the inputs map for a JXA unit: cross-unit input Ref → JS variable
 * name that will hold the serialized value in the JXA script.
 *
 * For JXA units, cross-unit inputs must be JSON-serialized into the script
 * as literal values. We generate inline JSON.parse() expressions.
 */
export function buildInputMap(
  unit: ExecutionUnit,
  results: Map<Ref, unknown>,
): Map<number, string> {
  const inputs = new Map<number, string>();
  for (const ref of unit.inputs) {
    const value = results.get(ref);
    if (value === undefined && !results.has(ref)) {
      throw new Error(`orchestrator: unresolved input ref %${ref} for ${unit.runtime} unit`);
    }
    // Inline the value as a JSON literal in the script
    inputs.set(ref, `JSON.parse(${JSON.stringify(JSON.stringify(value))})`);
  }
  return inputs;
}

// ── Public API ──────────────────────────────────────────────────────────

export interface OrchestratorResult {
  /** The final result value (typically a row array). */
  value: unknown;
  /** Per-unit timing in ms. */
  timings: { runtime: string; refs: number[]; ms: number }[];
}

/**
 * Execute a TargetedEventPlan by splitting into ExecutionUnits,
 * topologically sorting, and running each unit in order.
 *
 * JXA units at the same dependency depth are fused into a single
 * osascript invocation to minimize IPC overhead (~50ms per call).
 */
export async function executeTargetedPlan(
  plan: TargetedEventPlan,
): Promise<OrchestratorResult> {
  const units = splitExecutionUnits(plan);
  const sorted = fuseSchedule(topoSort(units));
  const results = new Map<Ref, unknown>();
  const timings: OrchestratorResult['timings'] = [];

  // Group consecutive JXA units that share the same dependency frontier
  // for fusion. For simplicity, we batch consecutive JXA units whose
  // dependencies are all already resolved.
  let i = 0;
  while (i < sorted.length) {
    const unit = sorted[i];

    if (unit.runtime === 'jxa') {
      // Collect a run of JXA units whose deps are all satisfied
      const batch: ExecutionUnit[] = [unit];
      let j = i + 1;
      while (j < sorted.length && sorted[j].runtime === 'jxa') {
        // Check if all deps are satisfied
        const allDepsSatisfied = sorted[j].dependsOn.every(dep =>
          results.has(dep.result)
        );
        if (allDepsSatisfied) {
          batch.push(sorted[j]);
          j++;
        } else {
          break;
        }
      }

      const t = Date.now();
      await executeFusedJxaUnits(batch, units, plan, results);
      const elapsed = Date.now() - t;
      for (const u of batch) {
        timings.push({ runtime: 'jxa', refs: u.nodes, ms: elapsed / batch.length });
      }
      i = j;

    } else if (unit.runtime === 'omniJS') {
      const t = Date.now();
      await executeSingleOmniJsUnit(unit, units, plan, results);
      timings.push({ runtime: 'omniJS', refs: unit.nodes, ms: Date.now() - t });
      i++;

    } else if (unit.runtime === 'node') {
      const t = Date.now();
      executeNodeUnit(unit, plan, results);
      timings.push({ runtime: 'node', refs: unit.nodes, ms: Date.now() - t });
      i++;

    } else {
      throw new Error(`orchestrator: unsupported runtime '${unit.runtime}'`);
    }
  }

  // Return the plan's overall result
  const finalValue = results.get(plan.result);
  return { value: finalValue, timings };
}

/**
 * Convenience: takes a raw EventPlan, assigns runtimes, and executes.
 */
export async function executeEventPlan(
  plan: EventPlan,
): Promise<OrchestratorResult> {
  const targeted = assignRuntimes(plan);
  return executeTargetedPlan(targeted);
}

// ── Full pipeline from StrategyNode ─────────────────────────────────────

/**
 * Sync helper: compile a StrategyNode all the way to a TargetedEventPlan
 * and ExecutionUnits, without executing. Useful for testing and debugging.
 */
export function compileEventPlan(node: StrategyNode): {
  targeted: TargetedEventPlan;
  units: ExecutionUnit[];
} {
  const eventPlan = lowerStrategy(node);
  const csed = cseEventPlan(eventPlan);
  const optimized = pruneColumns(csed);
  const targeted = assignRuntimes(optimized);
  const units = splitExecutionUnits(targeted);
  return { targeted, units };
}

/**
 * Full pipeline: StrategyNode → EventPlan → CSE → target → execute.
 *
 * This is the new-IR replacement for the old compileQuery + executeCompiledQuery
 * path. Wire this into queryOmnifocus.ts as the execution backend.
 */
export async function executeEventPlanPipeline(
  node: StrategyNode,
): Promise<OrchestratorResult> {
  const { targeted } = compileEventPlan(node);
  return executeTargetedPlan(targeted);
}
