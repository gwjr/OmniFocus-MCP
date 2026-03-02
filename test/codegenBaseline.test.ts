/**
 * Codegen baseline regression tests.
 *
 * Runs the same 8 representative queries as scripts/dump-codegen.mjs through
 * the full pipeline (lower → plan → optimize → compile) and asserts the
 * generated JXA matches the captured baseline in benchmark/codegen-baseline.txt.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lowerExpr } from '../dist/tools/query/lower.js';
import { buildPlanTree } from '../dist/tools/query/planner.js';
import { optimize, planPathLabel } from '../dist/tools/query/strategy.js';
import { compileQuery } from '../dist/tools/query/compile.js';
import { JxaEmitter } from '../dist/tools/query/emitters/jxaEmitter.js';
import { tagSemiJoinPass } from '../dist/tools/query/optimizations/tagSemiJoin.js';
import { crossEntityJoinPass } from '../dist/tools/query/optimizations/crossEntityJoin.js';
import { selfJoinEliminationPass } from '../dist/tools/query/optimizations/selfJoinElimination.js';
import { normalizePass } from '../dist/tools/query/optimizations/normalize.js';

// ── Constants ────────────────────────────────────────────────────────────

const PASSES = [tagSemiJoinPass, crossEntityJoinPass, selfJoinEliminationPass, normalizePass];

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(__dirname, '..', 'benchmark', 'codegen-baseline.txt');

// ── Queries (identical to dump-codegen.mjs) ──────────────────────────────

interface QuerySpec {
  label: string;
  entity: string;
  where: any;
  select: string[];
}

const queries: QuerySpec[] = [
  {
    label: 'all tasks by name',
    entity: 'tasks',
    where: null,
    select: ['name', 'dueDate', 'flagged'],
  },
  {
    label: 'flagged tasks',
    entity: 'tasks',
    where: { eq: [{ var: 'flagged' }, true] },
    select: ['name', 'dueDate'],
  },
  {
    label: 'tasks with tag Work',
    entity: 'tasks',
    where: { contains: [{ var: 'tags' }, 'Work'] },
    select: ['name'],
  },
  {
    label: 'tasks due soon',
    entity: 'tasks',
    where: { lt: [{ var: 'dueDate' }, { date: '2026-04-01' }] },
    select: ['name', 'dueDate'],
  },
  {
    label: 'active projects',
    entity: 'projects',
    where: { eq: [{ var: 'status' }, 'active'] },
    select: ['name', 'status'],
  },
  {
    label: 'projects with folderName',
    entity: 'projects',
    where: null,
    select: ['name', 'folderName'],
  },
  {
    label: 'all tags',
    entity: 'tags',
    where: null,
    select: ['name'],
  },
  {
    label: 'all folders',
    entity: 'folders',
    where: null,
    select: ['name'],
  },
];

// ── Baseline parser ──────────────────────────────────────────────────────

interface BaselineEntry {
  label: string;
  entity: string;
  path: string;
  jxa: string;
}

function parseBaseline(text: string): BaselineEntry[] {
  const entries: BaselineEntry[] = [];
  const HR = '\u2550'.repeat(54);

  // Split on the section separator
  const sections = text.split(HR).filter(s => s.trim().length > 0);

  for (const section of sections) {
    const lines = section.split('\n');

    // Find "Query: <label> [<entity>]"
    const queryLine = lines.find(l => l.startsWith('Query: '));
    if (!queryLine) continue;

    const queryMatch = queryLine.match(/^Query: (.+?) \[(\w+)\]$/);
    if (!queryMatch) continue;
    const [, label, entity] = queryMatch;

    // Find "Path: <path>"
    const pathLine = lines.find(l => l.startsWith('Path: '));
    const path = pathLine ? pathLine.replace('Path: ', '').trim() : '';

    // Find JXA Script section
    const jxaMarker = '\u2500\u2500 JXA Script ';
    const jxaIdx = lines.findIndex(l => l.startsWith(jxaMarker));
    if (jxaIdx < 0) continue;

    // JXA body is everything after the marker line until end of section
    const jxaLines = lines.slice(jxaIdx + 1);
    const jxa = jxaLines.join('\n').trim();

    entries.push({ label, entity, path, jxa });
  }

  return entries;
}

// ── Pipeline helper ──────────────────────────────────────────────────────

function runPipeline(q: QuerySpec): { path: string; jxa: string } {
  const ast = q.where != null ? lowerExpr(q.where) : true;
  let tree = buildPlanTree(ast, q.entity as any, q.select, false);
  tree = optimize(tree, PASSES);

  const path = planPathLabel(tree);
  const emitter = new JxaEmitter();
  const compiled = compileQuery(tree, emitter);
  const jxa = compiled.batchScript || compiled.standaloneScript || '(no JXA \u2014 fallback only)';

  return { path, jxa };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('codegen baseline regression', () => {
  let baseline: BaselineEntry[];

  before(() => {
    const text = readFileSync(BASELINE_PATH, 'utf-8');
    baseline = parseBaseline(text);
    assert.equal(baseline.length, 8, `expected 8 baseline entries, got ${baseline.length}`);
  });

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];

    it(`${q.label} [${q.entity}] — path matches`, () => {
      const result = runPipeline(q);
      const expected = baseline.find(b => b.label === q.label && b.entity === q.entity);
      assert.ok(expected, `baseline entry not found for "${q.label}" [${q.entity}]`);
      assert.equal(result.path, expected.path, `execution path mismatch for "${q.label}"`);
    });

    it(`${q.label} [${q.entity}] — JXA matches baseline`, () => {
      const result = runPipeline(q);
      const expected = baseline.find(b => b.label === q.label && b.entity === q.entity);
      assert.ok(expected, `baseline entry not found for "${q.label}" [${q.entity}]`);
      assert.equal(
        result.jxa.trim(),
        expected.jxa.trim(),
        `JXA codegen mismatch for "${q.label}"`,
      );
    });
  }
});
