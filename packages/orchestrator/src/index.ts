/**
 * @papercusp/orchestrator — TypeScript port of the harness orchestrator
 * (`run.sh`). Drops the bash prereq for Windows users while keeping
 * `claude -p` shell-out so Claude Max subscriptions continue to work.
 *
 * Status: STAGE 0 — skeleton + read-only utilities only. The actual
 * iteration loop still goes through bash run.sh until later stages port
 * `invoke()`, the main while loop, and worktree/branch isolation.
 *
 * Feature flag (set by Tauri's main.rs spawn for the desktop bundle):
 *
 *   PAPERCUSP_USE_TS_ORCHESTRATOR=1
 *
 * When unset / != 1, the bin/run.ts entry point exec's bash run.sh instead.
 */
export { readConfig, configGet, resolvePhase } from './config.js';
export {
  readFeatures,
  featuresExist,
  featureAttempts,
  setFeatureStatus,
  harnessSlug,
  passedFraction,
} from './state.js';
export { createLogger } from './log.js';
export { resolvePaths, resolveEnv } from './env.js';
export type {
  HarnessPhase,
  HarnessKind,
  HarnessConfig,
  PhaseConfig,
  FeatureRecord,
  FeaturesJson,
  OrchestratorEnv,
  OrchestratorDecision,
  InvokeResult,
} from './types.js';
