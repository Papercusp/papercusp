/**
 * Resolve the orchestrator runtime environment from process env + config.
 *
 * Mirrors the top of bash run.sh: HARNESS_DIR, PROJECT_DIR, STATE_DIR,
 * LOG_DIR, MAX_ITERATIONS, CLAUDE, plus phase-aware HARNESS_PHASE / PORT /
 * DB_PATH derived from .harness/config.json.
 */
import { harnessRoot } from '@papercusp/harness/paths';
import { readConfig, resolvePhase } from './config';
import type { OrchestratorEnv } from './types';

export interface ResolvedPaths {
  harnessDir: string;
  projectDir: string;
  stateDir: string;
  logDir: string;
}

export function resolvePaths(): ResolvedPaths {
  const harnessDir = harnessRoot();
  const projectDir = process.env.PROJECT_DIR ?? process.cwd();
  const stateDir = `${projectDir}/.harness`;
  const logDir = `${stateDir}/logs`;
  return { harnessDir, projectDir, stateDir, logDir };
}

export function resolveEnv(): OrchestratorEnv & ResolvedPaths {
  const paths = resolvePaths();
  const cfg = readConfig(paths.stateDir);
  const { phase, port, dbPath } = resolvePhase(cfg);

  return {
    ...paths,
    maxIterations: parseInt(process.env.MAX_ITERATIONS ?? '200', 10),
    iterationSleep: parseFloat(process.env.ITERATION_SLEEP ?? '2'),
    claudeCmd: process.env.CLAUDE ?? 'claude -p',
    phase,
    port,
    dbPath,
  };
}
