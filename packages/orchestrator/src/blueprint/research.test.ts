/**
 * P-017 — the `research` blueprint loads, resolves (extends base), and validates
 * clean. It's the non-coding proof: a different work-item, a different verb
 * vocabulary, different roles — same engine.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from './loader.js';
import { resolvePromptFile } from '../prompt-resolve.js';
import { harnessPath } from '@papercusp/harness/paths';

test('research blueprint loads + validates with no errors', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('research');
  assert.equal(blueprint.id, 'research');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(validation.errors.length, 0);
});

test('research blueprint has the expected research shape', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('research');
  assert.equal(bp.workItem.kind, 'research-task');
  assert.equal(bp.workItem.idPrefix, 'R');
  assert.equal(bp.spine.decider, 'research-director');
  assert.equal(bp.knobs.requiresRepo, false); // repo-less (overrides base)
  // research vocabulary, distinct from coding's
  assert.ok(Object.prototype.hasOwnProperty.call(bp.spine.edges, 'NEXT_RESEARCHER'));
  assert.ok(!Object.prototype.hasOwnProperty.call(bp.spine.edges, 'NEXT_WORKER'));
  // gym collects the work-item output (not a git diff) for a repo-less harness
  assert.equal(bp.gym?.collectTrace, 'work-item-output');
  // declared dispatch policy (D-005): one task pipeline at a time — depth over fan-out
  assert.equal(bp.dispatch?.concurrency, 1);
  // inherited from base
  assert.equal(bp.knobs.logRetention, 500);
});

test('every research role has a resolvable prompt file', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('research');
  for (const role of bp.roles) {
    const found = resolvePromptFile(
      { harnessDir: harnessPath(), phase: '', dept: '', blueprintId: 'research' },
      role.id,
    );
    assert.ok(found, `missing prompt for research role "${role.id}" (blueprints/research/prompts or base)`);
  }
});
