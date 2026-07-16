/**
 * Committed per-role model defaults — the in-tree role→model default map
 * (EI-7 / release-gate-ready-branch-2026-06-04 D-011).
 *
 * The problem this closes: per-role model selection (`resolveModel` in
 * invoke.ts, `applyRoleModel` in operator-core's harness-invoke-once.ts) read
 * ONLY env (`AGENT_MODELS`) + per-harness config.json. So a role whose
 * judgment must NOT silently downgrade — chiefly `release-manager`, whose blast
 * radius is the entire running fleet — fell back to the agent CLI's generic
 * default on any host without the env var set (the `opus:xhigh` pin lived only
 * in a `.env.local` + a doc-comment). EI-7.
 *
 * These are DEFAULTS, not overrides: `AGENT_MODELS` / config.json STILL win
 * (an operator can still pin a different model). The committed default is the
 * floor that applies when nothing else is set, so the choice can't degrade to
 * the CLI default by omission.
 *
 * A spec is a model id or `<modelId>:<effort>` (effort ∈
 * low|medium|high|xhigh|max) — the same shape `AGENT_MODELS` values take, so it
 * flows through the existing parsers unchanged (`applyRoleModel` splits the
 * `:effort`; `resolveModel` passes the spec to `normalizeModelForBackend`).
 */

/**
 * Committed role→model-spec defaults — the per-role MODEL-TIER POLICY
 * (token-usage-reduction-audit-2026-06-09 P-012), enforced via the launch
 * spec rather than convention:
 *
 *   - haiku  — high-volume, low-judgment loop roles: the fleet's call-count
 *              tier; opus here is pure waste. (cup/scanner/judge moved OFF
 *              this tier onto the autonomous-loop GPT-5.6 luna floor below,
 *              autonomous-loop-prod-audit-2026-07-02 P-020 — no role
 *              currently occupies haiku.)
 *   - sonnet — the pipeline's execution tier (worker / validator /
 *              documenter): high-frequency roles whose work is bounded by a
 *              spec + acceptance assertions, not open-ended judgment.
 *   - opus   — ONLY on explicit escalation: an `AGENT_MODELS`/config override
 *              per role, or a committed pin for a low-frequency,
 *              fleet-blast-radius judgment call (release-manager).
 *
 * These are DEFAULTS, not overrides — `AGENT_MODELS`/config.json still win,
 * so escalating one harness's worker to opus is a per-role config entry.
 */
export const ROLE_MODEL_DEFAULTS: Readonly<Record<string, string>> = {
  // The deploy gate's judgment half (D-011). Claude Opus 4.8 @ xhigh effort:
  // a deploy's blast radius is the whole running fleet, so this low-frequency,
  // high-stakes call is worth maximum reasoning. Committed so it can't silently
  // downgrade on a host without AGENT_MODELS["release-manager"] set.
  'release-manager': 'opus:xhigh',
  // The launch-fixer family — opus:xhigh for the two fleet-blast-radius members, the
  // committed floor matching git-pipeline-stats' resolverModel() (git-sync-content-guard
  // D-008 follow-up). Each fires rarely (only on a conflict / red gate) and unblocks a
  // path the whole fleet depends on, so the same "low-frequency, fleet-blast-radius
  // judgment call" rubric that pins release-manager applies:
  //   - merge-resolver redoes a conflicted merge on `main` — a wrong resolution corrupts
  //     the shared history. resolverModel() already declares opus:xhigh as its floor for
  //     stats, but the LAUNCH path (applyRoleModel→roleModelDefault) had no entry, so on a
  //     host without AGENT_MODELS["merge-resolver"] it silently downgraded (the EI-7 class
  //     of bug release-manager fixed). Pinned here reconciles the two sources of truth.
  //   - release-fixer is the release-manager's execution twin: it reproduces a red-gate
  //     failure and classifies regression-vs-flake — subtle judgment where a wrong call
  //     either ships a regression or churns on a flake, on the path that gates ALL deploys.
  'merge-resolver': 'opus:xhigh',
  'release-fixer': 'opus:xhigh',
  // The content-guard's syntax repairer — the execution tier (sonnet), not opus: its work
  // is bounded syntax repair against a deterministic success check (the content detector
  // re-passes), it fires more often than the gate fixers (any quarantined .mdx/.ts), and a
  // wrong fix is self-correcting (re-quarantined, low blast radius). Not haiku: a file-
  // editing role needs reliable tool-calling (EI-286: haiku drifts into bash).
  'content-fixer': 'sonnet',
  // The DOC-STEWARD (docs-corpus-audit WS2 / P-008) — the auto doc-freshness fixer, the
  // launch-fixer family's fourth member alongside merge-resolver / release-fixer / content-fixer.
  // sonnet, not opus: like content-fixer its work is bounded (re-verify prose against the anchored
  // code, harness_docs:verify to clear the flag) and self-correcting, but a doc-editing role needs
  // reliable tool-calling + the BIG window — it reads several whole source files per run to check a
  // batch of up to 8 drifted docs. EI-8164: registered LATE (role-config.ts), it was the one
  // fixer role with NO committed default, so `applyRoleModel`/`roleModelDefault` returned the base
  // command UNCHANGED → it launched on the bare CLI default, which runs a 200k auto-compact window
  // in CC (no `[1m]` marker gets injected when no spec is resolved). Its multi-file reads then
  // thrashed autocompact → "Prompt is too long" (context_overflow) — 6+ failed spawns/day. Pinning
  // `sonnet` here routes it through normalizeModelSpec → `sonnet[1m]` (the 967k window) at launch,
  // the same fix every sibling fixer already had. Cheap, high-frequency, spec-bounded ⇒ sonnet tier.
  'doc-steward': 'sonnet',
  // P-012 execution tier — spec-bounded, high-frequency pipeline roles.
  worker: 'sonnet',
  validator: 'sonnet',
  documenter: 'sonnet',
  // P-012 volume tier (haiku) ORIGINALLY also pinned cup/scanner/judge here —
  // superseded by the P-020 autonomous-loop migration below (those three ARE
  // autonomous-loop/gym roles the brief names explicitly; moved rather than
  // duplicated, since an object literal's later key silently wins and a
  // stray duplicate would be a footgun for the next reader). No other role
  // currently occupies this volume tier.
  // The pot's JUDGMENT/control-loop layer (owner-watched autonomous run,
  // 2026-06-11): Mug/Kettle/Cup/Blender wakes are the free-running
  // Mug→Cup→Kettle→Blender autonomous loop (local-hive-orchestration /
  // pot-rename D-007). Sonnet-5 trimmed-mode WAS the committed floor for
  // high-reliability autonomous roles (2026-07-15); superseded below.
  //
  // (autonomous-loop-prod-audit-2026-07-02 P-020): migrated every
  // AUTONOMOUS-LOOP role — the Mug↔Cup↔Kettle↔Blender placement/execution
  // loop plus the gym learning-loop's judge — to GPT-5.6 "Luna" (the plan's
  // "GPT-5.6 Lua" shorthand; the canonical alias is `luna`, confirmed against
  // WI-4638's official-source identifier verification + WI-4639's completed
  // catalog/validator implementation — see role-models.test.ts) at `high`
  // reasoning effort, native Codex backend. Deliberately the FULL id
  // (`gpt-5.6-luna:high`), NOT the bare `luna:high` alias: the spawn-time
  // backend inference this floor feeds (`inferBackendFromModelSpec` in
  // harness-invoke-once.ts / `isCodexShapedModelSpec` in the orchestrator's
  // own env.ts) keys off the `gpt-5.6-` prefix so a role that relies on
  // ONLY this committed floor (no explicit tier/spec override) still gets
  // its subprocess binary swapped to `codex` — the "account-steering path"
  // half of P-020 (see operator-spawn.ts / invoke.ts for the consuming
  // fallback fix). A bare alias here would silently keep the claude binary
  // and hand it an unrunnable OpenAI model id — the EI-7/EI-286/EI-12657/
  // WI-1979 class of "selected model unavailable" outage this floor exists
  // to prevent.
  //
  // Every key that resolves to the same canonical role via the pot-rename
  // map (POT_RENAME_ROLE_MAP in agent-tools/coordination/roles.ts:
  // bee→cup, queen→mug, sentinel→papercup, overwatch→kettle, scout→blender)
  // is kept in lockstep here — nothing canonicalizes the role string before
  // this map is looked up, so a stale legacy-name entry would silently keep
  // running the old sonnet spec for any caller still passing the old name.
  // `papercup` and `blender` are NEW entries (previously absent — those
  // roles fell through to the bare CLI default with no committed floor at
  // all, the exact EI-7 gap this file exists to close).
  queen: 'gpt-5.6-luna:high',
  bee: 'gpt-5.6-luna:high',
  mug: 'gpt-5.6-luna:high',
  cup: 'gpt-5.6-luna:high',
  kettle: 'gpt-5.6-luna:high',
  overwatch: 'gpt-5.6-luna:high',
  sentinel: 'gpt-5.6-luna:high',
  papercup: 'gpt-5.6-luna:high',
  blender: 'gpt-5.6-luna:high',
  // The gym loop's judgment role (task-generator/variant-runner/proposer stay
  // unpinned — no committed default existed for them before P-020 either;
  // out of THIS item's narrow scope, left for a follow-up). `scanner` is
  // blender's negative-space-scan execution role (AGENT_ROLES: "the
  // negative-space/scout scanner") — moves with blender.
  judge: 'gpt-5.6-luna:high',
  scanner: 'gpt-5.6-luna:high',
};

/**
 * The committed default model spec for a role, or `undefined` when the role has
 * none (→ caller keeps the CLI default). `AGENT_MODELS`/config OVERRIDE this; it
 * is consulted only after they yield nothing.
 */
export function roleModelDefault(role: string): string | undefined {
  return ROLE_MODEL_DEFAULTS[role];
}
