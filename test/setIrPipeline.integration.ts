/**
 * SetIR pipeline integration test.
 *
 * Runs 8 representative queries through the new SetIR pipeline:
 *   lowerToSetIr → optimizeSetIr → lowerSetIrToEventPlan
 *   → cseEventPlan → pruneColumns → executeEventPlan
 *
 * Compares results against the legacy pipeline (compileQuery + executeCompiledQuery)
 * to verify parity. Active-filter and project-exclusion are injected here, matching
 * the default behaviour of the legacy pipeline.
 *
 * Bail-on-first-failure: the first assertion failure is reported with full
 * diagnostic detail; subsequent tests are skipped.
 *
 * Requires OmniFocus running. Run with:
 *   node --test test/setIrPipeline.integration.ts
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

// ── Legacy pipeline imports ──────────────────────────────────────────────────
import { lowerExpr }              from '../dist/tools/query/lower.js';
import { buildPlanTree }          from '../dist/tools/query/planner.js';
import { compileQuery }           from '../dist/tools/query/compile.js';
import { executeCompiledQuery }   from '../dist/tools/query/executor.js';
import { JxaEmitter }             from '../dist/tools/query/emitters/jxaEmitter.js';
import { optimize }               from '../dist/tools/query/strategy.js';
import { tagSemiJoinPass }        from '../dist/tools/query/optimizations/tagSemiJoin.js';
import { crossEntityJoinPass }    from '../dist/tools/query/optimizations/crossEntityJoin.js';
import { selfJoinEliminationPass } from '../dist/tools/query/optimizations/selfJoinElimination.js';
import { normalizePass }          from '../dist/tools/query/optimizations/normalize.js';

// ── SetIR pipeline imports ───────────────────────────────────────────────────
import { lowerToSetIr, optimizeSetIr } from '../dist/tools/query/lowerToSetIr.js';
import { lowerSetIrToEventPlan }        from '../dist/tools/query/lowerSetIrToEventPlan.js';
import { cseEventPlan }                 from '../dist/tools/query/eventPlanCSE.js';
import { pruneColumns }                 from '../dist/tools/query/eventPlanColumnPrune.js';
import { executeEventPlan }             from '../dist/tools/query/executionUnits/orchestrator.js';
import type { LoweredExpr }             from '../dist/tools/query/fold.js';
import type { EntityType }              from '../dist/tools/query/variables.js';

// ── Shared constants ─────────────────────────────────────────────────────────

const PASSES = [tagSemiJoinPass, crossEntityJoinPass, selfJoinEliminationPass, normalizePass];

// Active-filter predicates per entity (matches legacy default: includeCompleted=false).
function activeFilterForEntity(entity: EntityType): LoweredExpr | null {
  switch (entity) {
    case 'tasks':
      return {
        op: 'and', args: [
          { op: 'not', args: [{ var: 'effectivelyCompleted' }] },
          { op: 'not', args: [{ var: 'effectivelyDropped'   }] },
        ],
      };
    case 'projects':
      return { op: 'in', args: [{ var: 'status' }, ['Active', 'OnHold']] };
    case 'tags':
      return { op: 'not', args: [{ var: 'effectivelyHidden' }] };
    case 'folders':
      return null;   // No folder active filter in legacy
    default:
      return null;
  }
}

// ── Query specs ──────────────────────────────────────────────────────────────

interface QuerySpec {
  label:  string;
  entity: string;
  where:  unknown;
  select: string[];
}

const queries: QuerySpec[] = [
  {
    label:  'all tasks by name',
    entity: 'tasks',
    where:  null,
    select: ['name', 'dueDate', 'flagged'],
  },
  {
    label:  'flagged tasks',
    entity: 'tasks',
    where:  { eq: [{ var: 'flagged' }, true] },
    select: ['name', 'dueDate'],
  },
  {
    label:  'tasks with tag Work',
    entity: 'tasks',
    where:  { contains: [{ var: 'tags' }, 'Work'] },
    select: ['name'],
  },
  {
    label:  'tasks due before 2026-04-01',
    entity: 'tasks',
    where:  { lt: [{ var: 'dueDate' }, { date: '2026-04-01' }] },
    select: ['name', 'dueDate'],
  },
  {
    label:  'active projects',
    entity: 'projects',
    where:  { eq: [{ var: 'status' }, 'active'] },
    select: ['name', 'status'],
  },
  {
    label:  'projects with folderName',
    entity: 'projects',
    where:  null,
    select: ['name', 'folderName'],
  },
  {
    label:  'all tags',
    entity: 'tags',
    where:  null,
    select: ['name'],
  },
  {
    label:  'all folders',
    entity: 'folders',
    where:  null,
    select: ['name'],
  },
];

// ── Pipeline runners ─────────────────────────────────────────────────────────

function buildLegacyTree(q: QuerySpec) {
  const ast = q.where != null ? lowerExpr(q.where as any) : true;
  let tree = buildPlanTree(ast, q.entity as any, q.select, false);
  tree = { kind: 'Sort', source: tree, by: 'name', direction: 'asc', entity: q.entity } as any;
  return optimize(tree, PASSES);
}

async function runLegacy(q: QuerySpec): Promise<Record<string, unknown>[]> {
  const tree = buildLegacyTree(q);
  const compiled = compileQuery(tree, new JxaEmitter());
  const result = await executeCompiledQuery(compiled);
  if (result.kind !== 'rows') throw new Error(`Legacy produced ${result.kind}`);
  return selectFields(result.rows, q.select);
}

async function runSetIr(q: QuerySpec): Promise<Record<string, unknown>[]> {
  const entity = q.entity as EntityType;
  const baseAst: LoweredExpr = q.where != null ? lowerExpr(q.where as any) : null;

  // Inject active-filter (matches legacy default: includeCompleted=false)
  let predicate: LoweredExpr = baseAst;
  const activeFilter = activeFilterForEntity(entity);
  if (activeFilter !== null) {
    predicate = predicate !== null
      ? { op: 'and', args: [predicate, activeFilter] }
      : activeFilter;
  }

  // Build SetIR plan (sort deferred so project-exclusion wraps unsorted data)
  let plan = lowerToSetIr({
    predicate: predicate ?? true,
    entity,
    op: 'get',
    select: q.select,
  });

  // Project exclusion for tasks: subtract project root tasks
  if (entity === 'tasks') {
    plan = {
      kind: 'Difference',
      left:  plan,
      right: { kind: 'Scan', entity: 'projects', columns: ['id'] },
    };
  }

  // Add sort after exclusion for deterministic comparison
  plan = { kind: 'Sort', source: plan, by: 'name', direction: 'asc', entity };

  plan = optimizeSetIr(plan);

  const ep      = lowerSetIrToEventPlan(plan);
  const csed    = cseEventPlan(ep);
  const pruned  = pruneColumns(csed);
  const result  = await executeEventPlan(pruned);

  if (!Array.isArray(result.value)) {
    throw new Error(`SetIR pipeline produced non-array: ${typeof result.value}`);
  }
  return selectFields(result.value as Record<string, unknown>[], q.select);
}

function selectFields(
  rows:   Record<string, unknown>[],
  fields: string[],
): Record<string, unknown>[] {
  return rows.map(row => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (f in row) out[f] = row[f];
    }
    return out;
  });
}

// ── Result cache (shared between sub-tests for same query) ───────────────────

interface CachedOk  { ok: true;  legacy: Record<string, unknown>[]; setIr: Record<string, unknown>[] }
interface CachedErr { ok: false; error: string }
type CachedResult = CachedOk | CachedErr;

const cache = new Map<string, Promise<CachedResult>>();

function getResults(q: QuerySpec): Promise<CachedResult> {
  const hit = cache.get(q.label);
  if (hit) return hit;

  const promise = (async (): Promise<CachedResult> => {
    try {
      const [legacy, setIr] = await Promise.all([runLegacy(q), runSetIr(q)]);
      return { ok: true, legacy, setIr };
    } catch (err: any) {
      const msg = `Pipeline error for "${q.label}": ${err.message ?? err}`;
      recordFailure(msg);
      return { ok: false, error: msg };
    }
  })();

  cache.set(q.label, promise);
  return promise;
}

// ── Bail-on-first-failure ────────────────────────────────────────────────────

let hasFailed = false;
let failureDetail = '';

function bail(ctx: { skip: (msg: string) => void }) {
  if (hasFailed) ctx.skip(`Skipped — prior failure:\n${failureDetail}`);
}

function recordFailure(msg: string) {
  if (!hasFailed) { hasFailed = true; failureDetail = msg; }
}

function failAndBail(msg: string): never {
  recordFailure(msg);
  assert.fail(msg);
  throw undefined; // unreachable
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

function nameDiffSummary(a: unknown[], b: unknown[], limit = 5): string {
  const aSet = new Set(a.map(String));
  const bSet = new Set(b.map(String));
  const onlyA = a.filter(n => !bSet.has(String(n)));
  const onlyB = b.filter(n => !aSet.has(String(n)));
  const lines: string[] = [];
  if (onlyA.length) {
    lines.push(`  Only in legacy (${onlyA.length}):`);
    for (const n of onlyA.slice(0, limit)) lines.push(`    - ${JSON.stringify(n)}`);
    if (onlyA.length > limit) lines.push(`    ... +${onlyA.length - limit} more`);
  }
  if (onlyB.length) {
    lines.push(`  Only in setIr (${onlyB.length}):`);
    for (const n of onlyB.slice(0, limit)) lines.push(`    - ${JSON.stringify(n)}`);
    if (onlyB.length > limit) lines.push(`    ... +${onlyB.length - limit} more`);
  }
  return lines.join('\n');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SetIR pipeline integration (requires OmniFocus)', () => {
  let pass = 0, fail = 0;

  after(() => {
    console.log(`\n  SetIR integration: ${pass} passed, ${fail} failed`);
    if (hasFailed) console.log(`\n  First failure:\n${failureDetail}\n`);
  });

  for (const q of queries) {
    // ── row count ────────────────────────────────────────────────────────────
    it(`${q.label} [${q.entity}] — row count`, async (ctx) => {
      bail(ctx);
      const res = await getResults(q);
      if (!res.ok) { fail++; failAndBail(res.error); }

      if (res.setIr.length !== res.legacy.length) {
        fail++;
        failAndBail([
          `Row count mismatch for "${q.label}"`,
          `  legacy: ${res.legacy.length}  setIr: ${res.setIr.length}`,
          nameDiffSummary(res.legacy.map(r => r.name), res.setIr.map(r => r.name)),
        ].join('\n'));
      }
      pass++;
    });

    // ── field set ────────────────────────────────────────────────────────────
    it(`${q.label} [${q.entity}] — field set`, async (ctx) => {
      bail(ctx);
      const res = await getResults(q);
      if (!res.ok) { fail++; failAndBail(res.error); }

      if (res.legacy.length === 0 && res.setIr.length === 0) { pass++; return; }

      const lf = Object.keys(res.legacy[0] ?? {}).sort();
      const ef = Object.keys(res.setIr[0]  ?? {}).sort();
      if (JSON.stringify(ef) !== JSON.stringify(lf)) {
        fail++;
        failAndBail([
          `Field set mismatch for "${q.label}"`,
          `  legacy:  [${lf.join(', ')}]`,
          `  setIr:   [${ef.join(', ')}]`,
        ].join('\n'));
      }
      pass++;
    });

    // ── names match ──────────────────────────────────────────────────────────
    it(`${q.label} [${q.entity}] — names (sorted)`, async (ctx) => {
      bail(ctx);
      const res = await getResults(q);
      if (!res.ok) { fail++; failAndBail(res.error); }

      const ln = res.legacy.map(r => r.name).filter(Boolean).sort();
      const en = res.setIr.map(r => r.name).filter(Boolean).sort();
      if (JSON.stringify(en) !== JSON.stringify(ln)) {
        fail++;
        failAndBail([
          `Name mismatch for "${q.label}"`,
          `  legacy: ${ln.length}  setIr: ${en.length}`,
          nameDiffSummary(ln, en),
        ].join('\n'));
      }
      pass++;
    });
  }
});
