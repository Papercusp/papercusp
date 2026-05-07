/**
 * Resolve the orchestrator runtime environment from process env + config.
 *
 * Mirrors the top of bash run.sh: HARNESS_DIR, PROJECT_DIR, STATE_DIR,
 * LOG_DIR, MAX_ITERATIONS, CLAUDE, plus phase-aware HARNESS_PHASE / PORT /
 * DB_PATH derived from .harness/config.json.
 */
import { harnessRoot } from '@papercusp/harness/paths';
import { readConfig, resolvePhase } from './config';
import type { AgentBackend, OrchestratorEnv } from './types';

/**
 * Resolve which agent backend to drive. Reads `AGENT_BACKEND` directly,
 * else infers from the agent command (`omp`/`pi` → omp, `claude` →
 * claude-code, anything else → omp). The explicit env var wins so users
 * can force the parser even when shelling through wrappers.
 */
export function resolveAgentBackend(agentCmd: string): AgentBackend {
  const explicit = (process.env.AGENT_BACKEND ?? '').trim().toLowerCase();
  if (explicit === 'omp' || explicit === 'pi') return 'omp';
  if (explicit === 'claude-code' || explicit === 'claude') return 'claude-code';
  // Infer from the binary name in agentCmd.
  const first = agentCmd.split(/\s+/).filter(Boolean)[0] ?? '';
  if (/(^|\/)(omp|pi)$/.test(first)) return 'omp';
  if (/(^|\/)claude$/.test(first)) return 'claude-code';
  return 'omp';
}

/**
 * Resolve the agent invocation command. `AGENT_CMD` wins over the
 * legacy `CLAUDE` env (back-compat) so existing harness installs keep
 * working without an env-var migration.
 */
export function resolveAgentCmd(): string {
  const fromAgent = process.env.AGENT_CMD;
  if (fromAgent && fromAgent.trim()) return fromAgent;
  return process.env.CLAUDE ?? 'omp -p';
}

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
  const claudeCmd = resolveAgentCmd();

  return {
    ...paths,
    maxIterations: parseInt(process.env.MAX_ITERATIONS ?? '200', 10),
    iterationSleep: parseFloat(process.env.ITERATION_SLEEP ?? '2'),
    claudeCmd,
    agentBackend: resolveAgentBackend(claudeCmd),
    phase,
    port,
    dbPath,
  };
}
