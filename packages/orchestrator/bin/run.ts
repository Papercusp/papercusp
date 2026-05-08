#!/usr/bin/env -S npx tsx
/**
 * Orchestrator CLI entry point. Equivalent to invoking
 * `bash <harness>/run.sh`, but routes through the TypeScript implementation
 * when `PAPERCUSP_USE_TS_ORCHESTRATOR=1` is set.
 *
 * Routing logic:
 *   - flag unset → spawn bash run.sh (default until parity is verified
 *     in production)
 *   - flag set → run the TS main loop end-to-end; every decision branch
 *     is now handled in TS (Stage 5a closed the last gap)
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { configGet, readConfig } from '../src/config.js';
import { resolvePaths, resolveAgentBackend, resolveAgentCmd } from '../src/env.js';
import { createLogger } from '../src/log.js';
import { runMainLoop } from '../src/main-loop.js';
import { bootstrapOrchestratorPg } from '../src/pg-bootstrap.js';
import { activeWorkspaceId } from '../src/workspace.js';

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
  const claudeCmd = resolveAgentCmd();
  const agentBackend = resolveAgentBackend(claudeCmd);
  const maxIterations = parseInt(process.env.MAX_ITERATIONS ?? '200', 10);
  const iterationSleepMs = (parseFloat(process.env.ITERATION_SLEEP ?? '2') || 0) * 1000;

  // Activation step 2: opt-in PG bootstrap. PAPERCUSP_USE_PG_STATE=1
  // attempts to connect; on success, ctx.pg + ctx.workspaceId are set
  // and Phases 1-7's PG-canonical paths run. On failure, the dormant
  // FS fallbacks remain — orchestrator behavior unchanged.
  const pgBoot = await bootstrapOrchestratorPg(logger.log);
  const workspaceId = pgBoot.pg ? activeWorkspaceId() : undefined;

  try {
    const exit = await runMainLoop({
      ctx: {
        harnessDir,
        projectDir,
        stateDir,
        logDir,
        phase,
        claudeCmd,
        agentBackend,
        dept: configGet<string>(cfg, 'dept', ''),
        log: logger.log,
        ...(pgBoot.pg ? { pg: pgBoot.pg, workspaceId } : {}),
      },
      logger,
      maxIterations,
      iterationSleepMs,
    });
    if (pgBoot.cleanup) await pgBoot.cleanup();
    process.exit(exit.exitCode);
  } catch (err) {
    if (pgBoot.cleanup) await pgBoot.cleanup();
    throw err;
  }
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
