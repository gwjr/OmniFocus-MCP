#!/usr/bin/env npx tsx
/**
 * 18-property read: JXA vs AS vs pre-compiled AS
 * 10 runs each, alternating.
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
  try { execSync(`osascript -l JavaScript "${f}"`, { timeout: 60000 }); }
  finally { try { unlinkSync(f); } catch {} }
  return Math.round(performance.now() - t0);
}

function runAS(script: string): number {
  const f = join(tmpdir(), `bench_as_${Date.now()}_${_seq++}.applescript`);
  writeFileSync(f, script);
  const t0 = performance.now();
  try { execSync(`osascript "${f}"`, { timeout: 60000 }); }
  finally { try { unlinkSync(f); } catch {} }
  return Math.round(performance.now() - t0);
}

function runSCPT(script: string): number {
  const src = join(tmpdir(), `bench_scpt_${Date.now()}_${_seq++}.applescript`);
  const scpt = src.replace('.applescript', '.scpt');
  writeFileSync(src, script);
  execSync(`osacompile -o "${scpt}" "${src}"`, { timeout: 10000 });
  try { unlinkSync(src); } catch {}
  const t0 = performance.now();
  try { execSync(`osascript "${scpt}"`, { timeout: 60000 }); }
  finally { try { unlinkSync(scpt); } catch {} }
  return Math.round(performance.now() - t0);
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// 18 task properties (JXA names → AS names)
const props: [string, string][] = [
  ['name', 'name'],
  ['id', 'id'],
  ['flagged', 'flagged'],
  ['completed', 'completed'],
  ['dropped', 'dropped'],
  ['dueDate', 'due date'],
  ['deferDate', 'defer date'],
  ['completionDate', 'completion date'],
  ['modificationDate', 'modification date'],
  ['creationDate', 'creation date'],
  ['estimatedMinutes', 'estimated minutes'],
  ['blocked', 'blocked'],
  ['effectivelyCompleted', 'effectively completed'],
  ['effectivelyDropped', 'effectively dropped'],
  ['sequential', 'sequential'],
  ['inInbox', 'in inbox'],
  ['next', 'next'],
  ['repetitionRule', 'repetition rule'],
];

console.log(`# 18-Property Read: JXA vs AS vs Pre-compiled AS`);
console.log(`# ${props.length} properties, 10 runs each, alternating\n`);

const jxaReads = props.map(([jxa], i) => `  var v${i} = items.${jxa}();`).join('\n');
const jxaScript = `(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedTasks;
${jxaReads}
  return JSON.stringify({count: v0.length});
})()`;

const asReads = props.map(([, as], i) => `    set v${i} to ${as} of every flattened task`).join('\n');
const asScript = `tell application "OmniFocus"
  tell default document
${asReads}
    return (count of v0) as text
  end tell
end tell`;

const N = 10;
const jxa: number[] = [];
const as: number[] = [];
const scpt: number[] = [];

for (let i = 0; i < N; i++) {
  jxa.push(runJXA(jxaScript));
  as.push(runAS(asScript));
  scpt.push(runSCPT(asScript));
  process.stdout.write('.');
}
console.log('\n');

console.log(`JXA:  [${jxa.map(v => v + 'ms').join(', ')}]`);
console.log(`      median=${median(jxa)}ms\n`);
console.log(`AS:   [${as.map(v => v + 'ms').join(', ')}]`);
console.log(`      median=${median(as)}ms\n`);
console.log(`SCPT: [${scpt.map(v => v + 'ms').join(', ')}]`);
console.log(`      median=${median(scpt)}ms\n`);

const jm = median(jxa), am = median(as), sm = median(scpt);
console.log(`## Summary`);
console.log(`  JXA:          ${jm}ms`);
console.log(`  AS (source):  ${am}ms  (${am > jm ? '+' : ''}${am - jm}ms vs JXA)`);
console.log(`  AS (compiled): ${sm}ms  (${sm > jm ? '+' : ''}${sm - jm}ms vs JXA)`);
console.log(`  Compilation overhead estimate: ${am - sm}ms (AS source - AS compiled)`);
