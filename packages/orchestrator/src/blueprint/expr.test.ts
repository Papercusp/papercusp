/**
 * P-001 / D-005 — the spine-condition expression evaluator. Pins the operators,
 * precedence, path resolution, truthiness, and the safety boundary (no eval).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { evalExpr, parseExpr, isValidExpr, readPath, truthy } from './expr.js';

test('comparisons — numeric', () => {
  assert.equal(evalExpr('1 < 2', {}), true);
  assert.equal(evalExpr('2 <= 2', {}), true);
  assert.equal(evalExpr('3 > 2', {}), true);
  assert.equal(evalExpr('3 >= 4', {}), false);
  assert.equal(evalExpr('2 == 2', {}), true);
  assert.equal(evalExpr('2 != 3', {}), true);
});

test('paths resolve against scope (dotted + bracket index)', () => {
  const scope = { tally: { margin: 0.7, mean_conf: 0.6, advocate_veto: false }, payload: { quorum: 3 } };
  assert.equal(evalExpr('tally.margin >= 0.5', scope), true);
  assert.equal(evalExpr('tally.mean_conf >= 0.6', scope), true);
  assert.equal(evalExpr('tally.advocate_veto', scope), false);
  assert.equal(evalExpr('NOT tally.advocate_veto', scope), true);
  assert.deepEqual(readPath({ a: [{ b: 9 }] }, ['a', 0, 'b']), 9);
});

test('the canonical vote gate condition', () => {
  const expr = 'tally.margin >= 0.5 AND tally.mean_conf >= 0.6 AND NOT tally.advocate_veto';
  assert.equal(evalExpr(expr, { tally: { margin: 0.6, mean_conf: 0.7, advocate_veto: false } }), true);
  // any clause false → false
  assert.equal(evalExpr(expr, { tally: { margin: 0.4, mean_conf: 0.7, advocate_veto: false } }), false);
  assert.equal(evalExpr(expr, { tally: { margin: 0.6, mean_conf: 0.5, advocate_veto: false } }), false);
  assert.equal(evalExpr(expr, { tally: { margin: 0.6, mean_conf: 0.7, advocate_veto: true } }), false);
});

test('the canonical collect until condition', () => {
  const expr = 'posts >= payload.quorum OR elapsed > payload.timeout_s';
  assert.equal(evalExpr(expr, { posts: 3, payload: { quorum: 3, timeout_s: 300 }, elapsed: 5 }), true);
  assert.equal(evalExpr(expr, { posts: 1, payload: { quorum: 3, timeout_s: 300 }, elapsed: 400 }), true);
  assert.equal(evalExpr(expr, { posts: 1, payload: { quorum: 3, timeout_s: 300 }, elapsed: 5 }), false);
});

test('precedence — OR binds looser than AND; NOT binds tightest', () => {
  // false AND false OR true  →  (false AND false) OR true  →  true
  assert.equal(evalExpr('false AND false OR true', {}), true);
  // true OR false AND false  →  true OR (false AND false)  →  true
  assert.equal(evalExpr('true OR false AND false', {}), true);
  // NOT false AND true  →  (NOT false) AND true  →  true
  assert.equal(evalExpr('NOT false AND true', {}), true);
});

test('parentheses override precedence', () => {
  assert.equal(evalExpr('(false AND false) OR true', {}), true);
  assert.equal(evalExpr('false AND (false OR true)', {}), false);
  assert.equal(evalExpr('NOT (true AND false)', {}), true);
});

test('symbolic operator aliases && || !', () => {
  assert.equal(evalExpr('true && false', {}), false);
  assert.equal(evalExpr('true || false', {}), true);
  assert.equal(evalExpr('!false', {}), true);
});

test('string + boolean + null literals', () => {
  assert.equal(evalExpr("'a' == 'a'", {}), true);
  assert.equal(evalExpr("'a' != 'b'", {}), true);
  assert.equal(evalExpr('x == null', { x: null }), true);
  assert.equal(evalExpr('x == null', { x: 1 }), false);
  assert.equal(evalExpr('flag', { flag: true }), true);
});

test('bare-path truthiness guard (deliberate ladder)', () => {
  assert.equal(evalExpr('asked.answered', { asked: { answered: true } }), true);
  assert.equal(evalExpr('NOT asked.answered', { asked: { answered: false } }), true);
  assert.equal(evalExpr('voted.resolved', { voted: { resolved: true } }), true);
  // missing path → undefined → falsy (never throws)
  assert.equal(evalExpr('voted.resolved', {}), false);
});

test('truthiness: empty array/object falsy, non-empty truthy', () => {
  assert.equal(truthy([]), false);
  assert.equal(truthy([1]), true);
  assert.equal(truthy({}), false);
  assert.equal(truthy({ a: 1 }), true);
  assert.equal(truthy(''), false);
  assert.equal(truthy('x'), true);
  assert.equal(truthy(0), false);
  assert.equal(truthy(null), false);
});

test('numeric-string coercion in comparisons', () => {
  assert.equal(evalExpr('a >= b', { a: '3', b: 2 }), true);
  assert.equal(evalExpr('a == b', { a: '2', b: 2 }), true);
});

test('parse errors throw; isValidExpr reports', () => {
  assert.throws(() => parseExpr('1 +'));
  assert.throws(() => parseExpr('(1 < 2'));
  assert.throws(() => parseExpr(''));
  assert.equal(isValidExpr('a.b >= 1'), true);
  assert.equal(isValidExpr('a >= '), false);
  assert.equal(isValidExpr('a.b AND'), false);
});

test('safety: no host access / function calls', () => {
  // `foo()` is not a valid primary — function-call syntax must not parse.
  assert.throws(() => parseExpr('process.exit(1)'));
  assert.throws(() => parseExpr('a = 1'));
});
