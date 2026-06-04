/**
 * P-002 / P-003 — the built-in program-mode blueprints (`vote`, `deliberate`)
 * load, merge `extends: base`, parse, and validate (program-mode rules: a gate
 * with a fallback, parseable expressions, exactly one spine model).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint, resolveBlueprint } from './loader.js';
import { isProgramSpine } from './program.js';

test('vote blueprint loads + validates (program mode)', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('vote');
  assert.equal(blueprint.id, 'vote');
  assert.equal(blueprint.workItem.kind, 'decision');
  assert.ok(isProgramSpine(blueprint.spine), 'vote is a program-mode spine');
  assert.equal(blueprint.spine.steps?.length, 4);
  assert.ok(blueprint.spine.gate && blueprint.spine.gate.length >= 2);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  // knob defaults survived the base merge.
  assert.equal(blueprint.knobs.quorum, 3);
  assert.equal(blueprint.knobs.max_voters, 5);
  assert.deepEqual(blueprint.knobs.lenses, ['correctness', 'risk', 'simplicity']);
  // trigger declaration (D-007).
  assert.equal(blueprint.triggers?.event, 'coordination-op:vote');
});

test('deliberate blueprint loads + validates (program mode, conditional step)', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('deliberate');
  assert.equal(blueprint.id, 'deliberate');
  assert.ok(isProgramSpine(blueprint.spine));
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  // the vote step is conditional on the owner not answering.
  const voteStep = blueprint.spine.steps?.find((s) => s.id === 'vote');
  assert.equal(voteStep?.op, 'coord:vote');
  assert.equal(voteStep?.when, 'NOT asked.answered');
  // the gate has a fallback (escalate).
  assert.ok(blueprint.spine.gate?.some((b) => b.else === true));
  assert.equal(blueprint.triggers?.event, 'coordination-op:deliberate');
});

test('a user fork (extends: vote) overrides lenses + the gate without code', () => {
  // Simulate a forked blueprint by parsing a raw object that extends vote.
  const forked = resolveBlueprint({
    id: 'my-vote',
    extends: 'vote',
    knobs: { lenses: ['my-domain', 'my-risk'], quorum: 2 },
  });
  assert.equal(forked.blueprint.id, 'my-vote');
  // inherited program spine from vote
  assert.equal(forked.blueprint.spine.steps?.length, 4);
  // overridden knobs
  assert.deepEqual(forked.blueprint.knobs.lenses, ['my-domain', 'my-risk']);
  assert.equal(forked.blueprint.knobs.quorum, 2);
  // inherited knob (not overridden)
  assert.equal(forked.blueprint.knobs.max_voters, 5);
  assert.equal(forked.validation.ok, true, JSON.stringify(forked.validation.errors));
});
