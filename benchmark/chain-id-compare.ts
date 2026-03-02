#!/usr/bin/env npx tsx
/**
 * Head-to-head: containingProject.id() in JXA vs AppleScript
 *
 * Tests whether the 531ms JXA measurement is a bridge artefact
 * vs Script Debugger's 35-89ms for the same operation in AS.
 *
 * 5 runs each, alternating to control for caching effects.
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let _seq = 0;

function runJXA(script: string): number {
  const f = join(tmpdir(), `bench_jxa_${Date.now()}_${_seq++}.js`);
  writeFileSync(f, script);
  const t0 = performance.now();
  try {
    execSync(`osascript -l JavaScript "${f}"`, { timeout: 60000 });
  } finally {
    try { unlinkSync(f); } catch {}
  }
  return Math.round(performance.now() - t0);
}

function runAS(script: string): number {
  const f = join(tmpdir(), `bench_as_${Date.now()}_${_seq++}.applescript`);
  writeFileSync(f, script);
  const t0 = performance.now();
  try {
    execSync(`osascript "${f}"`, { timeout: 60000 });
  } finally {
    try { unlinkSync(f); } catch {}
  }
  return Math.round(performance.now() - t0);
}

const N = 5;

console.log('# Chain Property Head-to-Head: JXA vs AppleScript');
console.log(`# ${N} runs each, alternating\n`);

// ── containingProject.id() ──────────────────────────────────────────

const jxaId: number[] = [];
const asId: number[] = [];

console.log('## containingProject.id() / id of containing project');
for (let i = 0; i < N; i++) {
  jxaId.push(runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var arr = doc.flattenedTasks.containingProject.id();
  return JSON.stringify({count: arr.length});
})()`));

  asId.push(runAS(`tell application "OmniFocus"
  tell default document
    set theIds to id of containing project of every flattened task
    return (count of theIds) as text
  end tell
end tell`));
}

console.log(`JXA: [${jxaId.map(v => v + 'ms').join(', ')}]  median=${median(jxaId)}ms`);
console.log(`AS:  [${asId.map(v => v + 'ms').join(', ')}]  median=${median(asId)}ms`);

// ── containingProject.name() ────────────────────────────────────────

const jxaName: number[] = [];
const asName: number[] = [];

console.log('\n## containingProject.name() / name of containing project');
for (let i = 0; i < N; i++) {
  jxaName.push(runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var arr = doc.flattenedTasks.containingProject.name();
  return JSON.stringify({count: arr.length});
})()`));

  asName.push(runAS(`tell application "OmniFocus"
  tell default document
    set theNames to name of containing project of every flattened task
    return (count of theNames) as text
  end tell
end tell`));
}

console.log(`JXA: [${jxaName.map(v => v + 'ms').join(', ')}]  median=${median(jxaName)}ms`);
console.log(`AS:  [${asName.map(v => v + 'ms').join(', ')}]  median=${median(asName)}ms`);

// ── containingProject() raw refs ────────────────────────────────────

const jxaRef: number[] = [];
const asRef: number[] = [];

console.log('\n## containingProject() / containing project (raw refs)');
for (let i = 0; i < N; i++) {
  jxaRef.push(runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var arr = doc.flattenedTasks.containingProject();
  return JSON.stringify({count: arr.length});
})()`));

  asRef.push(runAS(`tell application "OmniFocus"
  tell default document
    set theRefs to containing project of every flattened task
    return (count of theRefs) as text
  end tell
end tell`));
}

console.log(`JXA: [${jxaRef.map(v => v + 'ms').join(', ')}]  median=${median(jxaRef)}ms`);
console.log(`AS:  [${asRef.map(v => v + 'ms').join(', ')}]  median=${median(asRef)}ms`);

// ── For comparison: direct id (no chain) ────────────────────────────

const jxaDirect: number[] = [];
const asDirect: number[] = [];

console.log('\n## flattenedTasks.id() / id of every flattened task (no chain, baseline)');
for (let i = 0; i < N; i++) {
  jxaDirect.push(runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var arr = doc.flattenedTasks.id();
  return JSON.stringify({count: arr.length});
})()`));

  asDirect.push(runAS(`tell application "OmniFocus"
  tell default document
    set theIds to id of every flattened task
    return (count of theIds) as text
  end tell
end tell`));
}

console.log(`JXA: [${jxaDirect.map(v => v + 'ms').join(', ')}]  median=${median(jxaDirect)}ms`);
console.log(`AS:  [${asDirect.map(v => v + 'ms').join(', ')}]  median=${median(asDirect)}ms`);

// ── Summary ─────────────────────────────────────────────────────────

console.log('\n## Summary');
console.log(`${'Operation'.padEnd(45)} ${'JXA'.padStart(7)} ${'AS'.padStart(7)}  Delta`);
console.log('-'.repeat(75));
for (const [label, jxa, as] of [
  ['containingProject.id()', jxaId, asId],
  ['containingProject.name()', jxaName, asName],
  ['containingProject() (raw refs)', jxaRef, asRef],
  ['flattenedTasks.id() (baseline)', jxaDirect, asDirect],
] as [string, number[], number[]][]) {
  const jm = median(jxa);
  const am = median(as);
  const ratio = (jm / am).toFixed(1);
  console.log(`${label.padEnd(45)} ${(jm + 'ms').padStart(7)} ${(am + 'ms').padStart(7)}  JXA ${jm > am ? ratio + '× slower' : ratio + '× faster'}`);
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
