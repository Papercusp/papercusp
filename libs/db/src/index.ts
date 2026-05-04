export * from './schema';
export {
  getOrgPg,
  getOrgPgApp,
  getHarnessPg,
  _resetForTests,
  type OrgPgHandle,
} from './connection';
export { withWorkspace, withWorkspaceQuery } from './workspace-context';
export type { WorkspaceTxOptions } from './workspace-context';
export {
  getLegacyClient,
  withWorkspaceLegacy,
  type LegacyClient,
  type LegacyPrepared,
} from './legacy-shim';

// Spec-driven runtime helpers (Phase 4)
export {
  checkoutNextFeature,
  releaseExpired,
  releaseLock,
  setStatusAndRelease,
  type CheckoutOptions,
  type CheckedOutFeature,
} from './atomic-checkout';

export {
  checkProjectBudget,
  assertProjectBudget,
  BudgetExceededError,
  type BudgetCheckResult,
} from './budget-enforcement';

export {
  insertPendingEvent,
  listUnconsumedEvents,
  consumeEvent,
  consumeEvents,
  type InsertEventInput,
  type PendingEvent,
} from './pending-events';

export {
  listDueCronRoutines,
  fireRoutine,
  upsertRoutine,
  setRoutineActive,
  deleteRoutine,
  type RoutineRow,
} from './routines-runtime';

export {
  startRoutineTicker,
  type RoutineTickerOptions,
  type RoutineTickerHandle,
} from './routine-ticker';

export {
  getFeatureLineage,
  formatLineageForPrompt,
  createGoal,
  listGoals,
  type LineageRow,
} from './goal-lineage';
