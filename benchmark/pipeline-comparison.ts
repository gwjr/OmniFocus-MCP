#!/usr/bin/env npx tsx
/**
 * Pipeline Comparison Benchmark
 *
 * Runs 8 representative queries through both the legacy pipeline
 * (compileQuery + executeCompiledQuery) and the new EventPlan pipeline
 * (lowerStrategy + cseEventPlan + executeEventPlanPipeline), measuring
 * wall-clock time for each.
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

function fmtDelta(legacyMs: number, eventPlanMs: number): string {
  if (legacyMs === 0) return 'N/A';
  const pct = ((eventPlanMs - legacyMs) / legacyMs) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// ── Pipeline runners ─────────────────────────────────────────────────────

async function timeLegacy(q: QuerySpec): Promise<number> {
  const tree = buildOptimizedTree(q);
  const compiled = compileQuery(tree, new JxaEmitter());
  const t0 = performance.now();
  await executeCompiledQuery(compiled);
  return performance.now() - t0;
}

async function timeEventPlan(q: QuerySpec): Promise<number> {
  const tree = buildOptimizedTree(q);
  const t0 = performance.now();
  await executeEventPlanPipeline(tree);
  return performance.now() - t0;
}

// ── Main ─────────────────────────────────────────────────────────────────

interface Result {
  label: string;
  entity: string;
  legacyMedian: number;
  eventPlanMedian: number;
}

async function main() {
  console.error(`Pipeline Comparison Benchmark`);
  console.error(`${RUNS} runs per query per pipeline, reporting median\n`);

  // Warm-up: run one trivial query through each pipeline to absorb startup costs
  console.error('Warming up...');
  const warmup = queries[queries.length - 1]; // folders — smallest
  await timeLegacy(warmup);
  await timeEventPlan(warmup);
  console.error('Warm-up complete.\n');

  const results: Result[] = [];

  for (const q of queries) {
    console.error(`  ${q.label} [${q.entity}]`);

    // Legacy runs
    const legacyTimes: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const ms = await timeLegacy(q);
      legacyTimes.push(ms);
      console.error(`    legacy run ${i + 1}: ${fmtMs(ms)}`);
    }

    // EventPlan runs
    const eventPlanTimes: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const ms = await timeEventPlan(q);
      eventPlanTimes.push(ms);
      console.error(`    eventPlan run ${i + 1}: ${fmtMs(ms)}`);
    }

    results.push({
      label: q.label,
      entity: q.entity,
      legacyMedian: median(legacyTimes),
      eventPlanMedian: median(eventPlanTimes),
    });
  }

  // Compute totals
  const totalLegacy = results.reduce((s, r) => s + r.legacyMedian, 0);
  const totalEventPlan = results.reduce((s, r) => s + r.eventPlanMedian, 0);

  // Output markdown table to stdout
  console.log('# Pipeline Comparison Benchmark');
  console.log('');
  console.log(`${RUNS} runs per query, median reported.`);
  console.log('');
  console.log('| Query | Entity | Legacy | EventPlan | Delta |');
  console.log('|-------|--------|--------|-----------|-------|');
  for (const r of results) {
    console.log(
      `| ${r.label} | ${r.entity} | ${fmtMs(r.legacyMedian)} | ${fmtMs(r.eventPlanMedian)} | ${fmtDelta(r.legacyMedian, r.eventPlanMedian)} |`,
    );
  }
  console.log(
    `| **Total** | | **${fmtMs(totalLegacy)}** | **${fmtMs(totalEventPlan)}** | **${fmtDelta(totalLegacy, totalEventPlan)}** |`,
  );
  console.log('');
  console.log(`_Generated ${new Date().toISOString()}_`);
}

main().catch(err => {
  console.error(`\nBenchmark failed: ${err.message ?? err}`);
  process.exit(1);
});
