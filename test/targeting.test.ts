import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargets, TargetingError } from '../dist/tools/targeting.js';

describe('targeting — id mode', () => {
  it('id + entity → single-element ids array', async () => {
    const result = await resolveTargets({ id: 'abc123', entity: 'tasks' });
    assert.deepStrictEqual(result, { ids: ['abc123'], entity: 'tasks' });
  });

  it('id + entity projects', async () => {
    const result = await resolveTargets({ id: 'p1', entity: 'projects' });
    assert.deepStrictEqual(result, { ids: ['p1'], entity: 'projects' });
  });

  it('id without entity → error', async () => {
    await assert.rejects(
      () => resolveTargets({ id: 'abc' }),
      (err: any) => err instanceof TargetingError && /entity is required/i.test(err.message)
    );
  });
});

describe('targeting — ids mode', () => {
  it('ids + entity → pass through', async () => {
    const result = await resolveTargets({ ids: ['a', 'b'], entity: 'tasks' });
    assert.deepStrictEqual(result, { ids: ['a', 'b'], entity: 'tasks' });
  });

  it('ids without entity → error', async () => {
    await assert.rejects(
      () => resolveTargets({ ids: ['a'] }),
      (err: any) => err instanceof TargetingError && /entity is required/i.test(err.message)
    );
  });

  it('empty ids → error', async () => {
    await assert.rejects(
      () => resolveTargets({ ids: [], entity: 'tasks' }),
      (err: any) => err instanceof TargetingError && /non-empty/i.test(err.message)
    );
  });
});

describe('targeting — validation', () => {
  it('no targeting mode → error', async () => {
    await assert.rejects(
      () => resolveTargets({} as any),
      (err: any) => err instanceof TargetingError && /exactly one/i.test(err.message)
    );
  });

  it('multiple targeting modes → error', async () => {
    await assert.rejects(
      () => resolveTargets({ id: 'a', ids: ['b'], entity: 'tasks' }),
      (err: any) => err instanceof TargetingError && /got multiple/i.test(err.message)
    );
  });

  it('invalid entity for id mode → error', async () => {
    await assert.rejects(
      () => resolveTargets({ id: 'a', entity: 'folders' as any }),
      (err: any) => err instanceof TargetingError && /must be "tasks" or "projects"/i.test(err.message)
    );
  });

  it('invalid entity for ids mode → error', async () => {
    await assert.rejects(
      () => resolveTargets({ ids: ['a'], entity: 'tags' as any }),
      (err: any) => err instanceof TargetingError && /must be "tasks" or "projects"/i.test(err.message)
    );
  });
});

// query mode tests need the real queryOmnifocus or a live OmniFocus — covered in integration tests
