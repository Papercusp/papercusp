/**
 * WI-5645 (no-retirement-launch-guard) — the structured `retired` field, its
 * `extends`-inheritance behavior, and the launch-eligibility guard.
 *
 * Root-cause class behind EI-18177667809538623: `external-bench` extends the
 * RETIRED `coding-factory` blueprint, but nothing checked the ancestor chain
 * before an autoloop spent real LLM cost against it. These tests pin:
 *   1. `coding-factory` itself resolves as retired.
 *   2. `external-bench` (extends coding-factory, declares no `retired` of its
 *      own) INHERITS the retirement through the loader's deep-merge — the exact
 *      propagation the incident needed and didn't have.
 *   3. A child can explicitly un-retire via `retired: null`.
 *   4. `assertBlueprintLaunchEligible` throws for a retired resolved blueprint
 *      and is a no-op otherwise.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BlueprintSchema } from './schema.js';
import { loadBuiltinBlueprint, resolveBuiltinExtends, resolveExtends } from './loader.js';
import {
  blueprintRetirement,
  describeBlueprintRetirement,
  assertBlueprintLaunchEligible,
  BlueprintRetiredError,
} from './retirement.js';

test('coding-factory resolves as retired (structured field)', () => {
  const { blueprint } = loadBuiltinBlueprint('coding-factory');
  const info = blueprintRetirement(blueprint);
  assert.ok(info, 'coding-factory must resolve as retired');
  assert.equal(info!.retired, true);
  assert.equal(info!.at, '2026-06-24');
  assert.ok(info!.reason && info!.reason.length > 0);
});

// WI-6235: this test USED to assert the propagation through `external-bench`,
// which extended coding-factory and declared no `retired:` of its own. WI-5646
// (2026-07-26) deliberately gave external-bench its OWN retirement block —
// precisely so it would NOT silently un-retire if coding-factory were ever
// revived (see the rationale comment in its blueprint.yaml). That is a correct
// change, but it means external-bench no longer INHERITS anything, so the old
// assertion was reading its own field and the date drifted to 2026-07-26.
//
// The fix is NOT to bump the expected date — that would leave the test green
// while silently deleting the coverage it exists for (EI-18177667809538623:
// retirement must propagate through `extends`). The fixture is replaced with a
// child that genuinely declares no `retired:`, and external-bench's own
// retirement is pinned separately below.
test('a child declaring no `retired:` INHERITS its parent retirement — the EI-18177667809538623 propagation', () => {
  const raw = { id: 'inheriting-child', extends: 'coding-factory' };
  const blueprint = BlueprintSchema.parse(resolveExtends(raw, resolveBuiltinExtends));
  const info = blueprintRetirement(blueprint);
  assert.ok(info, 'a child that declares no retired: of its own must inherit its parent\'s retirement');
  assert.equal(info!.retired, true);
  assert.equal(info!.at, '2026-06-24');
});

test('external-bench declares its OWN retirement (WI-5646) — it overrides the inherited one rather than tracking it', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('external-bench');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const info = blueprintRetirement(blueprint);
  assert.ok(info, 'external-bench must resolve as retired');
  assert.equal(info!.at, '2026-07-26', 'its own block, NOT coding-factory\'s 2026-06-24');
  assert.ok(info!.reason && /premise/i.test(info!.reason), 'its own reason, not the inherited one');
});

test('assertBlueprintLaunchEligible throws BlueprintRetiredError for a retired resolved blueprint', () => {
  const { blueprint } = loadBuiltinBlueprint('external-bench');
  assert.throws(() => assertBlueprintLaunchEligible(blueprint), BlueprintRetiredError);
  try {
    assertBlueprintLaunchEligible(blueprint);
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof BlueprintRetiredError);
    assert.equal((e as BlueprintRetiredError).blueprintId, 'external-bench');
    assert.match((e as BlueprintRetiredError).message, /RETIRED/);
  }
});

test('a non-retired blueprint (coding) is launch-eligible — no throw, blueprintRetirement returns null', () => {
  const { blueprint } = loadBuiltinBlueprint('coding');
  assert.equal(blueprintRetirement(blueprint), null);
  assert.doesNotThrow(() => assertBlueprintLaunchEligible(blueprint));
});

test('a child can explicitly un-retire via `retired: null` (mergeRaw wholesale-replaces a non-plain-object child value)', () => {
  const raw = { id: 'revived-child', extends: 'coding-factory', retired: null };
  const blueprint = BlueprintSchema.parse(resolveExtends(raw, resolveBuiltinExtends));
  assert.equal(blueprintRetirement(blueprint), null, 'explicit retired: null must clear the inherited retirement');
});

test('describeBlueprintRetirement formats at + reason', () => {
  const msg = describeBlueprintRetirement({ retired: true, at: '2026-01-01', reason: 'because' }, 'some-id');
  assert.match(msg, /some-id/);
  assert.match(msg, /RETIRED/);
  assert.match(msg, /2026-01-01/);
  assert.match(msg, /because/);
});
