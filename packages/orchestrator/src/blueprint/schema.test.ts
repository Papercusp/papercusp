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
