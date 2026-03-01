/**
 * OmniFocus MCP Query Benchmark Suite.
 *
 * Measures performance across all execution paths with queries modeled
 * on real-world usage patterns (derived from 341 logged calls across
 * 15 projects).
 *
 * Usage:
 *   node test/benchmark.js              Run benchmarks, print table
 *   node test/benchmark.js --save       Run + save results as baseline
 *   node test/benchmark.js --compare    Run + compare against saved baseline
 *   node test/benchmark.js --quick      Single iteration (faster, less accurate)
 *   node test/benchmark.js --json       Output raw JSON instead of table
 *
 * Results saved to test/benchmark-baseline.json
 */

import { queryOmnifocus } from '../dist/tools/primitives/queryOmnifocus.js';
import { planFromAst } from '../dist/tools/query/planner.js';
import { lowerExpr } from '../dist/tools/query/lower.js';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(__dirname, 'benchmark-baseline.json');

// ── CLI Args ──────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const SAVE = args.has('--save');
const COMPARE = args.has('--compare');
const QUICK = args.has('--quick');
const JSON_OUT = args.has('--json');
const ITERATIONS = QUICK ? 1 : 3;

// ── Test Cases ────────────────────────────────────────────────────────────
//
// Organized by real-world frequency (most common first).
// Each case is tagged with:
//   category   — what kind of real-world usage it represents
//   expected   — expected execution path (for validation)

const testCases = [
  // ── #1: Project name lookup (by far the most common) ──────────────────
  {
    name: 'Tasks in project (name contains)',
    category: 'project-lookup',
    expected: 'project-scoped',
    params: {
      entity: 'tasks',
      where: { container: ['project', { contains: [{ var: 'name' }, 'bliz'] }] },
      select: ['name', 'flagged', 'dueDate'],
    },
  },
  {
    name: 'Tasks in project (exact name)',
    category: 'project-lookup',
    expected: 'project-scoped',
    params: {
      entity: 'tasks',
      where: { container: ['project', { eq: [{ var: 'name' }, 'One-offs'] }] },
      select: ['name', 'flagged'],
    },
  },

  // ── #2: Active project enumeration ────────────────────────────────────
  {
    name: 'All active projects',
    category: 'project-list',
    expected: 'omnijs-fallback',
    params: {
      entity: 'projects',
      select: ['name', 'status', 'folderName'],
    },
  },
  {
    name: 'Projects with task counts',
    category: 'project-list',
    expected: 'omnijs-fallback',
    params: {
      entity: 'projects',
      select: ['name', 'status', 'taskCount', 'activeTaskCount', 'modificationDate'],
      sort: { by: 'modificationDate', direction: 'desc' },
    },
  },

  // ── #3: Morning briefing / urgency triage ─────────────────────────────
  {
    name: 'Flagged tasks',
    category: 'urgency',
    expected: 'broad',
    params: {
      entity: 'tasks',
      where: { eq: [{ var: 'flagged' }, true] },
      select: ['name', 'projectName', 'dueDate'],
    },
  },
  {
    name: 'Tasks with due dates',
    category: 'urgency',
    expected: 'broad',
    params: {
      entity: 'tasks',
      where: { neq: [{ var: 'dueDate' }, null] },
      select: ['name', 'dueDate', 'projectName'],
      sort: { by: 'dueDate', direction: 'asc' },
    },
  },
  {
    name: 'Due within 7 days',
    category: 'urgency',
    expected: 'broad',
    params: {
      entity: 'tasks',
      where: {
        and: [
          { neq: [{ var: 'dueDate' }, null] },
          { lte: [{ var: 'dueDate' }, { offset: { date: 'now', days: 7 } }] },
        ],
      },
      select: ['name', 'dueDate', 'projectName', 'flagged'],
      sort: { by: 'dueDate', direction: 'asc' },
    },
  },
  {
    name: 'Overdue tasks',
    category: 'urgency',
    expected: 'broad',
    params: {
      entity: 'tasks',
      where: {
        and: [
          { neq: [{ var: 'dueDate' }, null] },
          { lt: [{ var: 'dueDate' }, { var: 'now' }] },
        ],
      },
      select: ['name', 'dueDate', 'projectName'],
    },
  },

  // ── #4: Name search ───────────────────────────────────────────────────
  {
    name: 'Name contains "review"',
    category: 'search',
    expected: 'broad',
    params: {
      entity: 'tasks',
      where: { contains: [{ var: 'name' }, 'review'] },
      select: ['name', 'projectName'],
    },
  },

  // ── #5: Tag-based queries (two-phase) ─────────────────────────────────
  {
    name: 'Tasks with tag (two-phase)',
    category: 'tags',
    expected: 'two-phase',
    params: {
      entity: 'tasks',
      where: { contains: [{ var: 'tags' }, 'waiting'] },
      select: ['name', 'projectName', 'tags'],
    },
  },

  // ── #6: Complex compound queries ──────────────────────────────────────
  {
    name: 'Flagged AND due date exists',
    category: 'compound',
    expected: 'broad',
    params: {
      entity: 'tasks',
      where: {
        and: [
          { eq: [{ var: 'flagged' }, true] },
          { neq: [{ var: 'dueDate' }, null] },
        ],
      },
      select: ['name', 'flagged', 'dueDate'],
    },
  },
  {
    name: 'Flagged OR has due date',
    category: 'compound',
    expected: 'broad',
    params: {
      entity: 'tasks',
      where: {
        or: [
          { eq: [{ var: 'flagged' }, true] },
          { neq: [{ var: 'dueDate' }, null] },
        ],
      },
      select: ['name', 'flagged', 'dueDate'],
      limit: 20,
    },
  },

  // ── #7: Summary / count mode ──────────────────────────────────────────
  {
    name: 'Count all active tasks',
    category: 'summary',
    expected: 'broad',
    params: {
      entity: 'tasks',
      summary: true,
    },
  },
  {
    name: 'Count flagged tasks',
    category: 'summary',
    expected: 'broad',
    params: {
      entity: 'tasks',
      where: { eq: [{ var: 'flagged' }, true] },
      summary: true,
    },
  },

  // ── #8: No filter, just list ──────────────────────────────────────────
  {
    name: 'All active tasks (limit 10)',
    category: 'list',
    expected: 'broad',
    params: {
      entity: 'tasks',
      select: ['name', 'flagged', 'dueDate'],
      limit: 10,
    },
  },

  // ── #9: Folders (always OmniJS fallback) ──────────────────────────────
  {
    name: 'All folders',
    category: 'folders',
    expected: 'omnijs-fallback',
    params: {
      entity: 'folders',
      select: ['name', 'projectCount'],
    },
  },

  // ── #10: Chain vars (projectName in select) ───────────────────────────
  {
    name: 'Tasks with projectName (chain)',
    category: 'chain',
    expected: 'broad',
    params: {
      entity: 'tasks',
      where: { eq: [{ var: 'flagged' }, true] },
      select: ['name', 'projectName', 'dueDate', 'flagged'],
    },
  },

  // ── #11: Date range (between) ─────────────────────────────────────────
  {
    name: 'Due date between now and +14d',
    category: 'date-range',
    expected: 'broad',
    params: {
      entity: 'tasks',
      where: {
        between: [
          { var: 'dueDate' },
          { var: 'now' },
          { offset: { date: 'now', days: 14 } },
        ],
      },
      select: ['name', 'dueDate'],
      sort: { by: 'dueDate', direction: 'asc' },
    },
  },

  // ── #12: Recently modified ────────────────────────────────────────────
  {
    name: 'Modified in last 3 days',
    category: 'recent',
    expected: 'broad',
    params: {
      entity: 'tasks',
      where: {
        gt: [{ var: 'modificationDate' }, { offset: { date: 'now', days: -3 } }],
      },
      select: ['name', 'modificationDate', 'projectName'],
      sort: { by: 'modificationDate', direction: 'desc' },
      limit: 20,
    },
  },

  // ── #13: Tags entity — direct JXA ─────────────────────────────────────
  {
    name: 'All active tags',
    category: 'tags-entity',
    expected: 'broad',
    params: {
      entity: 'tags',
      select: ['name', 'availableTaskCount'],
    },
  },
  {
    name: 'Tags with available tasks',
    category: 'tags-entity',
    expected: 'broad',
    params: {
      entity: 'tags',
      where: { gt: [{ var: 'availableTaskCount' }, 0] },
      select: ['name', 'availableTaskCount'],
    },
  },
  {
    name: 'Tags by name search',
    category: 'tags-entity',
    expected: 'broad',
    params: {
      entity: 'tags',
      where: { contains: [{ var: 'name' }, 'w'] },
      select: ['name', 'availableTaskCount'],
    },
  },
  {
    name: 'Tags with parent (two-phase)',
    category: 'tags-entity',
    expected: 'two-phase',
    params: {
      entity: 'tags',
      select: ['name', 'parentName', 'availableTaskCount'],
    },
  },
  {
    name: 'Count all active tags',
    category: 'tags-entity',
    expected: 'broad',
    params: {
      entity: 'tags',
      summary: true,
    },
  },
];

// ── Runner ────────────────────────────────────────────────────────────────

function getPlannedPath(params) {
  try {
    const ast = params.where != null ? lowerExpr(params.where) : true;
    const plan = planFromAst(ast, params.entity, params.select);
    return plan.path;
  } catch {
    return '?';
  }
}

async function runOnce(params) {
  const start = Date.now();
  const result = await queryOmnifocus(params);
  const ms = Date.now() - start;
  return { ms, count: result.count ?? 0, success: result.success, error: result.error };
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function runBenchmark(tc) {
  const path = getPlannedPath(tc.params);
  const timings = [];
  let lastResult;

  for (let i = 0; i < ITERATIONS; i++) {
    lastResult = await runOnce(tc.params);
    timings.push(lastResult.ms);
  }

  const medianMs = median(timings);
  const pathMatch = tc.expected === path;

  return {
    name: tc.name,
    category: tc.category,
    expectedPath: tc.expected,
    actualPath: path,
    pathMatch,
    medianMs,
    timings,
    count: lastResult.count,
    success: lastResult.success,
    error: lastResult.error,
  };
}

// ── Comparison ────────────────────────────────────────────────────────────

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function formatDelta(current, baseline) {
  if (baseline == null) return '';
  const diff = current - baseline;
  const pct = Math.round((diff / baseline) * 100);
  const sign = diff > 0 ? '+' : '';
  const color = diff > baseline * 0.2 ? '\x1b[31m' : diff < -baseline * 0.1 ? '\x1b[32m' : '';
  const reset = color ? '\x1b[0m' : '';
  return `${color}${sign}${diff}ms (${sign}${pct}%)${reset}`;
}

// ── Output ────────────────────────────────────────────────────────────────

function printTable(results, baseline) {
  const W = { name: 38, cat: 14, path: 18, time: 8, count: 7, delta: 20 };
  const hasDelta = baseline != null;

  const header = [
    'Test'.padEnd(W.name),
    'Category'.padEnd(W.cat),
    'Path'.padStart(W.path),
    'Time'.padStart(W.time),
    'Count'.padStart(W.count),
    ...(hasDelta ? ['vs Baseline'.padStart(W.delta)] : []),
  ].join(' ');

  const divider = '-'.repeat(header.length);
  console.log(header);
  console.log(divider);

  const baselineMap = baseline ? Object.fromEntries(baseline.results.map(r => [r.name, r])) : {};

  for (const r of results) {
    const pathStr = r.pathMatch ? r.actualPath : `${r.actualPath} (!=${r.expectedPath})`;
    const timeStr = r.success ? `${r.medianMs}ms` : 'ERROR';
    const delta = hasDelta ? formatDelta(r.medianMs, baselineMap[r.name]?.medianMs) : '';

    console.log([
      r.name.padEnd(W.name),
      r.category.padEnd(W.cat),
      pathStr.padStart(W.path),
      timeStr.padStart(W.time),
      String(r.count).padStart(W.count),
      ...(hasDelta ? [delta.padStart(W.delta)] : []),
    ].join(' '));

    if (r.error) console.log(`  ERROR: ${r.error}`);
    if (!r.pathMatch) console.log(`  PATH MISMATCH: expected ${r.expectedPath}, got ${r.actualPath}`);
  }

  console.log(divider);

  // Summary stats
  const succeeded = results.filter(r => r.success);
  const broad = succeeded.filter(r => r.actualPath === 'broad');
  const scoped = succeeded.filter(r => r.actualPath === 'project-scoped');
  const twoPhase = succeeded.filter(r => r.actualPath === 'two-phase');
  const fallback = succeeded.filter(r => r.actualPath === 'omnijs-fallback');

  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

  console.log();
  console.log('Summary:');
  if (broad.length) console.log(`  broad:           ${broad.length} tests, avg ${avg(broad.map(r => r.medianMs))}ms`);
  if (scoped.length) console.log(`  project-scoped:  ${scoped.length} tests, avg ${avg(scoped.map(r => r.medianMs))}ms`);
  if (twoPhase.length) console.log(`  two-phase:       ${twoPhase.length} tests, avg ${avg(twoPhase.map(r => r.medianMs))}ms`);
  if (fallback.length) console.log(`  omnijs-fallback: ${fallback.length} tests, avg ${avg(fallback.map(r => r.medianMs))}ms`);

  const mismatches = results.filter(r => !r.pathMatch);
  if (mismatches.length) {
    console.log(`  PATH MISMATCHES: ${mismatches.length}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

// Suppress query logs during benchmarking (they go to stderr)
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  if (typeof chunk === 'string' && chunk.startsWith('[query]')) return true;
  return origStderrWrite(chunk, ...args);
};

console.log('OmniFocus MCP Query Benchmark');
console.log(`Iterations: ${ITERATIONS} (median reported)`);
console.log('='.repeat(90));
console.log();

// Warmup
console.log('Warming up OmniFocus...');
const warmStart = Date.now();
await queryOmnifocus({ entity: 'tasks', summary: true });
const warmMs = Date.now() - warmStart;
console.log(`  Warmup: ${warmMs}ms`);
console.log();

// Run all benchmarks
const results = [];
for (const tc of testCases) {
  process.stdout.write(`  Running: ${tc.name}...`);
  const r = await runBenchmark(tc);
  results.push(r);
  process.stdout.write(` ${r.medianMs}ms\n`);
}
console.log();

// Output
const baseline = COMPARE ? loadBaseline() : null;

if (JSON_OUT) {
  const output = {
    timestamp: new Date().toISOString(),
    iterations: ITERATIONS,
    warmupMs: warmMs,
    results: results.map(r => ({
      name: r.name,
      category: r.category,
      expectedPath: r.expectedPath,
      actualPath: r.actualPath,
      medianMs: r.medianMs,
      timings: r.timings,
      count: r.count,
      success: r.success,
    })),
  };
  console.log(JSON.stringify(output, null, 2));
} else {
  printTable(results, baseline);
}

// Save baseline
if (SAVE) {
  const output = {
    timestamp: new Date().toISOString(),
    iterations: ITERATIONS,
    warmupMs: warmMs,
    results: results.map(r => ({
      name: r.name,
      category: r.category,
      expectedPath: r.expectedPath,
      actualPath: r.actualPath,
      medianMs: r.medianMs,
      timings: r.timings,
      count: r.count,
      success: r.success,
    })),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(output, null, 2));
  console.log();
  console.log(`Baseline saved to ${BASELINE_PATH}`);
}

if (COMPARE && !baseline) {
  console.log();
  console.log('No baseline found. Run with --save first to create one.');
}

// Restore stderr
process.stderr.write = origStderrWrite;
