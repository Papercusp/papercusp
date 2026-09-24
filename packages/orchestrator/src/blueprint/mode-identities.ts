/**
 * MODES AS FACETS — the mode-axis and audience IDENTITY documents (`identities-v1-2026-08-30`
 * P-021; D-008 as amended 2026-09-03, D-022 §1/§6, D-023 §3).
 *
 * A mode is three things fused together (D-008): STATE, DEFINITION, AUTHORITY. Only the
 * DEFINITION moves here — the long-form operating clause that `operating-modes-policy.ts`
 * used to splice into EVERY su render (33,951 B, no is-this-mode-active gate). Each mode's
 * definition is now an abstract identity blueprint filling ONE EXCLUSIVE AXIS SLOT
 * (`autonomy` / `ideation` / `objective` / `audit` — additive ACROSS axes, exclusive WITHIN
 * one), rendered in the `modes` layer only while the mode is ON:
 *
 *   - at launch, `suSessionBinding({ modes })` binds one layer per active mode into the
 *     FIRST render (role-launch-spec ← bootstrap-su's `--auto` / `--mode=drain` / fleet
 *     registration);
 *   - mid-session, `mode:set` writes `agent_modes` → the control anchor's `stack` projects
 *     these layers (`stack-binding-channel.ts`) → the ⟦stack⟧ inject-now payload attaches
 *     the document on the next turn; `enabled:false` detaches and VOIDS it (P-012 / D-022).
 *
 * WHAT STAYS KERNEL and is NOT in any of these documents: the mode STATE
 * (`harness_shared.agent_modes`), the IMPLICATION TABLE (`modes/registry.ts` `implies` —
 * DRAIN ⇒ AUTO is applied by the registry write, so `mode:set drain` binds `objective`
 * AND `autonomy`; a document cannot author an implication), and the AUTHORITY semantics
 * (what AUTO suspends, what AUDIT permits — computed by `instruction-lint.ts` from the
 * registry, enforced at the dispatch chokepoint by `audit-mode-guard.ts`). A mode-axis
 * document supplies only the domain flavour of how the mode reads; `identity-lint.ts`
 * BLOCKS an authority-bearing field on a mode axis (`authority-on-mode-axis`) and any
 * forged control literal (`⟦stack⟧`, `⟦INSTRUCTION-PRECEDENCE⟧`, …) — the D-005 negative.
 *
 * GOAL, GRADE and TEST now have authored mode-axis documents beside the original
 * four. `cold-auto` binds the AUTO document — same axis and grant — while its
 * carry rider remains a runtime-state contract until the reader migration.
 *
 * THE SECOND AXIS (D-008 "unify"): the file-based persona modes
 * (`<role>.persona.{engineer,novice}-mode.md`, `loadRoleModePersona`) are identities on the
 * exclusive `audience` slot — `AUDIENCE_IDENTITY_DOCUMENTS` — resolved through the same
 * chain. RECORDED DEFAULT (P-021): v1 is the four files on the same mechanism.
 *
 * These documents are AUTHORED (an identity's own prompt), not derived from su.md — unlike
 * `SU_PART_DOCUMENTS` they have no tiles, so `su-stack.ts` resolves them through the chain
 * ONLY (a missing document refuses; there is nothing to fall back to).
 */
import { createHash } from 'node:crypto';
import { MODE_AXES, type ModeAxis, type SlotId } from './slots.js';
import { layerSourceDocument, type BlueprintLayer } from './loader.js';
import { BlueprintContributionSchema } from './schema.js';
import type { BlueprintValidation } from './validate.js';
import { stableStringify } from './merge.js';
import type { BoundLayer } from './stack-mutation.js';

/** Generated view of mode metadata authored by a validated identity component.
 * The host policy registry still decides implications, subjects and authority. */
export interface ModeCatalogEntry {
  id: string;
  policyRef: string;
  slot: ModeAxis;
  title: string;
  oneLiner: string;
  definition: {
    contributionId: string;
    inputKind: 'prompt-file' | 'addressed-document';
    ref: string;
    source: 'fixed' | 'provider';
    refresh: 'source-change' | 'launch' | 'turn' | 'on-demand';
    producerRef?: string;
  };
  sourceId: string;
  sourceHash: string;
  revision: string;
}

export interface ModeCatalogSnapshot {
  revision: string;
  entries: readonly ModeCatalogEntry[];
}

export function modeCatalogFromValidatedSources(
  sources: readonly { layers: readonly BlueprintLayer[]; validation: BlueprintValidation }[],
  options: { supportedPolicyRefs: Iterable<string>; approvedModePolicyRefs?: Iterable<string> },
): ModeCatalogSnapshot {
  const supported = new Set(options.supportedPolicyRefs);
  const approved = new Set(options.approvedModePolicyRefs ?? []);
  const byId = new Map<string, ModeCatalogEntry>();
  for (const source of sources) {
    if (!source.validation.ok) throw new Error('mode catalog refuses an invalid blueprint source');
    for (const layer of source.layers) {
      const mode = layer.mode;
      if (!mode) continue;
      const slot = layer.slots.filter((value): value is ModeAxis => (MODE_AXES as readonly string[]).includes(value));
      if (slot.length !== 1) throw new Error(`mode "${mode.id}" must fill exactly one mode axis`);
      if (!supported.has(mode.policyRef)) throw new Error(`mode "${mode.id}" references unsupported host policy "${mode.policyRef}"`);
      if (layer.trust !== 'builtin' && !approved.has(mode.policyRef)) {
        throw new Error(`mode "${mode.id}" has no installer/admin approval for host policy "${mode.policyRef}"`);
      }
      if (layer.trust === 'installed' && (!layer.attestation || layer.attestation.contentHash !== layer.contentHash)) {
        throw new Error(`installed mode "${mode.id}" needs a valid layer attestation`);
      }
      const contributions = source.layers.flatMap((candidate) => {
        const raw = layerSourceDocument(candidate);
        return Array.isArray(raw?.contributions) ? raw.contributions.map((value) => BlueprintContributionSchema.parse(value)) : [];
      });
      const definition = contributions.find((value) => value.id === mode.definitionContributionId);
      if (!definition || definition.purpose !== 'prompt' ||
          (definition.inputKind !== 'prompt-file' && definition.inputKind !== 'addressed-document')) {
        throw new Error(`mode "${mode.id}" has no prompt contribution "${mode.definitionContributionId}"`);
      }
      const content = {
        id: mode.id, policyRef: mode.policyRef, slot: slot[0]!, title: mode.title,
        oneLiner: mode.oneLiner,
        definition: {
          contributionId: definition.id, inputKind: definition.inputKind, ref: definition.ref,
          source: definition.source, refresh: definition.refresh,
          ...(definition.producerRef ? { producerRef: definition.producerRef } : {}),
        },
        sourceId: layer.id, sourceHash: layer.contentHash,
      };
      const entry: ModeCatalogEntry = {
        ...content,
        revision: createHash('sha256').update(stableStringify(content)).digest('hex'),
      };
      const prior = byId.get(mode.id);
      if (prior && prior.revision === entry.revision) continue;
      if (prior && (mode.replacesRevision !== prior.revision || prior.policyRef !== mode.policyRef)) {
        throw new Error(`mode "${mode.id}" has conflicting definitions from "${prior.sourceId}" and "${layer.id}" without an exact replacement revision`);
      }
      byId.set(mode.id, entry);
    }
  }
  const entries = [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { revision: createHash('sha256').update(stableStringify(entries)).digest('hex'), entries };
}

export type SuModeDocId = 'su.mode-auto' | 'su.mode-ideate' | 'su.mode-drain' | 'su.mode-grade' | 'su.mode-test' | 'su.mode-goal' | 'su.mode-audit';

export interface SuModeDocument {
  /** The identity blueprint id (`blueprints/<id>/blueprint.yaml`). */
  id: SuModeDocId;
  /** The exclusive mode axis the identity fills — its `slots:` declaration. */
  slot: Exclude<ModeAxis, 'audience'>;
  /** The `modes/registry.ts` mode ids whose activation binds this document. */
  modes: readonly string[];
  /** Harness-relative path of the document: `blueprints/<id>/prompts/<slot>.md`. */
  path: string;
  role: string;
}

/**
 * The mode-axis identities — one per axis that has a definition today. Path is DERIVED
 * from id + slot (`prompts/<slot>.md`, the convention every non-domain identity document
 * follows), never restated.
 */
function modeDoc(id: SuModeDocId, slot: SuModeDocument['slot'], modes: readonly string[], role: string): SuModeDocument {
  return { id, slot, modes, path: `blueprints/${id}/prompts/${slot}.md`, role };
}

export const SU_MODE_DOCUMENTS: readonly SuModeDocument[] = [
  modeDoc('su.mode-auto', 'autonomy', ['auto', 'cold-auto'], 'the AUTO definition — the owner’s standing "act, don’t ask" grant read in the su’s vocabulary; bound for auto AND cold-auto (one dial, two positions)'),
  modeDoc('su.mode-ideate', 'ideation', ['ideate'], 'the IDEATE definition — "invent net-new, don’t just patch" + the IDEATE × AUTO composition table; stacks beside autonomy (cross-axis additive)'),
  modeDoc('su.mode-drain', 'objective', ['drain'], 'the DRAIN definition — drive the agreed backlog to terminal; DRAIN ⇒ AUTO is the registry’s implication, so drain binds objective AND autonomy'),
  modeDoc('su.mode-grade', 'grade', ['grade'], 'the GRADE definition — score, repair and re-grade while preserving independent acceptance'),
  modeDoc('su.mode-test', 'test', ['test'], 'the TEST definition — independently verify another agent’s work and leave guard tests'),
  modeDoc('su.mode-goal', 'goal', ['goal'], 'the GOAL definition — own portfolio outcomes and delegate every implementation'),
  modeDoc('su.mode-audit', 'audit', ['audit'], 'the AUDIT definition — a verdict on a whole program; read-only-toward-subject enforcement stays kernel (audit-mode-guard.ts)'),
];

export function isSuModeDocId(x: unknown): x is SuModeDocId {
  return typeof x === 'string' && SU_MODE_DOCUMENTS.some((d) => d.id === x);
}

export function suModeDocument(id: string): SuModeDocument | null {
  return SU_MODE_DOCUMENTS.find((d) => d.id === id) ?? null;
}

/**
 * The layer a registry mode id binds — null for an unknown id or a supported mode
 * without a definition. A typo must
 * never bind a layer; the registry test is what catches it).
 */
export function suModeLayer(modeId: string): BoundLayer | null {
  const key = String(modeId ?? '').trim().toLowerCase();
  const doc = SU_MODE_DOCUMENTS.find((d) => d.modes.includes(key));
  return doc ? { slot: doc.slot, id: doc.id } : null;
}

/**
 * The mode-axis layers a set of ACTIVE registry modes binds — one per axis, in
 * `MODE_AXES` order, deduped (auto + cold-auto can never both be active — same registry
 * axis — but a caller passing both still gets ONE autonomy layer). The implication
 * closure is NOT applied here: `setMode` already wrote the implied rows, so `modes`
 * as read from `agent_modes` carries `drain` AND `auto`.
 */
export function suModeLayers(modes: readonly string[] | null | undefined): BoundLayer[] {
  const bySlot = new Map<SlotId, BoundLayer>();
  for (const m of modes ?? []) {
    const layer = suModeLayer(m);
    if (layer && !bySlot.has(layer.slot)) bySlot.set(layer.slot, layer);
  }
  return MODE_AXES.filter((axis) => bySlot.has(axis)).map((axis) => bySlot.get(axis)!);
}

// ── the audience axis ─────────────────────────────────────────────────────────

export type AudienceRole = 'operator' | 'papercup';
export type AudienceMode = 'engineer' | 'novice';

export interface AudienceIdentityDocument {
  /** `<role>.audience-<mode>` — the identity blueprint id. */
  id: string;
  role: AudienceRole;
  mode: AudienceMode;
  slot: 'audience';
  /** Harness-relative path: `blueprints/<id>/prompts/audience.md`. */
  path: string;
}

export const AUDIENCE_ROLES: readonly AudienceRole[] = ['operator', 'papercup'];
export const AUDIENCE_MODES: readonly AudienceMode[] = ['engineer', 'novice'];

export function audienceIdentityId(role: AudienceRole, mode: AudienceMode): string {
  return `${role}.audience-${mode}`;
}

/** The four audience identities (D-008 unify; RECORDED DEFAULT v1 = four files, same mechanism). */
export const AUDIENCE_IDENTITY_DOCUMENTS: readonly AudienceIdentityDocument[] = AUDIENCE_ROLES.flatMap((role) =>
  AUDIENCE_MODES.map((mode) => {
    const id = audienceIdentityId(role, mode);
    return { id, role, mode, slot: 'audience' as const, path: `blueprints/${id}/prompts/audience.md` };
  }),
);

/** The audience identity document for a chat role + audience mode, or null for an unknown pair. */
export function audienceIdentityDocument(role: string, mode: string): AudienceIdentityDocument | null {
  return AUDIENCE_IDENTITY_DOCUMENTS.find((d) => d.role === role && d.mode === mode) ?? null;
}
