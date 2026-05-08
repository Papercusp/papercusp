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
  appendFileSync,
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

/**
 * Postgres client interface the orchestrator uses for PG-canonical state.
 * Kept as a structural type so callers can pass any postgres-js Sql<{}>
 * instance (or a test double) without importing `postgres` here. When
 * undefined, the orchestrator falls back to the legacy filesystem path
 * (features.json etc) — that fallback is removed once Phase 1 lands.
 */
export interface OrchestratorPg {
  // postgres-js tagged-template signature: pg`SELECT ...`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (template: TemplateStringsArray, ...values: unknown[]): Promise<any[]>;
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

/** Per-role model resolution. Per-harness `.harness/config.json` wins
    over the user-level `AGENT_MODELS` env var (which the operator's
    /settings/agent page writes). Empty string = use the agent CLI's
    default. */
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
 * What kind of structured stream the spawned agent is emitting (or `none` for
 * plain-text / passthrough commands). Drives both the extra flag set we
 * append AND the result-extraction parser.
 */
export type StreamFormat = 'claude-stream-json' | 'omp-json' | 'none';

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
    case 'none':
      return [];
  }
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
      } catch { /* claude can interleave non-JSON occasionally */ }
    }
    return '';
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
export async function invoke(
  ctx: InvokeContext,
  role: string,
  extras: readonly string[] = [],
): Promise<InvokeResult> {
  const cfg = readConfig(ctx.stateDir);
  const dept = ctx.dept ?? configGet<string>(cfg, 'dept', '');

  // 1. Resolve prompt file (with phase + dept fallback chain).
  const promptFile = resolvePromptFile(
    { harnessDir: ctx.harnessDir, phase: ctx.phase, dept },
    role,
  );
  if (!promptFile) {
    throw new Error(
      `invoke: no prompt file for role=${role} (looked under ${ctx.harnessDir}/prompts)`,
    );
  }

  // 2. Feature ID + run ID.
  const featureId = extractFeatureId(extras);
  const featureTag = featureId ? `-${featureId}` : '';
  const nowSec = (ctx.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const runId = makeRunId(role, featureId, nowSec);

  // 3. Worktree cwd override.
  let cwdOverride = '';
  if (featureId && ctx.worktreePathFor) {
    const wt = ctx.worktreePathFor(featureId) ?? '';
    if (wt && existsSync(wt)) cwdOverride = wt;
  }

  // 4. Backend-aware structured-stream detection. Defaults to inferring
  //    from the binary name in claudeCmd (omp/pi → omp, otherwise claude-code).
  const argv = splitCommand(ctx.claudeCmd);
  const agentBackend: AgentBackend = ctx.agentBackend ?? resolveAgentBackend(ctx.claudeCmd);
  const streamFormat = selectStreamFormat(agentBackend, ctx.claudeCmd);
  const extraFlags: string[] = [...streamFormatFlags(streamFormat)];

  // 5. Per-role model — only inject if user didn't already pass --model.
  const cmdAlreadyHasModel = ctx.claudeCmd.includes('--model ');
  if (!cmdAlreadyHasModel) {
    const model = resolveModel(cfg, role);
    if (model) {
      extraFlags.push('--model', model);
      ctx.log(`  role=${role} model=${model} (from config.json)`);
    }
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

  // 9. Build the prompt.
  const prompt = buildPrompt({
    role,
    promptFile,
    promptOverride,
    stateDir: ctx.stateDir,
    harnessDir: ctx.harnessDir,
    projectDir: ctx.projectDir,
    cwdOverride,
    featureId,
    runId,
    extras,
    substrateContext,
  });

  // 10. Spawn claude.
  if (!existsSync(ctx.logDir)) mkdirSync(ctx.logDir, { recursive: true });
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

  // Open the output streams ourselves so we can control buffering.
  // Use writeFileSync to truncate, then append as data arrives.
  writeFileSync(jsonlPath, '');
  writeFileSync(errPath, '');

  const outcome: SpawnOutcome = await new Promise((resolve) => {
    const child = spawn(command, finalArgv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk: Buffer) => appendFileSync(jsonlPath, chunk));
    child.stderr.on('data', (chunk: Buffer) => appendFileSync(errPath, chunk));

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
      resolve({ exitCode: 127, durationMs: Date.now() - startedAt });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      // bash uses exit 124 for timeout (matches `timeout` coreutil).
      const exitCode = timedOut ? 124 : (code ?? 0);
      resolve({ exitCode, durationMs: Date.now() - startedAt });
    });
  });

  // 11. Extract result text and write to .out.
  const finalText = extractResult(jsonlPath, streamFormat);
  writeFileSync(outPath, streamFormat !== 'none' ? `${finalText}\n` : finalText);

  // 11.5. PG ingest (Phase 4): when ctx.pg is wired, dump the run's
  // jsonl/out/err into harness_run_output as a single canonical row.
  // Files remain on disk for live tail + retention pruning; PG holds the
  // post-hoc replayable copy. Best-effort: a PG failure mustn't fail the
  // run.
  if (ctx.pg && ctx.workspaceId) {
    try {
      const { recordRunOutputPg } = await import('./run-output-pg');
      const { harnessSlug: getSlug } = await import('./state');
      let jsonlBody = '';
      let outBody = '';
      let errBody = '';
      try { jsonlBody = readFileSync(jsonlPath, 'utf8'); } catch { /* missing */ }
      try { outBody = readFileSync(outPath, 'utf8'); } catch { /* missing */ }
      try { errBody = readFileSync(errPath, 'utf8'); } catch { /* missing */ }
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
    try {
      const errSnippet = readFileSync(errPath, 'utf8').split(/\r?\n/).slice(0, 5);
      if (errSnippet.some((l) => l.length > 0)) {
        ctx.log('  stderr (first 5 lines):');
        for (const line of errSnippet) {
          if (line.length > 0) ctx.log(`    ${line}`);
        }
      }
    } catch {
      // ignore — log was just a courtesy
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
