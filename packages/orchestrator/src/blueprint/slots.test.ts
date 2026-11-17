/**
 * identities-v1-2026-08-30 P-001 — the slot registry (D-007 as amended, D-008
 * amendment, D-011, D-017) and the D-007 hard-error rule as a pure function.
 * The last test PINS docs/COMPOSITION_MODEL.md's slot table to this registry.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileAgentSpecification } from './composition-compiler.js';
import {
  LAYER_ORDER,
  RESERVED_LAYERS,
  SLOT_IDS,
  SLOT_REGISTRY,
  MODE_AXES,
  BUNDLE_KINDS,
  slotSpec,
  isSlotId,
  compareSlotOrder,
  slotLayerIndex,
  documentLayerIndex,
  findExclusiveSlotConflicts,
  renderSlotRegistryMarkdown,
} from './slots.js';

test('R-13: two layers in any single-layer slot are refused, naming the slot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exclusive-stack-slots-'));
  try {
    for (const spec of SLOT_REGISTRY.filter((slot) => slot.cardinality === 'exclusive')) {
      const paths = new Map(['first', 'second'].map((id) => {
        const path = join(dir, id + '.yaml');
        writeFileSync(path, JSON.stringify({ id, slots: [{ slot: spec.slot }] }));
        return [id, path];
      }));
      assert.throws(() => compileAgentSpecification({
        source: { id: 'conflicting-stack', slots: [], extends: ['first', 'second'] },
        resolve: (id) => paths.get(id) ?? null,
      }), new RegExp(`exclusive slot "${spec.slot}"`), spec.slot);
    }
    for (const id of ['first', 'second']) {
      writeFileSync(join(dir, id + '.yaml'), JSON.stringify({ id, slots: [{ slot: 'practice' }] }));
    }
    assert.equal(compileAgentSpecification({
      source: { id: 'additive-stack', slots: [], extends: ['first', 'second'] },
      resolve: (id) => join(dir, id + '.yaml'),
    }).configuration.id, 'additive-stack');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the registry is in layering order, every slot sits on a declarable layer, ids are unique', () => {
  assert.deepEqual([...LAYER_ORDER], ['kernel', 'client', 'domain', 'fleet-posture', 'modes', 'practices', 'instance']);
  const idx = SLOT_REGISTRY.map((s) => LAYER_ORDER.indexOf(s.layer));
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i]! >= idx[i - 1]!, `${SLOT_REGISTRY[i]!.slot} is out of layering order`);
  }
  for (const s of SLOT_REGISTRY) assert.ok(!RESERVED_LAYERS.has(s.layer), `${s.slot} sits on a reserved layer`);
  assert.equal(new Set(SLOT_IDS).size, SLOT_IDS.length);
  assert.deepEqual(SLOT_REGISTRY.map((s) => s.slot), [...SLOT_IDS]);
});

test('cardinalities per D-007 / D-008 / D-017: mode axes exclusive on `modes`; client/domain/fleet-posture/collaboration-stance exclusive; practice is the only additive slot', () => {
  for (const axis of MODE_AXES) {
    assert.equal(slotSpec(axis)?.cardinality, 'exclusive', axis);
    assert.equal(slotSpec(axis)?.layer, 'modes', axis);
  }
  assert.deepEqual([...MODE_AXES], ['autonomy', 'ideation', 'objective', 'grade', 'test', 'goal', 'audit', 'audience']);
  assert.deepEqual(SLOT_REGISTRY.filter((s) => s.cardinality === 'additive').map((s) => s.slot), ['practice']);
  for (const slot of ['client', 'domain', 'fleet-posture', 'collaboration-stance'] as const) {
    assert.equal(slotSpec(slot)?.cardinality, 'exclusive', slot);
  }
  assert.equal(slotSpec('collaboration-stance')?.layer, 'practices');
  // Reserved layers are not slots; an unknown id is not a slot.
  assert.equal(slotSpec('kernel'), null);
  assert.equal(slotSpec('instance'), null);
  assert.equal(isSlotId('risk-posture'), false);
  assert.equal(isSlotId('domain'), true);
});

test('ordering helpers: by layer, then declaration order within a layer', () => {
  assert.ok(compareSlotOrder('client', 'domain') < 0);
  assert.ok(compareSlotOrder('practice', 'autonomy') > 0);
  assert.ok(compareSlotOrder('collaboration-stance', 'practice') < 0, 'stance renders before practices within the practices layer');
  assert.equal(compareSlotOrder('audit', 'audit'), 0);
  assert.equal(slotLayerIndex('domain'), 2);
  assert.equal(documentLayerIndex([{ slot: 'fleet-posture' }, { slot: 'domain' }]), 2, 'a document sits at its LOWEST layer');
  assert.equal(documentLayerIndex([{ slot: 'nope' }]), null);
  assert.equal(documentLayerIndex([]), null);
});

test('findExclusiveSlotConflicts — the D-007 hard-error rule over per-layer claims', () => {
  assert.deepEqual(findExclusiveSlotConflicts([{ id: 'a', slot: 'domain' }, { id: 'b', slot: 'domain' }]), [
    { slot: 'domain', claimants: ['a', 'b'] },
  ]);
  assert.deepEqual(findExclusiveSlotConflicts([{ id: 'a', slot: 'practice' }, { id: 'b', slot: 'practice' }]), [], 'additive slots stack');
  assert.deepEqual(findExclusiveSlotConflicts([{ id: 'a', slot: 'domain' }, { id: 'a', slot: 'domain' }]), [], 'the same document twice (diamond extends) is one claimant');
  assert.deepEqual(findExclusiveSlotConflicts([{ id: 'a', slot: 'autonomy' }, { id: 'b', slot: 'ideation' }]), [], 'mode axes are additive ACROSS axes');
  assert.deepEqual(findExclusiveSlotConflicts([{ id: 'a', slot: 'bogus' }, { id: 'b', slot: 'bogus' }]), [], 'unknown slots are validation’s job, not a conflict');
  assert.deepEqual(
    findExclusiveSlotConflicts([{ id: 'z', slot: 'client' }, { id: 'y', slot: 'client' }, { id: 'z', slot: 'client' }]),
    [{ slot: 'client', claimants: ['z', 'y'] }],
    'claimants keep claim order, deduplicated',
  );
});

test('BUNDLE_KINDS is the D-011 vocabulary — and carries no `skill` kind (owner ruling 2026-09-02)', () => {
  // `plan` + `goal` added 2026-09-16: both were already live Cupboard listing kinds with
  // their own publish verbs while absent here, so D-011's uniform list was true of the text
  // and false of the code. Kept as an EXACT assertion on purpose — it is what makes the next
  // silent divergence between the listing kinds and this vocabulary fail loudly.
  assert.deepEqual(
    [...BUNDLE_KINDS],
    ['recipe', 'rubric', 'knowledge-pack', 'plan', 'goal', 'datatype', 'event', 'rule'],
  );
});

test('docs/COMPOSITION_MODEL.md embeds EXACTLY this registry (pinned prose — it cannot describe another one)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const doc = readFileSync(join(here, '..', '..', 'docs', 'COMPOSITION_MODEL.md'), 'utf8');
  const m = /<!-- SLOT-REGISTRY:BEGIN -->\n([\s\S]*?)\n<!-- SLOT-REGISTRY:END -->/.exec(doc);
  assert.ok(m, 'the doc carries the SLOT-REGISTRY:BEGIN/END markers');
  assert.equal(m![1], renderSlotRegistryMarkdown(), 'the embedded slot table drifted from slots.ts — re-paste renderSlotRegistryMarkdown() between the markers');
});
