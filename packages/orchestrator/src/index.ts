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
export { readConfig, configGet, resolvePhase } from './config';
export {
  readFeatures,
  featuresExist,
  featureAttempts,
  setFeatureStatus,
  harnessSlug,
  passedFraction,
} from './state';
export { createLogger } from './log';
export { resolvePaths, resolveEnv } from './env';
export { promptCandidates, resolvePromptFile } from './prompt-resolve';
export type { PromptResolveContext } from './prompt-resolve';
export { extractFeatureId, makeRunId } from './run-id';
export { buildPrompt } from './prompt-build';
export type { BuildPromptInput } from './prompt-build';
export { assembleRolePrompt, lookupProjectDir } from './role-prompt-from-slug';
export type {
  AssembleRolePromptOptions,
  AssembledPrompt,
  RolePromptMode,
} from './role-prompt-from-slug';
export {
  invoke,
  splitCommand,
  extractResult,
  resolvePromptOverride,
  resolveTimeout,
  resolveModel,
} from './invoke';
export type { InvokeContext } from './invoke';
export { parseDecision, DECISION_VERBS } from './decision-parse';
export type { DecisionVerb, ParsedDecision } from './decision-parse';
export { checkpointGate } from './checkpoints';
export type { CheckpointAction } from './checkpoints';
export { runMainLoop } from './main-loop';
export type { MainLoopOptions, MainLoopExit } from './main-loop';
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
} from './branch-iso';
export type { BranchIsoCtx } from './branch-iso';
export { git, branchExists, hasStagedChanges } from './git';
export type { GitResult, GitOptions } from './git';
export { runHook } from './hooks';
export type { RunHookOptions, RunHookResult } from './hooks';
export {
  extractActionsBlock,
  parseActionsJson,
  processActionsBlock,
} from './actions-block';
export type {
  ProcessActionsOptions,
  ProcessActionsResult,
} from './actions-block';
export { evaluateCostCap, sumJsonlCost } from './cost-cap';
export type { CostCapResult } from './cost-cap';
export { pruneLogs } from './prune-logs';
export type { PruneResult } from './prune-logs';
export { snapshotState } from './snapshot-state';
export type { SnapshotResult } from './snapshot-state';
export { runPreLoop } from './pre-loop';
export type { PreLoopResult } from './pre-loop';
export {
  firePluginHook,
  findFireHookCli,
  pluginSearchPaths,
} from './plugin-hooks';
export type {
  FirePluginHookOptions,
  FirePluginHookResult,
} from './plugin-hooks';
export {
  buildCompetitionManifest,
  competitionManifestPath,
  createLanePool,
  isCompetitionMode,
  isLaneMode,
  parallelMaxWorkers,
  parallelMode,
  parseCompetitionVerdict,
  readCompetitionManifest,
  writeCompetitionManifest,
} from './lanes';
export type {
  CompetitionLane,
  CompetitionManifest,
  CompetitionVerdict,
  LanePool,
  LaneRecord,
} from './lanes';
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
} from './types';
