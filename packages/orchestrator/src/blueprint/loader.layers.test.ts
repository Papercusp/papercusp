/**
 * identities-v1-2026-08-30 P-001 — the loader's per-LAYER surface: `resolveLayers`
 * (the extends walk keeping every merged document), `layerContentHash`
 * (attestation-excluded sha256 per layer), plus source-aware stack refusals:
 * attestation mismatch, exclusive-slot conflict, and D-029 exact bundle-pin
 * conflict.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as toYaml } from 'yaml';
import { harnessRootCandidates } from '@papercusp/harness/paths';
import {
  resolveBlueprint,
  resolveBlueprintSource,
  resolveLayers,
  resolveExtends,
  MAX_BLUEPRINT_EXTENDS_DEPTH,
  MAX_BLUEPRINT_EXPANDED_LAYERS,
  layerContentHash,
  layerTrust,
  loadBlueprintFromFile,
  loadBuiltinBlueprint,
} from './loader.js';

/** Materialize a set of blueprint documents on disk + a resolver over them. */
function chain(docs: Record<string, Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), 'bp-layers-'));
  for (const [id, doc] of Object.entries(docs)) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'blueprint.yaml'), toYaml(doc), 'utf8');
  }
  const resolve = (id: string): string | null => (id in docs ? join(dir, id, 'blueprint.yaml') : null);
  return { dir, resolve, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const runnable = { workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } };

test('R-1: identities cannot inherit workspace fields through a direct or indirect parent', () => {
  const fixture = chain({
    workspace: { id: 'workspace', knobs: { logRetention: 5 } },
    indirect: { id: 'indirect', extends: 'workspace' },
    root: { id: 'identity-root', slots: [] },
    portable: { id: 'portable', extends: 'root', slots: [{ slot: 'domain' }] },
  });
  try {
    for (const parent of ['workspace', 'indirect']) {
      const identity = { id: 'identity', extends: parent, slots: [{ slot: 'domain' }] };
      assert.throws(() => resolveBlueprintSource(identity, { resolve: fixture.resolve }),
        /identity "identity" cannot extend workspace blueprint "workspace"/);
      assert.throws(() => resolveBlueprint({ ...runnable, id: 'runtime', extends: parent, slots: [] }, { resolve: fixture.resolve }),
        /Unrecognized key/);
    }
    assert.equal(resolveBlueprintSource({ id: 'valid', extends: 'portable', slots: [] },
      { resolve: fixture.resolve }).validation.ok, true);
    const workspace = resolveBlueprint({ id: 'runtime', extends: ['workspace', 'portable'], ...runnable },
      { resolve: fixture.resolve });
    assert.equal(workspace.blueprint.knobs.logRetention, 5, 'workspaces still combine their own runtime configuration with portable layers');
  } finally {
    fixture.cleanup();
  }
});

test('layerTrust recognizes every built-in harness root without accepting a prefix lookalike', () => {
  for (const root of harnessRootCandidates()) {
    assert.equal(layerTrust(join(root, 'blueprints', 'su.mode-goal', 'blueprint.yaml')), 'builtin');
    assert.equal(layerTrust(join(root, 'blueprints-elsewhere', 'su.mode-goal', 'blueprint.yaml')), 'local');
  }
});

test('resolveLayers — layers come back parent-first with the loaded document last, each with its own hash', () => {
  const { resolve, cleanup } = chain({
    kernel: { id: 'kernel', slots: [], lexicon: { workUnit: 'deliverable' } },
    eng: { id: 'eng', extends: 'kernel', slots: [{ slot: 'domain' }] },
  });
  try {
    const root = { id: 'me', extends: 'eng', ...runnable };
    const { merged, layers } = resolveLayers(root, resolve, '/virtual/me.yaml');
    assert.deepEqual(
      layers.map((l) => l.id),
      ['kernel', 'eng', 'me'],
    );
    assert.deepEqual(
      layers.map((l) => l.sourceKind),
      ['identity', 'identity', 'blueprint'],
    );
    assert.deepEqual(
      layers.map((l) => l.slots),
      [[], ['domain'], []],
    );
    assert.equal(layers[2]!.sourcePath, '/virtual/me.yaml');
    assert.ok(layers[0]!.sourcePath?.endsWith(join('kernel', 'blueprint.yaml')));
    assert.deepEqual(
      layers.map((l) => l.attestation),
      [null, null, null],
    );
    assert.equal(merged.extends, undefined, 'extends is consumed');
    assert.equal((merged.lexicon as { workUnit: string }).workUnit, 'deliverable', 'grandparent portable lexicon inherited');
    assert.equal(new Set(layers.map((l) => l.contentHash)).size, 3, 'three distinct 64-hex hashes');
    for (const l of layers) assert.match(l.contentHash, /^[0-9a-f]{64}$/);
    // resolveExtends is the same walk minus the layers (the pre-P-001 signature).
    assert.deepEqual(resolveExtends(root, resolve), merged);
  } finally {
    cleanup();
  }
});

test('resolveLayers bounds inherited depth and names the failing path', () => {
  const docs = Object.fromEntries(
    Array.from({ length: MAX_BLUEPRINT_EXTENDS_DEPTH + 1 }, (_, i) => [
      `node${i + 1}`,
      { id: `node${i + 1}`, ...(i < MAX_BLUEPRINT_EXTENDS_DEPTH ? { extends: `node${i + 2}` } : {}) },
    ]),
  );
  const { resolve, cleanup } = chain(docs);
  try {
    const allowed = resolveLayers({ id: 'root', extends: 'node2' }, resolve);
    assert.equal(allowed.layers.length, MAX_BLUEPRINT_EXTENDS_DEPTH + 1);
    assert.throws(
      () => resolveLayers({ id: 'root', extends: 'node1' }, resolve),
      /blueprint extends depth exceeds 32 at "node33".*path: node1 ->.*node33/,
    );
  } finally {
    cleanup();
  }
});

test('resolveLayers bounds repeated-ancestor expansion before it can grow without limit', () => {
  const { resolve, cleanup } = chain({ leaf: { id: 'leaf' } });
  try {
    const allowed = resolveLayers({ id: 'root', extends: Array(MAX_BLUEPRINT_EXPANDED_LAYERS - 1).fill('leaf') }, resolve);
    assert.equal(allowed.layers.length, MAX_BLUEPRINT_EXPANDED_LAYERS);
    assert.throws(
      () => resolveLayers({ id: 'root', extends: Array(MAX_BLUEPRINT_EXPANDED_LAYERS).fill('leaf') }, resolve),
      /blueprint expanded layer count exceeds 128 at "root".*path: leaf/,
    );
  } finally {
    cleanup();
  }
});

test('layerContentHash — excludes the attestation itself and is key-order independent, so a signed document verifies against its own hash', () => {
  const raw = { id: 'x', slots: [{ slot: 'practice' }] };
  const h = layerContentHash(raw);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(layerContentHash({ ...raw, attestation: { contentHash: h, signedBy: 'p' } }), h);
  assert.equal(layerContentHash({ slots: [{ slot: 'practice' }], id: 'x' }), h);
  assert.notEqual(layerContentHash({ ...raw, id: 'y' }), h);
});

test('resolveBlueprint — a layer whose attestation disagrees with its content fails the load (attestation-hash-mismatch)', () => {
  const doc = { id: 'signed', slots: [{ slot: 'practice' }] };
  const good = { ...doc, attestation: { contentHash: layerContentHash(doc), signedBy: 'p' } };
  const bad = { ...doc, attestation: { contentHash: 'a'.repeat(64), signedBy: 'p' } };
  const goodChain = chain({ signed: good });
  try {
    const loaded = resolveBlueprint({ id: 'runtime', extends: 'signed', ...runnable }, { resolve: goodChain.resolve });
    assert.equal(loaded.validation.ok, true, JSON.stringify(loaded.validation.errors));
    assert.deepEqual(
      loaded.layers.map((l) => l.attestation),
      [{ contentHash: layerContentHash(doc), signedBy: 'p' }, null],
    );
  } finally {
    goodChain.cleanup();
  }
  const badChain = chain({ signed: bad });
  try {
    assert.throws(
      () => resolveBlueprint({ id: 'runtime', extends: 'signed', ...runnable }, { resolve: badChain.resolve }),
      /attestation-hash-mismatch: layer "signed"/,
    );
  } finally {
    badChain.cleanup();
  }
});

test('resolveBlueprint — two DISTINCT layers on one exclusive slot fail the load; additive slots stack; a diamond re-visit is one claimant (D-007)', () => {
  const { resolve, cleanup } = chain({
    engA: { id: 'engA', slots: [{ slot: 'domain' }] },
    engB: { id: 'engB', slots: [{ slot: 'domain' }] },
    pracA: { id: 'pracA', slots: [{ slot: 'practice' }] },
    pracB: { id: 'pracB', extends: 'pracA', slots: [{ slot: 'practice' }] },
  });
  try {
    assert.throws(
      () => resolveBlueprint({ id: 'two-domains', extends: ['engA', 'engB'], ...runnable }, { resolve }),
      /slot-exclusive-conflict: exclusive slot "domain" is claimed by 2 layers \(engA, engB\)/,
    );
    const ok = resolveBlueprint({ id: 'stack', extends: ['engA', 'pracB'], ...runnable }, { resolve });
    assert.deepEqual(
      ok.layers.map((l) => l.id),
      ['engA', 'pracA', 'pracB', 'stack'],
    );
    assert.equal(ok.validation.ok, true);
    const diamond = resolveBlueprint({ id: 'diamond', extends: ['pracA', 'pracB'], ...runnable }, { resolve });
    assert.deepEqual(
      diamond.layers.map((l) => l.id),
      ['pracA', 'pracA', 'pracB', 'diamond'],
      'a diamond lists the shared ancestor twice',
    );
    const same = resolveBlueprint({ id: 'same', extends: ['engA', 'engA'], ...runnable }, { resolve });
    assert.equal(same.validation.ok, true, 'the same exclusive document reached twice is ONE claimant');
  } finally {
    cleanup();
  }
});

test('D-029 — incompatible exact bundle pins fail in both parent orders and name every contributing source', () => {
  const { resolve, cleanup } = chain({
    v1: { id: 'bundle-v1', bundles: [{ kind: 'recipe', ref: 'shared', version: '1.0.0' }] },
    v2: { id: 'bundle-v2', bundles: [{ kind: 'recipe', ref: 'shared', version: '2.0.0' }] },
  });
  try {
    for (const parents of [
      ['v1', 'v2'],
      ['v2', 'v1'],
    ] as const) {
      assert.throws(
        () => resolveBlueprint({ id: `root-${parents.join('-')}`, extends: parents, ...runnable }, { resolve }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes('bundle-version-conflict') &&
          error.message.includes('bundle "recipe/shared"') &&
          error.message.includes('layer "bundle-v1" pins "1.0.0"') &&
          error.message.includes('layer "bundle-v2" pins "2.0.0"'),
      );
    }
  } finally {
    cleanup();
  }
});

test('D-029 — same-version peer declarations and a duplicated diamond source resolve to one effective bundle', () => {
  const { resolve, cleanup } = chain({
    shared: { id: 'shared-source', bundles: [{ kind: 'recipe', ref: 'shared', version: '1.0.0' }] },
    left: { id: 'left', extends: 'shared' },
    right: { id: 'right', extends: 'shared' },
    peer: { id: 'same-version-peer', bundles: [{ kind: 'recipe', ref: 'shared', version: '1.0.0' }] },
  });
  try {
    const loaded = resolveBlueprint(
      { id: 'diamond-root', extends: ['left', 'right', 'peer'], ...runnable },
      { resolve },
    );
    assert.equal(loaded.validation.ok, true);
    assert.deepEqual(
      loaded.layers.map((layer) => layer.id),
      ['shared-source', 'left', 'shared-source', 'right', 'same-version-peer', 'diamond-root'],
    );
    assert.deepEqual(loaded.blueprint.bundles, [{ kind: 'recipe', ref: 'shared', version: '1.0.0' }]);
  } finally {
    cleanup();
  }
});

test('P-002 — identical contribution claims compose once, while conflicting ids name both layers', () => {
  const declaration = { id: 'task-context', purpose: 'prompt', source: 'provider', refresh: 'turn', inputKind: 'prompt-file', ref: 'provider:task', producerRef: 'papercusp.turn-start-orientation@1', verb: 'render' };
  const { resolve, cleanup } = chain({
    left: { id: 'left', contributions: [declaration] },
    same: { id: 'same', contributions: [declaration] },
    different: { id: 'different', contributions: [{ ...declaration, ref: 'provider:other' }] },
  });
  try {
    const ok = resolveBlueprint({ id: 'ok', extends: ['left', 'same'], ...runnable }, { resolve });
    assert.deepEqual(ok.blueprint.contributions, [declaration]);
    assert.throws(
      () => resolveBlueprint({ id: 'conflict', extends: ['left', 'different'], ...runnable }, { resolve }),
      /contribution-conflict: contribution "task-context" conflicts between layer "left".*layer "different"/,
    );
  } finally {
    cleanup();
  }
});

test('D-029 — a validated higher-precedence override can replace every prior version; an incomplete override still fails', () => {
  const { resolve, cleanup } = chain({
    v1: { id: 'bundle-v1', bundles: [{ kind: 'recipe', ref: 'shared', version: '1.0.0' }] },
    v2: { id: 'bundle-v2', bundles: [{ kind: 'recipe', ref: 'shared', version: '2.0.0' }] },
  });
  try {
    const versionOverride = { replaces: ['1.0.0', '2.0.0'], reason: 'tested migration to v3' };
    const loaded = resolveBlueprint(
      {
        id: 'complete-override',
        extends: ['v1', 'v2'],
        bundles: [{ kind: 'recipe', ref: 'shared', version: '3.0.0', versionOverride }],
        ...runnable,
      },
      { resolve },
    );
    assert.deepEqual(loaded.blueprint.bundles, [{ kind: 'recipe', ref: 'shared', version: '3.0.0', versionOverride }]);
    assert.deepEqual(
      loaded.layers.flatMap((layer) => layer.bundles.map((bundle) => [layer.id, bundle.version])),
      [
        ['bundle-v1', '1.0.0'],
        ['bundle-v2', '2.0.0'],
        ['complete-override', '3.0.0'],
      ],
      'source provenance survives alongside the resolved override',
    );

    assert.throws(
      () =>
        resolveBlueprint(
          {
            id: 'incomplete-override',
            extends: ['v1', 'v2'],
            bundles: [
              {
                kind: 'recipe',
                ref: 'shared',
                version: '3.0.0',
                versionOverride: { replaces: ['1.0.0'], reason: 'forgot the v2 peer' },
              },
            ],
            ...runnable,
          },
          { resolve },
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('bundle-version-conflict') &&
        error.message.includes('layer "bundle-v2" pins "2.0.0"') &&
        error.message.includes('layer "incomplete-override" pins "3.0.0"'),
    );
  } finally {
    cleanup();
  }
});

test('D-029 — a forbidden mode-axis authority contribution cannot be hidden by a later replacement', () => {
  const { resolve, cleanup } = chain({
    flavour: {
      id: 'mode-flavour',
      slots: [{ slot: 'autonomy' }],
      knobs: { logRetention: 5 },
    },
  });
  try {
    assert.throws(
      () =>
        resolveBlueprint(
          {
            id: 'mode-root',
            extends: 'flavour',
            knobs: { logRetention: 1 },
            ...runnable,
          },
          { resolve },
        ),
      /Unrecognized key.*knobs/,
    );
  } finally {
    cleanup();
  }
});

test('built-ins are unchanged by the extension: coding-factory still loads, stays a blueprint source, and its layers start at base', () => {
  const { layers, blueprint, sourceKind, validation } = loadBuiltinBlueprint('coding-factory');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(sourceKind, 'blueprint');
  assert.equal(blueprint.slots, undefined, 'a plain blueprint stays a non-identity');
  assert.deepEqual(blueprint.bundles, []);
  assert.equal(layers[0]!.id, 'base');
  assert.equal(layers[layers.length - 1]!.id, 'coding-factory');
  assert.ok(layers.length >= 2);
});

test('the real Papercusp pot stays a pot source when it inherits the papercusp-engineer identity (P-037)', () => {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
  const loaded = loadBlueprintFromFile(join(repositoryRoot, '.papercusp', 'blueprint.yaml'));
  assert.equal(loaded.blueprint.kind, 'pot');
  assert.equal(loaded.sourceKind, 'blueprint', 'root kind comes from its own document, not inherited slots');
  assert.equal(loaded.layers.at(-1)?.id, 'papercusp');
  assert.equal(loaded.layers.at(-1)?.sourceKind, 'blueprint');
  assert.equal(
    loaded.layers.some((layer) => layer.id === 'papercusp-engineer' && layer.sourceKind === 'identity'),
    true,
  );
  assert.deepEqual(
    loaded.blueprint.slots?.map((slot) => slot.slot),
    ['domain'],
    'resolved runnable still carries the inherited domain slot',
  );
});
