/**
 * Codegen Dump — baseline regression output for the existing pipeline.
 *
 * Runs representative queries through:
 *   lowerExpr → buildPlanTree → optimize → compileQuery
 * and dumps the strategy tree + generated JXA for each, WITHOUT
 * executing anything against OmniFocus.
 *
 * Usage:  node scripts/dump-codegen.mjs
 */

import { lowerExpr } from '../dist/tools/query/lower.js';
import { buildPlanTree } from '../dist/tools/query/planner.js';
import { optimize, planPathLabel } from '../dist/tools/query/strategy.js';
import { compileQuery } from '../dist/tools/query/compile.js';
import { JxaEmitter } from '../dist/tools/query/emitters/jxaEmitter.js';
import { describeStrategyNode } from '../dist/tools/query/strategyDescriber.js';
import { tagSemiJoinPass } from '../dist/tools/query/optimizations/tagSemiJoin.js';
import { crossEntityJoinPass } from '../dist/tools/query/optimizations/crossEntityJoin.js';
import { selfJoinEliminationPass } from '../dist/tools/query/optimizations/selfJoinElimination.js';
import { normalizePass } from '../dist/tools/query/optimizations/normalize.js';

// ── Optimization passes (same order as queryOmnifocus.ts) ────────────

const PASSES = [tagSemiJoinPass, crossEntityJoinPass, selfJoinEliminationPass, normalizePass];

// ── Representative queries ───────────────────────────────────────────

const queries = [
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

// ── Main ─────────────────────────────────────────────────────────────

const emitter = new JxaEmitter();
const HR = '\u2550'.repeat(54);
const THIN = '\u2500'.repeat(54);

for (const q of queries) {
  console.log(`${HR}`);
  console.log(`Query: ${q.label} [${q.entity}]`);

  let ast;
  try {
    ast = q.where != null ? lowerExpr(q.where) : true;
  } catch (e) {
    console.log(`LOWER ERROR: ${e.message}\n`);
    continue;
  }

  let tree;
  try {
    tree = buildPlanTree(ast, q.entity, q.select, false);
  } catch (e) {
    console.log(`PLANNER ERROR: ${e.message}\n`);
    continue;
  }

  // Optimise
  tree = optimize(tree, PASSES);

  const path = planPathLabel(tree);
  console.log(`Path:  ${path}`);

  // Strategy tree
  console.log(`\n\u2500\u2500 Strategy Tree ${THIN.slice(16)}`);
  console.log(describeStrategyNode(tree));

  // Compile to JXA
  let compiled;
  try {
    compiled = compileQuery(tree, emitter);
  } catch (e) {
    console.log(`\nCOMPILE ERROR: ${e.message}\n`);
    continue;
  }

  const jxa = compiled.batchScript || compiled.standaloneScript || '(no JXA — fallback only)';

  console.log(`\n\u2500\u2500 JXA Script ${THIN.slice(13)}`);
  console.log(jxa);
  console.log('');
}
