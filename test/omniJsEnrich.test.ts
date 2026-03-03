/**
 * Unit tests for omniJsEnrich — OmniJS byIdentifier() enrichment utility.
 *
 * Tests script generation and column validation logic.
 * No OmniFocus process needed — these test the generated script text
 * and the accessor mapping, not actual execution.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateEnrichScript,
  canEnrichColumn,
  enrichableColumns,
} from '../dist/utils/omniJsEnrich.js';

// ── generateEnrichScript — basic structure ───────────────────────────────

describe('generateEnrichScript — basic structure', () => {
  it('generates a self-invoking function', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['name']);
    assert.ok(script.startsWith('(function()'), 'Should be a self-invoking function');
    assert.ok(script.endsWith('})()'), 'Should end with invocation');
  });

  it('embeds the ID array as JSON', () => {
    const script = generateEnrichScript('tasks', ['abc', 'def'], ['name']);
    assert.ok(script.includes('["abc","def"]'), 'Should contain the ID array as JSON');
  });

  it('uses the correct OmniJS class name for tasks', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['name']);
    assert.ok(script.includes('Task.byIdentifier'), 'Should use Task.byIdentifier');
  });

  it('uses the correct OmniJS class name for projects', () => {
    const script = generateEnrichScript('projects', ['id1'], ['name']);
    assert.ok(script.includes('Project.byIdentifier'), 'Should use Project.byIdentifier');
  });

  it('uses the correct OmniJS class name for folders', () => {
    const script = generateEnrichScript('folders', ['id1'], ['name']);
    assert.ok(script.includes('Folder.byIdentifier'), 'Should use Folder.byIdentifier');
  });

  it('uses the correct OmniJS class name for tags', () => {
    const script = generateEnrichScript('tags', ['id1'], ['name']);
    assert.ok(script.includes('Tag.byIdentifier'), 'Should use Tag.byIdentifier');
  });

  it('returns JSON.stringify of the output array', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['name']);
    assert.ok(script.includes('return JSON.stringify(_out)'), 'Should stringify output');
  });

  it('pushes null for items not found by byIdentifier', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['name']);
    assert.ok(script.includes('_out.push(null)'), 'Should push null for missing items');
  });
});

// ── generateEnrichScript — column accessors ──────────────────────────────

describe('generateEnrichScript — task column accessors', () => {
  it('maps id to _.id.primaryKey', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['id']);
    assert.ok(script.includes('_.id.primaryKey'), 'id should use primaryKey accessor');
  });

  it('maps name to simple property access', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['name']);
    assert.ok(script.includes('"name": _.name'), 'name should be a simple property');
  });

  it('maps dueDate to ISO date conversion', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['dueDate']);
    assert.ok(script.includes('.toISOString()'), 'dueDate should use toISOString()');
    assert.ok(script.includes('_.dueDate'), 'dueDate should access _.dueDate');
  });

  it('maps projectName to containingProject.name', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['projectName']);
    assert.ok(
      script.includes('containingProject') && script.includes('.name'),
      'projectName should access containingProject.name'
    );
  });

  it('maps projectId to containingProject.id.primaryKey', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['projectId']);
    assert.ok(
      script.includes('containingProject') && script.includes('id.primaryKey'),
      'projectId should access containingProject.id.primaryKey'
    );
  });

  it('maps tags to array of names', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['tags']);
    assert.ok(script.includes('.tags.map'), 'tags should map to tag names');
  });

  it('maps taskStatus to _tsName helper', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['taskStatus']);
    assert.ok(script.includes('_tsName'), 'taskStatus should use _tsName helper');
    assert.ok(script.includes('Task.Status.Completed'), 'Should define status enum mappings');
  });

  it('maps modificationDate to _.modified (OmniJS name)', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['modificationDate']);
    assert.ok(script.includes('_.modified'), 'modificationDate should map to _.modified');
  });

  it('maps creationDate to _.added (OmniJS name)', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['creationDate']);
    assert.ok(script.includes('_.added'), 'creationDate should map to _.added');
  });

  it('includes multiple columns in the output object', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['name', 'flagged', 'dueDate']);
    assert.ok(script.includes('"name"'), 'Should include name column');
    assert.ok(script.includes('"flagged"'), 'Should include flagged column');
    assert.ok(script.includes('"dueDate"'), 'Should include dueDate column');
  });
});

describe('generateEnrichScript — project column accessors', () => {
  it('maps status to _psName helper', () => {
    const script = generateEnrichScript('projects', ['id1'], ['status']);
    assert.ok(script.includes('_psName'), 'project status should use _psName helper');
    assert.ok(script.includes('Project.Status.Active'), 'Should define project status mappings');
  });

  it('maps folderId to parentFolder.id.primaryKey', () => {
    const script = generateEnrichScript('projects', ['id1'], ['folderId']);
    assert.ok(script.includes('parentFolder'), 'folderId should access parentFolder');
    assert.ok(script.includes('id.primaryKey'), 'Should use id.primaryKey');
  });

  it('maps folderName to parentFolder.name', () => {
    const script = generateEnrichScript('projects', ['id1'], ['folderName']);
    assert.ok(
      script.includes('parentFolder') && script.includes('.name'),
      'folderName should access parentFolder.name'
    );
  });
});

describe('generateEnrichScript — tag column accessors', () => {
  it('maps hidden to status check', () => {
    const script = generateEnrichScript('tags', ['id1'], ['hidden']);
    assert.ok(script.includes('Tag.Status.Active'), 'hidden should check tag status');
  });

  it('maps parentId to parent.id.primaryKey', () => {
    const script = generateEnrichScript('tags', ['id1'], ['parentId']);
    assert.ok(script.includes('_.parent'), 'parentId should access _.parent');
    assert.ok(script.includes('id.primaryKey'), 'Should use id.primaryKey');
  });

  it('maps parentName to parent.name', () => {
    const script = generateEnrichScript('tags', ['id1'], ['parentName']);
    assert.ok(
      script.includes('_.parent') && script.includes('.name'),
      'parentName should access parent.name'
    );
  });
});

describe('generateEnrichScript — folder column accessors', () => {
  it('maps parentFolderId to parent.id.primaryKey', () => {
    const script = generateEnrichScript('folders', ['id1'], ['parentFolderId']);
    assert.ok(script.includes('_.parent'), 'parentFolderId should access _.parent');
  });

  it('maps projectCount to flattenedProjects.length', () => {
    const script = generateEnrichScript('folders', ['id1'], ['projectCount']);
    assert.ok(script.includes('flattenedProjects.length'), 'projectCount should count projects');
  });
});

// ── generateEnrichScript — helper function inclusion ─────────────────────

describe('generateEnrichScript — helper functions', () => {
  it('includes _tsName only when taskStatus/status is requested for tasks', () => {
    const withStatus = generateEnrichScript('tasks', ['id1'], ['taskStatus']);
    assert.ok(withStatus.includes('function _tsName'), 'Should include _tsName');

    const withoutStatus = generateEnrichScript('tasks', ['id1'], ['name']);
    assert.ok(!withoutStatus.includes('function _tsName'), 'Should not include _tsName for name');
  });

  it('includes _psName only when status is requested for projects', () => {
    const withStatus = generateEnrichScript('projects', ['id1'], ['status']);
    assert.ok(withStatus.includes('function _psName'), 'Should include _psName');

    const withoutStatus = generateEnrichScript('projects', ['id1'], ['name']);
    assert.ok(!withoutStatus.includes('function _psName'), 'Should not include _psName for name');
  });

  it('does not include _tsName for project queries', () => {
    const script = generateEnrichScript('projects', ['id1'], ['status']);
    assert.ok(!script.includes('function _tsName'), 'Should not include _tsName for projects');
  });

  it('does not include _psName for task queries', () => {
    const script = generateEnrichScript('tasks', ['id1'], ['name']);
    assert.ok(!script.includes('function _psName'), 'Should not include _psName for tasks');
  });
});

// ── generateEnrichScript — error handling ────────────────────────────────

describe('generateEnrichScript — error handling', () => {
  it('throws for unsupported entity type', () => {
    assert.throws(
      () => generateEnrichScript('perspectives' as any, ['id1'], ['name']),
      /unsupported entity/,
      'Should throw for perspectives'
    );
  });

  it('throws for unknown column on tasks', () => {
    assert.throws(
      () => generateEnrichScript('tasks', ['id1'], ['nonExistentCol']),
      /no OmniJS accessor.*nonExistentCol/,
      'Should throw for unknown columns'
    );
  });

  it('throws listing all unknown columns', () => {
    assert.throws(
      () => generateEnrichScript('tasks', ['id1'], ['badCol1', 'name', 'badCol2']),
      /badCol1.*badCol2/,
      'Should list all missing columns'
    );
  });

  it('does not throw for valid columns', () => {
    assert.doesNotThrow(
      () => generateEnrichScript('tasks', ['id1'], ['name', 'flagged', 'dueDate']),
      'Should not throw for valid columns'
    );
  });
});

// ── canEnrichColumn ──────────────────────────────────────────────────────

describe('canEnrichColumn', () => {
  it('returns true for known task columns', () => {
    assert.ok(canEnrichColumn('tasks', 'name'));
    assert.ok(canEnrichColumn('tasks', 'dueDate'));
    assert.ok(canEnrichColumn('tasks', 'projectName'));
    assert.ok(canEnrichColumn('tasks', 'note'));
  });

  it('returns false for unknown task columns', () => {
    assert.ok(!canEnrichColumn('tasks', 'nonExistent'));
    assert.ok(!canEnrichColumn('tasks', 'now'));
  });

  it('returns true for known project columns', () => {
    assert.ok(canEnrichColumn('projects', 'name'));
    assert.ok(canEnrichColumn('projects', 'status'));
    assert.ok(canEnrichColumn('projects', 'folderName'));
  });

  it('returns false for perspectives', () => {
    assert.ok(!canEnrichColumn('perspectives', 'name'));
  });
});

// ── enrichableColumns ────────────────────────────────────────────────────

describe('enrichableColumns', () => {
  it('returns task columns', () => {
    const cols = enrichableColumns('tasks');
    assert.ok(cols.includes('name'));
    assert.ok(cols.includes('dueDate'));
    assert.ok(cols.includes('projectName'));
    assert.ok(cols.includes('tags'));
    assert.ok(cols.includes('note'));
  });

  it('returns project columns', () => {
    const cols = enrichableColumns('projects');
    assert.ok(cols.includes('name'));
    assert.ok(cols.includes('status'));
    assert.ok(cols.includes('folderId'));
    assert.ok(cols.includes('folderName'));
  });

  it('returns folder columns', () => {
    const cols = enrichableColumns('folders');
    assert.ok(cols.includes('name'));
    assert.ok(cols.includes('hidden'));
    assert.ok(cols.includes('projectCount'));
  });

  it('returns tag columns', () => {
    const cols = enrichableColumns('tags');
    assert.ok(cols.includes('name'));
    assert.ok(cols.includes('parentId'));
    assert.ok(cols.includes('parentName'));
  });

  it('returns empty for perspectives', () => {
    assert.deepEqual(enrichableColumns('perspectives'), []);
  });
});

// ── generateEnrichScript — output is valid JavaScript ────────────────────

describe('generateEnrichScript — syntactic validity', () => {
  it('generates parseable JavaScript for tasks with many columns', () => {
    const cols = ['id', 'name', 'flagged', 'dueDate', 'taskStatus', 'projectName', 'tags', 'note'];
    const script = generateEnrichScript('tasks', ['a', 'b', 'c'], cols);
    // Basic syntactic check: new Function should not throw
    assert.doesNotThrow(
      () => new Function(script),
      'Generated script should be syntactically valid JavaScript'
    );
  });

  it('generates parseable JavaScript for projects', () => {
    const cols = ['id', 'name', 'status', 'folderId', 'folderName'];
    const script = generateEnrichScript('projects', ['p1'], cols);
    assert.doesNotThrow(
      () => new Function(script),
      'Generated project script should be syntactically valid'
    );
  });

  it('generates parseable JavaScript for tags', () => {
    const cols = ['id', 'name', 'parentId', 'parentName', 'hidden'];
    const script = generateEnrichScript('tags', ['t1'], cols);
    assert.doesNotThrow(
      () => new Function(script),
      'Generated tag script should be syntactically valid'
    );
  });

  it('generates parseable JavaScript for folders', () => {
    const cols = ['id', 'name', 'parentFolderId', 'projectCount', 'hidden'];
    const script = generateEnrichScript('folders', ['f1'], cols);
    assert.doesNotThrow(
      () => new Function(script),
      'Generated folder script should be syntactically valid'
    );
  });

  it('properly escapes special characters in IDs', () => {
    const script = generateEnrichScript('tasks', ['id"with"quotes', "id'apos"], ['name']);
    // JSON.stringify handles escaping; verify no syntax error
    assert.doesNotThrow(
      () => new Function(script),
      'Should handle special characters in IDs'
    );
  });
});
