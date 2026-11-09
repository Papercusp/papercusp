/**
 * Per-workspace transaction wrapper.
 *
 * Every state-mutating tool runs through this. Provides:
 *   - A shared per-workspace gate plus deterministic per-path advisory locks
 *     for file-lock operations. Unrelated paths can proceed concurrently;
 *     global operations keep the exclusive workspace lock (key 101 in
 *     `sql/advisory-lock-keys.md`).
 *   - Safe default timeouts (overridden per-op inside the handler).
 *   - application_name tagging for pg_stat_activity visibility.
 *
 * Read-only ops (locks:queue) DO NOT use this wrapper — they don't need
 * the advisory lock and shouldn't pay its cost.
 */

import { performance } from 'node:perf_hooks';
import type { Sql } from 'postgres';
import {
  beginSuLockTransaction,
  ensureBootstrap,
  getTxPool,
  SU_LOCKS_FEATURE_KEY,
} from './su-lock-store';
import { startBackgroundJanitor } from './workspace-listener';
import { txnTimeouts } from './config';

/**
 * Thrown when a per-workspace transaction can't proceed in time under
 * same-workspace contention: an advisory-lock wait exceeds
 * `lock_timeout` (PG `55P03`) or a statement exceeds `statement_timeout`
 * (PG `57014`). Callers map this to a structured busy result (`{ok:false}`)
 * instead of leaking a raw postgres error to the agent. The originating PG
 * error is kept on `.cause` / `.pgCode`.
 */
export class WorkspaceContendedError extends Error {
  readonly coordinationDomain: string;
  readonly pgCode: string;
  constructor(coordinationDomain: string, pgCode: string, cause: unknown) {
    super(`workspace "${coordinationDomain}" contended (pg ${pgCode}: lock/statement timeout)`);
    this.name = 'WorkspaceContendedError';
    this.coordinationDomain = coordinationDomain;
    this.pgCode = pgCode;
    this.cause = cause;
  }
}

/** PG SQLSTATEs that mean "couldn't serialize in time": lock_timeout +
 *  statement_timeout (query_canceled). */
const CONTENTION_CODES = new Set(['55P03', '57014']);

export type WorkspaceTxnPhase =
  | 'bootstrap'
  | 'background-janitor-arm'
  | 'pool-lookup'
  | 'pool-acquire-and-begin'
  | 'transaction-settings'
  | 'advisory-scope'
  | 'operation'
  | 'transaction-settlement'
  | 'transaction-total';

export interface WorkspaceTxnPhaseTiming {
  phase: WorkspaceTxnPhase;
  durationMs: number;
}

/** True under vitest / NODE_ENV=test — the background janitor timer is
 *  skipped there so no wall-clock tick can race a test's fixtures
 *  (tests drive runBackgroundJanitorOnce() directly). */
function isTestEnv(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
}

export interface WorkspaceTxnOptions {
  /**
   * TTL-only renewal of existing rows. Use the shared domain gate without
   * path locks: the conditional UPDATE serializes on its own rows and cannot
   * insert, delete, change ownership, or resurrect an expired lease. Global
   * housekeeping still excludes renewals. Never use for acquire/release work.
   */
  leaseRenewal?: boolean;
  /**
   * Canonical file-lock paths touched by this transaction. When present,
   * acquire the shared workspace gate, shared advisory locks for each strict
   * ancestor, and one exclusive advisory lock per requested path, all in
   * sorted order. A request for `a/b/c.ts` therefore serializes with requests
   * for `a` and `a/b`, while sibling paths such as `a/b.ts` and `a/c.ts`
   * remain independent. An omitted/empty set keeps the historical exclusive
   * workspace scope for resource, granular, and housekeeping work.
   */
  paths?: readonly string[];
  /**
   * Named resources (agent_resource_locks.resource) this transaction reads and
   * writes — and ONLY those. When present, take the SHARED workspace gate plus
   * one EXCLUSIVE `su-resource:<domain>:<resource>` key per name, in sorted
   * order: exactly the keys `resource_scope_lock` (sidecar sql/030) takes, so a
   * TypeScript resource transaction and a one-statement SQL resource operation
   * serialize on the same key. Path-scoped work also holds only the shared gate,
   * so file locks and unrelated resources stop queueing behind each other; a
   * domain-global sweep (no paths, no resources) still holds the exclusive key
   * and excludes both. The callback must not touch another resource's rows: use
   * `scope: 'resource'` on tryAcquireResource / tryReleaseResource, and
   * releaseOwnerResourcesScoped for a known lock set (EI-27114494366587753).
   * Cannot be combined with `paths` or `leaseRenewal`.
   */
  resources?: readonly string[];
  /**
   * Per-operation timeout floors. A drain-capable caller has already declared
   * how long it is prepared to wait; forcing its advisory-lock statement back
   * to the global 5s default makes PostgreSQL cancel it, lose its FIFO queue
   * position, and re-enter at the tail on every retry. Floors preserve any
   * wider live db:txn-timeouts setting while letting that caller keep its place.
   */
  minLockTimeoutMs?: number;
  minStatementTimeoutMs?: number;
  /**
   * Optional diagnostic observer. It is called only for this transaction and
   * failures in the observer are swallowed so instrumentation cannot alter
   * lock behavior or the transaction result.
   */
  onPhase?: (timing: WorkspaceTxnPhaseTiming) => void;
}

function timeoutWithFloor(configuredMs: number, floorMs: number | undefined): number {
  if (floorMs == null || !Number.isFinite(floorMs) || floorMs <= 0) return configuredMs;
  return Math.max(configuredMs, Math.trunc(floorMs));
}

function reportWorkspaceTxnPhase(
  observer: ((timing: WorkspaceTxnPhaseTiming) => void) | undefined,
  phase: WorkspaceTxnPhase,
  durationMs: number,
): void {
  if (!observer) return;
  try {
    observer({ phase, durationMs: Math.max(0, durationMs) });
  } catch {
    // Diagnostics must never change the transaction outcome.
  }
}

function measureSyncPhase<T>(
  observer: ((timing: WorkspaceTxnPhaseTiming) => void) | undefined,
  phase: WorkspaceTxnPhase,
  operation: () => T,
): T {
  if (!observer) return operation();
  const startedAt = performance.now();
  try {
    return operation();
  } finally {
    reportWorkspaceTxnPhase(observer, phase, performance.now() - startedAt);
  }
}

async function measureAsyncPhase<T>(
  observer: ((timing: WorkspaceTxnPhaseTiming) => void) | undefined,
  phase: WorkspaceTxnPhase,
  operation: () => Promise<T>,
): Promise<T> {
  if (!observer) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    reportWorkspaceTxnPhase(observer, phase, performance.now() - startedAt);
  }
}

/**
 * A custody callback can be doing bounded filesystem/Git work while retaining
 * the transaction's row and advisory fences. PostgreSQL otherwise treats that
 * work as idle and can kill the connection before preservation commits. Keep
 * this SAME transaction active; never renew a lease or release its fence here.
 * There is at most one probe in flight, and settlement joins it before COMMIT
 * or ROLLBACK. A failed probe must make a successful callback roll back too.
 */
async function withTransactionLiveness<T>(
  tx: Sql,
  idleTimeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return operation();
  const intervalMs = Math.max(1, Math.min(10_000, Math.floor(idleTimeoutMs / 3)));
  let stopped = false;
  let failed = false;
  let failure: unknown;
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    timer = setTimeout(() => {
      pending = (async () => {
        try {
          await tx`SELECT 1 /* workspace transaction liveness */`;
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          if (!stopped && !failed) schedule();
        }
      })();
    }, intervalMs);
    timer.unref?.();
  };
  schedule();
  try {
    const result = await operation();
    // The final probe may still be running when operation() returns.
    stopped = true;
    if (timer) clearTimeout(timer);
    await pending;
    if (failed) throw failure;
    return result;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    await pending;
  }
}

function pathAncestors(path: string): string[] {
  if (path.length === 0) return [];
  const parts = path.split('/');
  return parts
    .slice(0, -1)
    .map((_, index) => parts.slice(0, index + 1).join('/'));
}

/**
 * Keep only the shallowest requested path when a transaction includes both a
 * directory/subtree and one of its descendants. The shallow path's exclusive
 * advisory lock already covers the descendant, and dropping the descendant
 * avoids trying to upgrade a shared ancestor lock to exclusive on the same
 * transaction.
 */
function uniqueSortedPaths(paths: readonly string[] | undefined): string[] {
  if (!paths || paths.length === 0) return [];
  const requested = Array.from(new Set(paths.filter((path) => path.length > 0))).sort();
  return requested.filter(
    (path) =>
      !requested.some(
        (ancestor) => ancestor !== path && path.startsWith(`${ancestor}/`),
      ),
  );
}

async function acquireAdvisoryScope(
  tx: Sql,
  coordinationDomain: string,
  paths: readonly string[] | undefined,
  leaseRenewal = false,
  resources?: readonly string[],
): Promise<void> {
  const scopedPaths = uniqueSortedPaths(paths);
  const scopedResources = Array.from(
    new Set((resources ?? []).filter((resource) => resource.length > 0)),
  ).sort();
  if (scopedResources.length > 0) {
    if (scopedPaths.length > 0 || leaseRenewal) {
      throw new Error('inWorkspaceTxn: `resources` cannot be combined with `paths` or `leaseRenewal`');
    }
    // Same shared gate as path-scoped work: a domain-global operation (or an
    // older process still taking the exclusive key for resource work) excludes us.
    await tx`SELECT pg_advisory_xact_lock_shared(
      ${SU_LOCKS_FEATURE_KEY}::int,
      hashtext(${'su:' + coordinationDomain})
    )`;
    for (const resource of scopedResources) {
      await tx`SELECT pg_advisory_xact_lock(
        ${SU_LOCKS_FEATURE_KEY}::int,
        hashtext(${'su-resource:' + coordinationDomain + ':' + resource})
      )`;
    }
    return;
  }
  if (!leaseRenewal && scopedPaths.length === 0) {
    // Preserve the original key for global operations and rolling
    // compatibility with processes that still use the workspace lock alone.
    await tx`SELECT pg_advisory_xact_lock(
      ${SU_LOCKS_FEATURE_KEY}::int,
      hashtext(${'su:' + coordinationDomain})
    )`;
    return;
  }

  // The shared gate prevents a path-scoped operation from racing a global
  // sweep/resource operation. The old workspace key is deliberately reused so
  // an old process holding the exclusive key still blocks new path work.
  await tx`SELECT pg_advisory_xact_lock_shared(
    ${SU_LOCKS_FEATURE_KEY}::int,
    hashtext(${'su:' + coordinationDomain})
  )`;
  if (leaseRenewal) return;

  // Shared locks on strict ancestors make a subtree/exact-path exclusive lock
  // conflict with descendants, while siblings can share the same directory
  // ancestor. Lock all shared ancestors before any exclusive leaves, then all
  // leaves in a stable order, so overlapping multi-path requests cannot form a
  // lock-order cycle.
  const ancestors = Array.from(
    new Set(scopedPaths.flatMap(pathAncestors)),
  ).sort();
  for (const path of ancestors) {
    await tx`SELECT pg_advisory_xact_lock_shared(
      ${SU_LOCKS_FEATURE_KEY}::int,
      hashtext(${'su:' + coordinationDomain + ':' + path})
    )`;
  }
  for (const path of scopedPaths) {
    await tx`SELECT pg_advisory_xact_lock(
      ${SU_LOCKS_FEATURE_KEY}::int,
      hashtext(${'su:' + coordinationDomain + ':' + path})
    )`;
  }
}

export async function inWorkspaceTxn<T>(
  coordinationDomain: string,
  ownerId: string,
  fn: (tx: Sql) => Promise<T>,
  options: WorkspaceTxnOptions = {},
): Promise<T> {
  const onPhase = options.onPhase;
  const phaseTimings = onPhase ? [] as WorkspaceTxnPhaseTiming[] : null;
  const phaseObserver = onPhase
    ? (timing: WorkspaceTxnPhaseTiming) => {
        phaseTimings?.push(timing);
        onPhase(timing);
      }
    : undefined;
  await measureAsyncPhase(phaseObserver, 'bootstrap', () => ensureBootstrap());
  // Arm the background expiry janitor on the first mutating locks:* op
  // (file-locking #4). Idempotent + cheap, so calling it every op is
  // fine; the timer module lives in workspace-listener.ts.
  if (!isTestEnv()) {
    measureSyncPhase(phaseObserver, 'background-janitor-arm', () => startBackgroundJanitor());
  }
  const sql = measureSyncPhase(phaseObserver, 'pool-lookup', () => getTxPool());
  const transactionStartedAt = phaseObserver ? performance.now() : null;
  const transactionPhaseStartIndex = phaseTimings?.length ?? 0;
  let transactionEntered = false;
  // postgres-js's `begin` returns the handler's value but wraps it in
  // UnwrapPromiseArray<T>; for our non-array results the cast is safe.
  let result: unknown;
  try {
    result = await beginSuLockTransaction(sql, async (tx) => {
    transactionEntered = true;
    if (transactionStartedAt !== null) {
      reportWorkspaceTxnPhase(
        phaseObserver,
        'pool-acquire-and-begin',
        performance.now() - transactionStartedAt,
      );
    }
    // Diagnostic name visible in pg_stat_activity (set below, in the same
    // round trip as the timeouts — WI-10003631).
    // Per-workspace lock_timeout + statement_timeout. Baked 5s/5s, but runtime-settable via the
    // LocksHost getTxnTimeouts seam (db:txn-timeouts, live-configurability-audit-2026-06-20 P-020),
    // so the window can be widened mid-incident without a deploy through this very txn path.
    // set_config(name, value, is_local=true) == SET LOCAL, but takes the value as a BOUND PARAMETER
    // (a bare `SET` does not) — same form as the application_name line above. Per-op overrides still
    // come from the tool handler. txnTimeouts() is fail-safe to 5s/5s on any host/read error.
    const configuredTimeouts = txnTimeouts();
    const lockTimeoutMs = timeoutWithFloor(configuredTimeouts.lockTimeoutMs, options.minLockTimeoutMs);
    const statementTimeoutMs = timeoutWithFloor(
      configuredTimeouts.statementTimeoutMs,
      options.minStatementTimeoutMs,
    );
    const settings = await measureAsyncPhase(phaseObserver, 'transaction-settings', () =>
      tx`SELECT set_config('application_name', ${'papercusp-su:' + ownerId}, true),
                    set_config('lock_timeout', ${`${Math.trunc(lockTimeoutMs)}ms`}, true),
                    set_config('statement_timeout', ${`${Math.trunc(statementTimeoutMs)}ms`}, true),
                    EXTRACT(EPOCH FROM current_setting('idle_in_transaction_session_timeout')::interval)
                      * 1000 AS idle_timeout_ms`,
    );
    await measureAsyncPhase(phaseObserver, 'advisory-scope', () =>
      acquireAdvisoryScope(
        tx as unknown as Sql,
        coordinationDomain,
        options.paths,
        options.leaseRenewal,
        options.resources,
      ),
    );
    // TransactionSql has the same tagged-template surface as Sql for our
    // purposes; the cast lets store helpers take a single `Sql` type
    // rather than juggling a union that TS can't resolve as callable.
    return measureAsyncPhase(phaseObserver, 'operation', () =>
      withTransactionLiveness(tx as unknown as Sql, Number(settings[0]?.idle_timeout_ms),
        () => fn(tx as unknown as Sql)),
    );
    });
  } catch (err) {
    if (transactionStartedAt !== null && !transactionEntered) {
      reportWorkspaceTxnPhase(
        phaseObserver,
        'pool-acquire-and-begin',
        performance.now() - transactionStartedAt,
      );
    }
    // Map a same-workspace contention timeout (advisory-lock lock_timeout /
    // statement_timeout) into a typed error callers turn into a structured busy
    // result — never a raw postgres error to the agent (P-015).
    const code = (err as { code?: string } | null)?.code;
    if (typeof code === 'string' && CONTENTION_CODES.has(code)) {
      throw new WorkspaceContendedError(coordinationDomain, code, err);
    }
    throw err;
  } finally {
    if (transactionStartedAt !== null) {
      const transactionTotalMs = performance.now() - transactionStartedAt;
      const measuredTransactionPhasesMs =
        phaseTimings?.slice(transactionPhaseStartIndex)
          .reduce((sum, timing) => sum + timing.durationMs, 0) ?? 0;
      // This residual covers commit/rollback and any transaction-framework
      // work not named above; it is diagnostic, not a separate handler phase.
      reportWorkspaceTxnPhase(
        phaseObserver,
        'transaction-settlement',
        transactionTotalMs - measuredTransactionPhasesMs,
      );
      reportWorkspaceTxnPhase(phaseObserver, 'transaction-total', transactionTotalMs);
    }
  }
  return result as T;
}
