/**
 * BRIEF-demo-blueprints ① — the `review` blueprint loads, resolves (extends base),
 * validates clean, and drives a smoke review through `deriveNext` to `done`. A
 * NEW orchestration shape (parallel-dimension review → adversarial verify →
 * synthesize), so there is no legacy path to byte-match — the test asserts the
 * spine is well-formed and every edge resolves.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolvePromptFile } from '../prompt-resolve.js';
import { harnessPath } from '@papercusp/harness/paths';
import { loadBuiltinBlueprint } from './loader.js';
import { deriveNext, type ParsedDecisionLike } from './derive-next.js';

const decision = (verb: string, arg: string | null = null): ParsedDecisionLike => ({ verb, arg, n: null });

test('review blueprint loads + validates with no errors', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('review');
  assert.equal(blueprint.id, 'review');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(validation.errors.length, 0);
});

test('review blueprint has the expected review shape', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('review');
  assert.equal(bp.workItem.kind, 'review-task');
  assert.equal(bp.workItem.idPrefix, 'RV');
  assert.equal(bp.spine.decider, 'review-director');
  assert.equal(bp.knobs.requiresRepo, true);
  // review vocabulary, distinct from coding/research
  for (const verb of ['NEXT_REVIEWER', 'NEXT_VERIFIER', 'NEXT_SYNTHESIZER']) {
    assert.ok(Object.prototype.hasOwnProperty.call(bp.spine.edges, verb), `missing edge ${verb}`);
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(bp.spine.edges, 'NEXT_WORKER'));
  // dimensions + threshold knobs (the configurable review surface)
  assert.deepEqual(bp.knobs.dimensions, ['bugs', 'security', 'perf', 'style']);
  assert.equal(bp.knobs.confidenceThreshold, 0.5);
  // findings report, not a git diff (like research's collector)
  assert.equal(bp.gym?.collectTrace, 'work-item-output');
  // the adversarial verifier is a reactive overlay, afterRole the reviewer
  const rule = bp.reactive.find((r) => r.role === 'finding-verifier');
  assert.ok(rule, 'finding-verifier reactive rule declared');
  assert.equal(rule!.when.afterRole, 'dimension-reviewer');
  // inherited from base
  assert.equal(bp.knobs.logRetention, 500);
});

test('every review role has a resolvable prompt file', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('review');
  for (const role of bp.roles) {
    const found = resolvePromptFile(
      { harnessDir: harnessPath(), phase: '', dept: '', blueprintId: 'review' },
      role.id,
    );
    assert.ok(found, `missing prompt for review role "${role.id}" (blueprints/review/prompts or base)`);
  }
});

test('deriveNext drives a smoke review through every edge to done', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('review');
  const spine = bp.spine;
  const RV = 'RV-001';

  // dimension review → dispatches the dimension-reviewer for the work-item
  assert.deepEqual(deriveNext(spine, decision('NEXT_REVIEWER', RV), RV), {
    kind: 'dispatch',
    role: 'dimension-reviewer',
    feature: RV,
    extras: [`FEATURE_ID=${RV}`],
  });
  // adversarial verify → dispatches the finding-verifier
  assert.deepEqual(deriveNext(spine, decision('NEXT_VERIFIER', RV), RV), {
    kind: 'dispatch',
    role: 'finding-verifier',
    feature: RV,
    extras: [`FEATURE_ID=${RV}`],
  });
  // synthesize → dispatches the findings-synthesizer
  assert.deepEqual(deriveNext(spine, decision('NEXT_SYNTHESIZER', RV), RV), {
    kind: 'dispatch',
    role: 'findings-synthesizer',
    feature: RV,
    extras: [`FEATURE_ID=${RV}`],
  });
  // ESCALATE carries its reason from the arg
  assert.deepEqual(deriveNext(spine, decision('ESCALATE', 'out of scope'), RV), {
    kind: 'terminal',
    outcome: 'escalate',
    reason: 'out of scope',
  });
  // IDLE stops cleanly; DONE terminates
  assert.deepEqual(deriveNext(spine, decision('IDLE'), RV), { kind: 'terminal', outcome: 'idle' });
  assert.deepEqual(deriveNext(spine, decision('DONE'), RV), { kind: 'terminal', outcome: 'done' });
  // an unknown verb falls back to the default (idle, re-scan)
  assert.deepEqual(deriveNext(spine, decision('NONSENSE_VERB'), RV), { kind: 'terminal', outcome: 'idle' });
  // a null decision also hits the default
  assert.deepEqual(deriveNext(spine, null, RV), { kind: 'terminal', outcome: 'idle' });
});
