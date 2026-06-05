/**
 * P-001 — BlueprintSchema is the validator-of-record. These tests pin the
 * default-filling, the discriminated spine-action union, the loose header
 * schema, and round-trip idempotence (parse(parse(x)) === parse(x)).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BlueprintSchema, BlueprintHeaderSchema, SpineActionSchema } from './schema.js';

/** Smallest blueprint that satisfies the required fields (id, workItem.kind, spine.edges). */
const minimal = {
  id: 'mini',
  workItem: { kind: 'feature' },
  spine: {
    edges: {
      DONE: { to: 'done' },
      NEXT_WORKER: { to: 'role', role: 'worker', extras: ['FEATURE_ID={feature}'] },
    },
  },
};

test('BlueprintSchema — minimal blueprint parses and fills defaults', () => {
  const bp = BlueprintSchema.parse(minimal);
  assert.equal(bp.id, 'mini');
  assert.equal(bp.version, '0.1.0');
  // workItem default idPrefix.
  assert.equal(bp.workItem.kind, 'feature');
  assert.equal(bp.workItem.idPrefix, 'W');
  // spine defaults.
  assert.equal(bp.spine.decider, 'director');
  assert.equal(bp.spine.maxTurns, 200);
  assert.deepEqual(bp.spine.default, { to: 'idle' });
  // layer defaults.
  assert.deepEqual(bp.roles, []);
  assert.equal(bp.planner.kind, 'none');
  assert.deepEqual(bp.reactive, []);
  assert.deepEqual(bp.gates.approvals, []);
  assert.equal(bp.recursion.enabled, false);
  assert.equal(bp.recursion.strategy, 'escalate');
  assert.equal(bp.recursion.maxDepth, 1);
  // knobs default — coding-style requiresRepo defaults true.
  assert.equal(bp.knobs.requiresRepo, true);
});

test('BlueprintSchema — role spine action fills extras/rejectWhenParallel defaults', () => {
  const bp = BlueprintSchema.parse({
    ...minimal,
    spine: { edges: { NEXT_SECURITY: { to: 'role', role: 'security-reviewer' } } },
  });
  const edge = bp.spine.edges.NEXT_SECURITY;
  assert.equal(edge.to, 'role');
  if (edge.to === 'role') {
    assert.deepEqual(edge.extras, []);
    assert.equal(edge.rejectWhenParallel, false);
  }
});

test('BlueprintRoleSchema — role `isolation` is an optional worktree/none enum (BRIEF-demo-blueprints ②)', () => {
  // a role can declare worktree isolation (migration's transformer); it survives.
  const isolated = BlueprintSchema.parse({
    ...minimal,
    roles: [{ id: 'transformer', isolation: 'worktree' }],
  });
  assert.equal(isolated.roles[0]!.isolation, 'worktree');
  // omitted → undefined (default shared-tree behavior, no field invented).
  const bare = BlueprintSchema.parse({ ...minimal, roles: [{ id: 'discoverer' }] });
  assert.equal(bare.roles[0]!.isolation, undefined);
  // an invalid isolation value is rejected by the enum.
  assert.throws(() => BlueprintSchema.parse({ ...minimal, roles: [{ id: 'x', isolation: 'sandbox' }] }));
});

test('SpineActionSchema — discriminated union rejects an unknown action kind', () => {
  assert.throws(() => SpineActionSchema.parse({ to: 'teleport' }));
  // valid arms parse.
  assert.deepEqual(SpineActionSchema.parse({ to: 'done' }), { to: 'done' });
  assert.equal(SpineActionSchema.parse({ to: 'escalate', reasonFrom: 'arg' }).to, 'escalate');
});

test('BlueprintSchema — rejects a blueprint missing required fields', () => {
  assert.throws(() => BlueprintSchema.parse({ id: 'x' })); // no workItem / spine
  assert.throws(() => BlueprintSchema.parse({ id: 'x', workItem: { kind: 'feature' } })); // no spine
});

// ── dispatch: — the declared autoloop dispatch policy ───────────────────────
// autoloop-pot-operator-rebuild-2026-06-05 D-005 (P-005): the last "lift
// hardcoded → declarative" for the autoloop.

test('DispatchSchema — optional: an undeclared dispatch stays undefined (pot / launch blueprints)', () => {
  const bp = BlueprintSchema.parse(minimal);
  assert.equal(bp.dispatch, undefined);
});

test('DispatchSchema — a bare dispatch section fills the legacy-equivalent defaults', () => {
  const bp = BlueprintSchema.parse({ ...minimal, dispatch: {} });
  assert.ok(bp.dispatch);
  // priority defaults to the only implemented mode.
  assert.equal(bp.dispatch.priority, 'plan-order');
  // readiness defaults to the legacy needs-work set (todo/failing + the
  // pending/failed FeatureRecord aliases) — byte-equivalent to the hardcoded
  // NEEDS_WORK the orchestrator used pre-lift.
  assert.deepEqual(bp.dispatch.readiness, ['todo', 'failing', 'pending', 'failed']);
  // concurrency / costCapUsd / safetyCeiling stay undeclared (the orchestrator
  // then falls back to per-install config + imperative defaults).
  assert.equal(bp.dispatch.concurrency, undefined);
  assert.equal(bp.dispatch.costCapUsd, undefined);
  assert.equal(bp.dispatch.safetyCeiling, undefined);
});

test('DispatchSchema — a full coding-style policy parses + round-trips', () => {
  const bp = BlueprintSchema.parse({
    ...minimal,
    dispatch: {
      concurrency: 4,
      priority: 'plan-order',
      readiness: ['todo', 'failing'],
      costCapUsd: 25,
      safetyCeiling: 8,
    },
  });
  assert.deepEqual(bp.dispatch, {
    concurrency: 4,
    priority: 'plan-order',
    readiness: ['todo', 'failing'],
    costCapUsd: 25,
    safetyCeiling: 8,
  });
  // idempotent (validator-of-record round-trips, like the rest of the schema).
  assert.deepEqual(BlueprintSchema.parse(bp), bp);
});

test('DispatchSchema — rejects degenerate values', () => {
  // concurrency must be a positive integer.
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { concurrency: 0 } }));
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { concurrency: -1 } }));
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { concurrency: 2.5 } }));
  // priority is a closed enum — an unimplemented mode is rejected, not stored.
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { priority: 'fifo' } }));
  // readiness must be a non-empty list of non-empty statuses.
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { readiness: [] } }));
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { readiness: [''] } }));
  // safetyCeiling / costCapUsd must be positive.
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { safetyCeiling: 0 } }));
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { costCapUsd: 0 } }));
});

test('BlueprintSchema — parse is idempotent (validator-of-record round-trips)', () => {
  const once = BlueprintSchema.parse(minimal);
  const twice = BlueprintSchema.parse(once);
  assert.deepEqual(twice, once);
});

test('BlueprintHeaderSchema — reads id + extends, keeps extra fields (loose)', () => {
  const h = BlueprintHeaderSchema.parse({
    id: 'coding-fork',
    extends: 'coding',
    spine: { edges: {} }, // an unknown-to-the-header field — preserved, not stripped.
  });
  assert.equal(h.id, 'coding-fork');
  assert.equal(h.extends, 'coding');
  assert.ok('spine' in h, 'loose header preserves non-header fields for the merge');
});

test('BlueprintHeaderSchema — extends can be a string or an array', () => {
  assert.equal(BlueprintHeaderSchema.parse({ id: 'a', extends: 'base' }).extends, 'base');
  assert.deepEqual(BlueprintHeaderSchema.parse({ id: 'a', extends: ['base', 'coding'] }).extends, [
    'base',
    'coding',
  ]);
});
