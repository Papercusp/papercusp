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

/** id → expected (single decider role, trigger kind, trigger key). `trigger: 'none'` = an ON-DEMAND
 *  launch (no cadence/event trigger) — e.g. `scan`, whose scheduled cadence was RETIRED
 *  (sentinel-herald-2026-06-21 D-018/P-023: the Queen scans/places continuously + the Sentinel reads
 *  live state, so a competing scheduled sweep is gone) and now launches only via
 *  `system:blueprint-run { blueprintId: scan }`. */
const LAUNCHES: Record<string, { role: string; trigger: 'schedule' | 'event' | 'none'; key?: string }> = {
  deploy: { role: 'release-manager', trigger: 'schedule' },
  scan: { role: 'scanner', trigger: 'none' },
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
    // The trigger is DECLARED (D-004): a cadence (schedule) or an event key — OR, for an ON-DEMAND
    // launch (`trigger: 'none'`, e.g. scan after its scheduled cadence was retired), NO trigger at all
    // (so materializeBlueprintTriggers mints no routine; it launches via system:blueprint-run).
    if (expect.trigger === 'schedule') {
      assert.ok((blueprint.triggers?.schedule?.length ?? 0) >= 1, `${id} declares a schedule trigger`);
      assert.equal(blueprint.triggers?.event, undefined, `${id} declares no event trigger`);
    } else if (expect.trigger === 'none') {
      assert.equal(blueprint.triggers?.schedule?.length ?? 0, 0, `${id} (on-demand) declares no schedule trigger`);
      assert.equal(blueprint.triggers?.event, undefined, `${id} (on-demand) declares no event trigger`);
    } else {
      assert.equal(blueprint.triggers?.event, expect.key, `${id} declares event ${expect.key}`);
    }
  });
}

test('pot launch blueprint loads + validates — decider=operator, NO trigger (the wake is self-declared)', () => {
  // autoloop-pot-operator-rebuild-2026-06-05 P0 (D-001/D-002): the Pot is the
  // minimal single-role operator blueprint. It deliberately declares NO
  // triggers.schedule and NO triggers.event — its loop is the operator deciding
  // its own next wake (pot:declare-wake → the one-shot hive-wake routine /
  // event-reaction subscriptions), not a cadence. A schedule appearing here
  // would silently reintroduce the timer loop D-002 removes.
  const { blueprint, validation } = loadBuiltinBlueprint('coding');
  assert.equal(blueprint.id, 'coding');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.ok(!isProgramSpine(blueprint.spine), 'pot is a decider-mode spine');
  // Placement automation ON (owner mandate 2026-06-11; local-hive P-030): the
  // pot decider is the MUG placement persona (queen→mug, WI-2932); `operator`
  // remains the declared alternative for decision-tree-only wakes.
  assert.equal(blueprint.spine.decider, 'mug', 'the pot decider is the mug placement persona (P-030 swap)');
  assert.ok(blueprint.roles.some((r) => r.id === 'operator'), 'pot declares its operator role');
  assert.deepEqual(validation.warnings, [], 'pot has no validator warnings');
  assert.equal(blueprint.triggers?.schedule?.length ?? 0, 0, 'pot declares NO schedule trigger');
  assert.equal(blueprint.triggers?.event, undefined, 'pot declares NO event trigger');
  // A CODING hive MUST be backed by a git repo (per-hive-git-and-release-gate-2026-06-29
  // D-002): pot:create clones/inits a repo and rejects a repo-less coding hive. The
  // non-coding `work` blueprint (extends coding) re-sets this false.
  assert.equal(blueprint.knobs.requiresRepo, true, 'a coding hive must be repo-backed (per-hive-git D-002)');
});

test('bee launch blueprint loads + validates — decider=bee, kind:harness, NO trigger (the Queen places it)', () => {
  // local-hive-orchestration-2026-06-06 P-010/P-011: the bee is the Queen's
  // "place a fresh generic worker" primitive. It is a single-role decider-mode
  // blueprint (extends single-agent) whose decider IS the `bee` role; it is
  // kind:'harness' (a bee is NOT a hive) and declares NO trigger — the Queen's
  // placement loop fires it on demand, not a cadence/event.
  const { blueprint, validation } = loadBuiltinBlueprint('cup');
  assert.equal(blueprint.id, 'cup');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(blueprint.kind, 'harness', 'a bee is kind:harness, never a hive');
  assert.ok(!isProgramSpine(blueprint.spine), 'bee is a decider-mode spine');
  // Blueprint ID renamed bee→cup (cup-lexicon P-005, W2c); stale stored refs resolve via BLUEPRINT_ID_ALIASES.
  assert.equal(blueprint.spine.decider, 'cup', 'the bee blueprint decider IS the cup role');
  assert.ok(blueprint.roles.some((r) => r.id === 'cup'), 'bee blueprint declares its cup role');
  assert.deepEqual(validation.warnings, [], 'bee has no validator warnings');
  assert.equal(blueprint.triggers?.schedule?.length ?? 0, 0, 'bee declares NO schedule trigger');
  assert.equal(blueprint.triggers?.event, undefined, 'bee declares NO event trigger');
});

test('implement declares its learning-system gym block (FB-23 / P-048): drill-ground-truth signals over the fix diff', () => {
  // self-learning-frontier P-048: the implement worker is a registered gym target
  // judged on red-queen drill ground truth. The signal names must stay in lockstep
  // with GYM_SIGNAL_REGISTRY (operator-core lib/gym/primitives.ts) — the registry
  // side is pinned by learning-targets.test.ts; this pins the blueprint side.
  const { blueprint, validation } = loadBuiltinBlueprint('implement');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(blueprint.gym?.collectTrace, 'git-diff', 'the implement trace is the fix diff');
  assert.deepEqual(
    blueprint.gym?.signals,
    ['regressionsFromTests', 'drillResolveRate', 'drillMttsh'],
    'implement is judged on the regression guardrail + the drill resolve/MTTSH ground truth',
  );
});

test('judge roles declare the shared domain plus exactly one mission practice identity (R-3)', () => {
  const missions = [
    ['gym', 'judge-gym'],
    ['ensemble-solve', 'judge-ensemble'],
  ] as const;
  for (const [blueprintId, practiceId] of missions) {
    const { blueprint, validation } = loadBuiltinBlueprint(blueprintId);
    assert.equal(validation.ok, true, `${blueprintId} validation: ${JSON.stringify(validation.errors)}`);
    const judge = blueprint.roles.find((role) => role.id === 'judge');
    assert.ok(judge, `${blueprintId} declares a judge role`);
    assert.deepEqual(
      judge.stack,
      [`domain:judge-domain`, `practice:${practiceId}`],
      `${blueprintId} judge wears one domain and one mission practice`,
    );
  }
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
