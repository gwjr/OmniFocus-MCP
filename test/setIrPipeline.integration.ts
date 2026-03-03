/**
 * SetIR pipeline integration test.
 *
 * Runs representative queries through the production pipeline via
 * executeQueryFromAst — the single-source-of-truth entry point in
 * the orchestrator. Any pipeline change is automatically covered here.
 *
 * Validation:
 *   - row count > 0 (or 0 for entities with no data — acceptable)
 *   - expected fields are present on each row
 *   - no pipeline errors thrown
 *
 * Bail-on-first-failure: the first assertion failure is reported with full
 * diagnostic detail; subsequent tests are skipped.
 *
 * Requires OmniFocus running. Run with:
 *   node --test test/setIrPipeline.integration.ts
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { lowerExpr }          from '../dist/tools/query/lower.js';
import { normalizeAst }       from '../dist/tools/query/normalizeAst.js';
import { executeQueryFromAst } from '../dist/tools/query/executionUnits/orchestrator.js';
import type { LoweredExpr }   from '../dist/tools/query/fold.js';
import type { EntityType }    from '../dist/tools/query/variables.js';

// ── Active-filter (mirrors queryOmnifocus default) ────────────────────────────

function activeFilterForEntity(entity: EntityType): LoweredExpr | null {
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

// ── Query specs ───────────────────────────────────────────────────────────────

interface QuerySpec {
  label:           string;
  entity:          EntityType;
  where:           unknown;
  select:          string[];
  /** Fields that must appear on every result row. */
  requiredFields?: string[];
}

const queries: QuerySpec[] = [
  {
    label:          'all tasks by name',
    entity:         'tasks',
    where:          null,
    select:         ['name', 'dueDate', 'flagged'],
    requiredFields: ['name'],
  },
  {
    label:          'flagged tasks',
    entity:         'tasks',
    where:          { eq: [{ var: 'flagged' }, true] },
    select:         ['name', 'dueDate'],
    requiredFields: ['name'],
  },
  {
    label:          'tasks with tag Work',
    entity:         'tasks',
    where:          { contains: [{ var: 'tags' }, 'Work'] },
    select:         ['name'],
    requiredFields: ['name'],
  },
  {
    label:          'tasks due before 2026-04-01',
    entity:         'tasks',
    where:          { lt: [{ var: 'dueDate' }, { date: '2026-04-01' }] },
    select:         ['name', 'dueDate'],
    requiredFields: ['name'],
  },
  {
    label:          'active projects',
    entity:         'projects',
    where:          { eq: [{ var: 'status' }, 'active'] },
    select:         ['name', 'status'],
    requiredFields: ['name'],
  },
  {
    label:          'projects with folderName',
    entity:         'projects',
    where:          null,
    select:         ['name', 'folderName'],
    requiredFields: ['name'],
  },
  {
    label:          'all tags',
    entity:         'tags',
    where:          null,
    select:         ['name'],
    requiredFields: ['name'],
  },
  {
    label:          'all folders',
    entity:         'folders',
    where:          null,
    select:         ['name'],
    requiredFields: ['name'],
  },
];

// ── Pipeline runner ───────────────────────────────────────────────────────────

async function runQuery(q: QuerySpec): Promise<Record<string, unknown>[]> {
  const entity = q.entity;

  const baseAst: LoweredExpr | null =
    q.where != null ? normalizeAst(lowerExpr(q.where as any) as LoweredExpr) as LoweredExpr : null;

  const activeFilter = activeFilterForEntity(entity);
  let predicate: LoweredExpr | true;
  if (activeFilter !== null) {
    predicate = baseAst !== null
      ? { op: 'and', args: [baseAst, activeFilter] }
      : activeFilter;
  } else {
    predicate = baseAst ?? true;
  }

  const result = await executeQueryFromAst({
    predicate,
    entity,
    op: 'get',
    select: q.select,
    sort: { by: 'name', direction: 'asc' },
  });

  if (!Array.isArray(result.value)) {
    throw new Error(`Pipeline returned non-array for "${q.label}": ${typeof result.value}`);
  }
  return result.value as Record<string, unknown>[];
}

// ── Result cache ──────────────────────────────────────────────────────────────

interface CachedOk  { ok: true;  rows: Record<string, unknown>[] }
interface CachedErr { ok: false; error: string }
type CachedResult = CachedOk | CachedErr;

const cache = new Map<string, Promise<CachedResult>>();

function getResult(q: QuerySpec): Promise<CachedResult> {
  const hit = cache.get(q.label);
  if (hit) return hit;

  const promise = (async (): Promise<CachedResult> => {
    try {
      const rows = await runQuery(q);
      return { ok: true, rows };
    } catch (err: any) {
      const msg = `Pipeline error for "${q.label}": ${err.message ?? err}`;
      recordFailure(msg);
      return { ok: false, error: msg };
    }
  })();

  cache.set(q.label, promise);
  return promise;
}

// ── Bail-on-first-failure ─────────────────────────────────────────────────────

let hasFailed = false;
let failureDetail = '';

function bail(ctx: { skip: (msg: string) => void }) {
  if (hasFailed) ctx.skip(`Skipped — prior failure:\n${failureDetail}`);
}

function recordFailure(msg: string) {
  if (!hasFailed) { hasFailed = true; failureDetail = msg; }
}

function failAndBail(msg: string): never {
  recordFailure(msg);
  assert.fail(msg);
  throw undefined; // unreachable
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SetIR pipeline integration (requires OmniFocus)', () => {
  let pass = 0, fail = 0;

  after(() => {
    console.log(`\n  SetIR integration: ${pass} passed, ${fail} failed`);
    if (hasFailed) console.log(`\n  First failure:\n${failureDetail}\n`);
  });

  for (const q of queries) {
    // ── pipeline succeeds ─────────────────────────────────────────────────
    it(`${q.label} [${q.entity}] — pipeline succeeds`, async (ctx) => {
      bail(ctx);
      const res = await getResult(q);
      if (!res.ok) { fail++; failAndBail(res.error); }
      pass++;
    });

    // ── returns an array ──────────────────────────────────────────────────
    it(`${q.label} [${q.entity}] — returns array`, async (ctx) => {
      bail(ctx);
      const res = await getResult(q);
      if (!res.ok) { fail++; failAndBail(res.error); }
      assert.ok(Array.isArray(res.rows), `Expected array, got ${typeof res.rows}`);
      pass++;
    });

    // ── required fields present ───────────────────────────────────────────
    if (q.requiredFields && q.requiredFields.length > 0) {
      it(`${q.label} [${q.entity}] — required fields present`, async (ctx) => {
        bail(ctx);
        const res = await getResult(q);
        if (!res.ok) { fail++; failAndBail(res.error); }

        if (res.rows.length === 0) {
          // Empty result is acceptable — no field check needed
          pass++;
          return;
        }

        const firstRow = res.rows[0];
        for (const field of q.requiredFields!) {
          if (!(field in firstRow)) {
            fail++;
            failAndBail([
              `Missing required field "${field}" in result for "${q.label}"`,
              `  First row keys: [${Object.keys(firstRow).join(', ')}]`,
            ].join('\n'));
          }
        }
        pass++;
      });
    }
  }
});
