/**
 * unify-agent-launches-as-blueprints-2026-06-04 — the built-in SINGLE-ROLE LAUNCH
 * blueprints (`deploy`, `scan`, `implement`, `merge-resolution`, `audit`) load,
 * merge `extends: base`, parse, validate (decider mode: a reachable terminal,
 * exactly one spine model), and declare exactly one role + a trigger. These are
 * the declarative replacements for the hand-wired invoke-callers (D-002/D-007).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint, resolveBlueprint } from './loader.js';
import { isProgramSpine } from '@papercusp/step-program';

/** id → expected (single decider role, trigger kind, trigger key). */
const LAUNCHES: Record<string, { role: string; trigger: 'schedule' | 'event'; key?: string }> = {
  deploy: { role: 'release-manager', trigger: 'schedule' },
  scan: { role: 'scanner', trigger: 'schedule' },
  implement: { role: 'worker', trigger: 'schedule' },
  'merge-resolution': { role: 'merge-resolver', trigger: 'event', key: 'git-sync:conflict' },
  audit: { role: 'auditor', trigger: 'event', key: 'feature:reaches-auditor-lane' },
};

for (const [id, expect] of Object.entries(LAUNCHES)) {
  test(`${id} launch blueprint loads + validates (single-role decider, declared trigger)`, () => {
    const { blueprint, validation } = loadBuiltinBlueprint(id);
    assert.equal(blueprint.id, id);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors));
    // A launch blueprint is a DECIDER-mode spine whose decider IS the launched role
    // (the degenerate single-role case, D-007) — not a coord-op program.
    assert.ok(!isProgramSpine(blueprint.spine), `${id} is a decider-mode spine`);
    assert.equal(blueprint.spine.decider, expect.role, `${id} decider is the launched role`);
    // The single role is declared (so prompt-resolve + caps have a hook).
    assert.ok(
      blueprint.roles.some((r) => r.id === expect.role),
      `${id} declares its role "${expect.role}"`,
    );
    // No validator warnings (a clean, well-formed declaration).
    assert.deepEqual(validation.warnings, [], `${id} has no validator warnings`);
    // The trigger is DECLARED (D-004): a cadence (schedule) or an event key.
    if (expect.trigger === 'schedule') {
      assert.ok((blueprint.triggers?.schedule?.length ?? 0) >= 1, `${id} declares a schedule trigger`);
      assert.equal(blueprint.triggers?.event, undefined, `${id} declares no event trigger`);
    } else {
      assert.equal(blueprint.triggers?.event, expect.key, `${id} declares event ${expect.key}`);
    }
  });
}

test('pot launch blueprint loads + validates — decider=operator, NO trigger (the wake is self-declared)', () => {
  // autoloop-pot-operator-rebuild-2026-06-05 P0 (D-001/D-002): the Pot is the
  // minimal single-role operator blueprint. It deliberately declares NO
  // triggers.schedule and NO triggers.event — its loop is the operator deciding
  // its own next wake (hive:declare-wake → the one-shot hive-wake routine /
  // event-reaction subscriptions), not a cadence. A schedule appearing here
  // would silently reintroduce the timer loop D-002 removes.
  const { blueprint, validation } = loadBuiltinBlueprint('hive');
  assert.equal(blueprint.id, 'hive');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.ok(!isProgramSpine(blueprint.spine), 'pot is a decider-mode spine');
  // Placement automation ON (owner mandate 2026-06-11; local-hive P-030): the
  // hive decider is the QUEEN placement persona; `operator` remains the
  // declared alternative for decision-tree-only wakes.
  assert.equal(blueprint.spine.decider, 'queen', 'the hive decider is the queen placement persona (P-030 swap)');
  assert.ok(blueprint.roles.some((r) => r.id === 'operator'), 'pot declares its operator role');
  assert.deepEqual(validation.warnings, [], 'pot has no validator warnings');
  assert.equal(blueprint.triggers?.schedule?.length ?? 0, 0, 'pot declares NO schedule trigger');
  assert.equal(blueprint.triggers?.event, undefined, 'pot declares NO event trigger');
  assert.equal(blueprint.knobs.requiresRepo, false, 'pot needs no repo');
});

test('bee launch blueprint loads + validates — decider=bee, kind:harness, NO trigger (the Queen places it)', () => {
  // local-hive-orchestration-2026-06-06 P-010/P-011: the bee is the Queen's
  // "place a fresh generic worker" primitive. It is a single-role decider-mode
  // blueprint (extends single-agent) whose decider IS the `bee` role; it is
  // kind:'harness' (a bee is NOT a hive) and declares NO trigger — the Queen's
  // placement loop fires it on demand, not a cadence/event.
  const { blueprint, validation } = loadBuiltinBlueprint('bee');
  assert.equal(blueprint.id, 'bee');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(blueprint.kind, 'harness', 'a bee is kind:harness, never a hive');
  assert.ok(!isProgramSpine(blueprint.spine), 'bee is a decider-mode spine');
  assert.equal(blueprint.spine.decider, 'bee', 'the bee decider IS the bee role');
  assert.ok(blueprint.roles.some((r) => r.id === 'bee'), 'bee declares its role');
  assert.deepEqual(validation.warnings, [], 'bee has no validator warnings');
  assert.equal(blueprint.triggers?.schedule?.length ?? 0, 0, 'bee declares NO schedule trigger');
  assert.equal(blueprint.triggers?.event, undefined, 'bee declares NO event trigger');
});

test('a user fork (extends: deploy) can swap the launched role without code', () => {
  // The forkability the unify plan buys: a fork declares a different role + model.
  const forked = resolveBlueprint({
    id: 'my-deploy',
    extends: 'deploy',
    spine: { decider: 'my-release-manager' },
    roles: [{ id: 'my-release-manager', description: 'my deploy gate' }],
  });
  assert.equal(forked.validation.ok, true, JSON.stringify(forked.validation.errors));
  assert.equal(forked.blueprint.spine.decider, 'my-release-manager');
  // inherited trigger (not overridden) survives the merge.
  assert.equal(forked.blueprint.triggers?.schedule?.length, 1);
});
