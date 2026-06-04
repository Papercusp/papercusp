/**
 * P-005 / D-005 — the pure coord-op-program interpreter. Pins step planning
 * (when-guards + arg interpolation) and gate-branch selection.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { planStep, selectGateBranch, isProgramSpine } from './program.js';
import { CoordOpStepSchema, GateBranchSchema } from './schema.js';

const step = (o: Record<string, unknown>) => CoordOpStepSchema.parse(o);
const branch = (o: Record<string, unknown>) => GateBranchSchema.parse(o);

test('planStep — invoke with interpolated args + bind', () => {
  const s = step({ id: 'open', op: 'coord:thread-open', args: { title: '{{ payload.question }}' }, bind: 'thread' });
  const plan = planStep(s, { payload: { question: 'Ship?' } });
  assert.equal(plan.kind, 'invoke');
  if (plan.kind === 'invoke') {
    assert.equal(plan.op, 'coord:thread-open');
    assert.deepEqual(plan.args, { title: 'Ship?' });
    assert.equal(plan.bind, 'thread');
  }
});

test('planStep — skip when the guard is false', () => {
  const s = step({ id: 'vote', op: 'coord:vote', args: {}, when: 'NOT asked.answered' });
  assert.equal(planStep(s, { asked: { answered: true } }).kind, 'skip');
  assert.equal(planStep(s, { asked: { answered: false } }).kind, 'invoke');
});

test('planStep — no when always invokes', () => {
  const s = step({ id: 'x', op: 'coord:thread-post', args: {} });
  assert.equal(planStep(s, {}).kind, 'invoke');
});

test('selectGateBranch — first matching when, in order', () => {
  const gate = [
    branch({ when: 'tally.margin >= 0.5 AND NOT tally.advocate_veto', op: 'resolve', args: { decision: '{{ tally.winner }}' } }),
    branch({ else: true, op: 'coord:escalate', args: { summary: 'split' } }),
  ];
  // decisive
  const decisive = selectGateBranch(gate, { tally: { margin: 0.8, advocate_veto: false, winner: 'yes' } });
  assert.equal(decisive?.op, 'resolve');
  assert.deepEqual(decisive?.args, { decision: 'yes' });
  // split → fallback
  const split = selectGateBranch(gate, { tally: { margin: 0.2, advocate_veto: false, winner: 'yes' } });
  assert.equal(split?.op, 'coord:escalate');
  assert.equal(split?.index, 1);
  // advocate veto → fallback
  const veto = selectGateBranch(gate, { tally: { margin: 0.9, advocate_veto: true, winner: 'yes' } });
  assert.equal(veto?.op, 'coord:escalate');
});

test('selectGateBranch — fallback via omitted when', () => {
  const gate = [
    branch({ when: 'asked.answered', op: 'resolve', args: {} }),
    branch({ op: 'coord:escalate', args: {} }), // no when, no else → fallback
  ];
  assert.equal(selectGateBranch(gate, { asked: { answered: false } })?.op, 'coord:escalate');
});

test('selectGateBranch — null when nothing matches and no fallback', () => {
  const gate = [branch({ when: 'asked.answered', op: 'resolve', args: {} })];
  assert.equal(selectGateBranch(gate, { asked: { answered: false } }), null);
  assert.equal(selectGateBranch([], {}), null);
  assert.equal(selectGateBranch(undefined, {}), null);
});

test('isProgramSpine', () => {
  assert.equal(isProgramSpine({ steps: [step({ id: 'a', op: 'x' })] }), true);
  assert.equal(isProgramSpine({ steps: [] }), false);
  assert.equal(isProgramSpine({}), false);
});
