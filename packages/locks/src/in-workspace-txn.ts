/**
 * Per-workspace transaction wrapper.
 *
 * Every state-mutating tool runs through this. Provides:
 *   - Per-workspace serialization via pg_advisory_xact_lock (key 101 in
 *     `sql/advisory-lock-keys.md`).
 *   - Safe default timeouts (overridden per-op inside the handler).
 *   - application_name tagging for pg_stat_activity visibility.
 *
 * Read-only ops (locks:queue) DO NOT use this wrapper — they don't need
 * the advisory lock and shouldn't pay its cost.
 */

import type { Sql } from 'postgres';
import { ensureBootstrap, getTxPool, SU_LOCKS_FEATURE_KEY } from './su-lock-store';
import { startBackgroundJanitor } from './workspace-listener';

/** True under vitest / NODE_ENV=test — the background janitor timer is
 *  skipped there so no wall-clock tick can race a test's fixtures
 *  (tests drive runBackgroundJanitorOnce() directly). */
function isTestEnv(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
}

export async function inWorkspaceTxn<T>(
  coordinationDomain: string,
  ownerId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  await ensureBootstrap();
  // Arm the background expiry janitor on the first mutating locks:* op
  // (file-locking #4). Idempotent + cheap, so calling it every op is
  // fine; the timer module lives in workspace-listener.ts.
  if (!isTestEnv()) startBackgroundJanitor();
  const sql = getTxPool();
  // postgres-js's `begin` returns the handler's value but wraps it in
  // UnwrapPromiseArray<T>; for our non-array results the cast is safe.
  const result = await sql.begin(async (tx) => {
    // Diagnostic name visible in pg_stat_activity.
    await tx`SELECT set_config('application_name', ${'papercusp-su:' + ownerId}, true)`;
    // Safe defaults — per-op overrides come from the tool handler.
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '5s'`;
    // Workspace-scoped advisory lock. Two-arg form prevents collisions
    // with future features that pick a different feature_key.
    await tx`SELECT pg_advisory_xact_lock(
      ${SU_LOCKS_FEATURE_KEY}::int,
      hashtext(${'su:' + coordinationDomain})
    )`;
    // TransactionSql has the same tagged-template surface as Sql for our
    // purposes; the cast lets store helpers take a single `Sql` type
    // rather than juggling a union that TS can't resolve as callable.
    return fn(tx as unknown as Sql);
  });
  return result as T;
}
