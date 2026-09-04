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
 * REGISTRY MODES WITHOUT A DOCUMENT (`goal`, `grade`, `test`) bind NO layer: their
 * definition is the registry `contract` mode:set already delivers on activation. `cold-auto`
 * binds the AUTO document — same axis, same grant; its carry rider is its contract.
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
import { MODE_AXES, type ModeAxis, type SlotId } from './slots.js';
import type { BoundLayer } from './stack-mutation.js';

export type SuModeDocId = 'su.mode-auto' | 'su.mode-ideate' | 'su.mode-drain' | 'su.mode-audit';

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
  modeDoc('su.mode-audit', 'audit', ['audit'], 'the AUDIT definition — a verdict on a whole program; read-only-toward-subject enforcement stays kernel (audit-mode-guard.ts)'),
];

export function isSuModeDocId(x: unknown): x is SuModeDocId {
  return typeof x === 'string' && SU_MODE_DOCUMENTS.some((d) => d.id === x);
}

export function suModeDocument(id: string): SuModeDocument | null {
  return SU_MODE_DOCUMENTS.find((d) => d.id === id) ?? null;
}

/**
 * The layer a registry mode id binds — null for a mode with no definition document
 * (goal / grade / test: registry contract only) and for an unknown id (a typo must
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
