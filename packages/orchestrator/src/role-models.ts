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
 *   - haiku  — high-volume, low-judgment loop roles (bees, scanners, judges):
 *              the fleet's call-count tier; opus here is pure waste.
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
  // P-012 execution tier — spec-bounded, high-frequency pipeline roles.
  worker: 'sonnet',
  validator: 'sonnet',
  documenter: 'sonnet',
  // P-012 volume tier — already de facto haiku via env on the dev box;
  // committed so a host without AGENT_MODELS can't silently run the fleet's
  // call-count tier on the CLI default.
  bee: 'haiku',
  scanner: 'haiku',
  judge: 'haiku',
  // The hive's JUDGMENT layer (owner-watched autonomous run, 2026-06-11): the
  // Queen/operator wakes are low-frequency (≤48/day) multi-step tool-driven
  // placement decisions — and with no entry here they fell to the host CLI
  // default (haiku on the dev box), which loads MCP tool references then
  // drifts into bash instead of calling them (three consecutive live wakes:
  // the 04:03Z home-slug survey, the 05:39Z bash-only queen turn, and the
  // 01:02Z evidence-fabrication incident, EI-286). Judgment tier per this
  // file's own rubric — escalate to opus via AGENT_MODELS if needed.
  queen: 'sonnet',
  operator: 'sonnet',
};

/**
 * The committed default model spec for a role, or `undefined` when the role has
 * none (→ caller keeps the CLI default). `AGENT_MODELS`/config OVERRIDE this; it
 * is consulted only after they yield nothing.
 */
export function roleModelDefault(role: string): string | undefined {
  return ROLE_MODEL_DEFAULTS[role];
}
