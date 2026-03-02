#!/usr/bin/env npx tsx
/**
 * OmniJS byIdentifier() vs JXA bulk-read pipeline
 *
 * Tests: given N task IDs, is it faster to:
 *   (a) OmniJS: Task.byIdentifier(id) × N, read properties from each
 *   (b) JXA: bulk-read all 2137 tasks' properties in one go, filter in Node
 *
 * Does NOT test OmniJS full scans (known to be slow).
 * 5 runs each, alternating.
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

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const N = 5;

console.log('# OmniJS byIdentifier() vs JXA Bulk Read');
console.log(`# ${N} runs each, alternating\n`);

// ── Get real task IDs ───────────────────────────────────────────────

console.log('Fetching task IDs...');
const idResult = runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var ids = doc.flattenedTasks.id();
  return JSON.stringify(ids.map(function(v) { return v.toString(); }));
})()`);
const allIds: string[] = JSON.parse(idResult.stdout.trim());
console.log(`Got ${allIds.length} task IDs\n`);

// Shuffle and pick subsets
const shuffled = [...allIds].sort(() => Math.random() - 0.5);

// Properties to read in both paths
const propsToRead = ['name', 'id', 'flagged', 'dueDate', 'deferDate'];

// ── OmniJS byIdentifier path ───────────────────────────────────────

function omniJSScript(ids: string[]): string {
  // OmniJS script that runs inside OmniFocus via evaluateJavascript
  const omniScript = `
(function() {
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
})()`;

  // JXA wrapper that calls evaluateJavascript
  return `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var result = app.evaluateJavascript(${JSON.stringify(omniScript)});
  return result;
})()`;
}

// ── JXA bulk-read path ──────────────────────────────────────────────

function jxaBulkScript(ids: string[]): string {
  return `(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedTasks;
  var names = items.name();
  var allIds = items.id();
  var flagged = items.flagged();
  var dueDates = items.dueDate();
  var deferDates = items.deferDate();

  var wantIds = ${JSON.stringify(ids)};
  var wantSet = {};
  for (var i = 0; i < wantIds.length; i++) wantSet[wantIds[i]] = true;

  var results = [];
  for (var i = 0; i < allIds.length; i++) {
    if (wantSet[allIds[i]]) {
      results.push({
        name: names[i],
        id: allIds[i],
        flagged: flagged[i],
        dueDate: dueDates[i] ? dueDates[i].toISOString() : null,
        deferDate: deferDates[i] ? deferDates[i].toISOString() : null
      });
    }
  }
  return JSON.stringify({count: results.length});
})()`;
}

// ── Run benchmarks ──────────────────────────────────────────────────

const counts = [1, 5, 10, 50, 100, 500];

interface Result {
  count: number;
  omniJS: number[];
  jxaBulk: number[];
}

const results: Result[] = [];

for (const count of counts) {
  const ids = shuffled.slice(0, count);
  const omniScript = omniJSScript(ids);
  const bulkScript = jxaBulkScript(ids);

  const omniJS: number[] = [];
  const jxaBulk: number[] = [];

  process.stdout.write(`${count} IDs: `);
  for (let i = 0; i < N; i++) {
    const o = runJXA(omniScript);
    omniJS.push(Math.round(o.ms));

    const b = runJXA(bulkScript);
    jxaBulk.push(Math.round(b.ms));

    process.stdout.write('.');
  }
  console.log();

  results.push({ count, omniJS, jxaBulk });
}

// ── Results ─────────────────────────────────────────────────────────

console.log('\n## Raw Runs\n');
for (const r of results) {
  console.log(`### ${r.count} IDs`);
  console.log(`  OmniJS byId: [${r.omniJS.map(v => v + 'ms').join(', ')}]  median=${median(r.omniJS)}ms`);
  console.log(`  JXA bulk:    [${r.jxaBulk.map(v => v + 'ms').join(', ')}]  median=${median(r.jxaBulk)}ms`);
}

console.log('\n## Summary\n');
console.log(`${'IDs'.padStart(5)}  ${'OmniJS'.padStart(9)}  ${'JXA bulk'.padStart(9)}  ${'Winner'.padStart(12)}  Per-ID (OmniJS)`);
console.log('-'.repeat(60));
for (const r of results) {
  const om = median(r.omniJS);
  const jm = median(r.jxaBulk);
  const winner = om < jm ? 'OmniJS' : 'JXA bulk';
  const ratio = (Math.max(om, jm) / Math.min(om, jm)).toFixed(1);
  const perId = (om / r.count).toFixed(1);
  console.log(
    `${String(r.count).padStart(5)}  ${(om + 'ms').padStart(9)}  ${(jm + 'ms').padStart(9)}  ` +
    `${winner} ${ratio}×`.padStart(12) + `  ${perId}ms`
  );
}

console.log('\nOmniJS reads 5 properties per item via byIdentifier().');
console.log('JXA bulk reads 5 property arrays from all tasks, filters in-script.');
