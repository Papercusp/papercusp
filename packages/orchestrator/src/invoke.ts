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
import type { AgentBackend, InvokeResult } from './types';
import { resolveAgentBackend } from './env';
import { writeSignedSpawnMcp, type SpawnMcpHandle } from './spawn-mcp';
import { randomUUID } from 'node:crypto';
import { extractChunkId } from './spawn-mcp';

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
   * Agent backend driving the spawn. Selects structured-output flag set
   * + result parser. Defaults to inferring from `claudeCmd`.
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
   * PG client for the workspace's Postgres database. Phase 1+ migrate
   * features.json, lanes.json, escalation, sentinels, dispatches, and
   * checkpoints onto Postgres; while undefined, the orchestrator falls
   * back to the legacy filesystem state. Operator wires this up via
   * `getOrgPg()`; CLI mode bootstraps its own connection.
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

/** Per-role timeout from config.json (in seconds). 0 = no timeout. */
export function resolveTimeout(cfg: ReturnType<typeof readConfig>, role: string): number {
  const t = configGet<unknown>(cfg, `timeouts.${role}`, 0);
  if (typeof t === 'number' && t > 0 && Number.isFinite(t)) return Math.floor(t);
  return 0;
}

/** Per-role model. Config.json wins; falls back to AGENT_MODELS env JSON. */
export function resolveModel(cfg: ReturnType<typeof readConfig>, role: string): string {
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
 * What kind of structured stream the spawned agent is emitting. Drives
 * extra-flag selection AND result parsing.
 */
export type StreamFormat = 'claude-stream-json' | 'omp-json' | 'none';

export function selectStreamFormat(
  agentBackend: AgentBackend,
  agentCmd: string,
): StreamFormat {
  const argv = splitCommand(agentCmd);
  const cmd = agentCmd.toLowerCase();
  if (agentBackend === 'omp') {
    if (cmd.includes('--mode ')) return 'none';
    const mentionsOmp = argv.some((a) => /(?:^|\/)(omp|pi)$/.test(a));
    return mentionsOmp ? 'omp-json' : 'none';
  }
  if (cmd.includes('stream-json')) return 'none';
  const mentionsClaude = argv.some((a) => a.includes('claude'));
  return mentionsClaude ? 'claude-stream-json' : 'none';
}

export function streamFormatFlags(fmt: StreamFormat): string[] {
  switch (fmt) {
    case 'claude-stream-json':
      return ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    case 'omp-json':
      return ['--mode', 'json', '--no-session'];
    case 'none':
      return [];
  }
}

/**
 * Parse the final assistant text from a structured-stream log file.
 * `claude-stream-json` looks for `{type:"result",result:"..."}`; `omp-json`
 * walks back to the last `message_end` / `done` assistantMessageEvent.
 */
export function extractResult(jsonlPath: string, format: StreamFormat): string {
  let data = '';
  try { data = readFileSync(jsonlPath, 'utf8'); } catch { return ''; }
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
      } catch { /* claude interleaves non-JSON occasionally */ }
    }
    return '';
  }

  // omp-json
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'message_end' && obj.message?.role === 'assistant') {
      const text = collectAssistantText(obj.message);
      if (text) return text;
    }
    if (
      obj.type === 'message_update'
      && obj.assistantMessageEvent?.type === 'done'
      && obj.assistantMessageEvent.message
    ) {
      const text = collectAssistantText(obj.assistantMessageEvent.message);
      if (text) return text;
    }
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

  // 2. Feature ID + run ID.
  const featureId = extractFeatureId(extras);
  const featureTag = featureId ? `-${featureId}` : '';
  const nowSec = (ctx.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const runId = makeRunId(role, featureId, nowSec);

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

  // 4. Stream-JSON detection (only when the command involves `claude`).
  // Per-role overrides for cmd + extraArgs come from aiBackend config when
  // present; otherwise fall back to ctx.claudeCmd / no extra args. This
  // restores the half-implemented per-role-agent-cmd path that referenced
  // undefined `roleAgentCmd` and `roleExtraArgs` symbols.
  const aiBackend = configGet<Record<string, unknown>>(cfg, 'aiBackend', {} as Record<string, unknown>);
  const aiDefault = (aiBackend?.default as Record<string, unknown>) ?? {};
  const aiRoles = (aiBackend?.roles as Record<string, Record<string, unknown>>) ?? {};
  const aiRole = aiRoles[role] ?? {};
  const roleAgentCmd =
    (typeof aiRole.cmd === 'string' && aiRole.cmd) ||
    (typeof aiDefault.cmd === 'string' && aiDefault.cmd) ||
    ctx.claudeCmd;
  const roleExtraArgs: string[] =
    (Array.isArray(aiRole.extraArgs) ? aiRole.extraArgs : null) ??
    (Array.isArray(aiDefault.extraArgs) ? aiDefault.extraArgs : null) ??
    [];

  const argv = splitCommand(roleAgentCmd);
  const agentBackend: AgentBackend = ctx.agentBackend ?? resolveAgentBackend(roleAgentCmd);
  const streamFormat = selectStreamFormat(agentBackend, roleAgentCmd);
  const extraFlags: string[] = [...streamFormatFlags(streamFormat)];

  // 5. Per-role model — only inject if user didn't already pass --model.
  const cmdAlreadyHasModel = roleAgentCmd.includes('--model ');
  if (!cmdAlreadyHasModel) {
    const model = resolveModel(cfg, role);
    if (model) {
      extraFlags.push('--model', model);
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
    featureHistory,
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
    `history=${featureHistory.length}`,
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
  // not from stdin. Materialise the prompt and append `@<path>` to argv.
  let ompPromptPath: string | undefined;
  if (agentBackend === 'omp' && streamFormat !== 'none') {
    ompPromptPath = join(ctx.logDir, `${runId}.prompt.md`);
    writeFileSync(ompPromptPath, prompt, 'utf8');
    finalArgv.push(`@${ompPromptPath}`);
  }

  // Open the output streams ourselves so we can control buffering.
  // Use writeFileSync to truncate, then append as data arrives.
  writeFileSync(jsonlPath, '');
  writeFileSync(errPath, '');

  const outcome: SpawnOutcome = await new Promise((resolve) => {
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
    if (ctx.workspaceId) {
      try {
        const spawnId = randomUUID();
        const slug = harnessSlugFromProjectDir(ctx.projectDir);
        const chunkId = extractChunkId(extras);
        // writeSignedSpawnMcp: writes .mcp.json AND HMAC-signs the URL
        // params so the operator can verify the spawn ctx wasn't
        // rewritten by the agent. See apps/operator/lib/spawn-signing.ts
        // (verification) and apps/operator/docs/spawn-signing-threat-model.md.
        // Signing is best-effort — falls back to unsigned URL if PG
        // unreachable; the operator is in soft-warn mode until
        // PAPERCUSP_REQUIRE_SPAWN_SIG=1.
        mcpHandle = await writeSignedSpawnMcp(cwd, {
          harnessSlug: slug,
          workspaceId: ctx.workspaceId,
          role,
          runId,
          spawnId,
          featureId: featureId || null,
          chunkId,
          parentSpawnId: options.parentSpawnId ?? null,
        });
      } catch (err) {
        ctx.log(`  spawn-mcp write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const child = spawn(command, finalArgv, { cwd, env: spawnEnv, stdio: ['pipe', 'pipe', 'pipe'] });

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
    if (agentBackend === 'omp') {
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
      resolve({ exitCode: 127, durationMs: Date.now() - startedAt });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (mcpHandle) restoreSpawnMcp(mcpHandle);
      // bash uses exit 124 for timeout (matches `timeout` coreutil).
      const exitCode = timedOut ? 124 : (code ?? 0);
      resolve({ exitCode, durationMs: Date.now() - startedAt });
    });
  });

  // 11. Extract result text and write to .out.
  const finalText = extractResult(jsonlPath, streamFormat);
  writeFileSync(outPath, streamFormat !== 'none' ? `${finalText}\n` : finalText);

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
