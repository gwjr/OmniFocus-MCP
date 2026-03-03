/**
 * Codegen Dump — static analysis of the SetIR pipeline.
 *
 * For each representative query, runs:
 *   lowerExpr → normalizeAst → [inject active filter] → executeQueryFromAst
 *   (via inspectEventPlan) and dumps:
 *     - SetIR plan (JSON)
 *     - EventPlan IR (via describeEventPlan)
 *     - Per-unit emitted JXA/OmniJS scripts
 *
 * Uses the same pipeline entry points as production — no reimplementation.
 * Usage:  node scripts/dump-codegen.mjs
 */

import { lowerExpr }          from '../dist/tools/query/lower.js';
import { normalizeAst }       from '../dist/tools/query/normalizeAst.js';
import { lowerToSetIr, optimizeSetIr } from '../dist/tools/query/lowerToSetIr.js';
import { lowerSetIrToEventPlan } from '../dist/tools/query/lowerSetIrToEventPlan.js';
import { cseEventPlan }       from '../dist/tools/query/eventPlanCSE.js';
import { pruneColumns }       from '../dist/tools/query/eventPlanColumnPrune.js';
import { inspectEventPlan }   from '../dist/tools/query/executionUnits/orchestrator.js';
import { describeEventPlan }  from '../dist/tools/query/eventPlanDescriber.js';

// ── Active-filter (mirrors queryOmnifocus default: includeCompleted=false) ───

function activeFilterForEntity(entity) {
  switch (entity) {
    case 'tasks':
      return {
        op: 'and', args: [
          { op: 'not', args: [{ var: 'effectivelyCompleted' }] },
          { op: 'not', args: [{ var: 'effectivelyDropped'   }] },
        ],
      };
    case 'projects':
      return { op: 'in', args: [{ var: 'status' }, ['Active', 'OnHold']] };
    case 'tags':
      return { op: 'not', args: [{ var: 'effectivelyHidden' }] };
    default:
      return null;
  }
}

// ── Representative queries ────────────────────────────────────────────────────

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

// ── Main ──────────────────────────────────────────────────────────────────────

const HR   = '═'.repeat(60);
const THIN = '─'.repeat(60);

for (const q of queries) {
  console.log(`\n${HR}`);
  console.log(`Query: ${q.label} [${q.entity}]`);

  let ast;
  try {
    const raw = q.where != null ? lowerExpr(q.where) : null;
    ast = raw != null ? normalizeAst(raw) : null;
  } catch (e) {
    console.log(`LOWER ERROR: ${e.message}\n`);
    continue;
  }

  // Inject active filter
  const activeFilter = activeFilterForEntity(q.entity);
  let predicate;
  if (activeFilter !== null) {
    predicate = ast !== null ? { op: 'and', args: [ast, activeFilter] } : activeFilter;
  } else {
    predicate = ast ?? true;
  }

  // Build SetIR plan
  let setIrPlan;
  try {
    setIrPlan = lowerToSetIr({ predicate, entity: q.entity, op: 'get', select: q.select });

    if (q.entity === 'tasks') {
      setIrPlan = {
        kind: 'Difference',
        left: setIrPlan,
        right: { kind: 'Scan', entity: 'projects', columns: ['id'] },
      };
    }

    setIrPlan = optimizeSetIr(setIrPlan);
  } catch (e) {
    console.log(`SETIR ERROR: ${e.message}\n`);
    continue;
  }

  console.log(`\n── SetIR Plan ${THIN.slice(14)}`);
  console.log(JSON.stringify(setIrPlan, null, 2));

  // Lower to EventPlan and apply CSE + pruning
  let eventPlan;
  try {
    const raw = lowerSetIrToEventPlan(setIrPlan, q.select);
    const csed = cseEventPlan(raw);
    eventPlan = pruneColumns(csed);
  } catch (e) {
    console.log(`EVENTPLAN ERROR: ${e.message}\n`);
    continue;
  }

  console.log(`\n── EventPlan IR ${THIN.slice(16)}`);
  console.log(describeEventPlan(eventPlan));

  // Inspect execution units and emitted scripts
  let inspection;
  try {
    inspection = inspectEventPlan(eventPlan);
  } catch (e) {
    console.log(`INSPECT ERROR: ${e.message}\n`);
    continue;
  }

  console.log(`\n── Execution Units (${inspection.units.length}) ${THIN.slice(22 + String(inspection.units.length).length)}`);
  for (const entry of inspection.emittedScripts) {
    console.log(`\n  [${entry.runtime}] refs: ${JSON.stringify(entry.refs)}`);
    console.log(entry.script);
  }
}

console.log(`\n${HR}\nDone.\n`);
