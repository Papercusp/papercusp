/**
 * SU agent file-lock coordination — storage layer.
 *
 * Owns:
 *   - Connection pools to the `papercusp_su` side-database (tx pool +
 *     listener pool, see §8 of su-agent-coordination-v3-2026-05-14.md).
 *   - Bootstrap of `papercusp_su` against the main `papercusp` database
 *     on first call.
 *   - Migration runner (idempotent; SHARE UPDATE EXCLUSIVE on su_meta
 *     to serialize concurrent runners — audit 3 #6).
 *   - Low-level acquire/release/heartbeat/cancel/queue helpers.
 *
 * Tools (acquire.ts, release.ts, …) call these helpers; they don't
 * touch postgres-js directly.
 */

// Note: no `import 'server-only'` — the store is exercised by smoke
// scripts and unit tests that run outside any server bundle. Server-only
// gating happens in the embedding app at the tool-registration boundary
// (the operator's agent-tools/index.ts, only loaded by its route handler).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { locksHost } from './config';

/**
 * Tx type re-export. Store helpers take `Sql`; callers inside
 * `inWorkspaceTxn` pass a `TransactionSql` (assignable via a single
 * cast at the wrapper boundary — see in-workspace-txn.ts).
 */
export type SuSqlTxn = Sql;
export type SuTransactionSql = TransactionSql<Record<string, unknown>>;

/**
 * SU-locks feature key in the per-workspace advisory-lock registry
 * (see `sql/advisory-lock-keys.md`). First arg of the two-arg
 * `pg_advisory_xact_lock(feature_key, hashtext('su:'||ws))`. Lives in
 * this lowest-level locks module so both the per-call txn wrapper
 * (`in-workspace-txn.ts`) and the background janitor share one
 * definition.
 */
export const SU_LOCKS_FEATURE_KEY = 101;

// ───────── Connection pools ─────────

/**
 * Resolve the URL for the SU side-database. Same host/port/role as the
 * main papercusp DB, different database name.
 *
 * The plan calls for a separate `papercusp_su` role, but operationally
 * that requires password-file management for embedded PG where there
 * is no external network surface — marginal value, real complexity.
 * We reuse `harness_admin` (the existing role with full access to the
 * embedded PG instance) and keep ONLY the database separate. Workload
 * isolation, drop-and-recreate, and per-database backup retention are
 * preserved; the grant-isolation goal is dropped as YAGNI.
 */
function suUrl(): string {
  const main = locksHost().getAdminBaseUrl();
  // Replace the path component (the database name) with `papercusp_su`.
  // URLs look like: postgresql://user:pass@host:port/dbname?params
  return main.replace(/\/[^/?]+(\?|$)/, '/papercusp_su$1');
}

function mainUrl(): string {
  // For bootstrap (CREATE DATABASE) we must NOT be connected to the
  // db we're creating. The injected admin URL targets the main db.
  return locksHost().getAdminBaseUrl();
}

let txPool: Sql | null = null;
let listenerPool: Sql | null = null;
let bootstrapped = false;

export function getTxPool(): Sql {
  if (!txPool) {
    txPool = postgres(suUrl(), {
      max: 10,
      prepare: false,
      // Run our SET LOCAL inside each txn; don't let postgres-js auto-prepare
      // statements across connections (the SET LOCAL won't carry).
    });
  }
  return txPool;
}

export function getListenerPool(): Sql {
  if (!listenerPool) {
    listenerPool = postgres(suUrl(), {
      max: 20, // Cap on concurrent workspace listeners — audit reviewer #3
      prepare: false,
    });
  }
  return listenerPool;
}

/**
 * Test-only — close pools and reset state. Used by vitest hooks to
 * recycle the connection set between disposable PG instances.
 */
export async function _resetForTests(): Promise<void> {
  // The background-janitor timer lives in workspace-listener.ts now
  // (file-locking #4); its test teardown is _resetListenersForTests().
  if (txPool) {
    await txPool.end({ timeout: 1 });
    txPool = null;
  }
  if (listenerPool) {
    await listenerPool.end({ timeout: 1 });
    listenerPool = null;
  }
  bootstrapped = false;
}

// ───────── Bootstrap + migrations ─────────

// The package OWNS its migrations: `sql/` lives adjacent to this module
// at `packages/locks/src/sql/`. Resolve relative to the module's own URL
// (works under src-as-entry dev, standalone tsc/vitest, and Node ESM)
// rather than `process.cwd()` — cwd is the *embedding app's* root, which
// no longer contains these files after extraction. Consumers that bundle
// this package server-side must keep it external (real files on disk) so
// `import.meta.url` + fs resolve to the symlinked package dir.
const SQL_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'sql',
);

/**
 * Ensures `papercusp_su` exists and migrations are applied. Idempotent.
 * Called lazily on the first locks:* invocation per process.
 *
 * Steps:
 *   1. Probe `papercusp_su` existence via the main db. If missing, run
 *      `001-bootstrap.sql` (CREATE DATABASE — outside any txn).
 *   2. Connect to papercusp_su; take SHARE UPDATE EXCLUSIVE on su_meta
 *      (creating it first if needed); apply every NNN-*.sql whose
 *      number isn't in su_meta yet.
 *   3. Stamp the schema_version key in su_meta.
 */
export async function ensureBootstrap(): Promise<void> {
  if (bootstrapped) return;

  // Step 1: probe the side db, create if absent.
  const main = postgres(mainUrl(), { max: 1, prepare: false });
  try {
    const rows = await main<Array<{ exists: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM pg_database WHERE datname = 'papercusp_su'
      ) AS exists
    `;
    if (!rows[0]?.exists) {
      // CREATE DATABASE can't run inside any transaction. postgres-js
      // wraps `.unsafe()` in an implicit txn by default; `.simple()`
      // disables that. We also split the bootstrap into separate calls
      // because PG won't accept other statements in the same simple
      // batch as CREATE DATABASE (each must stand alone).
      await main.unsafe('CREATE DATABASE papercusp_su').simple();
      await main.unsafe(
        "ALTER DATABASE papercusp_su SET idle_in_transaction_session_timeout = '30s'",
      ).simple();
      await main.unsafe(
        "ALTER DATABASE papercusp_su SET application_name = 'papercusp-su'",
      ).simple();
    }
  } finally {
    await main.end({ timeout: 1 });
  }

  // Step 2 + 3: connect to papercusp_su and apply migrations.
  const sql = getTxPool();

  // su_meta must exist before we can take SHARE UPDATE EXCLUSIVE on it.
  // Bootstrap it outside the lock — CREATE TABLE IF NOT EXISTS is safe
  // concurrently (the loser just no-ops).
  await sql`
    CREATE TABLE IF NOT EXISTS su_meta (
      key   text PRIMARY KEY,
      value text NOT NULL
    )
  `;

  // Now serialize the migration runner across processes.
  await sql.begin(async (tx) => {
    await tx`LOCK TABLE su_meta IN SHARE UPDATE EXCLUSIVE MODE`;

    const appliedRows = await tx<Array<{ key: string }>>`
      SELECT key FROM su_meta WHERE key LIKE 'migration:%'
    `;
    const applied = new Set(appliedRows.map((r) => r.key));

    const files = fs
      .readdirSync(SQL_DIR)
      .filter((f) => /^\d{3}-.*\.sql$/.test(f))
      .filter((f) => !f.endsWith('-bootstrap.sql'))
      .sort();

    for (const file of files) {
      const key = `migration:${file}`;
      if (applied.has(key)) continue;

      const sqlText = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
      // postgres-js `unsafe` runs as a single multi-statement script.
      // We're inside a txn so any failure rolls back the whole file.
      await tx.unsafe(sqlText);

      await tx`
        INSERT INTO su_meta (key, value) VALUES (${key}, ${new Date().toISOString()})
        ON CONFLICT (key) DO NOTHING
      `;
    }
  });

  bootstrapped = true;
  // The background expiry sweep (file-locking #4) is armed by
  // inWorkspaceTxn on the first mutating locks:* op — its timer lives
  // in workspace-listener.ts, the module that owns the locks
  // subsystem's long-lived background state.
}

// ───────── Path validation (app-side; trigger is belt-and-suspenders) ─────────

// Path validation + canonicalization moved to ./path-normalize.ts
// (file-locking #2 follow-up — one named module owns the rules).
// Re-exported here so existing `from '../su-lock-store'` importers
// keep resolving.
export {
  InvalidPathError,
  MAX_PATH_LEN,
  validatePath,
  canonicalizePath,
  normalizePaths,
} from './path-normalize';

// ───────── Janitor — expiry sweep ─────────

/**
 * Workspace-scoped expiry sweep: delete this workspace's expired lock
 * rows and flip its orphaned 'waiting' waiters (wait_until elapsed, the
 * agent crashed mid-wait) to 'expired'. Returns true if anything moved,
 * so the caller can decide whether to run grant_cascade.
 *
 * file-locking #4: replaces the former global janitor, which ran a
 * DELETE across EVERY workspace on every acquire/release/heartbeat
 * call. That global scan now lives only in the 30s background janitor
 * (runBackgroundJanitorOnce); the per-call hot path sweeps just the
 * workspace (or paths) it actually touches.
 *
 * Timeout-agnostic: inherits the caller's SET LOCAL statement_timeout.
 */
export async function sweepWorkspaceExpired(
  tx: Sql,
  coordinationDomain: string,
): Promise<boolean> {
  const expiredLocks = await tx<Array<{ path: string }>>`
    DELETE FROM agent_file_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND expires_ts <= clock_timestamp()
    RETURNING path
  `;
  // Orphaned 'waiting' waiters whose wait_until has passed but no one
  // marked them expired (bug #19). The head-waiter check now filters
  // waiters by wait_until so a stale row no longer BLOCKS acquires,
  // but it still must be cleaned up here / by the background janitor.
  const orphanWaiters = await tx<Array<{ ticket_id: string }>>`
    UPDATE agent_lock_waiters
       SET status = 'expired'
     WHERE coordination_domain = ${coordinationDomain}
       AND status = 'waiting'
       AND wait_until <= clock_timestamp()
    RETURNING ticket_id
  `;
  return expiredLocks.length > 0 || orphanWaiters.length > 0;
}

/**
 * Path-narrow expiry sweep for the acquire hot path (file-locking #4).
 * Sweeps ONLY the rows touching the paths this acquire is contending —
 * an index-perfect (coordination_domain, path) delete. The orphaned-waiter
 * flip is likewise restricted to waiters whose path set overlaps
 * `paths`.
 *
 * Expired rows on paths NOT in this set are intentionally left for the
 * background janitor — they cannot affect this acquire's outcome (the
 * upsert steals expired rows on the requested paths; the head-waiter
 * check filters dead waiters by wait_until).
 *
 * Timeout-agnostic: inherits the caller's SET LOCAL statement_timeout.
 */
export async function sweepPathsExpired(
  tx: Sql,
  coordinationDomain: string,
  paths: string[],
): Promise<boolean> {
  if (paths.length === 0) return false;
  const expiredLocks = await tx<Array<{ path: string }>>`
    DELETE FROM agent_file_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND path = ANY(${paths}::text[])
       AND expires_ts <= clock_timestamp()
    RETURNING path
  `;
  const orphanWaiters = await tx<Array<{ ticket_id: string }>>`
    UPDATE agent_lock_waiters
       SET status = 'expired'
     WHERE coordination_domain = ${coordinationDomain}
       AND status = 'waiting'
       AND wait_until <= clock_timestamp()
       AND paths && ${paths}::text[]
    RETURNING ticket_id
  `;
  return expiredLocks.length > 0 || orphanWaiters.length > 0;
}

/**
 * Reactive nudge: sweep this workspace's expired locks + orphaned
 * waiters and run the cascade if anything moved.
 *
 * Used by the wait loop on each ceiling tick so a waiter on a path
 * whose holder lapsed (TTL expiry, no explicit release) doesn't sit
 * idle forever. Workspace-scoped (file-locking #4) — it sweeps only
 * the caller's own workspace; other workspaces are reached by their
 * own pokes and the background janitor.
 *
 * Cheap: runs inside inWorkspaceTxn; the sweep's DELETE/UPDATE are
 * bounded by partial indexes (typically 0 rows in the steady state).
 */
export async function pokeWorkspace(tx: Sql, coordinationDomain: string): Promise<void> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  const swept = await sweepWorkspaceExpired(tx, coordinationDomain);
  if (swept) {
    await tx`SELECT grant_cascade(${coordinationDomain}, clock_timestamp())`;
  }
}

// ───────── Background janitor (file-locking #4) ─────────
//
// The 30s timer that drives this lives in workspace-listener.ts — the
// module that owns the locks subsystem's long-lived background state —
// and is armed by inWorkspaceTxn on the first mutating op. The sweep
// WORK stays here: it is storage-layer logic (tx pool, the per-
// workspace advisory lock, sweepWorkspaceExpired). The janitor uses
// the tx pool, NOT the LISTEN connection — a postgres-js listen
// connection is dedicated to LISTEN and cannot run the sweep's
// transactions; the tx pool is borrowed transiently each pass.

/**
 * One background sweep pass:
 *   1. Discover workspaces carrying expired locks or orphaned waiters
 *      (one index-bounded read).
 *   2. For each, take that workspace's advisory lock NON-blockingly
 *      (pg_try_advisory_xact_lock — if a tool txn already holds it,
 *      that txn sweeps+cascades itself, or we catch it next tick),
 *      sweep, and grant_cascade if anything moved. The advisory lock
 *      is required: grant_cascade's in-memory held-paths probe is only
 *      race-free under it.
 *   3. GC terminal waiter rows older than 24h (disjoint from every
 *      reader — readQueue's completed window is queued_ts > now-24h —
 *      so no advisory lock needed).
 *
 * One workspace failing never aborts the rest of the pass. Exported so
 * tests drive it directly (deterministic) instead of waiting on the
 * wall-clock interval.
 */
export async function runBackgroundJanitorOnce(): Promise<void> {
  await ensureBootstrap();
  const sql = getTxPool();

  const dirty = await sql<Array<{ coordination_domain: string }>>`
    SELECT coordination_domain FROM agent_file_locks
      WHERE expires_ts <= clock_timestamp()
    UNION
    SELECT coordination_domain FROM agent_lock_waiters
      WHERE status = 'waiting' AND wait_until <= clock_timestamp()
  `;

  for (const { coordination_domain } of dirty) {
    try {
      await sql.begin(async (txn) => {
        const tx = txn as unknown as Sql;
        await tx`SET LOCAL statement_timeout = '2s'`;
        const got = await tx<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(
            ${SU_LOCKS_FEATURE_KEY}::int,
            hashtext(${'su:' + coordination_domain})
          ) AS locked
        `;
        if (!got[0]?.locked) return; // contended — handled elsewhere
        const swept = await sweepWorkspaceExpired(tx, coordination_domain);
        if (swept) {
          await tx`SELECT grant_cascade(${coordination_domain}, clock_timestamp())`;
        }
      });
    } catch (err) {
      console.error(
        `[su-locks] background janitor: workspace ${coordination_domain} sweep failed`,
        err,
      );
    }
  }

  try {
    await sql.begin(async (txn) => {
      const tx = txn as unknown as Sql;
      await tx`SET LOCAL statement_timeout = '5s'`;
      await tx`
        DELETE FROM agent_lock_waiters
         WHERE status IN ('granted','expired','cancelled')
           AND queued_ts < clock_timestamp() - interval '24 hours'
      `;
    });
  } catch (err) {
    console.error('[su-locks] background janitor: terminal-waiter GC failed', err);
  }
}

// ───────── Acquire (no wait) ─────────

export interface AcquireParams {
  coordinationDomain: string;
  owner: string;
  /** Diagnostic label for the holder. `null` when the caller has no
   *  label (e.g. the FileClaimCoordinator adapter) — the owner_label
   *  column is nullable. */
  ownerLabel: string | null;
  paths: string[]; // already normalized
  intent: string;
  ttlSec: number;
}

export interface AcquireBusy {
  path: string;
  /** Canonical owner id of the holder (#5 — unredacted; SU is admin-tier). */
  owner: string;
  owner_label: string | null;
  intent: string;
  expires_ts: Date;
}

export type AcquireResult =
  | {
      ok: true;
      lock_id: string;
      expires_ts: Date;
      held: string[];
    }
  | {
      ok: false;
      busy: AcquireBusy[];
    };

/**
 * Atomic multi-path acquire. Inside the calling `inWorkspaceTxn`.
 *
 * Strategy:
 *   1. Head-waiter check — if any older waiter overlaps our paths, return busy.
 *   2. Upsert all paths; ON CONFLICT only overwrites expired rows.
 *   3. Verify our lock_id won every path. Mismatch → busy.
 *
 * Per audit 4 #1: success path short-circuits the busy SELECT.
 */
export async function tryAcquire(
  tx: Sql,
  params: AcquireParams,
): Promise<AcquireResult> {
  const { coordinationDomain, owner, ownerLabel, paths, intent, ttlSec } = params;

  if (paths.length === 0) {
    return { ok: true, lock_id: crypto.randomUUID(), expires_ts: new Date(), held: [] };
  }

  await tx`SET LOCAL statement_timeout = '500ms'`;

  // Step 1: path-narrow expiry sweep (file-locking #4). Only the rows
  // touching the paths THIS acquire contends — an index-perfect
  // (coordination_domain, path) delete, not the former global cross-workspace
  // scan. Fire the cascade if the sweep freed anything so a waiter
  // blocked solely behind a now-swept expired lock wakes immediately
  // rather than on the next background tick. Expired rows on other
  // paths are left for the background janitor — they cannot affect
  // this acquire's outcome.
  const swept = await sweepPathsExpired(tx, coordinationDomain, paths);
  if (swept) {
    await tx`SELECT grant_cascade(${coordinationDomain}, clock_timestamp())`;
  }

  // Step 2: head-waiter check.
  // Skip paths the calling owner already holds — a same-owner refresh
  // shouldn't be blocked by a waiter queued behind that owner. Subtract
  // the owner's currently-held paths from the set we head-waiter-check.
  const ownedRows = await tx<Array<{ path: string; lock_id: string }>>`
    SELECT path, lock_id::text AS lock_id FROM agent_file_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND owner = ${owner}
       AND path = ANY(${paths}::text[])
       AND expires_ts > clock_timestamp()
  `;
  const ownedSet = new Set(ownedRows.map((r) => r.path));
  const newPaths = paths.filter((p) => !ownedSet.has(p));
  // If the owner already holds at least one of the requested paths,
  // reuse that lock_id for the new path inserts so the entire returned
  // set shares ONE lock_id. Otherwise mixed lock_ids would mean
  // release(lock_id) only frees a subset.
  const existingLockIds = Array.from(new Set(ownedRows.map((r) => r.lock_id)));
  // If owner happens to hold multiple existing lock_ids on the
  // requested paths (acquired via separate calls), we can't unify
  // them in one upsert — pick the first and document the constraint
  // for callers.
  const reusableLockId = existingLockIds[0];
  // If every requested path is already owned by us, skip the head-waiter
  // check entirely — pure refresh.
  const blocked = newPaths.length === 0
    ? []
    : await tx<Array<{ blocked: true }>>`
        SELECT TRUE AS blocked FROM agent_lock_waiters
         WHERE coordination_domain = ${coordinationDomain}
           AND status = 'waiting'
           -- A waiter whose wait_until has elapsed is effectively dead
           -- (crashed agent / timed-out wait) and must not block a new
           -- acquire even if the janitor hasn't swept it yet
           -- (file-locking #4 — robust regardless of sweep timing).
           AND wait_until > clock_timestamp()
           AND paths && ${newPaths}::text[]
           AND queued_ts < clock_timestamp()
         LIMIT 1
      `;
  if (blocked.length > 0) {
    const busy = await readBusySnapshot(tx, coordinationDomain, paths, owner);
    return { ok: false, busy };
  }

  // Step 2b: pre-check that every NEW path (not already ours) is
  // either free or expired. Otherwise an upsert that partially fails
  // would still refresh our existing rows as a side effect (extending
  // their TTL and clobbering their intent). We deliberately mutate
  // ONLY on full success.
  if (newPaths.length > 0) {
    const blockedRows = await tx<Array<{ path: string }>>`
      SELECT path FROM agent_file_locks
       WHERE coordination_domain = ${coordinationDomain}
         AND path = ANY(${newPaths}::text[])
         AND expires_ts > clock_timestamp()
         AND owner != ${owner}
    `;
    if (blockedRows.length > 0) {
      const busy = await readBusySnapshot(tx, coordinationDomain, paths, owner);
      return { ok: false, busy };
    }
  }

  // Step 3: atomic upsert.
  // Use the reusable lock_id from any same-owner row we're refreshing,
  // so the returned lock_id matches every row this call creates or
  // refreshes. Without this, new paths in an extending acquire get a
  // fresh lock_id while refreshed paths keep their old one — caller
  // sees one lock_id but DB has two, and release-by-id leaks the
  // mismatched subset.
  const lockId = reusableLockId ?? crypto.randomUUID();
  const ttlText = `${ttlSec} seconds`;

  // Step 2b above already excludes the "another live owner holds one
  // of our paths" case, so by the time we reach the upsert every path
  // is either free or already-ours. The ON CONFLICT branch refreshes
  // OUR rows (or steals expired ones); the INSERT branch covers the
  // never-existed rows. The upsert ALWAYS takes every requested path
  // — file-locking #6 removes the former `(xmax = 0) AS is_new`
  // partial-rollback machinery that became dead code when Step 2b
  // landed. (xmax is PG-internal and not part of the documented
  // stable API; the new shape avoids depending on it.)
  const upserted = await tx<Array<{ path: string; lock_id: string }>>`
    WITH wanted AS (SELECT unnest(${paths}::text[]) AS path)
    INSERT INTO agent_file_locks
      (coordination_domain, path, owner, owner_label, intent, lock_id, acquired_ts, expires_ts)
    SELECT
      ${coordinationDomain}, w.path, ${owner}, ${ownerLabel}, ${intent},
      ${lockId}::uuid, clock_timestamp(), clock_timestamp() + ${ttlText}::interval
    FROM wanted w
    ON CONFLICT (coordination_domain, path) DO UPDATE
      SET owner       = EXCLUDED.owner,
          owner_label = EXCLUDED.owner_label,
          intent      = EXCLUDED.intent,
          lock_id     = EXCLUDED.lock_id,
          acquired_ts = clock_timestamp(),
          expires_ts  = EXCLUDED.expires_ts
      -- Refresh on two conditions:
      --   1. Expired locks (anyone can steal a stale row).
      --   2. Same-owner re-acquire (consecutive edits to the same
      --      file must not lock the agent out of itself).
      WHERE agent_file_locks.expires_ts <= clock_timestamp()
         OR agent_file_locks.owner = EXCLUDED.owner
    RETURNING path, lock_id
  `;

  // Defense in depth: if the upsert returned fewer rows than requested
  // a race slipped past Step 2b (e.g. another tx inserted between our
  // pre-check and the upsert). Surface as busy with no partial state
  // — the upsert never partially commits because we run inside a
  // single transaction.
  if (upserted.length !== paths.length) {
    const busy = await readBusySnapshot(tx, coordinationDomain, paths, owner);
    return { ok: false, busy };
  }

  const effectiveLockId = upserted[0].lock_id;
  return {
    ok: true,
    lock_id: effectiveLockId,
    expires_ts: new Date(Date.now() + ttlSec * 1000),
    held: paths,
  };
}

async function readBusySnapshot(
  tx: Sql,
  coordinationDomain: string,
  paths: string[],
  excludeOwner?: string,
): Promise<AcquireBusy[]> {
  const ownerFilter = excludeOwner
    ? tx`AND owner != ${excludeOwner}`
    : tx``;
  const rows = await tx<
    Array<{
      path: string;
      owner: string;
      owner_label: string | null;
      intent: string;
      expires_ts: Date;
    }>
  >`
    SELECT path, owner, owner_label, intent, expires_ts
      FROM agent_file_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND path = ANY(${paths}::text[])
       AND expires_ts > clock_timestamp()
       ${ownerFilter}
  `;
  return rows;
}

// ───────── Release ─────────

export interface ReleaseParams {
  coordinationDomain: string;
  owner: string;
  lockId?: string;
  paths?: string[];
  allMine?: boolean;
}

export async function tryRelease(
  tx: Sql,
  params: ReleaseParams,
): Promise<{ released: string[] }> {
  const { coordinationDomain, owner, lockId, paths, allMine } = params;

  await tx`SET LOCAL statement_timeout = '5s'`;

  // Sweep this workspace's expired locks + orphaned waiters so the
  // cascade below works from clean state. Release fires its own
  // unconditional cascade at the end of the function, so we ignore the
  // swept flag here (a janitor-driven cascade would be redundant).
  await sweepWorkspaceExpired(tx, coordinationDomain);

  let released: Array<{ path: string }>;

  if (allMine) {
    released = await tx<Array<{ path: string }>>`
      DELETE FROM agent_file_locks
       WHERE coordination_domain = ${coordinationDomain}
         AND owner = ${owner}
      RETURNING path
    `;
  } else if (lockId && paths && paths.length > 0) {
    // Owner check (bug #16): lock_id alone is unguessable but it's
    // persisted in tool_invocations.result_json (audit:read can read
    // it). Require owner match so a leaked lock_id can't be used by
    // another agent to release someone else's lock.
    released = await tx<Array<{ path: string }>>`
      DELETE FROM agent_file_locks
       WHERE coordination_domain = ${coordinationDomain}
         AND lock_id = ${lockId}::uuid
         AND owner = ${owner}
         AND path = ANY(${paths}::text[])
      RETURNING path
    `;
  } else if (lockId) {
    released = await tx<Array<{ path: string }>>`
      DELETE FROM agent_file_locks
       WHERE coordination_domain = ${coordinationDomain}
         AND lock_id = ${lockId}::uuid
         AND owner = ${owner}
      RETURNING path
    `;
  } else {
    throw new Error('locks:release requires lock_id or all_mine');
  }

  // Run the cascade. NOTIFY fires inside; we don't need the result set.
  await tx`SELECT grant_cascade(${coordinationDomain}, clock_timestamp())`;

  return { released: released.map((r) => r.path) };
}

// ───────── Heartbeat ─────────

export interface HeartbeatResult {
  expires_ts: Date | null;
  extended: boolean;
}

export async function tryHeartbeat(
  tx: Sql,
  coordinationDomain: string,
  owner: string,
  lockId: string,
  ttlSec: number,
): Promise<HeartbeatResult> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  // Sweep this workspace's expired rows; fire the cascade if anything
  // was freed (a waiter behind a now-swept lock should wake).
  const swept = await sweepWorkspaceExpired(tx, coordinationDomain);
  if (swept) {
    await tx`SELECT grant_cascade(${coordinationDomain}, clock_timestamp())`;
  }
  const ttlText = `${ttlSec} seconds`;
  // Owner check (bug #17): like release, require owner match so a
  // leaked lock_id can't be used to extend someone else's TTL.
  const rows = await tx<Array<{ expires_ts: Date }>>`
    UPDATE agent_file_locks
       SET expires_ts = clock_timestamp() + ${ttlText}::interval
     WHERE coordination_domain = ${coordinationDomain}
       AND lock_id = ${lockId}::uuid
       AND owner = ${owner}
       AND expires_ts > clock_timestamp()
     RETURNING expires_ts
  `;
  if (rows.length === 0) return { expires_ts: null, extended: false };
  return { expires_ts: rows[0].expires_ts, extended: true };
}

// ───────── Queue (read-only — no advisory lock) ─────────

export interface QueueParams {
  coordinationDomain: string;
  paths?: string[];
  owner?: string;
  includeCompleted?: boolean;
}

export interface ActiveLockRow {
  path: string;
  owner: string;
  owner_label: string | null;
  intent: string;
  acquired_ts: Date;
  expires_ts: Date;
}

export interface WaiterRow {
  ticket_id: string;
  owner: string;
  owner_label: string | null;
  paths: string[];
  intent: string;
  queued_ts: Date;
  wait_until: Date;
  status: 'waiting' | 'granted' | 'expired' | 'cancelled';
  ahead_count?: number;
}

export interface QueueResult {
  active_locks: ActiveLockRow[];
  waiting: WaiterRow[];
  completed?: WaiterRow[];
}

export async function readQueue(
  sqlIn: Sql,
  params: QueueParams,
): Promise<QueueResult> {
  // Wrap in a transaction so SET LOCAL statement_timeout is scoped to
  // this read (plan §6.1: queue = 1000ms). Without a transaction,
  // SET LOCAL is a no-op; SET (without LOCAL) would leak across the
  // pool. The transaction is read-only — no advisory lock needed.
  return sqlIn.begin(async (sql) => {
    await sql`SET LOCAL statement_timeout = '1s'`;
    return readQueueInner(sql as unknown as Sql, params);
  }) as Promise<QueueResult>;
}

async function readQueueInner(
  sql: Sql,
  params: QueueParams,
): Promise<QueueResult> {
  const { coordinationDomain, paths, owner, includeCompleted } = params;

  const lockFilter = paths && paths.length > 0
    ? sql`AND path = ANY(${paths}::text[])`
    : sql``;
  const ownerFilter = owner ? sql`AND owner = ${owner}` : sql``;

  const active = await sql<Array<ActiveLockRow>>`
    SELECT path, owner, owner_label, intent, acquired_ts, expires_ts
      FROM agent_file_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND expires_ts > clock_timestamp()
       ${lockFilter}
       ${ownerFilter}
     ORDER BY acquired_ts ASC
  `;

  const pathOverlap = paths && paths.length > 0
    ? sql`AND paths && ${paths}::text[]`
    : sql``;

  const waiting = await sql<Array<WaiterRow & { ahead_count: number }>>`
    SELECT ticket_id, owner, owner_label, paths, intent, queued_ts, wait_until,
           status::text AS status,
           (ROW_NUMBER() OVER (ORDER BY queued_ts ASC, ticket_id ASC) - 1)::int AS ahead_count
      FROM agent_lock_waiters
     WHERE coordination_domain = ${coordinationDomain}
       AND status = 'waiting'
       ${pathOverlap}
       ${ownerFilter}
     ORDER BY queued_ts ASC, ticket_id ASC
  `;

  const result: QueueResult = { active_locks: active, waiting };

  if (includeCompleted) {
    result.completed = await sql<Array<WaiterRow>>`
      SELECT ticket_id, owner, owner_label, paths, intent, queued_ts, wait_until,
             status::text AS status
        FROM agent_lock_waiters
       WHERE coordination_domain = ${coordinationDomain}
         AND status IN ('granted','expired','cancelled')
         AND queued_ts > clock_timestamp() - interval '24 hours'
         ${pathOverlap}
         ${ownerFilter}
       ORDER BY queued_ts DESC
       LIMIT 50
    `;
  }

  return result;
}

// ───────── Waiter insert (Phase 2 — wait path) ─────────

export const MAX_WAITERS_PER_OWNER = 10;

export interface InsertWaiterParams {
  coordinationDomain: string;
  owner: string;
  ownerLabel: string;
  paths: string[];
  intent: string;
  ttlSec: number;
  maxWaitSec: number;
}

export type InsertWaiterResult =
  | { ok: true; ticket_id: string; wait_until: Date }
  // Self-grant — the path freed up between the caller's last
  // try-acquire and this insert call (race between busy-return and
  // INSERT). The waiter was NOT inserted; the caller already holds
  // the lock and should treat this like a direct acquire success.
  | {
      ok: true;
      self_granted: true;
      lock_id: string;
      expires_ts: Date;
      held: string[];
    }
  | { ok: false; reason: 'waiter_cap_exceeded' };

/**
 * Insert a row into agent_lock_waiters. Capped at MAX_WAITERS_PER_OWNER
 * per owner (per-workspace would let one runaway agent jam other
 * agents' queues; per-owner fails loudly for the misbehaving caller
 * only — reviewer #8).
 *
 * Before inserting, attempts a fresh acquire under the workspace
 * advisory lock. Closes the race between the caller's earlier
 * try-acquire-returning-busy and this INSERT — if the holder released
 * in that window, the cascade ran without our row, and our waiter
 * would sit idle on a now-free file.
 */
export async function tryInsertWaiter(
  tx: Sql,
  params: InsertWaiterParams,
): Promise<InsertWaiterResult> {
  // Self-grant attempt first.
  const acquired = await tryAcquire(tx, {
    coordinationDomain: params.coordinationDomain,
    owner: params.owner,
    ownerLabel: params.ownerLabel,
    paths: params.paths,
    intent: params.intent,
    ttlSec: params.ttlSec,
  });
  if (acquired.ok) {
    return {
      ok: true,
      self_granted: true,
      lock_id: acquired.lock_id,
      expires_ts: acquired.expires_ts,
      held: acquired.held,
    };
  }

  await tx`SET LOCAL statement_timeout = '500ms'`;

  // Per-owner cap. NOTE: this counts across all workspaces; runaway
  // loops anywhere stop the owner cold.
  const capRows = await tx<Array<{ at_cap: boolean }>>`
    SELECT count(*) >= ${MAX_WAITERS_PER_OWNER} AS at_cap
      FROM agent_lock_waiters
     WHERE owner = ${params.owner}
       AND status = 'waiting'
  `;
  if (capRows[0]?.at_cap) {
    return { ok: false, reason: 'waiter_cap_exceeded' };
  }

  const waitText = `${params.maxWaitSec} seconds`;
  const rows = await tx<Array<{ ticket_id: string; wait_until: Date }>>`
    INSERT INTO agent_lock_waiters
      (coordination_domain, owner, owner_label, paths, intent, ttl_sec, wait_until)
    VALUES
      (${params.coordinationDomain}, ${params.owner}, ${params.ownerLabel},
       ${params.paths}, ${params.intent}, ${params.ttlSec},
       clock_timestamp() + ${waitText}::interval)
    RETURNING ticket_id, wait_until
  `;
  return { ok: true, ticket_id: rows[0].ticket_id, wait_until: rows[0].wait_until };
}

// ───────── Waiter status read ─────────

export interface WaiterStatus {
  status: 'waiting' | 'granted' | 'expired' | 'cancelled' | 'missing';
  granted_lock_id?: string;
  granted_expires_ts?: Date;
  paths?: string[];
}

export async function readWaiterStatus(
  sql: Sql,
  ticketId: string,
): Promise<WaiterStatus> {
  const rows = await sql<
    Array<{
      status: string;
      granted_lock_id: string | null;
      granted_expires_ts: Date | null;
      paths: string[];
    }>
  >`
    SELECT status::text AS status, granted_lock_id, granted_expires_ts, paths
      FROM agent_lock_waiters
     WHERE ticket_id = ${ticketId}::uuid
     LIMIT 1
  `;
  if (rows.length === 0) return { status: 'missing' };
  const r = rows[0];
  return {
    status: r.status as WaiterStatus['status'],
    granted_lock_id: r.granted_lock_id ?? undefined,
    granted_expires_ts: r.granted_expires_ts ?? undefined,
    paths: r.paths,
  };
}

/**
 * Force a waiter row to 'expired' if it's still 'waiting'. Used when
 * the wait timeout fires. Idempotent — no-op if already terminal.
 */
export async function expireWaiter(
  tx: Sql,
  ticketId: string,
): Promise<void> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  await tx`
    UPDATE agent_lock_waiters
       SET status = 'expired'
     WHERE ticket_id = ${ticketId}::uuid
       AND status = 'waiting'
  `;
}

// ───────── Cancel waiter ─────────

export async function tryCancelWait(
  tx: Sql,
  ticketId: string,
  owner: string,
): Promise<{ cancelled: boolean }> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  // Owner check prevents one agent from cancelling another's waiter.
  const rows = await tx<Array<{ ticket_id: string }>>`
    UPDATE agent_lock_waiters
       SET status = 'cancelled'
     WHERE ticket_id = ${ticketId}::uuid
       AND owner = ${owner}
       AND status = 'waiting'
     RETURNING ticket_id
  `;
  return { cancelled: rows.length > 0 };
}
