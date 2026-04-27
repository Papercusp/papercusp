#!/usr/bin/env -S npx tsx
/**
 * Orchestrator CLI entry point. Equivalent to invoking
 * `bash <harness>/run.sh`, but routes through the TypeScript implementation
 * when `PAPERCUSP_USE_TS_ORCHESTRATOR=1` is set.
 *
 * Routing logic:
 *   - flag unset → spawn bash run.sh (current default; preserves all
 *     production behavior until full TS port lands)
 *   - flag set + decision is one of DONE/IDLE/ESCALATE/CHECKPOINT/
 *     unparsable → handled in TS, exits with bash-equivalent code
 *   - flag set + decision is a NEXT_* branch → emits a "fallback" log
 *     line and hands off to bash run.sh so the existing per-feature
 *     branching keeps working until Stages 2c+ port them
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { configGet, readConfig } from '../src/config.js';
import { resolvePaths } from '../src/env.js';
import { createLogger } from '../src/log.js';
import { runMainLoop } from '../src/main-loop.js';

const useTs = process.env.PAPERCUSP_USE_TS_ORCHESTRATOR === '1';
const { harnessDir, projectDir, stateDir, logDir } = resolvePaths();
const runShPath = `${harnessDir}/run.sh`;

if (!existsSync(runShPath)) {
  process.stderr.write(
    `[papercusp-orchestrate] ERROR: ${runShPath} not found.\n` +
      'Set PAPERCUSP_HARNESS_DIR or place the @papercusp/harness package on disk.\n',
  );
  process.exit(2);
}

function runBash(): never {
  const child = spawn('bash', [runShPath], {
    cwd: projectDir,
    env: {
      ...process.env,
      HARNESS_DIR: harnessDir,
      PROJECT_DIR: projectDir,
    },
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    process.stderr.write(
      `[papercusp-orchestrate] failed to spawn bash: ${err.message}\n`,
    );
    process.exit(127);
  });
  // never returns — the exit handler does
  return undefined as never;
}

async function runTs(): Promise<never> {
  const logger = createLogger(stateDir);
  logger.log('PAPERCUSP_USE_TS_ORCHESTRATOR=1 set — TS orchestrator active');

  const cfg = readConfig(stateDir);
  const phase = (cfg.phase as string) ?? 'staging';
  const claudeCmd = process.env.CLAUDE ?? 'claude -p';
  const maxIterations = parseInt(process.env.MAX_ITERATIONS ?? '200', 10);
  const iterationSleepMs = (parseFloat(process.env.ITERATION_SLEEP ?? '2') || 0) * 1000;

  const exit = await runMainLoop({
    ctx: {
      harnessDir,
      projectDir,
      stateDir,
      logDir,
      phase,
      claudeCmd,
      dept: configGet<string>(cfg, 'dept', ''),
      log: logger.log,
    },
    logger,
    maxIterations,
    iterationSleepMs,
  });

  if (exit.reason === 'todo-branch') {
    logger.log(
      'Hand-off: complex decision branch not yet ported. Falling back to bash run.sh.',
    );
    runBash();
  }
  process.exit(exit.exitCode);
}

if (useTs) {
  runTs().catch((err) => {
    process.stderr.write(
      `[papercusp-orchestrate] uncaught error in TS loop: ${(err as Error).message}\n`,
    );
    process.exit(1);
  });
} else {
  runBash();
}
