# Blueprint composition model — identities as stackable documents

> Plan `identities-v1-2026-08-30` · item **P-001** (design audit + manifest schema) · work-item
> WI-2143731 · written 2026-09-03 by su-27188c44. Authority: D-006 (one composition system),
> D-013 (an identity IS a blueprint document), D-007 as amended (slots, not tiers), the D-008
> amendment (one exclusive slot per mode axis), D-011 (one bundling model), D-004 / D-014
> (grants reserved until M3), D-016 (Phase 3 scope), P-001's own **D-017**, and P-032's
> **D-018** (§8 — the `REPLACE_CLAUDE_BASE` composer is SUBSUMED, not a third path).
>
> This document describes `src/blueprint/{schema,slots,merge-rules,loader,validate}.ts` as
> built. The slot table below is **pinned** to `slots.ts` by `slots.test.ts` (it must equal
> `renderSlotRegistryMarkdown()` byte-for-byte), and the merge-rule claims are pinned by
> `merge-rules.test.ts`; the prose cannot describe a registry other than the one that ships.

## 1. The document model

There is one document kind: the blueprint (`BlueprintSchema`). An **identity** is a blueprint
document that declares the **slots** it fills — `slots:` present (even `[]`) ⇒ identity;
absent ⇒ ordinary blueprint (`isIdentityDocument`). Nothing else is new: the same loader
(`loadBlueprintFromFile` / `resolveBlueprint`), the same `extends` walk, the same per-harness
projection (`harness_shared.blueprints`), the same Cupboard `blueprint` listing kind and
`blueprint:publish` / `cupboard:install-blueprint` flows (D-013).

P-001 adds five sections to the schema:

| field | shape | rule |
|---|---|---|
| `slots` | `[{ slot, cardinality? }]` | `slot` is an OPEN string checked against the registry by `validateBlueprint` (`slot-unknown`, mirroring `unknown-op`): a new axis is a registry row, never a document-format change, and an installed identity naming a slot this platform lacks fails diagnosably. `cardinality` is optional and, when restated, must agree with the registry (`slot-cardinality-mismatch`) — the registry is authoritative, so the two copies cannot drift. |
| `bundles` | `[{ kind, ref, version? }]`, default `[]` | ONE uniform by-reference list for every distributable layer (D-011); `kind` is the CLOSED vocabulary `BUNDLE_KINDS` — no `skill` kind. `(kind, ref)` is unique per document (`bundle-duplicate`). Composes by union across a stack. |
| `grants` | `{ requires[], optional[], suggestedProviders{} }` | RESERVED (D-004, sequenced by D-014): the shape is final now; any non-empty grants section is an ERROR (`grants-reserved`) until capability classes ship in M3, so no interim grant vocabulary can appear. Until then an identity's toolset is the pot/role ceiling. |
| `publisher` | `{ id, name?, url? }` | layer metadata (the resolved document carries the leaf's). |
| `attestation` | `{ contentHash, signedBy, signature?, signedAt? }` | publisher attestation over THIS layer: `contentHash` must equal the layer's own hash (§4); the signature binding lands in M2 on `lib/identity/attest.ts` + `hive-keypair.ts`. |

Engine and autonomy defaults stay on the EXISTING `knobs.aiBackend.roles` / autonomy sections
(P-025) — never a parallel field. `extends` (the stack) and `version` already existed.

## 2. The slot registry

<!-- SLOT-REGISTRY:BEGIN -->
Layering order: `kernel` → `client` → `domain` → `fleet-posture` → `modes` → `practices` → `instance` (reserved, no declarable slot: `kernel`, `instance`).

| slot | cardinality | layer | fills | ruling |
|---|---|---|---|---|
| `client` | exclusive | client | the per-client tooling overlay (Claude / Codex / OMP) — the section the su prompt hand-splices today as CLIENT-TOOLING-OVERLAY | D-007 amendment 2026-09-03 |
| `domain` | exclusive | domain | the profession: what the work IS and how it is judged (papercusp-engineer, potato-salesman) — the engineering-discipline text of su.md | D-007 ("exactly one profession per agent" becomes "the domain slot is exclusive") |
| `fleet-posture` | exclusive | fleet-posture | the fleet ROLE playbook — member pull-loop style or leader monitoring / benching / claim-spec craft; the fleet PROTOCOL invariants stay kernel | D-003 (playbooks leave the kernel) + D-007 (member-vs-leader is one exclusive slot) |
| `autonomy` | exclusive | modes | the domain flavour of AUTO mode prose (state + what AUTO suspends stay kernel) | D-008 amendment 2026-09-03 (one exclusive slot per mode axis) |
| `ideation` | exclusive | modes | the domain flavour of IDEATE mode prose | D-008 amendment 2026-09-03 |
| `objective` | exclusive | modes | the domain flavour of DRAIN mode prose (the DRAIN ⇒ AUTO implication is kernel) | D-008 amendment 2026-09-03 |
| `audit` | exclusive | modes | the domain flavour of AUDIT mode prose (read-only-toward-subject enforcement is kernel) | D-008 amendment 2026-09-03 |
| `audience` | exclusive | modes | who the agent is speaking to — the engineer-mode / novice-mode personas that `loadRoleModePersona` resolves from files today | D-008 (unify the second mode axis) + amendment 2026-09-03 |
| `collaboration-stance` | exclusive | practices | how the agent works WITH the owner — the collaborator stance of su.md (address by name, confirm-before-execute posture, delivery discipline) | D-017 (P-001 ruling): exclusive — two stances toward one owner conflict rather than stack; sits on the practices layer per D-007’s order |
| `practice` | additive | practices | a stackable working practice (compaction protocol, wait-loop discipline, peer-wake craft, …) | D-007 ("practices stack because their slot is additive") |

Bundle kinds (`bundles[].kind`, D-011): `recipe`, `rubric`, `knowledge-pack`, `datatype`, `event`, `rule` — no `skill` kind (owner ruling 2026-09-02).
<!-- SLOT-REGISTRY:END -->

**Why a registry and not a `kind`.** What the profession/facet TYPE split encoded was a
cardinality constraint on one slot; two package kinds paid for one rule with two lifecycles
(D-007). A new axis is one row in `SLOT_SPECS` (typed exhaustively against `SLOT_IDS`, so a
slot without a spec is a compile error). **Why `kernel` and `instance` are layers, not slots.**
The kernel is sealed (D-009 / P-003) and the instance tier is the per-pot override
(`pot_settings.promptOverride.<role>`, audit S5); a document claiming either is refused
(`slot-reserved-layer`). **Why mode axes are five exclusive slots.** Modes stack ACROSS axes
(`auto + ideate`, `drain ⇒ auto`) and are exclusive WITHIN one; a single `mode` slot would make
`mode:set ideate` on an AUTO session a composition failure (D-008 amendment). Mode STATE and
the implication table stay in `modes/registry.ts`; authority is computed by
`instruction-lint.ts` and enforced at the dispatch chokepoint — identity text is never an input.

## 3. Composition: a stack is an ordered `extends`

A **stack** is the existing ordered multi-parent `extends` array (`schema.ts`
`extends: z.union([z.string(), z.array(z.string())])`); `resolveLayers` walks it depth-first,
parents before children, and returns every merged document as a `BlueprintLayer` (id,
sourcePath, contentHash, attestation, slots) in merge order. Precedence ascends along that
list; a renderer walks layers in layering order (§2) and renders the kernel LAST with an
explicit precedence statement (the seal — P-003).

**Merge algebra (`merge-rules.ts`, consumed by P-019).** Every leaf of `BlueprintSchema`
(145 as of 2026-09-03; a LEAF is a scalar field, a whole array, a whole record, a union, a lazy
schema, or an object's `.catchall` keys as `<path>.*`) has ONE declared rule in `MERGE_RULES`;
`merge-rules.test.ts` fails on a leaf with no rule and on a rule naming no leaf. The rules:

| rule | meaning | where |
|---|---|---|
| `replace` | the child's value wins when set; absent inherits — today's `mergeRaw` for scalars / arrays | the default |
| `union` | set-union: arrays by `key` (a field or tuple) or value; records by key, child wins per key — today's deep-merge for plain objects | every record; `bundles` (key `[kind, ref]`), `grants.requires`, `grants.optional` (D-003 / D-011) |
| `most-restrictive` | the TIGHTER value wins regardless of order (numeric caps: min) | `spine.maxTurns`, `recursion.maxDepth`, `knobs.maxCostUsd`, `knobs.parallelWorkers.max`, `knobs.parallelWorkers.maxFeaturesInFlight`, `dispatch.costCapUsd`, `dispatch.safetyCeiling` (D-003) |
| `hard-error` | keyed union in which a key claimed by two DISTINCT layers fails the load; cardinality-aware for `slots` | `slots` only (D-007) |

The default assignment REPRODUCES today's `mergeRaw` so every pre-existing blueprint resolves
byte-identically under the rule-driven merger; the deviations are exactly the rows above and
each carries a note saying so. A merger honouring the cap rule will turn a parent-200 /
child-500 `maxTurns` into 200 — the intended fix, asserted explicitly by P-019's fixtures.
`mergeRuleFor(path)` resolves a concrete document path: exact entry, else the nearest
enclosing catchall (`knobs.foo` → `knobs.*`).

**Slot conflicts are checked on the STACK, not the merged document.** `mergeRaw` still
replaces the child's `slots` array wholesale (P-019 unions it), so `resolveBlueprint` derives
the claims from `layers[].slots` and fails the load on `findExclusiveSlotConflicts`
(`slot-exclusive-conflict`): two DISTINCT documents on one exclusive slot conflict; the same
document reached twice (a diamond) is one claimant; additive slots stack; unknown slot ids are
validation's job (`slot-unknown`).

## 4. Per-layer content hash and attestation

`layerContentHash(raw)` is sha256 over the layer's OWN raw document with `attestation`
removed (sorted-key stable), so a publisher can sign a document that then carries its own
attestation. `blueprintHash` remains the hash of the RESOLVED document (the projection's
`content_hash`). `resolveBlueprint` verifies every layer's `attestation.contentHash` against
its computed hash and refuses the load on disagreement (`attestation-hash-mismatch`). The
lockfile (M2, P-005) extends the existing dep-validation pin record with these per-layer hashes.

## 5. Splice-seam design — how the stack enters each render tier

The four assemblers (audit §1–§2) stay code; each gains ONE seam where the ordered layer list
replaces the hand-spliced sections. Client is an axis of the stack, not of the assembler.

| tier | assembler today | what the stack replaces there | owning items |
|---|---|---|---|
| interactive psu | `packages/operator-core/lib/desktop-install/papercusp-files.ts` `renderSuPlaybook` — splice steps 1–11 over `blueprints/base/prompts/su.md` (audit §1) | step 1 CLIENT-TOOLING-OVERLAY → the `client` layer; the engineering-discipline text of su.md → `domain`; `## Working as a fleet MEMBER` / `## Default posture` → `fleet-posture` (attached by `fleet:launch-on-plan` / `fleet:take-leadership`); step 6 AUTO-MODE → the five mode-axis layers, attached from `mode:set`; step 9 SHARED-BASE-NOTES + step 8 COMPACTION → `practice` layers; the collaborator stance → `collaboration-stance`; `pot_settings.promptOverride.su` (S5) stays the instance tier; the kernel renders last with the seal. Generated sections (WIRE-SCHEMAS, COORD-LEGEND, RESULT-DOOR, WORKSPACE-MAP, PROMOTION-MODEL, PROJECT-GUIDE) remain derived and are spliced by marker — P-024 first restores the 5 missing markers (F2). | P-003, P-020, P-021, P-024 |
| autonomous spawn (bees) | `libs/papercusp/packages/orchestrator/src/prompt-build.ts` (S9) | the same layer list; the inline nudge constants become `practice` documents; the kernel base text is `blueprints/base/prompts/agent-base-preamble.md` (P-032 SUBSUME) | P-023, P-032 |
| chat-surface roles | `packages/operator-core/lib/prompt-assembly.ts` (S10/S11) | `PROMPT_ROLES` resolve through the chain with the file tier as lowest-precedence fallback; `loadRoleModePersona`'s engineer/novice files become the `audience` layer | P-023, P-021 |
| harness spawn | `libs/papercusp/packages/orchestrator/src/prompt-resolve.ts` (S6) | already the chain walk (`blueprints/<id>/prompts/<role>.md` up the chain, then base); `agent-base-overlay.md` becomes the `domain` leaf; `.materialized/**` is never the live path | P-032, P-003 |

**Client axis.** Exactly one `client` document per launch — Claude / Codex / OMP — selected by
the launcher's `agent` argument (today `apps/operator/prompts/papercusp-su.<agent>.md`, S2, plus
the out-of-repo mirrors S14). Claude's `CLAUDE.md` auto-load and the
`~/.papercusp/compaction-strategy.md` include are COMPENSATIONS for the dropped sections (F2),
retired by P-024 once the markers are present; Codex/OMP get the same content through the layer
list with no mirror.

**Runtime attach / detach (P-012).** Additive and mode-axis layers attach inject-now through
the existing mode-flip channel and appear in the next full render; a `domain` swap is a
relaunch-with-carry; a `fleet-posture` swap follows inject-now under the exclusive-slot rule.
Only mode PROSE moves; state and implications stay in the registry.

## 6. The projection: `harness_shared.blueprints` is POPULATED, not dropped (D-016 §3 → D-017)

Audit finding F3 / row S20 said "nothing reads it today". **That was wrong** (corrected in the
audit and in D-017): `getEffectiveBlueprint` (`packages/operator-core/lib/blueprint/project-to-pg.ts`)
reads the cache and lazily projects `<harness>/.papercusp/blueprint.yaml` on a miss, and is
called from `dbos/orchestrator-loop.ts` `resolveHarnessDispatchGate`, `blueprint/blueprint-run-action.ts`
and `harness/routines/gym-actions.ts`; `harness/improvements/watchdog.ts` reads it as
`blueprint_wired`; `blueprint/commit-reproject-real.ts` writes it. The table is empty on this
box because (a) this repo has no `.papercusp/blueprint.yaml` (S21 — P-024 creates it), so the
papercusp pot never projects, and (b) the lazy path only fires from those callers, with errors
swallowed (`.catch(() => null)`). Measured 2026-09-03: 9 of 10 sibling harness blueprints load
cleanly through the loader; `brood-box-alpha` fails `cannot resolve extended blueprint "pot"`
(filed). Ruling: POPULATE via the existing lazy projector + `commit → reproject` path; M2's
identities read the same projection; no new store.

## 7. Boundary — what P-001 deliberately leaves to its neighbours

- **P-019** replaces `mergeRaw` with the `MERGE_RULES`-driven merger, adds the fast-check
  properties (union commutative + idempotent; most-restrictive commutative; replace
  order-dependent by design), unions `slots` across layers, and decides whether `roles`,
  `reactive`, `gym.signals`, `dependencies.*` move from `replace` to keyed union.
- **P-002** assigns su.md's sections to these slots; **P-003** seals the kernel and renders the
  stack; **P-012** attaches/detaches layers at runtime; **P-032** subsumed the second composer
  (§8, D-018).
- **P-016 (M3)** lifts the `grants-reserved` refusal when capability classes exist.

## 8. The second composer (`REPLACE_CLAUDE_BASE`) — subsumed, not a third path (P-032 / D-018)

`src/prompt-resolve.ts` `resolveReplacementSystemPrompt` already composes a REPLACEMENT system
prompt for a spawn: the neutral base preamble, then the SINGLE most-specific blueprint overlay
walking the `extends` chain leaf-first (`base` excluded; first hit wins), joined
`trim + "\n\n" + trim + "\n"`. That is D-002's kernel + overlay model on the spawn tier,
shipped under domain-generic-agent-personas P-009/P-010/P-013, and it maps onto the stack
without remainder:

| file (live read path, under `libs/papercusp/packages/harness/`) | layer / slot | notes |
|---|---|---|
| `blueprints/base/prompts/agent-base-preamble.md` | **kernel** — the kernel's BASE text | domain- and tier-neutral ring-0 topics (Harness · Tools+MCP startup · Blockers · Diagnose-from-evidence · Mitigation≠fix · Context · Environment · Memory). Rendered on EVERY tier; su.md's ring-0 sections are kernel EXTENSIONS of the interactive tier and P-002 keeps an overlapping paragraph once, here. |
| `blueprints/<id>/prompts/agent-base-overlay.md` | **`domain`** — the slot's LEAF document | exclusive; the chain walk's first-hit rule IS the exclusive-slot resolution. Today only `blueprints/coding-factory/prompts/agent-base-overlay.md` exists — the coding HIVE (`blueprints/coding`) has no domain leaf (EI-22285277325728666); P-002's papercusp-engineer identity becomes it. |

**What the flag is.** `REPLACE_CLAUDE_BASE` (`libs/flags/src/types.ts`, default = `FLAG_DEFAULTS`
= not in `DARK_FLAGS` ⇒ **ON**; no workspace override carries the key) is not a composer — it is
the claude-CLI DELIVERY switch: replace the Claude Code default coding prompt
(`--system-prompt-file` for bees in `invoke.ts`; `--system-prompt-file` +
`--exclude-dynamic-system-prompt-sections` for psu sessions in `apps/operator/scripts/psu-launcher.mjs`)
versus append to it. Only REPLACE is coherent under the seal: the append branch places Claude's
unsealed coding prose ABOVE the kernel.

**Retirement (P-003-gated).** P-003's renderer produces the spawn-tier system prompt from the
stack `[kernel(preamble), domain(overlay)]`; `resolveReplacementSystemPrompt` becomes a thin call
into it and the flag, its `PAPERCUSP_REPLACE_CLAUDE_BASE` env threading (bootstrap-su,
bootstrap-role, dbos/orchestrator-runner, `invoke.replaceClaudeBaseEnabled`) and the launcher's
`--append-system-prompt-file` branch are deleted — only after a golden test shows the renderer's
output byte-equal to today's for the base-only and coding-factory chains. The byte formula is
pinned now by `prompt-resolve.test.ts` ("P-032/D-018 …"), which also asserts this section names
the two live paths above. `apps/operator/dist-*/**`, `papercusp-desktop/src-tauri/**/harness/**`
and `.materialized/**` copies of both files are projections, never the live read path.
