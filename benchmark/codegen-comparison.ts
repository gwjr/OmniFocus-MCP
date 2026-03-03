#!/usr/bin/env npx tsx
/**
 * Codegen Comparison: Legacy vs EventPlan
 *
 * For each of the 8 benchmark queries, captures the emitted JXA script text
 * from both the legacy pipeline (compileQuery + JxaEmitter) and the new
 * EventPlan pipeline (compileEventPlan + emitJxaUnit), then structurally
 * compares them.
 *
 * Does NOT execute against OmniFocus — purely static analysis of the
 * generated code.
 *
 * Usage:
 *   npx tsx benchmark/codegen-comparison.ts
 */

import { lowerExpr } from '../dist/tools/query/lower.js';
import { buildPlanTree } from '../dist/tools/query/planner.js';
import { compileQuery } from '../dist/tools/query/compile.js';
import { JxaEmitter } from '../dist/tools/query/emitters/jxaEmitter.js';
import { optimize } from '../dist/tools/query/strategy.js';
import { tagSemiJoinPass } from '../dist/tools/query/optimizations/tagSemiJoin.js';
import { crossEntityJoinPass } from '../dist/tools/query/optimizations/crossEntityJoin.js';
import { selfJoinEliminationPass } from '../dist/tools/query/optimizations/selfJoinElimination.js';
import { normalizePass } from '../dist/tools/query/optimizations/normalize.js';
import { compileEventPlan, computeExportedRefs, buildInputMap, fuseSchedule } from '../dist/tools/query/executionUnits/orchestrator.js';
import { emitJxaUnit } from '../dist/tools/query/executionUnits/jxaUnit.js';

// ── Constants ────────────────────────────────────────────────────────────

const PASSES = [tagSemiJoinPass, crossEntityJoinPass, selfJoinEliminationPass, normalizePass];

// ── Queries (same 8 as integration test) ────────────────────────────────

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
  // Add sort for consistency with integration test
  tree = { kind: 'Sort', source: tree, by: 'name', direction: 'asc', entity: q.entity } as any;
  tree = optimize(tree, PASSES);
  return tree;
}

/** Count occurrences of a pattern in a string. */
function countOccurrences(str: string, pattern: string | RegExp): number {
  if (typeof pattern === 'string') {
    let count = 0;
    let pos = 0;
    while ((pos = str.indexOf(pattern, pos)) !== -1) {
      count++;
      pos += pattern.length;
    }
    return count;
  }
  return (str.match(pattern) || []).length;
}

/** Extract AE call patterns from a JXA script. */
function analyzeAeCalls(script: string): {
  bulkReads: number;       // .propName() calls on collections
  whoseCalls: number;      // .whose({...}) calls
  byIdCalls: number;       // .byId(...) calls
  byNameCalls: number;     // .byName(...) calls
  dotPropCalls: number;    // .property() — all materialising calls
} {
  return {
    bulkReads: countOccurrences(script, /\.\w+\(\)/g),
    whoseCalls: countOccurrences(script, /\.whose\(/g),
    byIdCalls: countOccurrences(script, /\.byId\(/g),
    byNameCalls: countOccurrences(script, /\.byName\(/g),
    dotPropCalls: countOccurrences(script, /\.\w+\(\)/g),
  };
}

/** Count AE round-trips: each standalone/composite is 1 osascript call. */
function countRoundTrips(scripts: string[]): number {
  return scripts.filter(s => s.length > 0).length;
}

// ── Legacy pipeline ──────────────────────────────────────────────────────

function getLegacyScripts(q: QuerySpec): string[] {
  const tree = buildOptimizedTree(q);
  const compiled = compileQuery(tree, new JxaEmitter());
  const scripts: string[] = [];
  if (compiled.batchScript) scripts.push(compiled.batchScript);
  if (compiled.standaloneScript) scripts.push(compiled.standaloneScript);
  return scripts;
}

// ── EventPlan pipeline ──────────────────────────────────────────────────

interface EventPlanOutput {
  scripts: string[];
  unitSummary: string[];
  /** Actual osascript round-trips after fuseSchedule reordering. */
  fusedRoundTrips: number;
}

function getEventPlanScripts(q: QuerySpec): EventPlanOutput {
  const tree = buildOptimizedTree(q);
  const { targeted, units: rawUnits } = compileEventPlan(tree);
  // Apply the same fuseSchedule reordering the executor uses
  const units = fuseSchedule(rawUnits);

  const scripts: string[] = [];
  const unitSummary: string[] = [];

  // Simulate orchestrator script generation without execution
  // For JXA units, generate the script text
  // For Node units, describe what they do
  for (const unit of units) {
    if (unit.runtime === 'jxa') {
      const exports = computeExportedRefs(unit, units);
      // Build a dummy input map with placeholder expressions
      const inputs = new Map<number, string>();
      for (const ref of unit.inputs) {
        inputs.set(ref, `__input_${ref}__`);
      }
      const script = emitJxaUnit(unit, targeted, inputs, exports);
      scripts.push(script);
      unitSummary.push(`JXA unit: refs [${unit.nodes.join(',')}], exports [${exports.join(',')}]`);
    } else if (unit.runtime === 'node') {
      // Describe the node-side unit
      const nodeKinds = unit.nodes.map(ref => targeted.nodes[ref].kind);
      unitSummary.push(`Node unit: refs [${unit.nodes.join(',')}], ops: [${nodeKinds.join(',')}]`);
    } else {
      unitSummary.push(`${unit.runtime} unit: refs [${unit.nodes.join(',')}]`);
    }
  }

  // Count fused round-trips: consecutive JXA units (in fused schedule order)
  // are batched into one osascript call by the executor.
  let fusedRoundTrips = 0;
  let prevRuntime: string | null = null;
  for (const unit of units) {
    if (unit.runtime === 'jxa' || unit.runtime === 'omniJS') {
      if (prevRuntime !== 'jxa' && prevRuntime !== 'omniJS') {
        fusedRoundTrips++;
      }
    }
    prevRuntime = unit.runtime;
  }

  return { scripts, unitSummary, fusedRoundTrips };
}

// ── Main comparison ──────────────────────────────────────────────────────

interface ComparisonResult {
  label: string;
  entity: string;
  legacy: {
    scriptCount: number;
    totalBytes: number;
    totalLines: number;
    roundTrips: number;
    ae: ReturnType<typeof analyzeAeCalls>;
  };
  eventPlan: {
    jxaScriptCount: number;
    nodeUnitCount: number;
    totalJxaBytes: number;
    totalJxaLines: number;
    roundTrips: number;
    ae: ReturnType<typeof analyzeAeCalls>;
    unitSummary: string[];
  };
}

function compare(): ComparisonResult[] {
  const results: ComparisonResult[] = [];

  for (const q of queries) {
    const legacyScripts = getLegacyScripts(q);
    const { scripts: epScripts, unitSummary, fusedRoundTrips } = getEventPlanScripts(q);

    const legacyText = legacyScripts.join('\n');
    const epText = epScripts.join('\n');

    results.push({
      label: q.label,
      entity: q.entity,
      legacy: {
        scriptCount: legacyScripts.length,
        totalBytes: legacyText.length,
        totalLines: legacyText.split('\n').length,
        roundTrips: countRoundTrips(legacyScripts),
        ae: analyzeAeCalls(legacyText),
      },
      eventPlan: {
        jxaScriptCount: epScripts.length,
        nodeUnitCount: unitSummary.filter(s => s.startsWith('Node')).length,
        totalJxaBytes: epText.length,
        totalJxaLines: epText.split('\n').length,
        roundTrips: fusedRoundTrips,
        ae: analyzeAeCalls(epText),
        unitSummary,
      },
    });
  }

  return results;
}

// ── Output ──────────────────────────────────────────────────────────────

function formatComparison(results: ComparisonResult[]): string {
  const lines: string[] = [];

  lines.push('# Codegen Comparison: Legacy vs EventPlan');
  lines.push('');
  lines.push('Static analysis of emitted JXA scripts for 8 benchmark queries.');
  lines.push('No execution against OmniFocus — purely structural comparison.');
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Query | Entity | Legacy RT | EP RT | Legacy bytes | EP bytes | Delta | Legacy AE | EP AE |');
  lines.push('|-------|--------|-----------|-------|-------------|----------|-------|-----------|-------|');

  for (const r of results) {
    const bytesDelta = r.eventPlan.totalJxaBytes - r.legacy.totalBytes;
    const deltaPct = r.legacy.totalBytes > 0
      ? `${bytesDelta >= 0 ? '+' : ''}${((bytesDelta / r.legacy.totalBytes) * 100).toFixed(0)}%`
      : 'N/A';
    const legacyAE = r.legacy.ae.bulkReads;
    const epAE = r.eventPlan.ae.bulkReads;

    lines.push(
      `| ${r.label} | ${r.entity} | ${r.legacy.roundTrips} | ${r.eventPlan.roundTrips} | ${r.legacy.totalBytes} | ${r.eventPlan.totalJxaBytes} | ${deltaPct} | ${legacyAE} | ${epAE} |`
    );
  }

  // Totals
  const totalLegacyBytes = results.reduce((s, r) => s + r.legacy.totalBytes, 0);
  const totalEpBytes = results.reduce((s, r) => s + r.eventPlan.totalJxaBytes, 0);
  const totalLegacyRT = results.reduce((s, r) => s + r.legacy.roundTrips, 0);
  const totalEpRT = results.reduce((s, r) => s + r.eventPlan.roundTrips, 0);
  const totalDelta = totalEpBytes - totalLegacyBytes;
  const totalDeltaPct = `${totalDelta >= 0 ? '+' : ''}${((totalDelta / totalLegacyBytes) * 100).toFixed(0)}%`;

  lines.push(
    `| **Total** | | **${totalLegacyRT}** | **${totalEpRT}** | **${totalLegacyBytes}** | **${totalEpBytes}** | **${totalDeltaPct}** | | |`
  );
  lines.push('');

  // Per-query detail
  lines.push('## Per-Query Detail');
  lines.push('');

  for (const r of results) {
    lines.push(`### ${r.label} [${r.entity}]`);
    lines.push('');
    lines.push('**Legacy:**');
    lines.push(`- Scripts: ${r.legacy.scriptCount}, Round-trips: ${r.legacy.roundTrips}`);
    lines.push(`- Size: ${r.legacy.totalBytes} bytes, ${r.legacy.totalLines} lines`);
    lines.push(`- AE calls: bulk reads ${r.legacy.ae.bulkReads}, .whose() ${r.legacy.ae.whoseCalls}, .byId() ${r.legacy.ae.byIdCalls}`);
    lines.push('');
    lines.push('**EventPlan:**');
    lines.push(`- JXA scripts: ${r.eventPlan.jxaScriptCount}, Node units: ${r.eventPlan.nodeUnitCount}, Round-trips: ${r.eventPlan.roundTrips}`);
    lines.push(`- JXA size: ${r.eventPlan.totalJxaBytes} bytes, ${r.eventPlan.totalJxaLines} lines`);
    lines.push(`- AE calls: bulk reads ${r.eventPlan.ae.bulkReads}, .whose() ${r.eventPlan.ae.whoseCalls}, .byId() ${r.eventPlan.ae.byIdCalls}`);
    lines.push(`- Units: ${r.eventPlan.unitSummary.join('; ')}`);
    lines.push('');
  }

  // Regression analysis
  lines.push('## Regression Analysis');
  lines.push('');

  const regressions: string[] = [];
  const improvements: string[] = [];

  for (const r of results) {
    // More round-trips is a regression
    if (r.eventPlan.roundTrips > r.legacy.roundTrips) {
      regressions.push(
        `- **${r.label}**: ${r.eventPlan.roundTrips} round-trips vs legacy ${r.legacy.roundTrips} (+${r.eventPlan.roundTrips - r.legacy.roundTrips} extra osascript calls)`
      );
    }
    // More AE bulk reads (could indicate missing fusion)
    if (r.eventPlan.ae.bulkReads > r.legacy.ae.bulkReads * 1.5) {
      regressions.push(
        `- **${r.label}**: ${r.eventPlan.ae.bulkReads} bulk AE calls vs legacy ${r.legacy.ae.bulkReads} (${(r.eventPlan.ae.bulkReads / r.legacy.ae.bulkReads).toFixed(1)}x)`
      );
    }
    // Fewer round-trips is an improvement
    if (r.eventPlan.roundTrips < r.legacy.roundTrips) {
      improvements.push(
        `- **${r.label}**: ${r.eventPlan.roundTrips} round-trips vs legacy ${r.legacy.roundTrips} (saved ${r.legacy.roundTrips - r.eventPlan.roundTrips} osascript calls)`
      );
    }
  }

  if (regressions.length === 0) {
    lines.push('No regressions detected.');
  } else {
    lines.push('### Regressions');
    lines.push('');
    lines.push(...regressions);
  }
  lines.push('');

  if (improvements.length > 0) {
    lines.push('### Improvements');
    lines.push('');
    lines.push(...improvements);
    lines.push('');
  }

  lines.push(`_Generated ${new Date().toISOString()}_`);

  return lines.join('\n');
}

// ── Script dump (for manual inspection) ──────────────────────────────────

function dumpScripts(results: ComparisonResult[]): string {
  const lines: string[] = [];

  for (const q of queries) {
    const legacyScripts = getLegacyScripts(q);
    const { scripts: epScripts } = getEventPlanScripts(q);

    lines.push(`${'='.repeat(72)}`);
    lines.push(`QUERY: ${q.label} [${q.entity}]`);
    lines.push(`${'='.repeat(72)}`);
    lines.push('');

    lines.push('--- LEGACY JXA ---');
    for (let i = 0; i < legacyScripts.length; i++) {
      lines.push(`[script ${i + 1}/${legacyScripts.length}]`);
      lines.push(legacyScripts[i]);
      lines.push('');
    }

    lines.push('--- EVENTPLAN JXA ---');
    for (let i = 0; i < epScripts.length; i++) {
      lines.push(`[script ${i + 1}/${epScripts.length}]`);
      lines.push(epScripts[i]);
      lines.push('');
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const results = compare();
  const report = formatComparison(results);

  // Print summary report to stdout
  console.log(report);

  // If --dump flag, also print full scripts
  if (process.argv.includes('--dump')) {
    console.log('\n\n');
    console.log(dumpScripts(results));
  }
}

main();
