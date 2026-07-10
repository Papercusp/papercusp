/**
 * connect-retry — a narrow, provably-safe retry for a transaction OPEN
 * (`sql.begin(...)`'s `BEGIN` + the setup `SET_CONFIG` statements that run
 * ahead of the caller's own callback) hitting a pooled connection PgBouncer
 * already closed server-side.
 *
 * ## Why this exists (EI-9279)
 *
 * postgres-js keeps a free-list of pooled connections and hands one out for
 * the next query without first probing it. When PgBouncer (:6432) idle-reaps
 * a connection server-side, postgres-js doesn't learn about it until its
 * `close` event fires — a race that can leave a dead connection in the
 * free-list momentarily. A query issued against it fails immediately with
 * `CONNECTION_CLOSED` ("write CONNECTION_CLOSED 127.0.0.1:6432"). This bites
 * hardest on a FRESH SESSION's very first `withWorkspace` call (its pool was
 * just created, or has been idle since the previous session ended) — which is
 * exactly why it kept surfacing on a brand-new agent's mandated first tool
 * call (`coord:orient`), the worst possible place to fail since the agent
 * isn't oriented yet. Observed empirically: the failing call succeeded on
 * manual retry, typically the 2nd or 3rd attempt (WI/EI-9279 evidence).
 *
 * ## Why retrying `sql.begin(...)` as a whole is safe HERE
 *
 * `postgres-js`'s `sql.begin(fn)` sends `BEGIN` and awaits its round trip
 * BEFORE invoking `fn` at all (see `postgres/src/index.js` `begin()`), so a
 * `CONNECTION_CLOSED` thrown before the caller's callback starts PROVABLY
 * means the caller's own queries never reached the server — retrying the
 * whole `sql.begin(...)` (BEGIN + the workspace-context module's own
 * side-effect-free `SET_CONFIG` statements) cannot double-apply anything.
 * The moment the caller's callback starts running its own queries, retry
 * safety is no longer provable in general (a query may have partially
 * executed), so `retryBeforeCallbackStarts` requires the caller to call
 * `markStarted()` as the FIRST line of its callback body and refuses to
 * retry once that flag is set — a genuine mid-transaction failure always
 * propagates untouched, exactly like `pg-transient-retry.ts`'s narrower
 * `isRetriablePgConnectError` (CONNECT_TIMEOUT-only) does for background
 * sweeps. The two modules are deliberately independent (this one lives in
 * `@papercusp/db-org`, which `pg-transient-retry.ts`'s package —
 * `operator-core` — depends ON, not the reverse; a shared import would be a
 * backwards layering violation).
 */

/**
 * True iff `e` looks like a postgres-js connection-setup failure — safe to
 * retry ONLY while nothing has been sent on behalf of the caller's own
 * callback yet (enforced by `retryBeforeCallbackStarts`, not by this
 * predicate alone). Covers both `CONNECTION_CLOSED` (a stale pooled
 * connection PgBouncer already reaped) and `CONNECT_TIMEOUT` (the pool's
 * `connect()` itself timed out) — postgres-js-invented `code`s, so matching
 * on them cannot mask an unrelated application error.
 */
export function isRetriableConnectionSetupError(e: unknown): boolean {
  const x = e as { code?: string; message?: string } | null;
  if (!x) return false;
  if (x.code === 'CONNECTION_CLOSED' || x.code === 'CONNECT_TIMEOUT') return true;
  return /\b(CONNECTION_CLOSED|CONNECT_TIMEOUT)\b/.test(x.message ?? '');
}

export interface RetryBeforeCallbackOpts {
  /** Additional attempts AFTER the first (so total tries = retries + 1). Default 2 —
   *  matches the empirical EI-9279 evidence ("succeeded on 3rd try"). */
  retries?: number;
  /** Base backoff in ms; grows linearly per attempt (backoffMs * attemptNumber). Default 150. */
  backoffMs?: number;
  /** Injectable sleep (tests pass a synchronous stub). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Called just before each scheduled retry (attempt is 1-based). Test/observability hook. */
  onRetry?: (attempt: number, e: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `run`, retrying up to `retries` times on a `CONNECTION_CLOSED` /
 * `CONNECT_TIMEOUT` that strikes BEFORE `run`'s own `markStarted()` call —
 * i.e. before any of the real caller's queries were sent. `run` receives
 * `markStarted` and MUST call it as the first statement of the caller's own
 * callback (after any side-effect-free connection-setup statements the
 * wrapper itself issues, e.g. `SET_CONFIG`). Rethrows the LAST error once
 * retries are exhausted, once `markStarted()` has fired, or for any
 * non-classified error — this helper never swallows a real failure.
 */
export async function retryBeforeCallbackStarts<T>(
  run: (markStarted: () => void) => Promise<T>,
  opts: RetryBeforeCallbackOpts = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 150;
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let started = false;
    try {
      return await run(() => {
        started = true;
      });
    } catch (e) {
      lastErr = e;
      if (started || attempt >= retries || !isRetriableConnectionSetupError(e)) throw e;
      opts.onRetry?.(attempt + 1, e);
      await sleep(backoffMs * (attempt + 1));
    }
  }
  // Unreachable (the loop either returns or throws), but satisfies the type checker.
  throw lastErr;
}
