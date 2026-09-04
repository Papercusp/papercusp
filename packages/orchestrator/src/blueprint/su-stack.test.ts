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
import { composeSuStackSource, suStackDocuments } from './su-stack.js';
import { KERNEL_SEAL_MARKER } from './render-stack.js';
import { CLIENT_SEAM_MARKER } from './identity-lint.js';
import { SU_TILES } from './su-decomposition.js';

const here = dirname(fileURLToPath(import.meta.url));
const harnessDir = join(here, '..', '..', '..', 'harness'); // libs/papercusp/packages/harness

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
