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
