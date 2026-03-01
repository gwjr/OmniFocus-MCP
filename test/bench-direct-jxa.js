/**
 * Benchmark: Direct JXA Apple Events vs OmniJS evaluateJavascript.
 *
 * Tests:
 * 1. Bulk property reads via Apple Events (tasks.name(), etc.)
 * 2. ID-based per-item lookups (validates two-phase viability)
 * 3. Comparison with OmniJS equivalent
 *
 * Usage: node test/bench-direct-jxa.js
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Helpers ──────────────────────────────────────────────────────────────

function runJxa(script) {
  const tempFile = join(tmpdir(), `bench_jxa_${Date.now()}.js`);
  writeFileSync(tempFile, script);
  try {
    const wallStart = Date.now();
    const stdout = execSync(`osascript -l JavaScript "${tempFile}"`, {
      timeout: 120000,
      encoding: 'utf8',
    });
    const wallMs = Date.now() - wallStart;
    unlinkSync(tempFile);
    return { wallMs, result: stdout.trim() };
  } catch (e) {
    try { unlinkSync(tempFile); } catch {}
    return { wallMs: null, error: e.message?.slice(0, 200) };
  }
}

function runOmniJs(script) {
  const omnijsCode = `(() => {
    try {
      var _start = Date.now();
      var _result = (function() { ${script} })();
      var _elapsed = Date.now() - _start;
      return JSON.stringify({ elapsed: _elapsed, result: String(_result) });
    } catch(e) {
      return JSON.stringify({ error: e.toString(), elapsed: -1 });
    }
  })();`;

  const jxaWrapper = `
  function run() {
    try {
      var app = Application('OmniFocus');
      app.includeStandardAdditions = true;
      return app.evaluateJavascript(\`${omnijsCode.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`);
    } catch(e) {
      return JSON.stringify({ error: e.message, elapsed: -1 });
    }
  }
  `;

  const tempFile = join(tmpdir(), `bench_omnijs_${Date.now()}.js`);
  writeFileSync(tempFile, jxaWrapper);
  try {
    const wallStart = Date.now();
    const stdout = execSync(`osascript -l JavaScript "${tempFile}"`, {
      timeout: 120000,
      encoding: 'utf8',
    });
    const wallMs = Date.now() - wallStart;
    unlinkSync(tempFile);
    const parsed = JSON.parse(stdout);
    return { wallMs, innerMs: parsed.elapsed, result: parsed.result, error: parsed.error };
  } catch (e) {
    try { unlinkSync(tempFile); } catch {}
    return { wallMs: null, error: e.message?.slice(0, 200) };
  }
}

// ── Benchmarks ───────────────────────────────────────────────────────────

const benchmarks = [];

function bench(name, fn) {
  benchmarks.push({ name, fn });
}

// --- Group 1: Bulk reads via Apple Events ---

bench('JXA: Bulk read name (all tasks)', () => {
  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var names = doc.flattenedTasks.name();
    return JSON.stringify({count: names.length});
  })()`);
});

bench('JXA: Bulk read name + flagged + dueDate', () => {
  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var tasks = doc.flattenedTasks;
    var names = tasks.name();
    var flagged = tasks.flagged();
    var due = tasks.dueDate();
    return JSON.stringify({count: names.length, flaggedCount: flagged.filter(Boolean).length, dueCount: due.filter(Boolean).length});
  })()`);
});

bench('JXA: Bulk read name + flagged + dueDate + deferDate + completed', () => {
  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var tasks = doc.flattenedTasks;
    var names = tasks.name();
    var flagged = tasks.flagged();
    var due = tasks.dueDate();
    var defer = tasks.deferDate();
    var comp = tasks.completed();
    return JSON.stringify({count: names.length});
  })()`);
});

bench('JXA: Bulk read + containingProject (chain)', () => {
  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var tasks = doc.flattenedTasks;
    var names = tasks.name();
    var flagged = tasks.flagged();
    var projArr = tasks.containingProject();
    var projNames = projArr.map(function(p) { return p ? p.name() : null; });
    return JSON.stringify({count: names.length, withProject: projNames.filter(Boolean).length});
  })()`);
});

bench('JXA: Bulk read + IDs', () => {
  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var tasks = doc.flattenedTasks;
    var names = tasks.name();
    var ids = tasks.id();
    return JSON.stringify({count: names.length, sampleId: ids[0] ? ids[0].toString() : null});
  })()`);
});

// --- Group 2: ID-based per-item lookups (two-phase viability) ---

bench('JXA: Per-item lookup 10 tasks by ID', () => {
  // First get 10 IDs
  const idsResult = runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var ids = doc.flattenedTasks.id();
    var active = [];
    var comp = doc.flattenedTasks.completed();
    for (var i = 0; i < ids.length && active.length < 10; i++) {
      if (!comp[i]) active.push(ids[i].toString());
    }
    return JSON.stringify(active);
  })()`);
  if (idsResult.error) return idsResult;
  const ids = JSON.parse(idsResult.result);

  // Now look up each by ID and read tags
  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var ids = ${JSON.stringify(ids)};
    var results = [];
    for (var i = 0; i < ids.length; i++) {
      var matches = doc.flattenedTasks.whose({id: ids[i]});
      if (matches.length === 0) continue;
      var t = matches[0];
      results.push({
        id: ids[i],
        tags: t.tags().map(function(tg) { return tg.name().toLowerCase(); }),
        inInbox: t.inInbox()
      });
    }
    return JSON.stringify({count: results.length});
  })()`);
});

bench('JXA: Per-item lookup 50 tasks by ID', () => {
  const idsResult = runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var ids = doc.flattenedTasks.id();
    var active = [];
    var comp = doc.flattenedTasks.completed();
    for (var i = 0; i < ids.length && active.length < 50; i++) {
      if (!comp[i]) active.push(ids[i].toString());
    }
    return JSON.stringify(active);
  })()`);
  if (idsResult.error) return idsResult;
  const ids = JSON.parse(idsResult.result);

  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var ids = ${JSON.stringify(ids)};
    var results = [];
    for (var i = 0; i < ids.length; i++) {
      var matches = doc.flattenedTasks.whose({id: ids[i]});
      if (matches.length === 0) continue;
      var t = matches[0];
      results.push({
        id: ids[i],
        tags: t.tags().map(function(tg) { return tg.name().toLowerCase(); }),
        inInbox: t.inInbox()
      });
    }
    return JSON.stringify({count: results.length});
  })()`);
});

bench('JXA: Per-item lookup 100 tasks by ID', () => {
  const idsResult = runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var ids = doc.flattenedTasks.id();
    var active = [];
    var comp = doc.flattenedTasks.completed();
    for (var i = 0; i < ids.length && active.length < 100; i++) {
      if (!comp[i]) active.push(ids[i].toString());
    }
    return JSON.stringify(active);
  })()`);
  if (idsResult.error) return idsResult;
  const ids = JSON.parse(idsResult.result);

  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var ids = ${JSON.stringify(ids)};
    var results = [];
    for (var i = 0; i < ids.length; i++) {
      var matches = doc.flattenedTasks.whose({id: ids[i]});
      if (matches.length === 0) continue;
      var t = matches[0];
      results.push({
        id: ids[i],
        tags: t.tags().map(function(tg) { return tg.name().toLowerCase(); }),
        inInbox: t.inInbox()
      });
    }
    return JSON.stringify({count: results.length});
  })()`);
});

// --- Group 3: Project-scoped reads ---

bench('JXA: Project-scoped bulk read', () => {
  // Find a project first
  const projResult = runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var projs = doc.flattenedProjects.name();
    return JSON.stringify(projs.slice(0, 5));
  })()`);
  if (projResult.error) return projResult;
  const projs = JSON.parse(projResult.result);
  if (projs.length === 0) return { wallMs: 0, result: 'no projects' };
  const projName = projs[0].replace(/"/g, '\\"');

  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var proj = doc.flattenedProjects.whose({name: "${projName}"})[0];
    var tasks = proj.flattenedTasks;
    var names = tasks.name();
    var flagged = tasks.flagged();
    var due = tasks.dueDate();
    return JSON.stringify({project: "${projName}", count: names.length});
  })()`);
});

// --- Group 4: OmniJS equivalent for comparison ---

bench('OmniJS: Filter name contains "review"', () => {
  return runOmniJs(`
    return flattenedTasks.filter(function(t) {
      return (t.name || "").toLowerCase().indexOf("review") !== -1;
    }).length;
  `);
});

bench('OmniJS: Batch read name+flagged+due for all', () => {
  return runOmniJs(`
    var results = flattenedTasks.map(function(t) {
      return { n: t.name, f: t.flagged, d: t.dueDate ? 1 : 0 };
    });
    return results.length;
  `);
});

// ── Runner ───────────────────────────────────────────────────────────────

console.log('Direct JXA vs OmniJS Benchmark');
console.log('='.repeat(85));
console.log();

// Warmup
console.log('Warming up OmniFocus...');
const warmup = runJxa(`(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var doc = app.defaultDocument;
  return doc.flattenedTasks.name().length.toString();
})()`);
console.log(`  Warmup: ${warmup.wallMs}ms wall → ${warmup.result}`);
console.log();

const results = [];

for (const b of benchmarks) {
  process.stdout.write(`  ${b.name} ... `);
  const r = b.fn();
  if (r.error) {
    console.log(`ERROR: ${r.error}`);
    results.push({ name: b.name, wallMs: null, error: r.error });
  } else {
    const wallStr = r.wallMs != null ? `${r.wallMs}ms` : '?';
    const innerStr = r.innerMs != null ? `(${r.innerMs}ms inner)` : '';
    console.log(`${wallStr} ${innerStr} → ${r.result}`);
    results.push({ name: b.name, wallMs: r.wallMs, innerMs: r.innerMs, result: r.result });
  }
}

// Summary
console.log();
console.log('Summary');
console.log('-'.repeat(85));
console.log(`${'Benchmark'.padEnd(55)} ${'Wall ms'.padStart(10)}`);
console.log('-'.repeat(85));
for (const r of results) {
  const wall = r.wallMs != null ? `${r.wallMs}` : 'ERROR';
  console.log(`${r.name.padEnd(55)} ${wall.padStart(10)}`);
}
console.log('-'.repeat(85));
