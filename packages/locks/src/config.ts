/**
 * Host seam for `@papercusp/locks`.
 *
 * The package owns the entire SU-locks substrate — its own `papercusp_su`
 * side-database, connection pools, migration runner, advisory-lock
 * serialization, grant cascade, wait subsystem, and background janitor.
 * The ONE thing it does NOT know is how to resolve the embedded-pg admin
 * URL for the host's running Postgres instance; that is the embedding
 * application's concern, injected here. This keeps the package free of any
 * `@papercusp/@restart` runtime dependency other than the
 * `@papercusp/file-claim` interface it implements.
 *
 * Deliberately narrow (BRIEF-locks-extraction-2026-05-30, D-010): the seam
 * is a single `() => url` callback, NOT a shared transaction handle. Locks
 * keeps its own DB + pool + `pg_advisory_xact_lock` — that isolation is the
 * point. `coordinationDomain` is an opaque caller-supplied string and is
 * never derived from a workspace/harness noun inside the package.
 */
/**
 * Per-workspace transaction timeouts (PG lock_timeout / statement_timeout, in ms) applied inside
 * inWorkspaceTxn. live-configurability-audit-2026-06-20 P-020 (db:txn-timeouts).
 */
export interface TxnTimeouts {
  /** pg_advisory_xact_lock wait cap (lock_timeout). */
  lockTimeoutMs: number;
  /** Per-statement cap (statement_timeout). */
  statementTimeoutMs: number;
}

/**
 * Minimal structural ticket used to connect the SU pool to a host's
 * acquisition registry without making this host-agnostic package depend on a
 * particular database implementation.
 */
export interface AcquireDiagnosticTicket {
  /** The transaction has obtained a connection and entered its callback. */
  acquired: () => void;
  /** The transaction has settled, whether it committed or failed. */
  release: () => void;
}

/** Optional host-provided bridge to a process-local pool acquisition registry. */
export interface AcquireDiagnostics {
  beginAcquire?: (pool: string) => AcquireDiagnosticTicket | null;
  recordPoolMax?: (pool: string, max: number) => void;
}

/**
 * The baked defaults — the per-workspace txn wrapper's safe floor (5s/5s), the values that shipped
 * before db:txn-timeouts. Used whenever the host wires no getTxnTimeouts callback (the locks package
 * standalone, or tests). MUST stay in lock-step with operator-core's TXN_TIMEOUTS_DEFAULTS.
 */
export const DEFAULT_TXN_TIMEOUTS: TxnTimeouts = { lockTimeoutMs: 5000, statementTimeoutMs: 5000 };

export interface ResourceExpiryRelease {
  coordinationDomain: string;
  resource: string;
}

export interface LocksHost {
  /**
   * Resolve the embedded-pg admin URL for the host's MAIN database (the
   * one the operator normally connects to). The SU side-database URL is
   * derived from it by swapping the database-name path component to
   * `papercusp_su`; bootstrap (`CREATE DATABASE`) connects to this main URL
   * directly. Called per use (not cached here) so the host can run its own
   * connection change-detection.
   */
  getAdminBaseUrl: () => string;
  /**
   * OPTIONAL: resolve the per-workspace transaction timeouts (lock_timeout /
   * statement_timeout in ms) applied inside inWorkspaceTxn. Called per-txn —
   * keep it SYNC + zero-await (the host backs it with its own cache). Omitted
   * ⇒ the baked DEFAULT_TXN_TIMEOUTS (5s/5s), byte-identical to pre-config
   * behavior. Still a value callback, NOT a shared handle — consistent with
   * the deliberately-narrow seam. live-configurability-audit-2026-06-20 P-020.
   */
  getTxnTimeouts?: () => TxnTimeouts;
  /**
   * OPTIONAL: connect this package's pools to a host-local acquisition
   * registry. Missing or failing callbacks are ignored so diagnostics can
   * never change lock behavior.
   */
  acquireDiagnostics?: AcquireDiagnostics;
  /** Committed expiry deletions which left no live exclusive successor. */
  onResourceExpired?: (release: ResourceExpiryRelease) => void | Promise<void>;
}

let _host: LocksHost | null = null;

/**
 * Wire the host seam. The embedding application calls this once at startup,
 * before any locks API is used (the operator's host-adapter barrel calls it
 * at module load — see `apps/operator/lib/agent-tools/locks/configure.ts`).
 */
export function configureLocks(host: LocksHost): void {
  _host = host;
}

/** Internal: read the configured host, throwing if unconfigured. */
export function locksHost(): LocksHost {
  if (!_host) {
    throw new Error(
      '@papercusp/locks: configureLocks() must be called before using the locks API',
    );
  }
  return _host;
}

/** Called only after COMMIT (or a successful atomic statement response). */
export async function notifyResourceExpiries(releases: ResourceExpiryRelease[]): Promise<void> {
  for (const release of releases) {
    try {
      await _host?.onResourceExpired?.(release);
    } catch (error) {
      // Notification failure must not turn a committed lock operation into a retry.
      console.warn('[su-locks] resource expiry notification failed', error);
    }
  }
}

/**
 * Resolve the effective per-workspace transaction timeouts (lock_timeout / statement_timeout in ms)
 * applied inside inWorkspaceTxn. Returns the wired host's getTxnTimeouts() if present, else the baked
 * DEFAULT_TXN_TIMEOUTS. FAIL-SAFE: a missing host, a missing callback, a throw, or a non-finite value
 * all fall back to the 5s/5s default — a config read must never break or unexpectedly change the txn
 * window. live-configurability-audit-2026-06-20 P-020 (db:txn-timeouts).
 */
export function txnTimeouts(): TxnTimeouts {
  const h = _host;
  if (!h?.getTxnTimeouts) return DEFAULT_TXN_TIMEOUTS;
  try {
    const t = h.getTxnTimeouts();
    return {
      lockTimeoutMs: Number.isFinite(t?.lockTimeoutMs) ? t.lockTimeoutMs : DEFAULT_TXN_TIMEOUTS.lockTimeoutMs,
      statementTimeoutMs: Number.isFinite(t?.statementTimeoutMs)
        ? t.statementTimeoutMs
        : DEFAULT_TXN_TIMEOUTS.statementTimeoutMs,
    };
  } catch {
    return DEFAULT_TXN_TIMEOUTS;
  }
}

/**
 * Open a best-effort diagnostic ticket for one SU pool acquisition. The
 * returned methods are guarded individually: a broken observer must not turn
 * a lock operation into a failed lock operation.
 */
export function beginAcquireDiagnostic(pool: string): AcquireDiagnosticTicket | null {
  try {
    const ticket = _host?.acquireDiagnostics?.beginAcquire?.(pool);
    if (!ticket || typeof ticket.acquired !== 'function' || typeof ticket.release !== 'function') {
      return null;
    }
    return {
      acquired: () => {
        try { ticket.acquired(); } catch { /* diagnostics are fail-soft */ }
      },
      release: () => {
        try { ticket.release(); } catch { /* diagnostics are fail-soft */ }
      },
    };
  } catch {
    return null;
  }
}

/** Record the configured SU pool ceiling when the pool is built. */
export function recordPoolMaxDiagnostic(pool: string, max: number): void {
  try {
    _host?.acquireDiagnostics?.recordPoolMax?.(pool, max);
  } catch {
    // Diagnostics must never change pool construction or lock behavior.
  }
}
