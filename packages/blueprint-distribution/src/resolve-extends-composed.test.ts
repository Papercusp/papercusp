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
  builtinSupersedesInstalled,
  type BuiltinSupersession,
} from './resolve-extends-composed.js';

// WI-6554700010054458: stale installed stock must not shadow a newer or valid bundled built-in.
function supersessionFixture(installedYaml: string, builtinYaml: string) {
  const root = mkdtempSync(join(tmpdir(), 'bp-supersede-'));
  const installedDir = join(root, 'installed');
  const builtinFile = join(root, 'builtin', 'x', 'blueprint.yaml');
  mkdirSync(join(installedDir, 'x'), { recursive: true });
  mkdirSync(join(root, 'builtin', 'x'), { recursive: true });
  writeFileSync(blueprintFileIn(installedDir, 'x'), installedYaml);
  writeFileSync(builtinFile, builtinYaml);
  const seen: BuiltinSupersession[] = [];
  const resolve = makeComposedResolveExtends({
    installedDir,
    builtin: (id) => (id === 'x' ? builtinFile : null),
    onSuperseded: (verdict) => seen.push(verdict),
  });
  return { root, installedFile: blueprintFileIn(installedDir, 'x'), builtinFile, resolve, seen, installedDir };
}

test('supersession: an installed identity carrying visibility yields to the valid same-version built-in', () => {
  const f = supersessionFixture(
    'id: x\nversion: 0.1.2\nvisibility: public\nslots: []\n',
    'id: x\nversion: 0.1.2\nslots: []\n',
  );
  try {
    assert.equal(f.resolve('x'), f.builtinFile);
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0]!.reason, 'invalid-source');
    assert.match(f.seen[0]!.detail, /visibility/);
    assert.equal(f.seen[0]!.installedFile, f.installedFile);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('supersession: a VALID older installed release still shadows the newer built-in (first-hit order)', () => {
  // Version is not a criterion: the consumer suites install fixture identity roots
  // (e.g. `base` at a lower version) that must never be swapped for a built-in.
  const f = supersessionFixture('id: x\nversion: 0.1.9\n', 'id: x\nversion: 0.1.10\n');
  try {
    assert.equal(f.resolve('x'), f.installedFile);
    assert.equal(f.seen.length, 0);
    assert.equal(builtinSupersedesInstalled({ id: 'x', installedFile: f.installedFile, builtinFile: f.builtinFile }), null);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('supersession: a valid same-version or newer installed copy still shadows the built-in', () => {
  for (const version of ['0.1.2', '0.2.0']) {
    const f = supersessionFixture(`id: x\nversion: ${version}\ndescription: activated\n`, 'id: x\nversion: 0.1.2\n');
    try {
      assert.equal(f.resolve('x'), f.installedFile, version);
      assert.equal(f.seen.length, 0, version);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('supersession: unreadable or invalid built-in, non-numeric versions, and supersedes:null keep first-hit order', () => {
  const f = supersessionFixture('id: x\nversion: 0.1.0\nvisibility: public\nslots: []\n', 'id: x\nbogus: 1\n');
  try {
    assert.equal(f.resolve('x'), f.installedFile, 'an invalid built-in never wins');
    assert.equal(builtinSupersedesInstalled({ id: 'x', installedFile: f.installedFile, builtinFile: '/nope/blueprint.yaml' }), null);
    writeFileSync(f.builtinFile, 'id: x\nversion: next\n');
    writeFileSync(f.installedFile, 'id: x\nversion: 0.0.1\n');
    assert.equal(f.resolve('x'), f.installedFile, 'non-numeric versions are not ordered');
    writeFileSync(f.installedFile, 'id: x\nversion: 0.0.1\nvisibility: public\nslots: []\n');
    writeFileSync(f.builtinFile, 'id: x\nversion: 0.0.1\nslots: []\n');
    const strict = makeComposedResolveExtends({ installedDir: f.installedDir, builtin: () => f.builtinFile, supersedes: null });
    assert.equal(strict('x'), f.installedFile);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

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
  // Inherited from coding and its parent base. `coding` is a hive blueprint
  // (domain-generic-hive-architecture-2026-06-18): hive kind, inline planner — and
  // it MUST be repo-backed (per-hive-git-and-release-gate-2026-06-29 D-002:
  // `requiresRepo: true`), which the child inherits.
  assert.equal(blueprint.knobs.harnessKind, 'hive');
  assert.equal(blueprint.knobs.requiresRepo, true);
  assert.equal(blueprint.knobs.logRetention, 500); // from base
  assert.equal(blueprint.planner.kind, 'inline'); // from coding
  // Child override applied:
  assert.equal(blueprint.knobs.maxCostUsd, 42);
  // `extends` consumed.
  assert.equal(blueprint.extends, undefined);
});

test('e2e: a user FORKS the built-in `vote` program blueprint without code (P4 / D-006)', () => {
  // coordination-ops-as-blueprint-primitives P4: a user declares THEIR decision
  // process by extending the built-in `vote` program blueprint and overriding the
  // knobs (different lenses, smaller quorum) — no code. The inherited program
  // spine (steps + gate) comes through unchanged.
  const projectRoot = mkdtempSync(join(tmpdir(), 'bp-vote-fork-'));
  tmpDirs.push(projectRoot);
  const localBlueprints = join(projectRoot, '.papercusp', 'blueprints');
  const myDir = join(localBlueprints, 'team-vote');
  mkdirSync(myDir, { recursive: true });
  const myPath = join(myDir, 'blueprint.yaml');
  writeFileSync(
    myPath,
    [
      'id: team-vote',
      'extends: vote',
      'description: our team decision process',
      'knobs:',
      '  lenses: [security, latency, dx]',
      '  quorum: 2',
      '',
    ].join('\n'),
    'utf8',
  );

  const resolve = makeComposedResolveExtends({ localDirs: [localBlueprints] });
  const { blueprint, validation } = loadBlueprintFromFile(myPath, resolve);

  assert.equal(blueprint.id, 'team-vote');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  // The program spine (steps + gate) is inherited from `vote` unchanged.
  assert.equal(blueprint.spine.steps?.length, 4);
  assert.ok(blueprint.spine.gate && blueprint.spine.gate.length >= 2);
  assert.equal(blueprint.workItem.kind, 'decision');
  // The user's overrides applied.
  assert.deepEqual(blueprint.knobs.lenses, ['security', 'latency', 'dx']);
  assert.equal(blueprint.knobs.quorum, 2);
  // Inherited (not overridden) vote knobs survive.
  assert.equal(blueprint.knobs.max_voters, 5);
});
