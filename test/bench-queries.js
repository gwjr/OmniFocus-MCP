/**
 * Benchmark harness for OmniJS query patterns.
 * Runs representative queries inside OmniFocus and reports timing.
 *
 * Usage: node test/bench-queries.js
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Benchmark Queries ────────────────────────────────────────────────────
// Each script MUST end with a return statement.

const queries = [
  {
    name: '0. Baseline: count flattenedTasks',
    script: `return flattenedTasks.length;`,
  },
  {
    name: '1. Iterate, no property access',
    script: `
      var count = 0;
      flattenedTasks.forEach(function(t) { count++; });
      return count;
    `,
  },
  {
    name: '2. Filter: flagged',
    script: `return flattenedTasks.filter(function(t) { return t.flagged; }).length;`,
  },
  {
    name: '3. Filter: name contains "review"',
    script: `
      return flattenedTasks.filter(function(t) {
        return (t.name || "").toLowerCase().indexOf("review") !== -1;
      }).length;
    `,
  },
  {
    name: '4. Filter: dueDate != null',
    script: `return flattenedTasks.filter(function(t) { return t.dueDate != null; }).length;`,
  },
  {
    name: '5. Filter: dueDate < now',
    script: `
      var _now = new Date();
      return flattenedTasks.filter(function(t) {
        return t.dueDate != null && t.dueDate < _now;
      }).length;
    `,
  },
  {
    name: '6. effectiveDueDate between now..+7d',
    script: `
      var _now = new Date();
      var _end = new Date(_now.getTime()); _end.setDate(_end.getDate() + 7);
      return flattenedTasks.filter(function(t) {
        return t.effectiveDueDate != null && t.effectiveDueDate >= _now && t.effectiveDueDate <= _end;
      }).length;
    `,
  },
  {
    name: '7. Filter: tags contains "fast"',
    script: `
      return flattenedTasks.filter(function(t) {
        return t.tags.map(function(tg){return tg.name.toLowerCase();}).indexOf("fast") !== -1;
      }).length;
    `,
  },
  {
    name: '8. projectName contains "PHS"',
    script: `
      return flattenedTasks.filter(function(t) {
        return (t.containingProject ? t.containingProject.name || "" : "").toLowerCase().indexOf("phs") !== -1;
      }).length;
    `,
  },
  {
    name: '9. container("folder") walk',
    script: `
      return flattenedTasks.filter(function(item) {
        return (function(){
          var _c0 = item.containingProject;
          if(_c0==null)return false;
          _c0=_c0.parentFolder;
          while(_c0!=null){
            if((_c0.name || "").toLowerCase().indexOf("professional") !== -1) return true;
            _c0=_c0.parent;
          }
          return false;
        })();
      }).length;
    `,
  },
  {
    name: '10. Full: between + sort + select',
    script: `
      var _now = new Date();
      var _end = new Date(_now.getTime()); _end.setDate(_end.getDate() + 7);
      var taskStatusMap = {};
      taskStatusMap[Task.Status.Available] = "Available";
      taskStatusMap[Task.Status.Blocked] = "Blocked";
      taskStatusMap[Task.Status.Completed] = "Completed";
      taskStatusMap[Task.Status.Dropped] = "Dropped";
      taskStatusMap[Task.Status.DueSoon] = "DueSoon";
      taskStatusMap[Task.Status.Next] = "Next";
      taskStatusMap[Task.Status.Overdue] = "Overdue";

      var filtered = flattenedTasks.filter(function(item) {
        if (item.taskStatus === Task.Status.Completed || item.taskStatus === Task.Status.Dropped) return false;
        var d = item.dueDate;
        return (d != null && _now != null && d >= _now) && (d != null && _end != null && d <= _end);
      });

      filtered.sort(function(a, b) {
        var aVal = a.dueDate;
        var bVal = b.dueDate;
        if (aVal == null && bVal == null) return 0;
        if (aVal == null) return 1;
        if (bVal == null) return -1;
        return aVal.getTime() - bVal.getTime();
      });

      var results = filtered.map(function(item) {
        return {
          name: item.name || "",
          dueDate: item.dueDate ? item.dueDate.toISOString() : null,
          projectName: item.containingProject ? item.containingProject.name : null,
          tagNames: item.tags ? item.tags.map(function(t){return t.name;}) : []
        };
      });

      return JSON.stringify({count: results.length});
    `,
  },
  {
    name: '11. Batch: name+dueDate for ALL tasks',
    script: `
      var results = flattenedTasks.map(function(t) {
        return { n: t.name, d: t.dueDate ? 1 : 0 };
      });
      return results.length;
    `,
  },
  {
    name: '12. Batch: +projectName for ALL tasks',
    script: `
      var results = flattenedTasks.map(function(t) {
        return {
          n: t.name,
          d: t.dueDate ? 1 : 0,
          p: t.containingProject ? t.containingProject.name : null
        };
      });
      return results.length;
    `,
  },
  {
    name: '13. Status exclusion only',
    script: `
      return flattenedTasks.filter(function(t) {
        return t.taskStatus !== Task.Status.Completed && t.taskStatus !== Task.Status.Dropped;
      }).length;
    `,
  },
  {
    name: '14. REPEAT: count flattenedTasks',
    script: `return flattenedTasks.length;`,
  },
  {
    name: '15. REPEAT: name contains "review"',
    script: `
      return flattenedTasks.filter(function(t) {
        return (t.name || "").toLowerCase().indexOf("review") !== -1;
      }).length;
    `,
  },
];

// ── Runner ───────────────────────────────────────────────────────────────

function runQuery(script) {
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

  const tempFile = join(tmpdir(), `bench_${Date.now()}.js`);
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
    return {
      wallMs,
      innerMs: parsed.elapsed ?? null,
      result: parsed.result ?? null,
      error: parsed.error ?? null,
    };
  } catch (e) {
    try { unlinkSync(tempFile); } catch {}
    return { wallMs: null, innerMs: null, result: null, error: e.message?.slice(0, 100) };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

console.log('OmniJS Query Benchmark');
console.log('='.repeat(85));
console.log();

// Warmup
console.log('Warming up OmniFocus...');
const warmup = runQuery('return "ok";');
console.log(`  Warmup: ${warmup.wallMs}ms wall`);
console.log();

for (const q of queries) {
  process.stdout.write(`  ${q.name} ... `);
  const r = runQuery(q.script);
  if (r.error) {
    console.log(`ERROR: ${r.error}`);
  } else {
    console.log(`${String(r.innerMs).padStart(6)}ms inner / ${String(r.wallMs).padStart(6)}ms wall → ${r.result}`);
  }
}

console.log();
console.log('Summary');
console.log('-'.repeat(85));
console.log(`${'Query'.padEnd(46)} ${'Inner'.padStart(8)} ${'Wall'.padStart(8)}  Result`);
console.log('-'.repeat(85));
for (const q of queries) {
  const r = runQuery.__lastResults?.[q.name]; // won't exist, re-derive below
}

// We already printed inline, summary is above
