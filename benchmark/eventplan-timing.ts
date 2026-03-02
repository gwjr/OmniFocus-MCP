#!/usr/bin/env npx tsx
/**
 * EventPlan Pipeline Timing Benchmark
 *
 * Times the EventPlan pipeline (lowerStrategy + CSE + target + execute)
 * on 8 representative queries. 3 runs each, reports median + row count.
 *
 * Usage:
 *   npx tsx benchmark/eventplan-timing.ts
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

const PASSES = [tagSemiJoinPass, crossEntityJoinPass, selfJoinEliminationPass, normalizePass];
const RUNS = 3;

interface QuerySpec {
  label: string;
  entity: string;
  where: any;
  select: string[];
}

const queries: QuerySpec[] = [
  { label: 'all tasks',             entity: 'tasks',    where: null,                                                          select: ['name', 'dueDate', 'flagged'] },
  { label: 'flagged tasks',         entity: 'tasks',    where: { eq: [{ var: 'flagged' }, true] },                            select: ['name', 'dueDate'] },
  { label: 'tasks with tag Work',   entity: 'tasks',    where: { contains: [{ var: 'tags' }, 'Work'] },                       select: ['name'] },
  { label: 'tasks due soon',        entity: 'tasks',    where: { lt: [{ var: 'dueDate' }, { date: '2026-04-01' }] },          select: ['name', 'dueDate'] },
  { label: 'active projects',       entity: 'projects', where: { eq: [{ var: 'status' }, 'active'] },                         select: ['name', 'status'] },
  { label: 'projects + folderName', entity: 'projects', where: null,                                                          select: ['name', 'folderName'] },
  { label: 'all tags',              entity: 'tags',     where: null,                                                          select: ['name'] },
  { label: 'all folders',           entity: 'folders',  where: null,                                                          select: ['name'] },
];

function buildTree(q: QuerySpec) {
  const ast = q.where != null ? lowerExpr(q.where) : true;
  let tree = buildPlanTree(ast, q.entity as any, q.select, false);
  tree = optimize(tree, PASSES);
  return tree;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function timeQuery(q: QuerySpec): Promise<{ ms: number; rows: number; error?: string }> {
  try {
    const tree = buildTree(q);
    const t0 = performance.now();
    const result = await executeEventPlanPipeline(tree);
    const ms = performance.now() - t0;
    const rows = Array.isArray(result.value) ? result.value.length : -1;
    return { ms, rows };
  } catch (err: any) {
    return { ms: -1, rows: -1, error: err.message ?? String(err) };
  }
}

async function main() {
  console.error('EventPlan Pipeline Timing Benchmark');
  console.error(`${RUNS} runs per query, reporting median\n`);

  // Warm-up
  console.error('Warming up...');
  await timeQuery(queries[queries.length - 1]);
  console.error('Warm-up done.\n');

  const results: { label: string; entity: string; medianMs: number; rows: number; error?: string }[] = [];

  for (const q of queries) {
    console.error(`  ${q.label} [${q.entity}]`);
    const times: number[] = [];
    let lastRows = 0;
    let lastError: string | undefined;

    for (let i = 0; i < RUNS; i++) {
      const r = await timeQuery(q);
      if (r.error) {
        console.error(`    run ${i + 1}: ERROR — ${r.error}`);
        lastError = r.error;
      } else {
        times.push(r.ms);
        lastRows = r.rows;
        console.error(`    run ${i + 1}: ${fmtMs(r.ms)} (${r.rows} rows)`);
      }
    }

    if (times.length > 0) {
      results.push({ label: q.label, entity: q.entity, medianMs: median(times), rows: lastRows });
    } else {
      results.push({ label: q.label, entity: q.entity, medianMs: -1, rows: -1, error: lastError });
    }
  }

  const total = results.filter(r => r.medianMs > 0).reduce((s, r) => s + r.medianMs, 0);

  console.log('');
  console.log('| Query | Entity | Median | Rows | Status |');
  console.log('|-------|--------|--------|------|--------|');
  for (const r of results) {
    if (r.error) {
      console.log(`| ${r.label} | ${r.entity} | - | - | ERROR: ${r.error.slice(0, 60)} |`);
    } else {
      console.log(`| ${r.label} | ${r.entity} | ${fmtMs(r.medianMs)} | ${r.rows} | ok |`);
    }
  }
  console.log(`| **Total** | | **${fmtMs(total)}** | | |`);
  console.log('');
  console.log(`_${new Date().toISOString()}_`);
}

main().catch(err => {
  console.error(`\nBenchmark failed: ${err.message ?? err}`);
  process.exit(1);
});
