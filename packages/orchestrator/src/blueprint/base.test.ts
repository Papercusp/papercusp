/**
 * The `base` blueprint — the ABSTRACT parent (harness-blueprint-orchestration-
 * 2026-06-03 P-006). It carries only the common knobs every concrete blueprint
 * shares and is NEVER runnable standalone (it declares no `workItem`/`spine`, both
 * required by `BlueprintSchema`). Its whole contract is: fail to load directly,
 * but contribute its defaults through an `extends` merge.
 *
 * `loader.test.ts` proves the inheritance via the real `coding` child; this file
 * pins base's own two-part contract directly — the abstract-not-loadable property
 * (which nothing else covers) and the knob contribution through a minimal child.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { builtinBlueprintPath, loadBuiltinBlueprint, resolveBlueprint, resolveBlueprintSource } from './loader.js';
import { IdentitySourceDocumentSchema, RunnableBlueprintSchema } from './schema.js';

test('R-1: every built-in identity resolves without the workspace base', () => {
  // Change detector over the independent filesystem population, not a maintained
  // list of migrated identities. Before the migration these layers resolve base.
  const root = dirname(dirname(builtinBlueprintPath('base')));
  const identities = readdirSync(root).flatMap((id) => {
    const file = join(root, id, 'blueprint.yaml');
    if (!existsSync(file)) return [];
    const raw = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Object.hasOwn(raw, 'slots') ? [{ file, raw }] : [];
  });
  assert.ok(identities.length > 0, 'the builtin population must not be empty');
  for (const { file, raw } of identities) {
    IdentitySourceDocumentSchema.parse(raw);
    const resolved = resolveBlueprintSource(raw, { sourcePath: file });
    assert.equal(resolved.validation.ok, true, JSON.stringify(resolved.validation.errors));
    assert.equal(resolved.layers.some((layer) => layer.id === 'base'), false, `${raw.id} inherits workspace base`);
    assert.ok(resolved.layers.some((layer) => layer.id === 'identity-root'), `${raw.id} lacks identity root`);
    for (const key of ['workItem', 'spine', 'knobs', 'params', 'dispatch', 'environment']) {
      assert.equal(Object.hasOwn(resolved.merged, key), false, `${raw.id} inherits workspace field ${key}`);
    }
    assert.equal(RunnableBlueprintSchema.safeParse(resolved.merged).success, false, `${raw.id} became runnable`);
  }
});

test('base is abstract — loading it standalone throws (no workItem/spine)', () => {
  // BlueprintSchema requires workItem (+ spine); base supplies neither, so a
  // direct load must fail rather than silently produce a runnable-looking shell.
  assert.throws(() => loadBuiltinBlueprint('base'), /workItem|invalid|base/i);
});

test('a minimal child `extends: base` inherits base knobs', () => {
  const { blueprint, validation } = resolveBlueprint({
    id: 'tmp-base-child',
    extends: 'base',
    workItem: { kind: 'feature' },
    spine: { edges: { DONE: { to: 'done' } } },
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  // the three common knobs base declares
  assert.equal(blueprint.knobs.logRetention, 500);
  assert.deepEqual(blueprint.knobs.branchIsolation, { enabled: false });
  assert.deepEqual(blueprint.knobs.worktrees, { enabled: false });
  // `extends` is consumed by the merge, not carried into the resolved blueprint
  assert.equal(blueprint.extends, undefined);
});

test('a child overrides a base knob (deep-merge: child wins on the leaf, base keeps the rest)', () => {
  const { blueprint } = resolveBlueprint({
    id: 'tmp-base-override',
    extends: 'base',
    workItem: { kind: 'feature' },
    spine: { edges: { DONE: { to: 'done' } } },
    knobs: { logRetention: 42, requiresRepo: false },
  });
  // child wins on the overridden leaf
  assert.equal(blueprint.knobs.logRetention, 42);
  assert.equal(blueprint.knobs.requiresRepo, false);
  // base's other knobs survive the deep merge
  assert.deepEqual(blueprint.knobs.branchIsolation, { enabled: false });
  assert.deepEqual(blueprint.knobs.worktrees, { enabled: false });
});

test('params is a RECORD that UNIONS across extends (base universal ∪ child-specific), not replaced — P-006/D-003/D-007', () => {
  const { blueprint } = resolveBlueprint({
    id: 'tmp-base-params-child',
    extends: 'base',
    workItem: { kind: 'feature' },
    spine: { edges: { DONE: { to: 'done' } } },
    params: {
      'knobs.myKnob': { label: 'My knob', type: 'boolean', group: 'Custom' },
    },
  });
  // base's UNIVERSAL params survive (object-key union — an ARRAY would be replaced
  // wholesale by the child, which is exactly why params must be a keyed record).
  // Keys are config.json instance paths (the namespace the settings panel persists).
  assert.ok(blueprint.params['parallelWorkers.max'], 'base universal concurrency param inherited');
  assert.ok(blueprint.params['aiBackend.default.model'], 'base universal backend param inherited');
  assert.equal(blueprint.params['aiBackend.default.engine'].default, 'subprocess');
  assert.deepEqual(
    blueprint.params['aiBackend.default.engine'].options?.map((option) => option.value),
    ['subprocess', 'loop'],
  );
  // the child's own param is ADDED, not a replacement
  assert.equal(blueprint.params['knobs.myKnob'].label, 'My knob');
  assert.equal(blueprint.params['knobs.myKnob'].type, 'boolean');
  // ParamSpec inner defaults applied (Zod): description '' + secret false
  assert.equal(blueprint.params['knobs.myKnob'].description, '');
  assert.equal(blueprint.params['knobs.myKnob'].secret, false);
});
