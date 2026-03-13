/**
 * ExecutionUnit Orchestrator.
 *
 * Wires JXA and Node ExecutionUnits together into a runnable pipeline.
 *
 * Pipeline:
 *   predicate+entity → SetIR → EventPlan → assignRuntimes → splitExecutionUnits → topoSort
 *   → fuse JXA units into composite osascript calls where possible
 *   → execute units in dependency order
 *   → thread results between units via shared results map
 *   → return final result
 *
 * Public API:
 *   executeQueryFromAst — full pipeline from lowered predicate to results
 *   executeEventPlan    — convenience entry from a raw EventPlan
 *   executeTargetedPlan — entry from a TargetedEventPlan
 *   inspectEventPlan    — static analysis: units + emitted scripts (no execution)
 */

import type { EventPlan, Ref } from '../eventPlan.js';
import type { TargetedEventPlan } from '../targetedEventPlan.js';
import type { ExecutionUnit } from '../targetedEventPlan.js';
import { assignRuntimes, splitExecutionUnits, computeBindings } from '../targetedEventPlanLowering.js';
import { cseEventPlan } from '../eventPlanCSE.js';
import { pruneColumns } from '../eventPlanColumnPrune.js';
import { reorderEventPlan } from '../eventPlanReorder.js';
import { mergeSemiJoins } from '../eventPlanMergeSemiJoins.js';
import { emitJxaUnit } from './jxaUnit.js';
import { executeNodeUnit } from './nodeUnit.js';
import { executeJXA } from '../../../utils/scriptExecution.js';
import { lowerToSetIr, optimizeSetIr, collectVarNames } from '../lowerToSetIr.js';
import { lowerSetIrToEventPlan } from '../lowerSetIrToEventPlan.js';
import type { LoweredExpr } from '../fold.js';
import { isTaskOnlyVar, type EntityType } from '../variables.js';
import { enrichByIdentifier, canEnrichColumn } from '../../../utils/omniJsEnrich.js';
import { extractLinks } from '../../../utils/extractLinks.js';
import type { Row } from '../backends/nodeEval.js';
import { composeAsyncPasses, composePasses, type ExecutePass, type LowerPass, type OptimizePass } from '../pipeline.js';
import type { SetIrNode } from '../setIr.js';

// ── Custom post-query enrichment registry ─────────────────────────────────
//
// Columns that can't be read via the standard AE bulk pipeline or OmniJS
// enrichment. Each entry specifies which entities it applies to and a
// function that takes (ids, entity) → Map<id, value>.
//
// The orchestrator strips these columns from the select list before plan
// generation, then enriches the results after the main query completes.

interface CustomEnrichment {
  /** Entity types this enrichment applies to. */
  entities: Set<EntityType>;
  /** Fetch values for the given IDs. Returns Map from ID → column value. */
  fetch: (ids: string[], entity: EntityType) => Promise<Map<string, unknown>>;
  /** Default value for items not found in the enrichment map. */
  defaultValue: unknown;
  /** Label for timing output. */
  timingLabel: string;
}

const CUSTOM_ENRICHMENTS: Record<string, CustomEnrichment> = {
  links: {
    entities: new Set(['tasks', 'projects']),
    timingLabel: 'jxa-links',
    defaultValue: [],
    fetch: async (ids, entity) => {
      const singular = entity === 'tasks' ? 'task' as const : 'project' as const;
      return extractLinks(ids, singular);
    },
  },
};

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
 * units as serialized values. These are the refs the unit must include
 * in its JSON.stringify return.
 *
 * Includes the unit's result ref (unless it's only consumed as a
 * specifier). Also includes any internal ref that appears in another
 * unit's value-kind inputs list.
 *
 * Specifier-kind inputs are excluded — they are reconstructed in the
 * consuming unit and don't need to be serialized by this unit.
 */
export function computeExportedRefs(unit: ExecutionUnit, allUnits: ExecutionUnit[]): Ref[] {
  const nodeSet = new Set(unit.nodes);
  const exported = new Set<Ref>();

  // Collect refs consumed as values by other units
  for (const other of allUnits) {
    if (other === unit) continue;
    for (const inp of other.inputs) {
      if (inp.kind === 'specifier') continue;  // reconstructed, not serialized
      if (nodeSet.has(inp.ref)) {
        exported.add(inp.ref);
      }
    }
  }

  // Always include the result ref — the orchestrator reads it for the
  // final plan result. Only omit if an output binding explicitly marks
  // it as specifier-kind (non-serializable).
  const resultOutput = unit.outputs.find(o => o.ref === unit.result);
  if (!resultOutput || resultOutput.kind !== 'specifier') {
    exported.add(unit.result);
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

  // Generate per-unit script bodies (raw mode: skip inner JSON.stringify
  // since the composite wrapper handles serialisation once at the end)
  const perUnitExports: Ref[][] = [];
  const bodies: string[] = [];
  for (const unit of units) {
    const exports = computeExportedRefs(unit, allUnits);
    perUnitExports.push(exports);
    const inputs = buildInputMap(unit, results);
    const script = emitJxaUnit(unit, plan, inputs, exports, { raw: true });
    bodies.push(script);
  }

  // Build composite script: run each unit IIFE and collect raw results
  const slots = bodies.map((body, i) =>
    `  _r[${i}] = (${body});`
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
  for (const input of unit.inputs) {
    if (input.kind === 'specifier') {
      // Specifier inputs are reconstructed by the emitter — no runtime value needed.
      // The emitter handles these via the Input binding's spec field.
      continue;
    }
    const value = results.get(input.ref);
    if (value === undefined && !results.has(input.ref)) {
      throw new Error(`orchestrator: unresolved input ref %${input.ref} for ${unit.runtime} unit`);
    }
    // Inline the value as a JSON literal in the script
    inputs.set(input.ref, `JSON.parse(${JSON.stringify(JSON.stringify(value))})`);
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
  computeBindings(units, plan);
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
  return executeEventPlanPipeline(plan);
}

// ── Query pipeline entry point ───────────────────────────────────────────────

export interface QueryPlanParams {
  /** Lowered, normalised predicate (with active filter already injected). */
  predicate: LoweredExpr | true;
  entity: EntityType;
  op: 'get' | 'count' | 'exists';
  /** Output columns requested. */
  select?: string[];
  sort?: { by: string; direction?: 'asc' | 'desc' };
  limit?: number;
}

/**
 * Full pipeline from a lowered predicate to query results.
 *
 * Handles: lowerToSetIr → project-exclusion (tasks) → Sort/Limit →
 *   optimizeSetIr → lowerSetIrToEventPlan → cseEventPlan → pruneColumns →
 *   mergeSemiJoins → executeEventPlan → OrchestratorResult
 *
 * The caller is responsible for lowering the compact where clause, normalising
 * the AST, and injecting any active-filter predicates before calling this.
 */
/**
 * Determine whether the project-exclusion Difference node is needed for a
 * task query.  Returns true when the Difference MUST be present; false when
 * every variable referenced by the predicate and select list is task-only
 * (i.e. absent from the project var registry), making it impossible for
 * project rows to survive the filter — so the Difference is a no-op.
 *
 * Edge cases:
 *   - predicate === true (no filter): projects would pass → return true.
 *   - Empty var set after analysis: means the predicate is trivially true
 *     for all rows (e.g. true literal) — projects included → return true.
 */
function needsProjectExclusion(
  predicate: LoweredExpr | true,
  select: string[] | undefined,
): boolean {
  // No predicate → every row passes, including project rows.
  if (predicate === true) return true;

  const vars = collectVarNames(predicate);
  if (select) {
    for (const col of select) vars.add(col);
  }

  // No vars at all → trivially true predicate; projects pass through.
  if (vars.size === 0) return true;

  // If any referenced var exists in BOTH task and project registries,
  // a project row could match → Difference required.
  for (const v of vars) {
    if (!isTaskOnlyVar(v)) return true;
  }

  return false;
}

/**
 * Build the SetIR plan for a query — pure, no I/O.
 *
 * Order of operations:
 *   1. Lower predicate + select columns to SetIR (op:'get' — no terminal wrapping yet)
 *   2. Subtract project root tasks for task queries (projects appear in flattenedTasks)
 *   3. Apply terminal wrapping (Count / Limit / Sort) for the actual op
 *
 * Count/Limit must come AFTER project-exclusion so they operate on the
 * already-filtered row set, not on a terminal scalar.
 */
export function buildSetIrPlan(params: QueryPlanParams): import('../setIr.js').SetIrNode {
  const { predicate, entity, op, select, sort, limit } = params;

  // Step 1: lower predicate + output columns — always as 'get' (no terminal node yet)
  let plan = lowerToSetIr({ predicate, entity, op: 'get', select });

  // Step 2: subtract project root tasks (projects appear in flattenedTasks).
  // Optimisation: if every variable referenced in the predicate and select
  // list is task-only (absent from the project var registry), then projects
  // can never appear in the result set and the Difference is a no-op.
  if (entity === 'tasks' && needsProjectExclusion(predicate, select)) {
    plan = {
      kind:  'Difference',
      left:  plan,
      right: { kind: 'Scan', entity: 'projects', columns: ['id'] },
    };
  }

  // Step 3: terminal wrapping for the actual op
  switch (op) {
    case 'count':
      plan = { kind: 'Count', source: plan };
      break;
    case 'exists':
      plan = { kind: 'Limit', source: plan, n: 1 };
      break;
    case 'get':
      if (sort) {
        plan = { kind: 'Sort', source: plan, by: sort.by, direction: sort.direction ?? 'asc', entity };
      }
      if (limit) {
        plan = { kind: 'Limit', source: plan, n: limit };
      }
      break;
  }

  return plan;
}

export const compileQueryToSetIr: LowerPass<QueryPlanParams, SetIrNode> = function compileQueryToSetIr(
  params,
) {
  return buildSetIrPlan(params);
};

export const optimizeSetIrPipeline: OptimizePass<SetIrNode> = function optimizeSetIrPipeline(
  plan,
) {
  return optimizeSetIr(plan);
};

export function compileSetIrToEventPlan(
  plan: SetIrNode,
  outputColumns?: string[],
): EventPlan {
  return lowerSetIrToEventPlan(plan, outputColumns);
}

export const optimizeEventPlanPipeline: OptimizePass<EventPlan> = composePasses(
  cseEventPlan,
  pruneColumns,
  mergeSemiJoins,
);

export const compileEventPlanToTargetedPlan: LowerPass<EventPlan, TargetedEventPlan> = function compileEventPlanToTargetedPlan(
  plan,
) {
  return assignRuntimes(reorderEventPlan(plan));
};

export const executeTargetedPlanPipeline: ExecutePass<TargetedEventPlan, Promise<OrchestratorResult>> = function executeTargetedPlanPipeline(
  plan,
) {
  return executeTargetedPlan(plan);
};

export const executeEventPlanPipeline: ExecutePass<EventPlan, Promise<OrchestratorResult>> = async function executeEventPlanPipeline(
  plan,
) {
  const runEventPlan = composeAsyncPasses(
    compileEventPlanToTargetedPlan,
    executeTargetedPlanPipeline,
  );
  return runEventPlan(plan);
};

export function compileQueryToEventPlan(
  params: QueryPlanParams,
): EventPlan {
  const buildEventPlan = composePasses(
    compileQueryToSetIr,
    optimizeSetIrPipeline,
    (setIr: SetIrNode) => compileSetIrToEventPlan(setIr, params.select),
    optimizeEventPlanPipeline,
  );
  return buildEventPlan(params);
}

export async function executeSetIrPlan(
  plan: SetIrNode,
  outputColumns?: string[],
): Promise<OrchestratorResult> {
  const executeFromSetIr = composeAsyncPasses(
    optimizeSetIrPipeline,
    (optimizedSetIr: SetIrNode) => compileSetIrToEventPlan(optimizedSetIr, outputColumns),
    optimizeEventPlanPipeline,
    executeEventPlanPipeline,
  );
  return executeFromSetIr(plan);
}

// ── Column overlap analysis ──────────────────────────────────────────────────

export interface ColumnOverlap {
  /** Variables referenced by the filter predicate. */
  filterColumns: Set<string>;
  /** Select columns that overlap with filter columns (already read by the filter scan). */
  sharedColumns: string[];
  /** Select columns NOT in the filter — only needed for output, not filtering. */
  outputOnlyColumns: string[];
}

/**
 * Analyse which select columns are already present in the filter scan
 * (overlap) vs only needed for output (output-only).
 *
 * Used by the deferred enrichment path: when output-only columns
 * significantly exceed shared columns and the result set is small,
 * it's cheaper to enrich per-item via byIdentifier rather than
 * bulk-reading all rows.
 */
export function analyseColumnOverlap(
  predicate: LoweredExpr | true,
  select: string[] | undefined,
): ColumnOverlap {
  const filterColumns = predicate === true
    ? new Set<string>()
    : collectVarNames(predicate);

  if (!select || select.length === 0) {
    return { filterColumns, sharedColumns: [], outputOnlyColumns: [] };
  }

  const sharedColumns: string[] = [];
  const outputOnlyColumns: string[] = [];

  for (const col of select) {
    if (filterColumns.has(col)) {
      sharedColumns.push(col);
    } else {
      outputOnlyColumns.push(col);
    }
  }

  return { filterColumns, sharedColumns, outputOnlyColumns };
}

// ── Deferred enrichment constants ────────────────────────────────────────────

/** Maximum result-set size for deferred enrichment to be profitable. */
const DEFERRED_ENRICH_MAX_ROWS = 50;

/** Minimum number of output-only columns to justify deferred enrichment. */
const DEFERRED_ENRICH_MIN_OUTPUT_COLS = 3;

export async function executeQueryFromAst(
  params: QueryPlanParams,
): Promise<OrchestratorResult> {
  const { select, entity, op, predicate, limit } = params;

  // ── Strip custom-enrichment columns from select ───────────────────────
  //
  // Columns registered in CUSTOM_ENRICHMENTS can't go through the standard
  // AE bulk pipeline or OmniJS enrichment. Strip them from the select list
  // before building the plan; enrich via their custom fetch after results.

  const customCols = op === 'get' && select
    ? select.filter(c => CUSTOM_ENRICHMENTS[c]?.entities.has(entity))
    : [];

  const planSelect = customCols.length > 0
    ? select!.filter(c => !CUSTOM_ENRICHMENTS[c]?.entities.has(entity))
    : select;

  const planParams = customCols.length > 0
    ? { ...params, select: planSelect && planSelect.length > 0 ? planSelect : undefined }
    : params;

  // ── Native count / exists fast-paths ──────────────────────────────────
  //
  // When querying ALL rows of an entity with no filter (predicate === true),
  // use native AE .length instead of bulk-reading IDs through the full pipeline.
  // Benchmarked at ~12ms vs ~200ms (~7x speedup).
  //
  // For tasks: subtract projects count (projects appear in flattenedTasks).

  if (predicate === true && entity !== 'perspectives') {
    if (op === 'count') return executeNativeCount(entity);
    if (op === 'exists') return executeNativeExists(entity);
  }

  // ── Deferred enrichment eligibility check ──────────────────────────────
  //
  // When a query has a small explicit limit and many output-only columns
  // (columns in select but not referenced by the filter), it's cheaper to:
  //   1. Run the filter with minimal columns (filter + shared only)
  //   2. Collect matching IDs
  //   3. Enrich only those rows via OmniJS byIdentifier()
  //
  // This avoids bulk-reading all ~2000 rows for output columns that only
  // ~5 rows actually need. See docs/deferred-enrichment-design.md.

  if (
    op === 'get' &&
    planSelect && planSelect.length > 0 &&
    limit != null && limit <= DEFERRED_ENRICH_MAX_ROWS &&
    entity !== 'perspectives'
  ) {
    const overlap = analyseColumnOverlap(predicate, planSelect);
    const outputOnly = overlap.outputOnlyColumns;

    if (
      outputOnly.length >= DEFERRED_ENRICH_MIN_OUTPUT_COLS &&
      outputOnly.every(col => canEnrichColumn(entity, col))
    ) {
      const result = await executeDeferredEnrichment(
        { ...planParams, select: planSelect },
        overlap,
      );
      if (customCols.length > 0) return applyCustomEnrichments(result, entity, customCols);
      return result;
    }
  }

  // ── Standard full-scan path ────────────────────────────────────────────

  const result = await executeEventPlanPipeline(compileQueryToEventPlan(planParams));

  if (customCols.length > 0) return applyCustomEnrichments(result, entity, customCols);
  return result;
}

// ── Custom post-query enrichment execution ───────────────────────────────────

/**
 * Apply registered custom enrichments to query result rows.
 *
 * For each custom column, calls the registered fetch function with the
 * row IDs and merges values back into the result rows.
 */
async function applyCustomEnrichments(
  result: OrchestratorResult,
  entity: EntityType,
  columns: string[],
): Promise<OrchestratorResult> {
  if (!Array.isArray(result.value) || result.value.length === 0) return result;

  const rows = result.value as Row[];
  const ids = rows
    .map(row => row.id as string)
    .filter(id => id != null);

  if (ids.length === 0) return result;

  const extraTimings: OrchestratorResult['timings'] = [];

  for (const col of columns) {
    const enrichment = CUSTOM_ENRICHMENTS[col];
    if (!enrichment) continue;

    const t = Date.now();
    const valueMap = await enrichment.fetch(ids, entity);
    const ms = Date.now() - t;

    for (const row of rows) {
      const id = row.id as string;
      row[col] = valueMap.get(id) ?? enrichment.defaultValue;
    }

    extraTimings.push({ runtime: enrichment.timingLabel, refs: [], ms });
  }

  return {
    value: rows,
    timings: [...result.timings, ...extraTimings],
  };
}

// ── Native count fast-path execution ─────────────────────────────────────────

/**
 * Check whether a query is eligible for the native count fast-path.
 * Exported for unit testing.
 */
export function isNativeCountEligible(params: QueryPlanParams): boolean {
  return params.op === 'count' && params.predicate === true && params.entity !== 'perspectives';
}

/**
 * Check whether a query is eligible for the native exists fast-path.
 * Exported for unit testing.
 */
export function isNativeExistsEligible(params: QueryPlanParams): boolean {
  return params.op === 'exists' && params.predicate === true && params.entity !== 'perspectives';
}

/** Entity → JXA collection accessor for native count. */
const ENTITY_COLLECTION: Record<string, string> = {
  tasks:    'flattenedTasks',
  projects: 'flattenedProjects',
  folders:  'flattenedFolders',
  tags:     'flattenedTags',
};

/**
 * Build the JXA script for a native count query.
 * Exported for unit testing.
 */
export function buildNativeCountScript(entity: EntityType): string {
  const collection = ENTITY_COLLECTION[entity];
  if (!collection) throw new Error(`buildNativeCountScript: unknown entity '${entity}'`);

  if (entity === 'tasks') {
    // Subtract projects: they appear in flattenedTasks but are not "real" tasks.
    return `(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  return JSON.stringify(doc.${collection}.length - doc.flattenedProjects.length);
})()`;
  }
  return `(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  return JSON.stringify(doc.${collection}.length);
})()`;
}

/**
 * Execute a native AE count for an unfiltered entity query.
 *
 * Uses `.length` on the element specifier (native AE count event) instead of
 * bulk-reading IDs and counting in Node. For tasks, subtracts the project
 * count since projects appear in flattenedTasks.
 *
 * Benchmarked at ~12ms for tasks vs ~200ms for the full pipeline.
 */
async function executeNativeCount(entity: EntityType): Promise<OrchestratorResult> {
  const script = buildNativeCountScript(entity);

  const t = Date.now();
  const result = await executeJXA(script) as unknown as number;
  const ms = Date.now() - t;

  return {
    value: result,
    timings: [{ runtime: 'jxa', refs: [], ms }],
  };
}

/**
 * Build the JXA script for a native unfiltered entity exists check.
 * Exported for unit testing.
 *
 * For projects/folders/tags: dispatches the native AE `exists` command
 * (coredoex) via `.exists()` on the collection specifier — no row
 * serialisation, single round-trip.
 *
 * For tasks: `.exists()` on flattenedTasks would return true even when only
 * project root tasks exist (projects appear in flattenedTasks). We fall back
 * to the length-arithmetic approach to get the correct task-only count.
 */
export function buildNativeExistsScript(entity: EntityType): string {
  const collection = ENTITY_COLLECTION[entity];
  if (!collection) throw new Error(`buildNativeExistsScript: unknown entity '${entity}'`);

  if (entity === 'tasks') {
    // Cannot use .exists() here — flattenedTasks includes project root tasks,
    // so .exists() would return true even if there are zero real tasks.
    return `(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  return JSON.stringify(doc.flattenedTasks.length - doc.flattenedProjects.length > 0);
})()`;
  }
  // Native AE exists command (coredoex) — dispatched directly on the
  // collection specifier, no rows materialised.
  return `(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  return JSON.stringify(doc.${collection}.exists());
})()`;
}

/**
 * Execute a native AE exists check for an unfiltered entity query.
 *
 * For non-task entities: dispatches the native AE `exists` command (coredoex)
 * via `.exists()` on the collection specifier — no row serialisation.
 * For tasks: falls back to length arithmetic to exclude project root tasks.
 * Benchmarked at ~12ms vs ~200ms for the full pipeline.
 */
async function executeNativeExists(entity: EntityType): Promise<OrchestratorResult> {
  const script = buildNativeExistsScript(entity);

  const t = Date.now();
  const result = await executeJXA(script) as unknown as boolean;
  const ms = Date.now() - t;

  return {
    value: result,
    timings: [{ runtime: 'jxa', refs: [], ms }],
  };
}

// ── Deferred enrichment execution ────────────────────────────────────────────

/**
 * Two-phase execution: filter-only plan → byIdentifier enrichment.
 *
 * Phase 1: Execute with select = filterColumns ∪ sharedColumns (no output-only cols).
 *          This bulk-reads fewer columns and still produces the correct row set.
 * Phase 2: Extract IDs from Phase 1 results, call enrichByIdentifier for
 *          output-only columns, merge enriched data back into the filter rows.
 */
async function executeDeferredEnrichment(
  params: QueryPlanParams,
  overlap: ColumnOverlap,
): Promise<OrchestratorResult> {
  const { entity, select } = params;
  const outputOnly = overlap.outputOnlyColumns;

  // Phase 1: filter-only plan. Select only the columns needed for filtering
  // plus any shared columns (present in both filter and select).
  // Always include 'id' so we can match rows for the merge.
  const filterSelect = [...new Set([...overlap.sharedColumns, 'id'])];

  // Build and execute the filter-only plan
  const filterParams: QueryPlanParams = { ...params, select: filterSelect };
  const t0 = Date.now();
  const filterResult = await executeEventPlanPipeline(compileQueryToEventPlan(filterParams));
  const filterMs = Date.now() - t0;

  // Extract rows and IDs from the filter result
  if (!Array.isArray(filterResult.value)) {
    // Unexpected non-array result — fall back to standard path
    return filterResult;
  }

  const filterRows = filterResult.value as Row[];
  if (filterRows.length === 0) {
    return filterResult;
  }

  const ids = filterRows
    .map(row => row.id as string)
    .filter(id => id != null);

  if (ids.length === 0) {
    return filterResult;
  }

  // Phase 2: enrich the surviving rows via OmniJS byIdentifier
  const t1 = Date.now();
  const enrichedRows = await enrichByIdentifier(entity, ids, outputOnly);
  const enrichMs = Date.now() - t1;

  // Merge: combine filter rows with enriched data by matching on id
  const enrichMap = new Map<string, Row>();
  for (const row of enrichedRows) {
    if (row && row.id) {
      enrichMap.set(row.id as string, row);
    }
  }

  const mergedRows: Row[] = filterRows.map(filterRow => {
    const enriched = enrichMap.get(filterRow.id as string);
    if (!enriched) return filterRow;
    // Merge enriched columns into the filter row
    const result = { ...filterRow };
    for (const col of outputOnly) {
      if (col in enriched) {
        result[col] = enriched[col];
      }
    }
    return result;
  });

  // If the caller requested specific select columns, project to exactly those
  if (select && select.length > 0) {
    const selectSet = new Set(select);
    // Always keep 'id' for downstream use
    selectSet.add('id');
    for (const row of mergedRows) {
      for (const key of Object.keys(row)) {
        if (!selectSet.has(key)) {
          delete row[key];
        }
      }
    }
  }

  return {
    value: mergedRows,
    timings: [
      ...filterResult.timings,
      { runtime: 'omniJs-enrich', refs: [], ms: enrichMs },
    ],
  };
}

// ── Inspection (no execution) ────────────────────────────────────────────────

export interface InspectResult {
  units: ExecutionUnit[];
  emittedScripts: { runtime: string; refs: number[]; script: string }[];
}

/**
 * Static analysis of an EventPlan: splits into ExecutionUnits, computes
 * bindings, and emits each unit's script — without executing anything.
 *
 * The plan should already have CSE and column pruning applied.
 * Used by the dump-codegen script.
 */
export function inspectEventPlan(plan: EventPlan): InspectResult {
  const reordered = reorderEventPlan(plan);
  const targeted  = assignRuntimes(reordered);
  const units     = splitExecutionUnits(targeted);
  computeBindings(units, targeted);
  const sorted    = fuseSchedule(topoSort(units));

  const emptyInputs = new Map<number, string>();
  const emittedScripts: InspectResult['emittedScripts'] = [];

  for (const unit of sorted) {
    const exports = computeExportedRefs(unit, units);
    let script: string;
    if (unit.runtime === 'jxa') {
      script = emitJxaUnit(unit, targeted, emptyInputs, exports);
    } else {
      script = `(node-side unit — no emitted script)`;
    }
    emittedScripts.push({ runtime: unit.runtime, refs: unit.nodes, script });
  }

  return { units: sorted, emittedScripts };
}
