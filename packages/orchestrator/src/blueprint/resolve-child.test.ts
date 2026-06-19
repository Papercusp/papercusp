/**
 * P-008 (autoloop-pot-operator-rebuild D-008) — spawn-time childBlueprint
 * binding: omitted → self, literal → literal, `$param` → spawner-bound,
 * fail-closed on unbound/malformed placeholders. Plus the gym blueprint's
 * declared `$target` resolving end-to-end.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  resolveChildBlueprint,
  isChildBlueprintParam,
  CHILD_BLUEPRINT_PARAM_RE,
  assertNotNestedHive,
} from './resolve-child.js';
import { loadBuiltinBlueprint } from './loader.js';

test('omitted childBlueprint resolves to self (the documented default)', () => {
  assert.equal(resolveChildBlueprint({ id: 'coding', recursion: {} }), 'coding');
  assert.equal(resolveChildBlueprint({ id: 'research' }), 'research');
});

test('a literal childBlueprint resolves to that blueprint', () => {
  assert.equal(
    resolveChildBlueprint({ id: 'research', recursion: { childBlueprint: 'coding' } }),
    'coding',
  );
});

test('a $param childBlueprint binds from the spawner params', () => {
  assert.equal(
    resolveChildBlueprint({ id: 'gym', recursion: { childBlueprint: '$target' } }, { target: 'coding' }),
    'coding',
  );
  assert.equal(
    resolveChildBlueprint({ id: 'gym', recursion: { childBlueprint: '$target' } }, { target: 'research' }),
    'research',
  );
});

test('an unbound $param FAILS CLOSED (no silent self-fallback)', () => {
  assert.throws(
    () => resolveChildBlueprint({ id: 'gym', recursion: { childBlueprint: '$target' } }),
    /bound no "target" param/,
  );
  assert.throws(
    () => resolveChildBlueprint({ id: 'gym', recursion: { childBlueprint: '$target' } }, { other: 'x' }),
    /bound no "target" param/,
  );
});

test('a malformed placeholder throws', () => {
  assert.throws(
    () => resolveChildBlueprint({ id: 'gym', recursion: { childBlueprint: '$9bad' } }, { '9bad': 'x' }),
    /not a valid placeholder/,
  );
});

test('isChildBlueprintParam + the placeholder regex', () => {
  assert.equal(isChildBlueprintParam('$target'), true);
  assert.equal(isChildBlueprintParam('coding'), false);
  assert.equal(isChildBlueprintParam(undefined), false);
  assert.equal(CHILD_BLUEPRINT_PARAM_RE.test('$target'), true);
  assert.equal(CHILD_BLUEPRINT_PARAM_RE.test('$a-b_c2'), true);
  assert.equal(CHILD_BLUEPRINT_PARAM_RE.test('$9bad'), false);
  assert.equal(CHILD_BLUEPRINT_PARAM_RE.test('$'), false);
});

test('assertNotNestedHive — the no-nest guard (local-hive D-009 / swarm D-018)', () => {
  // A kind:'hive' WITH a parent → rejected loud.
  assert.throws(
    () => assertNotNestedHive({ id: 'hive', kind: 'hive' }, true),
    /cannot be nested|hives are peers/i,
  );
  // A kind:'hive' as a ROOT (no parent) → allowed (the bootstrap/deployment path).
  assert.doesNotThrow(() => assertNotNestedHive({ id: 'hive', kind: 'hive' }, false));
  // A kind:'harness' with a parent → allowed (general harnesses recurse freely).
  assert.doesNotThrow(() => assertNotNestedHive({ id: 'coding', kind: 'harness' }, true));
  // Default-kind (undefined → treated as harness) with a parent → allowed.
  assert.doesNotThrow(() => assertNotNestedHive({ id: 'bee' }, true));
});

test('the hive built-in blueprint is kind:hive + cannot be nested (P-010)', () => {
  const { blueprint: hive, validation } = loadBuiltinBlueprint('coding');
  assert.equal(hive.kind, 'hive');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.throws(() => assertNotNestedHive(hive, true), /cannot be nested|hives are peers/i);
  assert.doesNotThrow(() => assertNotNestedHive(hive, false));
});

test('the bee built-in launch blueprint is kind:harness (NOT a hive) and validates (P-010/P-011)', () => {
  const { blueprint: bee, validation } = loadBuiltinBlueprint('bee');
  assert.equal(bee.kind, 'harness');
  assert.equal(bee.spine.decider, 'bee');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  // A bee placed by the Queen (a parent) is allowed — only hives nest-guard.
  assert.doesNotThrow(() => assertNotNestedHive(bee, true));
});

test('the gym blueprint declares $target and resolves a parameterized child (D-008 verify)', () => {
  const { blueprint: gym, validation } = loadBuiltinBlueprint('gym');
  // The former undeclared runtime override is now DECLARED…
  assert.equal(gym.recursion.childBlueprint, '$target');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  // …and binds at spawn time to the blueprint under optimization.
  assert.equal(resolveChildBlueprint(gym, { target: 'coding' }), 'coding');
  // Unbound stays fail-closed for the gym too.
  assert.throws(() => resolveChildBlueprint(gym), /bound no "target" param/);
});
