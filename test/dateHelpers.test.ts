import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toLocalDateKey, formatDayLabel, addDays } from '../dist/utils/dateHelpers.js';

describe('toLocalDateKey', () => {
  it('converts a midday ISO date to YYYY-MM-DD', () => {
    assert.equal(toLocalDateKey('2026-03-01T12:00:00.000Z'), '2026-03-01');
  });

  it('returns valid format for midnight UTC', () => {
    const result = toLocalDateKey('2026-03-02T00:00:00.000Z');
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatDayLabel', () => {
  it('formats as "Day D Mon"', () => {
    assert.equal(formatDayLabel('2026-03-01'), 'Sun 1 Mar');
  });

  it('formats a weekday', () => {
    assert.equal(formatDayLabel('2026-03-02'), 'Mon 2 Mar');
  });

  it('handles double-digit dates', () => {
    assert.equal(formatDayLabel('2026-03-15'), 'Sun 15 Mar');
  });
});

describe('addDays', () => {
  it('adds 1 day', () => {
    assert.equal(addDays('2026-03-01', 1), '2026-03-02');
  });

  it('adds 14 days', () => {
    assert.equal(addDays('2026-03-01', 14), '2026-03-15');
  });

  it('crosses month boundary', () => {
    assert.equal(addDays('2026-03-31', 1), '2026-04-01');
  });

  it('crosses year boundary', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });

  it('adds 0 days returns same date', () => {
    assert.equal(addDays('2026-03-01', 0), '2026-03-01');
  });
});
