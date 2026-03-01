/**
 * Targeted benchmarks for alternatives to slow operations.
 *
 * Investigates:
 * 1. Can containingProject be chained in bulk? (tasks.containingProject.name() ?)
 * 2. Can tags be bulk-read somehow?
 * 3. Can we use a single whose() with multiple IDs?
 * 4. How fast is OmniJS for per-item data (tags, status) on a narrowed set?
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function runJxa(script) {
  const tempFile = join(tmpdir(), `bench_alt_${Date.now()}.js`);
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
    return { wallMs: null, error: e.message?.slice(0, 300) };
  }
}

const benchmarks = [];
function bench(name, fn) { benchmarks.push({ name, fn }); }

// --- Alternative chain patterns ---

bench('Chain: tasks.containingProject() then map .name()', () => {
  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var tasks = doc.flattenedTasks;
    var projs = tasks.containingProject();
    var names = projs.map(function(p) { return p ? p.name() : null; });
    return JSON.stringify({count: names.length, withProject: names.filter(Boolean).length});
  })()`);
});

bench('Chain: tasks.containingProject.name() (bulk chained)', () => {
  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var tasks = doc.flattenedTasks;
    try {
      var names = tasks.containingProject.name();
      return JSON.stringify({count: names.length, method: "chained_bulk"});
    } catch(e) {
      return JSON.stringify({error: e.message, method: "chained_bulk_failed"});
    }
  })()`);
});

// --- Active-only containingProject ---

bench('Chain: active tasks only → containingProject().map(name)', () => {
  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var tasks = doc.flattenedTasks;
    var comp = tasks.completed();
    var projs = tasks.containingProject();
    var count = 0;
    var names = [];
    for (var i = 0; i < comp.length; i++) {
      if (!comp[i]) {
        names.push(projs[i] ? projs[i].name() : null);
        count++;
      }
    }
    return JSON.stringify({activeCount: count, withProject: names.filter(Boolean).length});
  })()`);
});

// --- Tags exploration ---

bench('Tags: tasks.tags() bulk', () => {
  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    try {
      var tagArrays = doc.flattenedTasks.tags();
      return JSON.stringify({count: tagArrays.length, type: typeof tagArrays[0], sample: String(tagArrays[0])});
    } catch(e) {
      return JSON.stringify({error: e.message});
    }
  })()`);
});

bench('Tags: active-only per-item tags (486 tasks)', () => {
  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var tasks = doc.flattenedTasks;
    var comp = tasks.completed();
    var ids = tasks.id();
    var activeIds = [];
    for (var i = 0; i < comp.length; i++) {
      if (!comp[i]) activeIds.push(ids[i].toString());
    }

    var results = [];
    for (var i = 0; i < activeIds.length; i++) {
      var m = doc.flattenedTasks.whose({id: activeIds[i]});
      if (m.length === 0) continue;
      var tags = m[0].tags().map(function(t) { return t.name().toLowerCase(); });
      results.push({id: activeIds[i], tags: tags});
    }
    return JSON.stringify({count: results.length});
  })()`);
});

// --- ID lookup alternatives ---

bench('ID lookup: 10 IDs via whose() individually', () => {
  const idsResult = runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var ids = doc.flattenedTasks.id();
    var comp = doc.flattenedTasks.completed();
    var active = [];
    for (var i = 0; i < ids.length && active.length < 10; i++) {
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
      var m = doc.flattenedTasks.whose({id: ids[i]});
      if (m.length > 0) {
        results.push({
          id: ids[i],
          tags: m[0].tags().map(function(t) { return t.name().toLowerCase(); })
        });
      }
    }
    return JSON.stringify({count: results.length});
  })()`);
});

bench('ID lookup: 10 IDs via whose({_or: [...]}) batched', () => {
  const idsResult = runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var ids = doc.flattenedTasks.id();
    var comp = doc.flattenedTasks.completed();
    var active = [];
    for (var i = 0; i < ids.length && active.length < 10; i++) {
      if (!comp[i]) active.push(ids[i].toString());
    }
    return JSON.stringify(active);
  })()`);
  if (idsResult.error) return idsResult;
  const ids = JSON.parse(idsResult.result);

  // Try batched whose with _or
  const orClauses = ids.map(id => `{id: "${id}"}`).join(', ');
  return runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    try {
      var matches = doc.flattenedTasks.whose({_or: [${orClauses}]});
      var results = [];
      for (var i = 0; i < matches.length; i++) {
        results.push({
          id: matches[i].id().toString(),
          tags: matches[i].tags().map(function(t) { return t.name().toLowerCase(); })
        });
      }
      return JSON.stringify({count: results.length, method: "batched_or"});
    } catch(e) {
      return JSON.stringify({error: e.message, method: "batched_or_failed"});
    }
  })()`);
});

// --- OmniJS for per-item data on narrowed set ---

bench('OmniJS: Read tags for 50 active tasks (by ID)', () => {
  const idsResult = runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var ids = doc.flattenedTasks.id();
    var comp = doc.flattenedTasks.completed();
    var active = [];
    for (var i = 0; i < ids.length && active.length < 50; i++) {
      if (!comp[i]) active.push(ids[i].toString());
    }
    return JSON.stringify(active);
  })()`);
  if (idsResult.error) return idsResult;
  const ids = JSON.parse(idsResult.result);

  const omnijsCode = `(() => {
    try {
      var _start = Date.now();
      var ids = ${JSON.stringify(ids)};
      var results = [];
      for (var i = 0; i < ids.length; i++) {
        var t = flattenedTasks.byId(ids[i]);
        if (!t) continue;
        results.push({
          id: ids[i],
          tags: t.tags.map(function(tg) { return tg.name.toLowerCase(); })
        });
      }
      var _elapsed = Date.now() - _start;
      return JSON.stringify({ elapsed: _elapsed, result: String(results.length) });
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

  const tempFile = join(tmpdir(), `bench_omnijs2_${Date.now()}.js`);
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
});

// --- Full pipeline simulation ---

bench('Simulated pipeline: bulk read + Node filter + per-item 10', () => {
  // Phase 1: bulk read + IDs for active tasks
  const phase1 = runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var tasks = doc.flattenedTasks;
    var names = tasks.name();
    var flagged = tasks.flagged();
    var due = tasks.dueDate();
    var ids = tasks.id();
    var comp = tasks.completed();

    var rows = [];
    for (var i = 0; i < names.length; i++) {
      if (!comp[i]) {
        rows.push({
          name: names[i],
          flagged: flagged[i],
          dueDate: due[i] ? due[i].toISOString() : null,
          id: ids[i].toString()
        });
      }
    }
    return JSON.stringify(rows);
  })()`);
  if (phase1.error) return { wallMs: null, error: 'Phase 1: ' + phase1.error };

  const rows = JSON.parse(phase1.result);
  // Node-side filter: name contains "review"
  const filtered = rows.filter(r => r.name && r.name.toLowerCase().includes('review'));
  const firstTen = filtered.slice(0, 10);
  const ids = firstTen.map(r => r.id);

  if (ids.length === 0) return { wallMs: phase1.wallMs, result: `Phase 1: ${phase1.wallMs}ms, 0 matches` };

  // Phase 2: per-item tags
  const phase2 = runJxa(`(function() {
    var app = Application('OmniFocus');
    app.includeStandardAdditions = true;
    var doc = app.defaultDocument;
    var ids = ${JSON.stringify(ids)};
    var results = [];
    for (var i = 0; i < ids.length; i++) {
      var m = doc.flattenedTasks.whose({id: ids[i]});
      if (m.length === 0) continue;
      results.push({
        id: ids[i],
        tags: m[0].tags().map(function(t) { return t.name().toLowerCase(); })
      });
    }
    return JSON.stringify(results);
  })()`);

  const total = phase1.wallMs + (phase2.wallMs || 0);
  return {
    wallMs: total,
    result: `Phase1=${phase1.wallMs}ms(${rows.length}active→${filtered.length}matched), Phase2=${phase2.wallMs}ms(${ids.length}items), Total=${total}ms`
  };
});

// ── Runner ───────────────────────────────────────────────────────────────

console.log('Alternative Approaches Benchmark');
console.log('='.repeat(90));
console.log();

// Warmup
console.log('Warming up...');
const warmup = runJxa(`(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  return app.defaultDocument.flattenedTasks.name().length.toString();
})()`);
console.log(`  Warmup: ${warmup.wallMs}ms\n`);

for (const b of benchmarks) {
  process.stdout.write(`  ${b.name} ... `);
  const r = b.fn();
  if (r.error) {
    console.log(`ERROR: ${r.error.slice(0, 150)}`);
  } else {
    const wall = r.wallMs != null ? `${r.wallMs}ms` : '?';
    const inner = r.innerMs != null ? ` (${r.innerMs}ms inner)` : '';
    console.log(`${wall}${inner} → ${r.result}`);
  }
}

console.log();
