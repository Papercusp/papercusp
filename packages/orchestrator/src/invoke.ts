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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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
  type SpawnMcpHandle,
  type SpawnCodexHomeHandle,
} from './spawn-mcp';
import { randomUUID } from 'node:crypto';
import type { AgentBackend, InvokeResult } from './types';
import { resolveAgentBackend, normalizeModelForBackend } from './env';

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
  /** STATE_DIR — usually `<projectDir>/.harness`. */
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

/** Per-role model resolution. Per-harness `.harness/config.json` wins
    over the user-level `AGENT_MODELS` env var (which the operator's
    /settings/agent page writes). Empty string = use the agent CLI's
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
  if (!envJson) return '';
  try {
    const map = JSON.parse(envJson);
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      const v = (map as Record<string, unknown>)[role];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch { /* malformed AGENT_MODELS — silently ignore */ }
  return '';
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
      // `codex exec --json` → JSONL events. Orchestrator spawns are always
      // autonomous and need MCP tool calls + shell to run un-gated, so the
      // sandbox/approval bypass is unconditional here (under `-s read-only`
      // codex CANCELS MCP tool calls — handoff §8). `--skip-git-repo-check`
      // lets it run in non-repo cwds; `--ephemeral` keeps no rollout on disk.
      // Model (`-m`), the prompt stdin `-`, and CODEX_HOME/MCP are wired in
      // the spawn path (model flag is backend-aware; codex has no .mcp.json).
      return ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox'];
    case 'none':
      return [];
  }
}

/**
 * Extra CLI args that make claude-code actually load + trust the per-spawn
 * signed `.mcp.json`.
 *
 * omp path-discovers `<cwd>/.mcp.json` and connects automatically.
 * claude-code does NOT: it treats a project `.mcp.json` as "pending
 * approval" and, in headless `-p` mode (no way to approve), never connects
 * to it (verified against claude 2.1.158 — `claude mcp get` reports
 * unapproved `.mcp.json` servers as "⏸ Pending approval and not connected
 * to"). `--mcp-config <path>` loads AND trusts the file directly (bypassing
 * the approval gate); `--strict-mcp-config` restricts the worker to ONLY
 * that server, not the engineer's personal `~/.claude.json` fleet;
 * `--permission-mode bypassPermissions` stops the unattended spawn from
 * blocking on a per-tool approval prompt (workers run in isolated worktrees).
 *
 * Returns `[]` for any non-claude backend, a non-claude stream, when no
 * workspace is set (the `.mcp.json` is only written when `ctx.workspaceId`
 * is present), or for whichever flags the user already put in AGENT_CMD.
 */
export function claudeMcpArgs(
  agentBackend: AgentBackend,
  streamFormat: StreamFormat,
  roleAgentCmd: string,
  mcpConfigPath: string,
  hasWorkspace: boolean,
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
  if (
    !roleAgentCmd.includes('--permission-mode') &&
    !roleAgentCmd.includes('--dangerously-skip-permissions') &&
    !roleAgentCmd.includes('--allow-dangerously-skip-permissions')
  ) {
    out.push('--permission-mode', 'bypassPermissions');
  }
  return out;
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
    const resolved = resolvePromptFile(
      { harnessDir: ctx.harnessDir, phase: ctx.phase, dept },
      role,
    );
    if (!resolved) {
      throw new Error(
        `invoke: no prompt file for role=${role} (looked under ${ctx.harnessDir}/prompts)`,
      );
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

  // 7. Per-role prompt override.
  const promptOverride = resolvePromptOverride(cfg, ctx.stateDir, role);
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

  // 10b. claude-code MCP wiring — make claude load + trust the per-spawn
  // signed .mcp.json that writeSignedSpawnMcp drops into cwd below (omp
  // path-discovers it; claude won't without these flags). See claudeMcpArgs.
  finalArgv.push(
    ...claudeMcpArgs(
      agentBackend,
      streamFormat,
      roleAgentCmd,
      join(cwd, '.mcp.json'),
      Boolean(ctx.workspaceId),
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
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(ctx.extraSpawnEnv ?? {}),
      ...(options.extraEnv ?? {}),
      OMP_MEMORIES_ENABLED: 'false',
      OMP_MEMORY_BACKEND: 'off',
      PI_MEMORIES_ENABLED: 'false',
      PI_MEMORY_BACKEND: 'off',
    };

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
        // point the child at it. omp/claude keep the `.mcp.json` path.
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
          mcpHandle = await writeSignedSpawnMcp(cwd, signedInput);
        }
      } catch (err) {
        ctx.log(`  spawn-mcp write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const child = spawn(command, finalArgv, { cwd, env: spawnEnv, stdio: ['pipe', 'pipe', 'pipe'] });

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
      if (codexHomeHandle) codexHomeHandle.cleanup();
      void clearLane();
      resolve({ exitCode: 127, durationMs: Date.now() - startedAt });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (mcpHandle) restoreSpawnMcp(mcpHandle);
      if (codexHomeHandle) codexHomeHandle.cleanup();
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
