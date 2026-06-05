/**
 * P-005 — validateBlueprint semantics. Asserts the shipped `coding` blueprint is
 * error-free (only the expected vestigial-verb warnings), and that deliberately
 * broken blueprints produce the right errors.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { harnessPath } from '@papercusp/harness/paths';
import { BlueprintSchema } from './schema.js';
import { validateBlueprint } from './validate.js';

const coding = BlueprintSchema.parse(
  parseYaml(readFileSync(harnessPath('blueprints', 'coding', 'blueprint.yaml'), 'utf8')),
);

test('coding blueprint validates with no errors', () => {
  const v = validateBlueprint(coding);
  assert.equal(v.ok, true, `unexpected errors: ${JSON.stringify(v.errors)}`);
  assert.equal(v.errors.length, 0);
});

test('coding blueprint warns ONLY about the vestigial undeclared dispatch roles', () => {
  const v = validateBlueprint(coding);
  const undeclared = v.warnings
    .filter((w) => w.code === 'dispatch-undeclared-role')
    .map((w) => w.message);
  // tester / test-writer / monitor have no prompt — kept as spine edges for verb
  // parity but intentionally not declared roles.
  assert.equal(undeclared.length, 3, `got: ${JSON.stringify(undeclared)}`);
  for (const role of ['tester', 'test-writer', 'monitor']) {
    assert.ok(
      undeclared.some((m) => m.includes(`"${role}"`)),
      `expected an undeclared-role warning for ${role}`,
    );
  }
  // No dead-role / decider warnings for coding.
  assert.equal(v.warnings.filter((w) => w.code === 'unused-role').length, 0);
  assert.equal(v.warnings.filter((w) => w.code === 'decider-undeclared').length, 0);
});

test('empty spine → error', () => {
  const bp = BlueprintSchema.parse({
    id: 'x',
    workItem: { kind: 'feature' },
    spine: { edges: {}, default: { to: 'idle' } },
  });
  const v = validateBlueprint(bp);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'empty-spine'));
});

test('no reachable terminal → error', () => {
  const bp = BlueprintSchema.parse({
    id: 'x',
    workItem: { kind: 'feature' },
    spine: {
      edges: { NEXT_WORKER: { to: 'role', role: 'worker' } },
      default: { to: 'role', role: 'worker' }, // non-terminal default
    },
    roles: [{ id: 'director' }, { id: 'worker' }],
  });
  const v = validateBlueprint(bp);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'no-terminal'));
});

test('duplicate role id → error', () => {
  const bp = BlueprintSchema.parse({
    id: 'x',
    workItem: { kind: 'feature' },
    spine: { edges: { DONE: { to: 'done' } } },
    roles: [{ id: 'director' }, { id: 'director' }],
  });
  const v = validateBlueprint(bp);
  assert.ok(v.errors.some((e) => e.code === 'duplicate-role'));
});

test('recursion enabled without a trigger → warning', () => {
  const bp = BlueprintSchema.parse({
    id: 'x',
    workItem: { kind: 'research-task' },
    spine: { edges: { DONE: { to: 'done' } } },
    recursion: { enabled: true },
  });
  const v = validateBlueprint(bp);
  assert.equal(v.ok, true); // a warning, not an error
  assert.ok(v.warnings.some((w) => w.code === 'recursion-no-trigger'));
});

test('recursion childBlueprint: well-formed $param passes; malformed placeholder errors (D-008)', () => {
  const mk = (childBlueprint: string) =>
    BlueprintSchema.parse({
      id: 'x',
      workItem: { kind: 'research-task' },
      spine: { edges: { DONE: { to: 'done' } } },
      recursion: { enabled: true, childBlueprint, spawnOn: { role: 'runner' } },
      roles: [{ id: 'runner' }],
    });
  const ok = validateBlueprint(mk('$target'));
  assert.equal(ok.errors.some((e) => e.code === 'recursion-bad-param'), false, JSON.stringify(ok.errors));
  const bad = validateBlueprint(mk('$9bad'));
  assert.ok(bad.errors.some((e) => e.code === 'recursion-bad-param'), JSON.stringify(bad.errors));
});

test('reactive rule guarded only by `cond` (DataCondition) is a valid guard; a stale custom-only guard errors (D-002)', () => {
  const base = {
    id: 'x',
    workItem: { kind: 'feature' },
    roles: [{ id: 'debugger' }],
    spine: { edges: { DONE: { to: 'done' } } },
  };
  // `cond` alone is a real trigger condition.
  const withCond = BlueprintSchema.parse({
    ...base,
    reactive: [{ role: 'debugger', when: { cond: { attempts: { gte: 3 } } } }],
  });
  const v1 = validateBlueprint(withCond);
  assert.ok(!v1.errors.some((e) => e.code === 'empty-reactive-guard'), 'cond counts as a guard');
  // A stale blueprint whose ONLY guard was the retired `custom` string now has
  // no condition at all (the key is stripped at parse) → empty-reactive-guard.
  const staleCustom = BlueprintSchema.parse({
    ...base,
    reactive: [{ role: 'debugger', when: { custom: 'named-host-predicate' } }],
  });
  const v2 = validateBlueprint(staleCustom);
  assert.ok(v2.errors.some((e) => e.code === 'empty-reactive-guard'), 'custom no longer counts');
});
