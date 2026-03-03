/**
 * Tests for normalizeAst — AST canonicalization pass.
 *
 * Covers:
 *   1. Flatten nested and/or
 *   2. Collapse singleton and/or
 *   3. Double negation elimination
 *   4. LHS canonicalization (symmetric and ordering ops)
 *   5. Conjunct/disjunct sort ordering (tier 0-4)
 *   6. Idempotency
 *   7. Leaf passthrough
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAst } from '../dist/tools/query/normalizeAst.js';
import type { LoweredExpr } from '../dist/tools/query/fold.js';

// Shorthand builders to keep tests readable
const v = (name: string): LoweredExpr => ({ var: name });
const op = (name: string, ...args: LoweredExpr[]): LoweredExpr => ({ op: name, args });
const date = (value: string): LoweredExpr => ({ type: 'date', value });

// ── 1. Flatten nested and/or ─────────────────────────────────────────────

describe('normalizeAst — flatten', () => {
  it('flattens nested and', () => {
    const input = op('and', op('and', v('a'), v('b')), v('c'));
    const result = normalizeAst(input) as { op: string; args: LoweredExpr[] };
    assert.equal(result.op, 'and');
    assert.equal(result.args.length, 3);
  });

  it('flattens nested or', () => {
    const input = op('or', op('or', v('a'), v('b')), v('c'));
    const result = normalizeAst(input) as { op: string; args: LoweredExpr[] };
    assert.equal(result.op, 'or');
    assert.equal(result.args.length, 3);
  });

  it('flattens deeply nested and', () => {
    const input = op('and', op('and', op('and', v('a'), v('b')), v('c')), v('d'));
    const result = normalizeAst(input) as { op: string; args: LoweredExpr[] };
    assert.equal(result.op, 'and');
    assert.equal(result.args.length, 4);
  });

  it('does not flatten across and/or boundary', () => {
    // and(or(a, b), c) — or stays as a child of and
    const inner = op('or', v('a'), v('b'));
    const input = op('and', inner, v('c'));
    const result = normalizeAst(input) as { op: string; args: LoweredExpr[] };
    assert.equal(result.op, 'and');
    assert.equal(result.args.length, 2);
    // The or child should be preserved
    const orChild = result.args.find(a => typeof a === 'object' && 'op' in a && (a as any).op === 'or');
    assert.ok(orChild, 'or child should be preserved');
  });

  it('flattens middle and nested in and', () => {
    // and(eq(a,1), and(eq(b,2), eq(c,3)), eq(d,4)) → and(4 children)
    const input = op('and',
      op('eq', v('flagged'), true),
      op('and', op('eq', v('name'), 'test'), op('eq', v('id'), 'x')),
      op('eq', v('blocked'), false)
    );
    const result = normalizeAst(input) as { op: string; args: LoweredExpr[] };
    assert.equal(result.op, 'and');
    assert.equal(result.args.length, 4);
  });
});

// ── 2. Collapse singleton and/or ─────────────────────────────────────────

describe('normalizeAst — collapse singleton', () => {
  it('collapses and with one child', () => {
    const input = op('and', op('eq', v('flagged'), true));
    const result = normalizeAst(input);
    // Should unwrap to the single child
    assert.deepEqual(result, op('eq', v('flagged'), true));
  });

  it('collapses or with one child', () => {
    const input = op('or', op('eq', v('name'), 'foo'));
    const result = normalizeAst(input);
    assert.deepEqual(result, op('eq', v('name'), 'foo'));
  });

  it('collapses nested single-child and after flattening', () => {
    // and(and(eq(a, 1))) → eq(a, 1)
    const input = op('and', op('and', op('eq', v('flagged'), true)));
    const result = normalizeAst(input);
    assert.deepEqual(result, op('eq', v('flagged'), true));
  });
});

// ── 3. Double negation elimination ───────────────────────────────────────

describe('normalizeAst — double negation', () => {
  it('eliminates double not', () => {
    const input = op('not', op('not', op('eq', v('flagged'), true)));
    const result = normalizeAst(input);
    assert.deepEqual(result, op('eq', v('flagged'), true));
  });

  it('leaves single not intact', () => {
    const input = op('not', op('eq', v('flagged'), true));
    const result = normalizeAst(input) as { op: string; args: LoweredExpr[] };
    assert.equal((result as any).op, 'not');
  });

  it('eliminates triple not to single not', () => {
    // not(not(not(x))) → not(x)
    const x = op('eq', v('flagged'), true);
    const input = op('not', op('not', op('not', x)));
    const result = normalizeAst(input) as any;
    assert.equal(result.op, 'not');
    assert.deepEqual(result.args[0], x);
  });
});

// ── 4. LHS canonicalization ───────────────────────────────────────────────

describe('normalizeAst — LHS canonicalization', () => {
  it('eq: swaps literal on LHS with var on RHS', () => {
    const input = op('eq', 'foo', v('name'));
    const result = normalizeAst(input) as any;
    assert.equal(result.op, 'eq');
    assert.deepEqual(result.args[0], v('name'));
    assert.equal(result.args[1], 'foo');
  });

  it('eq: leaves var on LHS untouched', () => {
    const input = op('eq', v('name'), 'foo');
    const result = normalizeAst(input) as any;
    assert.deepEqual(result.args[0], v('name'));
    assert.equal(result.args[1], 'foo');
  });

  it('neq: swaps literal LHS', () => {
    const input = op('neq', true, v('flagged'));
    const result = normalizeAst(input) as any;
    assert.deepEqual(result.args[0], v('flagged'));
    assert.equal(result.args[1], true);
  });

  it('gt: flips to lt when literal is on LHS', () => {
    // gt(5, {var: "estimatedMinutes"}) means "5 > estimatedMinutes"
    // canonical form: lt({var: "estimatedMinutes"}, 5)
    const input = op('gt', 5, v('estimatedMinutes'));
    const result = normalizeAst(input) as any;
    assert.equal(result.op, 'lt');
    assert.deepEqual(result.args[0], v('estimatedMinutes'));
    assert.equal(result.args[1], 5);
  });

  it('gte: flips to lte when literal is on LHS', () => {
    const input = op('gte', 10, v('estimatedMinutes'));
    const result = normalizeAst(input) as any;
    assert.equal(result.op, 'lte');
    assert.deepEqual(result.args[0], v('estimatedMinutes'));
    assert.equal(result.args[1], 10);
  });

  it('lt: flips to gt when literal is on LHS', () => {
    const input = op('lt', 5, v('estimatedMinutes'));
    const result = normalizeAst(input) as any;
    assert.equal(result.op, 'gt');
    assert.deepEqual(result.args[0], v('estimatedMinutes'));
    assert.equal(result.args[1], 5);
  });

  it('lte: flips to gte when literal is on LHS', () => {
    const input = op('lte', 10, v('estimatedMinutes'));
    const result = normalizeAst(input) as any;
    assert.equal(result.op, 'gte');
    assert.deepEqual(result.args[0], v('estimatedMinutes'));
    assert.equal(result.args[1], 10);
  });

  it('gt: leaves var on LHS untouched', () => {
    const input = op('gt', v('estimatedMinutes'), 5);
    const result = normalizeAst(input) as any;
    assert.equal(result.op, 'gt');
    assert.deepEqual(result.args[0], v('estimatedMinutes'));
    assert.equal(result.args[1], 5);
  });

  it('contains: swaps literal LHS to ensure var on LHS', () => {
    const input = op('contains', 'foo', v('name'));
    const result = normalizeAst(input) as any;
    assert.equal(result.op, 'contains');
    assert.deepEqual(result.args[0], v('name'));
    assert.equal(result.args[1], 'foo');
  });

  it('startsWith: swaps literal LHS', () => {
    const input = op('startsWith', 'prefix', v('name'));
    const result = normalizeAst(input) as any;
    assert.deepEqual(result.args[0], v('name'));
  });

  it('endsWith: swaps literal LHS', () => {
    const input = op('endsWith', 'suffix', v('name'));
    const result = normalizeAst(input) as any;
    assert.deepEqual(result.args[0], v('name'));
  });

  it('eq: date literal on LHS swaps', () => {
    const input = op('eq', date('2026-01-01'), v('dueDate'));
    const result = normalizeAst(input) as any;
    assert.deepEqual(result.args[0], v('dueDate'));
    assert.deepEqual(result.args[1], date('2026-01-01'));
  });

  it('eq: var on both sides — no swap', () => {
    // Both are vars — leave as-is
    const input = op('eq', v('dueDate'), v('effectiveDueDate'));
    const result = normalizeAst(input) as any;
    assert.deepEqual(result.args[0], v('dueDate'));
    assert.deepEqual(result.args[1], v('effectiveDueDate'));
  });

  it('matches: does not swap (second arg is raw pattern, not a var)', () => {
    // matches({var: "name"}, "pattern") — already canonical; patterns aren't vars
    const input = op('matches', v('name'), 'foo.*');
    const result = normalizeAst(input) as any;
    assert.equal(result.op, 'matches');
    assert.deepEqual(result.args[0], v('name'));
  });
});

// ── 5. Sort ordering ──────────────────────────────────────────────────────

describe('normalizeAst — conjunct sort ordering', () => {
  it('tier 0 before tier 1 (simple comparison before not)', () => {
    const notExpr = op('not', op('eq', v('flagged'), true));
    const simpleEq = op('eq', v('name'), 'foo');
    const input = op('and', notExpr, simpleEq);
    const result = normalizeAst(input) as any;
    // simpleEq (tier 0) should come before notExpr (tier 1)
    assert.equal((result.args[0] as any).op, 'eq');
    assert.equal((result.args[1] as any).op, 'not');
  });

  it('tier 0 before tier 2 (simple comparison before nested and)', () => {
    const nested = op('and', op('eq', v('a'), 1), op('eq', v('b'), 2));
    const simple = op('eq', v('flagged'), true);
    const input = op('and', nested, simple);
    const result = normalizeAst(input) as any;
    // After flattening, 'nested' becomes 3 items merged in, so test pre-flatten scenario
    // Actually nested and gets flattened. Let's use nested or:
    const nestedOr = op('or', op('eq', v('a'), 1), op('eq', v('b'), 2));
    const input2 = op('and', nestedOr, simple);
    const result2 = normalizeAst(input2) as any;
    assert.equal((result2.args[0] as any).op, 'eq');   // tier 0
    assert.equal((result2.args[1] as any).op, 'or');    // tier 2
  });

  it('tier 0 before tier 3 (simple comparison before container)', () => {
    const containerExpr = op('container', 'tag', op('eq', v('name'), 'Work'));
    const simpleEq = op('eq', v('flagged'), true);
    const input = op('and', containerExpr, simpleEq);
    const result = normalizeAst(input) as any;
    // simple (tier 0) before container (tier 3)
    assert.equal((result.args[0] as any).op, 'eq');
    assert.equal((result.args[1] as any).op, 'container');
  });

  it('tier 1 before tier 3 (not before container)', () => {
    const containerExpr = op('container', 'tag', op('eq', v('name'), 'Work'));
    const notExpr = op('not', op('eq', v('flagged'), false));
    const input = op('and', containerExpr, notExpr);
    const result = normalizeAst(input) as any;
    assert.equal((result.args[0] as any).op, 'not');
    assert.equal((result.args[1] as any).op, 'container');
  });

  it('tier 3 before tier 4 (container before count)', () => {
    const containerExpr = op('container', 'tag', op('eq', v('name'), 'Work'));
    const countExpr = op('count', v('tags'));
    const input = op('and', countExpr, containerExpr);
    const result = normalizeAst(input) as any;
    assert.equal((result.args[0] as any).op, 'container');
    assert.equal((result.args[1] as any).op, 'count');
  });

  it('within tier 0: id field before name field', () => {
    const eqName = op('eq', v('name'), 'foo');
    const eqId = op('eq', v('id'), 'abc');
    const input = op('and', eqName, eqId);
    const result = normalizeAst(input) as any;
    // id < name in field ordering
    assert.deepEqual((result.args[0] as any).args[0], v('id'));
    assert.deepEqual((result.args[1] as any).args[0], v('name'));
  });

  it('within tier 0: name field before arbitrary field', () => {
    const eqFlagged = op('eq', v('flagged'), true);
    const eqName = op('eq', v('name'), 'foo');
    const input = op('and', eqFlagged, eqName);
    const result = normalizeAst(input) as any;
    // name < flagged in field ordering (name is special prefix)
    assert.deepEqual((result.args[0] as any).args[0], v('name'));
    assert.deepEqual((result.args[1] as any).args[0], v('flagged'));
  });

  it('within tier 0: same field — sort by op name', () => {
    const gtExpr = op('gt', v('estimatedMinutes'), 30);
    const eqExpr = op('eq', v('estimatedMinutes'), 60);
    const input = op('and', gtExpr, eqExpr);
    const result = normalizeAst(input) as any;
    // eq < gt alphabetically
    assert.equal((result.args[0] as any).op, 'eq');
    assert.equal((result.args[1] as any).op, 'gt');
  });

  it('sort is stable: equal keys preserve relative order', () => {
    // Two eq on different fields that both sort to tier 0, position 3
    const eq1 = op('eq', v('blocked'), false);
    const eq2 = op('eq', v('completed'), false);
    const input = op('and', eq2, eq1);
    const result = normalizeAst(input) as any;
    // blocked < completed alphabetically under the '3_' prefix
    assert.deepEqual((result.args[0] as any).args[0], v('blocked'));
    assert.deepEqual((result.args[1] as any).args[0], v('completed'));
  });
});

// ── 6. Idempotency ────────────────────────────────────────────────────────

describe('normalizeAst — idempotency', () => {
  it('normalizing twice gives the same result', () => {
    const input = op('and',
      op('eq', 'foo', v('name')),
      op('not', op('not', op('eq', v('flagged'), true))),
      op('container', 'tag', op('eq', v('name'), 'Work'))
    );
    const once = normalizeAst(input);
    const twice = normalizeAst(once);
    assert.deepEqual(once, twice);
  });

  it('idempotent on already-canonical and', () => {
    const canonical = op('and',
      op('eq', v('flagged'), true),
      op('not', op('eq', v('dropped'), true))
    );
    assert.deepEqual(normalizeAst(canonical), canonical);
  });
});

// ── 7. Leaf passthrough ───────────────────────────────────────────────────

describe('normalizeAst — leaf passthrough', () => {
  it('passes through boolean literal true', () => {
    assert.equal(normalizeAst(true), true);
  });

  it('passes through string literal', () => {
    assert.equal(normalizeAst('foo'), 'foo');
  });

  it('passes through number literal', () => {
    assert.equal(normalizeAst(42), 42);
  });

  it('passes through null', () => {
    assert.equal(normalizeAst(null), null);
  });

  it('passes through variable reference', () => {
    assert.deepEqual(normalizeAst(v('name')), v('name'));
  });

  it('passes through date literal', () => {
    assert.deepEqual(normalizeAst(date('2026-01-01')), date('2026-01-01'));
  });

  it('passes through array literal', () => {
    const arr: LoweredExpr = ['a', 'b', 'c'];
    assert.deepEqual(normalizeAst(arr), arr);
  });

  it('passes through simple eq unchanged', () => {
    const input = op('eq', v('flagged'), true);
    assert.deepEqual(normalizeAst(input), input);
  });

  it('does not mutate the original node', () => {
    const input = op('and',
      op('not', op('not', op('eq', v('flagged'), true))),
      op('eq', 'bar', v('name'))
    );
    const inputStr = JSON.stringify(input);
    normalizeAst(input);
    assert.equal(JSON.stringify(input), inputStr, 'input should not be mutated');
  });
});

// ── 8. Combined transforms ────────────────────────────────────────────────

describe('normalizeAst — combined', () => {
  it('applies all transforms in one pass', () => {
    // Input: and(
    //   not(not(eq(true, {var:"flagged"}))),    ← double-not + LHS swap
    //   and(                                    ← flattened into parent
    //     eq({var:"name"}, "foo"),
    //     container("tag", eq({var:"name"}, "Work"))
    //   )
    // )
    //
    // Expected after normalization:
    //   1. double-not eliminated: eq(true, flagged) → eq(flagged, true) [LHS swap]
    //   2. inner and flattened: 3 children at top level
    //   3. sorted: eq(name) [tier0, field='2_name'] < eq(flagged) [tier0, field='3_flagged']
    //                < container [tier3]
    const input = op('and',
      op('not', op('not', op('eq', true, v('flagged')))),
      op('and',
        op('eq', v('name'), 'foo'),
        op('container', 'tag', op('eq', v('name'), 'Work'))
      )
    );

    const result = normalizeAst(input) as any;

    assert.equal(result.op, 'and');
    assert.equal(result.args.length, 3);

    // args[0]: eq(name, "foo") — 'name' field key '2_name' sorts first
    assert.equal(result.args[0].op, 'eq');
    assert.deepEqual(result.args[0].args[0], v('name'));
    assert.equal(result.args[0].args[1], 'foo');

    // args[1]: eq(flagged, true) — LHS swapped + double-not removed, field key '3_flagged'
    assert.equal(result.args[1].op, 'eq');
    assert.deepEqual(result.args[1].args[0], v('flagged'));
    assert.equal(result.args[1].args[1], true);

    // args[2]: container (tier 3)
    assert.equal(result.args[2].op, 'container');
  });
});
