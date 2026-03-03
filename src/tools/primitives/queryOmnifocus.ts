/**
 * Query OmniFocus — Execution Router.
 *
 * Wires the full pipeline:
 *   1. Lower compact syntax → AST
 *   2. Build plan tree (planner)
 *   3. Optimize plan tree (tag semi-join, normalization)
 *   4. Execute plan tree (executor)
 *   5. Sort, limit, select in Node (via tree wrapper nodes)
 *
 * Two execution backends:
 *   - Legacy: compileQuery(JxaEmitter) → executeCompiledQuery (StrategyNode codegen)
 *   - EventPlan: lowerStrategy → cseEventPlan → executeEventPlan (new IR pipeline)
 *
 * Set USE_EVENT_PLAN_PIPELINE=1 env var to use the new pipeline.
 */

import { lowerExpr, LowerError } from '../query/lower.js';
import { buildPlanTree } from '../query/planner.js';
import { executeCompiledQuery } from '../query/executor.js';
import { compileQuery } from '../query/compile.js';
import { JxaEmitter } from '../query/emitters/jxaEmitter.js';
import { optimize, planPathLabel, type StrategyNode } from '../query/strategy.js';
import { tagSemiJoinPass } from '../query/optimizations/tagSemiJoin.js';
import { normalizePass } from '../query/optimizations/normalize.js';
import { crossEntityJoinPass } from '../query/optimizations/crossEntityJoin.js';
import { selfJoinEliminationPass } from '../query/optimizations/selfJoinElimination.js';
import { executeEventPlanPipeline } from '../query/executionUnits/orchestrator.js';
import type { LoweredExpr } from '../query/fold.js';
import type { EntityType } from '../query/variables.js';
import type { Row } from '../query/backends/nodeEval.js';

// ── Feature flag ─────────────────────────────────────────────────────

const USE_EVENT_PLAN = process.env.USE_EVENT_PLAN_PIPELINE !== '0';

// ── Query Logging ──────────────────────────────────────────────────────

function logQuery(entry: {
  where: unknown;
  entity: string;
  strategy: string;
  totalMs: number;
  resultCount: number;
  error?: string;
}): void {
  const where = entry.where != null ? JSON.stringify(entry.where) : '(none)';
  const err = entry.error ? ` ERROR: ${entry.error}` : '';

  console.error(
    `[query] ${entry.entity} ${entry.strategy} ${entry.totalMs}ms | result=${entry.resultCount}${err}`
  );
  console.error(`[query]   where: ${where}`);
}

// ── Types ───────────────────────────────────────────────────────────────

export interface QueryOmnifocusParams {
  entity: EntityType;
  where?: unknown;
  select?: string[];
  limit?: number;
  sort?: { by: string; direction?: 'asc' | 'desc' };
  includeCompleted?: boolean;
  summary?: boolean;
}

interface QueryResult {
  success: boolean;
  items?: any[];
  count?: number;
  error?: string;
}

// ── Optimization Passes ─────────────────────────────────────────────────

const PASSES = [tagSemiJoinPass, crossEntityJoinPass, selfJoinEliminationPass, normalizePass];

// ── Main Entry Point ────────────────────────────────────────────────────

export async function queryOmnifocus(params: QueryOmnifocusParams): Promise<QueryResult> {
  const t0 = Date.now();
  try {
    // Step 1: Lower the where clause
    let ast: LoweredExpr;
    try {
      ast = (params.where != null ? lowerExpr(params.where) : true) as LoweredExpr;
    } catch (e) {
      if (e instanceof LowerError) {
        logQuery({ where: params.where, entity: params.entity, strategy: 'error', totalMs: Date.now() - t0, resultCount: 0, error: e.message });
        return { success: false, error: e.message };
      }
      throw e;
    }

    // Step 1b: For tasks, expand select to include mandatory minimum fields
    // so the planner bulk-reads them (id, flagged are easy; status is computed).
    const expandedSelect = params.entity === 'tasks' && params.select
      ? augmentTaskSelect(params.select)
      : params.select;

    // Step 2: Build plan tree
    let tree = buildPlanTree(ast, params.entity, expandedSelect, params.includeCompleted ?? false);

    // Step 3: Wrap with sort/limit/project nodes
    tree = wrapWithPostProcessing(tree, params);

    // Step 4: Optimize
    tree = optimize(tree, PASSES);

    const strategy = planPathLabel(tree);

    // Step 5: Compile and execute (legacy or EventPlan pipeline)
    // Perspectives have no Apple Events class code; FallbackScan queries
    // use OmniJS-compiled predicates (container filters, expensive vars)
    // that the EventPlan Filter node can't evaluate. Both use the legacy
    // executor.
    let rows: Row[];

    if (USE_EVENT_PLAN && params.entity !== 'perspectives' && strategy !== 'fallback') {
      // New EventPlan IR pipeline:
      // StrategyNode → EventPlan → CSE → assignRuntimes → split → execute
      const orchResult = await executeEventPlanPipeline(tree);
      if (!Array.isArray(orchResult.value)) {
        throw new Error(`EventPlan pipeline produced non-array result — pipeline bug`);
      }
      rows = orchResult.value as Row[];
    } else {
      // Legacy pipeline: compile to JXA script and execute
      const compiled = compileQuery(tree, new JxaEmitter());
      const result = await executeCompiledQuery(compiled);
      if (result.kind !== 'rows') {
        throw new Error(`Plan tree produced ${result.kind} instead of rows — planner bug`);
      }
      rows = result.rows;
    }

    const totalCount = rows.length;

    logQuery({ where: params.where, entity: params.entity, strategy, totalMs: Date.now() - t0, resultCount: totalCount });

    // Summary mode
    if (params.summary) {
      return { success: true, count: totalCount };
    }

    // Select fields (if not already handled by Project node, which only
    // applies to tree-internal usage — for the public API, we always apply
    // select here to handle the full field mapping including OmniJS results)
    let items = params.select ? selectFields(rows, params.select) : rows;

    // For tasks, inject mandatory minimum fields (id, flagged, taskStatus)
    // into every row regardless of what the user selected.
    if (params.entity === 'tasks') {
      items = injectMandatoryTaskFields(items);
    }

    return { success: true, items, count: totalCount };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error occurred';
    logQuery({ where: params.where, entity: params.entity, strategy: 'error', totalMs: Date.now() - t0, resultCount: 0, error: msg });
    return { success: false, error: msg };
  }
}

// ── Post-Processing Wrappers ────────────────────────────────────────────

function wrapWithPostProcessing(tree: StrategyNode, params: QueryOmnifocusParams): StrategyNode {
  let current = tree;

  // Sort
  if (params.sort) {
    current = {
      kind: 'Sort',
      source: current,
      by: params.sort.by,
      direction: params.sort.direction ?? 'asc',
      entity: params.entity,
    };
  }

  // Limit
  if (params.limit) {
    current = {
      kind: 'Limit',
      source: current,
      count: params.limit,
    };
  }

  return current;
}

// ── Field Selection ─────────────────────────────────────────────────────

function selectFields(rows: Row[], fields: string[]): Row[] {
  return rows.map(row => {
    const selected: Row = {};
    for (const field of fields) {
      if (field in row) {
        selected[field] = row[field];
      }
    }
    return selected;
  });
}

// ── Mandatory Task Fields ─────────────────────────────────────────────────

/** Fields that are always needed for tasks (mapped to internal variable names). */
const MANDATORY_TASK_VARS = ['id', 'flagged', 'status'];

/**
 * Augment a user's select list with mandatory task fields so the planner
 * bulk-reads them. Uses internal variable names (status, not taskStatus).
 */
export function augmentTaskSelect(select: string[]): string[] {
  const set = new Set(select);
  // Map user-facing 'taskStatus' to internal 'status' computed var
  if (set.has('taskStatus')) {
    set.add('status');
  }
  for (const v of MANDATORY_TASK_VARS) {
    set.add(v);
  }
  return [...set];
}

/**
 * Inject mandatory minimum fields into task result rows.
 * Maps the internal 'status' field to 'taskStatus' for user-facing output.
 */
export function injectMandatoryTaskFields(rows: Row[]): Row[] {
  return rows.map(row => {
    const result = { ...row };
    // Map internal 'status' → user-facing 'taskStatus'
    if ('status' in result && !('taskStatus' in result)) {
      result.taskStatus = result.status;
      delete result.status;
    }
    return result;
  });
}
