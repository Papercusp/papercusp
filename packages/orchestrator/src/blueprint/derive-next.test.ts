/**
 * Direct unit coverage of `deriveNext` — the pure blueprint-spine interpreter
 * (harness-blueprint-orchestration-2026-06-03 P-003, D-024). The demo-blueprint
 * tests (review/research/gym/migration) exercise it through *real loaded* spines;
 * this file pins the interpreter's OWN branches against SYNTHETIC spines so each
 * arm of `actionFor` + the `templateExtras` substitution + the edge/default
 * lookup is covered in isolation — no loader, no fs, no PG.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SpineSchema, type BlueprintSpine } from './schema.js';
import { deriveNext, type ParsedDecisionLike } from './derive-next.js';

const decision = (
  verb: string,
  arg: string | null = null,
  n: number | null = null,
): ParsedDecisionLike => ({ verb, arg, n });

/**
 * Build a validated synthetic spine. Parsing through `SpineSchema` fills the
 * action defaults (`extras: []`, `rejectWhenParallel: false`) exactly as the
 * loader would, so the test exercises the same shapes production hands the
 * interpreter.
 */
const spine = (edges: Record<string, unknown>, dflt: unknown = { to: 'idle' }): BlueprintSpine =>
  SpineSchema.parse({ decider: 'd', edges, default: dflt });

test('role edge dispatches with {feature} + {arg} templated extras (arg present)', () => {
  const s = spine({ GO: { to: 'role', role: 'worker', extras: ['FEATURE_ID={feature}', 'VAL_ID={arg}'] } });
  // arg present → feature === arg; both placeholders resolve to it.
  assert.deepEqual(deriveNext(s, decision('GO', 'F-007'), 'F-DEFAULT'), {
    kind: 'dispatch',
    role: 'worker',
    feature: 'F-007',
    extras: ['FEATURE_ID=F-007', 'VAL_ID=F-007'],
  });
});

test('role edge: arg absent → {feature} falls back to defaultFeature, {arg} → empty', () => {
  const s = spine({ GO: { to: 'role', role: 'worker', extras: ['FEATURE_ID={feature}', 'VAL_ID={arg}'] } });
  assert.deepEqual(deriveNext(s, decision('GO', null), 'F-DEFAULT'), {
    kind: 'dispatch',
    role: 'worker',
    feature: 'F-DEFAULT',
    extras: ['FEATURE_ID=F-DEFAULT', 'VAL_ID='],
  });
});

test('terminal edges — done and idle', () => {
  const s = spine({ DONE: { to: 'done' }, STOP: { to: 'idle' } });
  assert.deepEqual(deriveNext(s, decision('DONE'), 'F'), { kind: 'terminal', outcome: 'done' });
  assert.deepEqual(deriveNext(s, decision('STOP'), 'F'), { kind: 'terminal', outcome: 'idle' });
});

test('escalate — reasonFrom:arg prefers the decision arg, falls back to reason', () => {
  const s = spine({ ESC: { to: 'escalate', reasonFrom: 'arg', reason: 'fallback' } });
  // arg present → reason carries the arg
  assert.deepEqual(deriveNext(s, decision('ESC', 'out of scope'), 'F'), {
    kind: 'terminal',
    outcome: 'escalate',
    reason: 'out of scope',
  });
  // arg null → falls back to the static reason
  assert.deepEqual(deriveNext(s, decision('ESC', null), 'F'), {
    kind: 'terminal',
    outcome: 'escalate',
    reason: 'fallback',
  });
});

test('escalate — a static reason (no reasonFrom) ignores the arg; bare → empty string', () => {
  const s = spine({
    FIXED: { to: 'escalate', reason: 'static reason' },
    BARE: { to: 'escalate' },
  });
  assert.deepEqual(deriveNext(s, decision('FIXED', 'ignored-arg'), 'F'), {
    kind: 'terminal',
    outcome: 'escalate',
    reason: 'static reason',
  });
  // No reason + no reasonFrom → '' (NOT undefined — a stray `reason: undefined`
  // key would break the P-003 deep-strict-equality equivalence proof).
  const bare = deriveNext(s, decision('BARE'), 'F');
  assert.deepEqual(bare, { kind: 'terminal', outcome: 'escalate', reason: '' });
});

test('role + rejectWhenParallel: an N=k (parallel-lane) decision → unsupported "verb N=k"', () => {
  const s = spine({
    NEXT_WORKER: { to: 'role', role: 'worker', extras: ['FEATURE_ID={feature}'], rejectWhenParallel: true },
  });
  // n set → the per-feature pipeline rejects the parallel-lane dispatch (D-001)
  assert.deepEqual(deriveNext(s, decision('NEXT_WORKER', 'F-1', 3), 'F-1'), {
    kind: 'unsupported',
    verb: 'NEXT_WORKER N=3',
  });
  // n null → ordinary single-lane dispatch
  assert.deepEqual(deriveNext(s, decision('NEXT_WORKER', 'F-1', null), 'F-1'), {
    kind: 'dispatch',
    role: 'worker',
    feature: 'F-1',
    extras: ['FEATURE_ID=F-1'],
  });
});

test('role WITHOUT rejectWhenParallel ignores n entirely', () => {
  const s = spine({ NEXT_VALIDATOR: { to: 'role', role: 'validator', extras: [] } });
  assert.deepEqual(deriveNext(s, decision('NEXT_VALIDATOR', 'F-1', 5), 'F-1'), {
    kind: 'dispatch',
    role: 'validator',
    feature: 'F-1',
    extras: [],
  });
});

test('unsupported edge carries the parsed verb through', () => {
  const s = spine({ NEXT_HARNESS: { to: 'unsupported' } });
  assert.deepEqual(deriveNext(s, decision('NEXT_HARNESS'), 'F'), {
    kind: 'unsupported',
    verb: 'NEXT_HARNESS',
  });
});

test('an unmapped verb AND a null decision both fall to spine.default', () => {
  const s = spine({ DONE: { to: 'done' } }, { to: 'idle' });
  assert.deepEqual(deriveNext(s, decision('WHO_KNOWS'), 'F'), { kind: 'terminal', outcome: 'idle' });
  assert.deepEqual(deriveNext(s, null, 'F'), { kind: 'terminal', outcome: 'idle' });
});

test('default may itself be a role dispatch — null decision uses defaultFeature + empty arg', () => {
  const s = spine({}, { to: 'role', role: 'scoper', extras: ['FEATURE_ID={feature}', 'A={arg}'] });
  assert.deepEqual(deriveNext(s, null, 'F-DEF'), {
    kind: 'dispatch',
    role: 'scoper',
    feature: 'F-DEF',
    extras: ['FEATURE_ID=F-DEF', 'A='],
  });
});

test('program-mode spine (no edges) → every verb + null fall to default', () => {
  // A coord-op program spine omits `edges` (D-002); deriveNext treats an absent
  // map as "no edge for any verb" → the default, never throwing on the lookup.
  const s = SpineSchema.parse({ decider: 'prog', default: { to: 'done' } });
  assert.equal(s.edges, undefined);
  assert.deepEqual(deriveNext(s, decision('ANY_VERB', 'x'), 'F'), { kind: 'terminal', outcome: 'done' });
  assert.deepEqual(deriveNext(s, null, 'F'), { kind: 'terminal', outcome: 'done' });
});
