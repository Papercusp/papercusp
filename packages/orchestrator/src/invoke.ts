/**
 * `invoke <role> [extras...]` — spawn the agent CLI (default `omp -p`,
 * or whatever $AGENT_CMD/$CLAUDE resolves to) with the assembled prompt,
 * capturing three outputs:
 *
 *   <logDir>/<runId>.jsonl  — raw stream-json events (UI tails this)
 *   <logDir>/<runId>.out    — the final result text (orchestrator parses this)
 *   <logDir>/<runId>.err    — stderr (logged on non-zero exit)
 *
 * Mirrors bash run.sh's invoke() function. Keeps the agent CLI as a child
 * process specifically so users on Claude Max subscriptions continue to
 * authenticate via Claude Code's CLI session (omp routes via Meridian's
 * Claude Code SDK; claude-code uses its own session) — the direct-SDK
 * route would lose that capability.
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { configGet, readConfig } from './config';
import { buildPrompt } from './prompt-build';
import { fetchSubstrateContext } from './tiered-context';
import { resolvePromptFile } from './prompt-resolve';
import { extractFeatureId, makeRunId } from './run-id';
import { harnessSlug as harnessSlugFromProjectDir } from './state';
import {
  buildSpawnMcpConfig as _buildSpawnMcpConfig, // eslint-disable-line @typescript-eslint/no-unused-vars
  extractChunkId,
  restoreSpawnMcp,
  writeSignedSpawnMcp,
  writeSignedSpawnCodexHome,
  writeSpawnClaudeConfig,
  type SpawnMcpHandle,
  type SpawnCodexHomeHandle,
  type SpawnClaudeConfigHandle,
} from './spawn-mcp';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentBackend, InvokeResult } from './types';
import { resolveAgentBackend, normalizeModelForBackend } from './env';
import { ROLE_MODEL_DEFAULTS } from './role-models';
import { workspaceHomeDir } from './workspace';

/**
 * Postgres client interface the orchestrator uses for PG-canonical state.
 * Kept as a structural type so callers can pass any postgres-js Sql<{}>
 * instance (or a test double) without importing `postgres` here. When
 * undefined, the orchestrator uses the in-memory feature store
 * (`state-memory.ts`) — fine for tests and CLI standalone mode.
 * Production always wires a real PG client.
 */
export interface OrchestratorPg {
  // postgres-js tagged-template signature: pg`SELECT ...`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (template: TemplateStringsArray, ...values: unknown[]): Promise<any[]>;
}

/**
 * Serialize a JS value bound for a jsonb column. postgres-js JSON-encodes a
 * value passed to a jsonb column, so `${JSON.stringify(x)}` DOUBLE-encodes it —
 * the array/object lands as a jsonb STRING scalar and never round-trips (and a
 * `::jsonb` cast does NOT fix it; verified). The correct form is the postgres-js
 * `sql.json()` helper. This wrapper uses it when present (a real client) and
 * falls back to the raw value for test doubles (makeMockPg) that don't implement
 * `.json` — so unit mocks observe the raw value, production stores real jsonb.
 */
export function pgJson(pg: OrchestratorPg, value: unknown): unknown {
  const j = (pg as { json?: (v: unknown) => unknown }).json;
  return typeof j === 'function' ? j(value) : value;
}

export interface InvokeContext {
  /** HARNESS_DIR — root of the @papercusp/harness install. */
  harnessDir: string;
  /** PROJECT_DIR — the user's project. */
  projectDir: string;
  /** STATE_DIR — usually `<projectDir>/.papercusp`. */
  stateDir: string;
  /** LOG_DIR — usually `<stateDir>/logs`. */
  logDir: string;
  /** Resolved phase from config.json (defaulted to "staging"). */
  phase: string;
  /** Agent invocation template. e.g. `omp -p`, `claude -p --model sonnet`, or any wrapper.
      Resolved from $AGENT_CMD ?? $CLAUDE; default `omp -p`. */
  claudeCmd: string;
  /**
   * Agent backend driving the spawn. Selects the structured-output flag
   * set + the result parser. Defaults to inferring from `claudeCmd`
   * (omp/pi binary → 'omp', otherwise 'claude-code').
   */
  agentBackend?: AgentBackend;
  /** Optional override for the dept slug (otherwise read from config.json). */
  dept?: string;
  /**
   * Function used to resolve a worktree path for a feature, if branchIso +
   * worktrees are enabled. Returns null/empty when no override applies.
   * Pluggable so the worktree subsystem (Stage 3) can be ported later
   * independently.
   */
  worktreePathFor?: (featureId: string) => string | null;
  /** Logger instance. */
  log: (message: string) => void;
  /** Override Date.now / shell time for deterministic tests. */
  nowSeconds?: () => number;
  /**
   * PG client for the workspace's Postgres database. Phase 1+ migrated
   * features, lanes, escalation, sentinels, dispatches, and checkpoints
   * onto Postgres; PG is canonical at runtime. When undefined (tests,
   * CLI standalone), the orchestrator uses the in-memory feature store
   * — features.json is no longer a supported backend. Operator wires
   * this up via `getOrgPg()`; CLI mode bootstraps its own connection.
   */
  pg?: OrchestratorPg;
  /**
   * Workspace ID for RLS scoping. Required when `pg` is set. Resolved
   * once at orchestrator startup from `~/.papercusp-workspaces/registry.json`
   * (the only legitimate pre-DB filesystem read).
   */
  workspaceId?: string;
  /**
   * Extra env vars merged into every spawned agent's process env.
   * Resolved once at orchestrator startup from PG (Migration 047 —
   * search-provider keys); attached to ctx so all `invoke()` call
   * sites pick them up without per-site plumbing.
   */
  extraSpawnEnv?: Record<string, string>;
}

/** What the spawn step actually returns (richer than the public InvokeResult). */
interface SpawnOutcome {
  exitCode: number;
  durationMs: number;
}

/** Split `claudeCmd` into argv. Honors simple quoting like bash IFS would. */
export function splitCommand(cmd: string): string[] {
  // The bash invocation does `$CLAUDE $extra_flags` — unquoted, so it's just
  // whitespace-split. Mirror that.
  return cmd.split(/\s+/).filter(Boolean);
}

/** Read promptOverrides.<role> from config.json. Mirrors the python helper. */
export function resolvePromptOverride(
  cfg: ReturnType<typeof readConfig>,
  stateDir: string,
  role: string,
): string {
  const overrides = (cfg.promptOverrides as Record<string, string> | undefined) ?? {};
  const val = overrides[role];
  if (!val) return '';

  // Absolute path
  if (val.startsWith('/')) {
    if (existsSync(val)) {
      try { return readFileSync(val, 'utf8'); } catch { return ''; }
    }
    return '';
  }

  // Relative path — resolve from stateDir
  if (val.startsWith('./') || val.endsWith('.md') || val.endsWith('.txt')) {
    const p = join(stateDir, val.replace(/^\.\//, ''));
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf8'); } catch { return ''; }
    }
    return '';
  }

  // Inline string
  return val;
}

/**
 * Store-aware per-role prompt override (Phase 1b read-side cutover, D-7).
 * Prefers the workspace-owned PG store
 * (`harness_shared.harness_prompt_overrides` keyed by workspace_id, harness_slug,
 * role) when a `pg` client + workspace + slug are available; otherwise — and on
 * ANY failure (no pg, missing table, query error, empty) — falls back to the
 * file/config.json `resolvePromptOverride` above. So this is regression-safe:
 * an empty/absent store, or a PG hiccup, yields exactly today's behavior. The
 * try/catch makes a store problem inert, never a spawn-breaker.
 */
export async function resolvePromptOverrideWithStore(
  cfg: ReturnType<typeof readConfig>,
  stateDir: string,
  role: string,
  opts: { pg?: OrchestratorPg; workspaceId?: string; harnessSlug?: string },
): Promise<string> {
  const { pg, workspaceId, harnessSlug } = opts;
  if (pg && workspaceId && harnessSlug) {
    try {
      const rows = await pg`
        SELECT prompt_md FROM harness_shared.harness_prompt_overrides
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND role = ${role}
         LIMIT 1`;
      const md = rows?.[0]?.prompt_md;
      if (typeof md === 'string' && md.length > 0) return md;
    } catch {
      /* table absent / query error → fall through to the file-based resolver */
    }
  }
  return resolvePromptOverride(cfg, stateDir, role);
}

/**
 * Resolve the operator app's prompts directory. Walks up from the
 * orchestrator's cwd looking for `apps/operator/prompts`; honors the
 * `PAPERCUSP_OPERATOR_PROMPTS_DIR` env override.
 *
 * Returns `null` when not found — caller falls through to empty
 * playbook (no behavior change).
 */
export function resolveOperatorPromptsDir(): string | null {
  const envOverride = process.env.PAPERCUSP_OPERATOR_PROMPTS_DIR;
  if (envOverride && existsSync(envOverride)) return envOverride;
  // Walk up from cwd; stop at filesystem root.
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    const candidate = `${dir}/apps/operator/prompts`;
    if (existsSync(candidate)) return candidate;
    const parent = dir.replace(/\/[^/]+$/, '');
    if (parent === dir || parent === '') break;
    dir = parent;
  }
  return null;
}

/**
 * Locate apps/operator-docs/src/content/docs/agents/ for shared cross-role guides
 * (e.g. finding-context.mdx). Honors the
 * `PAPERCUSP_OPERATOR_DOCS_AGENTS_DIR` env override.
 *
 * Returns `null` when not found — caller falls through to empty
 * sharedGuides array (no behavior change).
 */
export function resolveOperatorDocsAgentsDir(): string | null {
  const envOverride = process.env.PAPERCUSP_OPERATOR_DOCS_AGENTS_DIR;
  if (envOverride && existsSync(envOverride)) return envOverride;
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    const candidate = `${dir}/apps/operator-docs/src/content/docs/agents`;
    if (existsSync(candidate)) return candidate;
    const parent = dir.replace(/\/[^/]+$/, '');
    if (parent === dir || parent === '') break;
    dir = parent;
  }
  return null;
}

/** Strip a leading YAML frontmatter block (--- ... ---) from MDX text. */
export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return raw;
  // Advance past the closing '---' and the newline after it.
  let i = end + 4;
  if (raw[i] === '\n') i += 1;
  return raw.slice(i);
}

/** Per-role timeout from config.json (in seconds). 0 = no timeout. */
export function resolveTimeout(cfg: ReturnType<typeof readConfig>, role: string): number {
  const t = configGet<unknown>(cfg, `timeouts.${role}`, 0);
  if (typeof t === 'number' && t > 0 && Number.isFinite(t)) return Math.floor(t);
  return 0;
}

/** Per-role model resolution. Per-harness `.papercusp/config.json` wins
    over the user-level `AGENT_MODELS` env var (which the operator's
    /settings/agent page writes), which in turn wins over the committed
    `ROLE_MODEL_DEFAULTS` floor. Empty string = use the agent CLI's
    default. */
export function resolveModel(cfg: ReturnType<typeof readConfig>, role: string): string {
  // aiBackend role override wins, then aiBackend default, then legacy models.<role>.
  const fromAiRole = configGet<string>(cfg, `aiBackend.roles.${role}.model`, '');
  if (fromAiRole) return fromAiRole;
  const fromAiDefault = configGet<string>(cfg, `aiBackend.default.model`, '');
  if (fromAiDefault) return fromAiDefault;
  const fromConfig = configGet<string>(cfg, `models.${role}`, '');
  if (fromConfig) return fromConfig;
  const envJson = process.env.AGENT_MODELS;
  if (envJson) {
    try {
      const map = JSON.parse(envJson);
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        const v = (map as Record<string, unknown>)[role];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    } catch { /* malformed AGENT_MODELS — silently ignore */ }
  }
  // Committed default floor (EI-7) — applies only when nothing above set a
  // model, so a load-bearing role (release-manager) can't silently downgrade
  // to the CLI default on a host without AGENT_MODELS.
  return ROLE_MODEL_DEFAULTS[role] ?? '';
}

/**
 * Resolve the agent command + extra args for a role, layering:
 *   1. config.aiBackend.roles[role]      (most specific)
 *   2. config.aiBackend.default          (harness-wide override)
 *   3. fallbackCmd                       (process env: AGENT_CMD/CLAUDE)
 *
 * Returns the effective agent command and any role/default extraArgs to
 * append (in order: default.extraArgs, then role.extraArgs). Model is
 * still resolved via {@link resolveModel} for back-compat with the
 * existing `models.<role>` config and AGENT_MODELS env.
 *
 * Storing secrets here is NOT supported — values land in plaintext
 * config.json. For secrets, use the encrypted-credentials store.
 */
export function resolveAgentForRole(
  cfg: ReturnType<typeof readConfig>,
  role: string,
  fallbackCmd: string,
): { agentCmd: string; extraArgs: string[] } {
  const ai = (cfg.aiBackend as
    | { default?: { agentCmd?: string; model?: string; extraArgs?: string[] };
        roles?: Record<string, { agentCmd?: string; model?: string; extraArgs?: string[] }>; }
    | undefined) ?? {};
  const def = ai.default ?? {};
  const rol = ai.roles?.[role] ?? {};

  const agentCmd =
    (rol.agentCmd && rol.agentCmd.trim()) ||
    (def.agentCmd && def.agentCmd.trim()) ||
    fallbackCmd;

  const extraArgs: string[] = [];
  if (Array.isArray(def.extraArgs)) extraArgs.push(...def.extraArgs.filter((s) => typeof s === 'string'));
  if (Array.isArray(rol.extraArgs)) extraArgs.push(...rol.extraArgs.filter((s) => typeof s === 'string'));

  return { agentCmd, extraArgs };
}

/**
 * What kind of structured stream the spawned agent is emitting (or `none` for
 * plain-text / passthrough commands). Drives both the extra flag set we
 * append AND the result-extraction parser.
 */
export type StreamFormat = 'claude-stream-json' | 'omp-json' | 'codex-json' | 'none';

/**
 * Pick the structured-output flag set for a given backend, unless the
 * caller's command already specifies one (so manual overrides are
 * preserved). Returns `'none'` when the command is bare bash or similar
 * and we shouldn't inject anything.
 */
export function selectStreamFormat(
  agentBackend: AgentBackend,
  agentCmd: string,
): StreamFormat {
  const argv = splitCommand(agentCmd);
  const cmd = agentCmd.toLowerCase();

  if (agentBackend === 'omp') {
    // omp/pi-coding-agent uses `--mode json` for structured streaming.
    if (cmd.includes('--mode ')) return 'none';   // user picked their own mode
    const mentionsOmp = argv.some((a) => /(?:^|\/)(omp|pi)$/.test(a));
    return mentionsOmp ? 'omp-json' : 'none';
  }

  if (agentBackend === 'codex') {
    // codex CLI: `codex exec --json` emits JSONL events. If the command
    // already names the `exec` subcommand the user is driving it manually.
    if (/(?:^|\s)exec(?:\s|$)/.test(cmd)) return 'none';
    const mentionsCodex = argv.some((a) => /(?:^|\/)codex$/.test(a));
    return mentionsCodex ? 'codex-json' : 'none';
  }

  // claude-code path (default).
  if (cmd.includes('stream-json')) return 'none';
  const mentionsClaude = argv.some((a) => a.includes('claude'));
  return mentionsClaude ? 'claude-stream-json' : 'none';
}

/**
 * Extra CLI flags to append for structured streaming. Decoupled from
 * `selectStreamFormat` so callers can log/test the flag list directly.
 */
export function streamFormatFlags(fmt: StreamFormat): string[] {
  switch (fmt) {
    case 'claude-stream-json':
      return ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    case 'omp-json':
      return ['--mode', 'json', '--no-session'];
    case 'codex-json':
      // `codex exec --json` → JSONL events. `--skip-git-repo-check` lets it run
      // in non-repo cwds; `--ephemeral` keeps no rollout on disk. The sandbox
      // policy (`-s …`) is decided separately by codexSandboxArgs (flag-gated),
      // appended to extraFlags BEFORE the `-` stdin positional. Model (`-m`),
      // the prompt stdin `-`, and CODEX_HOME/MCP are wired in the spawn path.
      return ['exec', '--json', '--skip-git-repo-check', '--ephemeral'];
    case 'none':
      return [];
  }
}

/**
 * The closed allow-list a headless fleet agent runs under
 * (`--permission-mode dontAsk`). `mcp__papercusp` is a *server wildcard*:
 * the per-spawn signed `.mcp.json` is already role-scoped server-side —
 * surface-filtered by `listMcpProjections(role)` AND denied at call-time by
 * the dispatch stack's `role-allowlist` step — so the wildcard grants
 * exactly that role's MCP surface without us enumerating (or drifting from)
 * it. The rest is the safe built-in dev kit every pipeline role needs.
 *
 * `dontAsk` denies a *gated* tool that isn't allow-listed (verified vs
 * claude 2.1.158: an un-allow-listed gated tool — arbitrary `Bash`, file
 * writes, `Workflow`, a non-role MCP call — is denied, the model is told,
 * and it continues; no hang). But gating is NOT uniform: claude exempts a
 * class of session-local / "meta" tools from the allow-list entirely, so
 * omitting them does NOT block them (verified: with this exact allow-list,
 * `CronCreate` still created a job and `EnterWorktree` still ran). Those
 * dangerous-but-exempt tools are closed via FLEET_DISALLOWED_TOOLS instead
 * — the allow-list alone is not a complete boundary. (The old setting was a
 * blanket `--permission-mode bypassPermissions`, under which everything ran.)
 */
export const FLEET_ALLOWED_TOOLS: readonly string[] = [
  'mcp__papercusp',
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
];

/**
 * Hard denies layered on top of the allow-list. `--disallowed-tools` removes
 * a tool from the spawn ENTIRELY — it wins over the allow-list, over the
 * dontAsk exemption, and even under `bypassPermissions` (all verified vs
 * claude 2.1.158: a denied tool reports "No such tool exists in this
 * environment"). Two jobs:
 *
 * 1. **Dangerous *exempt* tools** — the automation/scheduling/spawn/remote
 *    built-ins a `claude -p` spawn carries that bypass the allow-list under
 *    dontAsk (see FLEET_ALLOWED_TOOLS). None are needed by a pipeline role;
 *    `EnterWorktree`/`ExitWorktree` would also violate the repo's
 *    one-tree/no-worktree rule, and `Workflow`/`Task` are uncontrolled
 *    sub-agent fan-out outside the orchestrator's spawn graph.
 * 2. **Dangerous *commands* inside the granted `Bash`** — `Bash` is
 *    allow-listed (roles need it) and can run anything, so the highest-value,
 *    no-legit-fleet-use commands are denied here.
 *
 * Defense-in-depth, NOT airtight containment, and the code must not pretend
 * otherwise:
 *   - `git push` is *primarily* blocked by the repo's pre-push hook —
 *     command-string matching is evadable (`git -C … push`, aliases,
 *     `&& git push`). This deny is the backstop.
 *   - credential reads (the allow-listed `Read` tool reaches any path) and
 *     network egress (the allow-listed `WebFetch`) are NOT closed here;
 *     true containment of those needs a network/fs sandbox — tracked as a
 *     follow-up, not solved by a deny-list.
 */
export const FLEET_DISALLOWED_TOOLS: readonly string[] = [
  // Dangerous built-ins that bypass the allow-list under dontAsk.
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
  'Workflow',
  'Task',
  'RemoteTrigger',
  'PushNotification',
  'Monitor',
  // Dangerous commands within the (allow-listed) Bash tool.
  'Bash(sudo:*)',
  'Bash(git push:*)',
];

/**
 * Roles whose prompts **explicitly forbid the `Write`/`Edit` tools** — they
 * are API/MCP-only (their output goes through the operator, not the working
 * tree). For these we drop `Edit`/`Write` from the allow-list, mechanically
 * enforcing the instruction the prompt already gives (resists a model that
 * ignores it, e.g. via prompt-injection).
 *
 * (Currently empty — the former `expert`/`feedback` API-only roles were removed.)
 *
 * This is the ONLY per-role built-in tightening that's verifiably safe from a
 * prompt read: other review/gate roles (reviewer, validator, infra-reviewer,
 * …) DO write legitimate output via the `Write` tool (review files,
 * infra-contract.json), so denying it would break them.
 * NOTE it's a defense-in-depth nudge, not a hard boundary: `Bash` is still
 * granted (these roles curl/run things), so a determined spawn could write via
 * a shell redirect — closing that needs a sandbox, not an allow-list. Further
 * per-role cuts should be gated on a real fleet-spawn run, not a prompt read.
 */
export const FLEET_NO_WRITE_ROLES: ReadonlySet<string> = new Set<string>([]);

/**
 * The allow-list for a given fleet role: the full safe kit
 * (`FLEET_ALLOWED_TOOLS`), minus `Edit`/`Write` for the API-only roles in
 * `FLEET_NO_WRITE_ROLES`. An unknown/empty role gets the full kit — never
 * silently strip a tool from a role we don't recognise.
 */
export function fleetAllowedToolsForRole(role: string | undefined): string[] {
  if (role && FLEET_NO_WRITE_ROLES.has(role)) {
    return FLEET_ALLOWED_TOOLS.filter((t) => t !== 'Edit' && t !== 'Write');
  }
  return [...FLEET_ALLOWED_TOOLS];
}

/* ─── Fleet OS sandbox (plan fleet-spawn-sandbox-2026-06-01) ─────────────────
 * DEFAULT-ON (P-013/D-015); opt out with PAPERCUSP_FLEET_SANDBOX=0. Closes the
 * gaps the tool whitelist CANNOT: credential reads + network egress. Uses
 * claude-code's OWN built-in
 * sandbox (Linux bubblewrap + socat proxy; macOS Seatbelt) injected via
 * `--settings`, NOT a hand-rolled wrapper. Verified vs claude 2.1.159: the
 * sandbox engages headlessly, composes with `--permission-mode dontAsk`, hides
 * denyRead paths, confines writes to cwd, and blocks egress to unlisted hosts.
 * ──────────────────────────────────────────────────────────────────────── */

/** Credential dirs hidden from the sandboxed Bash subprocess (`denyRead`). */
export const FLEET_SANDBOX_DENY_READ: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.config/gcloud',
  '~/.papercusp',
  '~/.npmrc',
];

/**
 * Domains a sandboxed Bash command may reach — the package registries a build/
 * test role legitimately needs. Verified (P-012/D-011): claude's sandbox egress
 * allowlist works (`curl registry.npmjs.org` → 200, `curl example.com` → 000).
 * Deny-all (`[]`) was the original floor but it breaks any role that runs
 * `npm/pip/cargo install` — so this is the functional default for the (now
 * default-on) sandbox. The agent's own model + MCP connections are OUTSIDE the sandbox and
 * unaffected; this list only governs what a sandboxed Bash *command* can fetch.
 *
 * Tradeoff (D-005): every domain here is reachable with TLS UNINSPECTED, so it
 * widens a potential exfil channel. Kept to package registries + the few common
 * toolchain CDNs a default-on fleet hits out-of-box — Playwright browsers
 * (`cdn.playwright.dev` + the `playwright.download.prss.microsoft.com` fallback)
 * and node-gyp headers (`nodejs.org`), added for default-on (P-013/D-015) after
 * the real fleet pass (D-013) showed `npx playwright install` / native-addon
 * builds blocked. A security-hardened deployment strips ALL of these with
 * `PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS=1`. Per-role narrowing (read-only
 * roles need none) is a future refinement.
 *
 * DEPLOYMENT-EXTENSIBLE (the no-fork widening path — the enabler for default-on,
 * D-012): the effective list is resolved at spawn time by
 * `resolveFleetAllowedDomains()`, which layers two env knobs over this base so a
 * deployment whose toolchain needs a non-registry host (a private registry, a
 * Playwright/Cypress browser CDN, an internal mirror) can adjust WITHOUT editing
 * code — exactly the breakage axis a per-project default-on must absorb:
 *   • `PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS` — comma/space-separated extra
 *     hosts APPENDED to this base (deduped).
 *   • `PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS=1` — lockdown: ignore the base +
 *     the append var and emit `[]` (a security-hardened deployment blocks ALL
 *     sandboxed-Bash egress). Wins over the append var.
 */
export const FLEET_SANDBOX_ALLOWED_DOMAINS: readonly string[] = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  // Common toolchain CDNs a default-on fleet needs out-of-box (P-013/D-015):
  'cdn.playwright.dev', // Playwright browser binaries (primary)
  'playwright.download.prss.microsoft.com', // Playwright browser binaries (fallback)
  'nodejs.org', // node-gyp headers for native addons
];

/**
 * Resolve the effective sandboxed-Bash egress allowlist for this spawn: the
 * `FLEET_SANDBOX_ALLOWED_DOMAINS` base plus any deployment additions, or `[]`
 * under lockdown. See the const docstring for the two env knobs. This is the
 * no-fork widening path that lets a default-on sandbox absorb a project whose
 * build/test toolchain reaches a host outside the registry defaults, instead of
 * that role's Bash step failing with an opaque egress block. Resolved from the
 * trusted orchestrator env, never from agent-supplied tool input.
 */
export function resolveFleetAllowedDomains(): string[] {
  const lockdown = process.env.PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS;
  if (lockdown === '1' || lockdown === 'true') return [];
  const extra = (process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS ?? '')
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  return [...new Set([...FLEET_SANDBOX_ALLOWED_DOMAINS, ...extra])];
}

/**
 * Root for the fleet sandbox's redirected package-manager caches. The sandbox
 * makes everything outside cwd read-only (allowWrite is cwd + this dir), but
 * npm/pip/cargo write their caches under $HOME (e.g. ~/.npm/_cacache) — so a
 * real `npm install` under the sandbox fails EROFS (verified P-014/D-013: the
 * registry was REACHED, the cache write was denied). Rather than weaken
 * containment by leaving $HOME writable, we add THIS one dedicated dir to
 * `allowWrite` and point each ecosystem's cache env at a per-project subdir of
 * it (see fleetSandboxCacheEnv). NOT under `~/.papercusp` (which is denyRead).
 * Computed from the operator process home so it matches the absolute cache-env
 * paths even when the child gets a per-spawn HOME (resolveSpawnHome).
 */
export const FLEET_SANDBOX_CACHE_ROOT = join(homedir(), '.cache', 'papercusp-fleet-sandbox');

/**
 * Cache-redirect env for a sandboxed spawn whose project lives at `cwd`. Points
 * npm/yarn/pip/cargo/go + the generic XDG cache at a per-project subdir of
 * FLEET_SANDBOX_CACHE_ROOT (which is allow-listed for writes). Per-project
 * keying (a short hash of cwd) keeps one project's build from poisoning
 * another's cache. Absolute paths, so they're independent of the child's HOME.
 * The caller mkdir -p's the dirs; only applied when the sandbox is enabled.
 */
export function fleetSandboxCacheEnv(cwd: string): Record<string, string> {
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  const base = join(FLEET_SANDBOX_CACHE_ROOT, key);
  return {
    npm_config_cache: join(base, 'npm'),
    YARN_CACHE_FOLDER: join(base, 'yarn'),
    PIP_CACHE_DIR: join(base, 'pip'),
    CARGO_HOME: join(base, 'cargo'),
    GOCACHE: join(base, 'go-build'),
    GOMODCACHE: join(base, 'go-mod'),
    // Catch-all: many tools honor XDG (~/.cache → here), incl. pip + Playwright.
    XDG_CACHE_HOME: join(base, 'xdg'),
  };
}

/**
 * `Read`/`Edit` permission DENY rules for the credential paths. Required
 * because claude's sandbox covers `Bash` + children only — the `Read`/`Edit`
 * TOOLS bypass it (they go through the permission system), and the default
 * read policy still allows `~/.ssh` / `~/.aws/credentials`. Path syntax is the
 * permission-rule form (`~/` for home), distinct from the sandbox `denyRead`.
 */
export const FLEET_SANDBOX_DENY_RULES: readonly string[] = [
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.gnupg/**)',
  'Read(~/.config/gcloud/**)',
  'Read(~/.papercusp/**)',
  'Edit(~/.ssh/**)',
  'Edit(~/.aws/**)',
  'Edit(~/.papercusp/**)',
];

/**
 * True when the fleet OS sandbox should engage. DEFAULT-ON (P-013/D-015): the
 * real fleet pass (D-013) confirmed MCP survives the sandbox, the egress
 * allowlist covers the common toolchains, and the `npm install` EROFS is fixed
 * (P-014) — so claude-code fleet spawns are sandboxed by default. Opt OUT with
 * `PAPERCUSP_FLEET_SANDBOX=0` (or `false`/`off`) — e.g. a deployment whose host
 * lacks bubblewrap, since the sandbox is `failIfUnavailable:true` (claude-code
 * only; codex/omp are unaffected — D-009/D-010). Read per-spawn, so the default
 * takes effect on the next operator restart (the :3070 host has no hot-reload).
 */
export function fleetSandboxEnabled(): boolean {
  const v = (process.env.PAPERCUSP_FLEET_SANDBOX ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/**
 * The sandbox settings claude-code consumes, **decided per role by trusted
 * orchestrator code** (this runs inside `invoke()`, never from agent-supplied
 * tool input — an agent must not be able to choose/weaken its child's sandbox).
 *
 * `role` is the per-role decision seat. The POLICY is uniform today —
 * credential protection (`denyRead` + Read/Edit deny rules) and deny-all egress,
 * which every role needs and none should escape. Two per-role facts verified
 * against claude 2.1.159 (P-004) shape what varies and what can't:
 *
 *  - Per-role WRITE tightening is NOT achievable via the sandbox: the cwd is
 *    ALWAYS writable (`allowWrite` only *adds* paths beyond cwd; `denyWrite`
 *    of the cwd didn't reliably block either). So write-discipline per role
 *    stays at the allowed-tools layer (via FLEET_NO_WRITE_ROLES, currently
 *    empty); the residual Bash-escape is a known, documented limit.
 *  - Per-role EGRESS *is* the achievable axis (e.g. a read-only review role
 *    does web research and would need an allowlist, while a worker needs none) — that's
 *    where `role` will branch. Today the egress floor is the registry allowlist
 *    `resolveFleetAllowedDomains()` (base + the deployment env knobs, D-012),
 *    uniform across roles; the exact per-role narrowing still wants the
 *    real-spawn verification pass (P-012).
 */
export function fleetSandboxSettingsForRole(role: string | undefined): Record<string, unknown> {
  // role: reserved for per-role egress policy (P-012). Uniform floor today; see docstring.
  void role;
  return {
    sandbox: {
      enabled: true,
      // Default-on (P-013) → if deps (bubblewrap/socat) are missing, fail loudly
      // rather than silently run unsandboxed. A host without bwrap opts out
      // explicitly with PAPERCUSP_FLEET_SANDBOX=0 (don't weaken the guarantee by
      // degrading to unsandboxed by default). claude-code only; codex/omp are
      // unaffected (D-009/D-010).
      failIfUnavailable: true,
      // Strict: no `dangerouslyDisableSandbox` retry-outside-the-sandbox escape hatch.
      allowUnsandboxedCommands: false,
      // cwd is always writable in claude's sandbox; this allowWrite is the
      // explicit (no-extra-paths) form of that default.
      // cwd + the allow-listed package-manager cache root (FLEET_SANDBOX_CACHE_ROOT):
      // without the latter a real `npm/pip/cargo install` fails EROFS, since those
      // caches live under $HOME which the sandbox makes read-only (D-013/P-014).
      filesystem: { allowWrite: ['.', FLEET_SANDBOX_CACHE_ROOT], denyRead: [...FLEET_SANDBOX_DENY_READ] },
      network: { allowedDomains: resolveFleetAllowedDomains() },
    },
    // Read/Edit tool deny rules — the sandbox does NOT cover these tools (D-004).
    permissions: { deny: [...FLEET_SANDBOX_DENY_RULES] },
  };
}

/* ─── G4 / P-011: spawn-env least-privilege (plan papercusp-user-protection-gate
 * 2026-05-31) ────────────────────────────────────────────────────────────────
 * The spawned agent CLI (claude/omp/codex) reaches EVERY privileged surface via
 * the SIGNED MCP HTTP endpoint (:3070) — never via a direct PG connection — so
 * it does not need the operator's admin PG creds or the key that decrypts
 * `operator_secrets`. Yet the merged `spawnEnv` (`...process.env` +
 * `ctx.extraSpawnEnv` + `options.extraEnv`) hands every child the full operator
 * env. `scopeSpawnEnvForRole` removes the secrets the child can't use, so a
 * fooled/compromised agent — or one executing a feature the auditor (G2)
 * mis-admitted — can't read admin PG creds or the decryption key straight out of
 * its environment (D-007: G4 is the damage-bound backstop to the auditor).
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Operator-internal secrets removed from EVERY spawned agent-CLI child env: the
 * admin Postgres DSNs and the key that decrypts `operator_secrets`. The agent
 * CLI authenticates to all privileged surfaces through the signed MCP HTTP
 * endpoint, so it never reads these directly — only the trusted orchestrator
 * (`invoke()` / `invoke-once`) needs them, and they stay in ITS `process.env`
 * because this helper scopes the CHILD `spawnEnv` only, not `process.env`.
 *  - `DATABASE_URL` / `PAPERCUSP_PG_DSN` — admin PG connection strings.
 *  - `PAPERCUSP_DB_ENCRYPTION_KEY` — decrypts the `operator_secrets` /
 *    search-provider-credentials store (see spawn-env-from-pg.ts).
 */
export const SPAWN_ENV_ALL_ROLES_STRIP: readonly string[] = [
  'DATABASE_URL',
  'PAPERCUSP_PG_DSN',
  'PAPERCUSP_DB_ENCRYPTION_KEY',
];

/**
 * Decrypted search-provider API-key env names that OMP's `web_search` providers
 * consume. SOURCE OF TRUTH: `apps/operator/lib/search-provider-credentials.ts`
 * `SEARCH_PROVIDERS` (each provider's `primary` + `alternates` + the SearXNG
 * `fields`). Mirrored here (a small, stable list) because the orchestrator
 * package can't import from `apps/operator` — wrong dependency direction.
 * **Keep in sync** with that file; the unit test
 * `SEARCH_PROVIDER_ENV_KEYS — mirrors …` pins the names so a drift is caught.
 *
 * These are stripped for the AUDITOR only (a read-only judge with no
 * `web_search` and no tools beyond read). NOTE several of these names
 * (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `CODEX_API_KEY`) could in principle be
 * a backend's API auth — but the fleet's agent backends authenticate via
 * session/OAuth FILES, NOT an API-key env: claude → `~/.claude` (per-spawn HOME
 * via `resolveSpawnHome`); codex → `~/.codex/auth.json` symlinked into the
 * per-spawn `CODEX_HOME` (`writeSignedSpawnCodexHome`); omp → the Meridian
 * Claude-Code-SDK bridge. So NO key here is load-bearing for backend auth, and
 * stripping them all still lets the auditor run + emit a verdict.
 */
export const SEARCH_PROVIDER_ENV_KEYS: readonly string[] = [
  'TAVILY_API_KEY',
  'PERPLEXITY_API_KEY',
  'PPLX_API_KEY',
  'BRAVE_API_KEY',
  'JINA_API_KEY',
  'MOONSHOT_SEARCH_API_KEY',
  'KIMI_SEARCH_API_KEY',
  'MOONSHOT_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'CODEX_API_KEY',
  'ZAI_API_KEY',
  'EXA_API_KEY',
  'PARALLEL_API_KEY',
  'KAGI_API_KEY',
  'SYNTHETIC_API_KEY',
  'SEARXNG_ENDPOINT',
  'SEARXNG_TOKEN',
  'SEARXNG_BASIC_USERNAME',
  'SEARXNG_BASIC_PASSWORD',
];

/**
 * Return a COPY of `env` with the secrets a spawned agent-CLI child of `role`
 * does not need removed (never mutates the input). Decided by trusted
 * orchestrator code, never from agent-supplied input.
 *
 *  - ALL roles lose the operator-internal PG/DB secrets
 *    (`SPAWN_ENV_ALL_ROLES_STRIP`) — the child uses the signed MCP endpoint.
 *  - The `auditor` role ADDITIONALLY loses every decrypted search-provider API
 *    key (`SEARCH_PROVIDER_ENV_KEYS`) — it is a read-only judge with no
 *    `web_search`. Backend auth is session/OAuth-file based, so no key here is
 *    needed for the auditor to run (see SEARCH_PROVIDER_ENV_KEYS).
 *
 * Applied to the merged `spawnEnv` BEFORE the post-merge env mutations
 * (`OMP_*`/`PI_*` memory flags, `resolveSpawnHome` → HOME/USERPROFILE,
 * `gitConfigNoPushEnv`, the per-spawn `CODEX_HOME`/`.mcp.json` and sandbox
 * cache-redirect), so HOME, the git-no-push config, and the MCP/cache env added
 * afterward survive — none of those are secrets this strips.
 */
export function scopeSpawnEnvForRole(env: NodeJS.ProcessEnv, role: string): NodeJS.ProcessEnv {
  const scoped: NodeJS.ProcessEnv = { ...env };
  for (const k of SPAWN_ENV_ALL_ROLES_STRIP) delete scoped[k];
  if (role === 'auditor') {
    for (const k of SEARCH_PROVIDER_ENV_KEYS) delete scoped[k];
  }
  return scoped;
}

/**
 * `--settings <inline JSON>` carrying the per-role fleet OS sandbox, appended
 * to a claude-code spawn when PAPERCUSP_FLEET_SANDBOX is set. The policy is
 * resolved from the trusted `role` (see fleetSandboxSettingsForRole). Returns
 * `[]` unless enabled + claude-code + claude stream + a workspace, or when the
 * user already passed their own `--settings` in AGENT_CMD (we defer to them).
 */
export function claudeSandboxArgs(
  agentBackend: AgentBackend,
  streamFormat: StreamFormat,
  roleAgentCmd: string,
  hasWorkspace: boolean,
  enabled: boolean,
  role: string,
): string[] {
  if (
    !enabled ||
    agentBackend !== 'claude-code' ||
    streamFormat !== 'claude-stream-json' ||
    !hasWorkspace ||
    roleAgentCmd.includes('--settings')
  ) {
    return [];
  }
  return ['--settings', JSON.stringify(fleetSandboxSettingsForRole(role))];
}

/**
 * codex's sandbox flags. **codex is NOT sandboxable for the fleet** — verified
 * vs codex on this box (P-012, D-009) and RE-VERIFIED on codex-cli 0.135 (D-016):
 * under `-s workspace-write` (and `read-only`) codex CANCELS MCP tool calls
 * ("user cancelled MCP tool call", client-side — never reaches the server),
 * while the same call REACHES the server under the bypass. A sandboxed codex
 * worker is therefore tool-less, which breaks the MCP-dependent fleet. So codex
 * always runs under `-s danger-full-access --dangerously-bypass-approvals-and-
 * sandbox` REGARDLESS of PAPERCUSP_FLEET_SANDBOX — the flag deliberately does
 * not switch codex to workspace-write (that would silently disable its tools).
 *
 * (workspace-write *does* confine writes + block command egress — but the MCP
 * cancellation makes it unusable here. RULED OUT (D-016): `network_access=true`
 * does NOT help — the cancel is a codex policy gating MCP under any sandbox, not
 * an egress block; and codex 0.135 has no auto-approve/MCP-trust knob — the only
 * approval-bypass is bundled with sandbox-bypass. Revisit if codex gains
 * MCP-under-sandbox support. claude is sandboxed because its sandbox covers only
 * sub-commands, leaving the agent's own MCP connection intact; codex differs.)
 *
 * CONTAINMENT FOR codex now comes from an EXTERNAL wrap, NOT its native sandbox:
 * under PAPERCUSP_FLEET_SANDBOX the codex spawn is wrapped in `srt`
 * (wrapSpawnWithSrt at the spawn site, P-017/D-017) while keeping the bypass
 * here — so MCP works AND shell commands are confined. This function's job is
 * just to keep codex's OWN sandbox off (the bypass); srt does the confining.
 *
 * Appended to `extraFlags` before the `-` stdin positional. Defers to a
 * user-set `-s`/`--sandbox`/bypass in AGENT_CMD. `enabled` is intentionally
 * unused: codex's NATIVE posture does not depend on the fleet-sandbox flag
 * (the flag drives the external srt-wrap instead).
 */
export function codexSandboxArgs(
  agentBackend: AgentBackend,
  streamFormat: StreamFormat,
  roleAgentCmd: string,
  enabled: boolean,
): string[] {
  void enabled; // codex can't be sandboxed (MCP cancellation) — see docstring.
  if (agentBackend !== 'codex' || streamFormat !== 'codex-json') return [];
  // Defer to a user-chosen sandbox/bypass posture in AGENT_CMD.
  if (
    /(?:^|\s)-s\s/.test(roleAgentCmd) ||
    roleAgentCmd.includes('--sandbox') ||
    roleAgentCmd.includes('--dangerously-bypass-approvals-and-sandbox')
  ) {
    return [];
  }
  return ['-s', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox'];
}

/* ─── External srt-wrap — codex containment (plan fleet-spawn-sandbox, P-017/D-017) ──
 * codex's NATIVE sandbox cancels MCP (D-009/D-016), so codex can't self-sandbox.
 * The way around (verified end-to-end, D-017): run codex with its native sandbox
 * OFF (codexSandboxArgs keeps `--dangerously-bypass-approvals-and-sandbox`, so
 * MCP is NOT cancelled) and wrap the WHOLE codex process in `srt`
 * (@anthropic-ai/sandbox-runtime: bubblewrap `--unshare-net` + a host-side
 * allowlisting proxy). srt then confines codex's shell commands (writes →
 * cwd+cache, egress → allowlist, creds hidden) while codex's MCP + model traffic
 * is allow-listed THROUGH srt's proxy. Crucial detail: srt injects a `no_proxy`
 * that excludes loopback + RFC1918, which would route the operator MCP DIRECTLY
 * into the isolated netns (unreachable) — so the wrap clears `no_proxy` inside
 * the srt shell, sending operator + model traffic through srt's proxy instead.
 *
 * omp (no native sandbox at all) uses the SAME wrap (D-018/D-019): omp's model
 * + MCP are loopback on this box (ollama / the meridian bridge) — the same
 * loopback-through-srt's-proxy transport proven for codex — so its egress
 * allowlist is the operator + localhost + registries (a cloud-model omp adds its
 * host via PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS). Its writable agent dirs
 * (`~/.omp` + PI_CODING_AGENT_DIR = `<project>/.papercusp/pi-sessions`, which holds
 * omp's agent/auth/models SQLite DBs) are added to allowWrite. Verified under
 * srt: omp starts cleanly + reaches its model (the residual omp↔ollama
 * tool-schema 400 is an omp bug, present with or without srt — NOT a containment
 * gap). claude uses its own `--settings` sandbox, not srt.
 * ──────────────────────────────────────────────────────────────────────── */

/** `srt` binary path (the egress+fs sandbox wrapper) if on PATH, else null. */
export function srtBinOnPath(): string | null {
  for (const d of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const p = join(d, 'srt');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Model-endpoint hosts the wrapped agent process must reach THROUGH srt's proxy.
 * codex (ChatGPT auth) talks to the OpenAI API + auth hosts. omp returns `[]`:
 * on this box its model is loopback (ollama :11434 / the meridian bridge :3456),
 * already covered by the `localhost`/`127.0.0.1` entries in buildFleetSrtSettings;
 * a deployment that points omp at a CLOUD model adds that host via
 * `PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS` (omp's provider is deployment-set,
 * so there's no single stable host to hardcode like codex's OpenAI).
 */
export function fleetSrtModelDomains(backend: AgentBackend): string[] {
  if (backend === 'codex') {
    return ['api.openai.com', 'chatgpt.com', 'auth.openai.com', '*.openai.com'];
  }
  return [];
}

/**
 * srt settings for an externally-wrapped agent spawn. Confines the WHOLE agent
 * process: writes → cwd + the pkg-cache root + the backend's own agent dirs
 * (`agentHomes` — codex's CODEX_HOME; omp's `~/.omp` + PI_CODING_AGENT_DIR);
 * egress → the operator (localhost/127.0.0.1) + the model endpoints + the
 * package registries/CDNs (resolveFleetAllowedDomains); credential dirs hidden
 * via `denyRead`, with `allowRead` re-permitting any agentHome that sits under a
 * denied dir (codex's CODEX_HOME lives under `~/.papercusp`, verified D-017). srt
 * schema: filesystem {allowWrite, denyWrite, denyRead, allowRead}.
 */
export function buildFleetSrtSettings(opts: {
  cwd: string;
  backend: AgentBackend;
  agentHomes?: string[];
}): Record<string, unknown> {
  const home = homedir();
  const abs = (p: string) => (p.startsWith('~/') ? join(home, p.slice(2)) : p);
  const denyRead = FLEET_SANDBOX_DENY_READ.map(abs);
  const homes = (opts.agentHomes ?? []).filter(Boolean).map(abs);
  const allowWrite = [opts.cwd, FLEET_SANDBOX_CACHE_ROOT, ...homes];
  // Re-allow reading any agent home that's under a denyRead dir (codex
  // CODEX_HOME is under ~/.papercusp) so the agent can load its config + auth.
  const allowRead = homes.filter((h) => denyRead.some((d) => h.startsWith(d)));
  return {
    network: {
      allowedDomains: [
        ...resolveFleetAllowedDomains(),
        ...fleetSrtModelDomains(opts.backend),
        'localhost',
        '127.0.0.1',
      ],
      deniedDomains: [],
    },
    filesystem: {
      allowWrite,
      denyWrite: [],
      denyRead,
      ...(allowRead.length ? { allowRead } : {}),
    },
  };
}

/** Write per-spawn srt settings to a 0600 temp file; returns its path. */
export function writeFleetSrtSettings(opts: {
  cwd: string;
  backend: AgentBackend;
  agentHomes?: string[];
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-fleet-srt-'));
  const path = join(dir, 'srt-settings.json');
  writeFileSync(path, JSON.stringify(buildFleetSrtSettings(opts)), { mode: 0o600 });
  return path;
}

/** Single-quote shell-escape each arg into one `sh -c`-safe string. */
function shQuote(parts: string[]): string {
  return parts.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
}

/** Backends wrapped in srt (no usable/any native sandbox): codex + omp. */
export function backendUsesSrt(backend: AgentBackend): boolean {
  return backend === 'codex' || backend === 'omp';
}

/**
 * Wrap a codex/omp spawn in `srt` (P-017/D-017 codex, D-018/D-019 omp). Returns
 * the command unchanged for claude-code (its own `--settings` sandbox) or when
 * disabled / srt absent. The wrapped form runs the agent via
 * `srt -s <settings> -c 'export no_proxy=… ; exec <agent …>'` so `no_proxy` is
 * cleared INSIDE the sandbox (srt injects its own otherwise) — letting the
 * operator MCP + model route through srt's proxy. The prompt arrives via the
 * agent's own channel (codex's trailing stdin `-`; omp's `@promptfile` arg),
 * inherited through the exec.
 */
export function wrapSpawnWithSrt(
  command: string,
  argv: string[],
  opts: { enabled: boolean; backend: AgentBackend; srtBin: string | null; settingsPath: string | null },
): { command: string; argv: string[] } {
  if (!opts.enabled || !backendUsesSrt(opts.backend) || !opts.srtBin || !opts.settingsPath) {
    return { command, argv };
  }
  const inner = `export no_proxy='' NO_PROXY=''; exec ${shQuote([command, ...argv])}`;
  return { command: opts.srtBin, argv: ['-s', opts.settingsPath, '-c', inner] };
}

/**
 * Extra CLI args that make claude-code load + trust the per-spawn signed
 * `.mcp.json` AND run under a closed, per-role whitelist instead of
 * unrestricted.
 *
 * omp path-discovers `<cwd>/.mcp.json` and connects automatically.
 * claude-code does NOT: it treats a project `.mcp.json` as "pending
 * approval" and, in headless `-p` mode (no way to approve), never connects
 * to it (verified against claude 2.1.158 — `claude mcp get` reports
 * unapproved `.mcp.json` servers as "⏸ Pending approval and not connected
 * to"). `--mcp-config <path>` loads AND trusts the file directly (bypassing
 * the approval gate); `--strict-mcp-config` restricts the worker to ONLY
 * that server, not the engineer's personal `~/.claude.json` fleet.
 *
 * `--permission-mode dontAsk` + `--allowed-tools <whitelist>` is the
 * permission posture: dontAsk pre-approves the allow-listed tools (no prompt,
 * no hang) and hard-denies everything else in headless mode — a true
 * default-deny whitelist (verified vs claude 2.1.158; note `default` mode
 * sandboxes even allow-listed writes, `dontAsk` does not, which is why we
 * use dontAsk and not default). `--disallowed-tools` adds the Bash
 * command-pattern backstop. See FLEET_ALLOWED_TOOLS / FLEET_DISALLOWED_TOOLS.
 *
 * Returns `[]` for any non-claude backend, a non-claude stream, or when no
 * workspace is set (the `.mcp.json` is only written when `ctx.workspaceId`
 * is present). If the user manages MCP loading or the permission posture
 * themselves in AGENT_CMD, we defer to them for that part.
 */
export function claudeMcpArgs(
  agentBackend: AgentBackend,
  streamFormat: StreamFormat,
  roleAgentCmd: string,
  mcpConfigPath: string,
  hasWorkspace: boolean,
  role: string,
): string[] {
  if (
    agentBackend !== 'claude-code' ||
    streamFormat !== 'claude-stream-json' ||
    !hasWorkspace
  ) {
    return [];
  }
  const out: string[] = [];
  if (!roleAgentCmd.includes('--mcp-config')) {
    out.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
  }
  // The permission posture is a unit (mode + allow-list + deny-list). If the
  // user set ANY permission-related flag in AGENT_CMD, they're managing it
  // themselves — don't half-apply ours on top (which could contradict
  // theirs). Otherwise impose the closed whitelist.
  const userManagesPermissions =
    roleAgentCmd.includes('--permission-mode') ||
    roleAgentCmd.includes('--allowed-tools') ||
    roleAgentCmd.includes('--allowedTools') ||
    roleAgentCmd.includes('--disallowed-tools') ||
    roleAgentCmd.includes('--disallowedTools') ||
    roleAgentCmd.includes('--dangerously-skip-permissions') ||
    roleAgentCmd.includes('--allow-dangerously-skip-permissions');
  if (!userManagesPermissions) {
    out.push('--permission-mode', 'dontAsk');
    // Allow-list as one space-joined value (claude splits it); deny patterns
    // as separate argv elements so each pattern's internal spaces (e.g.
    // `Bash(git push:*)`) survive. Both forms verified against claude 2.1.158.
    out.push('--allowed-tools', fleetAllowedToolsForRole(role).join(' '));
    out.push('--disallowed-tools', ...FLEET_DISALLOWED_TOOLS);
  }
  return out;
}

/**
 * The fleet pre-push hook body. Installed per-spawn via a spawn-env-only
 * `core.hooksPath` override (see `gitConfigNoPushEnv`), so it fires ONLY for
 * orchestrator-spawned agents — the shared checkout's config and the
 * user's / other agents' pushes are untouched. Unconditional block: the repo
 * invariant is "agents don't push" (integration is the orchestrator's job).
 * This is the real no-push enforcement; the `Bash(git push:*)` deny in
 * FLEET_DISALLOWED_TOOLS is an evadable backstop (`git -C … push`, aliases,
 * `&& git push` slip past command-string matching — this hook does not).
 */
const FLEET_PRE_PUSH_HOOK = `#!/bin/sh
# papercusp fleet pre-push hook — installed per-spawn via GIT_CONFIG core.hooksPath.
echo "papercusp: autonomous fleet spawns may not 'git push' (integration is the orchestrator's job; repo invariant: agents don't push). Blocked by the fleet pre-push hook." 1>&2
exit 1
`;

// Cached per orchestrator process — the hooks dir is created once with an
// unguessable name (see ensureFleetGitHooksDir) and reused across spawns.
let cachedFleetGitHooksDir: string | null = null;

/**
 * Create (once per process, then cached) a hooks directory holding only the
 * fleet pre-push hook and return its absolute path.
 *
 * Security: a `core.hooksPath` directory is an RCE sink — git executes
 * whatever hooks live there — so it must not sit at a predictable, shared
 * tmp path another user could pre-create / symlink (plant a hook, or clobber
 * a victim file through our write). So: `mkdtempSync` mints an unguessable
 * name and creates the dir atomically with mode 0700 (owner-only); the hook
 * is written through `O_NOFOLLOW | O_EXCL` so a pre-existing symlink/file at
 * the path errors rather than being followed/overwritten. `core.hooksPath`
 * pointing here means no OTHER hook type runs for the spawn — fine, fleet
 * agents commit with `--no-verify` and the only hook we want is pre-push.
 */
export function ensureFleetGitHooksDir(): string {
  if (cachedFleetGitHooksDir && existsSync(join(cachedFleetGitHooksDir, 'pre-push'))) {
    return cachedFleetGitHooksDir;
  }
  // mkdtemp → 0700, owner-only, unguessable name (can't be pre-created).
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-fleet-githooks-'));
  const hookPath = join(dir, 'pre-push');
  // O_EXCL: the freshly-minted dir is empty, so this also fails loudly if
  // anything raced a file in; O_NOFOLLOW: never write through a symlink.
  const fd = openSync(
    hookPath,
    // eslint-disable-next-line no-bitwise
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o700,
  );
  try {
    writeSync(fd, FLEET_PRE_PUSH_HOOK);
  } finally {
    closeSync(fd);
  }
  cachedFleetGitHooksDir = dir;
  return dir;
}

/**
 * Spawn-env additions that point THIS spawn's git at the fleet hooks dir via
 * `GIT_CONFIG_*`, blocking `git push` (see FLEET_PRE_PUSH_HOOK). Injected into
 * the spawn env only — the shared repo config + the user's / other agents'
 * git are untouched. Composes with any pre-existing `GIT_CONFIG_COUNT` in the
 * env rather than clobbering it. Verified vs git: blocks push, commits still
 * work (pre-push only fires on push).
 */
export function gitConfigNoPushEnv(
  baseEnv: NodeJS.ProcessEnv,
  hooksDir: string,
): Record<string, string> {
  const parsed = Number.parseInt(baseEnv.GIT_CONFIG_COUNT ?? '', 10);
  const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${n}`]: hooksDir,
  };
}

/**
 * claude-code-only spawn-env hardening (fleet-coordination-painpoints P-012).
 *
 * Belt-and-suspenders env hardening for claude-code spawns. The PRIMARY P-012
 * fix is {@link writeSpawnClaudeConfig} (an isolated, plugin-free
 * `CLAUDE_CONFIG_DIR`): with no enabled plugins / known marketplaces, claude
 * never resolves an external marketplace source and so can't check a plugin
 * tree out into the worker cwd (the "empty config stubs" bug — root-caused via
 * live strace to claude-code's `git clone --no-checkout` + `git checkout <sha>`
 * whose work-tree is the process cwd). These env vars are secondary defense:
 *   - `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` — never
 *     bootstrap/clone the official marketplace during a spawn (the only git
 *     activity a plugin-free config could still trigger).
 *   - `DISABLE_AUTOUPDATER=1` — stops the binary self-updater. NOTE: this does
 *     NOT gate the marketplace refresh (verified against the 2.1.161 binary —
 *     the refresh is gated by a per-marketplace `autoUpdate` flag, not this
 *     var); it was the prior, ineffective sole fix and is kept only as cheap
 *     hygiene. Do not rely on it to prevent the leak.
 * Returns `{}` for any non-claude backend (codex/omp have no plugin marketplace).
 */
export function claudeSpawnEnvHardening(agentBackend: AgentBackend): Record<string, string> {
  if (agentBackend !== 'claude-code') return {};
  return {
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    DISABLE_AUTOUPDATER: '1',
  };
}

/**
 * Phase E (P-051 / D-008): resolve the per-spawn `HOME` for a child agent.
 *
 * In the shared-operator model — signaled by `PAPERCUSP_SHARED_OPERATOR=1`,
 * which only the new desktop shell sets — ONE sidecar serves many workspaces
 * under a neutral process HOME (the real user home). Each spawned child must
 * therefore get its OWN workspace's HOME so filesystem credentials resolve
 * per-workspace: `~/.claude` (Claude session) + `~/.gitconfig` (git identity),
 * which the shell provisions into every workspace dir
 * (`workspaces.rs::link_workspace_credentials`).
 *
 * Returns the workspace HOME dir, or `null` to leave the inherited process HOME
 * untouched. `null` when: not the shared-operator model (dev / standalone / the
 * legacy per-process-HOME packaged build — D-009: never flip piecemeal in dev);
 * no workspace bound; the workspace dir isn't provisioned; or the caller
 * already pinned a HOME. (`PAPERCUSP_HOME` — operator *state* — is set
 * separately by the spawn envelope; this is the OS HOME for filesystem creds,
 * which `PAPERCUSP_HOME` does not cover.)
 */
export function resolveSpawnHome(
  workspaceId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  callerHomeOverride?: string,
): string | null {
  if (callerHomeOverride) return null;
  if (env.PAPERCUSP_SHARED_OPERATOR !== '1') return null;
  if (!workspaceId) return null;
  const wsHome = workspaceHomeDir(workspaceId, env);
  return existsSync(wsHome) ? wsHome : null;
}

/**
 * Parse the final assistant text from a structured-stream log file.
 *
 * For `claude-stream-json`: the terminal event is
 *   `{"type":"result","result":"...","total_cost_usd":N,...}`.
 *
 * For `omp-json`: events are `{"type":"message_update", message, assistantMessageEvent}` /
 *   `{"type":"message_end", message: AssistantMessage}` / `{"type":"agent_end", messages}`.
 *   The final assistant text is the last assistant `message_end` (or the
 *   `done` assistantMessageEvent), reconstructed from the message's text content blocks.
 *
 * For `none`: returns the file contents verbatim (matches old fallback).
 */
/**
 * Extract the final assistant text from accumulated stream-json content.
 * Either pass the raw content directly, or a filesystem path (back-compat
 * for callers that still keep the JSONL on disk).
 */
export function extractResult(source: string, format: StreamFormat): string {
  // Heuristic: a string with no newlines that exists as a path → treat as path.
  // Any other input is treated as content directly. Callers that want to be
  // explicit can use extractResultFromContent.
  let data = '';
  if (source.length > 0 && !source.includes('\n') && existsSync(source)) {
    try { data = readFileSync(source, 'utf8'); } catch { return ''; }
  } else {
    data = source;
  }
  if (format === 'none') return data;

  const lines = data.trimEnd().split(/\r?\n/);

  if (format === 'claude-stream-json') {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && obj.type === 'result' && typeof obj.result === 'string') {
          return obj.result;
        }
      } catch { /* claude can interleave non-JSON occasionally */ }
    }
    return '';
  }

  if (format === 'codex-json') {
    // `codex exec --json` JSONL: the assistant's text arrives as one or
    // more `{type:'item.completed', item:{type:'agent_message', text}}`
    // events (codex emits no single terminal `result`). Concatenate them
    // in order — the decision verb the orchestrator greps for is in this
    // text just like the claude/omp paths.
    const parts: string[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      if (
        obj && typeof obj === 'object'
        && obj.type === 'item.completed'
        && obj.item && typeof obj.item === 'object'
        && obj.item.type === 'agent_message'
        && typeof obj.item.text === 'string'
      ) {
        parts.push(obj.item.text);
      }
    }
    return parts.join('').trim();
  }

  // omp-json: walk from the end, find the last message_end / done /
  // agent_end carrying an assistant message. Pull text-content blocks.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    // Direct message_end with the final assistant message.
    if (obj.type === 'message_end' && obj.message?.role === 'assistant') {
      const text = collectAssistantText(obj.message);
      if (text) return text;
    }
    // assistantMessageEvent.type === 'done' carries the final message too.
    if (
      obj.type === 'message_update'
      && obj.assistantMessageEvent?.type === 'done'
      && obj.assistantMessageEvent.message
    ) {
      const text = collectAssistantText(obj.assistantMessageEvent.message);
      if (text) return text;
    }
    // agent_end has the full messages list — last assistant entry wins.
    if (obj.type === 'agent_end' && Array.isArray(obj.messages)) {
      for (let j = obj.messages.length - 1; j >= 0; j--) {
        const m = obj.messages[j];
        if (m?.role === 'assistant') {
          const text = collectAssistantText(m);
          if (text) return text;
          break;
        }
      }
    }
  }
  return '';
}

/** Concatenate text-typed content blocks from an omp/pi-ai assistant message. */
function collectAssistantText(message: any): string {
  if (!message || !Array.isArray(message.content)) return '';
  const parts: string[] = [];
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('').trim();
}

/** Initialize the empty memory files bash creates on first invocation. */
function ensureMemoryFiles(stateDir: string): void {
  const memDir = join(stateDir, 'memory');
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
  for (const f of ['raw.md', 'summary.md', 'MEMORY.md']) {
    const p = join(memDir, f);
    if (!existsSync(p)) writeFileSync(p, '');
  }
}

/**
 * Run the agent CLI (`omp -p` default, `claude -p` opt-in, or override) for a
 * given role. Returns the captured result.
 *
 * Pipes the assembled prompt to stdin; captures stream-json (or plain text)
 * to <logDir>/<runId>.jsonl, stderr to .err. Final result text is extracted
 * to .out for the orchestrator's decision parser.
 */
/**
 * Optional overrides for ad-hoc invocations (chunk-loop driver, etc.).
 * `inlinePrompt` short-circuits the prompt-file resolution — useful
 * when the caller has built the prompt programmatically and doesn't
 * want to write it to disk first. `cwd` overrides the working
 * directory the agent runs in (otherwise inferred from
 * `ctx.worktreePathFor` based on the FEATURE_ID extra).
 */
export interface InvokeOptions {
  inlinePrompt?: string;
  cwd?: string;
  /**
   * Parent spawn ID, set when this `invoke()` was triggered by another
   * agent's `orchestrator.spawn` MCP-tool call (Phase 9). Null/undefined
   * for orchestrator main-loop spawns. Plumbed through to the per-spawn
   * `.mcp.json` so plugin-tool calls from this child carry the lineage.
   */
  parentSpawnId?: string | null;
  /**
   * Extra env vars to inject into the spawned agent's process. The
   * operator passes decrypted search-provider keys (Migration 047) here
   * so workers/validators/scoper/architect can use OMP's web_search
   * providers. The orchestrator itself doesn't reach into operator
   * state — the caller (operator) computes these and passes them in.
   */
  extraEnv?: Record<string, string>;
  /**
   * Optional AbortSignal. When aborted, the spawn flow sends SIGTERM
   * to the child agent process (then SIGKILL after 2s grace via the
   * existing timeout path). Used by Phase 9's orchestrator.spawn
   * primitive to implement `orchestrator.cancel`.
   */
  signal?: AbortSignal;
  /**
   * Idempotency key (dbos-durable-jobs-2026-05-31 Phase 3, P-015). When set, it
   * is used as the run ID so the `harness_run_output` record is keyed
   * deterministically across re-invocations (e.g. a DBOS workflow step re-running
   * after a crash). Before spawning, invoke() checks for a completed run under
   * this key and, if found, returns the prior result WITHOUT re-spawning the
   * agent — so wrapping invoke() as a durable step can't double-run a completed
   * agent. Opt-in: unset (every current caller) keeps the timestamped run-id and
   * always spawns, so existing behaviour is unchanged.
   */
  idempotencyKey?: string;
}

/**
 * Idempotency short-circuit (dbos-durable-jobs-2026-05-31 Phase 3, P-015): look
 * up a prior COMPLETED run under `runId` (= the supplied idempotencyKey) and
 * reconstruct its InvokeResult so the caller can skip re-spawning the agent.
 * Returns null when no prior run exists (→ proceed to spawn). Exported for direct
 * unit testing. Takes primitives (no ctx) so a fake `pg` is enough to exercise it.
 */
export async function findPriorRunForIdempotency(
  pg: OrchestratorPg,
  workspaceId: string,
  harnessSlug: string,
  runId: string,
  role: string,
  log: (m: string) => void,
): Promise<InvokeResult | null> {
  let prior;
  try {
    const { readRunOutputPg } = await import('./run-output-pg');
    prior = await readRunOutputPg({ pg, workspaceId, harnessSlug }, runId);
  } catch (err) {
    log(`  idempotency lookup failed (non-fatal, proceeding to spawn): ${(err as Error).message}`);
    return null;
  }
  if (!prior) return null;
  // An empty-output prior run is not a meaningful completed run (the agent
  // emitted nothing → did no work). Reusing it would poison a DBOS decide-step
  // retry / a re-trigger with the empty result, so a transient empty (e.g. claude
  // returning nothing under concurrent load) could never recover (P-010). Treat
  // it as "no prior run" so the caller re-spawns.
  if (!prior.outBody.trim()) {
    log(`invoke ${role} prior run ${runId} had empty output — not reusing, will re-spawn`);
    return null;
  }
  log(`invoke ${role} idempotent hit (runId=${runId}, rc=${prior.exitCode}) — reusing prior run, no re-spawn`);
  return {
    output: prior.outBody.replace(/\n$/, ''),
    jsonlPath: '',
    outPath: '',
    exitCode: prior.exitCode,
    durationMs: prior.durationMs,
  };
}

export async function invoke(
  ctx: InvokeContext,
  role: string,
  extras: readonly string[] = [],
  options: InvokeOptions = {},
): Promise<InvokeResult> {
  const cfg = readConfig(ctx.stateDir);
  const dept = ctx.dept ?? configGet<string>(cfg, 'dept', '');

  // 1. Resolve prompt file (with phase + dept fallback chain), unless
  //    the caller supplied an inlinePrompt — in which case we skip the
  //    file resolution entirely and pass the inline string through to
  //    buildPrompt as-is.
  let promptFile = '';
  if (!options.inlinePrompt) {
    // A program-blueprint spawn (coordination-ops-as-blueprint-primitives) passes
    // BLUEPRINT_ID=<id> so a program role (voter/advocate) resolves its prompt from
    // blueprints/<id>/prompts/<role>.md. Absent for the normal pipeline.
    const blueprintId =
      extras.find((e) => e.startsWith('BLUEPRINT_ID='))?.slice('BLUEPRINT_ID='.length) || undefined;
    const resolved = resolvePromptFile(
      { harnessDir: ctx.harnessDir, phase: ctx.phase, dept, blueprintId },
      role,
    );
    if (!resolved) {
      const where = blueprintId
        ? `${ctx.harnessDir}/blueprints/${blueprintId}/prompts or ${ctx.harnessDir}/prompts`
        : `${ctx.harnessDir}/prompts`;
      throw new Error(`invoke: no prompt file for role=${role} (looked under ${where})`);
    }
    promptFile = resolved;
  }

  // 2. Feature ID + run ID. An idempotency key (P-015) is used as the run ID so
  //    the record is keyed deterministically across re-invocations; without it
  //    the run ID stays timestamped (every current caller).
  const featureId = extractFeatureId(extras);
  const featureTag = featureId ? `-${featureId}` : '';
  const nowSec = (ctx.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const runId = options.idempotencyKey ?? makeRunId(role, featureId, nowSec);

  // 2a. Idempotent short-circuit (P-015): reuse a prior completed run under this
  //     key instead of re-spawning. The guard that lets invoke() be wrapped as a
  //     durable DBOS step — a crash that re-runs a COMPLETED invoke returns the
  //     prior result, not a second agent run. An *interrupted* run leaves no row
  //     (written at run end), so it re-spawns on resume; re-spawn-fresh is the
  //     policy (D-003: the agent re-reads git state, so git is the dedup). Opt-in.
  if (options.idempotencyKey && ctx.pg && ctx.workspaceId) {
    const { harnessSlug: getSlug } = await import('./state');
    const prior = await findPriorRunForIdempotency(
      ctx.pg, ctx.workspaceId, getSlug(ctx.projectDir), runId, role, ctx.log,
    );
    if (prior) return prior;
  }

  // 3. Worktree cwd override. Caller's `options.cwd` wins; otherwise
  //    we infer from the registered worktreePathFor + the FEATURE_ID
  //    extra.
  let cwdOverride = '';
  if (options.cwd && existsSync(options.cwd)) {
    cwdOverride = options.cwd;
  } else if (featureId && ctx.worktreePathFor) {
    const wt = ctx.worktreePathFor(featureId) ?? '';
    if (wt && existsSync(wt)) cwdOverride = wt;
  }

  // 4. Backend-aware structured-stream detection. Defaults to inferring
  //    from the binary name in claudeCmd (omp/pi → omp, otherwise claude-code).
  //    Per-role / per-harness aiBackend config can override the agent
  //    command (and append extraArgs) — falls back to ctx.claudeCmd which
  //    came from process env (AGENT_CMD / CLAUDE).
  const { agentCmd: roleAgentCmd, extraArgs: roleExtraArgs } =
    resolveAgentForRole(cfg, role, ctx.claudeCmd);
  if (roleAgentCmd !== ctx.claudeCmd) {
    ctx.log(`  role=${role} agentCmd=${roleAgentCmd} (from config.json)`);
  }
  const argv = splitCommand(roleAgentCmd);
  const agentBackend: AgentBackend = ctx.agentBackend ?? resolveAgentBackend(roleAgentCmd);
  const streamFormat = selectStreamFormat(agentBackend, roleAgentCmd);
  const extraFlags: string[] = [...streamFormatFlags(streamFormat)];

  // codex sandbox policy (plan fleet-spawn-sandbox Phase 2) — flag-gated
  // workspace-write vs the prior danger-full-access default. Goes in extraFlags
  // (before the `-` stdin positional) because codex wants options before the prompt.
  extraFlags.push(...codexSandboxArgs(agentBackend, streamFormat, roleAgentCmd, fleetSandboxEnabled()));

  // 5. Per-role model — only inject if user didn't already pass one.
  //    codex's model flag is `-m` (bare id); claude/omp use `--model`.
  const modelFlag = agentBackend === 'codex' ? '-m' : '--model';
  const cmdAlreadyHasModel = roleAgentCmd.includes('--model ') || /(?:^|\s)-m\s/.test(roleAgentCmd);
  if (!cmdAlreadyHasModel) {
    const model = normalizeModelForBackend(resolveModel(cfg, role), agentBackend);
    if (model) {
      extraFlags.push(modelFlag, model);
      ctx.log(`  role=${role} model=${model} (from config.json)`);
    }
  }

  // 5b. Per-role extraArgs from aiBackend.{default,roles[role]}.extraArgs.
  if (roleExtraArgs.length > 0) {
    extraFlags.push(...roleExtraArgs);
  }

  // 6. Timeout.
  const timeoutSeconds = resolveTimeout(cfg, role);
  const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined;
  if (timeoutMs) {
    ctx.log(`  role=${role} timeout=${timeoutSeconds}s`);
  }

  // 7. Per-role prompt override — workspace-owned PG store preferred, with a
  //    file/config.json fallback (regression-safe; see resolvePromptOverrideWithStore).
  const promptOverride = await resolvePromptOverrideWithStore(cfg, ctx.stateDir, role, {
    pg: ctx.pg,
    workspaceId: ctx.workspaceId,
    harnessSlug: harnessSlugFromProjectDir(ctx.projectDir),
  });
  if (promptOverride) {
    ctx.log(`  role=${role} prompt-override applied (${promptOverride.length} chars)`);
  }

  // 8. Memory directory exists.
  ensureMemoryFiles(ctx.stateDir);

  // 8.5 Substrate context (Tier 1 + Tier 2 + Tier 3 + bounded supervisor inbox).
  // Best-effort; empty string on any fetch failure.
  let selfSlug = configGet<string>(cfg, 'slug', '');
  if (!selfSlug) {
    // Fallback to projectDir basename (matches what the file registry uses).
    const m = ctx.projectDir.match(/[^/]+$/);
    if (m) selfSlug = m[0];
  }
  const parentSlug = configGet<string>(cfg, 'parent_slug', '') || null;
  let substrateContext = '';
  if (selfSlug) {
    try {
      substrateContext = await fetchSubstrateContext({ selfSlug, parentSlug });
    } catch { /* leave empty */ }
  }

  // 8.6 Feature history — read PG-only (notes + debugger findings + audit
  // transitions). Best-effort; empty when the feature has no recorded
  // history yet OR when ctx.pg/workspaceId are unset (CLI mode without
  // PG bootstrap). Cache-safe: appended at end of prompt by buildPrompt.
  let featureHistory = '';
  if (featureId && ctx.pg && ctx.workspaceId) {
    try {
      const { fetchFeatureHistory } = await import('./feature-history.js');
      const { harnessSlug: getSlug } = await import('./state.js');
      featureHistory = await fetchFeatureHistory({
        pg: ctx.pg,
        workspaceId: ctx.workspaceId,
        harnessSlug: getSlug(ctx.projectDir),
        featureId,
      });
    } catch { /* best-effort; empty section is harmless */ }
  }

  // 8.6b G3 — feature provenance (P-009): look up the feature's `origin`
  // from harness_shared.harness_features_consolidated so buildPrompt can
  // wrap remote-authored content (featureHistory, planContext) in the
  // <untrusted-peer-content> delimiter. Best-effort; defaults to null
  // (treated as local/trusted) on any error or when PG is unavailable.
  //
  // G3 FAIL-OPEN DECISION (security trade-off, documented per G3 audit):
  //
  //   A PG query failure OR a missing row → featureOrigin stays null →
  //   content is treated as LOCAL/TRUSTED → NOT wrapped by wrapUntrusted().
  //
  //   This is an accepted defence-in-depth tradeoff:
  //   - G2 (the pick-gate) is the PRIMARY control — it rejects remote
  //     features before they are dispatched to agents at all. featureOrigin
  //     wrapping is a belt-and-suspenders layer, not the gate itself.
  //   - Pre-G1 rows (features created before the origin column existed)
  //     have null origin in the DB, and they are all local by construction
  //     — they predate the remote-feature ingest path.
  //   - Wrapping unknown-origin content as untrusted would add noise for
  //     the common case (most features are local) while providing minimal
  //     security gain (G2 already blocks remote dispatch).
  //   - A fail-SAFE alternative (wrap unknown as remote) was considered and
  //     rejected because it breaks the worker UX for every pre-G1 harness
  //     at no meaningful security gain (G2 is the gate).
  //
  //   If G2 is ever removed or weakened, revisit this decision and change
  //   the fallback to `'remote'` (fail-safe wrap).
  let featureOrigin: 'local' | 'remote' | null = null;
  if (featureId && ctx.pg) {
    try {
      const { harnessSlug: getSlug } = await import('./state.js');
      const rows = await ctx.pg<{ origin: string | null }[]>`
        SELECT origin
          FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${getSlug(ctx.projectDir)}
           AND feature_id   = ${featureId}
         LIMIT 1
      `;
      const raw = rows[0]?.origin;
      featureOrigin = raw === 'remote' ? 'remote' : 'local';
    } catch { /* best-effort; null → treated as local/trusted (see fail-open comment above) */ }
  }

  // 8.7 Materialize per-feature operator notes from PG → FS.
  //
  // PG is canonical for `harness_feature_notes`; the FS path
  // `<stateDir>/notes/<fid>.md` is a transient projection refreshed
  // here just before the worker spawns. The role prompt at
  // libs/papercusp/packages/harness/prompts/worker.md instructs the
  // agent to read this file if present.
  //
  // Best-effort. Skipped for non-feature-bound roles (orchestrator,
  // scoper, etc.) since they don't read the file and it would be
  // wasted I/O.
  if (
    featureId &&
    (role === 'worker' || role === 'validator' || role === 'debugger') &&
    ctx.pg && ctx.workspaceId
  ) {
    try {
      const { materializeFeatureNote } = await import('./feature-notes.js');
      const { materializeFeatureDebugNote } = await import('./feature-debug-notes.js');
      const { harnessSlug: getSlug } = await import('./state.js');
      const slug = getSlug(ctx.projectDir);
      const matInput = {
        pg: ctx.pg,
        workspaceId: ctx.workspaceId,
        harnessSlug: slug,
        featureId,
        stateDir: ctx.stateDir,
      };
      // Materialize both operator notes and debugger findings in
      // parallel — independent PG reads, neither depends on the other.
      await Promise.all([
        materializeFeatureNote(matInput),
        materializeFeatureDebugNote(matInput),
      ]);
    } catch { /* best-effort — worker prompt handles missing file */ }
  }

  // 8.10 Plan context — fetch the origin plan's ## Now + last 3 decisions
  // for worker/validator/reviewer roles executing plan-derived features.
  // Fetched over HTTP from the operator so this submodule stays free of
  // operator-layer PG imports. Best-effort; 3 s timeout; empty on miss.
  let planContext = '';
  if (
    featureId &&
    (role === 'worker' || role === 'validator' || role === 'reviewer')
  ) {
    try {
      const planCtxBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
      const planCtxRes = await fetch(
        `${planCtxBase}/api/harness/${harnessSlugFromProjectDir(ctx.projectDir)}/features/${featureId}/plan-context`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (planCtxRes.ok) {
        const planCtxData = await planCtxRes.json() as { section?: string };
        planContext = planCtxData.section ?? '';
      }
    } catch { /* best-effort — feature has no plan origin or operator unreachable */ }
  }

  // 8b. Pre-fetch per-role identity from PG (Migration 041
  // `harness_shared.identity_files`). When ctx.pg isn't set, this
  // returns empty and prompt-build falls back to reading the on-disk
  // file at <harnessDir>/identity/<role>.md.
  let identity = '';
  if (ctx.pg) {
    try {
      const rows = await ctx.pg<{ content: string }[]>`
        SELECT content FROM harness_shared.identity_files
         WHERE role = ${role}
         LIMIT 1
      `;
      identity = rows[0]?.content ?? '';
    } catch { /* best-effort; file fallback covers this */ }
  }

  // 8.8 Cross-tool playbook (`<role>.tools.md` from the operator's
  // prompts directory). Authored once per role; captures workflows +
  // patterns that span multiple tools. The operator-app is the single
  // source of truth for these files — the orchestrator reads them at
  // spawn time so the agent has the playbook in its system prompt.
  //
  // Path resolution: PAPERCUSP_OPERATOR_PROMPTS_DIR env override wins,
  // otherwise walk up from cwd looking for apps/operator/prompts.
  // Best-effort: missing files just produce an empty section.
  let toolsPlaybook = '';
  try {
    const promptsDir = resolveOperatorPromptsDir();
    if (promptsDir) {
      const playbookPath = `${promptsDir}/${role}.tools.md`;
      if (existsSync(playbookPath)) {
        toolsPlaybook = readFileSync(playbookPath, 'utf8');
      }
    }
  } catch { /* best-effort */ }

  // 8.9 Shared cross-role guides — Path B injection per docs-engine plan.
  // Authored as MDX in apps/operator-docs/src/content/docs/agents/ so the
  // doc-site page and the prompt content share one source. We strip
  // leading frontmatter and pass each guide as a separate section.
  const sharedGuides: string[] = [];
  try {
    const docsAgentsDir = resolveOperatorDocsAgentsDir();
    if (docsAgentsDir) {
      for (const name of ['finding-context.mdx']) {
        const guidePath = `${docsAgentsDir}/${name}`;
        if (existsSync(guidePath)) {
          const raw = readFileSync(guidePath, 'utf8');
          sharedGuides.push(stripFrontmatter(raw));
        }
      }
    }
  } catch { /* best-effort */ }

  // 9. Build the prompt.
  const prompt = buildPrompt({
    role,
    promptFile,
    inlinePrompt: options.inlinePrompt,
    promptOverride,
    stateDir: ctx.stateDir,
    harnessDir: ctx.harnessDir,
    identity,
    projectDir: ctx.projectDir,
    cwdOverride,
    featureId,
    runId,
    extras,
    substrateContext,
    planContext,
    featureHistory,
    toolsPlaybook,
    sharedGuides,
    // G3 — pass provenance so buildPrompt can wrap remote-authored content
    // (featureHistory, planContext) in <untrusted-peer-content> delimiters.
    featureOrigin,
  });

  // Token-spend telemetry — emit once per invoke so we can see how the
  // prompt budget breaks down across sections in production logs.
  // Char counts (not tokens; tokens ≈ chars/4 for english).
  //
  // Two channels:
  //   1. Log line (transport) — visible in run.log immediately.
  //   2. PG row (persistence, async best-effort) — enables the
  //      operator UI's "what did each turn cost" historical view.
  // Per architectural rule: log first, persist after. We do NOT
  // await the PG write; failure to persist is silent.
  ctx.log(
    `  prompt-budget role=${role} feature=${featureId ?? '-'} ` +
    `total=${prompt.length} substrate=${substrateContext.length} ` +
    `history=${featureHistory.length} playbook=${toolsPlaybook.length}`,
  );
  if (ctx.pg && ctx.workspaceId) {
    try {
      const { recordPromptComposition } = await import('./prompt-telemetry.js');
      const { harnessSlug: getSlug } = await import('./state.js');
      recordPromptComposition(ctx.pg, {
        workspaceId: ctx.workspaceId,
        harnessSlug: getSlug(ctx.projectDir),
        featureId,
        role,
        runId,
        totalChars: prompt.length,
        substrateChars: substrateContext.length,
        historyChars: featureHistory.length,
      });
    } catch { /* best-effort */ }
  }

  // 10. Spawn claude. logDir creation is deferred until we actually
  // need to write files (CLI fallback path); PG-canonical mode never
  // touches the directory.
  const jsonlPath = join(ctx.logDir, `${runId}.jsonl`);
  const outPath = join(ctx.logDir, `${runId}.out`);
  const errPath = join(ctx.logDir, `${runId}.err`);

  const finalArgv = [...argv.slice(1), ...extraFlags];
  const command = argv[0];
  const cwd = cwdOverride || ctx.projectDir;
  const startedAt = Date.now();

  // omp's `-p` mode reads the message from a positional arg (or `@file`),
  // not from stdin. Materialise the prompt to an ephemeral tmpfile under
  // ramTmpRoot() (Linux: /dev/shm tmpfs; macOS/Windows: page-cache-backed
  // os.tmpdir()), pass `@<path>` as argv, and rm the dir in the finally
  // block after spawn close. The harness directory stays pure-code; the
  // prompt body still lands in harness_run_output's prompt_body column
  // for post-hoc replay/debugging (Phase 4 + 5 working together).
  let ompPromptDir: string | undefined;
  let ompPromptPath: string | undefined;
  if (agentBackend === 'omp' && streamFormat !== 'none') {
    const { ramTmpRoot } = await import('./tmpfs');
    ompPromptDir = mkdtempSync(join(ramTmpRoot(), 'papercusp-'));
    ompPromptPath = join(ompPromptDir, 'prompt.md');
    writeFileSync(ompPromptPath, prompt, 'utf8');
    finalArgv.push(`@${ompPromptPath}`);
  }

  // codex `exec` reads the prompt from stdin via the trailing `-` positional
  // (the stdin.write block below pipes `prompt` to every non-omp backend).
  if (agentBackend === 'codex' && streamFormat !== 'none') {
    finalArgv.push('-');
  }

  // Per-spawn MCP config location. claude loads its config from an EXPLICIT
  // path (`--mcp-config … --strict-mcp-config`), so it can live in a UNIQUE
  // per-spawn temp dir rather than the shared `<cwd>/.mcp.json`. That lets
  // several claude spawns share ONE project dir without race-clobbering each
  // other's config — the coord-op vote fan-out spawns N voters + an advocate in
  // one harness dir, and a shared `.mcp.json` made two of them authenticate
  // under a single role (coordination-ops-as-blueprint-primitives D-012/D-014).
  // tmpdir() is sandbox-readable (not in FLEET_SANDBOX_DENY_READ). omp
  // path-discovers `<cwd>/.mcp.json` and has no explicit-path override, so it
  // keeps the shared file (its fan-out stays sequential); codex uses a per-spawn
  // CODEX_HOME (already isolated). The temp dir is removed alongside mcpHandle
  // when the spawn closes.
  let mcpConfigDir = cwd;
  let mcpTempDir: string | null = null;
  if (agentBackend === 'claude-code' && ctx.workspaceId) {
    mcpTempDir = mkdtempSync(join(tmpdir(), 'papercusp-mcp-'));
    mcpConfigDir = mcpTempDir;
  }
  const mcpConfigPath = join(mcpConfigDir, '.mcp.json');

  // 10b. claude-code MCP wiring — make claude load + trust the per-spawn
  // signed .mcp.json (omp path-discovers it; claude won't without these
  // flags). See claudeMcpArgs.
  finalArgv.push(
    ...claudeMcpArgs(
      agentBackend,
      streamFormat,
      roleAgentCmd,
      mcpConfigPath,
      Boolean(ctx.workspaceId),
      role,
    ),
  );

  // 10c. Optional OS sandbox (PAPERCUSP_FLEET_SANDBOX) — claude-code's built-in
  // sandbox via --settings: hides credential dirs, confines writes to cwd, and
  // allowlists command egress. Off by default; no-op for non-claude backends.
  // See plan fleet-spawn-sandbox-2026-06-01.
  finalArgv.push(
    ...claudeSandboxArgs(
      agentBackend,
      streamFormat,
      roleAgentCmd,
      Boolean(ctx.workspaceId),
      fleetSandboxEnabled(),
      role,
    ),
  );

  // Body accumulators (in-memory). Filesystem JSONL/ERR is only
  // touched in true-CLI fallback (no operator, no PG) — see writeBodyToDiskAtExit.
  const jsonlChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];

  // Live chunk streaming via in-process bus on the operator. Each
  // stdout chunk is HTTP-POSTed to /api/internal/run-chunk on the
  // operator; the operator's per-run EventEmitter fans out to SSE
  // subscribers without filesystem coupling.
  //
  // OPTIONAL persistence: when PAPERCUSP_PERSIST_CHUNKS=1 AND ctx.pg
  // is wired, each chunk is ALSO INSERTed into harness_run_chunks for
  // archival per-chunk replay (timing analysis, fine-grained playback).
  // The bus delivery does not wait for the PG write — persistence is
  // a parallel queue. Default OFF: full-body persistence at run exit
  // (harness_run_output, Phase 4) covers post-hoc replay for ~all use
  // cases.
  //
  // Falls back to file-only when:
  //   - PAPERCUSP_OPERATOR_BASE is unset/unreachable (CLI-only mode,
  //     no operator running)
  //   - harness_token isn't available (legacy harness without one)
  // Files are written ONLY at run end (not appended per-chunk) and
  // ONLY when neither bus nor PG is active — see writeFilesForFallback
  // below. Default PG-canonical mode produces zero files.
  let chunkSeq = 0;
  let chunkPostQueue: Promise<void> = Promise.resolve();
  let chunkPgQueue: Promise<void> = Promise.resolve();
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const persistChunks = process.env.PAPERCUSP_PERSIST_CHUNKS === '1';
  let harnessToken: string | null = null;
  try {
    const cfgRaw = readFileSync(`${ctx.stateDir}/config.json`, 'utf8');
    const cfgJson = JSON.parse(cfgRaw) as { harness_token?: string };
    if (typeof cfgJson.harness_token === 'string' && cfgJson.harness_token.length > 0) {
      harnessToken = cfgJson.harness_token;
    }
  } catch { /* no token → bus disabled, file-only path */ }

  // Pre-resolve the PG chunk-archival path when both flag + ctx.pg are
  // set. Done before the spawn Promise so the sync stdout handler can
  // reference appendChunkPg without an `await import`.
  type ChunkPgCtx = { pg: OrchestratorPg; workspaceId: string; harnessSlug: string };
  let chunksPgCtx: ChunkPgCtx | null = null;
  let appendChunkPgFn: ((c: ChunkPgCtx, runId: string, seq: number, data: string) => Promise<void>) | null = null;
  if (persistChunks && ctx.pg && ctx.workspaceId) {
    const { harnessSlug: getSlug } = await import('./state');
    chunksPgCtx = {
      pg: ctx.pg,
      workspaceId: ctx.workspaceId,
      harnessSlug: getSlug(ctx.projectDir),
    };
    appendChunkPgFn = (await import('./run-chunks-pg')).appendChunkPg;
  }

  const outcome: SpawnOutcome = await new Promise(async (resolve) => {
    // Spawn env: defensively disable omp's autonomous memory backend
    // for harness invocations. The harness composes the prompt itself
    // (substrate + role + memory + identity + feature history) and
    // owns context discipline; we don't want omp's `recall`/`reflect`
    // to autonomously inject extra context that competes.
    //
    // Both env keys covered:
    //   - `OMP_MEMORIES_ENABLED=false` — pre-backend `memories.enabled` flag
    //   - `OMP_MEMORY_BACKEND=off`     — explicit backend selection
    // Per omp's env docs, `OMP_*` keys are mirrored to `PI_*`. Setting
    // both forms protects against an unannounced rename.
    // Caller-supplied env on the ctx (e.g. decrypted search-provider keys
    // from Migration 047, resolved once at orchestrator boot). Spread
    // before the OMP_* memory-disable flags so we don't let the caller
    // accidentally override those.
    const spawnEnv: NodeJS.ProcessEnv = scopeSpawnEnvForRole(
      {
        ...process.env,
        ...(ctx.extraSpawnEnv ?? {}),
        ...(options.extraEnv ?? {}),
        OMP_MEMORIES_ENABLED: 'false',
        OMP_MEMORY_BACKEND: 'off',
        PI_MEMORIES_ENABLED: 'false',
        PI_MEMORY_BACKEND: 'off',
      },
      // G4 / P-011: strip operator-internal secrets the agent CLI never needs
      // (it uses the signed MCP endpoint, not direct PG); the auditor role
      // additionally loses the decrypted search-provider keys (read-only judge,
      // no web_search). Applied to the MERGED env BEFORE the per-spawn HOME /
      // git-no-push / MCP-config / sandbox-cache env is added below, so those
      // (non-secret) additions survive. See scopeSpawnEnvForRole.
      role,
    );

    // Phase E (P-051 / D-008): per-spawn HOME for filesystem-credential
    // isolation (~/.claude, ~/.gitconfig). See resolveSpawnHome — gated on the
    // shared-operator model so dev / legacy builds inherit the process HOME.
    const spawnHome = resolveSpawnHome(
      ctx.workspaceId,
      spawnEnv,
      options.extraEnv?.HOME ?? ctx.extraSpawnEnv?.HOME,
    );
    if (spawnHome) {
      spawnEnv.HOME = spawnHome;
      spawnEnv.USERPROFILE = spawnHome; // Windows
    }

    // claude-code only (P-012): point the spawn at an isolated, plugin-free
    // CLAUDE_CONFIG_DIR so the worker has no enabled plugins / known
    // marketplaces to resolve — and therefore can't run the
    // `git clone --no-checkout` + `git checkout <sha>` whose work-tree is the
    // process cwd, which leaks the plugin tree into the worker's cwd (the
    // empty package.json/.mcp.json/.env stub bug). It is a claude-code defect,
    // not ours (filed upstream); this denies it anything to resolve. The auth
    // session is symlinked in, so the worker stays logged in. CLAUDE_CONFIG_DIR
    // relocates only `.claude`; `.claude.json` stays at $HOME. See
    // writeSpawnClaudeConfig + claudeSpawnEnvHardening (secondary env defense).
    let claudeConfigHandle: SpawnClaudeConfigHandle | null = null;
    if (agentBackend === 'claude-code') {
      claudeConfigHandle = writeSpawnClaudeConfig(spawnEnv.HOME ?? homedir());
      spawnEnv.CLAUDE_CONFIG_DIR = claudeConfigHandle.configDir;
    }
    Object.assign(spawnEnv, claudeSpawnEnvHardening(agentBackend));

    // No orchestrator-spawned agent may `git push` — integration is the
    // orchestrator's job and the repo's invariant is "agents don't push".
    // Inject a pre-push hook via GIT_CONFIG into THIS spawn's env only, so
    // the shared checkout's config and the user's / other agents' pushes are
    // untouched. Real enforcement; the Bash(git push:*) deny is the backstop.
    Object.assign(spawnEnv, gitConfigNoPushEnv(spawnEnv, ensureFleetGitHooksDir()));

    // When the OS sandbox is on, also strip provider/cloud creds from the
    // sandboxed Bash subprocess env (verified: =1 strips e.g. AWS_SECRET_ACCESS_KEY
    // from a Bash subprocess). Complements the sandbox's denyRead + egress block.
    if (fleetSandboxEnabled()) {
      spawnEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
      // Redirect package-manager caches into the allow-listed cache root: the
      // sandbox makes $HOME read-only, so npm/pip/cargo (which cache under
      // ~/.npm/_cacache etc.) fail EROFS on a real install (D-013/P-014).
      // Absolute, per-project paths — independent of the per-spawn HOME above.
      // mkdir -p so bwrap can bind the dirs; harmless when no sandbox engages
      // (codex/omp aren't sandboxed → their $HOME stays writable, cache just
      // lands here instead).
      const cacheEnv = fleetSandboxCacheEnv(cwd);
      for (const dir of new Set(Object.values(cacheEnv))) {
        try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort; a real install would surface the error */ }
      }
      Object.assign(spawnEnv, cacheEnv);
    }

    // Per-spawn .mcp.json: write the seven-param URL config so OMP
    // discovers our agent-mcp endpoint with this spawn's harness/role/
    // feature/chunk/run/spawn baked in. Cleanup runs on close even if
    // spawn errors. Spec: apps/operator/docs/plugin-mcp-host-design.md (D4).
    let mcpHandle: SpawnMcpHandle | null = null;
    let codexHomeHandle: SpawnCodexHomeHandle | null = null;
    if (ctx.workspaceId) {
      try {
        const spawnId = randomUUID();
        const slug = harnessSlugFromProjectDir(ctx.projectDir);
        const chunkId = extractChunkId(extras);
        const signedInput = {
          harnessSlug: slug,
          workspaceId: ctx.workspaceId,
          role,
          runId,
          spawnId,
          featureId: featureId || null,
          chunkId,
          parentSpawnId: options.parentSpawnId ?? null,
        };
        // codex: no `.mcp.json` discovery — its MCP servers live in
        // $CODEX_HOME/config.toml. Mint a per-spawn CODEX_HOME with the
        // same signed, role-scoped URL + the ChatGPT auth symlink, and
        // point the child at it. omp writes the shared `<cwd>/.mcp.json`
        // (path discovery); claude writes to its per-spawn `mcpConfigDir`
        // (a unique temp dir — see the mcpConfigPath block above) and loads
        // it via `--mcp-config`, so concurrent claude spawns in one cwd
        // don't clobber a shared file.
        if (agentBackend === 'codex') {
          codexHomeHandle = await writeSignedSpawnCodexHome(signedInput);
          spawnEnv.CODEX_HOME = codexHomeHandle.codexHome;
        } else {
          // writeSignedSpawnMcp signs the URL params. In strict mode
          // (default since 2026-05-11) a signing failure throws — the
          // outer try/catch below logs `spawn-mcp write failed` and
          // proceeds with mcpHandle=null, so the agent runs but has no
          // MCP endpoint. That is the intended failure mode: better to
          // fail loudly than to emit an unsigned URL the operator will
          // reject on every tool call. To restore the silent-fallback
          // (soft-warn) behavior, pass `allowUnsigned: true` here AND
          // unset PAPERCUSP_REQUIRE_SPAWN_SIG on the operator.
          // No await-time risk: signing is a single PG round-trip against
          // a 32-byte row + an HMAC; total < 50ms in normal operation.
          mcpHandle = await writeSignedSpawnMcp(mcpConfigDir, signedInput);
        }
      } catch (err) {
        ctx.log(`  spawn-mcp write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // External OS-sandbox for backends that can't self-sandbox: codex (P-017/
    // D-017). codex's native sandbox cancels MCP (D-009), so it runs with its
    // sandbox bypassed (codexSandboxArgs) but wrapped in `srt`, which confines
    // its shell commands (writes → cwd+cache+agent-dirs, egress → allowlist,
    // creds hidden) while its MCP+model are allow-listed through srt's proxy.
    // The wrap clears `no_proxy` inside the srt shell so the operator
    // (loopback/RFC1918, which srt's default no_proxy excludes) routes through
    // that proxy instead of the isolated netns. omp gets the SAME wrap
    // (D-018/D-019: no native sandbox; model+MCP are loopback here). claude uses
    // its own --settings sandbox, not srt.
    let spawnCommand = command;
    let spawnArgv = finalArgv;
    if (fleetSandboxEnabled() && backendUsesSrt(agentBackend)) {
      const srtBin = srtBinOnPath();
      if (!srtBin) {
        throw new Error(
          `PAPERCUSP_FLEET_SANDBOX is set for a ${agentBackend} spawn but \`srt\` is not on PATH. ` +
            'Install @anthropic-ai/sandbox-runtime (npm i -g @anthropic-ai/sandbox-runtime) ' +
            'or set PAPERCUSP_FLEET_SANDBOX=0.',
        );
      }
      // The backend's own writable agent/state dirs (its config/auth/session DBs):
      // codex → the per-spawn CODEX_HOME; claude → the per-spawn isolated
      // CLAUDE_CONFIG_DIR (claude writes session/project state under it, and the
      // sandbox makes $HOME read-only); omp → ~/.omp + PI_CODING_AGENT_DIR
      // (the agent/auth/models SQLite DBs; usually <project>/.papercusp/pi-sessions,
      // already under cwd, but pinned here in case it's set to an absolute path).
      const agentHomes =
        agentBackend === 'codex'
          ? [codexHomeHandle?.codexHome].filter((x): x is string => Boolean(x))
          : agentBackend === 'claude-code'
            ? [claudeConfigHandle?.configDir].filter((x): x is string => Boolean(x))
            : [join(homedir(), '.omp'), spawnEnv.PI_CODING_AGENT_DIR].filter(
                (x): x is string => Boolean(x),
              );
      const settingsPath = writeFleetSrtSettings({ cwd, backend: agentBackend, agentHomes });
      ({ command: spawnCommand, argv: spawnArgv } = wrapSpawnWithSrt(command, finalArgv, {
        enabled: true,
        backend: agentBackend,
        srtBin,
        settingsPath,
      }));
    }
    const child = spawn(spawnCommand, spawnArgv, { cwd, env: spawnEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    // Write a row to harness_shared.harness_lanes so the operator UI's
    // "agents in flight" pill bar can subscribe to the live agent set.
    // Bash run.sh used to do this via `pg_write_lane`; the TS migration
    // dropped it, leaving the UI stuck on "No agents in flight" / the
    // "Orchestrator deciding next step…" subtitle even when a worker
    // was actively spawning. PK is (harness_slug, phase, role) — single
    // lane per role is fine for the common chunk-loop case; if parallel
    // workers ever need distinct rows the role string already encodes
    // the lane.
    let laneWritePromise: Promise<void> | null = null;
    const laneSlug = (() => {
      try { return harnessSlugFromProjectDir(ctx.projectDir); } catch { return ''; }
    })();
    if (ctx.pg && ctx.workspaceId && child.pid != null && laneSlug) {
      const lanePid = child.pid;
      const pg = ctx.pg;
      const ws = ctx.workspaceId;
      const startedAtMs = Date.now();
      laneWritePromise = (async () => {
        try {
          await pg`
            INSERT INTO harness_shared.harness_lanes
              (workspace_id, harness_slug, phase, role, feature_id, pid, started_at)
            VALUES (${ws}, ${laneSlug}, ${ctx.phase}, ${role}, ${featureId ?? null}, ${lanePid}, ${startedAtMs})
            ON CONFLICT (harness_slug, phase, role) DO UPDATE SET
              feature_id   = EXCLUDED.feature_id,
              pid          = EXCLUDED.pid,
              started_at   = EXCLUDED.started_at,
              workspace_id = EXCLUDED.workspace_id
          `;
        } catch (err) {
          ctx.log(`  lane write failed: ${(err as Error).message}`);
        }
      })();
    }
    const clearLane = async () => {
      if (!ctx.pg || !ctx.workspaceId || !laneSlug) return;
      const pg = ctx.pg;
      try {
        // Wait for the insert (if any) to finish before deleting — a
        // delete that races ahead of the insert leaves an orphan row
        // that the operator's status-sweep would have to clean up
        // later.
        if (laneWritePromise) await laneWritePromise;
        await pg`
          DELETE FROM harness_shared.harness_lanes
          WHERE harness_slug = ${laneSlug}
            AND phase = ${ctx.phase}
            AND role = ${role}
        `;
      } catch (err) {
        ctx.log(`  lane clear failed: ${(err as Error).message}`);
      }
    };

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }, timeoutMs);
    }

    // Phase 9: caller-supplied AbortSignal lets `orchestrator.cancel`
    // kill the child mid-flight. SIGTERM first; the orchestrator's
    // existing exit-handling drains, then we send SIGKILL after 2s if
    // the child doesn't exit. If the signal is already aborted at spawn
    // time we kill immediately.
    let cancelled = false;
    const onAbort = () => {
      if (cancelled) return;
      cancelled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000).unref();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Live streaming via the operator's chunk bus. POST each stdout
    // chunk to /api/internal/run-chunk; the operator publishes to an
    // in-process EventEmitter that the SSE handler subscribes to.
    // Sub-ms latency end-to-end vs ~10-50ms via fs.watch. Best-effort:
    // if the POST fails (operator down, network hiccup), the on-disk
    // JSONL still has the chunk and Phase 4 ingest-at-exit + the SSE
    // handler's fs.watch fallback keep the stream functional.
    child.stdout.on('data', (chunk: Buffer) => {
      jsonlChunks.push(chunk);
      const mySeq = chunkSeq;
      const myData = chunk.toString('utf8');
      let advancedSeq = false;
      if (harnessToken) {
        advancedSeq = true;
        // Serialize POSTs via Promise chain so chunks land in arrival
        // order at the bus even though fetch is async. Errors are
        // swallowed — never break the stream.
        chunkPostQueue = chunkPostQueue.then(async () => {
          try {
            await fetch(`${operatorBase}/api/internal/run-chunk`, {
              method: 'POST',
              headers: {
                'authorization': `Bearer ${harnessToken}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ runId, seq: mySeq, chunk: myData }),
            });
          } catch { /* operator unreachable; in-memory accumulator + Phase 4 covers post-run replay */ }
        });
      }
      // Optional: also persist to PG for archival per-chunk replay.
      // Independent queue from the bus POST; both share the seq number.
      if (chunksPgCtx && appendChunkPgFn) {
        advancedSeq = true;
        chunkPgQueue = chunkPgQueue.then(() => appendChunkPgFn!(chunksPgCtx!, runId, mySeq, myData));
      }
      if (advancedSeq) chunkSeq++;
    });
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    // EPIPE protection: if the subprocess exits before reading our stdin
    // (e.g. `true`, or a crashed claude binary), the write would throw an
    // unhandled EPIPE. Swallow it — the agent's exit code already tells
    // the caller something went wrong.
    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        ctx.log(`  stdin error: ${err.message}`);
      }
    });
    // Gate on streamFormat, not agentBackend: omp's @file convention
    // only applies when we're actually invoking omp/pi (streamFormat ===
    // 'omp-json'). For any other backend or for omp-with-stub-binary
    // (e.g. claudeCmd='cat' in tests), feed the prompt via stdin like
    // claude-code does — that's the universal Unix interface.
    if (streamFormat === 'omp-json') {
      try { child.stdin.end(); } catch { /* EPIPE-safe */ }
    } else {
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          ctx.log(`  stdin write error: ${(err as Error).message}`);
        }
      }
    }

    child.on('error', (err) => {
      ctx.log(`  spawn error: ${err.message}`);
      if (timer) clearTimeout(timer);
      if (mcpHandle) restoreSpawnMcp(mcpHandle);
      if (mcpTempDir) { try { rmSync(mcpTempDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
      if (codexHomeHandle) codexHomeHandle.cleanup();
      if (claudeConfigHandle) claudeConfigHandle.cleanup();
      void clearLane();
      resolve({ exitCode: 127, durationMs: Date.now() - startedAt });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (mcpHandle) restoreSpawnMcp(mcpHandle);
      if (mcpTempDir) { try { rmSync(mcpTempDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
      if (codexHomeHandle) codexHomeHandle.cleanup();
      if (claudeConfigHandle) claudeConfigHandle.cleanup();
      void clearLane();
      // bash uses exit 124 for timeout (matches `timeout` coreutil).
      const exitCode = timedOut ? 124 : (code ?? 0);
      resolve({ exitCode, durationMs: Date.now() - startedAt });
    });
  });

  // Drain the live-streaming POST queue + send a final close signal
  // so subscribers know the run finished. Best-effort throughout.
  if (harnessToken) {
    await chunkPostQueue.catch(() => {});
    try {
      await fetch(`${operatorBase}/api/internal/run-chunk`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${harnessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ runId, seq: chunkSeq, chunk: '', done: true }),
      });
    } catch { /* operator unreachable; subscribers fall back to file */ }
  }
  // Drain the optional PG-archival queue. If a chunk INSERT was still
  // in flight when the subprocess closed, this lets it complete before
  // Phase 4 finalization (run_output INSERT) runs.
  if (chunksPgCtx) {
    await chunkPgQueue.catch(() => {});
  }

  // 11. Extract result text from the in-memory accumulator.
  const jsonlBody = Buffer.concat(jsonlChunks).toString('utf8');
  const errBody = Buffer.concat(errChunks).toString('utf8');
  const finalText = extractResult(jsonlBody, streamFormat);
  const outBody = streamFormat !== 'none' ? `${finalText}\n` : finalText;

  // 11.5. Persistence: when ctx.pg is wired, the canonical record is
  // the harness_run_output row. The on-disk jsonl/out/err files are
  // skipped entirely — replay reads from PG.
  //
  // Files are still written when:
  //   - PG isn't wired (CLI fallback — user might tail -f), OR
  //   - PAPERCUSP_KEEP_FILES=1 (explicit override for debug)
  const writeFilesForFallback = !(ctx.pg && ctx.workspaceId)
    || process.env.PAPERCUSP_KEEP_FILES === '1';
  if (writeFilesForFallback) {
    if (!existsSync(ctx.logDir)) mkdirSync(ctx.logDir, { recursive: true });
    writeFileSync(jsonlPath, jsonlBody);
    writeFileSync(errPath, errBody);
    writeFileSync(outPath, outBody);
  }

  if (ctx.pg && ctx.workspaceId) {
    try {
      const { recordRunOutputPg } = await import('./run-output-pg');
      const { harnessSlug: getSlug } = await import('./state');
      await recordRunOutputPg(
        { pg: ctx.pg, workspaceId: ctx.workspaceId, harnessSlug: getSlug(ctx.projectDir) },
        {
          runId,
          role,
          promptBody: prompt,
          jsonlBody,
          outBody,
          errBody,
          exitCode: outcome.exitCode,
          durationMs: outcome.durationMs,
          startedAt,
          endedAt: Date.now(),
        },
      );
    } catch (err) {
      ctx.log(`  PG ingest failed (non-fatal): ${(err as Error).message}`);
    }
  }

  ctx.log(`invoke ${role} rc=${outcome.exitCode} (stdout: ${outPath})`);
  if (outcome.exitCode === 124) {
    ctx.log(`  role=${role} TIMED OUT after ${timeoutSeconds}s (rc=124)`);
  }
  if (outcome.exitCode !== 0) {
    const errSnippet = errBody.split(/\r?\n/).slice(0, 5);
    if (errSnippet.some((l) => l.length > 0)) {
      ctx.log('  stderr (first 5 lines):');
      for (const line of errSnippet) {
        if (line.length > 0) ctx.log(`    ${line}`);
      }
    }
  }

  // Phase 5: clean up the ephemeral omp prompt tmpdir. Always runs —
  // even on subprocess crash + PG-ingest failure — so /tmp doesn't
  // accumulate stale dirs. SIGKILL'd orchestrators leak; the OS sweeper
  // (systemd-tmpfiles on Linux, launchd on macOS) reaps them.
  if (ompPromptDir) {
    try { rmSync(ompPromptDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  return {
    output: finalText,
    jsonlPath,
    outPath,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
  };
}
