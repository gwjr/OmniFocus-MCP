/**
 * Unit tests for queryOmnifocus mandatory task fields and formatting,
 * and the op:'get'|'count'|'exists' parameter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  augmentTaskSelect,
  injectMandatoryTaskFields,
} from '../dist/tools/primitives/queryOmnifocus.js';
import { schema } from '../dist/tools/definitions/queryOmnifocus.js';

// ── augmentTaskSelect ─────────────────────────────────────────────────────

describe('augmentTaskSelect', () => {

  it('injects id, flagged, status when user selects only name', () => {
    const result = augmentTaskSelect(['name']);
    assert.ok(result.includes('id'), 'should include id');
    assert.ok(result.includes('flagged'), 'should include flagged');
    assert.ok(result.includes('status'), 'should include status');
    assert.ok(result.includes('name'), 'should keep user-selected name');
  });

  it('does not duplicate fields already in select', () => {
    const result = augmentTaskSelect(['id', 'name', 'flagged']);
    const idCount = result.filter(v => v === 'id').length;
    assert.equal(idCount, 1, 'should not duplicate id');
  });

  it('maps taskStatus to internal status var', () => {
    const result = augmentTaskSelect(['name', 'taskStatus']);
    assert.ok(result.includes('status'), 'should add status for taskStatus');
    assert.ok(result.includes('taskStatus'), 'should keep original taskStatus');
  });

  it('returns all mandatory fields even when select is empty', () => {
    const result = augmentTaskSelect([]);
    assert.ok(result.includes('id'));
    assert.ok(result.includes('flagged'));
    assert.ok(result.includes('status'));
  });
});

// ── injectMandatoryTaskFields ─────────────────────────────────────────────

describe('injectMandatoryTaskFields', () => {

  it('maps status to taskStatus in result rows', () => {
    const rows = [
      { id: '1', name: 'Test', flagged: false, status: 'Available' },
    ];
    const result = injectMandatoryTaskFields(rows);
    assert.equal(result[0].taskStatus, 'Available');
    assert.ok(!('status' in result[0]), 'status key should be removed');
  });

  it('preserves existing taskStatus without overwriting', () => {
    const rows = [
      { id: '1', name: 'Test', flagged: false, status: 'Available', taskStatus: 'Overdue' },
    ];
    const result = injectMandatoryTaskFields(rows);
    assert.equal(result[0].taskStatus, 'Overdue', 'should keep existing taskStatus');
  });

  it('preserves id and flagged in result', () => {
    const rows = [
      { id: '42', name: 'Task', flagged: true, status: 'Next' },
    ];
    const result = injectMandatoryTaskFields(rows);
    assert.equal(result[0].id, '42');
    assert.equal(result[0].flagged, true);
    assert.equal(result[0].taskStatus, 'Next');
  });

  it('handles rows without status field', () => {
    const rows = [
      { id: '1', name: 'Test', flagged: false },
    ];
    const result = injectMandatoryTaskFields(rows);
    assert.equal(result[0].id, '1');
    assert.ok(!('taskStatus' in result[0]), 'should not inject taskStatus if status missing');
  });

  it('does not mutate original rows', () => {
    const original = { id: '1', name: 'Test', flagged: false, status: 'Available' };
    const rows = [original];
    injectMandatoryTaskFields(rows);
    assert.ok('status' in original, 'original row should still have status');
  });
});

// ── op parameter — schema validation ─────────────────────────────────────

describe('query schema — op parameter', () => {
  it('accepts op:get', () => {
    assert.doesNotThrow(() => schema.parse({ entity: 'tasks', op: 'get' }));
  });

  it('accepts op:count', () => {
    assert.doesNotThrow(() => schema.parse({ entity: 'tasks', op: 'count' }));
  });

  it('accepts op:exists', () => {
    assert.doesNotThrow(() => schema.parse({ entity: 'tasks', op: 'exists' }));
  });

  it('rejects unknown op', () => {
    assert.throws(() => schema.parse({ entity: 'tasks', op: 'delete' }));
  });

  it('op is optional (defaults to get implicitly)', () => {
    const parsed = schema.parse({ entity: 'tasks' });
    assert.equal(parsed.op, undefined);
  });

  it('accepts summary:true alongside op (deprecated shim)', () => {
    assert.doesNotThrow(() => schema.parse({ entity: 'tasks', summary: true }));
  });

  it('op and summary can coexist (op takes precedence at runtime)', () => {
    // Schema does not reject this combination — runtime resolves it
    assert.doesNotThrow(() => schema.parse({ entity: 'tasks', op: 'count', summary: true }));
  });
});
