/**
 * Codegen Inspection Script — broad coverage of query shapes.
 *
 * Runs inspectEventPlan on 16 representative query shapes and prints
 * emitted JXA for each. No OmniFocus execution — inspection only.
 *
 * Usage:  node scripts/inspect-codegen.mjs
 */

import { lowerExpr }                from '../dist/tools/query/lower.js';
import { normalizeAst }             from '../dist/tools/query/normalizeAst.js';
import { buildSetIrPlan, inspectEventPlan } from '../dist/tools/query/executionUnits/orchestrator.js';
import { optimizeSetIr }            from '../dist/tools/query/lowerToSetIr.js';
import { lowerSetIrToEventPlan }    from '../dist/tools/query/lowerSetIrToEventPlan.js';
import { cseEventPlan }             from '../dist/tools/query/eventPlanCSE.js';
import { pruneColumns }             from '../dist/tools/query/eventPlanColumnPrune.js';
import { describeEventPlan }        from '../dist/tools/query/eventPlanDescriber.js';

// ── Active-filter (mirrors queryOmnifocus default: includeCompleted=false) ────

function activeFilter(entity) {
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

function buildPredicate(entity, userWhere) {
  const rawAst = userWhere != null ? lowerExpr(userWhere) : null;
  const ast    = rawAst   != null ? normalizeAst(rawAst)  : null;
  const af     = activeFilter(entity);
  if (af !== null) {
    return ast !== null ? { op: 'and', args: [ast, af] } : af;
  }
  return ast ?? true;
}

// ── Representative queries ────────────────────────────────────────────────────

const NOW_PLUS_30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const queries = [
  // 1. Simple get tasks — no predicate
  {
    label:  '1. Simple get tasks (no predicate)',
    entity: 'tasks',
    where:  null,
    select: ['name', 'dueDate', 'flagged'],
    op:     'get',
  },

  // 2. Tasks flagged=true
  {
    label:  '2. Tasks flagged=true',
    entity: 'tasks',
    where:  { eq: [{ var: 'flagged' }, true] },
    select: ['name', 'dueDate'],
    op:     'get',
  },

  // 3. Tasks where status='Overdue' (computed var)
  {
    label:  '3. Tasks status=Overdue (computed var)',
    entity: 'tasks',
    where:  { eq: [{ var: 'status' }, 'Overdue'] },
    select: ['name', 'dueDate'],
    op:     'get',
  },

  // 4. Tasks with tag filter: contains(tags, 'Work')
  {
    label:  '4. Tasks with tag contains(tags,"Work")',
    entity: 'tasks',
    where:  { contains: [{ var: 'tags' }, 'Work'] },
    select: ['name'],
    op:     'get',
  },

  // 5. Tasks with container(project, name contains 'a')
  {
    label:  '5. Tasks container(project, name contains "a")',
    entity: 'tasks',
    where:  { container: ['project', { contains: [{ var: 'name' }, 'a'] }] },
    select: ['name', 'projectName'],
    op:     'get',
  },

  // 6. Tasks with container(tag, name='Work')
  {
    label:  '6. Tasks container(tag, name="Work")',
    entity: 'tasks',
    where:  { container: ['tag', { eq: [{ var: 'name' }, 'Work'] }] },
    select: ['name'],
    op:     'get',
  },

  // 7. Projects (active, no predicate beyond status filter)
  {
    label:  '7. Active projects (no extra predicate)',
    entity: 'projects',
    where:  null,
    select: ['name', 'status'],
    op:     'get',
  },

  // 8. Projects where containing(tasks, flagged=true)
  {
    label:  '8. Projects containing(tasks, flagged=true)',
    entity: 'projects',
    where:  { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
    select: ['name'],
    op:     'get',
  },

  // 9. Folders where containing(projects, name startsWith 'A')
  {
    label:  '9. Folders containing(projects, name startsWith "A")',
    entity: 'folders',
    where:  { containing: ['projects', { startsWith: [{ var: 'name' }, 'A'] }] },
    select: ['name'],
    op:     'get',
  },

  // 10. Folders where containing(tasks, flagged=true) [two-hop]
  {
    label:  '10. Folders containing(tasks, flagged=true) [two-hop]',
    entity: 'folders',
    where:  { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
    select: ['name'],
    op:     'get',
  },

  // 11. Tags where containing(tasks, flagged=true) [array FK]
  {
    label:  '11. Tags containing(tasks, flagged=true) [array FK]',
    entity: 'tags',
    where:  { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
    select: ['name'],
    op:     'get',
  },

  // 12. op:count tasks
  {
    label:  '12. op:count tasks',
    entity: 'tasks',
    where:  null,
    select: [],
    op:     'count',
  },

  // 13. op:exists tasks flagged=true
  {
    label:  '13. op:exists tasks flagged=true',
    entity: 'tasks',
    where:  { eq: [{ var: 'flagged' }, true] },
    select: [],
    op:     'exists',
  },

  // 14. Tasks dueDate between now and +30 days
  {
    label:  `14. Tasks dueDate between now and +30 days (${NOW_PLUS_30})`,
    entity: 'tasks',
    where:  {
      and: [
        { isNotNull: [{ var: 'dueDate' }] },
        { lte: [{ var: 'dueDate' }, { date: NOW_PLUS_30 }] },
      ]
    },
    select: ['name', 'dueDate'],
    op:     'get',
  },

  // 15. Tasks sorted by dueDate, limit 10
  {
    label:  '15. Tasks sorted by dueDate asc, limit 10',
    entity: 'tasks',
    where:  null,
    select: ['name', 'dueDate'],
    op:     'get',
    sort:   { by: 'dueDate', direction: 'asc' },
    limit:  10,
  },

  // 16. Tasks where container(project, id='xyz')
  {
    label:  '16. Tasks container(project, id="xyz")',
    entity: 'tasks',
    where:  { container: ['project', { eq: [{ var: 'id' }, 'xyz'] }] },
    select: ['name'],
    op:     'get',
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

const HR   = '═'.repeat(72);
const THIN = '─'.repeat(72);

for (const q of queries) {
  console.log(`\n${HR}`);
  console.log(`Query: ${q.label}  [entity: ${q.entity}, op: ${q.op}]`);

  // Build predicate
  let predicate;
  try {
    predicate = buildPredicate(q.entity, q.where);
  } catch (e) {
    console.log(`  LOWER ERROR: ${e.message}`);
    continue;
  }

  // Use buildSetIrPlan (the production entry point) for op/sort/limit handling
  let setIrPlan;
  try {
    setIrPlan = buildSetIrPlan({
      predicate,
      entity: q.entity,
      op:     q.op,
      select: q.select,
      sort:   q.sort,
      limit:  q.limit,
    });
    setIrPlan = optimizeSetIr(setIrPlan);
  } catch (e) {
    console.log(`  SETIR ERROR: ${e.message}`);
    continue;
  }

  // Lower to EventPlan + CSE + column pruning
  let eventPlan;
  try {
    const raw  = lowerSetIrToEventPlan(setIrPlan, q.select?.length ? q.select : undefined);
    const csed = cseEventPlan(raw);
    eventPlan  = pruneColumns(csed);
  } catch (e) {
    console.log(`  EVENTPLAN ERROR: ${e.message}`);
    continue;
  }

  // Inspect: split into execution units, emit scripts
  let inspection;
  try {
    inspection = inspectEventPlan(eventPlan);
  } catch (e) {
    console.log(`  INSPECT ERROR: ${e.message}`);
    continue;
  }

  // Print EventPlan IR for reference
  console.log(`\n── EventPlan IR (${eventPlan.nodes.length} nodes)`);
  console.log(describeEventPlan(eventPlan));

  // Print emitted scripts per unit
  console.log(`\n── Execution Units: ${inspection.units.length} total`);
  for (let i = 0; i < inspection.emittedScripts.length; i++) {
    const entry = inspection.emittedScripts[i];
    console.log(`\n  [unit ${i}] runtime=${entry.runtime}  refs=${JSON.stringify(entry.refs)}`);
    if (entry.runtime === 'node') {
      console.log(`  (node-side — no JXA script)`);
    } else {
      console.log(entry.script);
    }
  }
}

console.log(`\n${HR}\nDone.\n`);
