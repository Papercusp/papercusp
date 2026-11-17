/**
 * identities-v1-2026-08-30 P-020 — the fleet postures are IDENTITIES, resolved through the
 * prompt chain (D-003 as narrowed by D-007; D-022 §5–6).
 *
 * What this pins: (1) every identity-homed su part document belongs to a built-in identity
 * blueprint (`blueprints/<id>/blueprint.yaml`) that declares EXACTLY the slot the document
 * fills and is abstract (a layer, never runnable alone) — `su.fleet-member` / `su.fleet-leader`
 * join `papercusp-engineer` / `su-collaborator`; (2) the su stack composer reads those
 * documents THROUGH THE CHAIN (`identityRoots`, most specific tier first), so an installed
 * override wins over the built-in copy and a bound identity installed in no tier REFUSES
 * the render; (3) the ⟦stack⟧ mutation payload is fed by the same resolution.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { builtinBlueprintPath, resolveBuiltinExtends, resolveLayers } from './loader.js';
import { isIdentitySourceDocument, parseBlueprintSourceDocument } from './schema.js';
import {
  SU_PART_DOCUMENTS,
  locateSuTiles,
  readSuSource,
  suPartDocumentBlueprintId,
  suPartDocumentHome,
} from './su-decomposition.js';
import {
  composeSuStackMutation,
  composeSuStackSource,
  resolveSuIdentityDocument,
  suBoundLayerDocument,
  suIdentityRoots,
  suPostureLayer,
  suStackDocuments,
} from './su-stack.js';
import { bindingRefs } from './stack-mutation.js';

const here = dirname(fileURLToPath(import.meta.url));
const harnessDir = join(here, '..', '..', '..', 'harness'); // libs/papercusp/packages/harness

const IDENTITY_IDS = ['papercusp-engineer', 'su-collaborator', 'su.fleet-member', 'su.fleet-leader'] as const;

test('P-020 — the identity-homed part documents are exactly the four identities; each has a built-in ABSTRACT blueprint declaring EXACTLY its slot', () => {
  const identityDocs = SU_PART_DOCUMENTS.filter((d) => suPartDocumentHome(d) === 'identity');
  assert.deepEqual(identityDocs.map((d) => d.id).sort(), [...IDENTITY_IDS].sort());
  assert.deepEqual(
    SU_PART_DOCUMENTS.filter((d) => suPartDocumentHome(d) === 'base').map((d) => d.id),
    ['su.kernel', 'su.practice', 'su.instance'],
    'kernel / practice / instance stay base-homed (tile-rendered)',
  );
  for (const d of identityDocs) {
    const id = suPartDocumentBlueprintId(d);
    assert.equal(id, d.id, `${d.path}: the identity blueprint dir is named by the document id`);
    // ABSTRACT, like `base`: never loaded standalone (the runnable schema wants a spine and a
    // work item), so resolve the extends stack the way the loader's own golden test does and
    // inspect the merged document.
    const path = builtinBlueprintPath(id!);
    const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(raw.extends, 'identity-root', `${id} extends the portable identity root`);
    const merged = resolveLayers(raw, resolveBuiltinExtends, path).merged as Record<string, unknown>;
    assert.equal(merged.id, id);
    assert.equal(isIdentitySourceDocument(parseBlueprintSourceDocument(raw)), true, `${id} declares its identity kind in its own source (D-028)`);
    assert.deepEqual(
      ((merged.slots ?? []) as Array<{ slot: string }>).map((s) => s.slot),
      [d.part],
      `${id} declares EXACTLY the slot its document fills`,
    );
    assert.equal(merged.spine ?? null, null, `${id} is abstract (no spine)`);
    assert.equal(merged.workItem ?? null, null, `${id} is abstract (no workItem)`);
    // Its document is on disk at the declared path (the extraction gen:su-decomposition writes).
    assert.ok(readFileSync(join(harnessDir, d.path), 'utf8').length > 0, `${d.path} exists`);
  }
  // The two postures are exclusive on ONE slot: member and leader never co-bind (D-003 / D-007).
  assert.equal(suPostureLayer('member').slot, 'fleet-posture');
  assert.equal(suPostureLayer('leader').slot, 'fleet-posture');
});

test('P-020 — the composer resolves identity documents THROUGH THE CHAIN: sourcePath is the identity file, an installed tier overrides the built-in copy, a missing identity refuses; the tiles stay byte-equal', () => {
  // Default roots: the harness dir alone (the built-in tier).
  assert.deepEqual(suIdentityRoots({ harnessDir }), [harnessDir]);
  const member = suStackDocuments({ harnessDir, posture: 'member' });
  const postureDoc = member.docs.find((d) => d.slot === 'fleet-posture')!;
  assert.equal(postureDoc.id, 'su.fleet-member');
  assert.equal(postureDoc.sourcePath, join(harnessDir, 'blueprints/su.fleet-member/prompts/fleet-posture.md'));
  assert.equal(member.docs.find((d) => d.slot === 'domain')!.sourcePath, join(harnessDir, 'blueprints/papercusp-engineer/prompts/agent-base-overlay.md'));
  assert.equal(member.docs.find((d) => d.slot === 'collaboration-stance')!.sourcePath, join(harnessDir, 'blueprints/su-collaborator/prompts/collaboration-stance.md'));
  assert.equal(member.docs.find((d) => d.slot === 'practice')!.sourcePath, 'blueprints/base/prompts/su.practice.md', 'a base-homed document still renders from its tiles');

  // The chain-resolved text IS the tile derivation, byte for byte (the drift test guards the file; this guards the seam).
  const located = locateSuTiles(readSuSource(harnessDir));
  for (const role of ['member', 'leader'] as const) {
    const layer = suPostureLayer(role);
    const fromTiles = suBoundLayerDocument(located, layer)!; // no resolve ⇒ tiles (the located-only caller)
    const fromChain = suBoundLayerDocument(located, layer, { identityRoots: [harnessDir] })!;
    assert.equal(fromChain.text, fromTiles.text, `${layer.id}: identity file == its tiles`);
    assert.notEqual(fromChain.sourcePath, fromTiles.sourcePath);
  }

  // An installed tier in FRONT of the built-in harness wins — and feeds the ⟦stack⟧ payload too.
  const tmp = mkdtempSync(join(tmpdir(), 'su-identities-'));
  try {
    const override = '## Working as a fleet LEADER — installed override\n\nThis text comes from the installed tier.\n';
    mkdirSync(join(tmp, 'blueprints/su.fleet-leader/prompts'), { recursive: true });
    writeFileSync(join(tmp, 'blueprints/su.fleet-leader/prompts/fleet-posture.md'), override);
    const part = SU_PART_DOCUMENTS.find((d) => d.id === 'su.fleet-leader')!;
    assert.equal(resolveSuIdentityDocument(part, [tmp, harnessDir])!.root, tmp);
    assert.equal(resolveSuIdentityDocument(part, [harnessDir, tmp])!.root, harnessDir, 'order = precedence');
    assert.equal(resolveSuIdentityDocument(part, [tmp + '-nowhere']), null);

    const leader = composeSuStackSource({ harnessDir, posture: 'leader', identityRoots: [tmp, harnessDir] });
    assert.ok(leader.text.includes('installed override'), 'the installed leader posture rendered');
    assert.ok(!leader.text.includes("- **When the owner designates you a fleet's leader, CLAIM it as your FIRST act"), 'the built-in leader tiles did NOT render');
    assert.ok(leader.text.includes('## Working as a fleet MEMBER') === false, 'no member text on a leader render');

    const swapped = composeSuStackMutation({
      harnessDir,
      identityRoots: [tmp, harnessDir],
      binding: { layers: [suPostureLayer('member')] },
      op: 'attach',
      layer: { slot: 'fleet-posture', id: 'su.fleet-leader' },
    });
    assert.deepEqual(swapped.mutation.replaced, { slot: 'fleet-posture', id: 'su.fleet-member' });
    assert.ok(swapped.injection!.includes('installed override'), 'the inject-now payload carries the chain-resolved text');
    assert.deepEqual(bindingRefs(swapped.runtimeBinding), ['fleet-posture:su.fleet-leader']);

    // Installed in NO tier ⇒ refuse loudly (never silently fall back to su.md's tiles).
    assert.throws(
      () => composeSuStackSource({ harnessDir, posture: 'leader', identityRoots: [tmp + '-nowhere'] }),
      /exists in none of the identity roots/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
