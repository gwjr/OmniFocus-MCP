/**
 * EventPlan pipeline integration test.
 *
 * Runs the same 8 queries from codegenBaseline.test.ts through BOTH the
 * legacy pipeline (compileQuery + executeCompiledQuery) and the new
 * EventPlan pipeline (lowerStrategy + cseEventPlan + executeEventPlan),
 * then asserts that the results are equivalent.
 *
 * Bail-on-first-failure: the first assertion failure is reported with
 * full diagnostic detail and all subsequent tests are skipped. This
 * avoids waiting minutes for remaining queries when the root cause is
 * already visible.
 *
 * Requires OmniFocus running. Run with:
 *   node --test test/eventPlanPipeline.integration.ts
 *
 * Skip in CI: these tests talk to a live OmniFocus instance.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { lowerExpr } from '../dist/tools/query/lower.js';
import { buildPlanTree } from '../dist/tools/query/planner.js';
import { executeCompiledQuery } from '../dist/tools/query/executor.js';
import { compileQuery } from '../dist/tools/query/compile.js';
import { JxaEmitter } from '../dist/tools/query/emitters/jxaEmitter.js';
import { optimize } from '../dist/tools/query/strategy.js';
import { tagSemiJoinPass } from '../dist/tools/query/optimizations/tagSemiJoin.js';
import { crossEntityJoinPass } from '../dist/tools/query/optimizations/crossEntityJoin.js';
import { selfJoinEliminationPass } from '../dist/tools/query/optimizations/selfJoinElimination.js';
import { normalizePass } from '../dist/tools/query/optimizations/normalize.js';
import { executeEventPlanPipeline } from '../dist/tools/query/executionUnits/orchestrator.js';

// ── Constants ────────────────────────────────────────────────────────────

const PASSES = [tagSemiJoinPass, crossEntityJoinPass, selfJoinEliminationPass, normalizePass];

// ── Queries (same 8 as codegenBaseline.test.ts) ──────────────────────────

interface QuerySpec {
  label: string;
  entity: string;
  where: any;
  select: string[];
}

const queries: QuerySpec[] = [
  {
    label: 'all tasks by name',
    entity: 'tasks',
    where: null,
    select: ['name', 'dueDate', 'flagged'],
  },
  {
    label: 'flagged tasks',
    entity: 'tasks',
    where: { eq: [{ var: 'flagged' }, true] },
    select: ['name', 'dueDate'],
  },
  {
    label: 'tasks with tag Work',
    entity: 'tasks',
    where: { contains: [{ var: 'tags' }, 'Work'] },
    select: ['name'],
  },
  {
    label: 'tasks due soon',
    entity: 'tasks',
    where: { lt: [{ var: 'dueDate' }, { date: '2026-04-01' }] },
    select: ['name', 'dueDate'],
  },
  {
    label: 'active projects',
    entity: 'projects',
    where: { eq: [{ var: 'status' }, 'active'] },
    select: ['name', 'status'],
  },
  {
    label: 'projects with folderName',
    entity: 'projects',
    where: null,
    select: ['name', 'folderName'],
  },
  {
    label: 'all tags',
    entity: 'tags',
    where: null,
    select: ['name'],
  },
  {
    label: 'all folders',
    entity: 'folders',
    where: null,
    select: ['name'],
  },
];

// ── Pipeline helpers ────────────────────────────────────────────────────

function buildOptimizedTree(q: QuerySpec) {
  const ast = q.where != null ? lowerExpr(q.where) : true;
  let tree = buildPlanTree(ast, q.entity as any, q.select, false);

  // Wrap with sort (by name for deterministic comparison)
  tree = { kind: 'Sort', source: tree, by: 'name', direction: 'asc', entity: q.entity } as any;

  tree = optimize(tree, PASSES);
  return tree;
}

async function runLegacy(q: QuerySpec): Promise<Record<string, unknown>[]> {
  const tree = buildOptimizedTree(q);
  const compiled = compileQuery(tree, new JxaEmitter());
  const result = await executeCompiledQuery(compiled);
  if (result.kind !== 'rows') throw new Error(`Legacy produced ${result.kind}`);
  return selectFields(result.rows, q.select);
}

async function runEventPlan(q: QuerySpec): Promise<Record<string, unknown>[]> {
  let orchResult;
  try {
    const tree = buildOptimizedTree(q);
    orchResult = await executeEventPlanPipeline(tree);
  } catch (err: any) {
    throw new Error(`EventPlan pipeline error for "${q.label}" [${q.entity}]: ${err.message ?? err}`);
  }
  if (!Array.isArray(orchResult.value)) {
    throw new Error(`EventPlan produced non-array for "${q.label}" [${q.entity}]: ${typeof orchResult.value}`);
  }
  return selectFields(orchResult.value as Record<string, unknown>[], q.select);
}

function selectFields(rows: Record<string, unknown>[], fields: string[]): Record<string, unknown>[] {
  return rows.map(row => {
    const selected: Record<string, unknown> = {};
    for (const f of fields) {
      if (f in row) selected[f] = row[f];
    }
    return selected;
  });
}

// ── Bail-on-first-failure state ──────────────────────────────────────────

let hasFailed = false;
let failureDetail = '';

function bail(ctx: { skip: (msg: string) => void }) {
  if (hasFailed) ctx.skip(`Skipped — prior failure:\n${failureDetail}`);
}

function recordFailure(msg: string): void {
  if (!hasFailed) {
    hasFailed = true;
    failureDetail = msg;
  }
}

// ── Diagnostic helpers ──────────────────────────────────────────────────

/** Show the first N items that differ between two sorted name arrays. */
function nameDiffSummary(
  legacyNames: unknown[],
  eventPlanNames: unknown[],
  limit = 10,
): string {
  const legacySet = new Set(legacyNames.map(String));
  const eventPlanSet = new Set(eventPlanNames.map(String));

  const onlyLegacy = legacyNames.filter(n => !eventPlanSet.has(String(n)));
  const onlyEventPlan = eventPlanNames.filter(n => !legacySet.has(String(n)));

  const lines: string[] = [];
  if (onlyLegacy.length > 0) {
    lines.push(`  Only in legacy (${onlyLegacy.length} total):`);
    for (const n of onlyLegacy.slice(0, limit)) lines.push(`    - ${JSON.stringify(n)}`);
    if (onlyLegacy.length > limit) lines.push(`    ... and ${onlyLegacy.length - limit} more`);
  }
  if (onlyEventPlan.length > 0) {
    lines.push(`  Only in eventPlan (${onlyEventPlan.length} total):`);
    for (const n of onlyEventPlan.slice(0, limit)) lines.push(`    - ${JSON.stringify(n)}`);
    if (onlyEventPlan.length > limit) lines.push(`    ... and ${onlyEventPlan.length - limit} more`);
  }
  return lines.join('\n');
}

function fieldSetSummary(
  legacyFields: string[],
  eventPlanFields: string[],
): string {
  const lines: string[] = [];
  const lSet = new Set(legacyFields);
  const eSet = new Set(eventPlanFields);
  const onlyL = legacyFields.filter(f => !eSet.has(f));
  const onlyE = eventPlanFields.filter(f => !lSet.has(f));
  if (onlyL.length) lines.push(`  Only in legacy fields: ${onlyL.join(', ')}`);
  if (onlyE.length) lines.push(`  Only in eventPlan fields: ${onlyE.join(', ')}`);
  lines.push(`  Legacy fields: [${legacyFields.join(', ')}]`);
  lines.push(`  EventPlan fields: [${eventPlanFields.join(', ')}]`);
  return lines.join('\n');
}

// ── Result cache ────────────────────────────────────────────────────────

interface CachedOk { ok: true; legacy: Record<string, unknown>[]; eventPlan: Record<string, unknown>[] }
interface CachedErr { ok: false; error: string }
type CachedResult = CachedOk | CachedErr;

const resultCache = new Map<string, Promise<CachedResult>>();

function getResults(q: QuerySpec): Promise<CachedResult> {
  const cached = resultCache.get(q.label);
  if (cached) return cached;

  const promise = (async (): Promise<CachedResult> => {
    try {
      const [legacy, eventPlan] = await Promise.all([
        runLegacy(q),
        runEventPlan(q),
      ]);
      return { ok: true, legacy, eventPlan };
    } catch (err: any) {
      const msg = `Pipeline error for "${q.label}": ${err.message ?? err}`;
      recordFailure(msg);
      return { ok: false, error: msg };
    }
  })();

  resultCache.set(q.label, promise);
  return promise;
}

// ── Test helpers ─────────────────────────────────────────────────────────

/** Await the cached result; throw (with bail) if the pipeline errored. */
async function requireResults(q: QuerySpec): Promise<{ legacy: Record<string, unknown>[]; eventPlan: Record<string, unknown>[] }> {
  const result = await getResults(q);
  if (!result.ok) {
    const { error } = result;
    throw new Error(error);
  }
  return result;
}

function failAndBail(msg: string): never {
  recordFailure(msg);
  assert.fail(msg);
  throw undefined; // unreachable — satisfies TS 'never' return type
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('EventPlan pipeline integration (requires OmniFocus)', () => {
  let passCount = 0;
  let failCount = 0;

  after(() => {
    console.log(`\n  EventPlan integration: ${passCount} passed, ${failCount} failed, ${hasFailed ? 'BAILED' : 'complete'}`);
    if (hasFailed) {
      console.log(`\n  First failure detail:\n${failureDetail}\n`);
    }
  });

  for (const q of queries) {
    it(`${q.label} [${q.entity}] — same row count`, async (ctx) => {
      bail(ctx);
      const { legacy, eventPlan } = await requireResults(q);

      if (eventPlan.length !== legacy.length) {
        const legacySample = legacy.slice(0, 3).map(r => r.name);
        const eventPlanSample = eventPlan.slice(0, 3).map(r => r.name);
        failCount++;
        failAndBail([
          `Row count mismatch for "${q.label}" [${q.entity}]`,
          `  legacy: ${legacy.length} rows  (first 3: ${JSON.stringify(legacySample)})`,
          `  eventPlan: ${eventPlan.length} rows  (first 3: ${JSON.stringify(eventPlanSample)})`,
          `  delta: ${eventPlan.length - legacy.length}`,
          nameDiffSummary(
            legacy.map(r => r.name),
            eventPlan.map(r => r.name),
            3,
          ),
        ].join('\n'));
      }
      passCount++;
    });

    it(`${q.label} [${q.entity}] — same field set`, async (ctx) => {
      bail(ctx);
      const { legacy, eventPlan } = await requireResults(q);

      if (legacy.length === 0 && eventPlan.length === 0) { passCount++; return; }

      const legacyFields = Object.keys(legacy[0] ?? {}).sort();
      const eventPlanFields = Object.keys(eventPlan[0] ?? {}).sort();

      if (JSON.stringify(eventPlanFields) !== JSON.stringify(legacyFields)) {
        failCount++;
        failAndBail([
          `Field set mismatch for "${q.label}" [${q.entity}]`,
          fieldSetSummary(legacyFields, eventPlanFields),
        ].join('\n'));
      }
      passCount++;
    });

    it(`${q.label} [${q.entity}] — same names (sorted)`, async (ctx) => {
      bail(ctx);
      const { legacy, eventPlan } = await requireResults(q);

      const legacyNames = legacy.map(r => r.name).filter(Boolean).sort();
      const eventPlanNames = eventPlan.map(r => r.name).filter(Boolean).sort();

      if (JSON.stringify(eventPlanNames) !== JSON.stringify(legacyNames)) {
        failCount++;
        failAndBail([
          `Name values mismatch for "${q.label}" [${q.entity}]`,
          `  legacy names: ${legacyNames.length}`,
          `  eventPlan names: ${eventPlanNames.length}`,
          nameDiffSummary(legacyNames, eventPlanNames, 3),
        ].join('\n'));
      }
      passCount++;
    });
  }
});
