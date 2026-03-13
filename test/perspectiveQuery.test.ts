import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBuiltinPerspectiveQuery } from '../dist/tools/primitives/perspectiveQuery.js';

describe('resolveBuiltinPerspectiveQuery', () => {
  it('maps Flagged to a flagged task query', () => {
    assert.deepEqual(resolveBuiltinPerspectiveQuery('Flagged'), {
      entity: 'tasks',
      where: { eq: [{ var: 'flagged' }, true] },
    });
  });

  it('maps inbox case-insensitively', () => {
    assert.deepEqual(resolveBuiltinPerspectiveQuery('inbox'), {
      entity: 'tasks',
      where: { eq: [{ var: 'inInbox' }, true] },
    });
  });

  it('returns null for non-built-in perspectives', () => {
    assert.equal(resolveBuiltinPerspectiveQuery('Active'), null);
  });
});
