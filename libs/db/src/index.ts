export * from './schema';
export {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
  schemaOf,
} from './schema/zod';
export {
  getOrgPg,
  getOrgPgApp,
  getHarnessPg,
  typedSql,
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
  withProjectBudget,
  BudgetExceededError,
  type BudgetCheckResult,
} from './budget-enforcement';

export {
  withSerializableRetry,
  SerializableRetryExhaustedError,
  type SerializableRetryOptions,
} from './with-serializable-retry';

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
  getFeatureLineage,
  formatLineageForPrompt,
  createGoal,
  listGoals,
  type LineageRow,
} from './goal-lineage';
