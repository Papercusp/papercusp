/**
 * User-defined hook runner. Mirrors bash's `run_hook <name>`:
 *
 *   - Looks for `<stateDir>/hooks/<name>.sh`
 *   - If executable, runs it with cwd = projectDir and env from caller
 *   - Captures stdout/stderr to `<stateDir>/logs/hooks/<ts>-<name>.log`
 *   - Logs failures but never aborts the mission
 *
 * Used at lifecycle points (pre-worker, post-worker, pre-validator,
 * post-validator, on-smoke-pass, on-smoke-fail, on-competition-start,
 * on-competition-won, afterDone). Each hook receives env vars set by the
 * caller — typically ROLE / FEATURE_ID / RC / REASON / TRIGGER.
 *
 * On Windows: the user must have bash on PATH (Git for Windows ships it).
 * The desktop bootstrap UI surfaces this prereq when `bash` isn't found.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface RunHookOptions {
  /** State dir where `hooks/<name>.sh` lives. */
  stateDir: string;
  /** Project dir used as cwd for the hook script. */
  projectDir: string;
  /** Log dir where hook output lands; usually `<stateDir>/logs`. */
  logDir: string;
  /** Env vars to pass to the hook (merged on top of process.env). */
  env: Record<string, string>;
  /** Logger for the orchestrator's run.log. */
  log: (message: string) => void;
}

export interface RunHookResult {
  /** Whether a hook was run (false = no script, no script-not-executable). */
  ran: boolean;
  /** Exit code if ran. Undefined if not. */
  exitCode?: number;
  /** Path to the hook log file if ran. */
  logfile?: string;
}

export function runHook(hookName: string, opts: RunHookOptions): RunHookResult {
  const script = join(opts.stateDir, 'hooks', `${hookName}.sh`);
  if (!isExecutable(script)) {
    return { ran: false };
  }

  const hookLogDir = join(opts.logDir, 'hooks');
  if (!existsSync(hookLogDir)) {
    mkdirSync(hookLogDir, { recursive: true });
  }
  const ts = Math.floor(Date.now() / 1000);
  const logfile = join(hookLogDir, `${ts}-${hookName}.log`);
  writeFileSync(logfile, ''); // truncate

  opts.log(`HOOK ${hookName} running (log: ${logfile})`);

  const result = spawnSync(script, [], {
    cwd: opts.projectDir,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Append both streams to the hook log file (combined, like bash 2>&1).
  if (result.stdout) appendFileSync(logfile, result.stdout);
  if (result.stderr) appendFileSync(logfile, result.stderr);

  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    opts.log(`  HOOK ${hookName} failed rc=${exitCode} — continuing (see ${logfile})`);
  }
  return { ran: true, exitCode, logfile };
}

function isExecutable(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    // Owner-execute bit. Node doesn't expose access(X_OK) sync-friendly; bit
    // mask is the safest cross-platform check.
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
