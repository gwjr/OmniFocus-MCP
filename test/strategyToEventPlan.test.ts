/**
 * Tests for Strategy → EventPlan lowering (leaf / scan nodes).
 *
 * The module under test does NOT exist yet — these tests are expected to fail
 * at import time until strategyToEventPlan.ts is implemented.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StrategyNode } from '../dist/tools/query/strategy.js';
import type { EventPlan, EventNode, Specifier, Ref } from '../dist/tools/query/eventPlan.js';
import { lowerStrategy } from '../dist/tools/query/strategyToEventPlan.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Find all nodes of a given kind in a plan. */
function findNodes(plan: EventPlan, kind: EventNode['kind']): { node: EventNode; ref: Ref }[] {
  return plan.nodes
    .map((node, i) => ({ node, ref: i }))
    .filter(({ node }) => node.kind === kind);
}

/** Find the single node of a given kind; throw if not exactly one. */
function findOne(plan: EventPlan, kind: EventNode['kind']): { node: EventNode; ref: Ref } {
  const matches = findNodes(plan, kind);
  assert.equal(matches.length, 1, `Expected exactly 1 ${kind} node, found ${matches.length}`);
  return matches[0];
}

/** Unwrap a Get node's specifier. */
function getSpecifier(plan: EventPlan, ref: Ref): Specifier {
  const node = plan.nodes[ref];
  assert.equal(node.kind, 'Get', `Node at ref ${ref} is ${node.kind}, expected Get`);
  return (node as Extract<EventNode, { kind: 'Get' }>).specifier;
}

/** Assert a specifier is Elements with the given classCode. */
function assertElements(spec: Specifier, classCode: string): void {
  assert.equal(spec.kind, 'Elements', `Expected Elements specifier, got ${spec.kind}`);
  assert.equal((spec as Extract<Specifier, { kind: 'Elements' }>).classCode, classCode);
}

/** Assert a specifier is Property with the given propCode and parent ref. */
function assertProperty(spec: Specifier, propCode: string, parentRef: Ref): void {
  assert.equal(spec.kind, 'Property', `Expected Property specifier, got ${spec.kind}`);
  const prop = spec as Extract<Specifier, { kind: 'Property' }>;
  assert.equal(prop.propCode, propCode);
  assert.equal(prop.parent, parentRef);
}

/**
 * Assert a specifier is Elements(Document, classCode).
 * Returns the spec for further inspection.
 */
function assertDocElements(spec: Specifier, classCode: string): void {
  assert.equal(spec.kind, 'Elements');
  const el = spec as Extract<Specifier, { kind: 'Elements' }>;
  assert.equal(el.classCode, classCode);
  const parent = el.parent as Specifier;
  assert.equal(parent.kind, 'Document');
}

// ── BulkScan ─────────────────────────────────────────────────────────────

describe('lowerStrategy — BulkScan', () => {

  it('single easy column emits Get(Elements), Get(Property), Zip + project exclusion', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name'],
      includeCompleted: true,
    };
    const plan = lowerStrategy(strategy);

    // node[0] = Get(Elements(Document, 'FCft'))
    assert.equal(plan.nodes[0].kind, 'Get');
    const spec0 = getSpecifier(plan, 0);
    assertDocElements(spec0, 'FCft');

    // node[1] = Get(Property(%0, 'pnam'))
    assert.equal(plan.nodes[1].kind, 'Get');
    const spec1 = getSpecifier(plan, 1);
    assertProperty(spec1, 'pnam', 0);

    // Zip includes name and injected id columns
    const { node: zipNode } = findOne(plan, 'Zip');
    const zip = zipNode as Extract<EventNode, { kind: 'Zip' }>;
    const colNames = zip.columns.map(c => c.name);
    assert.ok(colNames.includes('name'));
    assert.ok(colNames.includes('id'), 'id injected for project-exclusion anti-join');

    // Task BulkScans end with a project-exclusion anti-SemiJoin
    const semiJoins = findNodes(plan, 'SemiJoin');
    assert.ok(semiJoins.length >= 1);
    const excludeSJ = semiJoins.find(({ node }) =>
      (node as Extract<EventNode, { kind: 'SemiJoin' }>).exclude === true
    );
    assert.ok(excludeSJ, 'should have a project-exclusion anti-SemiJoin');

    // result = the anti-SemiJoin
    assert.equal(plan.result, excludeSJ!.ref);
  });

  it('two columns emit two Property reads and Zip with both', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name', 'flagged'],
      includeCompleted: true,
    };
    const plan = lowerStrategy(strategy);

    // node[0] = Get(Elements(Document, 'FCft'))
    assertDocElements(getSpecifier(plan, 0), 'FCft');

    // node[1] = Get(Property(%0, 'pnam'))
    assertProperty(getSpecifier(plan, 1), 'pnam', 0);

    // node[2] = Get(Property(%0, 'FCfl'))
    assertProperty(getSpecifier(plan, 2), 'FCfl', 0);

    // Zip includes name, flagged, and injected id
    const { node: zipNode } = findOne(plan, 'Zip');
    const zip = zipNode as Extract<EventNode, { kind: 'Zip' }>;
    const colNames = zip.columns.map(c => c.name);
    assert.ok(colNames.includes('name'));
    assert.ok(colNames.includes('flagged'));
    assert.ok(colNames.includes('id'), 'id injected for project-exclusion');

    // Result is the project-exclusion anti-SemiJoin
    const semiJoins = findNodes(plan, 'SemiJoin');
    const excludeSJ = semiJoins.find(({ node }) =>
      (node as Extract<EventNode, { kind: 'SemiJoin' }>).exclude === true
    );
    assert.ok(excludeSJ);
    assert.equal(plan.result, excludeSJ!.ref);
  });

  it('includeCompleted:false adds active-task Filter after Zip, then project exclusion', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name'],
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    // Zip should exist
    const { ref: zipRef } = findOne(plan, 'Zip');

    // A Filter node should follow the Zip
    const { node: filterNode, ref: filterRef } = findOne(plan, 'Filter');
    assert.ok(filterRef > zipRef, 'Filter should come after Zip');

    // The filter predicate should express active-task filtering:
    // {op:'and', args:[{op:'not',args:[{var:'effectivelyCompleted'}]},{op:'not',args:[{var:'effectivelyDropped'}]}]}
    const filter = filterNode as Extract<EventNode, { kind: 'Filter' }>;
    assert.equal(filter.source, zipRef);
    const pred = filter.predicate as any;
    assert.equal(pred.op, 'and');
    assert.equal(pred.args.length, 2);
    // Each arg should be {op:'not', args:[{var: '...'}]}
    for (const arg of pred.args) {
      assert.equal(arg.op, 'not');
      assert.ok('var' in arg.args[0], 'inner expression should be a {var} node');
    }
    // Check the var names
    const varNames = pred.args.map((a: any) => a.args[0].var);
    assert.ok(varNames.includes('effectivelyCompleted'));
    assert.ok(varNames.includes('effectivelyDropped'));

    // result should point to the project-exclusion anti-SemiJoin (after Filter)
    const semiJoins = findNodes(plan, 'SemiJoin');
    const excludeSJ = semiJoins.find(({ node }) =>
      (node as Extract<EventNode, { kind: 'SemiJoin' }>).exclude === true
    );
    assert.ok(excludeSJ, 'should have project-exclusion anti-SemiJoin');
    assert.ok(excludeSJ!.ref > filterRef, 'anti-SemiJoin after Filter');
    assert.equal(plan.result, excludeSJ!.ref);
  });

  it('computedVars adds Derive node after Zip, then project exclusion', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['completed', 'dropped'],
      computedVars: new Set(['status']),
      includeCompleted: true,
    };
    const plan = lowerStrategy(strategy);

    // Zip exists
    const { ref: zipRef } = findOne(plan, 'Zip');

    // Derive should exist after Zip
    const { node: deriveNode, ref: deriveRef } = findOne(plan, 'Derive');
    assert.ok(deriveRef > zipRef, 'Derive should come after Zip');

    const derive = deriveNode as Extract<EventNode, { kind: 'Derive' }>;
    assert.equal(derive.source, zipRef);
    assert.ok(
      derive.derivations.some(d => d.var === 'status' && d.entity === 'tasks'),
      'Should have a status derivation for tasks entity'
    );

    // Result is the project-exclusion anti-SemiJoin (after Derive)
    const semiJoins = findNodes(plan, 'SemiJoin');
    const excludeSJ = semiJoins.find(({ node }) =>
      (node as Extract<EventNode, { kind: 'SemiJoin' }>).exclude === true
    );
    assert.ok(excludeSJ);
    assert.ok(excludeSJ!.ref > deriveRef, 'anti-SemiJoin after Derive');
    assert.equal(plan.result, excludeSJ!.ref);
  });

  it('projects entity uses FCfx class code', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'projects',
      columns: ['name'],
      includeCompleted: true,
    };
    const plan = lowerStrategy(strategy);

    // node[0] should be Get(Elements(Document, 'FCfx'))
    assertDocElements(getSpecifier(plan, 0), 'FCfx');
  });

  it('tags entity with includeCompleted:false filters by effectivelyHidden', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tags',
      columns: ['name'],
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    // Should use FCfc (flattenedTag) for elements
    assertDocElements(getSpecifier(plan, 0), 'FCfc');

    // Active filter for tags is: {op:'not', args:[{var:'effectivelyHidden'}]}
    const { node: filterNode } = findOne(plan, 'Filter');
    const filter = filterNode as Extract<EventNode, { kind: 'Filter' }>;
    const pred = filter.predicate as any;
    assert.equal(pred.op, 'not');
    assert.ok('var' in pred.args[0], 'inner expression should be a {var} node');
    assert.equal(pred.args[0].var, 'effectivelyHidden');
  });

  it('folders entity uses FCff class code', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'folders',
      columns: ['name'],
      includeCompleted: true,
    };
    const plan = lowerStrategy(strategy);

    assertDocElements(getSpecifier(plan, 0), 'FCff');
  });

  it('computedVars + includeCompleted:false emits Derive, Filter, then project exclusion', () => {
    // Derive should come before the active filter so derived fields are
    // available to the filter predicate if needed.
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['completed', 'dropped', 'blocked', 'dueDate'],
      computedVars: new Set(['status']),
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    const { ref: zipRef } = findOne(plan, 'Zip');
    const { ref: deriveRef } = findOne(plan, 'Derive');
    const { ref: filterRef } = findOne(plan, 'Filter');

    assert.ok(deriveRef > zipRef, 'Derive comes after Zip');
    assert.ok(filterRef > deriveRef, 'Filter comes after Derive');

    // Result is the project-exclusion anti-SemiJoin (after Filter)
    const semiJoins = findNodes(plan, 'SemiJoin');
    const excludeSJ = semiJoins.find(({ node }) =>
      (node as Extract<EventNode, { kind: 'SemiJoin' }>).exclude === true
    );
    assert.ok(excludeSJ);
    assert.ok(excludeSJ!.ref > filterRef, 'anti-SemiJoin after Filter');
    assert.equal(plan.result, excludeSJ!.ref);
  });

});

// ── FallbackScan ─────────────────────────────────────────────────────────

describe('lowerStrategy — FallbackScan', () => {

  it('basic FallbackScan emits Get(Elements) + Filter', () => {
    const strategy: StrategyNode = {
      kind: 'FallbackScan',
      entity: 'tasks',
      filterAst: { op: 'var', args: ['flagged'] } as any,
      includeCompleted: true,
    };
    const plan = lowerStrategy(strategy);

    // node[0] = Get(Elements(Document, 'FCft'))
    assertDocElements(getSpecifier(plan, 0), 'FCft');

    // node[1] = Filter(%0, predicate)
    const filter = plan.nodes[1] as Extract<EventNode, { kind: 'Filter' }>;
    assert.equal(filter.kind, 'Filter');
    assert.equal(filter.source, 0);

    assert.equal(plan.result, 1);
  });

  it('includeCompleted:false combines active filter with user predicate', () => {
    const strategy: StrategyNode = {
      kind: 'FallbackScan',
      entity: 'tasks',
      filterAst: { op: 'var', args: ['flagged'] } as any,
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    // There should be a Filter node
    const { node: filterNode } = findOne(plan, 'Filter');
    const filter = filterNode as Extract<EventNode, { kind: 'Filter' }>;

    // The predicate should be {and: [activeFilterExpr, {var: 'flagged'}]}
    const pred = filter.predicate as any;
    assert.equal(pred.op, 'and');
    assert.ok(pred.args.length >= 2, 'And predicate should have at least 2 args');
  });

  it('FallbackScan for projects uses FCfx', () => {
    const strategy: StrategyNode = {
      kind: 'FallbackScan',
      entity: 'projects',
      filterAst: { op: 'var', args: ['flagged'] } as any,
      includeCompleted: true,
    };
    const plan = lowerStrategy(strategy);

    assertDocElements(getSpecifier(plan, 0), 'FCfx');
  });

  it('FallbackScan for tags uses FCfc', () => {
    const strategy: StrategyNode = {
      kind: 'FallbackScan',
      entity: 'tags',
      filterAst: { op: 'var', args: ['name'] } as any,
      includeCompleted: true,
    };
    const plan = lowerStrategy(strategy);

    assertDocElements(getSpecifier(plan, 0), 'FCfc');
  });
});

// ── MembershipScan ───────────────────────────────────────────────────────

describe('lowerStrategy — MembershipScan', () => {

  it('tags→tasks emits source lookup, ForEach with element + id reads', () => {
    const strategy: StrategyNode = {
      kind: 'MembershipScan',
      sourceEntity: 'tags',
      targetEntity: 'tasks',
      predicate: { op: 'eq', args: [{ op: 'var', args: ['name'] }, 'Work'] } as any,
      includeCompleted: true,
    };
    const plan = lowerStrategy(strategy);

    // First: Get(Elements(Document, 'FCfc')) — flattened tags
    assertDocElements(getSpecifier(plan, 0), 'FCfc');

    // Second: Filter to find the matching tag(s)
    const filterNodes = findNodes(plan, 'Filter');
    assert.ok(filterNodes.length >= 1, 'Should have at least one Filter node');
    const sourceFilter = filterNodes[0];
    assert.equal(
      (sourceFilter.node as Extract<EventNode, { kind: 'Filter' }>).source,
      0
    );

    // Should have a ForEach that iterates over matched tags
    const forEachNodes = findNodes(plan, 'ForEach');
    assert.ok(forEachNodes.length >= 1, 'Should have a ForEach node');

    const forEach = forEachNodes[0].node as Extract<EventNode, { kind: 'ForEach' }>;
    // Body should Get(Elements(%n, 'FCft')) — tasks of the tag
    // and then Get(Property(%m, 'ID  ')) — task IDs
    const bodyGets = forEach.body.filter(n => n.kind === 'Get');
    assert.ok(bodyGets.length >= 1, 'ForEach body should have Get nodes');

    // Check that the body reads task elements (FCft) from the loop variable
    const elementGet = bodyGets.find(g => {
      const spec = (g as Extract<EventNode, { kind: 'Get' }>).specifier;
      return spec.kind === 'Elements' && (spec as any).classCode === 'FCft';
    });
    assert.ok(elementGet, 'ForEach body should get task elements (FCft)');

    // Check that an ID property read exists in the body
    const idGet = bodyGets.find(g => {
      const spec = (g as Extract<EventNode, { kind: 'Get' }>).specifier;
      return spec.kind === 'Property' && (spec as any).propCode === 'ID  ';
    });
    assert.ok(idGet, 'ForEach body should read task IDs (ID  )');

    // Result should reference the ForEach (outside = accumulated ids)
    assert.equal(plan.result, forEachNodes[0].ref);
  });

  it('projects→tasks uses FCfx for source and FCft for target', () => {
    const strategy: StrategyNode = {
      kind: 'MembershipScan',
      sourceEntity: 'projects',
      targetEntity: 'tasks',
      predicate: { op: 'eq', args: [{ op: 'var', args: ['name'] }, 'MyProject'] } as any,
      includeCompleted: true,
    };
    const plan = lowerStrategy(strategy);

    // Source elements should use FCfx (flattenedProject)
    assertDocElements(getSpecifier(plan, 0), 'FCfx');

    // ForEach body should reference FCft for target tasks
    const forEachNodes = findNodes(plan, 'ForEach');
    assert.ok(forEachNodes.length >= 1);

    const forEach = forEachNodes[0].node as Extract<EventNode, { kind: 'ForEach' }>;
    const bodyElementGets = forEach.body.filter(n => {
      if (n.kind !== 'Get') return false;
      const spec = (n as Extract<EventNode, { kind: 'Get' }>).specifier;
      return spec.kind === 'Elements';
    });
    assert.ok(bodyElementGets.length >= 1);
    const targetSpec = (bodyElementGets[0] as Extract<EventNode, { kind: 'Get' }>).specifier;
    assert.equal((targetSpec as Extract<Specifier, { kind: 'Elements' }>).classCode, 'FCft');
  });

  it('folders→projects uses FCff for source and FCfx for target', () => {
    const strategy: StrategyNode = {
      kind: 'MembershipScan',
      sourceEntity: 'folders',
      targetEntity: 'projects',
      predicate: { op: 'eq', args: [{ op: 'var', args: ['name'] }, 'Legal'] } as any,
      includeCompleted: true,
    };
    const plan = lowerStrategy(strategy);

    // Source: flattenedFolder = FCff
    assertDocElements(getSpecifier(plan, 0), 'FCff');

    // Target in ForEach body: flattenedProject = FCfx
    const forEachNodes = findNodes(plan, 'ForEach');
    assert.ok(forEachNodes.length >= 1);

    const forEach = forEachNodes[0].node as Extract<EventNode, { kind: 'ForEach' }>;
    const bodyElementGets = forEach.body.filter(n => {
      if (n.kind !== 'Get') return false;
      const spec = (n as Extract<EventNode, { kind: 'Get' }>).specifier;
      return spec.kind === 'Elements';
    });
    assert.ok(bodyElementGets.length >= 1);
    const targetSpec = (bodyElementGets[0] as Extract<EventNode, { kind: 'Get' }>).specifier;
    assert.equal((targetSpec as Extract<Specifier, { kind: 'Elements' }>).classCode, 'FCfx');
  });

  it('MembershipScan with includeCompleted:false filters target items', () => {
    const strategy: StrategyNode = {
      kind: 'MembershipScan',
      sourceEntity: 'tags',
      targetEntity: 'tasks',
      predicate: { op: 'eq', args: [{ op: 'var', args: ['name'] }, 'Work'] } as any,
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    // With includeCompleted:false, the plan should filter out completed/dropped
    // target items. This could be inside the ForEach body or after the ForEach,
    // but there must be some active-item filtering.
    // We just verify a Filter exists somewhere in the plan.
    const filterNodes = findNodes(plan, 'Filter');
    assert.ok(filterNodes.length >= 1, 'Should have a Filter for active items');
  });
});

// ── Regression: active filter variable availability ─────────────────────
//
// When includeCompleted:false, the active filter predicate references
// variables (effectivelyCompleted/effectivelyDropped for tasks, status for
// projects, etc.) that must be present in the Zip'd rows. If the user's
// select columns don't include them, the lowering pass must inject them
// as additional bulk-read Property nodes fed into the Zip.
//
// Without this, the Filter evaluates `row.effectivelyCompleted` as
// undefined, and `!undefined` is truthy — silently including all rows
// instead of filtering completed/dropped items.

describe('lowerStrategy — active filter variables in Zip', () => {

  it('tasks: Zip includes effectivelyCompleted and effectivelyDropped when includeCompleted:false', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['id', 'name'],  // user only selected id and name
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    // Find the Zip node
    const zips = findNodes(plan, 'Zip');
    assert.equal(zips.length, 1, 'should have exactly one Zip');
    const zip = zips[0].node as Extract<EventNode, { kind: 'Zip' }>;

    const colNames = zip.columns.map(c => c.name);
    assert.ok(
      colNames.includes('effectivelyCompleted'),
      `Zip columns should include effectivelyCompleted for active filter, got: [${colNames.join(', ')}]`,
    );
    assert.ok(
      colNames.includes('effectivelyDropped'),
      `Zip columns should include effectivelyDropped for active filter, got: [${colNames.join(', ')}]`,
    );
  });

  it('tasks: no extra columns when includeCompleted:true', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['id', 'name'],
      includeCompleted: true,
    };
    const plan = lowerStrategy(strategy);

    const zips = findNodes(plan, 'Zip');
    assert.equal(zips.length, 1);
    const zip = zips[0].node as Extract<EventNode, { kind: 'Zip' }>;

    const colNames = zip.columns.map(c => c.name);
    assert.deepEqual(colNames, ['id', 'name'], 'no extra columns when includeCompleted:true');
  });

  it('projects: Zip includes status when includeCompleted:false', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'projects',
      columns: ['id', 'name'],
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    const zips = findNodes(plan, 'Zip');
    assert.equal(zips.length, 1);
    const zip = zips[0].node as Extract<EventNode, { kind: 'Zip' }>;

    const colNames = zip.columns.map(c => c.name);
    assert.ok(
      colNames.includes('status'),
      `Zip columns should include status for project active filter, got: [${colNames.join(', ')}]`,
    );
  });

  it('tags: Zip includes effectivelyHidden when includeCompleted:false', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tags',
      columns: ['id', 'name'],
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    const zips = findNodes(plan, 'Zip');
    assert.equal(zips.length, 1);
    const zip = zips[0].node as Extract<EventNode, { kind: 'Zip' }>;

    const colNames = zip.columns.map(c => c.name);
    assert.ok(
      colNames.includes('effectivelyHidden'),
      `Zip columns should include effectivelyHidden for tag active filter, got: [${colNames.join(', ')}]`,
    );
  });

  it('folders: no active filter vars added (legacy has no folder active filter)', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'folders',
      columns: ['id', 'name'],
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    const zips = findNodes(plan, 'Zip');
    assert.equal(zips.length, 1);
    const zip = zips[0].node as Extract<EventNode, { kind: 'Zip' }>;

    // Folders have no active filter, so no extra columns should be injected
    const colNames = zip.columns.map(c => c.name);
    assert.deepEqual(colNames, ['id', 'name'], 'no extra active filter columns for folders');

    // No Filter node should be emitted for folders
    const filters = findNodes(plan, 'Filter');
    assert.equal(filters.length, 0, 'no Filter for folders when no active filter');
  });

  it('tasks: does not duplicate columns already in the select list', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['id', 'name', 'effectivelyCompleted', 'effectivelyDropped'],
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    const zips = findNodes(plan, 'Zip');
    assert.equal(zips.length, 1);
    const zip = zips[0].node as Extract<EventNode, { kind: 'Zip' }>;

    const colNames = zip.columns.map(c => c.name);
    // Should not have duplicates
    const unique = new Set(colNames);
    assert.equal(colNames.length, unique.size, `no duplicate columns: [${colNames.join(', ')}]`);
  });
});

// ── Identity filter elimination in lowering ──────────────────────────────

describe('lowerStrategy — identity filter elimination', () => {

  it('Filter(source, true) does not emit a Filter node', () => {
    const strategy: StrategyNode = {
      kind: 'Filter',
      source: {
        kind: 'BulkScan',
        entity: 'tasks',
        columns: ['id', 'name'],
        includeCompleted: true,
      },
      predicate: true,
      entity: 'tasks',
    };
    const plan = lowerStrategy(strategy);

    // The plan should have no EventPlan Filter node — the identity filter
    // was eliminated by the lowering guard.
    const filters = findNodes(plan, 'Filter');
    assert.equal(filters.length, 0, 'Identity Filter(source, true) should be eliminated in lowering');
  });

  it('PreFilter(source, true) does not emit a Filter node', () => {
    const strategy: StrategyNode = {
      kind: 'PreFilter',
      source: {
        kind: 'BulkScan',
        entity: 'tasks',
        columns: ['id', 'name'],
        includeCompleted: true,
      },
      predicate: true,
      entity: 'tasks',
      assumeTrue: new Set(['flagged']),
    };
    const plan = lowerStrategy(strategy);

    // The plan should have no EventPlan Filter node — the identity filter
    // was eliminated by the lowering guard.
    const filters = findNodes(plan, 'Filter');
    assert.equal(filters.length, 0, 'Identity PreFilter(source, true) should be eliminated in lowering');
  });

  it('Filter(source, null) does not emit a Filter node', () => {
    const strategy: StrategyNode = {
      kind: 'Filter',
      source: {
        kind: 'BulkScan',
        entity: 'tasks',
        columns: ['id', 'name'],
        includeCompleted: true,
      },
      predicate: null,
      entity: 'tasks',
    };
    const plan = lowerStrategy(strategy);

    const filters = findNodes(plan, 'Filter');
    assert.equal(filters.length, 0, 'Identity Filter(source, null) should be eliminated in lowering');
  });

  it('PreFilter(source, null) does not emit a Filter node', () => {
    const strategy: StrategyNode = {
      kind: 'PreFilter',
      source: {
        kind: 'BulkScan',
        entity: 'tasks',
        columns: ['id', 'name'],
        includeCompleted: true,
      },
      predicate: null,
      entity: 'tasks',
      assumeTrue: new Set(['flagged']),
    };
    const plan = lowerStrategy(strategy);

    const filters = findNodes(plan, 'Filter');
    assert.equal(filters.length, 0, 'Identity PreFilter(source, null) should be eliminated in lowering');
  });
});

// ── Regression: Filter nodes carry entity field (#22) ────────────────────
//
// Filter nodes emitted by lowerStrategy must carry the entity field so
// that nodeUnit can compile the predicate against the correct entity's
// variable registry. Without entity, the nodeEval backend doesn't know
// which variable set to use and fails with "Unknown variable X for entity Y".

describe('lowerStrategy — Filter nodes carry entity field', () => {

  it('BulkScan active filter carries entity for tasks', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name'],
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    const { node: filterNode } = findOne(plan, 'Filter');
    const filter = filterNode as Extract<EventNode, { kind: 'Filter' }>;
    assert.equal(filter.entity, 'tasks', 'active filter should carry entity: tasks');
  });

  it('BulkScan active filter carries entity for projects', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'projects',
      columns: ['name'],
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    const { node: filterNode } = findOne(plan, 'Filter');
    const filter = filterNode as Extract<EventNode, { kind: 'Filter' }>;
    assert.equal(filter.entity, 'projects', 'active filter should carry entity: projects');
  });

  it('BulkScan active filter carries entity for tags', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tags',
      columns: ['name'],
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    const { node: filterNode } = findOne(plan, 'Filter');
    const filter = filterNode as Extract<EventNode, { kind: 'Filter' }>;
    assert.equal(filter.entity, 'tags', 'active filter should carry entity: tags');
  });

  it('Strategy Filter node passes entity through to EventPlan Filter', () => {
    const strategy: StrategyNode = {
      kind: 'Filter',
      source: {
        kind: 'BulkScan',
        entity: 'projects',
        columns: ['name', 'status'],
        includeCompleted: true,
      },
      predicate: { op: 'eq', args: [{ var: 'status' }, 'Active'] } as any,
      entity: 'projects',
    };
    const plan = lowerStrategy(strategy);

    const filters = findNodes(plan, 'Filter');
    assert.ok(filters.length >= 1, 'should have at least one Filter');
    // The user-specified Filter (not the active filter) should carry entity
    const userFilter = filters[filters.length - 1];
    const filter = userFilter.node as Extract<EventNode, { kind: 'Filter' }>;
    assert.equal(filter.entity, 'projects', 'user Filter should carry entity: projects');
  });

  it('FallbackScan Filter carries entity', () => {
    const strategy: StrategyNode = {
      kind: 'FallbackScan',
      entity: 'tasks',
      filterAst: { op: 'var', args: ['flagged'] } as any,
      includeCompleted: true,
    };
    const plan = lowerStrategy(strategy);

    const { node: filterNode } = findOne(plan, 'Filter');
    const filter = filterNode as Extract<EventNode, { kind: 'Filter' }>;
    assert.equal(filter.entity, 'tasks', 'FallbackScan filter should carry entity: tasks');
  });

  it('PreFilter passes entity through to EventPlan Filter', () => {
    const strategy: StrategyNode = {
      kind: 'PreFilter',
      source: {
        kind: 'BulkScan',
        entity: 'tags',
        columns: ['name'],
        includeCompleted: true,
      },
      predicate: { op: 'eq', args: [{ var: 'name' }, 'Work'] } as any,
      entity: 'tags',
      assumeTrue: new Set(['name']),
    };
    const plan = lowerStrategy(strategy);

    const filters = findNodes(plan, 'Filter');
    assert.ok(filters.length >= 1, 'should have at least one Filter');
    const filter = filters[filters.length - 1].node as Extract<EventNode, { kind: 'Filter' }>;
    assert.equal(filter.entity, 'tags', 'PreFilter should carry entity: tags');
  });
});

// ── Regression: tasks active filter uses effectivelyCompleted/effectivelyDropped (#30) ──
//
// The task active filter must reference `effectivelyCompleted` and
// `effectivelyDropped` (which propagate from parent tasks/projects),
// NOT `completed` / `dropped` (direct boolean properties). The
// "effectively" variants match OmniFocus's active-task behavior:
// a task in a dropped project has effectivelyDropped:true even if its
// own dropped flag is false.

describe('lowerStrategy — tasks active filter uses correct variables', () => {

  it('tasks active filter predicate uses effectivelyCompleted and effectivelyDropped', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name'],
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    const { node: filterNode } = findOne(plan, 'Filter');
    const filter = filterNode as Extract<EventNode, { kind: 'Filter' }>;
    const pred = filter.predicate as any;

    // Extract all {var} references from the predicate tree
    const vars: string[] = [];
    function collectVars(expr: any): void {
      if (expr && typeof expr === 'object') {
        if ('var' in expr) vars.push(expr.var);
        if (expr.args) for (const a of expr.args) collectVars(a);
      }
    }
    collectVars(pred);

    assert.ok(vars.includes('effectivelyCompleted'), 'should reference effectivelyCompleted');
    assert.ok(vars.includes('effectivelyDropped'), 'should reference effectivelyDropped');
    assert.ok(!vars.includes('completed'),
      'must NOT reference completed — use effectivelyCompleted instead');
    assert.ok(!vars.includes('dropped'),
      'must NOT reference dropped — use effectivelyDropped instead');
  });

  it('tasks active filter Zip columns include effectivelyCompleted and effectivelyDropped, not completed/dropped', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name'],
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    const zips = findNodes(plan, 'Zip');
    assert.equal(zips.length, 1, 'should have exactly one Zip');
    const zip = zips[0].node as Extract<EventNode, { kind: 'Zip' }>;
    const colNames = zip.columns.map(c => c.name);

    assert.ok(colNames.includes('effectivelyCompleted'), 'Zip should include effectivelyCompleted column');
    assert.ok(colNames.includes('effectivelyDropped'), 'Zip should include effectivelyDropped column');
    assert.ok(!colNames.includes('completed'),
      'Zip must NOT include completed');
    assert.ok(!colNames.includes('dropped'),
      'Zip must NOT include dropped');
  });

  it('projects active filter uses status (not completed/dropped)', () => {
    const strategy: StrategyNode = {
      kind: 'BulkScan',
      entity: 'projects',
      columns: ['name'],
      includeCompleted: false,
    };
    const plan = lowerStrategy(strategy);

    const { node: filterNode } = findOne(plan, 'Filter');
    const filter = filterNode as Extract<EventNode, { kind: 'Filter' }>;
    const pred = filter.predicate as any;

    // Project active filter is {op:'in', args:[{var:'status'}, ['Active','OnHold']]}
    const vars: string[] = [];
    function collectVars(expr: any): void {
      if (expr && typeof expr === 'object') {
        if ('var' in expr) vars.push(expr.var);
        if (expr.args) for (const a of expr.args) collectVars(a);
      }
    }
    collectVars(pred);

    assert.ok(vars.includes('status'), 'projects active filter should reference status');
    assert.ok(!vars.includes('completed'),
      'projects active filter should not reference completed');
  });
});

// ── Entity class code mapping ────────────────────────────────────────────

describe('lowerStrategy — entity class code mapping', () => {

  const entityClassCodes: Array<{ entity: string; classCode: string }> = [
    { entity: 'tasks',    classCode: 'FCft' },
    { entity: 'projects', classCode: 'FCfx' },
    { entity: 'folders',  classCode: 'FCff' },
    { entity: 'tags',     classCode: 'FCfc' },
  ];

  for (const { entity, classCode } of entityClassCodes) {
    it(`${entity} → Elements classCode ${classCode}`, () => {
      const strategy: StrategyNode = {
        kind: 'BulkScan',
        entity: entity as any,
        columns: ['name'],
        includeCompleted: true,
      };
      const plan = lowerStrategy(strategy);
      assertDocElements(getSpecifier(plan, 0), classCode);
    });
  }
});
