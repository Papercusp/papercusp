/**
 * E2a — import-time blueprint dependency validation. Pure → exhaustively
 * covered with injected host capability sets.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  validateBlueprintDependencies,
  parseDepSpec,
  type DependencyHostSets,
} from './blueprint-deps.js';

const host = (over: Partial<DependencyHostSets> = {}): DependencyHostSets => ({
  availableTools: new Set(),
  installedPlugins: new Set(),
  cupboardPlugins: new Set(),
  ...over,
});

test('parseDepSpec — plain, versioned, scoped, scoped+versioned', () => {
  assert.deepEqual(parseDepSpec('slack-notifier'), { name: 'slack-notifier', range: null });
  assert.deepEqual(parseDepSpec('slack-notifier@^1.0.0'), { name: 'slack-notifier', range: '^1.0.0' });
  assert.deepEqual(parseDepSpec('@papercusp/foo'), { name: '@papercusp/foo', range: null });
  assert.deepEqual(parseDepSpec('@papercusp/foo@1.2.3'), { name: '@papercusp/foo', range: '1.2.3' });
});

test('empty / absent deps → ok', () => {
  assert.equal(validateBlueprintDependencies(undefined, host()).ok, true);
  assert.equal(validateBlueprintDependencies(null, host()).ok, true);
  assert.equal(validateBlueprintDependencies({}, host()).ok, true);
  assert.equal(validateBlueprintDependencies({ tools: [], plugins: [] }, host()).ok, true);
});

test('a declared tool present in the catalog → ok', () => {
  const r = validateBlueprintDependencies(
    { tools: ['docs:get'] },
    host({ availableTools: new Set(['docs:get']) }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing.tools, []);
});

test('a declared tool absent from the catalog → missing + actionable message', () => {
  const r = validateBlueprintDependencies(
    { tools: ['custom:frobnicate'] },
    host({ availableTools: new Set(['docs:get']) }),
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.tools, ['custom:frobnicate']);
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0], /needs tool "custom:frobnicate"/);
});

test('an installed plugin → ok, not installable', () => {
  const r = validateBlueprintDependencies(
    { plugins: ['slack-notifier'] },
    host({ installedPlugins: new Set(['slack-notifier']) }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.installable.plugins, []);
  assert.deepEqual(r.missing.plugins, []);
});

test('a Cupboard-listed but not-installed plugin → ok + installable (does not block)', () => {
  const r = validateBlueprintDependencies(
    { plugins: ['slack-notifier'] },
    host({ cupboardPlugins: new Set(['slack-notifier']) }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.installable.plugins, ['slack-notifier']);
  assert.deepEqual(r.missing.plugins, []);
});

test('a plugin in NEITHER installed nor Cupboard → missing + "needs plugin X" upfront', () => {
  const r = validateBlueprintDependencies(
    { plugins: ['ghost-plugin'] },
    host({ installedPlugins: new Set(['slack-notifier']), cupboardPlugins: new Set(['other']) }),
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.plugins, ['ghost-plugin']);
  assert.match(r.messages[0], /needs plugin "ghost-plugin" — not installed and not available in the Cupboard/);
});

test('version-qualified plugin matches by name (installed)', () => {
  const r = validateBlueprintDependencies(
    { plugins: ['slack-notifier@^1.0.0'] },
    host({ installedPlugins: new Set(['slack-notifier']) }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing.plugins, []);
});

test('version-qualified plugin resolvable from Cupboard → installable carries the @range spec', () => {
  const r = validateBlueprintDependencies(
    { plugins: ['slack-notifier@^1.0.0'] },
    host({ cupboardPlugins: new Set(['slack-notifier']) }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.installable.plugins, ['slack-notifier@^1.0.0']);
});

test('mixed: missing tool + missing plugin → ok:false, both messages, both lists', () => {
  const r = validateBlueprintDependencies(
    { tools: ['docs:get', 'custom:x'], plugins: ['installed-one', 'cupboard-one', 'ghost'] },
    host({
      availableTools: new Set(['docs:get']),
      installedPlugins: new Set(['installed-one']),
      cupboardPlugins: new Set(['cupboard-one']),
    }),
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.tools, ['custom:x']);
  assert.deepEqual(r.missing.plugins, ['ghost']);
  assert.deepEqual(r.installable.plugins, ['cupboard-one']);
  assert.equal(r.messages.length, 2);
});
