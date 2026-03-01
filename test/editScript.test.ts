import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateEditScript } from '../dist/tools/primitives/batchEdit.js';

// Helper: generate script and return as string for assertions
function gen(overrides: Record<string, any>) {
  return generateEditScript({
    ids: ['test-id-1'],
    entity: 'tasks',
    ...overrides,
  });
}

describe('editScript — set properties', () => {
  it('set name', () => {
    const s = gen({ set: { name: 'New Name' } });
    assert.match(s, /set name to "New Name"/);
  });

  it('set note', () => {
    const s = gen({ set: { note: 'A note' } });
    assert.match(s, /set note to "A note"/);
  });

  it('set flagged true', () => {
    const s = gen({ set: { flagged: true } });
    assert.match(s, /set flagged to true/);
  });

  it('set flagged false', () => {
    const s = gen({ set: { flagged: false } });
    assert.match(s, /set flagged to false/);
  });

  it('set estimatedMinutes', () => {
    const s = gen({ set: { estimatedMinutes: 30 } });
    assert.match(s, /set estimated minutes to 30/);
  });

  it('clear estimatedMinutes with null', () => {
    const s = gen({ set: { estimatedMinutes: null } });
    assert.match(s, /set estimated minutes to missing value/);
  });

  it('set sequential for projects', () => {
    const s = gen({ entity: 'projects', set: { sequential: true } });
    assert.match(s, /set sequential to true/);
  });

  it('sequential ignored for tasks', () => {
    const s = gen({ entity: 'tasks', set: { sequential: true } });
    assert.doesNotMatch(s, /set sequential/);
  });
});

describe('editScript — dates', () => {
  it('set dueDate with ISO string', () => {
    const s = gen({ set: { dueDate: '2026-04-15' } });
    // Date pre-construction should be before Foundation
    assert.match(s, /copy current date to/);
    assert.match(s, /set due date to/);
    // Pre-construction must appear before `use framework`
    const preIdx = s.indexOf('copy current date to');
    const fwIdx = s.indexOf('use framework "Foundation"');
    assert.ok(preIdx < fwIdx, 'date pre-construction must be before Foundation import');
  });

  it('clear dueDate with null', () => {
    const s = gen({ set: { dueDate: null } });
    assert.match(s, /set due date to missing value/);
  });

  it('set deferDate', () => {
    const s = gen({ set: { deferDate: '2026-05-01' } });
    assert.match(s, /set defer date to/);
  });

  it('clear deferDate with null', () => {
    const s = gen({ set: { deferDate: null } });
    assert.match(s, /set defer date to missing value/);
  });

  it('set plannedDate', () => {
    const s = gen({ set: { plannedDate: '2026-06-01' } });
    assert.match(s, /set planned date to/);
  });

  it('clear plannedDate with null', () => {
    const s = gen({ set: { plannedDate: null } });
    assert.match(s, /set planned date to missing value/);
  });
});

describe('editScript — tags', () => {
  it('addTags produces tag pre-resolution block', () => {
    const s = gen({ addTags: ['Urgent', 'Home'] });
    assert.match(s, /first flattened tag whose name = "Urgent"/);
    assert.match(s, /first flattened tag whose name = "Home"/);
    assert.match(s, /Tag not found: Urgent/);
    assert.match(s, /Tag not found: Home/);
  });

  it('addTags produces add commands in loop', () => {
    const s = gen({ addTags: ['Urgent'] });
    assert.match(s, /add addTag0 to tags of workItem/);
  });

  it('removeTags produces remove commands', () => {
    const s = gen({ removeTags: ['Old'] });
    assert.match(s, /first flattened tag whose name = "Old"/);
    assert.match(s, /remove removeTag0 from tags of workItem/);
  });

  it('removeTags silently skips missing (no error return)', () => {
    const s = gen({ removeTags: ['Old'] });
    // removeTag resolution uses try block but doesn't return error
    assert.doesNotMatch(s, /Tag not found: Old/);
  });
});

describe('editScript — mark', () => {
  it('mark completed for task', () => {
    const s = gen({ mark: 'completed' });
    assert.match(s, /mark complete/);
  });

  it('mark dropped for task', () => {
    const s = gen({ mark: 'dropped' });
    assert.match(s, /mark dropped/);
  });

  it('mark active for task', () => {
    const s = gen({ mark: 'active' });
    assert.match(s, /mark incomplete/);
  });

  it('mark completed for project', () => {
    const s = gen({ entity: 'projects', mark: 'completed' });
    assert.match(s, /mark complete/);
  });

  it('mark dropped for project', () => {
    const s = gen({ entity: 'projects', mark: 'dropped' });
    assert.match(s, /mark dropped/);
  });

  it('mark active for project', () => {
    const s = gen({ entity: 'projects', mark: 'active' });
    assert.match(s, /set status to active status/);
  });

  it('mark onHold for project', () => {
    const s = gen({ entity: 'projects', mark: 'onHold' });
    assert.match(s, /set status to on hold status/);
  });

  it('mark flagged', () => {
    const s = gen({ mark: 'flagged' });
    assert.match(s, /set flagged to true/);
  });

  it('mark unflagged', () => {
    const s = gen({ mark: 'unflagged' });
    assert.match(s, /set flagged to false/);
  });
});

describe('editScript — offset', () => {
  it('offset dueDate', () => {
    const s = gen({ offset: { dueDate: { days: 7 } } });
    assert.match(s, /set curVal to due date/);
    assert.match(s, /set due date to curVal \+ \(7 \* days\)/);
    assert.match(s, /if curVal is not missing value/);
  });

  it('offset deferDate', () => {
    const s = gen({ offset: { deferDate: { days: -3 } } });
    assert.match(s, /set curVal to defer date/);
    assert.match(s, /set defer date to curVal \+ \(-3 \* days\)/);
  });

  it('offset plannedDate', () => {
    const s = gen({ offset: { plannedDate: { days: 14 } } });
    assert.match(s, /set curVal to planned date/);
    assert.match(s, /set planned date to curVal \+ \(14 \* days\)/);
  });
});

describe('editScript — entity class', () => {
  it('uses flattened task for tasks entity', () => {
    const s = gen({ entity: 'tasks' });
    assert.match(s, /flattened task id anId/);
  });

  it('uses flattened project for projects entity', () => {
    const s = gen({ entity: 'projects', set: { flagged: true } });
    assert.match(s, /flattened project id anId/);
  });
});

describe('editScript — multiple IDs', () => {
  it('includes all IDs in theIds list', () => {
    const s = gen({ ids: ['id-a', 'id-b', 'id-c'], set: { flagged: true } });
    assert.match(s, /"id-a", "id-b", "id-c"/);
  });
});

describe('editScript — combined operations', () => {
  it('set + mark + addTags + offset in one script', () => {
    const s = gen({
      set: { name: 'Updated', flagged: true },
      mark: 'completed',
      addTags: ['Done'],
      offset: { dueDate: { days: 1 } },
    });
    assert.match(s, /set name to "Updated"/);
    assert.match(s, /set flagged to true/);
    assert.match(s, /mark complete/);
    assert.match(s, /first flattened tag whose name = "Done"/);
    assert.match(s, /set due date to curVal/);
  });
});

describe('editScript — structure', () => {
  it('starts with use scripting additions', () => {
    const s = gen({ set: { flagged: true } });
    assert.ok(s.startsWith('use scripting additions'));
  });

  it('includes escapeForJSON handler', () => {
    const s = gen({ set: { flagged: true } });
    assert.match(s, /on escapeForJSON/);
  });

  it('uses default document (not front document)', () => {
    const s = gen({ set: { flagged: true } });
    assert.match(s, /tell default document/);
  });

  it('returns JSON array', () => {
    const s = gen({ set: { flagged: true } });
    assert.match(s, /set jsonResult to "\["/);
  });
});
