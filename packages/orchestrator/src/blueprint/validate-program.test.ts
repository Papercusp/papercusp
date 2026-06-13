/**
 * P-005 — program-mode blueprint validation: spine-mode exclusivity, gate
 * fallback, expression parseability, and the optional knownOps op-name check.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BlueprintSchema } from './schema.js';
import { validateBlueprint } from './validate.js';

const programBp = (over: Record<string, unknown> = {}) =>
  BlueprintSchema.parse({
    id: 'vote-test',
    workItem: { kind: 'decision', idPrefix: 'VOTE' },
    roles: [{ id: 'voter' }, { id: 'advocate' }],
    spine: {
      steps: [
        { id: 'open', op: 'coord:thread-open', args: { title: '{{ payload.question }}' }, bind: 'thread' },
        { id: 'collect', op: 'coord:collect', args: { quorum: '{{ payload.quorum }}' }, bind: 'collected' },
        { id: 'agg', op: 'vote:aggregate', args: {}, bind: 'tally' },
      ],
      gate: [
        { when: { 'tally.margin': { gte: 0.5 } }, op: 'resolve', args: {} },
        { else: true, op: 'coord:escalate', args: {} },
      ],
    },
    ...over,
  });

test('valid program blueprint passes', () => {
  const v = validateBlueprint(programBp());
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('program roles are not flagged dead (spawned by ops, not edges)', () => {
  const v = validateBlueprint(programBp());
  assert.equal(v.warnings.some((w) => w.code === 'unused-role'), false);
});

test('spine-mode: both edges and steps is an error', () => {
  const v = validateBlueprint(
    programBp({
      spine: {
        edges: { DONE: { to: 'done' } },
        steps: [{ id: 'open', op: 'coord:thread-open' }],
        gate: [{ else: true, op: 'resolve' }],
      },
    }),
  );
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'spine-mode'));
});

test('gate with no fallback is rejected', () => {
  const v = validateBlueprint(
    programBp({
      spine: {
        steps: [{ id: 'agg', op: 'vote:aggregate', bind: 'tally' }],
        gate: [{ when: { 'tally.margin': { gte: 0.5 } }, op: 'resolve' }],
      },
    }),
  );
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'gate-no-fallback'));
});

test('steps without a gate is valid — a deterministic pipeline (P-010)', () => {
  // deterministic-blueprints-migration-2026-06-13 P-010: a gateless steps
  // program is the deterministic-pipeline shape — it resolves by running every
  // step, with no decision fork. The old `gate-missing` rejection was removed
  // (see validate.ts §"Two program shapes"); a well-formed gateless program is
  // therefore valid.
  const v = validateBlueprint(
    programBp({ spine: { steps: [{ id: 'agg', op: 'vote:aggregate' }] } }),
  );
  assert.equal(v.ok, true);
  assert.ok(!v.errors.some((e) => e.code === 'gate-missing'));
});

test('an invalid when (not a DataCondition) is rejected at schema parse', () => {
  // The canonical `when` is a @papercusp/rules MatchMap (adopt-event-rules-engines
  // D-002); a bare string expression is no longer a valid when and the schema
  // rejects it at parse — the primary enforcement.
  const parsed = BlueprintSchema.safeParse({
    id: 'vote-test',
    workItem: { kind: 'decision', idPrefix: 'VOTE' },
    roles: [{ id: 'voter' }],
    spine: {
      steps: [{ id: 'agg', op: 'vote:aggregate', when: 'margin >=', bind: 'tally' }],
      gate: [{ else: true, op: 'resolve' }],
    },
  });
  assert.equal(parsed.success, false);
});

test('validate.ts flags bad-step-when on a raw blueprint with an invalid when', () => {
  // The secondary net: a raw (un-schema-parsed) blueprint whose when is not a
  // DataCondition is caught by validate.ts. A leftover STRING-expr `when` (the
  // pre-adopt-event-rules-engines form) is the realistic bad value: a string
  // fails every dataConditionSchema branch (incl. the permissive match-map
  // record, which requires an object). NB an object like `{ all: <non-array> }`
  // is NOT a valid fixture here — it parses as the match-map `{ "all": <value> }`,
  // since the `all`/`any`/`not` combinators only bind as the sole strict key.
  // The blueprint is also raw (no `gates`/`recursion`) — validateBlueprint must
  // tolerate that (it's run author-time over un-parsed blueprints too).
  const raw = {
    id: 'vote-test',
    workItem: { kind: 'decision', idPrefix: 'VOTE' },
    roles: [{ id: 'voter' }],
    knobs: {},
    spine: {
      decider: 'director',
      maxTurns: 200,
      default: { to: 'idle' },
      steps: [{ id: 'agg', op: 'vote:aggregate', when: 'tally.margin >= 0.5', bind: 'tally' }],
      gate: [{ else: true, op: 'resolve', args: {} }],
    },
    planner: { kind: 'none' },
    reactive: [],
  } as unknown as Parameters<typeof validateBlueprint>[0];
  const v = validateBlueprint(raw);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'bad-step-when'));
});

test('duplicate step ids rejected', () => {
  const v = validateBlueprint(
    programBp({
      spine: {
        steps: [
          { id: 'dup', op: 'coord:thread-open' },
          { id: 'dup', op: 'vote:aggregate' },
        ],
        gate: [{ else: true, op: 'resolve' }],
      },
    }),
  );
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'duplicate-step'));
});

test('knownOps: unknown op is an error when the registry is supplied', () => {
  const known = new Set(['coord:thread-open', 'coord:collect', 'vote:aggregate', 'resolve', 'coord:escalate']);
  assert.equal(validateBlueprint(programBp(), { knownOps: known }).ok, true);

  const withBadOp = programBp({
    spine: {
      steps: [{ id: 'x', op: 'coord:nonexistent', bind: 'r' }],
      gate: [{ else: true, op: 'resolve' }],
    },
  });
  const v = validateBlueprint(withBadOp, { knownOps: known });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'unknown-op'));
});

test('decider-mode blueprints still validate unchanged', () => {
  const coding = BlueprintSchema.parse({
    id: 'c',
    workItem: { kind: 'feature' },
    roles: [{ id: 'director' }, { id: 'worker' }],
    spine: {
      decider: 'director',
      edges: { DONE: { to: 'done' }, NEXT_WORKER: { to: 'role', role: 'worker' } },
    },
  });
  assert.equal(validateBlueprint(coding).ok, true);
});
