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
