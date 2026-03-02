#!/usr/bin/env npx tsx
/**
 * Multi-property scaling: JXA vs AppleScript
 *
 * Tests whether AS compilation is pay-once-per-script with cheaper
 * per-statement dispatch, vs JXA which may pay per-statement overhead.
 *
 * Also tests pre-compiled .scpt to isolate compilation cost.
 *
 * 5 runs each, alternating JXA/AS at each property count.
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

function runPrecompiledAS(script: string): number {
  const srcFile = join(tmpdir(), `bench_as_${Date.now()}_${_seq++}.applescript`);
  const scptFile = srcFile.replace('.applescript', '.scpt');
  writeFileSync(srcFile, script);
  // Compile to .scpt
  execSync(`osacompile -o "${scptFile}" "${srcFile}"`, { timeout: 10000 });
  try { unlinkSync(srcFile); } catch {}
  // Run the pre-compiled script
  const t0 = performance.now();
  try {
    execSync(`osascript "${scptFile}"`, { timeout: 60000 });
  } finally {
    try { unlinkSync(scptFile); } catch {}
  }
  return Math.round(performance.now() - t0);
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const N = 5;

const taskProps = [
  'name', 'id', 'flagged', 'completed', 'dropped',
  'dueDate', 'deferDate', 'completionDate', 'modificationDate',
  'estimatedMinutes', 'blocked', 'effectivelyCompleted',
];

// JXA property names map directly; AS names need translation
const asPropNames: Record<string, string> = {
  name: 'name',
  id: 'id',
  flagged: 'flagged',
  completed: 'completed',
  dropped: 'dropped',
  dueDate: 'due date',
  deferDate: 'defer date',
  completionDate: 'completion date',
  modificationDate: 'modification date',
  estimatedMinutes: 'estimated minutes',
  blocked: 'blocked',
  effectivelyCompleted: 'effectively completed',
};

console.log('# Multi-Property Scaling: JXA vs AppleScript vs Pre-compiled AS');
console.log(`# ${N} runs each, alternating\n`);

const counts = [1, 2, 3, 5, 8, 12];

const results: { count: number; jxa: number[]; as: number[]; scpt: number[] }[] = [];

for (const count of counts) {
  const props = taskProps.slice(0, count);

  const jxaReads = props.map((p, i) => `  var v${i} = items.${p}();`).join('\n');
  const jxaScript = `(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedTasks;
${jxaReads}
  return JSON.stringify({count: v0.length, props: ${count}});
})()`;

  const asReads = props.map((p, i) => `    set v${i} to ${asPropNames[p]} of every flattened task`).join('\n');
  const asScript = `tell application "OmniFocus"
  tell default document
${asReads}
    return (count of v0) as text
  end tell
end tell`;

  const jxa: number[] = [];
  const as: number[] = [];
  const scpt: number[] = [];

  process.stdout.write(`${count} props: `);
  for (let i = 0; i < N; i++) {
    jxa.push(runJXA(jxaScript));
    as.push(runAS(asScript));
    scpt.push(runPrecompiledAS(asScript));
    process.stdout.write('.');
  }
  console.log();

  results.push({ count, jxa, as, scpt });
}

// ── Results ─────────────────────────────────────────────────────────

console.log('\n## Raw Runs\n');
for (const r of results) {
  console.log(`### ${r.count} properties`);
  console.log(`  JXA:  [${r.jxa.map(v => v + 'ms').join(', ')}]  median=${median(r.jxa)}ms`);
  console.log(`  AS:   [${r.as.map(v => v + 'ms').join(', ')}]  median=${median(r.as)}ms`);
  console.log(`  SCPT: [${r.scpt.map(v => v + 'ms').join(', ')}]  median=${median(r.scpt)}ms`);
}

console.log('\n## Summary\n');
console.log(`${'Props'.padStart(5)}  ${'JXA'.padStart(7)}  ${'AS'.padStart(7)}  ${'SCPT'.padStart(7)}  ${'AS-JXA'.padStart(7)}  ${'SCPT-JXA'.padStart(9)}  ${'AS-SCPT'.padStart(8)}`);
console.log('-'.repeat(65));
for (const r of results) {
  const jm = median(r.jxa);
  const am = median(r.as);
  const sm = median(r.scpt);
  const diff = am - jm;
  const scptDiff = sm - jm;
  const compileCost = am - sm;
  console.log(
    `${String(r.count).padStart(5)}  ${(jm + 'ms').padStart(7)}  ${(am + 'ms').padStart(7)}  ${(sm + 'ms').padStart(7)}  ` +
    `${(diff > 0 ? '+' : '') + diff + 'ms'}`.padStart(7) + '  ' +
    `${(scptDiff > 0 ? '+' : '') + scptDiff + 'ms'}`.padStart(9) + '  ' +
    `${(compileCost > 0 ? '+' : '') + compileCost + 'ms'}`.padStart(8)
  );
}

console.log('\nAS-JXA: positive = AS slower. SCPT-JXA: positive = pre-compiled AS slower. AS-SCPT: compilation overhead estimate.');
console.log('\nDone.');
