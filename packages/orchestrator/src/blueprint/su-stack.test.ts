/**
 * identities-v1-2026-08-30 P-003 — the interactive su's composed source, over the
 * REAL harness tree: lossless (every non-dedupe tile of su.md renders exactly once),
 * ordered (identity tiles above the seal, kernel tiles under it, the seal once),
 * seams preserved for `renderSuPlaybook`, the D-018 §4 dedupe guarded.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeSuStackSource, composeSuStackMutation, suEffectiveBinding, suPostureBinding, suSessionBinding, suStackDocuments, SU_OUTSIDE_MEMBER_BASE, SU_STATIC_LAYERS } from './su-stack.js';
import { bindingRefs, STACK_INJECTION_STAMP } from './stack-mutation.js';
import { KERNEL_SEAL_MARKER } from './render-stack.js';
import { CLIENT_SEAM_MARKER } from './identity-lint.js';
import { SU_PREAMBLE_REL, SU_TILES } from './su-decomposition.js';

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
    'Registering work is a SEPARATE discipline',
    'file a work item for it and CLAIM it',
    'Record what you\nfound and did on the work item / plan']) {
    assert.ok(normal.text.includes(instruction), `positive control: ${instruction}`);
    assert.equal(controlled.text.includes(instruction), false, `withheld workflow: ${instruction}`);
  }
  assert.throws(() => composeSuStackSource({ harnessDir, workItemWorkflow: 'host-managed',
    tiles: SU_TILES.filter(t => !t.anchor.startsWith('- **Plan before')) }), /workflow/);
});

test('host-managed preamble keeps blocker investigation and refuses missing or ambiguous workflow source', () => {
  const preamble = readFileSync(join(harnessDir, SU_PREAMBLE_REL), 'utf8');
  const controlled = composeSuStackSource({ harnessDir, workItemWorkflow: 'host-managed' });
  for (const retained of ['check its concrete progress', 'investigate and fix it',
    'Report the stall and its evidence to the host', 'The host records the findings',
    'A slow check that keeps failing is a loop', 'Root cause named', 'Verified —']) {
    assert.ok(controlled.text.includes(retained), `retained blocker duty: ${retained}`);
  }
  const changed = preamble.replace('file a work item for it and CLAIM it', 'FILE A DIFFERENT ITEM');
  assert.ok(composeSuStackSource({ harnessDir, preambleText: changed }).text.includes('FILE A DIFFERENT ITEM'));
  for (const preambleText of [changed, preamble + '\n' + preamble]) {
    assert.throws(() => composeSuStackSource({ harnessDir, preambleText,
      workItemWorkflow: 'host-managed' }), /workflow.*preamble/i);
  }
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

test('an outside fleet member is composed from its own base and posture, and from nothing of the interactive su', () => {
  const su = composeSuStackSource({ harnessDir, outsidePlan: true, posture: null,
    binding: suSessionBinding({ fleetRole: 'member', outsidePlan: true }) });
  const member = composeSuStackSource({ harnessDir, outsidePlan: true, outsideMember: true,
    binding: suSessionBinding({ fleetRole: 'member', outsidePlan: true }) });

  // Its base is the one kernel document, under the seal; its posture the one layer above it.
  assert.deepEqual(member.order.map((entry) => `${entry.layer}:${entry.id}`),
    ['fleet-posture:su.outside-fleet-member', `kernel:${SU_OUTSIDE_MEMBER_BASE.id}`]);
  const seal = member.text.indexOf(KERNEL_SEAL_MARKER);
  assert.ok(seal > 0);
  assert.ok(member.text.indexOf('## Working as a fleet member on an outside assignment') < seal);
  assert.ok(member.text.indexOf('# Fleet member on an outside assignment: the base') > seal);
  assert.ok(member.text.includes('Kernel documents, in order: `su.outside-member-base`.'));

  // Positive control: the interactive su's composition for the same member carries all of this.
  for (const suOnly of ['Superuser engineer-collaborator', '## Engineering discipline', '<!-- PAPERCUSP-SU:AUTO-MODE -->',
    CLIENT_SEAM_MARKER, 'Anti-babysitting', 'Coordination: subscribe']) {
    assert.ok(su.text.includes(suOnly), `positive control: ${suOnly}`);
    assert.equal(member.text.includes(suOnly), false, `not a member's: ${suOnly}`);
  }
  for (const layer of SU_STATIC_LAYERS)
    assert.equal(member.order.some((entry) => entry.id === layer.id), false, `static su layer ${layer.id}`);
  // A member is given a fraction of the su's text.
  assert.ok(member.text.length < 10400, `member source is ${member.text.length} chars`);
  assert.ok(su.text.length > 8 * member.text.length);

  // What the member's two documents must say, since nothing else says it for them.
  for (const needed of ['work_items:complete', 'File locks are enforced', 'Leave git alone', 'scheduler:get_next',
    'changeKindReason', 'name the test files by path', '"state": "dropped"', 'work_items:release',
    'mcp__papercusp-su__work_items_complete', 'session:request-compaction',
    // The close hands the next item and renews the context: the three things a member acts on.
    "the close's `next`", 'freshContext: "queued"', 'your context was renewed at a work-item boundary',
    // A story is not always code: the close for a document or configuration change.
    '"changeKinds": ["docs"]', 'readBack',
    // Its file and shell tools are Papercusp's own: the file tools lock the file themselves, and
    // the shell runs commands and never writes. A long run goes to the background.
    'capability:write', 'capability:edit', 'capability:patch', 'Give them absolute paths',
    'Commands run through `capability:bash`', 'Never change a file', 'run_in_background: true',
    'capability:bash_output',
    // The shell holds a work-item's long runs once they keep failing: the note that clears it.
    'loop_audit_required', 'work_items:comment',
    // With the flag off it has Claude Code's own, under the same rules.
    '**Without those tools** you have Claude Code\'s `Edit`, `Write` and `Bash`']) {
    assert.ok(member.text.includes(needed), `member text names: ${needed}`);
  }
  // It has no tool to file work, search the catalog or keep itself running, so it is told of none.
  for (const absent of ['work_items:create', 'tools:find', 'tools:invoke', 'loop:arm', 'plans:', 'capability:git', 'capability:fetch']) {
    assert.equal(member.text.includes(absent), false, `member text must not name: ${absent}`);
  }
});

test('an outside fleet member always has its posture, keeps a layer the launch selected, and refuses what does not apply', () => {
  // No binding given: the member posture is bound, never a render without one.
  const bare = suStackDocuments({ harnessDir, outsideMember: true });
  assert.deepEqual(bindingRefs(bare.binding), ['fleet-posture:su.outside-fleet-member']);
  assert.deepEqual(bare.located, []);

  // A layer the launch selected renders above the seal beside the posture.
  const selected = suStackDocuments({ harnessDir, outsideMember: true,
    binding: { layers: [{ slot: 'domain', id: 'product-rules' }] },
    resolveLayer: (layer) => layer.id === 'product-rules'
      ? { id: 'product-rules', layer: 'domain', slot: 'domain', text: 'PRODUCT RULES', sourcePath: null } : null });
  assert.deepEqual(selected.docs.map((doc) => doc.id).sort(),
    ['product-rules', SU_OUTSIDE_MEMBER_BASE.id, 'su.outside-fleet-member'].sort());

  assert.throws(() => suStackDocuments({ harnessDir, outsideMember: true, workItemWorkflow: 'host-managed' }), /host-managed/);
  assert.throws(() => suStackDocuments({ harnessDir, outsideMember: true, outsidePlan: false }), /outside plan/);
  // The base missing from every tier refuses: there is no su text to fall back to.
  assert.throws(() => suStackDocuments({ harnessDir, outsideMember: true, identityRoots: [join(here, 'no-such-root')] }),
    /base document .* exists in none of the identity roots/);
});
