/**
 * Tests for the `containing` operator (#49).
 *
 * The `containing` operator filters entities (typically projects) by the
 * existence of child entities (typically tasks) satisfying a predicate.
 *
 * Syntax:  { containing: ["tasks", predicate] }  on entity: "projects"
 * Meaning: projects where at least one active task satisfies predicate
 *
 * This is the reverse of `container`:
 *   container:  parent → child   (tasks in project where ...)
 *   containing: child → parent   (projects containing tasks where ...)
 *
 * These tests are TDD-style — they are expected to FAIL until the
 * containing operator is implemented in lower.ts, operations.ts,
 * fold.ts, planner.ts, and the backends.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Describer tests ──────────────────────────────────────────────────────

import { describeExpr } from '../dist/tools/query/backends/describer.js';

describe('describeExpr — containing operator', () => {
  it('describes basic containing', () => {
    assert.equal(
      describeExpr({ containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] }),
      'containing tasks where flagged = true'
    );
  });

  it('describes containing with complex predicate', () => {
    assert.equal(
      describeExpr({
        containing: ['tasks', {
          and: [
            { eq: [{ var: 'flagged' }, true] },
            { lte: [{ var: 'dueDate' }, { offset: { date: 'now', days: 7 } }] }
          ]
        }]
      }),
      'containing tasks where (flagged = true) AND (dueDate <= 7 days from now)'
    );
  });

  it('describes containing combined with other predicates via and', () => {
    assert.equal(
      describeExpr({
        and: [
          { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
          { eq: [{ var: 'status' }, 'Active'] }
        ]
      }),
      '(containing tasks where flagged = true) AND (status = "Active")'
    );
  });

  it('describes containing with status predicate', () => {
    assert.equal(
      describeExpr({
        containing: ['tasks', { eq: [{ var: 'taskStatus' }, 'overdue'] }]
      }),
      'containing tasks where taskStatus = "overdue"'
    );
  });
});

// ── Lowering tests ───────────────────────────────────────────────────────

import { lowerExpr } from '../dist/tools/query/lower.js';
import { LowerError } from '../dist/tools/query/lower.js';

describe('lowerExpr — containing operator', () => {
  it('lowers containing to {op: "containing", args: ["tasks", loweredPredicate]}', () => {
    const result = lowerExpr({ containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] });
    assert.deepEqual(result, {
      op: 'containing',
      args: [
        'tasks',
        { op: 'eq', args: [{ var: 'flagged' }, true] }
      ]
    });
  });

  it('lowers containing with complex predicate', () => {
    const result = lowerExpr({
      containing: ['tasks', {
        and: [
          { eq: [{ var: 'flagged' }, true] },
          { contains: [{ var: 'name' }, 'review'] }
        ]
      }]
    });
    assert.deepEqual(result, {
      op: 'containing',
      args: [
        'tasks',
        {
          op: 'and',
          args: [
            { op: 'eq', args: [{ var: 'flagged' }, true] },
            { op: 'contains', args: [{ var: 'name' }, 'review'] }
          ]
        }
      ]
    });
  });

  it('rejects containing with wrong arg count (1 arg)', () => {
    assert.throws(
      () => lowerExpr({ containing: [{ eq: [{ var: 'flagged' }, true] }] }),
      (err: Error) => err instanceof LowerError
    );
  });

  it('rejects containing with wrong arg count (3 args)', () => {
    assert.throws(
      () => lowerExpr({ containing: ['tasks', { eq: [{ var: 'flagged' }, true] }, 'extra'] }),
      (err: Error) => err instanceof LowerError
    );
  });

  it('rejects containing with invalid child entity type', () => {
    // Only "tasks" should be valid as the child entity for containing
    assert.throws(
      () => lowerExpr({ containing: ['folders', { eq: [{ var: 'name' }, 'test'] }] }),
      (err: Error) => {
        if (!(err instanceof LowerError)) return false;
        // Error message should mention "tasks" as the valid child entity
        return err.message.includes('tasks') || err.message.includes('containing');
      }
    );
  });

  it('rejects containing with non-string child entity', () => {
    assert.throws(
      () => lowerExpr({ containing: [42, { eq: [{ var: 'flagged' }, true] }] }),
      (err: Error) => err instanceof LowerError
    );
  });
});

// ── Planner tests ────────────────────────────────────────────────────────

import { buildPlanTree } from '../dist/tools/query/planner.js';
import { planPathLabel, walkPlan } from '../dist/tools/query/strategy.js';
import type { LoweredExpr } from '../dist/tools/query/fold.js';
import type { StrategyNode } from '../dist/tools/query/strategy.js';

function lower(where: unknown): LoweredExpr {
  return (where != null ? lowerExpr(where) : true) as LoweredExpr;
}

function plan(where: unknown, entity: string = 'projects', select?: string[]) {
  const ast = lower(where);
  return buildPlanTree(ast, entity as any, select, false);
}

function findNode(tree: StrategyNode, kind: string): StrategyNode | null {
  let found: StrategyNode | null = null;
  walkPlan(tree, n => {
    if (n.kind === kind) found = n;
    return n;
  });
  return found;
}

function findAllNodes(tree: StrategyNode, kind: string): StrategyNode[] {
  const found: StrategyNode[] = [];
  walkPlan(tree, n => {
    if (n.kind === kind) found.push(n);
    return n;
  });
  return found;
}

describe('planner — containing operator', () => {
  it('containing(tasks, predicate) on projects → semijoin path', () => {
    const tree = plan(
      { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
      'projects'
    );
    // Should produce a SemiJoin-based plan, not a fallback
    assert.equal(planPathLabel(tree), 'semijoin');
  });

  it('produces a SemiJoin node', () => {
    const tree = plan(
      { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
      'projects'
    );
    const sj = findNode(tree, 'SemiJoin');
    assert.ok(sj, 'should have a SemiJoin node');
    assert.equal(sj!.kind, 'SemiJoin');
  });

  it('SemiJoin source is a BulkScan on projects entity', () => {
    const tree = plan(
      { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
      'projects'
    );
    const sj = findNode(tree, 'SemiJoin');
    assert.ok(sj && sj.kind === 'SemiJoin');

    // The source should be (or contain) a BulkScan on projects
    const sourceScan = findNode(sj.source, 'BulkScan') || (sj.source.kind === 'BulkScan' ? sj.source : null);
    assert.ok(sourceScan && sourceScan.kind === 'BulkScan', 'source should include a BulkScan');
    assert.equal(sourceScan.entity, 'projects');
  });

  it('SemiJoin lookup is a MembershipScan (projects→tasks)', () => {
    const tree = plan(
      { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
      'projects'
    );
    const sj = findNode(tree, 'SemiJoin');
    assert.ok(sj && sj.kind === 'SemiJoin');

    const lookup = sj.lookup;
    assert.equal(lookup.kind, 'MembershipScan');
    if (lookup.kind === 'MembershipScan') {
      // The MembershipScan should look up tasks, returning project IDs
      // (reverse direction: find tasks matching predicate, collect their containing project IDs)
      assert.equal(lookup.sourceEntity, 'tasks', 'source entity should be tasks (child entity)');
      assert.equal(lookup.targetEntity, 'projects', 'target entity should be projects (parent entity)');
    }
  });

  it('MembershipScan predicate carries the child predicate', () => {
    const tree = plan(
      { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
      'projects'
    );
    const ms = findNode(tree, 'MembershipScan');
    assert.ok(ms && ms.kind === 'MembershipScan');
    // The predicate should be the lowered child predicate (flagged = true)
    assert.deepEqual(ms.predicate, { op: 'eq', args: [{ var: 'flagged' }, true] });
  });

  it('containing combined with project-level filter via and', () => {
    const tree = plan(
      {
        and: [
          { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
          { eq: [{ var: 'status' }, 'Active'] }
        ]
      },
      'projects'
    );
    // Should have both SemiJoin (for containing) and Filter (for status)
    const sj = findNode(tree, 'SemiJoin');
    assert.ok(sj, 'should have a SemiJoin for containing');

    const filter = findNode(tree, 'Filter');
    assert.ok(filter, 'should have a Filter for the project-level predicate');
    if (filter && filter.kind === 'Filter') {
      assert.equal(filter.entity, 'projects');
    }
  });

  it('containing under or → fallback (cannot be extracted)', () => {
    const tree = plan(
      {
        or: [
          { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
          { eq: [{ var: 'status' }, 'Active'] }
        ]
      },
      'projects'
    );
    // containing under OR cannot be extracted into a SemiJoin
    assert.equal(planPathLabel(tree), 'fallback');
  });

  it('containing under not → fallback (anti-join not supported)', () => {
    const tree = plan(
      { not: [{ containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] }] },
      'projects'
    );
    assert.equal(planPathLabel(tree), 'fallback');
  });

  it('projects BulkScan includes id column for SemiJoin key', () => {
    const tree = plan(
      { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
      'projects'
    );
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('id'), 'BulkScan should include id for SemiJoin key');
  });

  it('containing with select columns preserves them on BulkScan', () => {
    const tree = plan(
      { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
      'projects',
      ['name', 'status', 'dueDate']
    );
    const scan = findNode(tree, 'BulkScan');
    assert.ok(scan && scan.kind === 'BulkScan');
    assert.ok(scan.columns.includes('name'), 'should include name select column');
  });

  it('containing with task predicate using computed var (taskStatus)', () => {
    // taskStatus = 'overdue' needs to compile correctly with computed var deps
    const tree = plan(
      { containing: ['tasks', { eq: [{ var: 'taskStatus' }, 'overdue'] }] },
      'projects'
    );
    assert.equal(planPathLabel(tree), 'semijoin');
    const ms = findNode(tree, 'MembershipScan');
    assert.ok(ms && ms.kind === 'MembershipScan');
  });

  it('containing with task predicate using chain var (projectName)', () => {
    // Edge case: containing predicate references projectName (chain var on tasks)
    const tree = plan(
      { containing: ['tasks', { contains: [{ var: 'name' }, 'review'] }] },
      'projects'
    );
    assert.equal(planPathLabel(tree), 'semijoin');
  });
});

// ── EventPlan lowering tests ─────────────────────────────────────────────

import type { EventPlan, EventNode, Ref, Specifier } from '../dist/tools/query/eventPlan.js';
import { lowerStrategy } from '../dist/tools/query/strategyToEventPlan.js';

function findEPNodes(plan: EventPlan, kind: EventNode['kind']): { node: EventNode; ref: Ref }[] {
  return plan.nodes
    .map((node, i) => ({ node, ref: i }))
    .filter(({ node }) => node.kind === kind);
}

function findEPOne(plan: EventPlan, kind: EventNode['kind']): { node: EventNode; ref: Ref } {
  const matches = findEPNodes(plan, kind);
  assert.equal(matches.length, 1, `Expected exactly 1 ${kind} node, found ${matches.length}`);
  return matches[0];
}

function getSpecifier(plan: EventPlan, ref: Ref): Specifier {
  const node = plan.nodes[ref];
  assert.equal(node.kind, 'Get', `Node at ref ${ref} is ${node.kind}, expected Get`);
  return (node as Extract<EventNode, { kind: 'Get' }>).specifier;
}

function assertDocElements(spec: Specifier, classCode: string): void {
  assert.equal(spec.kind, 'Elements');
  const el = spec as Extract<Specifier, { kind: 'Elements' }>;
  assert.equal(el.classCode, classCode);
  const parent = el.parent as Specifier;
  assert.equal(parent.kind, 'Document');
}

describe('lowerStrategy — containing operator (SemiJoin with reverse MembershipScan)', () => {

  /**
   * The canonical containing query: find projects that contain flagged tasks.
   *
   * Strategy tree produced by the planner:
   *   SemiJoin(
   *     source: BulkScan(projects, [id, name]),
   *     lookup: MembershipScan(tasks→projects, flagged=true)
   *   )
   *
   * Expected EventPlan:
   *   - Get(Elements(Doc, FCfx))           — all flattened projects
   *   - Get(Property(%0, pnam))            — project names
   *   - Get(Property(%0, ID  ))            — project IDs
   *   - Zip([name, id])                    — zip into rows
   *   - (active filter for projects)
   *   - ... MembershipScan lowering ...
   *   - SemiJoin(source=zipRef, ids=membershipRef)
   */
  it('SemiJoin with reverse MembershipScan lowers to SemiJoin + ForEach', () => {
    // Build the strategy tree manually (as the planner would produce)
    const strategy: StrategyNode = {
      kind: 'SemiJoin',
      source: {
        kind: 'BulkScan',
        entity: 'projects',
        columns: ['id', 'name'],
        includeCompleted: false,
      },
      lookup: {
        kind: 'MembershipScan',
        sourceEntity: 'tasks',
        targetEntity: 'projects',
        predicate: { op: 'eq', args: [{ var: 'flagged' }, true] } as any,
        includeCompleted: false,
      },
    };

    const plan = lowerStrategy(strategy);

    // Should have a SemiJoin node
    const semiJoins = findEPNodes(plan, 'SemiJoin');
    assert.ok(semiJoins.length >= 1, 'should have at least one SemiJoin');

    // Find the user SemiJoin (not a project-exclusion anti-join, since this is projects entity)
    const userSJ = semiJoins.find(({ node }) => {
      const sj = node as Extract<EventNode, { kind: 'SemiJoin' }>;
      return !sj.exclude;
    });
    assert.ok(userSJ, 'should have a non-exclude SemiJoin');

    // SemiJoin source should be the projects scan result
    const sj = userSJ!.node as Extract<EventNode, { kind: 'SemiJoin' }>;
    assert.equal(typeof sj.source, 'number');
    assert.equal(typeof sj.ids, 'number');

    // Result should be the SemiJoin
    assert.equal(plan.result, userSJ!.ref);
  });

  it('reverse MembershipScan scans tasks (FCft) and collects project IDs', () => {
    const strategy: StrategyNode = {
      kind: 'MembershipScan',
      sourceEntity: 'tasks',
      targetEntity: 'projects',
      predicate: { op: 'eq', args: [{ var: 'flagged' }, true] } as any,
      includeCompleted: false,
    };

    const plan = lowerStrategy(strategy);

    // Should scan tasks (FCft) as the source entity
    const gets = findEPNodes(plan, 'Get');
    assert.ok(gets.length >= 1, 'should have Get nodes');

    // First Get should be Elements(Document, FCft) — flattened tasks
    const firstSpec = getSpecifier(plan, 0);
    assertDocElements(firstSpec, 'FCft');

    // Should have a Filter for the predicate (flagged = true)
    const filters = findEPNodes(plan, 'Filter');
    assert.ok(filters.length >= 1, 'should have at least one Filter');

    // Should produce an ID set result (project IDs extracted from matching tasks)
    // The exact mechanism depends on implementation — could be:
    //   a) ForEach over matched tasks, reading containingProject.id()
    //   b) Bulk read containingProject.id() from matched tasks, then deduplicate
    // We just verify the overall shape is sensible.
  });

  it('full containing plan lowers with both scans and SemiJoin', () => {
    // Full strategy tree as planner would build it
    const strategy: StrategyNode = {
      kind: 'SemiJoin',
      source: {
        kind: 'BulkScan',
        entity: 'projects',
        columns: ['id', 'name', 'status'],
        includeCompleted: false,
      },
      lookup: {
        kind: 'MembershipScan',
        sourceEntity: 'tasks',
        targetEntity: 'projects',
        predicate: {
          op: 'and',
          args: [
            { op: 'eq', args: [{ var: 'flagged' }, true] },
            { op: 'contains', args: [{ var: 'name' }, 'review'] },
          ]
        } as any,
        includeCompleted: false,
      },
    };

    const plan = lowerStrategy(strategy);

    // Plan should contain:
    // 1. Get nodes for projects (FCfx) scan
    // 2. Get nodes for tasks (FCft) scan (in MembershipScan)
    // 3. A SemiJoin connecting them
    const getNodes = findEPNodes(plan, 'Get');
    assert.ok(getNodes.length >= 3, `should have multiple Get nodes, got ${getNodes.length}`);

    const semiJoins = findEPNodes(plan, 'SemiJoin');
    assert.ok(semiJoins.length >= 1, 'should have at least one SemiJoin');
  });

  it('containing with Filter for additional project predicates', () => {
    // Strategy: Filter(SemiJoin(BulkScan(projects), MembershipScan(tasks→projects)), status='Active')
    const strategy: StrategyNode = {
      kind: 'Filter',
      source: {
        kind: 'SemiJoin',
        source: {
          kind: 'BulkScan',
          entity: 'projects',
          columns: ['id', 'name', 'status'],
          includeCompleted: false,
        },
        lookup: {
          kind: 'MembershipScan',
          sourceEntity: 'tasks',
          targetEntity: 'projects',
          predicate: { op: 'eq', args: [{ var: 'flagged' }, true] } as any,
          includeCompleted: false,
        },
      },
      predicate: { op: 'eq', args: [{ var: 'status' }, 'Active'] } as any,
      entity: 'projects',
    };

    const plan = lowerStrategy(strategy);

    // Should have a Filter node with entity: projects
    const filters = findEPNodes(plan, 'Filter');
    const userFilter = filters.find(({ node }) => {
      const f = node as Extract<EventNode, { kind: 'Filter' }>;
      const pred = f.predicate as any;
      return pred && typeof pred === 'object' && 'op' in pred &&
        pred.op === 'eq' && pred.args?.[0]?.var === 'status';
    });
    assert.ok(userFilter, 'should have a Filter for status = Active');

    const filter = userFilter!.node as Extract<EventNode, { kind: 'Filter' }>;
    assert.equal(filter.entity, 'projects', 'Filter should carry entity: projects');

    // Result should be the status Filter (outermost node)
    assert.equal(plan.result, userFilter!.ref);
  });
});

// ── VarCollector tests ───────────────────────────────────────────────────

import { collectVarsFromAst } from '../dist/tools/query/backends/varCollector.js';

describe('varCollector — containing operator', () => {
  it('collects no project-level vars from a containing predicate', () => {
    // The containing predicate's vars belong to the child entity (tasks),
    // not the parent entity (projects). The planner should not add
    // task vars to the projects BulkScan columns.
    const ast = lower({ containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] });
    const vars = collectVarsFromAst(ast, 'projects');
    // 'flagged' is a tasks variable, not a projects variable
    assert.ok(!vars.has('flagged'),
      'containing predicate vars should not appear as project-level vars');
  });

  it('collects project-level vars from sibling predicates', () => {
    const ast = lower({
      and: [
        { containing: ['tasks', { eq: [{ var: 'flagged' }, true] }] },
        { eq: [{ var: 'status' }, 'Active'] }
      ]
    });
    const vars = collectVarsFromAst(ast, 'projects');
    // 'status' is a projects variable and should be collected
    assert.ok(vars.has('status'),
      'project-level vars from sibling predicates should be collected');
    // 'flagged' from the containing predicate should NOT be collected
    assert.ok(!vars.has('flagged'),
      'task vars from containing predicate should not be collected at project level');
  });
});
