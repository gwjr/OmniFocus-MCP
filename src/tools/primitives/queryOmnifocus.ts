/**
 * Query OmniFocus — Execution Router.
 *
 * Wires the full pipeline:
 *   1. Lower compact syntax → AST
 *   2. Plan execution strategy (planner)
 *   3. Execute via direct JXA bulk-read + Node-side filter (fast path)
 *      OR via OmniJS evaluateJavascript (fallback)
 *   4. Sort, limit, select in Node
 */

import { executeJXA, executeOmniFocusScript } from '../../utils/scriptExecution.js';
import { compileWhere, CompileError } from '../query/backends/jxaCompiler.js';
import { compileNodePredicate, type Row, type RowFn } from '../query/backends/nodeEval.js';
import { lowerExpr, LowerError } from '../query/lower.js';
import { planFromAst, type ExecutionPlan, type ExecutionPath } from '../query/planner.js';
import { generateBulkReadScript, generatePerItemReadScript } from '../query/jxaBulkRead.js';
import type { LoweredExpr } from '../query/fold.js';
import { getVarRegistry } from '../query/variables.js';

// ── Query Logging ──────────────────────────────────────────────────────

function logQuery(entry: {
  where: unknown;
  entity: string;
  strategy: ExecutionPath;
  totalMs: number;
  phase1Ms?: number;
  phase2Ms?: number;
  bulkRows?: number;
  filteredRows?: number;
  resultCount: number;
  perItemCount?: number;
  thresholdFallback?: boolean;
  error?: string;
}): void {
  const where = entry.where != null ? JSON.stringify(entry.where) : '(none)';
  const phases = [
    entry.phase1Ms != null ? `bulk=${entry.phase1Ms}ms` : null,
    entry.phase2Ms != null ? `per-item=${entry.phase2Ms}ms` : null,
  ].filter(Boolean).join(' ');
  const counts = [
    entry.bulkRows != null ? `read=${entry.bulkRows}` : null,
    entry.filteredRows != null ? `filtered=${entry.filteredRows}` : null,
    entry.perItemCount != null ? `per-item=${entry.perItemCount}` : null,
    `result=${entry.resultCount}`,
  ].filter(Boolean).join(' ');
  const flags = entry.thresholdFallback ? ' [threshold→fallback]' : '';
  const err = entry.error ? ` ERROR: ${entry.error}` : '';

  console.error(
    `[query] ${entry.entity} ${entry.strategy} ${entry.totalMs}ms | ${phases ? phases + ' | ' : ''}${counts}${flags}${err}`
  );
  console.error(`[query]   where: ${where}`);
}

// ── Types ───────────────────────────────────────────────────────────────

export interface QueryOmnifocusParams {
  entity: 'tasks' | 'projects' | 'folders';
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

// ── Main Entry Point ────────────────────────────────────────────────────

export async function queryOmnifocus(params: QueryOmnifocusParams): Promise<QueryResult> {
  const t0 = Date.now();
  try {
    // Phase 0: Lower the where clause
    let ast: LoweredExpr;
    try {
      ast = (params.where != null ? lowerExpr(params.where) : true) as LoweredExpr;
    } catch (e) {
      if (e instanceof LowerError) {
        logQuery({ where: params.where, entity: params.entity, strategy: 'omnijs-fallback', totalMs: Date.now() - t0, resultCount: 0, error: e.message });
        return { success: false, error: e.message };
      }
      throw e;
    }

    // Phase 0.5: Plan the execution strategy
    const plan = planFromAst(ast, params.entity, params.select);

    // Route to appropriate execution path
    if (plan.path === 'omnijs-fallback') {
      return executeViaOmniJs(params, ast, t0);
    }

    return executeViaDirectJxa(params, plan, ast, t0);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error occurred';
    logQuery({ where: params.where, entity: params.entity, strategy: 'omnijs-fallback', totalMs: Date.now() - t0, resultCount: 0, error: msg });
    return { success: false, error: msg };
  }
}

// ── Direct JXA Path (fast) ──────────────────────────────────────────────

async function executeViaDirectJxa(
  params: QueryOmnifocusParams,
  plan: ExecutionPlan,
  ast: LoweredExpr,
  t0: number
): Promise<QueryResult> {
  // Phase 1: Direct JXA bulk-read
  const t1 = Date.now();
  const jxaScript = generateBulkReadScript(plan, params.includeCompleted ?? false);
  const rawResult = await executeJXA(jxaScript);
  const phase1Ms = Date.now() - t1;

  // Check for alignment errors
  if (rawResult && typeof rawResult === 'object' && 'error' in rawResult) {
    logQuery({ where: params.where, entity: params.entity, strategy: plan.path, totalMs: Date.now() - t0, phase1Ms, resultCount: 0, error: `alignment: ${(rawResult as any).error}` });
    return { success: false, error: `Bulk read error: ${(rawResult as any).error}` };
  }

  let rows = rawResult as Row[];
  if (!Array.isArray(rows)) {
    logQuery({ where: params.where, entity: params.entity, strategy: plan.path, totalMs: Date.now() - t0, phase1Ms, resultCount: 0, error: 'bad format' });
    return { success: false, error: 'Unexpected bulk read result format' };
  }

  const bulkRows = rows.length;

  // Phase 1 filter: Node-side evaluation
  if (ast !== true) {
    try {
      const predicate = compileNodePredicate(
        plan.filterAst,
        plan.entity,
        plan.stubVars ? { stubVars: plan.stubVars } : undefined
      );
      rows = rows.filter(row => !!predicate(row));
    } catch (e) {
      // If NodeEval fails (e.g. unsupported operation), fall back to OmniJS
      logQuery({ where: params.where, entity: params.entity, strategy: plan.path, totalMs: Date.now() - t0, phase1Ms, bulkRows, resultCount: 0, error: `NodeEval failed: ${e}` });
      return executeViaOmniJs(params, ast, t0);
    }
  }

  const filteredRows = rows.length;

  // Phase 2: Per-item reads for two-phase plan
  // Benchmarking shows per-item ID lookups cost ~200ms each via JXA .whose({id}).
  // If the phase 1 pre-filter leaves too many items, fall back to OmniJS which
  // handles everything in-process (~6s total, vs N*200ms for large N).
  const PER_ITEM_THRESHOLD = 20;
  let phase2Ms: number | undefined;
  let perItemCount: number | undefined;
  let thresholdFallback = false;

  if ((plan.path === 'two-phase' || plan.path === 'project-scoped') && plan.perItemVars && plan.perItemVars.size > 0) {
    const ids = rows.map(r => r.id as string).filter(Boolean);

    if (ids.length > PER_ITEM_THRESHOLD) {
      thresholdFallback = true;
      logQuery({ where: params.where, entity: params.entity, strategy: plan.path, totalMs: Date.now() - t0, phase1Ms, bulkRows, filteredRows, resultCount: ids.length, thresholdFallback: true });
      return executeViaOmniJs(params, ast, t0);
    }

    if (ids.length > 0) {
      const t2 = Date.now();
      const detailScript = generatePerItemReadScript(ids, plan.perItemVars);
      const detailResult = await executeJXA(detailScript);
      phase2Ms = Date.now() - t2;
      perItemCount = ids.length;

      if (Array.isArray(detailResult)) {
        // Merge details into rows
        const detailMap = new Map<string, Row>();
        for (const detail of detailResult) {
          if (detail && typeof detail === 'object' && 'id' in detail) {
            detailMap.set(detail.id as string, detail as Row);
          }
        }

        for (const row of rows) {
          const detail = detailMap.get(row.id as string);
          if (detail) {
            for (const [key, value] of Object.entries(detail)) {
              if (key !== 'id') row[key] = value;
            }
          }
        }
      }

      // Re-evaluate with full data (no stubs)
      try {
        const exactPredicate = compileNodePredicate(plan.filterAst, plan.entity);
        rows = rows.filter(row => !!exactPredicate(row));
      } catch (e) {
        // Log but continue with phase-1 filtered results
        console.error('Exact re-filter failed:', e);
      }
    }
  }

  // Node-side sort
  if (params.sort) {
    applySort(rows, params.sort);
  }

  // Count before limiting
  const totalCount = rows.length;

  // Apply limit
  if (params.limit) {
    rows = rows.slice(0, params.limit);
  }

  logQuery({ where: params.where, entity: params.entity, strategy: plan.path, totalMs: Date.now() - t0, phase1Ms, phase2Ms, bulkRows, filteredRows, resultCount: totalCount, perItemCount });

  // Summary mode
  if (params.summary) {
    return { success: true, count: totalCount };
  }

  // Select fields (or return all available)
  const items = params.select ? selectFields(rows, params.select) : rows;

  return { success: true, items, count: totalCount };
}

// ── OmniJS Fallback Path ────────────────────────────────────────────────

async function executeViaOmniJs(
  params: QueryOmnifocusParams,
  ast: LoweredExpr,
  t0?: number
): Promise<QueryResult> {
  const startMs = t0 ?? Date.now();

  // Compile the where clause to JXA for OmniJS execution
  let whereCondition: string | null = null;
  let preambleCode: string[] = [];

  if (params.where != null) {
    try {
      const result = compileWhere(params.where, params.entity);
      whereCondition = result.condition;
      preambleCode = result.preamble;
    } catch (e) {
      if (e instanceof CompileError) {
        logQuery({ where: params.where, entity: params.entity, strategy: 'omnijs-fallback', totalMs: Date.now() - startMs, resultCount: 0, error: e.message });
        return { success: false, error: e.message };
      }
      throw e;
    }
  }

  const jxaScript = generateOmniJsScript(params, whereCondition, preambleCode);

  const tempFile = `/tmp/omnifocus_query_${Date.now()}.js`;
  const fs = await import('fs');
  fs.writeFileSync(tempFile, jxaScript);

  const result = await executeOmniFocusScript(tempFile);

  fs.unlinkSync(tempFile);

  const count = result.count ?? result.items?.length ?? 0;

  if (result.error) {
    logQuery({ where: params.where, entity: params.entity, strategy: 'omnijs-fallback', totalMs: Date.now() - startMs, resultCount: count, error: result.error });
    return { success: false, error: result.error };
  }

  logQuery({ where: params.where, entity: params.entity, strategy: 'omnijs-fallback', totalMs: Date.now() - startMs, resultCount: count });

  return {
    success: true,
    items: params.summary ? undefined : result.items,
    count: result.count
  };
}

// ── Node-side Sort ──────────────────────────────────────────────────────

function applySort(rows: Row[], sort: { by: string; direction?: 'asc' | 'desc' }): void {
  const order = sort.direction === 'desc' ? -1 : 1;
  const registry = getVarRegistry('tasks');
  const def = registry[sort.by];
  const key = def?.nodeKey ?? sort.by;

  rows.sort((a, b) => {
    let aVal = a[key] as any;
    let bVal = b[key] as any;

    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;

    // Date strings → compare as timestamps
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      const at = Date.parse(aVal);
      const bt = Date.parse(bVal);
      if (!isNaN(at) && !isNaN(bt)) return (at - bt) * order;
      return aVal.localeCompare(bVal) * order;
    }

    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return (aVal - bVal) * order;
    }

    return 0;
  });
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

// ── OmniJS Script Generator (preserved from original) ───────────────────

function generateOmniJsScript(
  params: QueryOmnifocusParams,
  whereCondition: string | null,
  preambleCode: string[]
): string {
  const { entity, select, limit, sort, includeCompleted = false, summary = false } = params;

  return `(() => {
    try {
      // Helper function to format dates
      function formatDate(date) {
        if (!date) return null;
        return date.toISOString();
      }

      // Status mappings
      const taskStatusMap = {
        [Task.Status.Available]: "Available",
        [Task.Status.Blocked]: "Blocked",
        [Task.Status.Completed]: "Completed",
        [Task.Status.Dropped]: "Dropped",
        [Task.Status.DueSoon]: "DueSoon",
        [Task.Status.Next]: "Next",
        [Task.Status.Overdue]: "Overdue"
      };

      const projectStatusMap = {
        [Project.Status.Active]: "Active",
        [Project.Status.Done]: "Done",
        [Project.Status.Dropped]: "Dropped",
        [Project.Status.OnHold]: "OnHold"
      };

      const folderStatusMap = {
        [Folder.Status.Active]: "Active",
        [Folder.Status.Dropped]: "Dropped"
      };

      // Expression preamble (date constants, regex patterns, helpers)
      var _now = new Date();
      var _eq = function(a, b) {
        if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
        return a === b;
      };
      ${preambleCode.join('\n      ')}

      // Get the appropriate collection based on entity type
      let items = [];
      const entityType = "${entity}";

      if (entityType === "tasks") {
        items = flattenedTasks;
      } else if (entityType === "projects") {
        items = flattenedProjects;
      } else if (entityType === "folders") {
        items = flattenedFolders;
      }

      // Apply filters
      let filtered = items.filter(item => {
        // Skip completed/dropped unless explicitly requested
        if (!${includeCompleted}) {
          if (entityType === "tasks") {
            if (item.taskStatus === Task.Status.Completed ||
                item.taskStatus === Task.Status.Dropped) {
              return false;
            }
          } else if (entityType === "projects") {
            if (item.status === Project.Status.Done ||
                item.status === Project.Status.Dropped) {
              return false;
            }
          }
        }

        ${whereCondition ? `return (${whereCondition});` : 'return true;'}
      });

      // Apply sorting if specified
      ${sort ? generateSortLogic(sort.by, sort.direction, entity) : ''}

      // Apply limit if specified
      ${limit ? `filtered = filtered.slice(0, ${limit});` : ''}

      // If summary mode, just return count
      if (${summary}) {
        return JSON.stringify({
          count: filtered.length,
          error: null
        });
      }

      // Transform items to return only requested fields
      const results = filtered.map(item => {
        ${generateFieldMapping(entity, select)}
      });

      return JSON.stringify({
        items: results,
        count: results.length,
        error: null
      });

    } catch (error) {
      return JSON.stringify({
        error: "Script execution error: " + error.toString(),
        items: [],
        count: 0
      });
    }
  })();`;
}

// ── OmniJS Helpers (preserved from original) ────────────────────────────

function mapFieldToProperty(field: string, entity?: string): string {
  if (entity === 'projects') {
    const projectMap: Record<string, string> = {
      modificationDate: 'task.modified',
      modified: 'task.modified',
      creationDate: 'task.added',
      added: 'task.added',
    };
    return projectMap[field] || field;
  }
  const taskMap: Record<string, string> = {
    modificationDate: 'modified',
    modified: 'modified',
    creationDate: 'added',
    added: 'added',
  };
  return taskMap[field] || field;
}

function generateSortLogic(sortBy: string, sortOrder?: string, entity?: string): string {
  const order = sortOrder === 'desc' ? -1 : 1;
  const jxaProp = mapFieldToProperty(sortBy, entity);

  return `
    filtered.sort((a, b) => {
      let aVal = a.${jxaProp};
      let bVal = b.${jxaProp};

      // Handle null/undefined values
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      // Compare based on type
      if (typeof aVal === 'string') {
        return aVal.localeCompare(bVal) * ${order};
      } else if (aVal instanceof Date) {
        return (aVal.getTime() - bVal.getTime()) * ${order};
      } else {
        return (aVal - bVal) * ${order};
      }
    });
  `;
}

function generateFieldMapping(entity: string, fields?: string[]): string {
  if (!fields || fields.length === 0) {
    if (entity === 'tasks') {
      return `
        const obj = {
          id: item.id.primaryKey,
          name: item.name || "",
          flagged: item.flagged || false,
          taskStatus: taskStatusMap[item.taskStatus] || "Unknown",
          dueDate: formatDate(item.dueDate),
          deferDate: formatDate(item.deferDate),
          plannedDate: formatDate(item.plannedDate),
          tagNames: item.tags ? item.tags.map(t => t.name) : [],
          projectName: item.containingProject ? item.containingProject.name : (item.inInbox ? "Inbox" : null),
          estimatedMinutes: item.estimatedMinutes || null,
          note: item.note || ""
        };
        return obj;
      `;
    } else if (entity === 'projects') {
      return `
        const taskArray = item.tasks || [];
        const activeTaskArray = taskArray.filter(t =>
          t.taskStatus !== Task.Status.Completed &&
          t.taskStatus !== Task.Status.Dropped
        );
        return {
          id: item.id.primaryKey,
          name: item.name || "",
          status: projectStatusMap[item.status] || "Unknown",
          folderName: item.parentFolder ? item.parentFolder.name : null,
          taskCount: taskArray.length,
          activeTaskCount: activeTaskArray.length,
          flagged: item.flagged || false,
          dueDate: formatDate(item.dueDate),
          deferDate: formatDate(item.deferDate),
          note: item.note || ""
        };
      `;
    } else if (entity === 'folders') {
      return `
        const projectArray = item.projects || [];
        return {
          id: item.id.primaryKey,
          name: item.name || "",
          projectCount: projectArray.length,
          path: item.container ? item.container.name + "/" + item.name : item.name
        };
      `;
    }
  }

  const mappings = fields!.map(field => {
    if (field === 'id') return `id: item.id.primaryKey`;
    if (field === 'taskStatus') return `taskStatus: taskStatusMap[item.taskStatus]`;
    if (field === 'status') return `status: projectStatusMap[item.status]`;
    if (field === 'modificationDate' || field === 'modified') return `modificationDate: formatDate(item.${mapFieldToProperty('modified', entity)})`;
    if (field === 'creationDate' || field === 'added') return `creationDate: formatDate(item.${mapFieldToProperty('added', entity)})`;
    if (field === 'completionDate') return `completionDate: item.completionDate ? formatDate(item.completionDate) : null`;
    if (field === 'dueDate') return `dueDate: formatDate(item.dueDate)`;
    if (field === 'deferDate') return `deferDate: formatDate(item.deferDate)`;
    if (field === 'plannedDate') return `plannedDate: formatDate(item.plannedDate)`;
    if (field === 'effectiveDueDate') return `effectiveDueDate: formatDate(item.effectiveDueDate)`;
    if (field === 'effectiveDeferDate') return `effectiveDeferDate: formatDate(item.effectiveDeferDate)`;
    if (field === 'effectivePlannedDate') return `effectivePlannedDate: formatDate(item.effectivePlannedDate)`;
    if (field === 'tagNames') return `tagNames: item.tags ? item.tags.map(t => t.name) : []`;
    if (field === 'tags') return `tags: item.tags ? item.tags.map(t => t.id.primaryKey) : []`;
    if (field === 'projectName') return `projectName: item.containingProject ? item.containingProject.name : (item.inInbox ? "Inbox" : null)`;
    if (field === 'projectId') return `projectId: item.containingProject ? item.containingProject.id.primaryKey : null`;
    if (field === 'parentId') return `parentId: item.parent ? item.parent.id.primaryKey : null`;
    if (field === 'childIds') return `childIds: item.children ? item.children.map(c => c.id.primaryKey) : []`;
    if (field === 'hasChildren') return `hasChildren: item.children ? item.children.length > 0 : false`;
    if (field === 'folderName') return `folderName: item.parentFolder ? item.parentFolder.name : null`;
    if (field === 'folderID') return `folderID: item.parentFolder ? item.parentFolder.id.primaryKey : null`;
    if (field === 'taskCount') return `taskCount: item.tasks ? item.tasks.length : 0`;
    if (field === 'activeTaskCount') return `activeTaskCount: item.tasks ? item.tasks.filter(t => t.taskStatus !== Task.Status.Completed && t.taskStatus !== Task.Status.Dropped).length : 0`;
    if (field === 'tasks') return `tasks: item.tasks ? item.tasks.map(t => t.id.primaryKey) : []`;
    if (field === 'projectCount') return `projectCount: item.projects ? item.projects.length : 0`;
    if (field === 'projects') return `projects: item.projects ? item.projects.map(p => p.id.primaryKey) : []`;
    if (field === 'subfolders') return `subfolders: item.folders ? item.folders.map(f => f.id.primaryKey) : []`;
    if (field === 'path') return `path: item.container ? item.container.name + "/" + item.name : item.name`;
    if (field === 'estimatedMinutes') return `estimatedMinutes: item.estimatedMinutes || null`;
    if (field === 'note') return `note: item.note || ""`;
    return `${field}: item.${field} !== undefined ? item.${field} : null`;
  }).join(',\n          ');

  return `
    return {
      ${mappings}
    };
  `;
}
