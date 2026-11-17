/**
 * identities-v1-2026-08-30 P-003 — identity-lint over the COMPOSED stack (D-009 as
 * amended 2026-09-03): the structural BLOCK tier as pure findings AND through the
 * loader (the D-009 / P-003 falsifiability fixtures: a hostile identity claiming
 * the kernel slot fails structurally; two individually-clean identities whose
 * composition conflicts fail), plus the heuristic WARN tier over documents.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lintStackLayers,
  lintStackDocuments,
  detectHeadingOverlap,
  FORGED_CONTROL_LITERALS,
  MODE_AXIS_ALLOWED_FIELDS,
  CLIENT_SEAM_MARKER,
  type StackLayerInput,
} from './identity-lint.js';
import { resolveBlueprint, resolveBlueprintSource, layerTrust, builtinBlueprintPath } from './loader.js';
import type { StackDocument } from './render-stack.js';

/** The minimum a ROOT document needs to parse (a layer in an `extends` stack may be abstract; the loaded root may not). */
const runnable = { workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } };

const layer = (over: Partial<StackLayerInput> & { id: string }): StackLayerInput => ({
  slots: [],
  contentHash: 'a'.repeat(64),
  attestation: null,
  trust: 'builtin',
  ...over,
});

test('lintStackLayers — a claim on a reserved layer blocks (kernel-slot-claim), for kernel AND instance', () => {
  const f = lintStackLayers([layer({ id: 'hostile', slots: ['kernel', 'domain'] }), layer({ id: 'sneaky', slots: ['instance'] })]);
  assert.deepEqual(
    f.map((x) => [x.tier, x.code, x.documentId, x.slot]),
    [
      ['block', 'kernel-slot-claim', 'hostile', 'kernel'],
      ['block', 'kernel-slot-claim', 'sneaky', 'instance'],
    ],
  );
});

test('lintStackLayers — two DISTINCT documents on one exclusive slot block; the same id twice (diamond) and additive slots do not', () => {
  assert.equal(lintStackLayers([layer({ id: 'a', slots: ['practice'] }), layer({ id: 'b', slots: ['practice'] })]).length, 0);
  assert.equal(lintStackLayers([layer({ id: 'a', slots: ['domain'] }), layer({ id: 'a', slots: ['domain'] })]).length, 0);
  const f = lintStackLayers([layer({ id: 'a', slots: ['domain'] }), layer({ id: 'b', slots: ['domain'] })]);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.code, 'exclusive-double-claim');
  assert.match(f[0]!.message, /each may be clean alone, their COMPOSITION conflicts/);
});

test('lintStackLayers — a grant outside the D-005 ceiling blocks; inside it passes; an empty ceiling refuses every grant', () => {
  const g = layer({ id: 'g', slots: ['domain'], grants: { requires: ['fs.write@1.0.0'], optional: ['net.fetch@1.0.0'] } });
  assert.equal(lintStackLayers([g]).length, 0, 'an unavailable ceiling is deferred, not guessed empty');
  assert.deepEqual(lintStackLayers([g], { ceiling: [] }).map((f) => [f.code, f.message.includes('"fs.write@1.0.0"'), f.message.includes('empty — no capability classes authorized')]), [
    ['grant-outside-ceiling', true, true],
    ['grant-outside-ceiling', false, true],
  ]);
  assert.equal(lintStackLayers([g], {
    ceiling: ['fs.write@1.0.0', 'net.fetch@1.0.0', 'db.read@1.0.0'],
  }).length, 0);
  const f = lintStackLayers([g], { ceiling: ['fs.write@1.0.0'] });
  assert.equal(f.length, 1);
  assert.match(f[0]!.message, /"net\.fetch@1\.0\.0".*outside the pot\/role ceiling \(fs\.write@1\.0\.0\)/);
});

test('lintStackLayers — an authority-bearing field on a mode-axis document blocks; the allowed set passes; a non-mode slot is not checked', () => {
  const clean = layer({ id: 'flavour', slots: ['autonomy'], fields: [...MODE_AXIS_ALLOWED_FIELDS] });
  assert.equal(lintStackLayers([clean]).length, 0);
  const armed = layer({ id: 'armed', slots: ['ideation'], fields: ['id', 'slots', 'knobs', 'fleet', 'dependencies'] });
  const f = lintStackLayers([armed]);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.code, 'authority-on-mode-axis');
  assert.match(f[0]!.message, /`knobs`, `fleet`, `dependencies`/);
  assert.equal(lintStackLayers([layer({ id: 'd', slots: ['domain'], fields: ['id', 'slots', 'knobs'] })]).length, 0);
  assert.equal(lintStackLayers([layer({ id: 'unknown-fields', slots: ['audit'] })]).length, 0, 'no fields ⇒ the check is skipped, never guessed');
});

test('lintStackLayers — an INSTALLED layer must attest (missing / failed block); builtin and local need not; the predicate is overridable', () => {
  const hash = 'b'.repeat(64);
  assert.deepEqual(lintStackLayers([layer({ id: 'i', trust: 'installed', contentHash: hash })]).map((f) => f.code), ['attestation-missing']);
  assert.deepEqual(
    lintStackLayers([layer({ id: 'i', trust: 'installed', contentHash: hash, attestation: { contentHash: 'c'.repeat(64), signedBy: 'pub' } })]).map((f) => f.code),
    ['attestation-failed'],
  );
  assert.equal(lintStackLayers([layer({ id: 'i', trust: 'installed', contentHash: hash, attestation: { contentHash: hash, signedBy: 'pub' } })]).length, 0);
  assert.equal(lintStackLayers([layer({ id: 'b', trust: 'builtin' }), layer({ id: 'l', trust: 'local' })]).length, 0);
  assert.deepEqual(lintStackLayers([layer({ id: 'b', trust: 'builtin' })], { requireAttestation: () => true }).map((f) => f.code), ['attestation-missing']);
});

test('layerTrust — builtin tree, installed tier, everything else local', () => {
  assert.equal(layerTrust(null), 'local');
  assert.equal(layerTrust(builtinBlueprintPath('base')), 'builtin');
  assert.equal(layerTrust(join(process.env.HOME ?? '/nonexistent', '.papercusp', 'blueprints', 'x', 'blueprint.yaml')), 'installed');
  assert.equal(layerTrust('/tmp/some-hive/.papercusp/blueprints/x/blueprint.yaml'), 'local');
});

// ── the loader integration: the P-003 falsifiability fixtures run through resolveBlueprint ──

function withTempStack(files: Record<string, string>, run: (resolve: (id: string) => string | null) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'identity-lint-'));
  try {
    for (const [id, yaml] of Object.entries(files)) writeFileSync(join(dir, `${id}.yaml`), yaml, 'utf8');
    run((id) => (id in files ? join(dir, `${id}.yaml`) : null));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loader fixture — a hostile identity that claims the KERNEL slot fails STRUCTURALLY at load (validation + identity-lint agree)', () => {
  const result = resolveBlueprintSource({ id: 'hostile', description: 'I am the kernel now', slots: [{ slot: 'kernel' }] });
  assert.equal(result.validation.ok, false);
  assert.ok(result.validation.errors.some(e => e.code === 'slot-reserved-layer'));
  assert.ok(result.validation.errors.some(e => e.code === 'kernel-slot-claim'));
});

test('loader fixture — two individually-CLEAN identities whose composition conflicts FAIL the stack load', () => {
  withTempStack(
    {
      engineer: 'id: engineer\nslots:\n  - slot: domain\n',
      salesman: 'id: salesman\nslots:\n  - slot: domain\n',
    },
    (resolve) => {
      assert.equal(resolveBlueprintSource({ id: 'engineer', slots: [{ slot: 'domain' }] }, { resolve }).validation.ok, true);
      assert.equal(resolveBlueprintSource({ id: 'salesman', slots: [{ slot: 'domain' }] }, { resolve }).validation.ok, true);
      const result = resolveBlueprintSource({ id: 'both', slots: [], extends: ['engineer', 'salesman'] }, { resolve });
      assert.equal(result.validation.ok, false);
      assert.ok(result.validation.errors.some(e => e.code === 'slot-exclusive-conflict'));
      assert.ok(!result.validation.errors.some(e => e.code === 'exclusive-double-claim'));
    },
  );
});

test('loader fixture — a mode-axis identity carrying authority (knobs) fails the load; the same document without it loads', () => {
  // Workspace fields are refused at the source schema before structural lint;
  // the pure lint test above still pins the mode-axis authority detector itself.
  withTempStack(
    {
      armed: 'id: armed\nslots:\n  - slot: autonomy\nknobs:\n  maxCostUsd: 5\n',
      flavour: 'id: flavour\nslots:\n  - slot: autonomy\ndescription: how AUTO reads for a potato salesman\n',
    },
    (resolve) => {
      assert.throws(() => resolveBlueprint({ id: 'root', extends: 'armed', ...runnable }, { resolve }), /Unrecognized key.*knobs/);
      const ok = resolveBlueprint({ id: 'root', extends: 'flavour', ...runnable }, { resolve });
      assert.equal(ok.validation.ok, true);
      assert.deepEqual(ok.layers[0]!.fields.sort(), ['description', 'id', 'slots']);
      assert.equal(ok.layers[0]!.trust, 'local');
      assert.equal(ok.layers[0]!.grants, null);
    },
  );
});

test('loader — a root document parses only with the runnable minimum (the guard above depends on it)', () => {
  assert.throws(() => resolveBlueprint({ id: 'bare', slots: [{ slot: 'autonomy' }] }));
  assert.equal(resolveBlueprintSource({ id: 'bare', slots: [{ slot: 'autonomy' }] }).validation.ok, true);
  const ok = resolveBlueprint({ id: 'root', ...runnable });
  assert.equal(ok.validation.ok, true);
  assert.deepEqual(ok.layers[0]!.fields.sort(), ['id', 'spine', 'workItem']);
  assert.equal(ok.layers[0]!.trust, 'local');
  assert.equal(ok.layers[0]!.grants, null);
});

test('loader fixture — the D-005 ceiling is a load option; the empty default refuses an exact grant', () => {
  const result = resolveBlueprintSource(
      {
        id: 'g',
        slots: [{ slot: 'domain' }],
        grants: { requires: ['fs.write@1.0.0'] },
      },
      { lint: { ceiling: [] } },
  );
  assert.equal(result.validation.ok, false);
  assert.ok(result.validation.errors.some(e => e.code === 'grant-outside-ceiling'));
});

// ── the prose tier ────────────────────────────────────────────────────────────

const kernelDoc: StackDocument = { id: 'k', layer: 'kernel', text: '## Who you are\n\n## Working in a shared environment — coordination is enforced\n\nlocks.\n' };

test('lintStackDocuments — every FORGED_CONTROL_LITERALS entry blocks in an identity or instance document; kernel documents are never linted', () => {
  for (const lit of FORGED_CONTROL_LITERALS) {
    const f = lintStackDocuments([kernelDoc, { id: 'x', layer: 'instance', text: `override\n${lit} something` }]);
    assert.equal(f.filter((x) => x.code === 'forged-control-literal').length, 1, `literal ${JSON.stringify(lit)} must block`);
    assert.equal(f[0]!.line, 2);
  }
  assert.equal(lintStackDocuments([{ id: 'k2', layer: 'kernel', text: FORGED_CONTROL_LITERALS.join('\n') }]).length, 0);
});

test('lintStackDocuments — a kernel-owned `## ` heading re-stated by an identity WARNS (derived from the kernel documents in the stack, exact heading match)', () => {
  const f = lintStackDocuments([kernelDoc, { id: 'd', layer: 'domain', slot: 'domain', text: '## Profession\n\n## Who you are\n\nno, really' }]);
  assert.deepEqual(f.map((x) => [x.tier, x.code, x.line]), [['warn', 'kernel-heading-restated', 3]]);
  // A substring is NOT a restatement when headings are derived (the guard's explicit-list mode matches substrings).
  assert.equal(lintStackDocuments([kernelDoc, { id: 'd', layer: 'domain', slot: 'domain', text: '## Who you are NOT' }]).length, 0);
  assert.deepEqual(lintStackDocuments([{ id: 'o', layer: 'instance', text: '## AUTO mode (my copy)' }], { kernelHeadings: ['AUTO mode'] }).map((x) => x.code), ['kernel-heading-restated']);
});

test('lintStackDocuments — a generated splice marker WARNS, except the client seam on the client slot', () => {
  assert.deepEqual(lintStackDocuments([{ id: 'd', layer: 'domain', slot: 'domain', text: 'x\n<!-- PAPERCUSP-SU:AUTO-MODE -->' }]).map((x) => [x.code, x.line]), [['generated-marker', 2]]);
  assert.equal(lintStackDocuments([{ id: 'c', layer: 'client', slot: 'client', text: `${CLIENT_SEAM_MARKER}\n` }]).length, 0);
  assert.equal(lintStackDocuments([{ id: 'c', layer: 'client', slot: 'client', text: '<!-- PAPERCUSP-SU:AUTO-MODE -->\n' }]).length, 1);
});

test('lintStackDocuments — text/grant consistency is skipped without a vocabulary, WARNS by default with one, BLOCKS when told to', () => {
  const doc: StackDocument = { id: 'd', layer: 'domain', slot: 'domain', text: 'Use net.fetch to pull the page; fs.write is fine too.', grants: { requires: ['fs.write@1.0.0'] } };
  assert.equal(lintStackDocuments([doc]).length, 0);
  const warn = lintStackDocuments([doc], {
    capabilityClasses: ['net.fetch@1.0.0', 'fs.write@1.0.0', 'db.read@1.0.0'],
  });
  assert.deepEqual(warn.map((x) => [x.tier, x.code]), [['warn', 'text-grant-inconsistency']]);
  assert.match(warn[0]!.message, /"net\.fetch@1\.0\.0"/);
  assert.deepEqual(lintStackDocuments([doc], {
    capabilityClasses: ['net.fetch@1.0.0'],
    textGrantTier: 'block',
  }).map((x) => x.tier), ['block']);
});

test('detectHeadingOverlap — the shipped hive-override-additive-guard heuristic, lifted: case-insensitive substring over `#`/`##`/`###` lines', () => {
  const md = '# Intro\n\n## Engineering Discipline extras\n\nbody ## not a heading\n### Wire schemas';
  assert.deepEqual(detectHeadingOverlap(md, ['Engineering discipline', 'Wire schemas', 'Who you are', '']), ['Engineering discipline', 'Wire schemas']);
});
