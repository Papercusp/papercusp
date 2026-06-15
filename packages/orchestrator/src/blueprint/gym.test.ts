/**
 * P-011 — the `gym` blueprint loads, resolves (extends base), and validates clean.
 * The gym is a meta-harness (D-022): a built-in reference blueprint whose work is
 * "improve another harness's blueprint". Same engine, a gym vocabulary + the
 * generator/judge/proposer roles + layer-4 recursion (the target sub-harness).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from './loader.js';
import { resolvePromptFile } from '../prompt-resolve.js';
import { harnessPath } from '@papercusp/harness/paths';

test('gym blueprint loads + validates with no errors AND no warnings', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('gym');
  assert.equal(blueprint.id, 'gym');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(validation.errors.length, 0, JSON.stringify(validation.errors));
  // A faithful port should be warning-clean too (every role used, decider declared,
  // every dispatch target declared, recursion bounded).
  assert.equal(validation.warnings.length, 0, JSON.stringify(validation.warnings));
});

test('gym blueprint has the expected meta-harness shape', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('gym');
  assert.equal(bp.workItem.kind, 'gym-task');
  assert.equal(bp.workItem.idPrefix, 'G');
  assert.equal(bp.spine.decider, 'gym-director');
  // repo-less: the gym's own work needs no repo (only the target sub-harness may).
  assert.equal(bp.knobs.requiresRepo, false);
  // the optimization vocabulary
  for (const verb of ['GENERATE_TASKS', 'RUN_VARIANT', 'JUDGE', 'PROPOSE', 'ACCEPT']) {
    assert.ok(Object.prototype.hasOwnProperty.call(bp.spine.edges, verb), `missing verb ${verb}`);
  }
  // the core trio (D-022) + the mechanics roles
  const roleIds = new Set(bp.roles.map((r) => r.id));
  for (const r of ['task-generator', 'judge', 'proposer']) assert.ok(roleIds.has(r), `missing role ${r}`);
  // the gym is itself gym-able and repo-less → work-item-output trace seam
  assert.equal(bp.gym?.collectTrace, 'work-item-output');
  // layer-4 recursion: run-target-variant spawns the target sub-harness, bounded.
  assert.equal(bp.recursion.enabled, true);
  assert.equal(bp.recursion.spawnOn?.role, 'variant-runner');
  assert.equal(bp.recursion.maxDepth, 1);
  // D-008: the parameterized child is DECLARED (`$target`), no longer an
  // undeclared runtime override of self (see resolve-child.test.ts for binding).
  assert.equal(bp.recursion.childBlueprint, '$target');
  // inherited from base
  assert.equal(bp.knobs.logRetention, 500);
});

test('every gym role has a resolvable prompt file', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('gym');
  for (const role of bp.roles) {
    const found = resolvePromptFile(
      { harnessDir: harnessPath(), phase: '', dept: '', blueprintId: 'gym' },
      role.id,
    );
    assert.ok(found, `missing prompt for gym role "${role.id}" (blueprints/gym/prompts or base)`);
  }
});
