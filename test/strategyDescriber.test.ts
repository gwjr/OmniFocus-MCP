import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeStrategyNode } from '../dist/tools/query/strategyDescriber.js';
import type { StrategyNode } from '../dist/tools/query/strategy.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const bulkScan: StrategyNode = {
  kind: 'BulkScan',
  entity: 'tasks',
  columns: ['id', 'name', 'flagged'],
  includeCompleted: false,
};

const fallbackScan: StrategyNode = {
  kind: 'FallbackScan',
  entity: 'tasks',
  filterAst: { op: 'eq', args: [{ var: 'flagged' }, true] },
  includeCompleted: false,
};

const membershipScan: StrategyNode = {
  kind: 'MembershipScan',
  sourceEntity: 'tags',
  targetEntity: 'tasks',
  predicate: { op: 'eq', args: [{ var: 'name' }, 'work'] },
  includeCompleted: false,
};

// ── Smoke tests ──────────────────────────────────────────────────────────

describe('describeStrategyNode — leaf nodes', () => {

  it('describes BulkScan', () => {
    const output = describeStrategyNode(bulkScan);
    assert.ok(output.includes('BulkScan tasks'));
    assert.ok(output.includes('id, name, flagged'));
  });

  it('describes BulkScan with projectScope', () => {
    const scoped: StrategyNode = {
      ...bulkScan,
      projectScope: { op: 'contains', args: [{ var: 'name' }, 'PHS'] },
    };
    const output = describeStrategyNode(scoped);
    assert.ok(output.includes('scope:'));
  });

  it('describes FallbackScan', () => {
    const output = describeStrategyNode(fallbackScan);
    assert.ok(output.includes('FallbackScan tasks'));
  });

  it('describes MembershipScan', () => {
    const output = describeStrategyNode(membershipScan);
    assert.ok(output.includes('MembershipScan'));
    assert.ok(output.includes('tags'));
    assert.ok(output.includes('tasks'));
  });
});

describe('describeStrategyNode — unary transforms', () => {

  it('describes Filter', () => {
    const node: StrategyNode = {
      kind: 'Filter',
      source: bulkScan,
      predicate: { op: 'eq', args: [{ var: 'flagged' }, true] },
      entity: 'tasks',
    };
    const output = describeStrategyNode(node);
    assert.ok(output.includes('Filter'));
    assert.ok(output.includes('BulkScan'), 'should include child');
  });

  it('describes PreFilter', () => {
    const node: StrategyNode = {
      kind: 'PreFilter',
      source: bulkScan,
      predicate: { op: 'eq', args: [{ var: 'flagged' }, true] },
      entity: 'tasks',
      assumeTrue: new Set(['flagged']),
    };
    const output = describeStrategyNode(node);
    assert.ok(output.includes('PreFilter'));
    assert.ok(output.includes('assumeTrue:[flagged]'));
  });

  it('describes PerItemEnrich', () => {
    const node: StrategyNode = {
      kind: 'PerItemEnrich',
      source: bulkScan,
      perItemVars: new Set(['note']),
      entity: 'tasks',
      threshold: 100,
      fallback: fallbackScan,
    };
    const output = describeStrategyNode(node);
    assert.ok(output.includes('PerItemEnrich'));
    assert.ok(output.includes('note'));
    // Should include both source and fallback children
    assert.ok(output.includes('BulkScan'));
    assert.ok(output.includes('FallbackScan'));
  });

  it('describes Sort', () => {
    const node: StrategyNode = {
      kind: 'Sort',
      source: bulkScan,
      by: 'dueDate',
      direction: 'asc',
      entity: 'tasks',
    };
    const output = describeStrategyNode(node);
    assert.ok(output.includes('Sort by:dueDate asc'));
  });

  it('describes Limit', () => {
    const node: StrategyNode = {
      kind: 'Limit',
      source: bulkScan,
      count: 10,
    };
    const output = describeStrategyNode(node);
    assert.ok(output.includes('Limit 10'));
  });

  it('describes Project', () => {
    const node: StrategyNode = {
      kind: 'Project',
      source: bulkScan,
      fields: ['id', 'name'],
    };
    const output = describeStrategyNode(node);
    assert.ok(output.includes('Project [id, name]'));
  });
});

describe('describeStrategyNode — binary nodes', () => {

  it('describes SemiJoin', () => {
    const node: StrategyNode = {
      kind: 'SemiJoin',
      source: bulkScan,
      lookup: membershipScan,
    };
    const output = describeStrategyNode(node);
    assert.ok(output.includes('SemiJoin'));
    assert.ok(output.includes('BulkScan'));
    assert.ok(output.includes('MembershipScan'));
  });

  it('describes CrossEntityJoin', () => {
    const folderScan: StrategyNode = {
      kind: 'BulkScan',
      entity: 'folders',
      columns: ['id', 'name'],
      includeCompleted: false,
    };
    const node: StrategyNode = {
      kind: 'CrossEntityJoin',
      source: bulkScan,
      lookup: folderScan,
      sourceKey: 'folderId',
      lookupKey: 'id',
      fieldMap: { name: 'folderName' },
    };
    const output = describeStrategyNode(node);
    assert.ok(output.includes('CrossEntityJoin'));
    assert.ok(output.includes('sourceKey:folderId'));
    assert.ok(output.includes('lookupKey:id'));
  });
});

describe('describeStrategyNode — indentation', () => {

  it('indents nested nodes', () => {
    const node: StrategyNode = {
      kind: 'Limit',
      source: {
        kind: 'Sort',
        source: {
          kind: 'Filter',
          source: bulkScan,
          predicate: { op: 'eq', args: [{ var: 'flagged' }, true] },
          entity: 'tasks',
        },
        by: 'dueDate',
        direction: 'asc',
        entity: 'tasks',
      },
      count: 10,
    };
    const output = describeStrategyNode(node);
    const lines = output.split('\n');
    // Limit at indent 0, Sort at indent 2, Filter at indent 4, BulkScan at indent 6
    assert.ok(lines[0].startsWith('Limit'), 'top level should not be indented');
    assert.ok(lines[1].startsWith('  Sort'), 'Sort should be indented 2');
    assert.ok(lines[2].startsWith('    Filter'), 'Filter should be indented 4');
    assert.ok(lines[3].startsWith('      BulkScan'), 'BulkScan should be indented 6');
  });
});
