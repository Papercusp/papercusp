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
export { promptCandidates, resolvePromptFile } from './prompt-resolve.js';
export type { PromptResolveContext } from './prompt-resolve.js';
export { extractFeatureId, makeRunId } from './run-id.js';
export { buildPrompt } from './prompt-build.js';
export type { BuildPromptInput } from './prompt-build.js';
export {
  invoke,
  splitCommand,
  extractResult,
  resolvePromptOverride,
  resolveTimeout,
  resolveModel,
} from './invoke.js';
export type { InvokeContext } from './invoke.js';
export { parseDecision, DECISION_VERBS } from './decision-parse.js';
export type { DecisionVerb, ParsedDecision } from './decision-parse.js';
export { checkpointGate } from './checkpoints.js';
export type { CheckpointAction } from './checkpoints.js';
export { runMainLoop } from './main-loop.js';
export type { MainLoopOptions, MainLoopExit } from './main-loop.js';
export {
  branchIsoEnabled,
  worktreeEnabled,
  worktreePath,
  branchIsoBase,
  branchIsoPreWorker,
  branchIsoPostWorker,
  branchIsoPreValidator,
  branchIsoPostValidator,
  worktreeReset,
} from './branch-iso.js';
export type { BranchIsoCtx } from './branch-iso.js';
export { git, branchExists, hasStagedChanges } from './git.js';
export type { GitResult, GitOptions } from './git.js';
export { runHook } from './hooks.js';
export type { RunHookOptions, RunHookResult } from './hooks.js';
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
