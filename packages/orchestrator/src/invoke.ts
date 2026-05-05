/**
 * `invoke <role> [extras...]` — spawn `claude -p` (or whatever $CLAUDE
 * resolves to) with the assembled prompt on stdin, capturing two outputs:
 *
 *   <logDir>/<runId>.jsonl  — raw stream-json events (UI tails this)
 *   <logDir>/<runId>.out    — the final result text (orchestrator parses this)
 *   <logDir>/<runId>.err    — stderr (logged on non-zero exit)
 *
 * Mirrors bash run.sh's invoke() function. Keeps `claude -p` as a child
 * process specifically so users on Claude Max subscriptions continue to
 * authenticate via Claude Code's CLI session — the SDK route would lose
 * that capability.
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { configGet, readConfig } from './config';
import { buildPrompt } from './prompt-build';
import { resolvePromptFile } from './prompt-resolve';
import { extractFeatureId, makeRunId } from './run-id';
import type { AgentBackend, InvokeResult } from './types';
import { resolveAgentBackend } from './env';

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
  /** $CLAUDE invocation template. e.g. `claude -p` or `claude -p --model sonnet`. */
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

/** Per-role model from config.json (e.g. "sonnet"). */
export function resolveModel(cfg: ReturnType<typeof readConfig>, role: string): string {
  const m = configGet<string>(cfg, `models.${role}`, '');
  return m;
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
 * Run `claude -p` (or override) for a given role. Returns the captured result.
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

  // 4. Stream-JSON detection (only when the command involves `claude`).
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
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        ctx.log(`  stdin write error: ${(err as Error).message}`);
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

  return {
    output: finalText,
    jsonlPath,
    outPath,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
  };
}
