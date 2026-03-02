#!/usr/bin/env npx tsx
/**
 * JSON serialisation: OmniJS-side vs JXA-side
 *
 * When returning data from OmniJS via evaluateJavascript(), we can either:
 *   (a) JSON.stringify inside OmniJS, return a string, JXA passes it through
 *   (b) Return a raw JS array/object, let JXA receive it and JSON.stringify
 *
 * First: discover what evaluateJavascript() actually returns for non-string
 * values. Then benchmark the two paths at various data sizes.
 *
 * 9 runs each, alternating. Trimmed stats: drop top/bottom 2, median of middle 5.
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let _seq = 0;

function runJXA(script: string): { ms: number; stdout: string } {
  const f = join(tmpdir(), `bench_jxa_${Date.now()}_${_seq++}.js`);
  writeFileSync(f, script);
  const t0 = performance.now();
  let stdout: string;
  try {
    stdout = execSync(`osascript -l JavaScript "${f}"`, { timeout: 60000 }).toString();
  } finally {
    try { unlinkSync(f); } catch {}
  }
  return { ms: performance.now() - t0, stdout };
}

/** Drop top/bottom `trim` values, return median of remainder */
function trimmedMedian(arr: number[], trim = 2): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const trimmed = sorted.slice(trim, sorted.length - trim);
  return trimmed[Math.floor(trimmed.length / 2)];
}

function formatRuns(arr: number[], trim = 2): string {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted.map((v, i) =>
    (i < trim || i >= sorted.length - trim) ? `(${v}ms)` : `${v}ms`
  ).join(', ');
}

// ═══════════════════════════════════════════════════════════════════
// PART 1: What does evaluateJavascript() return for different types?
// ═══════════════════════════════════════════════════════════════════

console.log('# JSON Bridge: OmniJS vs JXA Serialisation\n');
console.log('## Part 1: What does evaluateJavascript() return?\n');

const typeTests = [
  ['string literal', `"hello"`],
  ['number', `42`],
  ['boolean', `true`],
  ['null', `null`],
  ['array of numbers', `[1, 2, 3]`],
  ['array of strings', `["a", "b", "c"]`],
  ['array of objects', `[{name: "foo", val: 1}, {name: "bar", val: 2}]`],
  ['nested array', `[[1, "a", true], [2, "b", false]]`],
  ['JSON.stringify(array)', `JSON.stringify([1, 2, 3])`],
  ['JSON.stringify(objects)', `JSON.stringify([{name: "foo"}, {name: "bar"}])`],
];

for (const [label, omniExpr] of typeTests) {
  const result = runJXA(`(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var result = app.evaluateJavascript('(function(){ return ${omniExpr.replace(/'/g, "\\'")}; })()');
  return JSON.stringify({
    type: typeof result,
    isArray: Array.isArray(result),
    value: result,
    length: typeof result === 'string' ? result.length : (Array.isArray(result) ? result.length : null)
  });
})()`);
  const parsed = JSON.parse(result.stdout.trim());
  console.log(`  ${label.padEnd(30)} → type=${parsed.type}, isArray=${parsed.isArray}, length=${parsed.length}`);
  const valStr = JSON.stringify(parsed.value);
  console.log(`  ${''.padEnd(30)}   value=${valStr.length > 80 ? valStr.slice(0, 77) + '...' : valStr}`);
}

// ═══════════════════════════════════════════════════════════════════
// PART 2: Benchmark with real OmniFocus data
// ═══════════════════════════════════════════════════════════════════

console.log('\n## Part 2: Serialisation Benchmark with Real Data\n');
console.log('9 runs each, drop top/bottom 2, trimmed median of middle 5.\n');

const N = 9;
const TRIM = 2;

// Test at different result sizes using byIdentifier
const counts = [10, 50, 100];

// First get real task IDs
console.log('Fetching task IDs...');
const idResult = runJXA(`(function() {
  var app = Application('OmniFocus');
  var ids = app.defaultDocument.flattenedTasks.id();
  return JSON.stringify(ids.slice(0, 100).map(function(v) { return v.toString(); }));
})()`);
const taskIds: string[] = JSON.parse(idResult.stdout.trim());
console.log(`Got ${taskIds.length} IDs\n`);

interface Strategy { key: string; label: string; script: string }

for (const count of counts) {
  const ids = taskIds.slice(0, count);

  const strategies: Strategy[] = [
    {
      key: 'A',
      label: 'A: OmniJS JSON.stringify (objects)',
      script: `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var omniCode = ${JSON.stringify(`(function() {
    var ids = ${JSON.stringify(ids)};
    var results = [];
    for (var i = 0; i < ids.length; i++) {
      var t = Task.byIdentifier(ids[i]);
      if (t) {
        results.push({
          name: t.name,
          id: t.id.primaryKey,
          flagged: t.flagged,
          dueDate: t.dueDate ? t.dueDate.toISOString() : null,
          deferDate: t.deferDate ? t.deferDate.toISOString() : null
        });
      }
    }
    return JSON.stringify(results);
  })()`)};
  var result = app.evaluateJavascript(omniCode);
  return result;
})()`
    },
    {
      key: 'B',
      label: 'B: OmniJS raw → JXA JSON.stringify',
      script: `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var omniCode = ${JSON.stringify(`(function() {
    var ids = ${JSON.stringify(ids)};
    var results = [];
    for (var i = 0; i < ids.length; i++) {
      var t = Task.byIdentifier(ids[i]);
      if (t) {
        results.push([
          t.name,
          t.id.primaryKey,
          t.flagged,
          t.dueDate ? t.dueDate.toISOString() : null,
          t.deferDate ? t.deferDate.toISOString() : null
        ]);
      }
    }
    return results;
  })()`)};
  var result = app.evaluateJavascript(omniCode);
  return JSON.stringify(result);
})()`
    },
    {
      key: 'C',
      label: 'C: OmniJS JSON.stringify (arrays) ',
      script: `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var omniCode = ${JSON.stringify(`(function() {
    var ids = ${JSON.stringify(ids)};
    var results = [];
    for (var i = 0; i < ids.length; i++) {
      var t = Task.byIdentifier(ids[i]);
      if (t) {
        results.push([
          t.name,
          t.id.primaryKey,
          t.flagged,
          t.dueDate ? t.dueDate.toISOString() : null,
          t.deferDate ? t.deferDate.toISOString() : null
        ]);
      }
    }
    return JSON.stringify(results);
  })()`)};
  var result = app.evaluateJavascript(omniCode);
  return result;
})()`
    },
  ];

  const runs: Record<string, number[]> = { A: [], B: [], C: [] };
  // Track execution order for temporal analysis
  const timeline: { iter: number; key: string; ms: number }[] = [];

  process.stdout.write(`${count} items: `);
  for (let i = 0; i < N; i++) {
    // Shuffle strategy order each iteration to control for position effects
    const order = [...strategies].sort(() => Math.random() - 0.5);
    for (const s of order) {
      const ms = Math.round(runJXA(s.script).ms);
      runs[s.key].push(ms);
      timeline.push({ iter: i, key: s.key, ms });
    }
    process.stdout.write('.');
  }
  console.log();

  // Show execution-order timeline
  console.log(`  Timeline (execution order):`);
  for (let i = 0; i < N; i++) {
    const iterRuns = timeline.filter(t => t.iter === i);
    const parts = iterRuns.map(t => `${t.key}:${t.ms}ms`).join('  ');
    console.log(`    iter ${i}: ${parts}`);
  }

  // Show trimmed stats
  for (const s of strategies) {
    const r = runs[s.key];
    console.log(`  ${s.label}  [${formatRuns(r, TRIM)}]  trimmed=${trimmedMedian(r, TRIM)}ms`);
  }
  console.log();
}

console.log('Path A: OmniJS builds [{name,id,flagged,...}], JSON.stringify in OmniJS, string returned to JXA');
console.log('Path B: OmniJS builds [[name,id,flagged,...]], returns raw array, JXA does JSON.stringify');
console.log('Path C: OmniJS builds [[name,id,flagged,...]], JSON.stringify in OmniJS, string returned to JXA');
console.log('\nStrategy order randomized each iteration. Runs in (parens) were trimmed as outliers.');
