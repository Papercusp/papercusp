#!/usr/bin/env -S npx tsx
/**
 * Orchestrator CLI entry point. The TypeScript orchestrator is the
 * default; `PAPERCUSP_USE_TS_ORCHESTRATOR=0` opts back into bash
 * `run.sh` (deprecated, scheduled for removal — kept only as an
 * emergency escape hatch).
 *
 * Routing logic:
 *   - flag unset (default) → run the TS main loop end-to-end. All
 *     decision verbs are handled including NEXT_EXPERT / NEXT_FEEDBACK /
 *     NEXT_SCOPER (formerly bash-only).
 *   - PAPERCUSP_USE_TS_ORCHESTRATOR=0 → fall back to bash run.sh.
 *     Use only if you hit a TS bug in production AND need to ship; file
 *     a parity issue at the same time so we can delete run.sh.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { configGet, readConfig } from '../src/config.js';
import { resolvePaths, resolveAgentBackend, resolveAgentCmd } from '../src/env.js';
import { createLogger } from '../src/log.js';
import { runMainLoop } from '../src/main-loop.js';
import { bootstrapOrchestratorPg } from '../src/pg-bootstrap.js';
import { activeWorkspaceId } from '../src/workspace.js';
import { harnessSlug } from '../src/state.js';

// TS is the default. Set PAPERCUSP_USE_TS_ORCHESTRATOR=0 to opt OUT
// (back to bash run.sh) — emergency escape hatch only.
const useTs = process.env.PAPERCUSP_USE_TS_ORCHESTRATOR !== '0';
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
