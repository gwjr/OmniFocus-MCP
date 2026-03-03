#!/usr/bin/env npx tsx
/**
 * Pipeline Comparison Benchmark
 *
 * Runs 8 representative queries through both the legacy EventPlan pipeline
 * (StrategyNode → lowerStrategy → cseEventPlan → executeEventPlanPipeline)
 * and the new SetIR pipeline (lowerToSetIr → lowerSetIrToEventPlan →
 * cseEventPlan → pruneColumns → executeEventPlan), measuring wall-clock
 * time for each.
 *
 * 3 runs per query per pipeline; reports median. Pipelines run
 * sequentially to avoid OmniFocus contention.
 *
 * Output: markdown table to stdout.
 *
 * Usage:
 *   npx tsx benchmark/pipeline-comparison.ts
 *
 * Requires OmniFocus running.
 */

import { lowerExpr } from '../dist/tools/query/lower.js';
import { buildPlanTree } from '../dist/tools/query/planner.js';
import { optimize } from '../dist/tools/query/strategy.js';
import { tagSemiJoinPass } from '../dist/tools/query/optimizations/tagSemiJoin.js';
import { crossEntityJoinPass } from '../dist/tools/query/optimizations/crossEntityJoin.js';
import { selfJoinEliminationPass } from '../dist/tools/query/optimizations/selfJoinElimination.js';
import { normalizePass } from '../dist/tools/query/optimizations/normalize.js';
import { executeEventPlanPipeline } from '../dist/tools/query/executionUnits/orchestrator.js';

// SetIR pipeline imports
import { lowerToSetIr, optimizeSetIr } from '../dist/tools/query/lowerToSetIr.js';
import { lowerSetIrToEventPlan } from '../dist/tools/query/lowerSetIrToEventPlan.js';
import { cseEventPlan } from '../dist/tools/query/eventPlanCSE.js';
import { pruneColumns } from '../dist/tools/query/eventPlanColumnPrune.js';
import { executeEventPlan } from '../dist/tools/query/executionUnits/orchestrator.js';
import type { LoweredExpr } from '../dist/tools/query/fold.js';
import type { EntityType } from '../dist/tools/query/variables.js';

// ── Constants ────────────────────────────────────────────────────────────

const PASSES = [tagSemiJoinPass, crossEntityJoinPass, selfJoinEliminationPass, normalizePass];
const RUNS = 3;

// ── Queries ──────────────────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────────

// ── Active filters (match legacy default: includeCompleted=false) ────────

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
      return null;
    default:
      return null;
  }
}

function buildOptimizedTree(q: QuerySpec) {
  const ast = q.where != null ? lowerExpr(q.where) : true;
  let tree = buildPlanTree(ast, q.entity as any, q.select, false);
  tree = optimize(tree, PASSES);
  return tree;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function fmtMs(ms: number): string {
  return ms < 1000
    ? `${ms.toFixed(0)}ms`
    : `${(ms / 1000).toFixed(2)}s`;
}

function fmtDelta(baseMs: number, newMs: number): string {
  if (baseMs === 0) return 'N/A';
  const pct = ((newMs - baseMs) / baseMs) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// ── Pipeline runners ─────────────────────────────────────────────────────

async function timeEventPlan(q: QuerySpec): Promise<number> {
  const tree = buildOptimizedTree(q);
  const t0 = performance.now();
  await executeEventPlanPipeline(tree);
  return performance.now() - t0;
}

async function timeSetIr(q: QuerySpec): Promise<number> {
  const entity = q.entity as EntityType;
  const baseAst: LoweredExpr = q.where != null ? lowerExpr(q.where) : null;

  let predicate: LoweredExpr = baseAst;
  const activeFilter = activeFilterForEntity(entity);
  if (activeFilter !== null) {
    predicate = predicate !== null
      ? { op: 'and', args: [predicate, activeFilter] }
      : activeFilter;
  }

  let plan = lowerToSetIr({
    predicate: predicate ?? true,
    entity,
    op: 'get',
    select: q.select,
  });

  if (entity === 'tasks') {
    plan = {
      kind: 'Difference',
      left: plan,
      right: { kind: 'Scan', entity: 'projects', columns: ['id'] },
    };
  }

  plan = optimizeSetIr(plan);

  const t0 = performance.now();
  const ep = lowerSetIrToEventPlan(plan, q.select);
  const csed = cseEventPlan(ep);
  const pruned = pruneColumns(csed);
  await executeEventPlan(pruned);
  return performance.now() - t0;
}

// ── Main ─────────────────────────────────────────────────────────────────

interface Result {
  label: string;
  entity: string;
  eventPlanMedian: number;
  setIrMedian: number;
}

async function main() {
  console.error(`Pipeline Comparison: EventPlan vs SetIR`);
  console.error(`${RUNS} runs per query per pipeline, reporting median\n`);

  // Warm-up
  console.error('Warming up...');
  const warmup = queries[queries.length - 1]; // folders — smallest
  await timeEventPlan(warmup);
  await timeSetIr(warmup);
  console.error('Warm-up complete.\n');

  const results: Result[] = [];

  for (const q of queries) {
    console.error(`  ${q.label} [${q.entity}]`);

    // EventPlan (StrategyNode path) runs
    const epTimes: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const ms = await timeEventPlan(q);
      epTimes.push(ms);
      console.error(`    eventPlan run ${i + 1}: ${fmtMs(ms)}`);
    }

    // SetIR runs
    const setIrTimes: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const ms = await timeSetIr(q);
      setIrTimes.push(ms);
      console.error(`    setIR run ${i + 1}: ${fmtMs(ms)}`);
    }

    results.push({
      label: q.label,
      entity: q.entity,
      eventPlanMedian: median(epTimes),
      setIrMedian: median(setIrTimes),
    });
  }

  // Compute totals
  const totalEP = results.reduce((s, r) => s + r.eventPlanMedian, 0);
  const totalSetIr = results.reduce((s, r) => s + r.setIrMedian, 0);

  // Output markdown table to stdout
  console.log('# Pipeline Comparison: EventPlan vs SetIR');
  console.log('');
  console.log(`${RUNS} runs per query, median reported.`);
  console.log('');
  console.log('| Query | Entity | EventPlan | SetIR | Delta |');
  console.log('|-------|--------|-----------|-------|-------|');
  for (const r of results) {
    console.log(
      `| ${r.label} | ${r.entity} | ${fmtMs(r.eventPlanMedian)} | ${fmtMs(r.setIrMedian)} | ${fmtDelta(r.eventPlanMedian, r.setIrMedian)} |`,
    );
  }
  console.log(
    `| **Total** | | **${fmtMs(totalEP)}** | **${fmtMs(totalSetIr)}** | **${fmtDelta(totalEP, totalSetIr)}** |`,
  );
  console.log('');
  console.log(`_Generated ${new Date().toISOString()}_`);
}

main().catch(err => {
  console.error(`\nBenchmark failed: ${err.message ?? err}`);
  process.exit(1);
});
