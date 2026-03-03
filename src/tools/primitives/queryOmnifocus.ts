/**
 * Query OmniFocus — Execution Router.
 *
 * Responsibilities:
 *   1. Lower compact syntax → AST
 *   2. Inject active filter (includeCompleted=false default)
 *   3. Delegate to orchestrator.executeQueryFromAst for full pipeline execution
 *
 * Perspectives are handled separately via OmniJS (no Apple Events class code).
 */

import { lowerExpr, LowerError } from '../query/lower.js';
import { normalizeAst } from '../query/normalizeAst.js';
import { executeQueryFromAst } from '../query/executionUnits/orchestrator.js';
import { queryPerspectives } from './queryPerspectives.js';
import type { LoweredExpr } from '../query/fold.js';
import type { EntityType } from '../query/variables.js';
import type { Row } from '../query/backends/nodeEval.js';

// ── Query Logging ──────────────────────────────────────────────────────────────

function logQuery(entry: {
  where: unknown;
  entity: string;
  op: string;
  strategy: string;
  totalMs: number;
  resultCount: number;
  error?: string;
}): void {
  const where = entry.where != null ? JSON.stringify(entry.where) : '(none)';
  const err = entry.error ? ` ERROR: ${entry.error}` : '';

  console.error(
    `[query] ${entry.entity} ${entry.op} ${entry.strategy} ${entry.totalMs}ms | result=${entry.resultCount}${err}`
  );
  console.error(`[query]   where: ${where}`);
}

// ── Types ───────────────────────────────────────────────────────────────

export interface QueryOmnifocusParams {
  entity: EntityType;
  /** Explicit operation type. 'get' returns items (default); 'count' returns
   *  the number of matches without reading output-only columns; 'exists' returns
   *  a boolean and stops after the first match. */
  op?: 'get' | 'count' | 'exists';
  where?: unknown;
  select?: string[];
  limit?: number;
  sort?: { by: string; direction?: 'asc' | 'desc' };
  includeCompleted?: boolean;
  /** @deprecated Use op:'count' instead. */
  summary?: boolean;
}

interface QueryResult {
  success: boolean;
  items?: any[];
  count?: number;
  exists?: boolean;
  error?: string;
}

// ── Active filter ─────────────────────────────────────────────────────────────

/**
 * Build the default active-item predicate for an entity.
 * Returns null if no active filter is needed (folders, perspectives).
 */
function activeFilterForEntity(entity: EntityType, includeCompleted: boolean): LoweredExpr | null {
  if (includeCompleted) return null;

  switch (entity) {
    case 'tasks':
      return {
        op: 'and', args: [
          { op: 'not', args: [{ var: 'effectivelyCompleted' }] },
          { op: 'not', args: [{ var: 'effectivelyDropped'   }] },
        ],
      } as LoweredExpr;
    case 'projects':
      return { op: 'in', args: [{ var: 'status' }, ['Active', 'OnHold']] } as LoweredExpr;
    case 'tags':
      return { op: 'not', args: [{ var: 'effectivelyHidden' }] } as LoweredExpr;
    case 'folders':
    default:
      return null;
  }
}

// ── Main Entry Point ────────────────────────────────────────────────────

export async function queryOmnifocus(params: QueryOmnifocusParams): Promise<QueryResult> {
  const t0 = Date.now();

  // Resolve effective operation. summary:true is the legacy shim for count.
  const effectiveOp: 'get' | 'count' | 'exists' =
    params.op ?? (params.summary ? 'count' : 'get');

  try {
    // Step 1: Lower and normalise the WHERE predicate.
    let ast: LoweredExpr;
    try {
      const lowered = params.where != null ? lowerExpr(params.where) : null;
      ast = lowered != null ? normalizeAst(lowered as LoweredExpr) as LoweredExpr : null;
    } catch (e) {
      if (e instanceof LowerError) {
        logQuery({ where: params.where, entity: params.entity, op: effectiveOp, strategy: 'error', totalMs: Date.now() - t0, resultCount: 0, error: e.message });
        return { success: false, error: e.message };
      }
      throw e;
    }

    const entity = params.entity;

    // Special case: perspectives have no Apple Events class code.
    if (entity === 'perspectives') {
      const filterAst: LoweredExpr | true = ast ?? true;
      const rows = await queryPerspectives(filterAst);
      const totalCount = rows.length;

      logQuery({ where: params.where, entity, op: effectiveOp, strategy: 'perspectives', totalMs: Date.now() - t0, resultCount: totalCount });

      if (effectiveOp === 'count') return { success: true, count: totalCount };
      if (effectiveOp === 'exists') return { success: true, exists: totalCount > 0 };

      let items = params.select ? selectFields(rows, params.select) : rows;
      return { success: true, items, count: totalCount };
    }

    // Step 2: Inject active filter unless includeCompleted.
    const activeFilter = activeFilterForEntity(entity, params.includeCompleted ?? false);
    let predicate: LoweredExpr | true;
    if (activeFilter !== null) {
      predicate = ast !== null
        ? { op: 'and', args: [ast, activeFilter] } as LoweredExpr
        : activeFilter;
    } else {
      predicate = ast ?? true;
    }

    // Step 3: For 'get', expand select to include mandatory minimum task fields.
    const expandedSelect = effectiveOp === 'get' && entity === 'tasks' && params.select
      ? augmentTaskSelect(params.select)
      : effectiveOp === 'get' ? params.select : undefined;

    // Step 4: Delegate full pipeline (SetIR → EventPlan → execute) to orchestrator.
    const orchResult = await executeQueryFromAst({
      predicate,
      entity,
      op: effectiveOp,
      select: expandedSelect,
      sort: params.sort,
      limit: params.limit,
    });

    // op:'count' produces a numeric result from the RowCount EventPlan node.
    // Handle it before the Row[] check to avoid a false "pipeline bug" error.
    if (effectiveOp === 'count') {
      const count = typeof orchResult.value === 'number'
        ? orchResult.value
        : Array.isArray(orchResult.value) ? orchResult.value.length : 0;
      logQuery({ where: params.where, entity, op: effectiveOp, strategy: 'setIr', totalMs: Date.now() - t0, resultCount: count });
      return { success: true, count };
    }

    if (!Array.isArray(orchResult.value)) {
      throw new Error(`EventPlan pipeline produced non-array result — pipeline bug`);
    }
    const rows: Row[] = orchResult.value as Row[];
    const totalCount = rows.length;

    logQuery({ where: params.where, entity, op: effectiveOp, strategy: 'setIr', totalMs: Date.now() - t0, resultCount: totalCount });

    if (effectiveOp === 'exists') {
      return { success: true, exists: totalCount > 0 };
    }

    // 'get': return items
    let items = params.select ? selectFields(rows, params.select) : rows;

    // For tasks, inject mandatory minimum fields (id, flagged, taskStatus)
    // into every row regardless of what the user selected.
    if (entity === 'tasks') {
      items = injectMandatoryTaskFields(items);
    }

    return { success: true, items, count: totalCount };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error occurred';
    logQuery({ where: params.where, entity: params.entity, op: effectiveOp, strategy: 'error', totalMs: Date.now() - t0, resultCount: 0, error: msg });
    return { success: false, error: msg };
  }
}

// ── Field Selection ─────────────────────────────────────────────────────────

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
