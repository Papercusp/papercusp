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
  SU_LOCK_TX_POOL_LABEL,
} from './su-lock-store';
import { startBackgroundJanitor } from './workspace-listener';
import { beginAcquireDiagnostic, txnTimeouts } from './config';

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
  preservation?: WorkspacePreservationSnapshot;
  constructor(coordinationDomain: string, pgCode: string, cause: unknown) {
    super(`workspace "${coordinationDomain}" contended (pg ${pgCode}: lock/statement timeout)`);
    this.name = 'WorkspaceContendedError';
    this.coordinationDomain = coordinationDomain;
    this.pgCode = pgCode;
    this.cause = cause;
  }
}

export interface WorkspacePreservationSnapshot {
  observedAtMs: number;
  truncated: boolean;
  unavailable?: { code: string; message: string };
  holders: Array<{
    owner: string;
    backendPid: number;
    startedAtMs: number;
    phase: 'preservation';
    ownerComplete: boolean;
  }>;
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
  | 'preservation'
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
   * TTL-only renewal of existing rows, without advisory locks: the conditional
   * UPDATE serializes on its own rows and cannot insert, delete, change
   * ownership, or resurrect an expired lease. Unrelated global work must not
   * starve a live lease's heartbeat. Never use for acquire/release work.
   */
  leaseRenewal?: boolean;
  /** Global janitor only: skip a busy domain without waiting. The callback is
   * not entered and the result is undefined; use with a void callback. */
  tryWorkspaceLock?: boolean;
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

class PreservationRequired extends Error {
  constructor(readonly effect: () => Promise<unknown>, readonly identity: string) {
    super('file-lock preservation requires transaction settlement');
  }
}

interface PreservationContext {
  next: number;
  completed: Array<{ identity: string; result: unknown }>;
  pending?: PreservationRequired;
  protect: (domain: string, paths: readonly string[]) => Promise<void>;
  sql: Sql;
}

const preservationContexts = new WeakMap<Sql, PreservationContext>();

/** Reserve the exact existing lease/operation under the same advisory keys on
 * one dedicated session. Settle SQL before capture, then reread that identity
 * before release/cascade. The existing lease, hook operation and immutable host
 * receipt remain the durable records; no parallel reservation store is needed. */
export async function preserveOutsideWorkspaceTxn<T>(
  tx: Sql, domain: string, paths: readonly string[], identity: unknown,
  effect: () => Promise<T>,
): Promise<T> {
  const context = preservationContexts.get(tx);
  if (!context) throw new Error('file-lock preservation requires inWorkspaceTxn');
  const key = JSON.stringify(identity);
  const index = context.next++;
  const prior = context.completed[index];
  if (prior) {
    if (prior.identity !== key) throw new Error('file-lock preservation selection changed');
    return prior.result as T;
  }
  await context.protect(domain, paths);
  const pending = new PreservationRequired(effect, key);
  context.pending = pending;
  throw pending;
}

/** Physical alias protection uses the same session fence. A different live
 * lease remains a refusal, including another lease of the same owner. */
export async function protectPreservationAlias(
  tx: Sql, domain: string, paths: readonly string[], check: (sql: Sql) => Promise<void>,
): Promise<void> {
  const context = preservationContexts.get(tx);
  if (!context) throw new Error('file-lock preservation requires inWorkspaceTxn');
  await context.protect(domain, paths);
  await check(context.sql);
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

function advisoryScope(
  coordinationDomain: string,
  paths: readonly string[] | undefined,
  leaseRenewal = false,
  resources?: readonly string[],
): Array<{ key: string; shared: boolean }> {
  const scope: Array<{ key: string; shared: boolean }> = [];
  const lock = (key: string, shared = false): void => {
    scope.push({ key, shared });
  };
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
    lock('su:' + coordinationDomain, true);
    for (const resource of scopedResources) {
      lock('su-resource:' + coordinationDomain + ':' + resource);
    }
    return scope;
  }
  // Renewal and expiry/release serialize on the exact row. Waiting for the
  // workspace gate here lets an unrelated global operation expire every live
  // lease in the domain. A conditional UPDATE cannot resurrect a deleted or
  // expired row, including when it resumes after a concurrent row-lock wait.
  if (leaseRenewal) return scope;
  if (scopedPaths.length === 0) {
    // Preserve the original key for global operations and rolling
    // compatibility with processes that still use the workspace lock alone.
    lock('su:' + coordinationDomain);
    return scope;
  }

  // The shared gate prevents a path-scoped operation from racing a global
  // sweep/resource operation. The old workspace key is deliberately reused so
  // an old process holding the exclusive key still blocks new path work.
  lock('su:' + coordinationDomain, true);
  // Shared locks on strict ancestors make a subtree/exact-path exclusive lock
  // conflict with descendants, while siblings can share the same directory
  // ancestor. Lock all shared ancestors before any exclusive leaves, then all
  // leaves in a stable order, so overlapping multi-path requests cannot form a
  // lock-order cycle.
  const ancestors = Array.from(
    new Set(scopedPaths.flatMap(pathAncestors)),
  ).sort();
  for (const path of ancestors) {
    lock('su:' + coordinationDomain + ':' + path, true);
  }
  for (const path of scopedPaths) {
    lock('su:' + coordinationDomain + ':' + path);
  }
  return scope;
}

export async function acquireAdvisoryScope(
  tx: Sql,
  coordinationDomain: string,
  paths: readonly string[] | undefined,
  leaseRenewal = false,
  resources?: readonly string[],
  session = false,
): Promise<void> {
  for (const { key, shared } of advisoryScope(coordinationDomain, paths, leaseRenewal, resources)) {
    if (session) {
      if (shared) await tx`SELECT pg_advisory_lock_shared(${SU_LOCKS_FEATURE_KEY}::int, hashtext(${key}))`;
      else await tx`SELECT pg_advisory_lock(${SU_LOCKS_FEATURE_KEY}::int, hashtext(${key}))`;
    } else if (shared) {
      await tx`SELECT pg_advisory_xact_lock_shared(${SU_LOCKS_FEATURE_KEY}::int, hashtext(${key}))`;
    } else {
      await tx`SELECT pg_advisory_xact_lock(${SU_LOCKS_FEATURE_KEY}::int, hashtext(${key}))`;
    }
  }
}

async function readPreservationSnapshot(
  tx: Sql, coordinationDomain: string, options: WorkspaceTxnOptions,
): Promise<WorkspacePreservationSnapshot> {
  const scope = advisoryScope(coordinationDomain, options.paths, options.leaseRenewal, options.resources);
  const rows = await tx<{ pid: number; application_name: string }[]>`
    SELECT DISTINCT activity.pid, activity.application_name
    FROM pg_locks held JOIN pg_stat_activity activity ON activity.pid = held.pid
    JOIN jsonb_to_recordset(${tx.json(scope)}::jsonb) AS request(key text, shared boolean)
      ON held.objid = hashtext(request.key)::oid
    WHERE held.locktype = 'advisory' AND held.granted
      AND held.classid = ${SU_LOCKS_FEATURE_KEY}::oid AND held.objsubid = 2
      AND held.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND held.pid <> pg_backend_pid()
      AND (NOT request.shared OR held.mode = 'ExclusiveLock')
      AND activity.xact_start IS NULL AND activity.application_name LIKE 'su:pres:%'
    ORDER BY activity.pid LIMIT 9`;
  return {
    observedAtMs: Date.now(),
    truncated: rows.length > 8,
    holders: rows.slice(0, 8).flatMap(row => {
      const identity = /^su:pres:(\d+):(.+)$/.exec(row.application_name);
      const startedAtMs = Number(identity?.[1]);
      if (!identity || !Number.isSafeInteger(startedAtMs) || startedAtMs <= 0) return [];
      return [{ owner: identity[2], backendPid: row.pid, startedAtMs,
        phase: 'preservation' as const, ownerComplete: Buffer.byteLength(row.application_name) < 63 }];
    }),
  };
}

async function workspaceTransactionAttempt<T>(
  coordinationDomain: string,
  ownerId: string,
  fn: (tx: Sql) => Promise<T>,
  options: WorkspaceTxnOptions = {},
  pool?: Sql,
  acquisitionStartedAt?: number,
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
  const sql = measureSyncPhase(phaseObserver, 'pool-lookup', () => pool ?? getTxPool());
  const transactionStartedAt = phaseObserver ? acquisitionStartedAt ?? performance.now() : null;
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
    await measureAsyncPhase(phaseObserver, 'transaction-settings', () =>
      tx`SELECT set_config('application_name', ${'papercusp-su:' + ownerId}, true),
                    set_config('lock_timeout', ${`${Math.trunc(lockTimeoutMs)}ms`}, true),
                    set_config('statement_timeout', ${`${Math.trunc(statementTimeoutMs)}ms`}, true)`,
    );
    const scoped = await measureAsyncPhase(phaseObserver, 'advisory-scope', async () => {
      if (options.tryWorkspaceLock) {
        if (options.paths?.length || options.resources?.length || options.leaseRenewal) {
          throw new Error('tryWorkspaceLock requires a global workspace scope');
        }
        const rows = await tx`SELECT pg_try_advisory_xact_lock(
          ${SU_LOCKS_FEATURE_KEY}::int, hashtext(${'su:' + coordinationDomain})) AS locked`;
        return rows[0]?.locked === true;
      }
      await acquireAdvisoryScope(tx as unknown as Sql, coordinationDomain,
        options.paths, options.leaseRenewal, options.resources);
      return true;
    });
    if (!scoped) return undefined as T;
    // TransactionSql has the same tagged-template surface as Sql for our
    // purposes; the cast lets store helpers take a single `Sql` type
    // rather than juggling a union that TS can't resolve as callable.
    return measureAsyncPhase(phaseObserver, 'operation', () => fn(tx as unknown as Sql));
    }, Boolean(pool));
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

export async function inWorkspaceTxn<T>(
  coordinationDomain: string, ownerId: string, fn: (tx: Sql) => Promise<T>,
  options: WorkspaceTxnOptions = {},
): Promise<T> {
  await ensureBootstrap();
  const acquisitionStartedAt = options.onPhase ? performance.now() : undefined;
  const acquisition = beginAcquireDiagnostic(SU_LOCK_TX_POOL_LABEL);
  const connection = await getTxPool().reserve().then(reserved => {
    acquisition?.acquired();
    return reserved;
  }, error => {
    acquisition?.release();
    throw error;
  });
  let firstAttempt = true;
  let inTransaction = false;
  // ReservedSql has no begin(): ordinary postgres-js begin closes over the
  // pool, which could select another backend. Keep settlement and session keys
  // on this reserved connection, including after ROLLBACK of a SQL-only prefix.
  const pool = new Proxy(connection, {
    get(target, property) {
      if (property !== 'begin') return Reflect.get(target, property);
      return async (run: (tx: Sql) => Promise<unknown>) => {
        await connection.unsafe('BEGIN');
        inTransaction = true;
        try {
          const result = await run(connection as unknown as Sql);
          await connection.unsafe('COMMIT');
          return result;
        } catch (error) {
          await connection.unsafe('ROLLBACK');
          throw error;
        } finally {
          inTransaction = false;
        }
      };
    },
  }) as unknown as Sql;
  const scopes = new Set<string>();
  let fenced = false;
  let preservationApplicationName: string | undefined;
  const context: PreservationContext = {
    next: 0, completed: [], sql: connection as unknown as Sql,
    protect: async (domain, paths) => {
      const key = JSON.stringify([domain, uniqueSortedPaths(paths)]);
      if (scopes.has(key)) return;
      const take = async () => {
        fenced = true;
        await acquireAdvisoryScope(context.sql, domain, paths, false, undefined, true);
      };
      // The first reservation overlaps its transaction's original keys. An
      // alias requested by capture uses a separate short, timeout-bounded txn.
      if (inTransaction) await take();
      else await workspaceTransactionAttempt(domain, ownerId, take, { paths }, pool);
      scopes.add(key);
    },
  };
  const tx = connection as unknown as Sql;
  preservationContexts.set(tx, context);
  try {
    for (;;) {
      context.next = 0;
      context.pending = undefined;
      try {
        const startedAt = firstAttempt ? acquisitionStartedAt : undefined;
        firstAttempt = false;
        return await workspaceTransactionAttempt(coordinationDomain, ownerId, async () => {
          const protect = context.protect;
          context.protect = async (domain, paths) => {
            context.protect = protect;
            await protect(coordinationDomain, options.paths ?? []);
            await protect(domain, paths);
          };
          const result = await fn(tx);
          if (context.next !== context.completed.length) {
            throw new Error('file-lock preservation selection changed');
          }
          return result;
        }, options, pool, startedAt);
      } catch (error) {
        // Expiry wraps host errors. Only this request's exact sentinel may
        // cross the settlement boundary; an ordinary error never runs capture.
        let cause: unknown = error;
        while (cause instanceof Error && cause !== context.pending && cause.cause) cause = cause.cause;
        const pending = context.pending as PreservationRequired | undefined;
        if (!pending || cause !== pending) {
          if (error instanceof WorkspaceContendedError) {
            try {
              // This is an observation AFTER the failed transaction, not a
              // file-lease verdict. Read only incompatible granted keys from
              // the same scope plan; compatible siblings must stay invisible.
              error.preservation = await pool.begin(async diagnostic => {
                await diagnostic`SELECT set_config('statement_timeout', '250ms', true),
                  set_config('application_name', ${'papercusp-su:' + ownerId}, true)`;
                return readPreservationSnapshot(diagnostic as unknown as Sql, coordinationDomain, options);
              }) as WorkspacePreservationSnapshot;
            } catch (diagnosticError) {
              // An unavailable/budgeted-out diagnostic leaves the original
              // timeout intact. It never authorizes a grant, unlock or retry.
              const code = (diagnosticError as { code?: unknown } | null)?.code;
              error.preservation = { observedAtMs: Date.now(), truncated: false, holders: [],
                unavailable: { code: typeof code === 'string' ? code.slice(0, 80) : 'unknown',
                  message: diagnosticError instanceof Error ? diagnosticError.message.slice(0, 200) : 'Observation unavailable' } };
            }
          }
          throw error;
        }
        // SET LOCAL is rolled back before capture, although the session still
        // holds its advisory fences. Retain the actor and this phase's onset
        // in the existing PG diagnostic label while no SQL transaction exists.
        // The canonical su UUID plus this prefix/timestamp fits PG's 63 bytes.
        if (preservationApplicationName === undefined) {
          const [previous] = await connection<{ application_name: string }[]>`
            SELECT current_setting('application_name') AS application_name`;
          preservationApplicationName = previous.application_name;
        }
        await connection`SELECT set_config('application_name',
          ${`su:pres:${Date.now()}:${ownerId}`}, false)`;
        const result = await measureAsyncPhase(options.onPhase, 'preservation', () => pending.effect());
        context.completed.push({ identity: pending.identity, result });
      }
    }
  } finally {
    preservationContexts.delete(tx);
    try {
      if (fenced) {
        if (preservationApplicationName === undefined) {
          await connection`SELECT pg_advisory_unlock_all()`;
        } else {
          // Restore the exact prior label with fence release, on success and
          // failure, before this reserved connection can return to the pool.
          await connection`SELECT pg_advisory_unlock_all(),
            set_config('application_name', ${preservationApplicationName}, false)`;
        }
      }
    } finally {
      connection.release();
      acquisition?.release();
    }
  }
}
