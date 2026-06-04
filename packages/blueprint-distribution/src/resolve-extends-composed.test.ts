/**
 * E1a — composed `extends` resolver (local → installed → built-in).
 * Unit-tested purely via an injected `exists` predicate (no disk), plus one
 * end-to-end test through the real loader proving a local blueprint can
 * `extends: <built-in>` and merge.
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import {
  makeComposedResolveExtends,
  blueprintFileIn,
} from './resolve-extends-composed.js';

test('blueprintFileIn — <root>/<id>/blueprint.yaml layout', () => {
  assert.equal(blueprintFileIn('/a/b', 'coding'), join('/a/b', 'coding', 'blueprint.yaml'));
});

test('precedence: local shadows installed shadows built-in (first hit wins)', () => {
  const present = new Set([
    blueprintFileIn('/local', 'x'),
    blueprintFileIn('/installed', 'x'),
  ]);
  const builtin = (id: string) => `/builtin/${id}.yaml`;
  const resolve = makeComposedResolveExtends({
    localDirs: ['/local'],
    installedDir: '/installed',
    builtin,
    exists: (p) => present.has(p),
  });
  // both local + installed exist → local wins.
  assert.equal(resolve('x'), blueprintFileIn('/local', 'x'));
});

test('installed tier used when no local hit', () => {
  const present = new Set([blueprintFileIn('/installed', 'x')]);
  const resolve = makeComposedResolveExtends({
    localDirs: ['/local'],
    installedDir: '/installed',
    builtin: () => null,
    exists: (p) => present.has(p),
  });
  assert.equal(resolve('x'), blueprintFileIn('/installed', 'x'));
});

test('built-in fallback when neither local nor installed has the id', () => {
  const resolve = makeComposedResolveExtends({
    localDirs: ['/local'],
    installedDir: '/installed',
    builtin: (id) => `/builtin/${id}.yaml`,
    exists: () => false,
  });
  assert.equal(resolve('coding'), '/builtin/coding.yaml');
});

test('returns null when no tier resolves the id', () => {
  const resolve = makeComposedResolveExtends({
    localDirs: ['/local'],
    installedDir: '/installed',
    builtin: () => null,
    exists: () => false,
  });
  assert.equal(resolve('nope'), null);
});

test('multiple localDirs — earliest matching dir wins', () => {
  const present = new Set([
    blueprintFileIn('/local2', 'x'),
    blueprintFileIn('/local3', 'x'),
  ]);
  const resolve = makeComposedResolveExtends({
    localDirs: ['/local1', '/local2', '/local3'],
    builtin: () => null,
    exists: (p) => present.has(p),
  });
  assert.equal(resolve('x'), blueprintFileIn('/local2', 'x'));
});

test('default options degenerate to the built-in resolver (real coding built-in)', () => {
  // No local/installed tiers + default builtin (resolveBuiltinExtends) → finds
  // the shipped built-in `coding`.
  const resolve = makeComposedResolveExtends();
  const p = resolve('coding');
  assert.ok(p && p.endsWith(join('coding', 'blueprint.yaml')), `expected a coding built-in path, got ${p}`);
  assert.equal(resolve('does-not-exist-blueprint'), null);
});

// ── end-to-end through the loader ────────────────────────────────────────────
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('e2e: a local blueprint can `extends` a built-in and merge through the loader', () => {
  // Lay out a project-local blueprints root with `myproj` extending built-in `coding`.
  const projectRoot = mkdtempSync(join(tmpdir(), 'bp-compose-'));
  tmpDirs.push(projectRoot);
  const localBlueprints = join(projectRoot, '.papercusp', 'blueprints');
  const myDir = join(localBlueprints, 'myproj');
  mkdirSync(myDir, { recursive: true });
  const myPath = join(myDir, 'blueprint.yaml');
  writeFileSync(
    myPath,
    [
      'id: myproj',
      'extends: coding',
      'description: a local override of coding',
      'knobs:',
      '  maxCostUsd: 42',
      '',
    ].join('\n'),
    'utf8',
  );

  const resolve = makeComposedResolveExtends({ localDirs: [localBlueprints] });
  const { blueprint, validation } = loadBlueprintFromFile(myPath, resolve);

  assert.equal(blueprint.id, 'myproj');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  // Inherited from coding (and coding's own parent, base):
  assert.equal(blueprint.knobs.harnessKind, 'coding');
  assert.equal(blueprint.knobs.requiresRepo, true);
  assert.equal(blueprint.knobs.logRetention, 500); // from base
  assert.equal(blueprint.planner.kind, 'features-import'); // from coding
  // Child override applied:
  assert.equal(blueprint.knobs.maxCostUsd, 42);
  // `extends` consumed.
  assert.equal(blueprint.extends, undefined);
});
