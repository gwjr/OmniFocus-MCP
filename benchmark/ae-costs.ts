#!/usr/bin/env npx tsx
/**
 * Apple Events Cost Benchmark
 *
 * Measures:
 * 1. Process startup: bare JXA vs bare AS vs connecting to OmniFocus
 * 2. Collection access costs (flattenedTasks, flattenedProjects, etc.)
 * 3. Bulk property read costs (name, id, flagged, dates, etc.)
 * 4. Chain property costs (containingProject.name(), container.id())
 * 5. Per-item lookup costs (.whose({id:}))
 * 6. Relationship traversal costs (tag→tasks, project→flattenedTasks)
 * 7. Note reads
 *
 * Each test runs 3 times; reports median.
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let _seq = 0;
function tmpFile(prefix: string): string {
  return join(tmpdir(), `bench_${prefix}_${Date.now()}_${_seq++}.js`);
}

function runJXA(script: string): { ms: number; stdout: string } {
  const f = tmpFile('jxa');
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

function median(runs: number[]): number {
  const sorted = [...runs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function bench(name: string, fn: () => { ms: number; stdout: string }, n = 3): { name: string; medianMs: number; runs: number[]; note: string } {
  const runs: number[] = [];
  let note = '';
  for (let i = 0; i < n; i++) {
    const { ms, stdout } = fn();
    runs.push(Math.round(ms));
    if (i === 0 && stdout.trim()) {
      // Capture first-run output as note
      const trimmed = stdout.trim();
      note = trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed;
    }
  }
  return { name, medianMs: median(runs), runs, note };
}

// ── Results Table ────────────────────────────────────────────────────────

interface Result { name: string; medianMs: number; runs: number[]; note: string }

function printTable(title: string, results: Result[]) {
  console.log(`\n## ${title}\n`);
  const nameW = Math.max(50, ...results.map(r => r.name.length));
  const hdr = `${'Test'.padEnd(nameW)}  Median   Runs         Note`;
  console.log(hdr);
  console.log('-'.repeat(hdr.length + 20));
  for (const r of results) {
    const runsStr = r.runs.map(v => `${v}ms`).join(', ');
    console.log(`${r.name.padEnd(nameW)}  ${String(r.medianMs).padStart(5)}ms  [${runsStr}]  ${r.note}`);
  }
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 1: Process Startup Costs
// ════════════════════════════════════════════════════════════════════════

console.log('# Apple Events Cost Benchmark');
console.log(`Date: ${new Date().toISOString()}`);

const startup: Result[] = [];

startup.push(bench('bare JXA (no app)', () =>
  runJXA(`function run() { return "ok"; }`)
));

startup.push(bench('bare AS (no app)', () =>
  runAS(`return "ok"`)
));

startup.push(bench('JXA: Application("OmniFocus") only', () =>
  runJXA(`(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  return "connected";
})()`)
));

startup.push(bench('AS: tell app "OmniFocus" only', () =>
  runAS(`tell application "OmniFocus"
  return "connected"
end tell`)
));

startup.push(bench('JXA: app + defaultDocument', () =>
  runJXA(`(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var doc = app.defaultDocument;
  return "ok";
})()`)
));

startup.push(bench('AS: app + default document', () =>
  runAS(`tell application "OmniFocus"
  tell default document
    return "ok"
  end tell
end tell`)
));

printTable('Process Startup', startup);

// ════════════════════════════════════════════════════════════════════════
// SECTION 2: Collection Access (getting a reference, no property reads)
// ════════════════════════════════════════════════════════════════════════

const collections: Result[] = [];

for (const col of ['flattenedTasks', 'flattenedProjects', 'flattenedTags', 'flattenedFolders']) {
  collections.push(bench(`JXA: doc.${col} (ref only)`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.${col};
  return JSON.stringify(items.length);
})()`)
  ));
}

for (const col of ['flattened tasks', 'flattened projects', 'flattened tags', 'flattened folders']) {
  collections.push(bench(`AS: count of ${col}`, () =>
    runAS(`tell application "OmniFocus"
  tell default document
    return count of ${col}
  end tell
end tell`)
  ));
}

printTable('Collection Access (count)', collections);

// ════════════════════════════════════════════════════════════════════════
// SECTION 3: Bulk Property Reads (single property on entire collection)
// ════════════════════════════════════════════════════════════════════════

const bulkReads: Result[] = [];

// Task properties
const taskProps = [
  'name', 'id', 'flagged', 'completed', 'dropped',
  'dueDate', 'deferDate', 'completionDate', 'modificationDate',
  'estimatedMinutes', 'blocked', 'effectivelyCompleted', 'effectivelyDropped',
];

for (const prop of taskProps) {
  bulkReads.push(bench(`JXA: flattenedTasks.${prop}()`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedTasks;
  var arr = items.${prop}();
  return JSON.stringify({count: arr.length});
})()`)
  ));
}

// Chain properties
const chainProps = [
  { name: 'containingProject (ref)', expr: 'items.containingProject()' },
  { name: 'containingProject.name()', expr: 'items.containingProject.name()' },
  { name: 'containingProject.id()', expr: 'items.containingProject.id()' },
];

for (const { name, expr } of chainProps) {
  bulkReads.push(bench(`JXA: flattenedTasks.${name}`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedTasks;
  var arr = ${expr};
  return JSON.stringify({count: arr.length});
})()`)
  ));
}

printTable('Bulk Property Reads (Tasks)', bulkReads);

// ── Project properties ───────────────────────────────────────────────

const projReads: Result[] = [];

const projProps = [
  'name', 'id', 'status', 'flagged', 'completed',
  'dueDate', 'deferDate', 'completionDate', 'estimatedMinutes', 'sequential',
  'numberOfTasks', 'numberOfAvailableTasks',
];

for (const prop of projProps) {
  projReads.push(bench(`JXA: flattenedProjects.${prop}()`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedProjects;
  var arr = items.${prop}();
  return JSON.stringify({count: arr.length});
})()`)
  ));
}

// Project chain
projReads.push(bench(`JXA: flattenedProjects.container() (ref)`, () =>
  runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedProjects;
  var arr = items.container();
  return JSON.stringify({count: arr.length});
})()`)
));

projReads.push(bench(`JXA: flattenedProjects.container.id()`, () =>
  runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedProjects;
  var arr = items.container.id();
  return JSON.stringify({count: arr.length});
})()`)
));

printTable('Bulk Property Reads (Projects)', projReads);

// ── Tag properties ───────────────────────────────────────────────────

const tagReads: Result[] = [];

const tagProps = ['name', 'id', 'allowsNextAction', 'hidden', 'effectivelyHidden'];

for (const prop of tagProps) {
  tagReads.push(bench(`JXA: flattenedTags.${prop}()`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedTags;
  var arr = items.${prop}();
  return JSON.stringify({count: arr.length});
})()`)
  ));
}

tagReads.push(bench(`JXA: flattenedTags.container() (ref)`, () =>
  runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedTags;
  var arr = items.container();
  return JSON.stringify({count: arr.length});
})()`)
));

tagReads.push(bench(`JXA: flattenedTags.container.id()`, () =>
  runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedTags;
  var arr = items.container.id();
  return JSON.stringify({count: arr.length});
})()`)
));

printTable('Bulk Property Reads (Tags)', tagReads);

// ── Folder properties ────────────────────────────────────────────────

const folderReads: Result[] = [];

for (const prop of ['name', 'id']) {
  folderReads.push(bench(`JXA: flattenedFolders.${prop}()`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedFolders;
  var arr = items.${prop}();
  return JSON.stringify({count: arr.length});
})()`)
  ));
}

folderReads.push(bench(`JXA: flattenedFolders.container.id()`, () =>
  runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedFolders;
  var arr = items.container.id();
  return JSON.stringify({count: arr.length});
})()`)
));

printTable('Bulk Property Reads (Folders)', folderReads);

// ════════════════════════════════════════════════════════════════════════
// SECTION 4: Multi-Property Reads (cost of N properties in one script)
// ════════════════════════════════════════════════════════════════════════

const multiProp: Result[] = [];

for (const count of [1, 2, 3, 5, 8, 12]) {
  const props = taskProps.slice(0, count);
  const reads = props.map(p => `var ${p}Arr = items.${p}();`).join('\n  ');
  multiProp.push(bench(`JXA: ${count} task props in one script`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedTasks;
  ${reads}
  return JSON.stringify({count: ${props[0]}Arr.length, props: ${count}});
})()`)
  ));
}

printTable('Multi-Property Reads (Tasks, one script)', multiProp);

// ════════════════════════════════════════════════════════════════════════
// SECTION 5: Per-Item Lookups (.whose)
// ════════════════════════════════════════════════════════════════════════

const perItem: Result[] = [];

// First get some real IDs to test with
const idResult = runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var ids = doc.flattenedTasks.id();
  return JSON.stringify(ids.slice(0, 10).map(function(v) { return v.toString(); }));
})()`);
const testIds: string[] = JSON.parse(idResult.stdout.trim());

if (testIds.length > 0) {
  // Single .whose lookup
  perItem.push(bench(`JXA: flattenedTasks.whose({id: "x"}) × 1`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var m = doc.flattenedTasks.whose({id: "${testIds[0]}"});
  return JSON.stringify({found: m.length});
})()`)
  ));

  // 5 .whose lookups in a loop
  const fiveIds = testIds.slice(0, 5);
  perItem.push(bench(`JXA: flattenedTasks.whose({id}) × 5 (loop)`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var ids = ${JSON.stringify(fiveIds)};
  var found = 0;
  for (var i = 0; i < ids.length; i++) {
    var m = doc.flattenedTasks.whose({id: ids[i]});
    if (m.length > 0) found++;
  }
  return JSON.stringify({found: found});
})()`)
  ));

  // 10 .whose lookups
  perItem.push(bench(`JXA: flattenedTasks.whose({id}) × 10 (loop)`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var ids = ${JSON.stringify(testIds)};
  var found = 0;
  for (var i = 0; i < ids.length; i++) {
    var m = doc.flattenedTasks.whose({id: ids[i]});
    if (m.length > 0) found++;
  }
  return JSON.stringify({found: found});
})()`)
  ));

  // .whose by name (case-insensitive)
  perItem.push(bench(`JXA: flattenedTasks.whose({name: "..."})`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var m = doc.flattenedTasks.whose({name: "nonexistent-benchmark-task-12345"});
  return JSON.stringify({found: m.length});
})()`)
  ));

  // .whose on tags (smaller collection)
  perItem.push(bench(`JXA: flattenedTags.whose({name: "..."})`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var m = doc.flattenedTags.whose({name: "nonexistent-benchmark-tag-12345"});
  return JSON.stringify({found: m.length});
})()`)
  ));

  // .whose on projects
  perItem.push(bench(`JXA: flattenedProjects.whose({name: "..."})`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var m = doc.flattenedProjects.whose({name: "nonexistent-benchmark-proj-12345"});
  return JSON.stringify({found: m.length});
})()`)
  ));
}

printTable('Per-Item Lookups (.whose)', perItem);

// ════════════════════════════════════════════════════════════════════════
// SECTION 6: Relationship Traversal (tag→tasks, project→tasks, etc.)
// ════════════════════════════════════════════════════════════════════════

const relationships: Result[] = [];

// Get a real tag name and project name
const namesResult = runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var tagNames = doc.flattenedTags.name();
  var projNames = doc.flattenedProjects.name();
  return JSON.stringify({
    tag: tagNames.length > 0 ? tagNames[0] : null,
    project: projNames.length > 0 ? projNames[0] : null,
  });
})()`);
const { tag: sampleTag, project: sampleProject } = JSON.parse(namesResult.stdout.trim());

if (sampleTag) {
  relationships.push(bench(`JXA: tag("${sampleTag.slice(0,20)}").tasks.id()`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var tags = doc.flattenedTags.whose({name: "${sampleTag.replace(/"/g, '\\"')}"});
  if (tags.length === 0) return JSON.stringify({ids: 0});
  var taskIds = tags[0].tasks.id();
  return JSON.stringify({ids: taskIds.length});
})()`)
  ));
}

if (sampleProject) {
  relationships.push(bench(`JXA: project("${sampleProject.slice(0,20)}").flattenedTasks.id()`, () =>
    runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var projs = doc.flattenedProjects.whose({name: "${sampleProject.replace(/"/g, '\\"')}"});
  if (projs.length === 0) return JSON.stringify({ids: 0});
  var taskIds = projs[0].flattenedTasks.id();
  return JSON.stringify({ids: taskIds.length});
})()`)
  ));
}

printTable('Relationship Traversal', relationships);

// ════════════════════════════════════════════════════════════════════════
// SECTION 7: Note Reads
// ════════════════════════════════════════════════════════════════════════

const noteReads: Result[] = [];

noteReads.push(bench(`JXA: flattenedTasks.note() (bulk)`, () =>
  runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedTasks;
  var arr = items.note();
  return JSON.stringify({count: arr.length});
})()`)
));

noteReads.push(bench(`JXA: flattenedProjects.note() (bulk)`, () =>
  runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedProjects;
  var arr = items.note();
  return JSON.stringify({count: arr.length});
})()`)
));

printTable('Note Reads', noteReads);

// ════════════════════════════════════════════════════════════════════════
// SECTION 8: AppleScript vs JXA for Same Operations
// ════════════════════════════════════════════════════════════════════════

const asVsJxa: Result[] = [];

asVsJxa.push(bench(`JXA: 3 task props (name, flagged, dueDate)`, () =>
  runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedTasks;
  var n = items.name();
  var f = items.flagged();
  var d = items.dueDate();
  return JSON.stringify({count: n.length});
})()`)
));

asVsJxa.push(bench(`AS: 3 task props (name, flagged, due date)`, () =>
  runAS(`tell application "OmniFocus"
  tell default document
    set n to name of every flattened task
    set f to flagged of every flattened task
    set d to due date of every flattened task
    return (count of n) as text
  end tell
end tell`)
));

asVsJxa.push(bench(`JXA: project status (bulk)`, () =>
  runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedProjects;
  var s = items.status();
  return JSON.stringify({count: s.length});
})()`)
));

asVsJxa.push(bench(`AS: project status (bulk)`, () =>
  runAS(`tell application "OmniFocus"
  tell default document
    set theStatuses to status of every flattened project
    return (count of theStatuses) as text
  end tell
end tell`)
));

printTable('JXA vs AppleScript (Same Operations)', asVsJxa);

console.log('\nDone.');
