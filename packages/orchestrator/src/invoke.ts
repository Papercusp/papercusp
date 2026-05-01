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
import { fetchSubstrateContext } from './tiered-context';
import { resolvePromptFile } from './prompt-resolve';
import { extractFeatureId, makeRunId } from './run-id';
import type { InvokeResult } from './types';

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
 * Parse the final result text from a stream-json log. The terminal event has
 * `{"type":"result","result":"...","total_cost_usd":N,...}`. If parsing fails
 * (or the cmd wasn't claude), returns the file contents as-is.
 */
export function extractResult(jsonlPath: string, isStreamJson: boolean): string {
  let data = '';
  try { data = readFileSync(jsonlPath, 'utf8'); } catch { return ''; }
  if (!isStreamJson) return data;
  // Walk lines from the end — terminal "result" event is near the bottom.
  const lines = data.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && obj.type === 'result' && typeof obj.result === 'string') {
        return obj.result;
      }
    } catch {
      // Skip malformed lines — claude can interleave non-JSON occasionally.
    }
  }
  return '';
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
  const cmdMentionsClaude = argv.some((a) => a.includes('claude'));
  const cmdAlreadyHasStreamJson = ctx.claudeCmd.includes('stream-json');
  const isStreamJson = cmdMentionsClaude && !cmdAlreadyHasStreamJson;
  const extraFlags: string[] = isStreamJson
    ? ['--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    : [];

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
  const finalText = extractResult(jsonlPath, isStreamJson);
  writeFileSync(outPath, isStreamJson ? `${finalText}\n` : finalText);

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
