export * from './schema';
export {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
  schemaOf,
} from './schema/zod';
export {
  getOrgPg,
  getOrgPgListener,
  getOrgPgApp,
  getOrgPgLosslessBigint,
  getHarnessPg,
  typedSql,
  processConnectionCeiling,
  logConnectionBudget,
  explicitOrgPoolOverrideWarning,
  maybePgbouncer,
  setAdminPoolStatementTimeoutProvider,
  _resetForTests,
  PG_BIGINT_AS_NUMBER_TYPES,
  PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES,
  PG_TIMESTAMPTZ_AS_STRING_TYPES,
  restoreRawDateSerializers,
  restoreRawJsonbSerializer,
  longLivedPoolConnectionOptions,
  poolIdleTimeoutSec,
  // WI-7097: a caller-facing deadline for one DB round trip, guarding against
  // postgres.js's silent-retry-forever-on-failed-initial-connect. See connection.ts.
  withDbCallDeadline,
  DbCallDeadlineError,
  DEFAULT_DB_CALL_DEADLINE_MS,
  retryOnRetryableDbDeadline,
  type RetryOnRetryableDbDeadlineOptions,
  // P-022 / D-020: the PHASE-scoped sibling of withDbCallDeadline — bounds only
  // connect + BEGIN + SET_CONFIG and disarms before the caller's own work, so a
  // dead endpoint fails fast without capping legitimately long handlers.
  withAcquisitionDeadline,
  DEFAULT_TX_ACQUIRE_DEADLINE_MS,
  // EI-19306394439939264: the rebind primitive was exported from connection.ts but never
  // re-exported here, so no other package could import it — which is why adoption outside
  // connection.ts was zero and 25 hand-rolled pools still wedge on a dead endpoint.
  endStalePool,
  type OrgPgHandle,
} from './connection';
export {
  ON_CONFLICT_NO_MATCHING_INDEX_SQLSTATE,
  explainOnConflictSkew,
  isOnConflictSkewError,
  parseConflictTarget,
  parseInsertTarget,
} from './on-conflict-diagnostic';
// EI-19485014132257783 — this process's own acquisition counters, the MEASURED
// discriminator behind the two deadline errors' "dead endpoint vs saturated client
// pool" fork. Re-exported for the same reason `endStalePool` is (EI-19306394439939264):
// a diagnostic only reachable inside this package gets zero adoption, and a health
// surface wanting live acquire pressure has nowhere else to read it.
export {
  acquireSnapshot,
  describeAcquirePressure,
  beginAcquire,
  recordPoolMax,
  resetAcquireRegistryForTest,
  ACQUIRE_RECENT_SUCCESS_MS,
  type AcquireSnapshot,
  type AcquireTicket,
} from './acquire-registry';
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
  HostedServiceContextError,
  TenantContextError,
  deriveTenantContext,
  withHostedServiceContext,
  withTenantContext,
  HOSTED_SERVICE_ROLE,
  HOSTED_TENANT_ROLE,
  type DerivedTenantContext,
  type HostedServiceContextErrorCode,
  type HostedTenantPrincipal,
  type ResolvedTenantWorkspace,
  type TenantContextErrorCode,
  type VerifiedTenantServerContext,
} from './tenant-context';
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

export {
  linkPot,
  unlinkPot,
  setMainOwner,
  potsForGoal,
  goalsForPot,
  goalSpend,
  portfolioSpend,
  GOAL_SPEND_SNAPSHOT_SOURCE,
  GOAL_SPEND_TICK_SOURCE,
  type GoalPotLink,
  type GoalPotRole,
  type GoalSpend,
  type PotSpend,
} from './goal-pots';
