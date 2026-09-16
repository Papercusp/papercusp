/**
 * P-014 clause 6 — FACET STACK VERIFIED, for the NON-ENGINEERING identity.
 *
 * `identities-v1-2026-08-30` D-045 measured the gap this file closes: the slot /
 * seal / exclusivity machinery is well covered in the ABSTRACT (render-stack.test.ts
 * is entirely synthetic), and the only real identity any stack test names is
 * `papercusp-engineer`. `research-steward` — a declared identity on the same
 * exclusive `domain` slot — was composed by nothing. So the mechanism was tested
 * and the SUBJECT was not enrolled in it, which is the same shape D-037 (clause 8),
 * D-040 (clause 3) and D-043 (clause 2) each found.
 *
 * The subject here is therefore the REAL blueprint FILE, not a fixture literal:
 * every assertion below is downstream of bytes on disk, so a change to the
 * identity's slot declaration fails this test rather than passing it quietly.
 *
 * `RESEARCH_STEWARD_BLUEPRINT` overrides the subject path. That is what makes a
 * falsifiability probe tier-2 (mutate a COPY outside the tree) instead of tier-3
 * (mutate the shared checkout and race git-sync's sweep) — see CLAUDE.md
 * "Proving a guard is falsifiable". `extends: base` is resolved with
 * `resolveBuiltinExtends` explicitly, so a copied-out subject still resolves its
 * parent from the real builtin directory.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { builtinBlueprintPath, resolveBuiltinExtends, resolveLayers, type RawBlueprint } from './loader.js';
import { composeStack, type StackDocument } from './render-stack.js';
import { SLOT_SPECS, findExclusiveSlotConflicts } from './slots.js';

const SUBJECT = process.env.RESEARCH_STEWARD_BLUEPRINT ?? builtinBlueprintPath('research-steward');

/**
 * Loaded at the LAYER seam, not with `loadBuiltinBlueprint`. Measured 2026-09-16:
 * `research-steward` is an ABSTRACT identity layer (its own header says so), so
 * `resolveBlueprint` REFUSES it — the merged document has no `workItem`/`spine`
 * and fails RunnableBlueprint validation. An identity is composed as a layer and
 * only becomes runnable when merged with a runnable blueprint, so the layer seam
 * is the one that can see it at all.
 */
function loadSubject() {
  const raw = parseYaml(readFileSync(SUBJECT, 'utf8')) as RawBlueprint;
  const { merged, layers } = resolveLayers(raw, resolveBuiltinExtends, SUBJECT);
  return { raw, merged, layers };
}

/** The identity as it renders: id + slot taken from the FILE, never hard-coded here. */
function researchStewardDocument(): StackDocument {
  const { raw, layers } = loadSubject();
  const root = layers[layers.length - 1];
  const slot = root.slots[0];
  const bp = raw as { description?: string; lexicon?: Record<string, string> };
  const lexicon = Object.entries(bp.lexicon ?? {})
    .map(([k, v]) => `a "${k}" is called a "${v}"`)
    .join('\n');
  return {
    id: root.id,
    layer: 'domain',
    slot: slot as StackDocument['slot'],
    text: `## Research stewardship\n\n${bp.description ?? ''}\n\n## This hive's vocabulary\n\n${lexicon}`,
    sourcePath: SUBJECT,
  };
}

const KERNEL: StackDocument = {
  id: 'kernel-base',
  layer: 'kernel',
  text: 'Kernel base text. Register work, respect locks, record completion evidence.',
};

/**
 * The engineering CONTROL ARM. Deliberately a foil, not a second subject: its job
 * is to show that the hard error in the exclusivity case below is about the PAIR
 * occupying one exclusive slot, not about `research-steward` being malformed.
 */
const PAPERCUSP_ENGINEER: StackDocument = {
  id: 'papercusp-engineer',
  layer: 'domain',
  slot: 'domain',
  text: '## Engineering discipline\n\nShip verified changes; a red gate is yours to green.',
};

describe('P-014 clause 6 — the research-steward facet stack', () => {
  it('(a) declares, in the real blueprint file, the EXCLUSIVE domain slot', () => {
    const loaded = loadSubject();
    const root = loaded.layers[loaded.layers.length - 1];

    expect(root.id).toBe('research-steward');
    // D-013: the `slots:` key is the identity discriminator. Read from disk.
    expect(root.slots).toEqual(['domain']);
    // The REGISTRY is authoritative for cardinality (slots.ts), not the document.
    expect(SLOT_SPECS.domain.cardinality).toBe('exclusive');
    expect(SLOT_SPECS.domain.layer).toBe('domain');

    // …and it occupies that slot when actually composed.
    const composed = composeStack([KERNEL, researchStewardDocument()]);
    expect(composed.order.find((e) => e.id === 'research-steward')).toMatchObject({
      layer: 'domain',
      slot: 'domain',
    });
  });

  it('(b) renders BELOW the seal, with the kernel rendered LAST', () => {
    const composed = composeStack([KERNEL, researchStewardDocument()]);

    // Order: the identity is an identity-layer document, the kernel is last.
    expect(composed.order.map((e) => e.id)).toEqual(['research-steward', 'kernel-base']);

    const identityAt = composed.text.indexOf('Research stewardship');
    const sealAt = composed.text.indexOf(composed.seal);
    const kernelAt = composed.text.indexOf('Kernel base text.');

    expect(identityAt).toBeGreaterThanOrEqual(0);
    expect(sealAt).toBeGreaterThan(identityAt); // identity ABOVE the seal
    expect(kernelAt).toBeGreaterThan(sealAt); // kernel BELOW it, last
    expect(composed.text.trimEnd().endsWith('Kernel base text. Register work, respect locks, record completion evidence.')).toBe(true);

    // The seal names this identity in the precedence statement it renders.
    expect(composed.seal).toContain('domain/domain:research-steward');
  });

  it('(c) is a HARD ERROR when stacked with papercusp-engineer on the same exclusive slot (D-007)', () => {
    const doc = researchStewardDocument();

    const conflicts = findExclusiveSlotConflicts([
      { id: doc.id, slot: 'domain' },
      { id: PAPERCUSP_ENGINEER.id, slot: 'domain' },
    ]);
    expect(conflicts).toEqual([{ slot: 'domain', claimants: ['research-steward', 'papercusp-engineer'] }]);

    // MEASURED GAP, pinned deliberately (2026-09-16, this test's first run).
    // D-007's hard error is enforced by the LOADER over a blueprint's `extends`
    // layers (slots.ts: "the loader runs this over LoadedBlueprint.layers and
    // fails the load on any hit"). It is NOT enforced at the COMPOSITION seam:
    // `composeStack` orders and lints, and two DOCUMENTS claiming one exclusive
    // slot compose without error — both render, `research-steward` first by
    // input order. So the rule exists as a pure function and as a loader check,
    // and a stack assembled document-by-document (the P-012 attach/detach
    // mutation path) can still carry two professions.
    //
    // This assertion pins the CURRENT behaviour so the gap cannot be mistaken
    // for coverage. If enforcement is added at this seam, this test fails and
    // must be flipped to expect the throw — that failure is the point.
    const both = composeStack([KERNEL, doc, PAPERCUSP_ENGINEER]);
    expect(both.order.map((e) => e.id)).toEqual(['research-steward', 'papercusp-engineer', 'kernel-base']);
    expect(both.findings.filter((f) => f.tier === 'block')).toEqual([]);
  });

  it('(d) CONTROL ARM: each identity composes cleanly ALONE, so (c) is about the pair', () => {
    const doc = researchStewardDocument();

    const engineering = composeStack([KERNEL, PAPERCUSP_ENGINEER]);
    expect(engineering.order.map((e) => e.id)).toEqual(['papercusp-engineer', 'kernel-base']);
    expect(engineering.findings.filter((f) => f.tier === 'block')).toEqual([]);

    const research = composeStack([KERNEL, doc]);
    expect(research.findings.filter((f) => f.tier === 'block')).toEqual([]);

    // Structural peers: same layer, same slot, same rendered shape — the only
    // difference is which profession the text carries.
    expect(research.order[0]).toMatchObject({ layer: 'domain', slot: 'domain', position: 0 });
    expect(engineering.order[0]).toMatchObject({ layer: 'domain', slot: 'domain', position: 0 });
  });

  it('binds to the real file: the rendered identity carries the blueprint’s own lexicon', () => {
    // Fails if the subject file stops declaring the vocabulary D-037 measured —
    // this is the assertion a mutation probe kills.
    const doc = researchStewardDocument();
    expect(doc.sourcePath).toBe(SUBJECT);
    expect(doc.text).toContain('a "repo" is called a "source corpus"');
  });
});
