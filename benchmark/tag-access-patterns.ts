#!/usr/bin/env npx tsx
/**
 * Tag access pattern audit
 *
 * Tests various ways to get tags from tasks:
 * 1. AS: {id, name} of tags of a single task (user reports fast)
 * 2. AS: tags of every flattened task (bulk — does it work?)
 * 3. JXA: single task .tags()
 * 4. Scaling: how does per-task tag read scale with N tasks?
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

function runAS(script: string): { ms: number; stdout: string } {
  const f = join(tmpdir(), `bench_as_${Date.now()}_${_seq++}.applescript`);
  writeFileSync(f, script);
  const t0 = performance.now();
  let stdout: string;
  try {
    stdout = execSync(`osascript "${f}"`, { timeout: 60000 }).toString();
  } finally {
    try { unlinkSync(f); } catch {}
  }
  return { ms: performance.now() - t0, stdout };
}

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

console.log('# Tag Access Pattern Audit\n');

// ── Part 1: What patterns work? ─────────────────────────────────────

console.log('## Part 1: Which patterns work?\n');

// Single task - AS reference pattern
const r1 = runAS(`tell application "OmniFocus"
  tell default document
    set testItem to some flattened task where primary tag is not missing value
    set testRef to a reference to {id, name} of tags of testItem
    return testRef as text
  end tell
end tell`);
console.log(`  AS: {id, name} of tags of (single task)    ${Math.round(r1.ms)}ms`);
console.log(`    result: ${r1.stdout.trim().slice(0, 120)}`);

// Single task - just names
const r1b = runAS(`tell application "OmniFocus"
  tell default document
    set testItem to some flattened task where primary tag is not missing value
    return name of tags of testItem
  end tell
end tell`);
console.log(`  AS: name of tags of (single task)          ${Math.round(r1b.ms)}ms`);
console.log(`    result: ${r1b.stdout.trim().slice(0, 120)}`);

// Bulk - try name of tags of every flattened task
console.log('\n  Trying bulk patterns...');

const r2 = runAS(`tell application "OmniFocus"
  tell default document
    try
      set tagNames to name of tags of every flattened task
      return (count of tagNames) as text
    on error errMsg
      return "ERROR: " & errMsg
    end try
  end tell
end tell`);
console.log(`  AS: name of tags of every flattened task   ${Math.round(r2.ms)}ms`);
console.log(`    result: ${r2.stdout.trim().slice(0, 200)}`);

// JXA bulk - flattenedTasks.tags()
const r3 = runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  try {
    var tags = doc.flattenedTasks.tags();
    return JSON.stringify({count: tags.length, sample: tags.slice(0, 3).map(function(t) {
      return t ? (Array.isArray(t) ? t.length + ' tags' : typeof t) : 'null';
    })});
  } catch(e) {
    return JSON.stringify({error: e.message || String(e)});
  }
})()`);
console.log(`  JXA: flattenedTasks.tags()                ${Math.round(r3.ms)}ms`);
console.log(`    result: ${r3.stdout.trim().slice(0, 200)}`);

// JXA: flattenedTasks.tags.name()  (chain through)
const r4 = runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  try {
    var names = doc.flattenedTasks.tags.name();
    return JSON.stringify({count: names.length, sample: names.slice(0, 5)});
  } catch(e) {
    return JSON.stringify({error: e.message || String(e)});
  }
})()`);
console.log(`  JXA: flattenedTasks.tags.name() (chain)   ${Math.round(r4.ms)}ms`);
console.log(`    result: ${r4.stdout.trim().slice(0, 200)}`);

// ── Part 2: Per-task tag reads, scaling ─────────────────────────────

console.log('\n## Part 2: Per-Task Tag Read Scaling\n');

// Get IDs of tasks that have tags
const idsWithTags = runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var ids = doc.flattenedTasks.id();
  var tags = doc.flattenedTasks.tags();
  var result = [];
  for (var i = 0; i < ids.length && result.length < 100; i++) {
    if (tags[i] && tags[i].length > 0) {
      result.push(ids[i].toString());
    }
  }
  return JSON.stringify({total: ids.length, withTags: result.length, ids: result});
})()`);
const tagData = JSON.parse(idsWithTags.stdout.trim());
console.log(`  ${tagData.total} tasks total, found ${tagData.withTags} with tags\n`);
const taggedIds: string[] = tagData.ids;

const N = 7;
const TRIM = 1;

for (const count of [1, 5, 10, 50]) {
  if (count > taggedIds.length) break;
  const ids = taggedIds.slice(0, count);

  // AS: loop over tasks by ID, get tag names
  const asScript = `tell application "OmniFocus"
  tell default document
    set theIds to {${ids.map(id => `"${id}"`).join(', ')}}
    set output to {}
    repeat with anId in theIds
      set t to first flattened task whose id is anId
      set tagNames to name of tags of t
      set end of output to {anId as text, tagNames}
    end repeat
    return count of output
  end tell
end tell`;

  // OmniJS: byIdentifier, get tag names
  const omniScript = `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var result = app.evaluateJavascript(${JSON.stringify(`(function() {
    var ids = ${JSON.stringify(ids)};
    var results = [];
    for (var i = 0; i < ids.length; i++) {
      var t = Task.byIdentifier(ids[i]);
      if (t) {
        var tagNames = [];
        t.tags.forEach(function(tag) { tagNames.push(tag.name); });
        results.push([ids[i], tagNames]);
      }
    }
    return JSON.stringify(results);
  })()`)});
  return result;
})()`;

  const asRuns: number[] = [];
  const omniRuns: number[] = [];

  process.stdout.write(`  ${count} tasks: `);
  for (let i = 0; i < N; i++) {
    // Randomize order
    if (Math.random() > 0.5) {
      asRuns.push(Math.round(runAS(asScript).ms));
      omniRuns.push(Math.round(runJXA(omniScript).ms));
    } else {
      omniRuns.push(Math.round(runJXA(omniScript).ms));
      asRuns.push(Math.round(runAS(asScript).ms));
    }
    process.stdout.write('.');
  }
  console.log();

  console.log(`    AS (.whose + name of tags):  [${formatRuns(asRuns, TRIM)}]  trimmed=${trimmedMedian(asRuns, TRIM)}ms`);
  console.log(`    OmniJS (byId + tag.name):    [${formatRuns(omniRuns, TRIM)}]  trimmed=${trimmedMedian(omniRuns, TRIM)}ms`);
}
