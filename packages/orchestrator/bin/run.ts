#!/usr/bin/env -S npx tsx
/**
 * Orchestrator CLI entry point. The TypeScript orchestrator is the
 * canonical and only main-loop driver as of 2026-05-08. The legacy
 * `PAPERCUSP_USE_TS_ORCHESTRATOR=0` bash-fallback was removed once
 * parity gaps G4/G5/G6 closed and operator spawn sites moved to TS.
 *
 * `bash run.sh` may still exist on disk for backward compat with
 * external callers (supervisor.sh, other harness scripts) but no
 * longer drives an iteration loop from this binary.
 */
import { configGet, readConfig } from '../src/config.js';
import { resolvePaths, resolveAgentBackend, resolveAgentCmd } from '../src/env.js';
import { createLogger } from '../src/log.js';
import { runMainLoop } from '../src/main-loop.js';
import { bootstrapOrchestratorPg } from '../src/pg-bootstrap.js';
import { activeWorkspaceId } from '../src/workspace.js';
import { harnessSlug } from '../src/state.js';

if (process.env.PAPERCUSP_USE_TS_ORCHESTRATOR === '0') {
  process.stderr.write(
    '[papercusp-orchestrate] WARN: PAPERCUSP_USE_TS_ORCHESTRATOR=0 is no longer honored.\n' +
    '  The bash run.sh fallback was retired 2026-05-08. Running TS regardless.\n',
  );
}

const { harnessDir, projectDir, stateDir, logDir } = resolvePaths();

async function runTs(): Promise<never> {
  const logger = createLogger(stateDir);
  logger.log('TS orchestrator active (default).');

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
  //
  // Pass the harness slug so the pg client's search_path scopes to the
  // per-harness schema (harness_<slug>,harness_shared,public). Phase 1's
  // unqualified `harness_features` queries resolve correctly via that
  // search_path — same pattern as the operator's `dbcFor(slug)`.
  const slug = harnessSlug(projectDir);
  const pgBoot = await bootstrapOrchestratorPg(logger.log, { harnessSlug: slug });
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

runTs().catch((err) => {
  process.stderr.write(
    `[papercusp-orchestrate] uncaught error in TS loop: ${(err as Error).message}\n`,
  );
  process.exit(1);
});
