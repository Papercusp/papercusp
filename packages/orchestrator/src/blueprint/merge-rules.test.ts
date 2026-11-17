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
  for (const p of [
    'slots',
    'bundles',
    'grants.requires',
    'grants.optional',
    'grants.suggestedProviders',
    'publisher.id',
    'attestation.contentHash',
  ]) {
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
    [
      'a:scalar',
      'b.c:scalar',
      'b.d:array',
      'e:record',
      'f:union',
      'g.h:scalar',
      'g.*:catchall',
      'i:lazy',
      'j.k:scalar',
      'l.m:scalar',
    ],
  );
});

test('mergeRuleFor — exact entry, else the nearest enclosing catchall, else null', () => {
  assert.equal(mergeRuleFor('knobs.maxCostUsd')?.rule, 'constraint-intersection');
  assert.equal(mergeRuleFor('knobs.someForwardUnknownKnob'), MERGE_RULES['knobs.*']);
  assert.equal(mergeRuleFor('knobs.promotion.staging_to_main'), MERGE_RULES['knobs.promotion.*']);
  assert.equal(mergeRuleFor('knobs.promotion.smokeBuild.anything'), MERGE_RULES['knobs.promotion.smokeBuild.*']);
  assert.equal(mergeRuleFor('knobs.scoper.runState'), MERGE_RULES['knobs.scoper.*']);
  assert.equal(mergeRuleFor('no.such.path'), null);
  assert.equal(mergeRuleFor('id')?.rule, 'explicit-replacement');
});

test('the registry exercises all five D-029 operations (the vocabulary cannot collapse back to ambiguous union/replace labels)', () => {
  assert.deepEqual([...new Set(Object.values(MERGE_RULES).map((rule) => rule.rule))].sort(), [
    'constraint-intersection',
    'explicit-replacement',
    'hard-conflict',
    'keyed-overlay',
    'set-union',
  ]);
});

test('the decided deviations from last-writer-wins are declared exactly, and everything else reproduces today’s mergeRaw (byte-equivalence default)', () => {
  // D-007: a second distinct layer on an exclusive slot is a hard conflict — the only such leaf.
  assert.deepEqual(MERGE_RULES.slots, { rule: 'hard-conflict', key: 'slot', note: MERGE_RULES.slots?.note });
  assert.deepEqual(
    Object.entries(MERGE_RULES)
      .filter(([, r]) => r.rule === 'hard-conflict')
      .map(([p]) => p),
    ['slots'],
  );
  // D-011 / D-003: bundles overlay by identity; grant declarations use structural set union.
  assert.equal(MERGE_RULES.bundles?.rule, 'keyed-overlay');
  assert.deepEqual(MERGE_RULES.bundles?.key, ['kind', 'ref']);
  assert.equal(MERGE_RULES['grants.requires']?.rule, 'set-union');
  assert.equal(MERGE_RULES['grants.optional']?.rule, 'set-union');
  // D-003 / D-029: safety caps compose by constraint intersection; so do the
  // identity recall bounds (identity-system-everything-migration P-012).
  const caps = Object.entries(MERGE_RULES)
    .filter(([, r]) => r.rule === 'constraint-intersection')
    .map(([p]) => p)
    .sort();
  assert.deepEqual(caps, [
    'dispatch.costCapUsd',
    'dispatch.safetyCeiling',
    'knobs.maxCostUsd',
    'knobs.parallelWorkers.max',
    'knobs.parallelWorkers.maxFeaturesInFlight',
    'recall.budgetShare',
    'recall.corpora',
    'recall.memoryScopes',
    'recursion.maxDepth',
    'spine.maxTurns',
  ]);
  // D-020 (P-019): roles overlay by id; the other declaration arrays use structural set union.
  assert.equal(MERGE_RULES.roles?.rule, 'keyed-overlay');
  assert.equal(MERGE_RULES.roles?.key, 'id');
  const declarationSets = [
    'contributions',
    'reactive',
    'gym.signals',
    'dependencies.tools',
    'dependencies.packs',
    'dependencies.plugins',
    'dependencies.blueprints',
    'dependencies.datatypes',
  ];
  for (const p of declarationSets) {
    assert.equal(MERGE_RULES[p]?.rule, 'set-union', `${p} composes by set union (D-020)`);
    assert.equal(MERGE_RULES[p]?.key, undefined, `${p} unions by structural value`);
  }
  // D-009: own maxima and whole-stack restrictions remain source-layer
  // metadata. Key-overlay would erase their origins before authorization.
  const layerPolicyRecords = new Set(['ceiling', 'floors']);
  for (const path of layerPolicyRecords) assert.equal(MERGE_RULES[path]?.rule, 'explicit-replacement');
  // Other records key-overlay; arrays / scalars / unions / lazy / catchall replace.
  const nonReplacementArrays = new Set(['bundles', 'grants.requires', 'grants.optional', 'roles', ...declarationSets]);
  for (const leaf of enumerateBlueprintLeaves()) {
    const rule = MERGE_RULES[leaf.path];
    assert.ok(rule, `no rule for ${leaf.path}`);
    if (layerPolicyRecords.has(leaf.path)) continue;
    if (leaf.kind === 'record')
      assert.equal(rule.rule, 'keyed-overlay', `${leaf.path}: a record composes by keyed overlay (today's deep-merge)`);
    else if (leaf.path === 'slots' || nonReplacementArrays.has(leaf.path) || caps.includes(leaf.path)) continue;
    else assert.equal(rule.rule, 'explicit-replacement', `${leaf.path}: undeclared deviation from last-writer-wins`);
  }
});
