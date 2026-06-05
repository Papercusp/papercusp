/**
 * BRIEF-demo-blueprints ② — the `migration` blueprint loads, resolves (extends
 * base), validates clean, and drives a smoke migration through `deriveNext` to
 * `done`. A NEW orchestration shape (discover sites → transform each in isolation →
 * verify), so there is no legacy path to byte-match — the test asserts the spine is
 * well-formed, every edge resolves, and the transformer carries `isolation: worktree`
 * (the key demo — the role-level worktree-isolation declaration the schema now
 * supports).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { harnessPath } from '@papercusp/harness/paths';
import { loadBuiltinBlueprint } from './loader.js';
import { deriveNext, type ParsedDecisionLike } from './derive-next.js';

const decision = (verb: string, arg: string | null = null): ParsedDecisionLike => ({ verb, arg, n: null });

test('migration blueprint loads + validates with no errors', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('migration');
  assert.equal(blueprint.id, 'migration');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(validation.errors.length, 0);
});

test('migration blueprint has the expected migration shape', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('migration');
  assert.equal(bp.workItem.kind, 'migration-task');
  assert.equal(bp.workItem.idPrefix, 'M');
  assert.equal(bp.spine.decider, 'migration-director');
  assert.equal(bp.knobs.requiresRepo, true);
  // migration vocabulary, distinct from coding/research
  for (const verb of ['NEXT_DISCOVERER', 'NEXT_TRANSFORMER', 'NEXT_VERIFIER']) {
    assert.ok(Object.prototype.hasOwnProperty.call(bp.spine.edges, verb), `missing edge ${verb}`);
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(bp.spine.edges, 'NEXT_WORKER'));
  // migration produces code changes → git-diff trace + regression signal (like coding)
  assert.equal(bp.gym?.collectTrace, 'git-diff');
  assert.deepEqual(bp.gym?.signals, ['regressionsFromTests']);
  // worktree machinery is on at the blueprint level, consistent with the role declaration
  assert.deepEqual(bp.knobs.worktrees, { enabled: true });
  // max concurrent transforms — migrated from `knobs.maxParallel` into the
  // declared dispatch policy (autoloop-pot-operator-rebuild-2026-06-05 D-005)
  assert.equal(bp.knobs.maxParallel, undefined);
  assert.equal(bp.dispatch?.concurrency, 4);
  // inherited from base
  assert.equal(bp.knobs.logRetention, 500);
});

test('the transformer role declares worktree isolation (the key demo)', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('migration');
  const transformer = bp.roles.find((r) => r.id === 'transformer');
  assert.ok(transformer, 'transformer role declared');
  // the schema-level `isolation` field survives the load (would be stripped without it)
  assert.equal(transformer!.isolation, 'worktree');
  // other roles default to no isolation (omitted → undefined)
  const discoverer = bp.roles.find((r) => r.id === 'discoverer');
  assert.equal(discoverer!.isolation, undefined);
});

test('every migration role has a resolvable prompt file', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('migration');
  for (const role of bp.roles) {
    const p = harnessPath('prompts', `${role.id}.md`);
    assert.ok(existsSync(p), `missing prompt for migration role "${role.id}" at ${p}`);
  }
});

test('deriveNext drives a smoke migration through every edge to done', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('migration');
  const spine = bp.spine;
  const M = 'M-001';

  // discover sites → dispatches the discoverer
  assert.deepEqual(deriveNext(spine, decision('NEXT_DISCOVERER', M), M), {
    kind: 'dispatch',
    role: 'discoverer',
    feature: M,
    extras: [`FEATURE_ID=${M}`],
  });
  // transform a site → dispatches the (worktree-isolated) transformer
  assert.deepEqual(deriveNext(spine, decision('NEXT_TRANSFORMER', M), M), {
    kind: 'dispatch',
    role: 'transformer',
    feature: M,
    extras: [`FEATURE_ID=${M}`],
  });
  // verify a site → dispatches the migration-verifier
  assert.deepEqual(deriveNext(spine, decision('NEXT_VERIFIER', M), M), {
    kind: 'dispatch',
    role: 'migration-verifier',
    feature: M,
    extras: [`FEATURE_ID=${M}`],
  });
  // ESCALATE carries its reason from the arg
  assert.deepEqual(deriveNext(spine, decision('ESCALATE', 'site failed thrice'), M), {
    kind: 'terminal',
    outcome: 'escalate',
    reason: 'site failed thrice',
  });
  // IDLE stops cleanly; DONE terminates; unknown verb + null fall to default (idle)
  assert.deepEqual(deriveNext(spine, decision('IDLE'), M), { kind: 'terminal', outcome: 'idle' });
  assert.deepEqual(deriveNext(spine, decision('DONE'), M), { kind: 'terminal', outcome: 'done' });
  assert.deepEqual(deriveNext(spine, decision('NONSENSE_VERB'), M), { kind: 'terminal', outcome: 'idle' });
  assert.deepEqual(deriveNext(spine, null, M), { kind: 'terminal', outcome: 'idle' });
});
