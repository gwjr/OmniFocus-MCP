import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JxaEmitter } from '../dist/tools/query/emitters/jxaEmitter.js';
import { compileQuery } from '../dist/tools/query/compile.js';
import { lowerExpr } from '../dist/tools/query/lower.js';
import { buildPlanTree } from '../dist/tools/query/planner.js';
import { optimize, walkPlan } from '../dist/tools/query/strategy.js';
import { tagSemiJoinPass } from '../dist/tools/query/optimizations/tagSemiJoin.js';
import { normalizePass } from '../dist/tools/query/optimizations/normalize.js';
import { crossEntityJoinPass } from '../dist/tools/query/optimizations/crossEntityJoin.js';
import { selfJoinEliminationPass } from '../dist/tools/query/optimizations/selfJoinElimination.js';
import type { StrategyNode, BulkScan, MembershipScan } from '../dist/tools/query/strategy.js';
import type { LoweredExpr } from '../dist/tools/query/fold.js';

const emitter = new JxaEmitter();
const PASSES = [tagSemiJoinPass, crossEntityJoinPass, selfJoinEliminationPass, normalizePass];

// ── Helpers ──────────────────────────────────────────────────────────────

function lower(where: unknown): LoweredExpr {
  return (where != null ? lowerExpr(where) : true) as LoweredExpr;
}

function plan(where: unknown, entity: string = 'tasks', select?: string[]) {
  const ast = lower(where);
  return buildPlanTree(ast, entity as any, select, false);
}

function optimizedPlan(where: unknown, entity: string = 'tasks', select?: string[]) {
  return optimize(plan(where, entity, select), PASSES);
}

function findNode(tree: StrategyNode, kind: string): StrategyNode | null {
  let found: StrategyNode | null = null;
  walkPlan(tree, n => {
    if (n.kind === kind) found = n;
    return n;
  });
  return found;
}

// ── JxaEmitter.propertyScan ──────────────────────────────────────────────

describe('JxaEmitter.propertyScan', () => {
  it('produces body with return rows (no JSON.stringify, no var app)', () => {
    const node: BulkScan = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name', 'flagged'],
      includeCompleted: false,
    };
    const frag = emitter.propertyScan(node);
    assert.equal(frag.resultType, 'rows');
    assert.ok(frag.body.includes('return rows;'), 'should end with return rows');
    assert.ok(!frag.body.includes('JSON.stringify'), 'should not contain JSON.stringify');
    assert.ok(!frag.body.includes('var app'), 'should not contain var app');
  });

  it('includes alignment check', () => {
    const node: BulkScan = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name', 'flagged'],
      includeCompleted: false,
    };
    const frag = emitter.propertyScan(node);
    assert.ok(frag.body.includes('alignment'), 'should contain alignment check');
  });

  it('includes active filter for tasks', () => {
    const node: BulkScan = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name'],
      includeCompleted: false,
    };
    const frag = emitter.propertyScan(node);
    assert.ok(frag.body.includes('activeIndices'), 'should filter active items');
  });

  it('omits active filter when includeCompleted (project exclusion still applies)', () => {
    const node: BulkScan = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name'],
      includeCompleted: true,
    };
    const frag = emitter.propertyScan(node);
    // Task entities always use activeIndices for project exclusion, even
    // without an active filter. Check that the completed/dropped filter
    // is absent but project exclusion is present.
    assert.ok(!frag.body.includes('!_fa0[j]'), 'should not have completed filter');
    assert.ok(frag.body.includes('_projIdSet'), 'should have project exclusion');
  });

  it('includes chain properties', () => {
    const node: BulkScan = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name', 'projectName'],
      includeCompleted: false,
    };
    const frag = emitter.propertyScan(node);
    assert.ok(frag.body.includes('containingProject.name'), 'should include chain accessor');
  });

  it('includes project scope when present', () => {
    const node: BulkScan = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name'],
      projectScope: { op: 'eq', args: [{ var: 'name' }, 'PHS'] },
      includeCompleted: false,
    };
    const frag = emitter.propertyScan(node);
    assert.ok(frag.body.includes('flattenedProjects.whose'), 'should scope to project');
  });

  it('handles id column', () => {
    const node: BulkScan = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name', 'id'],
      includeCompleted: false,
    };
    const frag = emitter.propertyScan(node);
    assert.ok(frag.body.includes('idKeys'), 'should include id key mapping');
  });
});

// ── JxaEmitter.membershipLookup ──────────────────────────────────────────

describe('JxaEmitter.membershipLookup', () => {
  it('produces body with return ids (no JSON.stringify, no var app)', () => {
    const node: MembershipScan = {
      kind: 'MembershipScan',
      sourceEntity: 'tags',
      targetEntity: 'tasks',
      predicate: { op: 'eq', args: [{ var: 'name' }, 'waiting'] },
      includeCompleted: false,
    };
    const frag = emitter.membershipLookup(node);
    assert.equal(frag.resultType, 'idSet');
    assert.ok(frag.body.includes('return ids;'), 'should end with return ids');
    assert.ok(!frag.body.includes('JSON.stringify'), 'should not contain JSON.stringify');
    assert.ok(!frag.body.includes('var app'), 'should not contain var app');
  });

  it('includes whose lookup for tag name', () => {
    const node: MembershipScan = {
      kind: 'MembershipScan',
      sourceEntity: 'tags',
      targetEntity: 'tasks',
      predicate: { op: 'eq', args: [{ var: 'name' }, 'waiting'] },
      includeCompleted: false,
    };
    const frag = emitter.membershipLookup(node);
    assert.ok(frag.body.includes('.whose({name: "waiting"})'), 'should lookup by tag name');
  });

  it('includes active filter on target entity', () => {
    const node: MembershipScan = {
      kind: 'MembershipScan',
      sourceEntity: 'tags',
      targetEntity: 'tasks',
      predicate: { op: 'eq', args: [{ var: 'name' }, 'work'] },
      includeCompleted: false,
    };
    const frag = emitter.membershipLookup(node);
    assert.ok(frag.body.includes('completed'), 'should filter completed tasks');
  });
});

// ── JxaEmitter.perItemRead ───────────────────────────────────────────────

describe('JxaEmitter.perItemRead', () => {
  it('produces body with return results', () => {
    const frag = emitter.perItemRead(['id1', 'id2'], new Set(['tags']), 'tasks');
    assert.equal(frag.resultType, 'rows');
    assert.ok(frag.body.includes('return results;'), 'should end with return results');
    assert.ok(!frag.body.includes('JSON.stringify'), 'should not contain JSON.stringify');
    assert.ok(!frag.body.includes('var app'), 'should not contain var app');
  });

  it('includes per-item accessor for tags', () => {
    const frag = emitter.perItemRead(['id1'], new Set(['tags']), 'tasks');
    assert.ok(frag.body.includes('item.tags()'), 'should include tags accessor');
  });
});

// ── JxaEmitter.wrapStandalone ────────────────────────────────────────────

describe('JxaEmitter.wrapStandalone', () => {
  it('wraps with IIFE, app/doc setup, and JSON.stringify', () => {
    const frag = { body: '  return [1, 2, 3];', resultType: 'rows' as const };
    const script = emitter.wrapStandalone(frag);
    assert.ok(script.startsWith('(function()'), 'should start with IIFE');
    assert.ok(script.includes("var app = Application('OmniFocus')"), 'should setup app');
    assert.ok(script.includes('var doc = app.defaultDocument'), 'should setup doc');
    assert.ok(script.includes('JSON.stringify'), 'should JSON.stringify the result');
    assert.ok(script.endsWith('})()'), 'should end with IIFE invocation');
  });
});

// ── JxaEmitter.wrapComposite ─────────────────────────────────────────────

describe('JxaEmitter.wrapComposite', () => {
  it('fuses 2 fragments into composite script with shared preamble', () => {
    const frag0 = { body: '  var x = 1;\n  return [x];', resultType: 'rows' as const };
    const frag1 = { body: '  var y = 2;\n  return [y];', resultType: 'idSet' as const };
    const script = emitter.wrapComposite([frag0, frag1]);

    assert.ok(script.includes("var app = Application('OmniFocus')"), 'shared app setup');
    assert.ok(script.includes('var _r = []'), 'result array');
    assert.ok(script.includes('_r[0]'), 'slot 0');
    assert.ok(script.includes('_r[1]'), 'slot 1');
    assert.ok(script.includes('JSON.stringify(_r)'), 'stringifies array');

    // Each fragment in its own IIFE for variable isolation
    const iifeCount = (script.match(/\(function\(\)/g) || []).length;
    assert.ok(iifeCount >= 3, 'should have outer + 2 inner IIFEs');
  });

  it('fuses 3 fragments', () => {
    const frags = [
      { body: '  return [];', resultType: 'rows' as const },
      { body: '  return [];', resultType: 'idSet' as const },
      { body: '  return [];', resultType: 'rows' as const },
    ];
    const script = emitter.wrapComposite(frags);
    assert.ok(script.includes('_r[0]'), 'slot 0');
    assert.ok(script.includes('_r[1]'), 'slot 1');
    assert.ok(script.includes('_r[2]'), 'slot 2');
  });
});

// ── Backward Compatibility ──────────────────────────────────────────────

describe('backward compatibility', () => {
  it('generateBulkReadFromColumns produces same structure as before', async () => {
    const { generateBulkReadFromColumns } = await import('../dist/tools/query/jxaBulkRead.js');
    const node: BulkScan = {
      kind: 'BulkScan',
      entity: 'tasks',
      columns: ['name', 'flagged'],
      includeCompleted: false,
    };
    const script = generateBulkReadFromColumns(node);
    // Should be a complete standalone script
    assert.ok(script.startsWith('(function()'), 'should be IIFE');
    assert.ok(script.includes("var app = Application('OmniFocus')"), 'should have app setup');
    assert.ok(script.includes('JSON.stringify'), 'should JSON.stringify');
    assert.ok(script.includes('nameArr'), 'should bulk-read name');
    assert.ok(script.includes('flaggedArr'), 'should bulk-read flagged');
  });

  it('generateMembershipScript produces same structure as before', async () => {
    const { generateMembershipScript } = await import('../dist/tools/query/jxaBulkRead.js');
    const node: MembershipScan = {
      kind: 'MembershipScan',
      sourceEntity: 'tags',
      targetEntity: 'tasks',
      predicate: { op: 'eq', args: [{ var: 'name' }, 'waiting'] },
      includeCompleted: false,
    };
    const script = generateMembershipScript(node);
    assert.ok(script.startsWith('(function()'), 'should be IIFE');
    assert.ok(script.includes("var app = Application('OmniFocus')"), 'should have app setup');
    assert.ok(script.includes('JSON.stringify'), 'should JSON.stringify');
    assert.ok(script.includes('.whose({name: "waiting"})'), 'should lookup tag');
  });

  it('generatePerItemReadScript produces same structure as before', async () => {
    const { generatePerItemReadScript } = await import('../dist/tools/query/jxaBulkRead.js');
    const script = generatePerItemReadScript(['id1'], new Set(['tags']), 'tasks');
    assert.ok(script.startsWith('(function()'), 'should be IIFE');
    assert.ok(script.includes("var app = Application('OmniFocus')"), 'should have app setup');
    assert.ok(script.includes('JSON.stringify'), 'should JSON.stringify');
    assert.ok(script.includes('.whose({id:'), 'should lookup by id');
  });
});

// ── compileQuery ─────────────────────────────────────────────────────────

describe('compileQuery', () => {
  it('broad path (1 BulkScan) → standaloneScript, 1 slot', () => {
    const tree = optimizedPlan(undefined);
    const compiled = compileQuery(tree, emitter);

    assert.equal(compiled.batchScript, null, 'no batch for single leaf');
    assert.ok(compiled.standaloneScript, 'should have standalone script');
    assert.equal(compiled.slotMap.size, 1, 'should have 1 slot');
    assert.equal(compiled.root, tree, 'should preserve root');

    // The single entry should be the BulkScan
    const [node, entry] = [...compiled.slotMap.entries()][0];
    assert.equal(node.kind, 'BulkScan');
    assert.equal(entry.index, 0);
    assert.equal(entry.resultType, 'rows');
  });

  it('CrossEntityJoin (2 BulkScans from different entities) → batchScript, 2 slots', () => {
    const tree = optimizedPlan(undefined, 'projects', ['name', 'status', 'folderName']);
    const compiled = compileQuery(tree, emitter);

    assert.ok(compiled.batchScript, 'should have batch script');
    assert.equal(compiled.standaloneScript, null, 'no standalone for multi-leaf');
    assert.equal(compiled.slotMap.size, 2, 'should have 2 slots');

    // Check slot types — both BulkScan but for different entities
    const entries = [...compiled.slotMap.entries()];
    assert.ok(entries.every(([n]) => n.kind === 'BulkScan'), 'both should be BulkScan');
  });

  it('OmniJS-only (0 JXA leaves) → no scripts, empty slotMap', () => {
    const tree = optimizedPlan(undefined, 'perspectives');
    const compiled = compileQuery(tree, emitter);

    assert.equal(compiled.batchScript, null);
    assert.equal(compiled.standaloneScript, null);
    assert.equal(compiled.slotMap.size, 0);
  });

  it('does not collect leaves inside PerItemEnrich fallback', () => {
    // projects.folderName is per-item → two-phase with PerItemEnrich
    // crossEntityJoinPass resolves it, but raw plan (before optimization) has PerItemEnrich
    const rawTree = plan(
      { contains: [{ var: 'name' }, 'Legal'] },
      'projects',
      ['name', 'folderName']
    );

    // Should have PerItemEnrich with BulkScan source and FallbackScan fallback
    const enrich = findNode(rawTree, 'PerItemEnrich');
    assert.ok(enrich, 'should have PerItemEnrich');

    const compiled = compileQuery(rawTree, emitter);

    // The source BulkScan should be in slotMap
    assert.equal(compiled.slotMap.size, 1, 'only source BulkScan, not fallback');
    const [node] = [...compiled.slotMap.keys()];
    assert.equal(node.kind, 'BulkScan');

    // Should be standalone (only 1 leaf)
    assert.ok(compiled.standaloneScript, 'should have standalone script');
    assert.equal(compiled.batchScript, null, 'no batch needed');
  });

  it('SelfJoinEnrich (1 BulkScan) → standaloneScript, 1 slot', () => {
    const tree = optimizedPlan(undefined, 'tags', ['name', 'parentName']);
    const compiled = compileQuery(tree, emitter);

    // SelfJoinEnrich eliminates the redundant BulkScan, so only 1 leaf
    assert.ok(compiled.standaloneScript, 'should have standalone script');
    assert.equal(compiled.slotMap.size, 1, 'should have 1 slot');
  });

  it('batch script is valid JXA structure', () => {
    // CrossEntityJoin produces a multi-leaf plan (2 BulkScans)
    const tree = optimizedPlan(undefined, 'projects', ['name', 'folderName']);
    const compiled = compileQuery(tree, emitter);

    assert.ok(compiled.batchScript);
    // Check structural properties
    assert.ok(compiled.batchScript.startsWith('(function()'), 'outer IIFE');
    assert.ok(compiled.batchScript.includes("var app = Application('OmniFocus')"), 'app setup');
    assert.ok(compiled.batchScript.includes('var _r = []'), 'result array');
    assert.ok(compiled.batchScript.includes('JSON.stringify(_r)'), 'stringify array');
    assert.ok(compiled.batchScript.includes('_r[0]'), 'slot 0');
    assert.ok(compiled.batchScript.includes('_r[1]'), 'slot 1');
  });

  it('slotMap preserves node identity', () => {
    const tree = optimizedPlan(undefined);
    const compiled = compileQuery(tree, emitter);

    // The BulkScan in slotMap should be the same object as in the tree
    const [slotNode] = [...compiled.slotMap.keys()];
    const treeScan = findNode(tree, 'BulkScan');
    assert.equal(slotNode, treeScan, 'should be same object reference');
  });
});
