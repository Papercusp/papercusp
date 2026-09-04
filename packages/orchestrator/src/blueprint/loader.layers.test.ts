/**
 * identities-v1-2026-08-30 P-001 — the loader's per-LAYER surface: `resolveLayers`
 * (the extends walk keeping every merged document), `layerContentHash`
 * (attestation-excluded sha256 per layer), and the two stack-level load
 * refusals — `attestation-hash-mismatch` and the D-007 `slot-exclusive-conflict`.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as toYaml } from 'yaml';
import { resolveBlueprint, resolveLayers, resolveExtends, layerContentHash, loadBlueprintFromFile, loadBuiltinBlueprint } from './loader.js';

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

test('resolveLayers — layers come back parent-first with the loaded document last, each with its own hash', () => {
  const { resolve, cleanup } = chain({
    kernel: { id: 'kernel', knobs: { logRetention: 5 } },
    eng: { id: 'eng', extends: 'kernel', slots: [{ slot: 'domain' }] },
  });
  try {
    const root = { id: 'me', extends: 'eng', ...runnable };
    const { merged, layers } = resolveLayers(root, resolve, '/virtual/me.yaml');
    assert.deepEqual(layers.map((l) => l.id), ['kernel', 'eng', 'me']);
    assert.deepEqual(layers.map((l) => l.sourceKind), ['blueprint', 'identity', 'blueprint']);
    assert.deepEqual(layers.map((l) => l.slots), [[], ['domain'], []]);
    assert.equal(layers[2]!.sourcePath, '/virtual/me.yaml');
    assert.ok(layers[0]!.sourcePath?.endsWith(join('kernel', 'blueprint.yaml')));
    assert.deepEqual(layers.map((l) => l.attestation), [null, null, null]);
    assert.equal(merged.extends, undefined, 'extends is consumed');
    assert.equal((merged.knobs as { logRetention: number }).logRetention, 5, 'grandparent knobs inherited');
    assert.equal(new Set(layers.map((l) => l.contentHash)).size, 3, 'three distinct 64-hex hashes');
    for (const l of layers) assert.match(l.contentHash, /^[0-9a-f]{64}$/);
    // resolveExtends is the same walk minus the layers (the pre-P-001 signature).
    assert.deepEqual(resolveExtends(root, resolve), merged);
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
    assert.deepEqual(loaded.layers.map((l) => l.attestation), [
      { contentHash: layerContentHash(doc), signedBy: 'p' },
      null,
    ]);
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
    assert.deepEqual(ok.layers.map((l) => l.id), ['engA', 'pracA', 'pracB', 'stack']);
    assert.equal(ok.validation.ok, true);
    const diamond = resolveBlueprint({ id: 'diamond', extends: ['pracA', 'pracB'], ...runnable }, { resolve });
    assert.deepEqual(diamond.layers.map((l) => l.id), ['pracA', 'pracA', 'pracB', 'diamond'], 'a diamond lists the shared ancestor twice');
    const same = resolveBlueprint({ id: 'same', extends: ['engA', 'engA'], ...runnable }, { resolve });
    assert.equal(same.validation.ok, true, 'the same exclusive document reached twice is ONE claimant');
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
  assert.equal(loaded.layers.some((layer) => layer.id === 'papercusp-engineer' && layer.sourceKind === 'identity'), true);
  assert.deepEqual(loaded.blueprint.slots?.map((slot) => slot.slot), ['domain'], 'resolved runnable still carries the inherited domain slot');
});
