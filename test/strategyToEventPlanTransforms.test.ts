/**
 * Tests for Strategy → EventPlan lowering: transform and binary nodes.
 *
 * The module under test (strategyToEventPlan.ts) does NOT exist yet.
 * These tests are intentionally failing — they define the expected
 * lowering behaviour for Filter, PreFilter, Sort, Limit, Project,
 * SemiJoin, CrossEntityJoin, and PerItemEnrich strategy nodes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StrategyNode } from '../dist/tools/query/strategy.js';
import type { EventPlan, EventNode } from '../dist/tools/query/eventPlan.js';
import { lowerStrategy } from '../dist/tools/query/strategyToEventPlan.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Return all EventNodes of a given kind from the plan. */
function findNodes(plan: EventPlan, kind: EventNode['kind']): EventNode[] {
  return plan.nodes.filter(n => n.kind === kind);
}

/** Return the first EventNode of a given kind, or fail. */
function findOne(plan: EventPlan, kind: EventNode['kind']): EventNode {
  const matches = findNodes(plan, kind);
  assert.ok(matches.length >= 1, `expected at least one ${kind} node, found none`);
  return matches[0];
}

/** Trivial BulkScan leaf used as a source in most tests. */
function trivialBulkScan(entity: string = 'tasks'): StrategyNode {
  return {
    kind: 'BulkScan',
    entity: entity as any,
    columns: ['name'],
    includeCompleted: true,
  };
}

/** MembershipScan leaf for SemiJoin tests. */
function trivialMembershipScan(): StrategyNode {
  return {
    kind: 'MembershipScan',
    sourceEntity: 'tags',
    targetEntity: 'tasks',
    predicate: { op: 'eq', args: [{ var: 'name' }, 'Waiting'] } as any,
    includeCompleted: false,
  };
}

/** FallbackScan leaf for PerItemEnrich tests. */
function trivialFallbackScan(): StrategyNode {
  return {
    kind: 'FallbackScan',
    entity: 'tasks',
    filterAst: true as any,
    includeCompleted: true,
  };
}

// ── Filter ───────────────────────────────────────────────────────────────

describe('lowerStrategy — Filter', () => {
  it('passes predicate through to an EventPlan Filter node', () => {
    const predicate = { var: 'flagged' } as any;
    const strategy: StrategyNode = {
      kind: 'Filter',
      source: trivialBulkScan(),
      predicate,
      entity: 'tasks',
    };

    const plan = lowerStrategy(strategy);

    // Plan must contain a user Filter node (the BulkScan also adds a
    // project-exclusion SemiJoin for tasks, but no extra Filter)
    const filters = findNodes(plan, 'Filter');
    assert.equal(filters.length, 1, 'expected exactly one Filter node');

    const filter = filters[0] as Extract<EventNode, { kind: 'Filter' }>;
    assert.deepEqual(filter.predicate, predicate);

    // Filter.source should be the project-exclusion anti-SemiJoin ref
    // (which is the BulkScan result for task entities)
    const semiJoins = findNodes(plan, 'SemiJoin');
    const excludeSJ = semiJoins.find(n =>
      (n as Extract<EventNode, { kind: 'SemiJoin' }>).exclude === true
    );
    assert.ok(excludeSJ, 'task BulkScan should produce a project-exclusion SemiJoin');
    const excludeRef = plan.nodes.indexOf(excludeSJ!);
    assert.equal(filter.source, excludeRef);

    // Result is the Filter ref
    const filterRef = plan.nodes.indexOf(filter);
    assert.equal(plan.result, filterRef);
  });
});

// ── PreFilter ────────────────────────────────────────────────────────────

describe('lowerStrategy — PreFilter', () => {
  it('elides when all predicate vars are stubbed', () => {
    const predicate = { var: 'flagged' } as any;
    const strategy: StrategyNode = {
      kind: 'PreFilter',
      source: trivialBulkScan(),
      predicate,
      entity: 'tasks',
      assumeTrue: new Set(['flagged']),
    };

    const plan = lowerStrategy(strategy);

    // All vars are stubbed → PreFilter is a no-op, no Filter emitted
    const filters = findNodes(plan, 'Filter');
    assert.equal(filters.length, 0, 'all-stubbed PreFilter should be elided (no Filter)');

    // assumeTrue must NOT appear anywhere in the event plan
    for (const node of plan.nodes) {
      assert.equal(
        'assumeTrue' in node, false,
        'assumeTrue should not appear in EventPlan nodes'
      );
    }
  });

  it('keeps non-stubbed conjuncts as Filter', () => {
    // and(gt(projectCount, 0), eq(name, 'Foo'))
    // projectCount is stubbed, name is not → keeps eq(name, 'Foo') as Filter
    const predicate = {
      op: 'and',
      args: [
        { op: 'gt', args: [{ var: 'projectCount' }, 0] },
        { op: 'eq', args: [{ var: 'name' }, 'Foo'] },
      ],
    } as any;
    const strategy: StrategyNode = {
      kind: 'PreFilter',
      source: trivialBulkScan('folders'),
      predicate,
      entity: 'folders',
      assumeTrue: new Set(['projectCount']),
    };

    const plan = lowerStrategy(strategy);

    // Should produce a Filter with only the non-stubbed conjunct
    const filters = findNodes(plan, 'Filter');
    assert.equal(filters.length, 1, 'mixed PreFilter should produce a Filter');
    const filter = filters[0] as Extract<EventNode, { kind: 'Filter' }>;
    // The remaining predicate should be eq(name, 'Foo'), not the full and()
    assert.deepEqual(filter.predicate, { op: 'eq', args: [{ var: 'name' }, 'Foo'] });
  });
});

// ── Sort ─────────────────────────────────────────────────────────────────

describe('lowerStrategy — Sort', () => {
  it('produces a Sort node with by and dir', () => {
    const strategy: StrategyNode = {
      kind: 'Sort',
      source: trivialBulkScan(),
      by: 'name',
      direction: 'asc',
      entity: 'tasks',
    };

    const plan = lowerStrategy(strategy);

    const sorts = findNodes(plan, 'Sort');
    assert.equal(sorts.length, 1, 'expected exactly one Sort node');

    const sort = sorts[0] as Extract<EventNode, { kind: 'Sort' }>;
    assert.equal(sort.by, 'name');
    assert.equal(sort.dir, 'asc');

    // Sort.source should be the project-exclusion anti-SemiJoin ref
    // (which is the BulkScan result for task entities)
    const semiJoins = findNodes(plan, 'SemiJoin');
    const excludeSJ = semiJoins.find(n =>
      (n as Extract<EventNode, { kind: 'SemiJoin' }>).exclude === true
    );
    assert.ok(excludeSJ, 'task BulkScan should produce a project-exclusion SemiJoin');
    const excludeRef = plan.nodes.indexOf(excludeSJ!);
    assert.equal(sort.source, excludeRef);
  });
});

// ── Limit ────────────────────────────────────────────────────────────────

describe('lowerStrategy — Limit', () => {
  it('produces a Limit node with n', () => {
    const strategy: StrategyNode = {
      kind: 'Limit',
      source: trivialBulkScan(),
      count: 10,
    };

    const plan = lowerStrategy(strategy);

    const limits = findNodes(plan, 'Limit');
    assert.equal(limits.length, 1, 'expected exactly one Limit node');

    const limit = limits[0] as Extract<EventNode, { kind: 'Limit' }>;
    assert.equal(limit.n, 10);
  });
});

// ── Project → Pick ───────────────────────────────────────────────────────

describe('lowerStrategy — Project', () => {
  it('lowers to Pick (not Project)', () => {
    const strategy: StrategyNode = {
      kind: 'Project',
      source: trivialBulkScan(),
      fields: ['name', 'flagged'],
    };

    const plan = lowerStrategy(strategy);

    // Must produce a Pick node, NOT a "Project" node
    const picks = findNodes(plan, 'Pick');
    assert.equal(picks.length, 1, 'Project should lower to a Pick node');

    const pick = picks[0] as Extract<EventNode, { kind: 'Pick' }>;
    assert.deepEqual(pick.fields, ['name', 'flagged']);

    // Result is the Pick ref
    const pickRef = plan.nodes.indexOf(pick);
    assert.equal(plan.result, pickRef);
  });
});

// ── SemiJoin ─────────────────────────────────────────────────────────────

describe('lowerStrategy — SemiJoin', () => {
  it('lowers to SemiJoin with source and ids refs', () => {
    const strategy: StrategyNode = {
      kind: 'SemiJoin',
      source: trivialBulkScan(),
      lookup: trivialMembershipScan(),
    };

    const plan = lowerStrategy(strategy);

    // Two SemiJoin nodes: one for project-exclusion (exclude:true from BulkScan)
    // and one for the user's tag-based SemiJoin (no exclude flag)
    const semiJoins = findNodes(plan, 'SemiJoin');
    assert.equal(semiJoins.length, 2, 'expected two SemiJoin nodes (project-exclusion + user)');

    // The user SemiJoin is the one without exclude:true
    const userSJ = semiJoins.find(n =>
      !(n as Extract<EventNode, { kind: 'SemiJoin' }>).exclude
    ) as Extract<EventNode, { kind: 'SemiJoin' }>;
    assert.ok(userSJ, 'should have a non-exclude SemiJoin');

    // source should reference the project-exclusion anti-SemiJoin
    // (which is the BulkScan result for task entities)
    const excludeSJ = semiJoins.find(n =>
      (n as Extract<EventNode, { kind: 'SemiJoin' }>).exclude === true
    );
    assert.ok(excludeSJ, 'should have a project-exclusion anti-SemiJoin');
    const excludeRef = plan.nodes.indexOf(excludeSJ!);
    assert.equal(userSJ.source, excludeRef);

    // ids should reference the result of MembershipScan lowering
    assert.equal(typeof userSJ.ids, 'number');
    assert.notEqual(userSJ.ids, userSJ.source);

    // Result is the user SemiJoin ref
    const sjRef = plan.nodes.indexOf(userSJ);
    assert.equal(plan.result, sjRef);
  });
});

// ── CrossEntityJoin → HashJoin ───────────────────────────────────────────

describe('lowerStrategy — CrossEntityJoin', () => {
  it('lowers to HashJoin with join keys and field map', () => {
    const sourceScan: StrategyNode = {
      kind: 'BulkScan',
      entity: 'projects',
      columns: ['name', 'folderId'],
      includeCompleted: true,
    };
    const lookupScan: StrategyNode = {
      kind: 'BulkScan',
      entity: 'folders',
      columns: ['id', 'name'],
      includeCompleted: true,
    };
    const strategy: StrategyNode = {
      kind: 'CrossEntityJoin',
      source: sourceScan,
      lookup: lookupScan,
      sourceKey: 'folderId',
      lookupKey: 'id',
      fieldMap: { name: 'folderName' },
    };

    const plan = lowerStrategy(strategy);

    const hashJoins = findNodes(plan, 'HashJoin');
    assert.equal(hashJoins.length, 1, 'expected exactly one HashJoin node');

    const hj = hashJoins[0] as Extract<EventNode, { kind: 'HashJoin' }>;
    assert.equal(hj.sourceKey, 'folderId');
    assert.equal(hj.lookupKey, 'id');
    assert.deepEqual(hj.fieldMap, { name: 'folderName' });

    // Result is the HashJoin ref
    const hjRef = plan.nodes.indexOf(hj);
    assert.equal(plan.result, hjRef);
  });
});

// ── PerItemEnrich ────────────────────────────────────────────────────────

describe('lowerStrategy — PerItemEnrich', () => {
  it('lowers to ColumnValues + ForEach(Get(ByID + Property)) + HashJoin', () => {
    const source: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name', 'id'],
      includeCompleted: true,
    };
    const strategy: StrategyNode = {
      kind: 'PerItemEnrich',
      source,
      perItemVars: new Set(['note']),
      entity: 'tasks',
      threshold: 50,
      fallback: trivialFallbackScan(),
    };

    const plan = lowerStrategy(strategy);

    // ColumnValues extracts id column from the BulkScan result
    const colVals = findNodes(plan, 'ColumnValues');
    assert.ok(colVals.length >= 1, 'expected ColumnValues for id extraction');
    const cv = colVals[0] as Extract<EventNode, { kind: 'ColumnValues' }>;
    assert.equal(cv.field, 'id');

    // ForEach iterates over the ColumnValues result
    const forEaches = findNodes(plan, 'ForEach');
    assert.equal(forEaches.length, 1, 'expected exactly one ForEach');
    const fe = forEaches[0] as Extract<EventNode, { kind: 'ForEach' }>;
    const cvRef = plan.nodes.indexOf(cv);
    assert.equal(fe.source, cvRef);

    // ForEach body should contain:
    //   - Get(ByID(Elements(Document, FCft), loopRef))  — resolve task by ID
    //   - Get(Property(byIdRef, noteCode))               — read note property
    //   - Zip([{name:'id', ref:loopRef}, {name:'note', ref:propRef}])
    const body = fe.body;
    assert.ok(body.length >= 3, `expected at least 3 body nodes, got ${body.length}`);

    // First body node: Get with ByID specifier
    const getById = body[0];
    assert.equal(getById.kind, 'Get');
    if (getById.kind === 'Get') {
      assert.equal(getById.specifier.kind, 'ByID');
    }

    // Second body node: Get with Property specifier (note)
    const getProp = body[1];
    assert.equal(getProp.kind, 'Get');
    if (getProp.kind === 'Get') {
      assert.equal(getProp.specifier.kind, 'Property');
      if (getProp.specifier.kind === 'Property') {
        assert.equal(getProp.specifier.propCode, 'FCno'); // OFTaskProp.note
      }
    }

    // Third body node: Zip with id and note columns
    const zip = body[2];
    assert.equal(zip.kind, 'Zip');
    if (zip.kind === 'Zip') {
      const names = zip.columns.map((c: { name: string }) => c.name);
      assert.ok(names.includes('id'), 'Zip should include id column');
      assert.ok(names.includes('note'), 'Zip should include note column');
    }

    // ForEach.collect should reference the Zip
    // (body nodes are not in plan.nodes — collect is a body-local index)
    assert.equal(typeof fe.collect, 'number');

    // Final HashJoin merges enriched data back into source rows
    const hashJoins = findNodes(plan, 'HashJoin');
    assert.ok(hashJoins.length >= 1, 'expected HashJoin to merge enriched rows');
    const hj = hashJoins[0] as Extract<EventNode, { kind: 'HashJoin' }>;
    assert.equal(hj.sourceKey, 'id');
    assert.equal(hj.lookupKey, 'id');
    assert.deepEqual(hj.fieldMap, { note: 'note' });

    // Result is the HashJoin ref
    const hjRef = plan.nodes.indexOf(hj);
    assert.equal(plan.result, hjRef);
  });

  it('handles multiple per-item vars (note + estimatedMinutes)', () => {
    const source: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name', 'id'],
      includeCompleted: true,
    };
    const strategy: StrategyNode = {
      kind: 'PerItemEnrich',
      source,
      perItemVars: new Set(['note', 'estimatedMinutes']),
      entity: 'tasks',
      threshold: 50,
      fallback: trivialFallbackScan(),
    };

    const plan = lowerStrategy(strategy);

    // ForEach body should contain two Get(Property) nodes — one per var
    const forEaches = findNodes(plan, 'ForEach');
    assert.equal(forEaches.length, 1);
    const fe = forEaches[0] as Extract<EventNode, { kind: 'ForEach' }>;

    const body = fe.body;
    const getNodes = body.filter(n => n.kind === 'Get' && n.specifier.kind === 'Property');
    assert.equal(getNodes.length, 2, 'expected two Get(Property) nodes for two vars');

    // Extract the propCodes from the Property specifiers
    const propCodes = getNodes.map(n => {
      if (n.kind === 'Get' && n.specifier.kind === 'Property') {
        return n.specifier.propCode;
      }
      return null;
    });
    // note = FCno, estimatedMinutes = FCEM
    assert.ok(propCodes.includes('FCno'), 'expected note propCode FCno');
    assert.ok(propCodes.includes('FCEM'), 'expected estimatedMinutes propCode FCEM');

    // Zip should have id + both var columns
    const zipNodes = body.filter(n => n.kind === 'Zip');
    assert.equal(zipNodes.length, 1, 'expected one Zip in ForEach body');
    const zip = zipNodes[0];
    if (zip.kind === 'Zip') {
      const names = zip.columns.map((c: { name: string }) => c.name);
      assert.ok(names.includes('id'), 'Zip should include id');
      assert.ok(names.includes('note'), 'Zip should include note');
      assert.ok(names.includes('estimatedMinutes'), 'Zip should include estimatedMinutes');
      assert.equal(names.length, 3, 'Zip should have exactly 3 columns');
    }
  });
});
