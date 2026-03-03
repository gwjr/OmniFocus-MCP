#!/usr/bin/env npx tsx
/**
 * Optimizer fast-path benchmark.
 *
 * Measures wall-clock time for 5 query patterns that each exercise a specific
 * optimizer path added this session.  Each case is run 3 times; the median is
 * reported.  Timings include the full pipeline overhead (Node build + JXA IPC
 * round-trips) so they represent real latency as seen by the MCP caller.
 *
 * Requires OmniFocus running and `npm run build` up to date.
 * Run with:   npx tsx benchmark/pipeline-paths.ts
 *
 * Cases:
 *  1. Unfiltered count (native AE fast-path)
 *  2. Filtered count — active filter only (full pipeline, no id read after #75)
 *  3. Tag-name semi-join — tasks matching a specific tag name
 *  4. Task-only predicate — flagged tasks (no project-exclusion Difference)
 *  5. Containing FK semi-join — projects containing flagged tasks
 */

import { executeQueryFromAst } from '../dist/tools/query/executionUnits/orchestrator.js';
import { executeJXA }         from '../dist/utils/scriptExecution.js';
import type { LoweredExpr }   from '../dist/tools/query/fold.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a simple lowered eq predicate. */
function eqPred(varName: string, value: unknown): LoweredExpr {
  return { op: 'eq', args: [{ var: varName }, value as LoweredExpr] };
}

/** Build a lowered contains predicate (e.g. tags contains 'name'). */
function containsPred(varName: string, value: string): LoweredExpr {
  return { op: 'contains', args: [{ var: varName }, value] };
}

/** Build a lowered containing predicate (entity containing tasks where ...). */
function containingPred(childEntity: string, predicate: LoweredExpr): LoweredExpr {
  return { op: 'containing', args: [childEntity, predicate] };
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface BenchResult {
  name: string;
  medianMs: number;
  runs: number[];
  detail: string;
}

async function bench(
  name: string,
  fn: () => Promise<string>,
  n = 3,
): Promise<BenchResult> {
  const runs: number[] = [];
  let detail = '';
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const d = await fn();
    runs.push(Math.round(performance.now() - t0));
    if (i === 0) detail = d;
  }
  return { name, medianMs: median(runs), runs, detail };
}

function printTable(title: string, results: BenchResult[]) {
  console.log(`\n## ${title}\n`);
  const nw = Math.max(55, ...results.map(r => r.name.length));
  const hdr = `${'Case'.padEnd(nw)}  Median   Runs              Detail`;
  console.log(hdr);
  console.log('-'.repeat(hdr.length + 10));
  for (const r of results) {
    const runsStr = r.runs.map(v => `${v}ms`).join(', ');
    console.log(`${r.name.padEnd(nw)}  ${String(r.medianMs).padStart(5)}ms  [${runsStr.padEnd(20)}]  ${r.detail}`);
  }
}

// ── Setup: discover a real tag name ─────────────────────────────────────────

console.log('# Pipeline Optimizer Paths Benchmark');
console.log(`Date: ${new Date().toISOString()}`);
console.log('Loading tag names from OmniFocus...');

const tagScript = `(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var names = doc.flattenedTags.name();
  return JSON.stringify(names.slice(0, 5));
})()`;

const tagRaw = await executeJXA(tagScript) as string[];
const sampleTag: string | null = Array.isArray(tagRaw) && tagRaw.length > 0 ? tagRaw[0] : null;
console.log(`Sample tag: ${sampleTag ?? '(none — tag cases will be skipped)'}\n`);

// ── Benchmark cases ──────────────────────────────────────────────────────────

const results: BenchResult[] = [];

// ── Case 1: Unfiltered count (native AE fast-path) ─────────────────────────
//
// predicate === true → executeNativeCount() → single JXA: .length - .length
// Expected: ~12–30ms (vs ~200ms full pipeline).

results.push(await bench(
  '1. Unfiltered count (native .length fast-path)',
  async () => {
    const r = await executeQueryFromAst({
      predicate: true,
      entity: 'tasks',
      op: 'count',
    });
    return `count=${r.value}`;
  },
));

// ── Case 2: Filtered count — active filter only ────────────────────────────
//
// Predicate: flagged === true (single cheap var)
// Goes through full pipeline → RowCount EventPlan node.
// After #75 fix (if merged): id column not read.
// Expected: ~200–400ms (single JXA round-trip: id + flagged, then count in Node).

results.push(await bench(
  '2. Filtered count — flagged tasks (full pipeline)',
  async () => {
    const predicate = eqPred('flagged', true);
    const r = await executeQueryFromAst({
      predicate,
      entity: 'tasks',
      op: 'count',
    });
    return `count=${r.value}`;
  },
));

// ── Case 3: Tag-name semi-join (tag filter shortcut) ───────────────────────
//
// Query: tasks where tag name = sampleTag
// Optimizer rewrites this to: flattenedTags.whose({name}) → tag IDs →
//   SemiJoin(flattenedTasks.tagIds, tagId set)
// Expected: faster than full bulk read path (~200–350ms vs ~400+ms naive).
// Skipped if no tags exist.

if (sampleTag) {
  results.push(await bench(
    `3. Tag-name semi-join — tasks tagged "${sampleTag.slice(0, 25)}"`,
    async () => {
      // contains(tags, tagName) → tag semi-join shortcut (Intersect + TagNameTaskIds)
      const predicate = containsPred('tags', sampleTag);
      const r = await executeQueryFromAst({
        predicate,
        entity: 'tasks',
        op: 'get',
        select: ['id', 'name', 'flagged'],
      });
      const rows = Array.isArray(r.value) ? r.value : [];
      return `rows=${rows.length}`;
    },
  ));
} else {
  console.log('(Case 3 skipped — no tags found)');
}

// ── Case 4: Task-only predicate (no project-exclusion Difference) ──────────
//
// Query: tasks where inInbox === true
// inInbox is task-only (absent from project var registry) →
//   needsProjectExclusion() returns false → no Difference node in SetIR →
//   single bulk scan, no project scan.
// Expected: ~200–350ms (one JXA round-trip vs ~350ms+ with Difference).

results.push(await bench(
  '4. Task-only predicate — inInbox (skips project-exclusion)',
  async () => {
    // inInbox is task-only → needsProjectExclusion() = false → no Difference node
    const predicate = eqPred('inInbox', true);
    const r = await executeQueryFromAst({
      predicate,
      entity: 'tasks',
      op: 'get',
      select: ['id', 'name', 'inInbox'],
    });
    const rows = Array.isArray(r.value) ? r.value : [];
    return `rows=${rows.length}`;
  },
));

// ── Case 5: Containing FK semi-join (project → flagged tasks) ─────────────
//
// Query: projects that contain at least one flagged task
// containing() path: BulkScan(tasks, flagged) → project IDs via FK join →
//   SemiJoin(projects by projectId).
// Expected: ~400–700ms (two JXA round-trips: task scan + project scan).

results.push(await bench(
  '5. containing() FK semi-join — projects with flagged tasks',
  async () => {
    // containing(tasks, flagged=true) → BulkScan(tasks) + FK join to projects
    const predicate = containingPred('tasks', eqPred('flagged', true));
    const r = await executeQueryFromAst({
      predicate,
      entity: 'projects',
      op: 'get',
      select: ['id', 'name'],
    });
    const rows = Array.isArray(r.value) ? r.value : [];
    return `rows=${rows.length}`;
  },
));

// ── Results ──────────────────────────────────────────────────────────────────

printTable('Optimizer Fast-Path Timings', results);

console.log('\nNotes:');
console.log('  Case 1: native .length fast-path (no bulk read); ref ~200ms without fast-path');
console.log('  Case 2: full pipeline, RowCount node; ref same as case 4 after #75 fixes id prune');
console.log('  Case 3: tag semi-join shortcut; avoids flattenedTasks.tagIds() bulk read');
console.log('  Case 4: task-only predicate skips Difference node (~100ms saved vs shared vars)');
console.log('  Case 5: containing() two-phase FK semi-join; two JXA round-trips expected');
console.log('\nDone.');
