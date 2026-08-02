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
  getOrgPgLosslessBigint,
  getHarnessPg,
  typedSql,
  processConnectionCeiling,
  logConnectionBudget,
  maybePgbouncer,
  setAdminPoolStatementTimeoutProvider,
  _resetForTests,
  PG_BIGINT_AS_NUMBER_TYPES,
  restoreRawDateSerializers,
  restoreRawJsonbSerializer,
  longLivedPoolConnectionOptions,
  poolIdleTimeoutSec,
  // EI-19306394439939264: the rebind primitive was exported from connection.ts but never
  // re-exported here, so no other package could import it — which is why adoption outside
  // connection.ts was zero and 25 hand-rolled pools still wedge on a dead endpoint.
  endStalePool,
  type OrgPgHandle,
} from './connection';
// Store IDENTITY — the generation-3 connection guard (plan
// outage-must-not-be-silent-2026-08-02, D-001). Re-exported HERE deliberately, learning
// from EI-19306394439939264 above: a guard only reachable inside connection.ts gets zero
// adoption. `storeIdentityViolation()` is the one every diagnostic/health surface wants —
// a non-null value means any `not_found` seen since came from a DIFFERENT store and is not
// evidence of data loss.
export {
  storeIdentityViolation,
  pinnedStoreIdentity,
  clearStoreIdentityViolation,
  describeStoreIdentityMismatch,
  parseStoreIdentity,
  pinOrVerifyStoreIdentity,
  sameStore,
  redactUrl,
  STORE_IDENTITY_SQL,
  _resetStoreIdentityForTests,
  type StoreIdentity,
  type ObservedStoreIdentity,
  type StoreIdentityVerdict,
} from './store-identity';
export { withWorkspace, withWorkspaceQuery, withHarnessSchema, harnessQuery } from './workspace-context';
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
  listActiveEphemeralRoutines,
  recordEphemeralFire,
  fireRoutine,
  upsertRoutine,
  setRoutineActive,
  deleteRoutine,
  setRoutinesPerWorkspaceConflict,
  NEXT_FIRE_PARKED,
  isParkedNextFire,
  normalizeNextFireAt,
  type RoutineRow,
} from './routines-runtime';

export {
  getFeatureLineage,
  formatLineageForPrompt,
  createGoal,
  listGoals,
  type LineageRow,
} from './goal-lineage';
