import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { coerceJson, getCoercionWarnings, tryFixJsLiteral } from '../dist/tools/utils/coercion.js';

// Helper: apply coerceJson and return { value, warnings }
function coerce(input: unknown) {
  const schema = coerceJson('testField', z.any());
  const value = schema.parse(input);
  const warnings = getCoercionWarnings();
  return { value, warnings };
}

describe('tryFixJsLiteral', () => {
  it('fixes unquoted keys', () => {
    const result = tryFixJsLiteral('{and: [{var: "name"}, "test"]}');
    assert.deepEqual(result, { and: [{ var: 'name' }, 'test'] });
  });

  it('fixes single-quoted strings', () => {
    const result = tryFixJsLiteral("{'and': [{'var': 'name'}, 'test']}");
    assert.deepEqual(result, { and: [{ var: 'name' }, 'test'] });
  });

  it('strips trailing commas', () => {
    const result = tryFixJsLiteral('{"a": [1, 2, 3,]}');
    assert.deepEqual(result, { a: [1, 2, 3] });
  });

  it('handles mixed issues', () => {
    const result = tryFixJsLiteral("{and: [{var: 'name',}, 'test',]}");
    assert.deepEqual(result, { and: [{ var: 'name' }, 'test'] });
  });

  it('returns null for completely invalid strings', () => {
    assert.equal(tryFixJsLiteral('not even close'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(tryFixJsLiteral(''), null);
  });
});

describe('coerceJson', () => {
  it('parses valid JSON string and warns', () => {
    const { value, warnings } = coerce('{"and": [true, false]}');
    assert.deepEqual(value, { and: [true, false] });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /JSON-encoded string/);
  });

  it('fixes JS literal and warns more strongly', () => {
    const { value, warnings } = coerce('{and: [{var: "name"}, "test"]}');
    assert.deepEqual(value, { and: [{ var: 'name' }, 'test'] });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /JavaScript object literal/);
  });

  it('warns and passes through completely invalid strings', () => {
    const { value, warnings } = coerce('not valid at all');
    assert.equal(value, 'not valid at all');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /isn't valid JSON/);
  });

  it('passes through non-string values unchanged', () => {
    const obj = { and: [true, false] };
    const { value, warnings } = coerce(obj);
    assert.deepEqual(value, obj);
    assert.equal(warnings.length, 0);
  });

  it('passes through numbers unchanged', () => {
    const { value, warnings } = coerce(42);
    assert.equal(value, 42);
    assert.equal(warnings.length, 0);
  });

  it('passes through null unchanged', () => {
    const { value, warnings } = coerce(null);
    assert.equal(value, null);
    assert.equal(warnings.length, 0);
  });
});
