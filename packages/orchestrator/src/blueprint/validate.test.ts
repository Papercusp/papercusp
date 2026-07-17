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
  parseYaml(readFileSync(harnessPath('blueprints', 'coding-factory', 'blueprint.yaml'), 'utf8')),
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

test('gates.finalize — a `{role,extras}` entry is resolved the same as a plain-string role (EI-421)', () => {
  const base = {
    id: 'finalize-entries',
    workItem: { kind: 'feature' },
    spine: {
      edges: {
        DONE: { to: 'done' },
        NEXT_WORKER: { to: 'role', role: 'worker', extras: ['FEATURE_ID={feature}'] },
      },
    },
    roles: [{ id: 'worker' }, { id: 'documenter' }, { id: 'committer' }],
  };

  // `documenter` is only referenced via the OBJECT finalize-entry form — must count
  // as both a known role (no finalize-unknown-role) and a USED role (no unused-role).
  const withObjectEntry = BlueprintSchema.parse({
    ...base,
    gates: {
      finalize: {
        onDone: [{ role: 'documenter', extras: ['OUTPUT_KIND=artifacts'] }, 'archive'],
        onEscalate: ['committer'],
      },
    },
  });
  const v = validateBlueprint(withObjectEntry);
  assert.equal(v.errors.length, 0, `unexpected errors: ${JSON.stringify(v.errors)}`);
  assert.equal(
    v.warnings.filter((w) => w.code === 'finalize-unknown-role').length,
    0,
    `unexpected finalize-unknown-role: ${JSON.stringify(v.warnings)}`,
  );
  assert.ok(
    !v.warnings.some((w) => w.code === 'unused-role' && w.message.includes('"documenter"')),
    `documenter should be counted used via its object finalize entry: ${JSON.stringify(v.warnings)}`,
  );
  assert.ok(
    !v.warnings.some((w) => w.code === 'unused-role' && w.message.includes('"committer"')),
    `committer should be counted used via onEscalate: ${JSON.stringify(v.warnings)}`,
  );

  // An object entry naming a role that is neither a known finalize step nor a
  // declared role still warns (same as the plain-string form).
  const withUnknownRole = BlueprintSchema.parse({
    ...base,
    gates: { finalize: { onDone: [{ role: 'nonexistent-role' }], onEscalate: [] } },
  });
  const v2 = validateBlueprint(withUnknownRole);
  assert.ok(
    v2.warnings.some((w) => w.code === 'finalize-unknown-role' && w.message.includes('"nonexistent-role"')),
  );
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

test('self-claim spine (no edges/steps) is VALID — flat-distributed topology has no central decider', () => {
  const bp = BlueprintSchema.parse({
    id: 'dist-broadcast',
    workItem: { kind: 'feature' },
    spine: { claimModel: 'self-claim-fifo' }, // no edges, no steps — peers self-claim + run their role
    roles: [{ id: 'worker' }],
    coordination: { broadcast: 'topic' },
  });
  const v = validateBlueprint(bp);
  assert.ok(!v.errors.some((e) => e.code === 'empty-spine'), `self-claim must not be empty-spine: ${JSON.stringify(v.errors)}`);
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
    workItem: { kind: 'task' },
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
      workItem: { kind: 'task' },
      spine: { edges: { DONE: { to: 'done' } } },
      recursion: { enabled: true, childBlueprint, spawnOn: { role: 'runner' } },
      roles: [{ id: 'runner' }],
    });
  const ok = validateBlueprint(mk('$target'));
  assert.equal(ok.errors.some((e) => e.code === 'recursion-bad-param'), false, JSON.stringify(ok.errors));
  const bad = validateBlueprint(mk('$9bad'));
  assert.ok(bad.errors.some((e) => e.code === 'recursion-bad-param'), JSON.stringify(bad.errors));
});

test('knownRoles: a dispatched role that is a live agent role is not flagged; a ghost still is (P-001)', () => {
  const bp = BlueprintSchema.parse({
    id: 'x',
    workItem: { kind: 'feature' },
    spine: {
      decider: 'director',
      // `worker` is a live built-in role dispatched WITHOUT re-declaring it in
      // roles[]; `ghost` is a genuine typo/dead role.
      edges: { DONE: { to: 'done' }, NEXT_WORKER: { to: 'role', role: 'worker' }, GHOST: { to: 'role', role: 'ghost' } },
    },
    roles: [{ id: 'director' }],
  });
  // Pre-P-001 (no knownRoles → declared-only): BOTH worker and ghost are flagged.
  const lenient = validateBlueprint(bp);
  const lenientUndeclared = lenient.warnings.filter((w) => w.code === 'dispatch-undeclared-role').map((w) => w.message);
  assert.ok(lenientUndeclared.some((m) => m.includes('"worker"')), JSON.stringify(lenientUndeclared));
  assert.ok(lenientUndeclared.some((m) => m.includes('"ghost"')), JSON.stringify(lenientUndeclared));

  // With knownRoles: `worker` resolves via the global persona fallback → not a
  // ghost → suppressed; `ghost` (neither declared nor live) still warns.
  const aware = validateBlueprint(bp, { knownRoles: new Set(['director', 'worker']) });
  const awareUndeclared = aware.warnings.filter((w) => w.code === 'dispatch-undeclared-role').map((w) => w.message);
  assert.equal(awareUndeclared.some((m) => m.includes('"worker"')), false, JSON.stringify(awareUndeclared));
  assert.ok(awareUndeclared.some((m) => m.includes('"ghost"')), JSON.stringify(awareUndeclared));
});

test('knownRoles: a live agent role as decider is not flagged decider-undeclared (P-001)', () => {
  const bp = BlueprintSchema.parse({
    id: 'x',
    workItem: { kind: 'feature' },
    spine: { decider: 'mug', edges: { DONE: { to: 'done' } } },
    roles: [{ id: 'worker' }],
  });
  // Declared-only: `mug` (not in roles[]) → decider-undeclared.
  assert.ok(validateBlueprint(bp).warnings.some((w) => w.code === 'decider-undeclared'));
  // With knownRoles incl. `mug`: not flagged.
  const aware = validateBlueprint(bp, { knownRoles: new Set(['mug', 'worker']) });
  assert.equal(aware.warnings.some((w) => w.code === 'decider-undeclared'), false, JSON.stringify(aware.warnings));
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

// ── ephemeral-tier schedule contract (schedule-inventory-and-ephemeral-tier-2026-06-26 P-010 / D-006) ──

const withSchedule = (schedule: unknown[]) =>
  BlueprintSchema.parse({
    id: 'x',
    workItem: { kind: 'feature' },
    spine: { edges: { DONE: { to: 'done' } } },
    triggers: { schedule },
  });

test('tier defaults to durable; a durable cron schedule has no trigger errors', () => {
  const bp = withSchedule([{ cron: '*/5 * * * *' }]);
  assert.equal(bp.triggers!.schedule[0]!.tier, 'durable'); // schema default
  const v = validateBlueprint(bp);
  const trigErrs = v.errors.filter((e) => e.code.startsWith('ephemeral-') || e.code === 'durable-no-cron');
  assert.equal(trigErrs.length, 0, JSON.stringify(trigErrs));
});

test('tier:ephemeral with a deterministic action + intervalSec validates (no trigger errors)', () => {
  const bp = withSchedule([{ tier: 'ephemeral', action: 'system:hive-watchdog-sweep', intervalSec: 5 }]);
  const v = validateBlueprint(bp);
  assert.equal(v.errors.filter((e) => e.code.startsWith('ephemeral-')).length, 0, JSON.stringify(v.errors));
});

test('tier:ephemeral that omits action (defaults to system:blueprint-run) AND intervalSec → two contract errors', () => {
  const bp = withSchedule([{ tier: 'ephemeral' }]);
  const v = validateBlueprint(bp);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'ephemeral-blueprint-run-action'), JSON.stringify(v.errors));
  assert.ok(v.errors.some((e) => e.code === 'ephemeral-no-interval'), JSON.stringify(v.errors));
});

test('tier:ephemeral intervalSec below the floor → ephemeral-interval-floor (raw/out-of-band path)', () => {
  const bp = withSchedule([{ tier: 'ephemeral', action: 'system:foo', intervalSec: 5 }]);
  (bp.triggers!.schedule[0] as { intervalSec: number }).intervalSec = 0; // simulate a raw blueprint that bypassed zod
  const v = validateBlueprint(bp);
  assert.ok(v.errors.some((e) => e.code === 'ephemeral-interval-floor'), JSON.stringify(v.errors));
});

test('tier:ephemeral coarse intervalSec (≥60s) + a stray cron → warnings, not errors', () => {
  const bp = withSchedule([{ tier: 'ephemeral', action: 'system:foo', intervalSec: 120, cron: '* * * * *' }]);
  const v = validateBlueprint(bp);
  assert.equal(v.errors.filter((e) => e.code.startsWith('ephemeral-')).length, 0, JSON.stringify(v.errors));
  assert.ok(v.warnings.some((w) => w.code === 'ephemeral-interval-coarse'), JSON.stringify(v.warnings));
  assert.ok(v.warnings.some((w) => w.code === 'ephemeral-cron-ignored'), JSON.stringify(v.warnings));
});

test('tier:durable missing a cron → durable-no-cron (raw/out-of-band path)', () => {
  const bp = withSchedule([{ cron: '*/5 * * * *' }]);
  delete (bp.triggers!.schedule[0] as { cron?: string }).cron; // simulate a raw blueprint
  const v = validateBlueprint(bp);
  assert.ok(v.errors.some((e) => e.code === 'durable-no-cron'), JSON.stringify(v.errors));
});
