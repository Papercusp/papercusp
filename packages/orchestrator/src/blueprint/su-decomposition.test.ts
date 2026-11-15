/**
 * identities-v1-2026-08-30 P-002 — the su.md decomposition: the anchor tiling is
 * sound over the LIVE su.md, every part document on disk is byte-equal to its
 * derivation (lossless), the base role library and its disposition table agree
 * both ways, the default stack is well-formed, and COMPOSITION_MODEL.md §9 is
 * pinned to `renderSuDecompositionMarkdown()`.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYER_ORDER, SLOT_IDS, isSlotId, slotSpec } from './slots.js';
import {
  BASE_ROLE_LIBRARY_DISPOSITION,
  BASE_ROLE_LIBRARY_REL,
  SU_DEFAULT_STACK,
  SU_PART_DOCUMENTS,
  SU_PREAMBLE_REL,
  SU_SOURCE_REL,
  SU_TILES,
  extractSuPart,
  isSuPart,
  locateSuTiles,
  renderSuDecompositionMarkdown,
  suPartDocumentDrift,
  suPartDocumentHome,
  suTilingProblems,
  tilesOfDocument,
} from './su-decomposition.js';

/** The real shipped harness package dir (…/orchestrator/src/blueprint → …/harness). */
const HARNESS_PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'harness');
const su = () => readFileSync(join(HARNESS_PKG, SU_SOURCE_REL), 'utf8');

test('the tiling is SOUND over the live su.md — every anchor unique + in order, first tile on line 1, every heading and splice marker classified', () => {
  const problems = suTilingProblems(su());
  assert.deepEqual(problems, [], `su.md changed under the tiling — re-classify:\n  - ${problems.join('\n  - ')}`);
});

test('additive observation instructions remain readable by the serving catalog from before those tiles existed', () => {
  const addedPracticeLabels = new Set([
    'turn-end observation pass and routing',
    'bug and friction trip-wire',
    'rubric nudge for observations',
  ]);
  const servingTiles = SU_TILES.filter((tile) => !addedPracticeLabels.has(tile.label));
  assert.equal(SU_TILES.length - servingTiles.length, 3);
  const text = su();
  assert.deepEqual(suTilingProblems(text, servingTiles), [], 'live prompt changes must remain compatible with the older serving reader');
  const practice = extractSuPart(text, 'su.practice', servingTiles);
  for (const clause of ['Before you end or yield a turn', 'FILING IS NOT A JUDGMENT CALL', 'rubrics:list']) {
    assert.ok(practice.includes(clause), `the older reader must retain the observation instruction: ${clause}`);
  }
});

test('the tiling is LOSSLESS — the tiles concatenate back to su.md byte-for-byte, with no gap or overlap', () => {
  const text = su();
  const located = locateSuTiles(text);
  assert.equal(located[0]!.startLine, 1);
  for (let i = 1; i < located.length; i++) assert.equal(located[i]!.startLine, located[i - 1]!.endLine + 1, `gap/overlap before tile ${i}`);
  assert.equal(located.map((t) => t.text).join(''), text);
  // The union of every part document + the seam-only tiles is the whole file.
  const seamOnly = located.filter((t) => t.part === 'client');
  const docs = SU_PART_DOCUMENTS.map((d) => extractSuPart(text, d.id)).join('').length + seamOnly.map((t) => t.text).join('').length;
  assert.equal(docs, text.length, 'every tile lands in exactly one part document or is the client seam');
  assert.ok(seamOnly.every((t) => t.seam === 'CLIENT-TOOLING-OVERLAY'), 'the client part is seam-only in su.md');
});

test('every tile names a registry slot or a reserved layer; fleet-posture tiles name a v1 posture; dedupe rows name a REAL preamble heading', () => {
  const preamble = readFileSync(join(HARNESS_PKG, SU_PREAMBLE_REL), 'utf8');
  const headings = new Set(preamble.split('\n').filter((l) => l.startsWith('# ')).map((l) => l.slice(2)));
  for (const t of SU_TILES) {
    assert.ok(isSuPart(t.part), t.anchor);
    assert.ok(t.part === 'kernel' || t.part === 'instance' || isSlotId(t.part), t.anchor);
    if (t.part === 'fleet-posture') assert.ok(t.posture === 'member' || t.posture === 'leader', t.anchor);
    if (t.dedupeWithPreamble) {
      assert.ok(headings.has(t.dedupeWithPreamble), `dedupe row names a preamble heading that no longer exists: "${t.dedupeWithPreamble}" (${t.anchor})`);
      assert.equal(t.part, 'kernel', `a D-018 §4 dedupe row is by definition kernel text: ${t.anchor}`);
    }
    assert.ok(t.label.length > 0 && t.rationale.length > 0, t.anchor);
  }
  // D-018 §4 named the overlapping paragraphs — each is tiled as a dedupe row.
  const dedupes = new Set(SU_TILES.filter((t) => t.dedupeWithPreamble).map((t) => t.dedupeWithPreamble));
  for (const h of ['Blockers', 'Fixing what you find — a mitigation is not a fix', 'Memory', 'Tools and MCP startup', 'Diagnose from evidence, not a plausible story']) {
    assert.ok(dedupes.has(h), `D-018 §4 overlap not recorded as a dedupe row: ${h}`);
  }
  // The five prose parts D-007 requires all receive text; the client part is the seam.
  const partsWithText = new Set(locateSuTiles(su()).filter((t) => !t.seam).map((t) => t.part));
  for (const p of ['kernel', 'domain', 'fleet-posture', 'collaboration-stance', 'practice'] as const) assert.ok(partsWithText.has(p), p);
  assert.ok(!partsWithText.has('client'));
});

test('part documents on disk are BYTE-EQUAL to their derivation from su.md (regenerate: npm run gen:su-decomposition)', () => {
  const drift = suPartDocumentDrift(HARNESS_PKG);
  const bad = drift.filter((d) => d.status !== 'ok');
  assert.deepEqual(bad, [], `part documents drifted from su.md — run \`npm run gen:su-decomposition\` (never edit a part document by hand; edit su.md):\n  ${bad.map((d) => `${d.status}: ${d.path}`).join('\n  ')}`);
  const text = su();
  for (const d of SU_PART_DOCUMENTS) {
    const body = extractSuPart(text, d.id);
    assert.ok(body.length > 0, `${d.id} extracts no text`);
    assert.equal(body, tilesOfDocument(locateSuTiles(text), d).map((t) => t.text).join(''));
    if (d.part !== 'fleet-posture') assert.equal(d.posture, undefined, d.id);
  }
  // Both identity documents have a blueprint.yaml beside their prompts/ dir declaring the slot they fill.
  for (const [id, slot] of [
    ['papercusp-engineer', 'domain'],
    ['su-collaborator', 'collaboration-stance'],
  ] as const) {
    const y = readFileSync(join(HARNESS_PKG, 'blueprints', id, 'blueprint.yaml'), 'utf8');
    assert.match(y, new RegExp(`^id: ${id}$`, 'm'));
    assert.match(y, new RegExp(`- slot: ${slot}`), `${id} must declare slots: [{ slot: ${slot} }]`);
    assert.ok(existsSync(join(HARNESS_PKG, 'blueprints', id, 'prompts')), id);
  }
});

test('the checker names a runnable writer command in its drift remediation', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const generator = readFileSync(join(here, '..', '..', 'bin', 'gen-su-decomposition.ts'), 'utf8');
  assert.match(generator, /run from the repository root or libs\/papercusp: npm run gen:su-decomposition/);
});

test('mode catalog stdout survives a paused pipe reader and emits the complete catalog', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const generator = join(here, '..', '..', 'bin', 'gen-su-decomposition.ts');
  const expected = readFileSync(join(here, 'mode-catalog.generated.ts'));
  const child = spawn(process.execPath, ['--import', 'tsx', generator, '--mode-catalog-stdout'], {
    cwd: join(here, '..', '..', '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pause();
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  child.stdout.resume();
  const code = await finished;
  assert.equal(code, 0, Buffer.concat(errors).toString('utf8'));
  assert.deepEqual(Buffer.concat(chunks), expected);
}, 30_000);

test('the owning submodule package exposes the generator and drift-check commands', () => {
  const packageJson = JSON.parse(readFileSync(join(HARNESS_PKG, '..', '..', 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.scripts?.['gen:su-decomposition'], 'tsx packages/orchestrator/bin/gen-su-decomposition.ts');
  assert.equal(packageJson.scripts?.['gen:su-decomposition:check'], 'tsx packages/orchestrator/bin/gen-su-decomposition.ts --check');
});

test('the base role library and BASE_ROLE_LIBRARY_DISPOSITION agree both ways; only `su` decomposes in v1', () => {
  const onDisk = readdirSync(join(HARNESS_PKG, BASE_ROLE_LIBRARY_REL)).filter((f) => !f.startsWith('su.') || f === 'su.md');
  const table = BASE_ROLE_LIBRARY_DISPOSITION.map((r) => r.file);
  assert.equal(new Set(table).size, table.length, 'duplicate rows');
  assert.deepEqual([...table].sort(), [...onDisk].sort(), 'a prompt was added to / removed from blueprints/base/prompts/ without a disposition row (su.* part documents are excluded — they are derived)');
  assert.deepEqual(BASE_ROLE_LIBRARY_DISPOSITION.filter((r) => r.disposition === 'decomposed-v1').map((r) => r.file), ['su.md']);
  assert.deepEqual(BASE_ROLE_LIBRARY_DISPOSITION.filter((r) => r.disposition === 'kernel-base').map((r) => r.file), ['agent-base-preamble.md']);
  for (const r of BASE_ROLE_LIBRARY_DISPOSITION) {
    if (r.disposition === 'later') assert.ok(r.target && isSlotId(r.target.slot) && /^P-\d{3}$/.test(r.target.item), r.file);
    else assert.equal(r.target, undefined, r.file);
    if (r.disposition === 'sidecar') assert.ok(r.file.endsWith('.role.json'), r.file);
    else assert.ok(r.file.endsWith('.md'), r.file);
  }
});

test('SU_DEFAULT_STACK is in LAYER_ORDER, every slot it names is exclusive-or-additive per the registry, and it carries NO fleet posture by default', () => {
  const idx = SU_DEFAULT_STACK.map((e) => LAYER_ORDER.indexOf(e.layer));
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i]! >= idx[i - 1]!, `${SU_DEFAULT_STACK[i]!.layer} out of order`);
  for (const e of SU_DEFAULT_STACK) {
    if (e.slot) {
      assert.ok(SLOT_IDS.includes(e.slot), e.slot);
      assert.equal(slotSpec(e.slot)!.layer, e.layer, `${e.slot} sits on ${slotSpec(e.slot)!.layer}, not ${e.layer}`);
    }
  }
  const posture = SU_DEFAULT_STACK.find((e) => e.layer === 'fleet-posture')!;
  assert.equal(posture.ref, null, 'a fleet posture is attached by a stack mutation, never by default');
  assert.equal(posture.binding, 'runtime');
  assert.deepEqual(
    SU_DEFAULT_STACK.filter((e) => e.binding === 'static' && e.slot).map((e) => [e.slot, e.ref]),
    [
      ['domain', 'papercusp-engineer'],
      ['collaboration-stance', 'su-collaborator'],
      ['practice', 'su.practice'],
    ],
    'engineer + collaborator stance + the anti-babysitting practice',
  );
  // Every static identity ref is a part document.
  const docIds = new Set(SU_PART_DOCUMENTS.map((d) => d.id));
  for (const e of SU_DEFAULT_STACK) if (e.binding === 'static' && e.slot) assert.ok(docIds.has(e.ref as never), e.ref!);
});

test('docs/COMPOSITION_MODEL.md §9 embeds EXACTLY renderSuDecompositionMarkdown() (pinned prose)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const doc = readFileSync(join(here, '..', '..', 'docs', 'COMPOSITION_MODEL.md'), 'utf8');
  const m = /<!-- SU-DECOMPOSITION:BEGIN -->\n([\s\S]*?)\n<!-- SU-DECOMPOSITION:END -->/.exec(doc);
  assert.ok(m, 'the doc carries the SU-DECOMPOSITION:BEGIN/END markers');
  assert.equal(m![1], renderSuDecompositionMarkdown(), 'the embedded decomposition drifted from su-decomposition.ts — re-paste renderSuDecompositionMarkdown() between the markers (npm run gen:su-decomposition does it)');
  assert.ok(!/\bline \d+\b/i.test(m![1]), 'the pinned prose must not carry line numbers (anchors only)');
});

test('R-2 (identity-system-everything-migration-2026-10-18 #D-005): the kernel is domain-neutral — instance seams live in su.instance, the practice-notes seam in su.practice, and no identity document carries a seam', () => {
  const text = su();
  const seam = (id: string) => `<!-- PAPERCUSP-SU:${id} -->`;
  const kernel = extractSuPart(text, 'su.kernel');
  for (const id of ['WORKSPACE-MAP', 'PROMOTION-MODEL', 'SHARED-BASE-NOTES']) {
    assert.ok(!kernel.includes(seam(id)), `the kernel must not carry the ${id} seam`);
  }
  // Positive control: the kernel still carries its own (domain-neutral) seams, so the
  // negatives above are not passing on an empty or mis-extracted document.
  for (const id of ['AUTO-MODE', 'RESULT-DOOR', 'COORD-LEGEND', 'WIRE-SCHEMAS']) {
    assert.ok(kernel.includes(seam(id)), `the kernel keeps its ${id} seam`);
  }
  const instance = extractSuPart(text, 'su.instance');
  for (const id of ['WORKSPACE-MAP', 'PROMOTION-MODEL', 'PROJECT-GUIDE']) {
    assert.ok(instance.includes(seam(id)), `su.instance carries the ${id} seam`);
  }
  const practice = extractSuPart(text, 'su.practice');
  for (const id of ['COMPACTION', 'SHARED-BASE-NOTES']) {
    assert.ok(practice.includes(seam(id)), `su.practice carries the ${id} seam`);
  }
  // identity-lint's generated-marker rule: a splice seam never lives in an identity
  // document (a standalone wearer would ship the literal marker and lose the text).
  for (const doc of SU_PART_DOCUMENTS.filter((d) => suPartDocumentHome(d) === 'identity')) {
    assert.ok(!extractSuPart(text, doc.id).includes('<!-- PAPERCUSP-SU:'), `${doc.id} is an identity document and carries no splice seam`);
  }
  // The checked-in kernel document matches (it is what the stack composer reads).
  const onDisk = readFileSync(join(HARNESS_PKG, SU_PART_DOCUMENTS.find((d) => d.id === 'su.kernel')!.path), 'utf8');
  for (const id of ['WORKSPACE-MAP', 'PROMOTION-MODEL', 'SHARED-BASE-NOTES']) {
    assert.ok(!onDisk.includes(seam(id)), `checked-in su.kernel.md must not carry the ${id} seam (run npm run gen:su-decomposition)`);
  }
});

test('app-wide-lossless-caps-and-agent-guidance-2026-11-08 P-001 (LOSSLESS-P-001 / AUTO-BAR-R-10-P-001): the lossless-data rule is authored ONCE in su.md and regenerated into exactly the domain part document', () => {
  const RULE = '- **Lossless data — bound the work, never the truth.**';
  const text = su();
  // Canonical source: su.md carries the rule exactly once, with its planning and reviewing clauses.
  assert.equal(text.split(RULE).length - 1, 1, 'su.md authors the lossless-data rule exactly once');
  const tile = locateSuTiles(text).find((t) => t.text.startsWith(RULE));
  assert.ok(tile, 'the rule opens its own tile (an SU_TILES row in su-decomposition.ts)');
  assert.equal(tile!.part, 'domain', 'engineering judgment rides the domain slot');
  for (const clause of ['  - **Planning:**', '  - **Reviewing:**', 'N-1, N and N+1', 'Raising a cap, changing a default or adding a']) {
    assert.ok(tile!.text.includes(clause), `the rule tile carries its clause: ${clause.trim()}`);
  }
  assert.ok(!tile!.text.includes('- **In alpha, timidity'), 'the rule tile ends before the next bullet');
  // Derived copies: exactly ONE part document carries it, and the checked-in file holds the regenerated text.
  const carriers = SU_PART_DOCUMENTS.filter((d) => extractSuPart(text, d.id).includes(RULE)).map((d) => d.id);
  assert.deepEqual(carriers, ['papercusp-engineer'], 'exactly the domain identity document carries the rule');
  const domainDoc = SU_PART_DOCUMENTS.find((d) => d.id === 'papercusp-engineer')!;
  const onDisk = readFileSync(join(HARNESS_PKG, domainDoc.path), 'utf8');
  assert.equal(onDisk.split(RULE).length - 1, 1, 'the checked-in domain document carries the rule once (run npm run gen:su-decomposition)');
  assert.ok(onDisk.includes(tile!.text), 'the checked-in domain document carries the regenerated tile verbatim');
  // Counterexample: drop the tile row and the bullet is absorbed by the preceding kernel tile, so
  // the domain document loses it. The row, not luck, is what routes the rule to every su route.
  const withoutRow = SU_TILES.filter((t) => !t.anchor.startsWith(RULE));
  assert.equal(withoutRow.length, SU_TILES.length - 1, 'exactly one SU_TILES row anchors the rule');
  const misrouted = SU_PART_DOCUMENTS.filter((d) => extractSuPart(text, d.id, withoutRow).includes(RULE)).map((d) => d.id);
  assert.equal(misrouted.length, 1, 'without its row the bullet still lands in exactly one document (tiling stays lossless)');
  assert.notEqual(misrouted[0], 'papercusp-engineer', 'without its row the rule is misrouted out of the domain document');
});
