/**
 * identities-v1-2026-08-30 P-001 — the MERGE_RULES registry is EXHAUSTIVE over
 * `BlueprintSchema`'s leaves, in both directions: a leaf with no rule is the
 * "composes by an unstated rule" defect D-007 / P-019 forbid; a rule naming no
 * leaf is a rule that rotted when its field moved. Both fail here, naming the
 * offenders, so a new field cannot land without stating how it composes.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  MERGE_RULES,
  mergeRuleFor,
  enumerateSchemaLeaves,
  enumerateBlueprintLeaves,
  missingMergeRules,
  danglingMergeRules,
} from './merge-rules.js';

test('every BlueprintSchema leaf has a declared merge rule (no field composes by an unstated rule)', () => {
  const missing = missingMergeRules().map((l) => `${l.path} (${l.kind}:${l.type})`);
  assert.deepEqual(
    missing,
    [],
    `BlueprintSchema leaves with NO entry in MERGE_RULES — declare each one's rule in merge-rules.ts:\n  ${missing.join('\n  ')}`,
  );
});

test('every MERGE_RULES path names a real BlueprintSchema leaf (a rule cannot outlive its field)', () => {
  const dangling = danglingMergeRules();
  assert.deepEqual(
    dangling,
    [],
    `MERGE_RULES paths that match no schema leaf — the field moved or was renamed:\n  ${dangling.join('\n  ')}`,
  );
});

test('the schema has the identity extension leaves (P-001) and the enumeration is non-trivial', () => {
  const paths = new Set(enumerateBlueprintLeaves().map((l) => l.path));
  for (const p of ['slots', 'bundles', 'grants.requires', 'grants.optional', 'grants.suggestedProviders', 'publisher.id', 'attestation.contentHash']) {
    assert.ok(paths.has(p), `expected leaf ${p}`);
  }
  assert.ok(paths.size > 100, `expected the full blueprint surface, got ${paths.size} leaves`);
});

test('enumerateSchemaLeaves — descends objects through wrappers; arrays/records/unions/lazy are ONE leaf; catchall keys are <path>.*', () => {
  const s = z.object({
    a: z.string().optional(),
    b: z.object({ c: z.number().default(1), d: z.array(z.string()).default([]) }).prefault({}),
    e: z.record(z.string(), z.string()),
    f: z.union([z.string(), z.number()]),
    g: z.looseObject({ h: z.boolean() }),
    i: z.lazy(() => z.string()),
    j: z.object({ k: z.string() }).nullable().optional(),
    l: z.strictObject({ m: z.string() }),
  });
  assert.deepEqual(
    enumerateSchemaLeaves(s).map((l) => `${l.path}:${l.kind}`),
    ['a:scalar', 'b.c:scalar', 'b.d:array', 'e:record', 'f:union', 'g.h:scalar', 'g.*:catchall', 'i:lazy', 'j.k:scalar', 'l.m:scalar'],
  );
});

test('mergeRuleFor — exact entry, else the nearest enclosing catchall, else null', () => {
  assert.equal(mergeRuleFor('knobs.maxCostUsd')?.rule, 'most-restrictive');
  assert.equal(mergeRuleFor('knobs.someForwardUnknownKnob'), MERGE_RULES['knobs.*']);
  assert.equal(mergeRuleFor('knobs.promotion.staging_to_main'), MERGE_RULES['knobs.promotion.*']);
  assert.equal(mergeRuleFor('knobs.promotion.smokeBuild.anything'), MERGE_RULES['knobs.promotion.smokeBuild.*']);
  assert.equal(mergeRuleFor('knobs.scoper.runState'), MERGE_RULES['knobs.scoper.*']);
  assert.equal(mergeRuleFor('no.such.path'), null);
  assert.equal(mergeRuleFor('id')?.rule, 'replace');
});

test('the decided deviations from last-writer-wins are declared exactly, and everything else reproduces today’s mergeRaw (byte-equivalence default)', () => {
  // D-007: a second distinct layer on an exclusive slot is a hard error — the ONLY hard-error leaf.
  assert.deepEqual(MERGE_RULES.slots, { rule: 'hard-error', key: 'slot', note: MERGE_RULES.slots?.note });
  assert.deepEqual(
    Object.entries(MERGE_RULES).filter(([, r]) => r.rule === 'hard-error').map(([p]) => p),
    ['slots'],
  );
  // D-011 / D-003: bundles + grants compose by union.
  assert.equal(MERGE_RULES.bundles?.rule, 'union');
  assert.deepEqual(MERGE_RULES.bundles?.key, ['kind', 'ref']);
  assert.equal(MERGE_RULES['grants.requires']?.rule, 'union');
  assert.equal(MERGE_RULES['grants.optional']?.rule, 'union');
  // D-003: safety caps compose most-restrictive.
  const caps = Object.entries(MERGE_RULES).filter(([, r]) => r.rule === 'most-restrictive').map(([p]) => p).sort();
  assert.deepEqual(caps, [
    'dispatch.costCapUsd',
    'dispatch.safetyCeiling',
    'knobs.maxCostUsd',
    'knobs.parallelWorkers.max',
    'knobs.parallelWorkers.maxFeaturesInFlight',
    'recursion.maxDepth',
    'spine.maxTurns',
  ]);
  // D-020 (P-019): declaration-set arrays compose by union — roles keyed by id, the rest by value.
  assert.equal(MERGE_RULES.roles?.rule, 'union');
  assert.equal(MERGE_RULES.roles?.key, 'id');
  const declarationSets = ['reactive', 'gym.signals', 'dependencies.tools', 'dependencies.packs', 'dependencies.plugins', 'dependencies.blueprints', 'dependencies.datatypes'];
  for (const p of declarationSets) {
    assert.equal(MERGE_RULES[p]?.rule, 'union', `${p} composes by union (D-020)`);
    assert.equal(MERGE_RULES[p]?.key, undefined, `${p} unions by structural value`);
  }
  // Everything else = the pre-P-019 mergeRaw: records key-union, arrays / scalars / unions / lazy / catchall replace.
  const unionArrays = new Set(['bundles', 'grants.requires', 'grants.optional', 'roles', ...declarationSets]);
  for (const leaf of enumerateBlueprintLeaves()) {
    const rule = MERGE_RULES[leaf.path];
    assert.ok(rule, `no rule for ${leaf.path}`);
    if (leaf.kind === 'record') assert.equal(rule.rule, 'union', `${leaf.path}: a record composes by key-union (today's deep-merge)`);
    else if (leaf.path === 'slots' || unionArrays.has(leaf.path) || caps.includes(leaf.path)) continue;
    else assert.equal(rule.rule, 'replace', `${leaf.path}: undeclared deviation from last-writer-wins`);
  }
});
