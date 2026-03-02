/**
 * Plan Tree Executor.
 *
 * Recursively walks a PlanNode tree, executing each node and producing
 * a PlanResult ({kind:'rows', rows} or {kind:'idSet', ids}).
 *
 * Supports two entry points:
 *   - executePlan(node): legacy, each JXA leaf fires its own osascript
 *   - executeCompiledQuery(compiled): fused, pre-computed JXA results via slotMap
 */

import { executeJXA, executeOmniFocusScript } from '../../utils/scriptExecution.js';
import { compileWhere, CompileError } from './backends/jxaCompiler.js';
import { compileNodePredicate, type Row, type RowFn } from './backends/nodeEval.js';
import { lowerExpr } from './lower.js';
import type { LoweredExpr } from './fold.js';
import { getVarRegistry, type EntityType } from './variables.js';
import {
  generateBulkReadFromColumns,
  generatePerItemReadScript,
  generateMembershipScript,
} from './jxaBulkRead.js';
import type {
  PlanNode,
  PlanResult,
  BulkScan,
  OmniJSScan,
  MembershipScan,
  Filter,
  PreFilter,
  PerItemEnrich,
  Sort as SortNode,
  Limit as LimitNode,
  Project as ProjectNode,
  SemiJoin,
  CrossEntityJoin,
} from './planTree.js';
import type { SelfJoinEnrich } from './optimizations/selfJoinElimination.js';
import type { CompiledQuery, SlotEntry } from './compile.js';

// ── Execution Context ───────────────────────────────────────────────────

interface ExecContext {
  /** Accumulated timing per node kind */
  timings: Map<string, number>;
  /** Predicate cache to avoid recompiling the same (pred, entity, stubs) */
  predicateCache: Map<string, RowFn>;
  /** Pre-computed batch results from fused JXA execution (keyed by slot index). */
  batchResults: unknown[] | null;
  /** Map from JXA leaf PlanNode (by identity) → slot in batchResults. */
  slotMap: Map<PlanNode, SlotEntry> | null;
}

function createContext(): ExecContext {
  return { timings: new Map(), predicateCache: new Map(), batchResults: null, slotMap: null };
}

function recordTiming(ctx: ExecContext, kind: string, ms: number): void {
  ctx.timings.set(kind, (ctx.timings.get(kind) || 0) + ms);
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Execute a plan tree, returning rows or an id set.
 */
export async function executePlan(node: PlanNode): Promise<PlanResult> {
  const ctx = createContext();
  const result = await executeNode(node, ctx);
  logTimings(ctx);
  return result;
}

/**
 * Execute a compiled query with fused JXA scripts.
 *
 * Runs the batch/standalone script upfront, populates the slotMap,
 * then walks the plan tree — JXA leaf nodes return pre-computed results
 * instead of firing individual osascript invocations.
 */
export async function executeCompiledQuery(compiled: CompiledQuery): Promise<PlanResult> {
  const ctx = createContext();

  // Execute batch or standalone script
  const t = Date.now();
  let batchResults: unknown[] = [];

  if (compiled.batchScript) {
    const raw = await executeJXA(compiled.batchScript);
    if (!Array.isArray(raw)) {
      throw new Error('Batch script did not return an array');
    }
    batchResults = raw;
    recordTiming(ctx, 'BatchJXA', Date.now() - t);
  } else if (compiled.standaloneScript) {
    const raw = await executeJXA(compiled.standaloneScript);
    batchResults = [raw];
    recordTiming(ctx, 'StandaloneJXA', Date.now() - t);
  }

  // Populate context with pre-computed results
  ctx.batchResults = batchResults;
  ctx.slotMap = compiled.slotMap;

  // Walk the plan tree
  const result = await executeNode(compiled.root, ctx);
  logTimings(ctx);
  return result;
}

function logTimings(ctx: ExecContext): void {
  const parts: string[] = [];
  for (const [kind, ms] of ctx.timings) {
    parts.push(`${kind}=${ms}ms`);
  }
  if (parts.length > 0) {
    console.error(`[executor] ${parts.join(' ')}`);
  }
}

// ── Node Dispatch ───────────────────────────────────────────────────────

async function executeNode(node: PlanNode, ctx: ExecContext): Promise<PlanResult> {
  switch (node.kind) {
    case 'BulkScan':       return executeBulkScan(node, ctx);
    case 'OmniJSScan':     return executeOmniJSScan(node, ctx);
    case 'MembershipScan': return executeMembershipScan(node, ctx);
    case 'Filter':         return executeFilter(node, ctx);
    case 'PreFilter':      return executePreFilter(node, ctx);
    case 'PerItemEnrich':  return executePerItemEnrich(node, ctx);
    case 'Sort':           return executeSort(node, ctx);
    case 'Limit':          return executeLimit(node, ctx);
    case 'Project':           return executeProject(node, ctx);
    case 'SemiJoin':          return executeSemiJoin(node, ctx);
    case 'CrossEntityJoin':   return executeCrossEntityJoin(node, ctx);
    case 'SelfJoinEnrich':    return executeSelfJoinEnrich(node as SelfJoinEnrich, ctx);
  }
}

// ── Leaf Nodes ──────────────────────────────────────────────────────────

async function executeBulkScan(node: BulkScan, ctx: ExecContext): Promise<PlanResult> {
  // Check slotMap for pre-computed result
  const slot = ctx.slotMap?.get(node);
  if (slot && ctx.batchResults) {
    const rawResult = ctx.batchResults[slot.index];
    recordTiming(ctx, 'BulkScan(cached)', 0);
    return parseBulkScanResult(rawResult);
  }

  const t = Date.now();
  const script = generateBulkReadFromColumns(node);
  const rawResult = await executeJXA(script);
  recordTiming(ctx, 'BulkScan', Date.now() - t);

  return parseBulkScanResult(rawResult);
}

function parseBulkScanResult(rawResult: unknown): PlanResult {
  if (rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult) && 'error' in rawResult) {
    throw new Error(`Bulk read error: ${(rawResult as any).error}`);
  }

  const rows = rawResult as Row[];
  if (!Array.isArray(rows)) {
    throw new Error('Unexpected bulk read result format');
  }

  return { kind: 'rows', rows };
}

async function executeOmniJSScan(node: OmniJSScan, ctx: ExecContext): Promise<PlanResult> {
  const t = Date.now();

  // Perspectives use a dedicated script
  if (node.entity === 'perspectives') {
    const result = await executePerspectivesScan(node);
    recordTiming(ctx, 'OmniJSScan', Date.now() - t);
    return result;
  }

  // Compile the where clause to JXA for OmniJS execution
  let whereCondition: string | null = null;
  let preambleCode: string[] = [];

  if (node.filterAst !== true) {
    const result = compileWhere(node.filterAst as unknown, node.entity);
    whereCondition = result.condition;
    preambleCode = result.preamble;
  }

  const jxaScript = generateOmniJsScript(node, whereCondition, preambleCode);

  const tempFile = `/tmp/omnifocus_query_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.js`;
  const fs = await import('fs');
  fs.writeFileSync(tempFile, jxaScript);

  const result = await executeOmniFocusScript(tempFile);
  fs.unlinkSync(tempFile);

  recordTiming(ctx, 'OmniJSScan', Date.now() - t);

  if (result.error) {
    throw new Error(`OmniJS error: ${result.error}`);
  }

  return { kind: 'rows', rows: result.items || [] };
}

async function executeMembershipScan(node: MembershipScan, ctx: ExecContext): Promise<PlanResult> {
  // Check slotMap for pre-computed result
  const slot = ctx.slotMap?.get(node);
  if (slot && ctx.batchResults) {
    const rawResult = ctx.batchResults[slot.index];
    recordTiming(ctx, 'MembershipScan(cached)', 0);
    const ids = Array.isArray(rawResult) ? new Set(rawResult as string[]) : new Set<string>();
    return { kind: 'idSet', ids };
  }

  const t = Date.now();
  const script = generateMembershipScript(node);
  const rawResult = await executeJXA(script);
  recordTiming(ctx, 'MembershipScan', Date.now() - t);

  const ids = Array.isArray(rawResult) ? new Set(rawResult as string[]) : new Set<string>();
  return { kind: 'idSet', ids };
}

// ── Transform Nodes ─────────────────────────────────────────────────────

async function executeFilter(node: Filter, ctx: ExecContext): Promise<PlanResult> {
  const source = await executeNode(node.source, ctx);
  if (source.kind !== 'rows') throw new Error('Filter source must produce rows');

  const t = Date.now();
  const predicate = getCachedPredicate(ctx, node.predicate, node.entity);
  const rows = source.rows.filter(row => !!predicate(row));
  recordTiming(ctx, 'Filter', Date.now() - t);

  return { kind: 'rows', rows };
}

async function executePreFilter(node: PreFilter, ctx: ExecContext): Promise<PlanResult> {
  const source = await executeNode(node.source, ctx);
  if (source.kind !== 'rows') throw new Error('PreFilter source must produce rows');

  const t = Date.now();
  const cacheKey = predicateCacheKey(node.predicate, node.entity, node.assumeTrue);
  let predicate = ctx.predicateCache.get(cacheKey);
  if (!predicate) {
    predicate = compileNodePredicate(node.predicate, node.entity, { stubVars: node.assumeTrue });
    ctx.predicateCache.set(cacheKey, predicate);
  }
  const rows = source.rows.filter(row => !!predicate!(row));
  recordTiming(ctx, 'PreFilter', Date.now() - t);

  return { kind: 'rows', rows };
}

async function executePerItemEnrich(node: PerItemEnrich, ctx: ExecContext): Promise<PlanResult> {
  const source = await executeNode(node.source, ctx);
  if (source.kind !== 'rows') throw new Error('PerItemEnrich source must produce rows');

  let rows = source.rows;

  // Check threshold — if too many items, execute fallback instead
  if (rows.length > node.threshold) {
    console.error(`[executor] PerItemEnrich threshold exceeded (${rows.length} > ${node.threshold}), using fallback`);
    return executeNode(node.fallback, ctx);
  }

  if (rows.length === 0) {
    return { kind: 'rows', rows: [] };
  }

  // Per-item reads
  const t = Date.now();
  const ids = rows.map(r => r.id as string).filter(Boolean);

  if (ids.length === 0) {
    recordTiming(ctx, 'PerItemEnrich', Date.now() - t);
    return { kind: 'rows', rows };
  }

  const detailScript = generatePerItemReadScript(ids, node.perItemVars, node.entity);
  const detailResult = await executeJXA(detailScript);
  recordTiming(ctx, 'PerItemEnrich', Date.now() - t);

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

  return { kind: 'rows', rows };
}

async function executeSort(node: SortNode, ctx: ExecContext): Promise<PlanResult> {
  const source = await executeNode(node.source, ctx);
  if (source.kind !== 'rows') throw new Error('Sort source must produce rows');

  const t = Date.now();
  const rows = [...source.rows]; // clone to avoid mutating
  applySort(rows, node.by, node.direction, node.entity);
  recordTiming(ctx, 'Sort', Date.now() - t);

  return { kind: 'rows', rows };
}

async function executeLimit(node: LimitNode, ctx: ExecContext): Promise<PlanResult> {
  const source = await executeNode(node.source, ctx);
  if (source.kind !== 'rows') throw new Error('Limit source must produce rows');

  return { kind: 'rows', rows: source.rows.slice(0, node.count) };
}

async function executeProject(node: ProjectNode, ctx: ExecContext): Promise<PlanResult> {
  const source = await executeNode(node.source, ctx);
  if (source.kind !== 'rows') throw new Error('Project source must produce rows');

  const rows = source.rows.map(row => {
    const selected: Row = {};
    for (const field of node.fields) {
      if (field in row) {
        selected[field] = row[field];
      }
    }
    return selected;
  });

  return { kind: 'rows', rows };
}

// ── Binary Nodes ────────────────────────────────────────────────────────

async function executeSemiJoin(node: SemiJoin, ctx: ExecContext): Promise<PlanResult> {
  // Execute source and lookup in parallel
  const [sourceResult, lookupResult] = await Promise.all([
    executeNode(node.source, ctx),
    executeNode(node.lookup, ctx),
  ]);

  if (sourceResult.kind !== 'rows') throw new Error('SemiJoin source must produce rows');
  if (lookupResult.kind !== 'idSet') throw new Error('SemiJoin lookup must produce idSet');

  const t = Date.now();
  const ids = lookupResult.ids;
  const rows = sourceResult.rows.filter(row => {
    const id = row.id;
    if (id == null) {
      throw new Error('SemiJoin: source row missing "id" field. Ensure BulkScan includes id in columns.');
    }
    return ids.has(id as string);
  });
  recordTiming(ctx, 'SemiJoin', Date.now() - t);

  return { kind: 'rows', rows };
}

async function executeCrossEntityJoin(node: CrossEntityJoin, ctx: ExecContext): Promise<PlanResult> {
  // Execute source and lookup in parallel
  const [sourceResult, lookupResult] = await Promise.all([
    executeNode(node.source, ctx),
    executeNode(node.lookup, ctx),
  ]);

  if (sourceResult.kind !== 'rows') throw new Error('CrossEntityJoin source must produce rows');
  if (lookupResult.kind !== 'rows') throw new Error('CrossEntityJoin lookup must produce rows');

  const t = Date.now();

  // Check for count-aggregation mode: fieldMap = {'*': outputVarName}
  if ('*' in node.fieldMap) {
    const outputVar = node.fieldMap['*'];

    // Build count map: group lookup rows by lookupKey, count per group
    const countMap = new Map<string, number>();
    for (const row of lookupResult.rows) {
      const key = row[node.lookupKey];
      if (key != null) {
        const k = String(key);
        countMap.set(k, (countMap.get(k) || 0) + 1);
      }
    }

    // Merge counts into source rows
    for (const row of sourceResult.rows) {
      const sk = row[node.sourceKey];
      row[outputVar] = sk != null ? (countMap.get(String(sk)) || 0) : 0;
    }
  } else {
    // Direct join mode: build lookup map and merge fields
    const lookupMap = new Map<string, Row>();
    for (const row of lookupResult.rows) {
      const key = row[node.lookupKey];
      if (key != null) {
        lookupMap.set(String(key), row);
      }
    }

    for (const row of sourceResult.rows) {
      const fk = row[node.sourceKey];
      if (fk != null) {
        const lookupRow = lookupMap.get(String(fk));
        if (lookupRow) {
          for (const [lookupField, outputField] of Object.entries(node.fieldMap)) {
            row[outputField] = lookupRow[lookupField];
          }
        } else {
          for (const outputField of Object.values(node.fieldMap)) {
            row[outputField] = null;
          }
        }
      } else {
        for (const outputField of Object.values(node.fieldMap)) {
          row[outputField] = null;
        }
      }
    }
  }

  recordTiming(ctx, 'CrossEntityJoin', Date.now() - t);
  return { kind: 'rows', rows: sourceResult.rows };
}

async function executeSelfJoinEnrich(node: SelfJoinEnrich, ctx: ExecContext): Promise<PlanResult> {
  const sourceResult = await executeNode(node.source, ctx);
  if (sourceResult.kind !== 'rows') throw new Error('SelfJoinEnrich source must produce rows');

  const t = Date.now();
  const rows = sourceResult.rows;
  const isCount = node.aggregation === 'count';

  if (isCount) {
    // Count aggregation: count rows grouped by lookupKey, store as outputVar on sourceKey-matching rows
    const outputVar = node.fieldMap['*'];
    const counts = new Map<string, number>();
    for (const row of rows) {
      const groupKey = row[node.lookupKey];
      if (groupKey != null) {
        const key = String(groupKey);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    for (const row of rows) {
      const fk = row[node.sourceKey];
      row[outputVar] = fk != null ? (counts.get(String(fk)) || 0) : 0;
    }
  } else {
    // Direct lookup: build index from lookupKey → row, then enrich via sourceKey
    const lookupMap = new Map<string, Row>();
    for (const row of rows) {
      const key = row[node.lookupKey];
      if (key != null) {
        lookupMap.set(String(key), row);
      }
    }

    for (const row of rows) {
      const fk = row[node.sourceKey];
      if (fk != null) {
        const lookupRow = lookupMap.get(String(fk));
        if (lookupRow) {
          for (const [lookupField, outputField] of Object.entries(node.fieldMap)) {
            row[outputField] = lookupRow[lookupField];
          }
        } else {
          for (const outputField of Object.values(node.fieldMap)) {
            row[outputField] = null;
          }
        }
      } else {
        for (const outputField of Object.values(node.fieldMap)) {
          row[outputField] = null;
        }
      }
    }
  }

  recordTiming(ctx, 'SelfJoinEnrich', Date.now() - t);
  return { kind: 'rows', rows };
}

// ── Predicate Caching ───────────────────────────────────────────────────

function predicateCacheKey(pred: LoweredExpr, entity: EntityType, stubs?: Set<string>): string {
  const stubStr = stubs ? [...stubs].sort().join(',') : '';
  return JSON.stringify(pred) + '|' + entity + '|' + stubStr;
}

function getCachedPredicate(ctx: ExecContext, pred: LoweredExpr, entity: EntityType): RowFn {
  const key = predicateCacheKey(pred, entity);
  let fn = ctx.predicateCache.get(key);
  if (!fn) {
    fn = compileNodePredicate(pred, entity);
    ctx.predicateCache.set(key, fn);
  }
  return fn;
}

// ── Sort Helper ─────────────────────────────────────────────────────────

function applySort(rows: Row[], sortBy: string, direction: 'asc' | 'desc', entity: EntityType): void {
  const order = direction === 'desc' ? -1 : 1;
  const registry = getVarRegistry(entity);
  const def = registry[sortBy];
  const key = def?.nodeKey ?? sortBy;

  rows.sort((a, b) => {
    let aVal = a[key] as any;
    let bVal = b[key] as any;

    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;

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

// ── OmniJS Script Generation (moved from queryOmnifocus.ts) ─────────────

function generateOmniJsScript(
  node: OmniJSScan,
  whereCondition: string | null,
  preambleCode: string[]
): string {
  const entity = node.entity;
  const includeCompleted = node.includeCompleted;

  return `(() => {
    try {
      function formatDate(date) {
        if (!date) return null;
        return date.toISOString();
      }

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

      var _now = new Date();
      var _eq = function(a, b) {
        if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
        if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
        return a === b;
      };
      var _cmp = function(a, b) {
        if (a == null || b == null) return null;
        if (a instanceof Date) a = a.getTime();
        if (b instanceof Date) b = b.getTime();
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        if (typeof a === 'string' && typeof b === 'string') { a = a.toLowerCase(); b = b.toLowerCase(); return a < b ? -1 : a > b ? 1 : 0; }
        return null;
      };
      var _inArr = function(v, arr) {
        if (!arr || !arr.length) return false;
        for (var i = 0; i < arr.length; i++) { if (_eq(v, arr[i])) return true; }
        return false;
      };
      ${preambleCode.join('\n      ')}

      let items = [];
      const entityType = "${entity}";

      if (entityType === "tasks") {
        items = flattenedTasks;
      } else if (entityType === "projects") {
        items = flattenedProjects;
      } else if (entityType === "folders") {
        items = flattenedFolders;
      } else if (entityType === "tags") {
        items = flattenedTags;
      }

      let filtered = items.filter(item => {
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
          } else if (entityType === "tags") {
            if (item.effectivelyHidden) {
              return false;
            }
          }
        }

        ${whereCondition ? `return (${whereCondition});` : 'return true;'}
      });

      const results = filtered.map(item => {
        ${generateFieldMapping(entity)}
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

function generateFieldMapping(entity: string): string {
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
  } else if (entity === 'tags') {
    return `
        return {
          id: item.id.primaryKey,
          name: item.name || "",
          allowsNextAction: item.allowsNextAction,
          hidden: item.hidden,
          effectivelyHidden: item.effectivelyHidden,
          availableTaskCount: item.availableTasks ? item.availableTasks.length : 0,
          remainingTaskCount: item.remainingTasks ? item.remainingTasks.length : 0,
          parentName: item.parent ? item.parent.name : null
        };
      `;
  }

  return 'return {};';
}

// ── Perspectives ────────────────────────────────────────────────────────

async function executePerspectivesScan(node: OmniJSScan): Promise<PlanResult> {
  const script = `(() => {
    try {
      var items = [];

      var builtIns = [
        { obj: Perspective.BuiltIn.Inbox, name: "Inbox" },
        { obj: Perspective.BuiltIn.Projects, name: "Projects" },
        { obj: Perspective.BuiltIn.Tags, name: "Tags" },
        { obj: Perspective.BuiltIn.Forecast, name: "Forecast" },
        { obj: Perspective.BuiltIn.Flagged, name: "Flagged" },
        { obj: Perspective.BuiltIn.Review, name: "Review" }
      ];
      builtIns.forEach(function(p) {
        items.push({
          id: "builtin_" + p.name.toLowerCase(),
          name: p.name,
          type: "builtin"
        });
      });

      try {
        var customs = Perspective.Custom.all;
        if (customs && customs.length > 0) {
          customs.forEach(function(p) {
            items.push({
              id: p.identifier || ("custom_" + p.name.toLowerCase().replace(/\\s+/g, "_")),
              name: p.name,
              type: "custom"
            });
          });
        }
      } catch (e) {
        // Custom perspectives not available (Standard edition)
      }

      return JSON.stringify({ items: items, count: items.length, error: null });
    } catch (error) {
      return JSON.stringify({ error: error.toString(), items: [], count: 0 });
    }
  })()`;

  const tempFile = `/tmp/omnifocus_perspectives_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.js`;
  const fs = await import('fs');
  fs.writeFileSync(tempFile, script);

  const result = await executeOmniFocusScript(tempFile);
  fs.unlinkSync(tempFile);

  if (result.error) {
    throw new Error(`Perspectives error: ${result.error}`);
  }

  let items = result.items || [];

  // Node-side filtering by predicate if present
  if (node.filterAst !== true) {
    try {
      const predicate = compileNodePredicate(
        node.filterAst,
        'perspectives'
      );
      items = items.filter((row: any) => !!predicate(row));
    } catch (e) {
      console.error('Perspectives filter failed:', e);
    }
  }

  return { kind: 'rows', rows: items };
}
