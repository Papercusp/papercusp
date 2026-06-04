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
 * Committed role→model-spec defaults. Keep this SMALL — only roles whose model
 * choice is load-bearing enough that an accidental downgrade is a real
 * regression belong here; everything else should keep using the CLI default.
 */
export const ROLE_MODEL_DEFAULTS: Readonly<Record<string, string>> = {
  // The deploy gate's judgment half (D-011). Claude Opus 4.8 @ xhigh effort:
  // a deploy's blast radius is the whole running fleet, so this low-frequency,
  // high-stakes call is worth maximum reasoning. Committed so it can't silently
  // downgrade on a host without AGENT_MODELS["release-manager"] set.
  'release-manager': 'opus:xhigh',
};

/**
 * The committed default model spec for a role, or `undefined` when the role has
 * none (→ caller keeps the CLI default). `AGENT_MODELS`/config OVERRIDE this; it
 * is consulted only after they yield nothing.
 */
export function roleModelDefault(role: string): string | undefined {
  return ROLE_MODEL_DEFAULTS[role];
}
