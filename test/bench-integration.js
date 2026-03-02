/**
 * Integration Benchmark: Direct JXA vs OmniJS paths.
 *
 * Runs queries through both the new executeViaDirectJxa path and the
 * OmniJS fallback path, comparing results and timing.
 *
 * Usage: node test/bench-integration.js
 */

import { queryOmnifocus } from '../dist/tools/primitives/queryOmnifocus.js';
import { buildPlanTree } from '../dist/tools/query/planner.js';
import { planPathLabel } from '../dist/tools/query/strategy.js';
import { lowerExpr } from '../dist/tools/query/lower.js';

// ── Test Cases ────────────────────────────────────────────────────────────

const testCases = [
  {
    name: 'All active tasks (no where)',
    params: {
      entity: 'tasks',
      select: ['name', 'flagged'],
      limit: 5,
    },
  },
  {
    name: 'Flagged tasks',
    params: {
      entity: 'tasks',
      where: { eq: [{ var: 'flagged' }, true] },
      select: ['name', 'flagged', 'dueDate'],
    },
  },
  {
    name: 'Name contains "review"',
    params: {
      entity: 'tasks',
      where: { contains: [{ var: 'name' }, 'review'] },
      select: ['name'],
    },
  },
  {
    name: 'Due date not null',
    params: {
      entity: 'tasks',
      where: { neq: [{ var: 'dueDate' }, null] },
      select: ['name', 'dueDate'],
      limit: 10,
    },
  },
  {
    name: 'Flagged AND name contains "review"',
    params: {
      entity: 'tasks',
      where: {
        and: [
          { eq: [{ var: 'flagged' }, true] },
          { contains: [{ var: 'name' }, 'review'] }
        ]
      },
      select: ['name', 'flagged'],
    },
  },
  {
    name: 'Summary mode — count flagged',
    params: {
      entity: 'tasks',
      where: { eq: [{ var: 'flagged' }, true] },
      summary: true,
    },
  },
  {
    name: 'Sort by dueDate asc, limit 5',
    params: {
      entity: 'tasks',
      where: { neq: [{ var: 'dueDate' }, null] },
      select: ['name', 'dueDate'],
      sort: { by: 'dueDate', direction: 'asc' },
      limit: 5,
    },
  },
];

// ── Runner ────────────────────────────────────────────────────────────────

async function runTest(tc) {
  // Check what path the planner chooses
  let path;
  try {
    const ast = tc.params.where != null ? lowerExpr(tc.params.where) : true;
    const tree = buildPlanTree(ast, tc.params.entity, tc.params.select);
    path = planPathLabel(tree);
  } catch {
    path = '?';
  }

  // Run via normal queryOmnifocus (which uses the planner to route)
  const start = Date.now();
  const result = await queryOmnifocus(tc.params);
  const newMs = Date.now() - start;

  // Force OmniJS fallback by querying projects entity (always falls back)
  // Actually, we'll run it with the real function and note the path
  return {
    name: tc.name,
    path,
    newMs,
    count: result.count,
    success: result.success,
    error: result.error,
    sampleItems: result.items?.slice(0, 3),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

console.log('Integration Benchmark: queryOmnifocus()');
console.log('='.repeat(85));
console.log();

// Warmup
console.log('Warming up OmniFocus...');
const warmStart = Date.now();
await queryOmnifocus({ entity: 'tasks', summary: true });
console.log(`  Warmup: ${Date.now() - warmStart}ms`);
console.log();

console.log(`${'Test'.padEnd(45)} ${'Path'.padStart(18)} ${'Time'.padStart(8)} ${'Count'.padStart(8)}`);
console.log('-'.repeat(85));

for (const tc of testCases) {
  const r = await runTest(tc);
  const timeStr = r.success ? `${r.newMs}ms` : 'ERROR';
  const countStr = r.count != null ? String(r.count) : '-';
  console.log(`${r.name.padEnd(45)} ${r.path.padStart(18)} ${timeStr.padStart(8)} ${countStr.padStart(8)}`);
  if (r.error) {
    console.log(`  ERROR: ${r.error}`);
  }
  if (r.sampleItems && r.sampleItems.length > 0) {
    console.log(`  Sample: ${JSON.stringify(r.sampleItems[0])}`);
  }
}

console.log('-'.repeat(85));
console.log();

// Now run the OmniJS fallback versions for comparison
console.log('OmniJS fallback comparison (projects entity forces fallback):');
console.log('-'.repeat(85));

const fallbackTests = [
  {
    name: 'All active projects (OmniJS fallback)',
    params: {
      entity: 'projects',
      select: ['name', 'status'],
      limit: 5,
    },
  },
  {
    name: 'Folders (OmniJS fallback)',
    params: {
      entity: 'folders',
      select: ['name'],
    },
  },
];

for (const tc of fallbackTests) {
  const start = Date.now();
  const result = await queryOmnifocus(tc.params);
  const ms = Date.now() - start;
  const countStr = result.count != null ? String(result.count) : '-';
  console.log(`${tc.name.padEnd(45)} ${'omnijs-fallback'.padStart(18)} ${(ms + 'ms').padStart(8)} ${countStr.padStart(8)}`);
  if (result.error) {
    console.log(`  ERROR: ${result.error}`);
  }
  if (result.items && result.items.length > 0) {
    console.log(`  Sample: ${JSON.stringify(result.items[0])}`);
  }
}

console.log('-'.repeat(85));
