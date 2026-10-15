/**
 * identities-v1-2026-08-30 P-003 — the interactive su's composed source, over the
 * REAL harness tree: lossless (every non-dedupe tile of su.md renders exactly once),
 * ordered (identity tiles above the seal, kernel tiles under it, the seal once),
 * seams preserved for `renderSuPlaybook`, the D-018 §4 dedupe guarded.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeSuStackSource, composeSuStackMutation, suEffectiveBinding, suPostureBinding, suSessionBinding, suStackDocuments } from './su-stack.js';
import { bindingRefs, STACK_INJECTION_STAMP } from './stack-mutation.js';
import { KERNEL_SEAL_MARKER } from './render-stack.js';
import { CLIENT_SEAM_MARKER } from './identity-lint.js';
import { SU_TILES } from './su-decomposition.js';

const here = dirname(fileURLToPath(import.meta.url));
const harnessDir = join(here, '..', '..', '..', 'harness'); // libs/papercusp/packages/harness

test('host-managed assignment workflow preserves the sealed authority and evidence contract', () => {
  const normal = composeSuStackSource({ harnessDir });
  const controlled = composeSuStackSource({ harnessDir, workItemWorkflow: 'host-managed' });
  assert.deepEqual(controlled.order, normal.order);
  assert.ok(controlled.text.includes(KERNEL_SEAL_MARKER));
  for (const retained of ['operator + admin', 'File locking is ENFORCED', 'Never contest a live peer',
    '<!-- PAPERCUSP-SU:AUTO-MODE -->', 'root cause', 'filesChanged']) {
    assert.ok(controlled.text.includes(retained), `retained invariant: ${retained}`);
  }
  assert.ok(controlled.text.includes('The host owns this assignment'));
  for (const instruction of ['Declare a real intent + claim your lane',
    "Finish with `work_items:complete", 'Plan before non-trivial work.',
    'Registering work is a SEPARATE discipline']) {
    assert.ok(normal.text.includes(instruction), `positive control: ${instruction}`);
    assert.equal(controlled.text.includes(instruction), false, `withheld workflow: ${instruction}`);
  }
  assert.throws(() => composeSuStackSource({ harnessDir, workItemWorkflow: 'host-managed',
    tiles: SU_TILES.filter(t => !t.anchor.startsWith('- **Plan before')) }), /workflow/);
});

test('composeSuStackSource — lossless over the real su.md: every non-dropped tile renders exactly once; identity tiles above the seal, kernel tiles under it', () => {
  const out = composeSuStackSource({ harnessDir });
  assert.equal(out.findings.filter((f) => f.tier === 'block').length, 0, JSON.stringify(out.findings));
  const iSeal = out.text.indexOf(KERNEL_SEAL_MARKER);
  assert.ok(iSeal > 0);
  assert.equal(out.text.split(KERNEL_SEAL_MARKER).length, 2, 'one seal');
  const { located, droppedTiles } = suStackDocuments({ harnessDir });
  const dropped = new Set(droppedTiles);
  for (const t of located) {
    if (t.part === 'fleet-posture') continue; // unbound by default — attached at fleet:join / take-leadership
    const needle = t.text.trim();
    const first = out.text.indexOf(needle);
    if (dropped.has(t)) {
      assert.equal(out.text.indexOf(t.anchor), -1, `dropped dedupe tile must not render: ${t.anchor}`);
      continue;
    }
    assert.ok(first >= 0, `tile missing from the render: ${t.anchor}`);
    assert.equal(out.text.indexOf(needle, first + 1), -1, `tile renders twice: ${t.anchor}`);
    if (t.part === 'kernel') assert.ok(first > iSeal, `kernel tile must render under the seal: ${t.anchor}`);
    else assert.ok(first < iSeal, `identity/instance tile must render above the seal: ${t.anchor}`);
  }
  // Order of the identity layers is LAYER_ORDER; the kernel is last, preamble first within it.
  assert.deepEqual(
    out.order.map((e) => `${e.layer}:${e.id}`),
    ['client:client-seam', 'domain:papercusp-engineer', 'practices:su-collaborator', 'practices:su.practice', 'instance:su.instance', 'kernel:agent-base-preamble', 'kernel:su.kernel'],
  );
  assert.ok(out.text.indexOf('# Agent base preamble') > iSeal && out.text.indexOf('# Agent base preamble') < out.text.indexOf('## Who you are'));
});

test('composeSuStackSource — the D-018 §4 dedupe drops exactly the tiles whose named heading the preamble carries, and keeps a tile whose heading is missing', () => {
  const { droppedTiles, keptDedupeTiles } = suStackDocuments({ harnessDir });
  const marked = SU_TILES.filter((t) => t.dedupeWithPreamble);
  assert.ok(marked.length >= 5, 'the decomposition marks the dedupe tiles');
  assert.equal(keptDedupeTiles.length, 0, `preamble is missing a dedupe heading: ${keptDedupeTiles.map((t) => t.dedupeWithPreamble).join(', ')}`);
  assert.deepEqual(droppedTiles.map((t) => t.anchor), marked.map((t) => t.anchor));
  // Guard: a preamble WITHOUT the headings keeps every marked tile (no silent kernel loss).
  const guarded = suStackDocuments({ harnessDir, preambleText: '# Agent base preamble\n\nnothing else\n' });
  assert.equal(guarded.droppedTiles.length, 0);
  assert.equal(guarded.keptDedupeTiles.length, marked.length);
  const rendered = composeSuStackSource({ harnessDir, preambleText: '# Agent base preamble\n\nnothing else\n' });
  for (const t of guarded.keptDedupeTiles) assert.ok(rendered.text.includes(t.anchor), `kept tile must render: ${t.anchor}`);
});

test('composeSuStackSource — every splice seam survives: the client seam renders AS the client layer above the seal; the kernel seams render under it', () => {
  const out = composeSuStackSource({ harnessDir });
  const iSeal = out.text.indexOf(KERNEL_SEAL_MARKER);
  const iClient = out.text.indexOf(CLIENT_SEAM_MARKER);
  assert.ok(iClient >= 0 && iClient < iSeal, 'client seam above the seal');
  for (const seam of ['AUTO-MODE', 'RESULT-DOOR', 'COORD-LEGEND', 'WIRE-SCHEMAS']) {
    const i = out.text.indexOf(`<!-- PAPERCUSP-SU:${seam} -->`);
    assert.ok(i > iSeal, `${seam} seam under the seal`);
  }
  const seamsInSource = SU_TILES.filter((t) => t.seam).length;
  assert.equal((out.text.match(/<!-- PAPERCUSP-SU:[A-Z-]+ -->/g) ?? []).length, seamsInSource, 'no seam lost, none duplicated');
  // The only warn the default stack may carry is the heuristic contradiction phrasing (the
  // engineer domain text legitimately talks about locks and work-items); nothing structural.
  assert.ok(out.findings.every((f) => f.tier === 'warn'), JSON.stringify(out.findings));
});

test('composeSuStackSource — binding a fleet posture renders it between domain and practices', () => {
  const member = composeSuStackSource({ harnessDir, posture: 'member' });
  assert.deepEqual(member.order.map((e) => e.id).slice(0, 4), ['client-seam', 'papercusp-engineer', 'su.fleet-member', 'su-collaborator']);
  assert.ok(member.text.includes('## Working as a fleet MEMBER'));
  const leader = composeSuStackSource({ harnessDir, posture: 'leader' });
  assert.ok(leader.order.some((e) => e.id === 'su.fleet-leader') && !leader.order.some((e) => e.id === 'su.fleet-member'));
});

// ── P-012: the binding + the stack-mutation primitive over the real tree ──────

test('suSessionBinding / suEffectiveBinding — presence fleet_role derives the posture layer; the static layers are implied; posture sugar and an explicit binding must agree', () => {
  assert.deepEqual(bindingRefs(suSessionBinding({ fleetRole: null })), []);
  assert.deepEqual(bindingRefs(suSessionBinding({ fleetRole: 'Leader' })), ['fleet-posture:su.fleet-leader']);
  assert.deepEqual(
    bindingRefs(suSessionBinding({ fleetRole: 'member', modes: ['auto'] })),
    ['fleet-posture:su.fleet-member', 'autonomy:su.mode-auto'],
    'P-021: an active mode binds its axis identity beside the posture (D-008 as amended)',
  );
  assert.deepEqual(bindingRefs(suEffectiveBinding(null)), ['domain:papercusp-engineer', 'collaboration-stance:su-collaborator', 'practice:su.practice']);
  assert.deepEqual(bindingRefs(suEffectiveBinding(suPostureBinding('member'))), [
    'domain:papercusp-engineer',
    'fleet-posture:su.fleet-member',
    'collaboration-stance:su-collaborator',
    'practice:su.practice',
  ]);
  assert.throws(() => suEffectiveBinding(suPostureBinding('member'), 'leader'), /posture "leader" disagrees/);
  // `binding` and `posture` are the same seam: identical renders.
  const viaBinding = composeSuStackSource({ harnessDir, binding: suSessionBinding({ fleetRole: 'leader' }) });
  const viaPosture = composeSuStackSource({ harnessDir, posture: 'leader' });
  assert.equal(viaBinding.text, viaPosture.text);
  assert.deepEqual(viaBinding.order, viaPosture.order);
});

test('composeSuStackMutation — attach member, swap to leader (one attach, `replaced`), detach restores the default order; the injection carries the real posture text and the next render composes clean', () => {
  const joined = composeSuStackMutation({ harnessDir, binding: null, op: 'attach', layer: { slot: 'fleet-posture', id: 'su.fleet-member' } });
  assert.equal(joined.mutation.changed, true);
  assert.equal(joined.mutation.replaced, null);
  assert.deepEqual(bindingRefs(joined.runtimeBinding), ['fleet-posture:su.fleet-member']);
  assert.deepEqual(joined.nextRender.order.map((e) => e.id).slice(0, 4), ['client-seam', 'papercusp-engineer', 'su.fleet-member', 'su-collaborator']);
  assert.ok(joined.injection!.startsWith(`${STACK_INJECTION_STAMP} {"op":"attach","slot":"fleet-posture","id":"su.fleet-member"`));
  assert.ok(joined.injection!.includes('## Working as a fleet MEMBER'), 'the injected text IS the posture tile');
  assert.equal(joined.injection!.includes(KERNEL_SEAL_MARKER), false);
  assert.equal(joined.nextRender.findings.filter((f) => f.tier === 'block').length, 0);

  const led = composeSuStackMutation({ harnessDir, binding: joined.runtimeBinding, op: 'attach', layer: { slot: 'fleet-posture', id: 'su.fleet-leader' } });
  assert.deepEqual(led.mutation.replaced, { slot: 'fleet-posture', id: 'su.fleet-member' });
  assert.deepEqual(bindingRefs(led.runtimeBinding), ['fleet-posture:su.fleet-leader']);
  assert.ok(led.injection!.includes('It REPLACES `su.fleet-member` on the exclusive `fleet-posture` slot'));
  assert.ok(led.nextRender.order.some((e) => e.id === 'su.fleet-leader') && !led.nextRender.order.some((e) => e.id === 'su.fleet-member'));

  const left = composeSuStackMutation({ harnessDir, binding: led.runtimeBinding, op: 'detach', layer: { slot: 'fleet-posture' } });
  assert.equal(left.mutation.id, 'su.fleet-leader');
  assert.deepEqual(bindingRefs(left.runtimeBinding), []);
  assert.deepEqual(left.nextRender.order, composeSuStackSource({ harnessDir }).order, 'detach restores the default stack');
  assert.ok(left.injection!.includes('DETACHED'));

  // A static su layer cannot be detached at runtime; an unknown bound document is refused, not rendered without.
  assert.throws(() => composeSuStackMutation({ harnessDir, binding: null, op: 'detach', layer: { slot: 'practice', id: 'su.practice' } }), /static layer of the su stack/);
  assert.throws(() => composeSuStackMutation({ harnessDir, binding: null, op: 'attach', layer: { slot: 'practice', id: 'no-such-practice' } }), /neither an su.md part document nor resolvable/);
  // A caller-resolved practice stacks beside su.practice and is injected.
  const extra = composeSuStackMutation({
    harnessDir,
    binding: null,
    op: 'attach',
    layer: { slot: 'practice', id: 'wait-loop-discipline' },
    resolveLayer: (l) => (l.id === 'wait-loop-discipline' ? { id: l.id, layer: 'practices', slot: 'practice', text: '## Waiting well\n\nre-check, then re-arm.' } : null),
  });
  assert.deepEqual(bindingRefs(extra.runtimeBinding), ['practice:wait-loop-discipline']);
  assert.deepEqual(extra.nextRender.order.filter((e) => e.slot === 'practice').map((e) => e.id), ['su.practice', 'wait-loop-discipline']);
  assert.ok(extra.injection!.includes('## Waiting well'));
});
