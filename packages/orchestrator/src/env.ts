/**
 * Resolve the orchestrator runtime environment from process env + config.
 *
 * Mirrors the top of bash run.sh: HARNESS_DIR, PROJECT_DIR, STATE_DIR,
 * LOG_DIR, MAX_ITERATIONS, CLAUDE, plus phase-aware HARNESS_PHASE / PORT /
 * DB_PATH derived from .papercusp/config.json.
 */
import { harnessRoot } from '@papercusp/harness/paths';
import { resolvePhase } from './config';
import { readEffectiveConfig } from './effective-config';
import type { AgentBackend, OrchestratorEnv } from './types';

/**
 * Resolve which agent backend to drive. Reads `AGENT_BACKEND` directly,
 * else infers from the agent command (`omp` keyword → omp, otherwise
 * claude-code). The explicit env var wins so users can force the parser
 * even when shelling through wrappers.
 */
export function resolveAgentBackend(agentCmd: string): AgentBackend {
  const explicit = (process.env.AGENT_BACKEND ?? '').trim().toLowerCase();
  if (explicit === 'omp' || explicit === 'pi') return 'omp';
  if (explicit === 'claude-code' || explicit === 'claude') return 'claude-code';
  if (explicit === 'codex') return 'codex';
  // Infer from the binary name in agentCmd.
  const first = agentCmd.split(/\s+/).filter(Boolean)[0] ?? '';
  if (/(^|\/)(omp|pi)$/.test(first)) return 'omp';
  if (/(^|\/)codex$/.test(first)) return 'codex';
  return 'claude-code';
}

/**
 * Normalize a model id for the target backend's CLI.
 *
 * omp uses the explicit `provider/model` form (e.g.
 * `anthropic/claude-opus-4-7`), and that is what the operator's
 * /settings/agent page + per-harness config.json store. The claude CLI's
 * `--model`, however, rejects the provider prefix — it wants a bare id
 * (`claude-opus-4-7`) or an alias (`opus`/`sonnet`/`haiku`). So for the
 * claude-code backend we strip a single leading `provider/` segment;
 * for omp (and an already-bare id) we pass the value through untouched.
 * codex's `-m` likewise wants a bare id (`gpt-5.5`), so it strips the
 * provider prefix the same way claude-code does. Empty in → empty out.
 */
export function normalizeModelForBackend(model: string, backend: AgentBackend): string {
  if (!model) return '';
  if (backend !== 'claude-code' && backend !== 'codex') return model;
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(slash + 1) : model;
}

/**
 * Resolve the agent invocation command. `AGENT_CMD` wins over the
 * legacy `CLAUDE` env (back-compat) so existing harness installs keep
 * working without an env-var migration.
 */
export function resolveAgentCmd(): string {
  const fromAgent = process.env.AGENT_CMD;
  if (fromAgent && fromAgent.trim()) return fromAgent;
  return process.env.CLAUDE ?? 'claude -p';
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
  const stateDir = `${projectDir}/.papercusp`;
  const logDir = `${stateDir}/logs`;
  return { harnessDir, projectDir, stateDir, logDir };
}

export function resolveEnv(): OrchestratorEnv & ResolvedPaths {
  const paths = resolvePaths();
  const cfg = readEffectiveConfig(paths.stateDir);
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
