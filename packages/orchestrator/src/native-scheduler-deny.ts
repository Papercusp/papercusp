/**
 * Native-scheduler lockout for spawned agent sessions
 * (native-scheduler-lockout-2026-06-09).
 *
 * The hive's liveness contract is "a wake is always armed IN THE ROUTINES
 * TABLE" (`hive:declare-wake` → the one-shot `hive-wake` routine row): that
 * table is the single scheduler of record that `hive:status`, Pause, the
 * wake-mode gate, and the liveness backstop all read (D-001). claude-code
 * ships its OWN scheduling surfaces — Cron* tools, `ScheduleWakeup`, the
 * `/schedule` + `/loop` skills — and a wake scheduled there is invisible to
 * all of that machinery: the backstop double-fires, Pause can't stage it, and
 * a cron job outlives the hive as a zombie (verified live 2026-06-09:
 * `ScheduleWakeup` IS in a headless `-p` session's toolset). So every agent
 * launch denies them, forcing the one scheduler the substrate can see.
 *
 * Two layers ride the same flag:
 *   - T1 (`NATIVE_SCHEDULER_DENY`): claude's first-class scheduler tools.
 *   - T2 (`OS_SCHEDULER_BASH_DENY`): `Bash(<cmd>:*)` deny patterns for the
 *     persistent OS schedulers reachable through the Bash tool. Headless bees
 *     run with a minimal, hook-free CLAUDE_CONFIG_DIR (creds symlink only),
 *     so a PreToolUse hook guard never fires there — the deny patterns are
 *     the only enforcement that reaches every claude agent session (D-007).
 *     Known limits, accepted: prefix rules don't catch compound commands
 *     (`x && crontab …`), and `at` is omitted (bare-prefix rule would
 *     false-positive `atuin`/`attach`); the prompt layer (P-011) carries the
 *     intent, and the omp/codex hook seams (P-010) do word-boundary matching.
 *
 * Scope: AGENT sessions only (headless invoke spawns, wake-executor resumes,
 * interactive `psu --role` panes). The human `psu su` collaborator session
 * keeps its native schedulers — `/schedule` there is the owner's own surface
 * (D-003).
 *
 * Flag form: MUST be the single-token `--disallowedTools=a,b,c` (D-002). The
 * flag is variadic (`<tools...>`) and the space form greedily eats every
 * following token — including a trailing positional prompt (verified live:
 * the wake text became "deny rules"). The deny holds under
 * `--permission-mode bypassPermissions` (also verified live — the tool is
 * removed from the model's toolset, not merely permission-gated).
 *
 * psu-launcher.mjs (plain-node script, can't import TS) duplicates the
 * rendered literal in `roleLaunchArgs`; the lockstep test in
 * apps/operator/lib/psu-launcher.test.ts pins the two copies together.
 */

/** T1 — claude-code's first-class scheduler tools + skills. */
export const NATIVE_SCHEDULER_DENY = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'Skill(schedule)',
  'Skill(loop)',
] as const;

/** T2 — persistent OS schedulers via the Bash tool (colon prefix-rule form;
 *  entries must stay space-free so the `=` single-token join survives). */
export const OS_SCHEDULER_BASH_DENY = [
  'Bash(crontab:*)',
  'Bash(systemd-run:*)',
  'Bash(batch:*)',
] as const;

/** The ready-to-append argv token (claude CLI). Single `=` token — see header. */
export function nativeSchedulerDenyFlag(): string {
  return `--disallowedTools=${[...NATIVE_SCHEDULER_DENY, ...OS_SCHEDULER_BASH_DENY].join(',')}`;
}

/** True when `cmd` already carries an explicit --disallowedTools /
 *  --disallowed-tools (either form) — an operator-configured deny list wins;
 *  we never stack a second flag (claude would union them, but the operator's
 *  intent is ambiguous, so leave their command untouched) (D-004). */
export function hasExplicitDisallowedTools(cmd: string): boolean {
  return /--disallowed(?:-t|T)ools(?:=|\s)/.test(cmd);
}
