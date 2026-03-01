import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateMoveScript, validateMoveParams, MoveValidationError } from '../dist/tools/primitives/batchMove.js';

// Helper: generate script with defaults
function gen(overrides: Record<string, any>) {
  return generateMoveScript({
    ids: ['test-id-1'],
    entity: 'tasks',
    ...overrides,
  });
}

describe('moveScript — toProjectId', () => {
  it('resolves destination by ID reference', () => {
    const s = gen({ toProjectId: 'proj-123' });
    assert.match(s, /flattened project id "proj-123"/);
    assert.match(s, /move \{workItem\} to end of tasks of destItem/);
  });
});

describe('moveScript — toProjectName', () => {
  it('resolves destination with whose lookup', () => {
    const s = gen({ toProjectName: 'My Project' });
    assert.match(s, /every flattened project whose name = "My Project"/);
    assert.match(s, /move \{workItem\} to end of tasks of destItem/);
  });

  it('includes ambiguity check', () => {
    const s = gen({ toProjectName: 'Dup' });
    assert.match(s, /count of destProjects\) > 1/);
    assert.match(s, /Ambiguous/);
  });

  it('includes not-found check', () => {
    const s = gen({ toProjectName: 'Dup' });
    assert.match(s, /count of destProjects\) = 0/);
    assert.match(s, /Project not found/);
  });
});

describe('moveScript — toFolderName', () => {
  it('resolves folder with whose lookup', () => {
    const s = gen({ entity: 'projects', toFolderName: 'Work' });
    assert.match(s, /every flattened folder whose name = "Work"/);
    assert.match(s, /move \{workItem\} to end of projects of destItem/);
  });

  it('includes ambiguity check', () => {
    const s = gen({ entity: 'projects', toFolderName: 'Work' });
    assert.match(s, /count of destFolders\) > 1/);
    assert.match(s, /Ambiguous/);
  });

  it('includes not-found check', () => {
    const s = gen({ entity: 'projects', toFolderName: 'Work' });
    assert.match(s, /count of destFolders\) = 0/);
    assert.match(s, /Folder not found/);
  });
});

describe('moveScript — toFolderId', () => {
  it('resolves folder by ID reference', () => {
    const s = gen({ entity: 'projects', toFolderId: 'fold-456' });
    assert.match(s, /flattened folder id "fold-456"/);
    assert.match(s, /move \{workItem\} to end of projects of destItem/);
  });
});

describe('moveScript — toInbox', () => {
  it('moves tasks to inbox', () => {
    const s = gen({ toInbox: true });
    assert.match(s, /move \{workItem\} to beginning of inbox tasks/);
    assert.match(s, /set destName to "Inbox"/);
  });
});

describe('moveScript — entity class', () => {
  it('uses flattened task for tasks', () => {
    const s = gen({ toInbox: true });
    assert.match(s, /flattened task id/);
  });

  it('uses flattened project for projects', () => {
    const s = gen({ entity: 'projects', toFolderName: 'X' });
    assert.match(s, /flattened project id/);
  });
});

describe('moveScript — multiple IDs', () => {
  it('includes all IDs', () => {
    const s = gen({ ids: ['a', 'b', 'c'], toInbox: true });
    assert.match(s, /"a", "b", "c"/);
  });
});

describe('moveScript — structure', () => {
  it('uses default document', () => {
    const s = gen({ toInbox: true });
    assert.match(s, /tell default document/);
  });

  it('includes escapeForJSON handler', () => {
    const s = gen({ toInbox: true });
    assert.match(s, /on escapeForJSON/);
  });

  it('returns JSON array', () => {
    const s = gen({ toInbox: true });
    assert.match(s, /set jsonResult to "\["/);
  });

  it('includes destination in result', () => {
    const s = gen({ toInbox: true });
    assert.match(s, /destination/);
  });
});

describe('validateMoveParams', () => {
  it('no destination → error', () => {
    assert.throws(
      () => validateMoveParams({ ids: ['a'], entity: 'tasks' }),
      (err: any) => err instanceof MoveValidationError && /exactly one destination/i.test(err.message)
    );
  });

  it('multiple destinations → error', () => {
    assert.throws(
      () => validateMoveParams({ ids: ['a'], entity: 'tasks', toProjectId: 'p', toInbox: true }),
      (err: any) => err instanceof MoveValidationError && /got multiple/i.test(err.message)
    );
  });

  it('task + toFolderName → error', () => {
    assert.throws(
      () => validateMoveParams({ ids: ['a'], entity: 'tasks', toFolderName: 'F' }),
      (err: any) => err instanceof MoveValidationError && /cannot be moved to folders/i.test(err.message)
    );
  });

  it('task + toFolderId → error', () => {
    assert.throws(
      () => validateMoveParams({ ids: ['a'], entity: 'tasks', toFolderId: 'f1' }),
      (err: any) => err instanceof MoveValidationError && /cannot be moved to folders/i.test(err.message)
    );
  });

  it('project + toProjectId → error', () => {
    assert.throws(
      () => validateMoveParams({ ids: ['a'], entity: 'projects', toProjectId: 'p1' }),
      (err: any) => err instanceof MoveValidationError && /cannot be moved to projects/i.test(err.message)
    );
  });

  it('project + toProjectName → error', () => {
    assert.throws(
      () => validateMoveParams({ ids: ['a'], entity: 'projects', toProjectName: 'P' }),
      (err: any) => err instanceof MoveValidationError && /cannot be moved to projects/i.test(err.message)
    );
  });

  it('project + toInbox → error', () => {
    assert.throws(
      () => validateMoveParams({ ids: ['a'], entity: 'projects', toInbox: true }),
      (err: any) => err instanceof MoveValidationError && /cannot be moved to projects or inbox/i.test(err.message)
    );
  });

  it('task + toProjectId → valid', () => {
    assert.doesNotThrow(
      () => validateMoveParams({ ids: ['a'], entity: 'tasks', toProjectId: 'p1' })
    );
  });

  it('project + toFolderName → valid', () => {
    assert.doesNotThrow(
      () => validateMoveParams({ ids: ['a'], entity: 'projects', toFolderName: 'F' })
    );
  });
});
