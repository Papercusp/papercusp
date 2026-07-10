/**
 * Workspace-context wrapper for harness_shared.* queries.
 *
 * Every read/write against a workspace-scoped table must execute inside
 * a transaction with `SET LOCAL app.workspace_id` set. This module provides
 * the canonical wrapper.
 *
 * Usage:
 *
 *   import { withWorkspace } from '@papercusp/db-org/workspace-context';
 *   const result = await withWorkspace(workspaceId, async (tx) => {
 *     return await tx`SELECT * FROM harness_shared.projects`;
 *   });
 *
 * The `tx` parameter is a postgres-js Sql tagged-template that runs
 * inside the transaction with the GUC set. NEVER reach for the bare-pool
 * `db` import inside the callback — the tx-only ESLint rule will reject
 * that, because a fresh checkout would have no GUC and bypass RLS.
 */

import type { Sql } from 'postgres';
import { getOrgPg, getOrgPgApp, getHarnessPg, pgbouncerEnabled } from './connection';
import { slugToSchemaName } from './schema';
import { retryBeforeCallbackStarts } from './connect-retry';

export interface WorkspaceTxOptions {
  /**
   * If true, skip setting `app.workspace_id` (admin-only escape hatch
   * for migrations that intentionally span workspaces). Default false.
   *
   * Calls passing this MUST be using a connection that BYPASSES RLS
   * (i.e. harness_admin role). Do not use from application code.
   */
  bypassRlsForAdmin?: boolean;
}

/**
 * Run a callback inside a transaction with `app.workspace_id` set.
 *
 * @param workspaceId  Auth-derived workspace identifier. Must be non-empty.
 * @param fn           Callback receiving the transaction-bound Sql client.
 * @param opts         See {@link WorkspaceTxOptions}.
 */
export async function withWorkspace<T>(
  workspaceId: string,
  fn: (tx: Sql) => Promise<T>,
  opts: WorkspaceTxOptions = {},
): Promise<T> {
  if (!workspaceId && !opts.bypassRlsForAdmin) {
    throw new Error(
      'withWorkspace: workspaceId is empty. Auth-derive it from the bearer token; do not pass empty.',
    );
  }
  // Default path: harness_app role, SUBJECT to RLS. The GUC inside the
  // transaction is the load-bearing workspace filter.
  // Admin-bypass path: harness_admin role, RLS bypassed (intentional for
  // migrations and cross-workspace tooling).
  const { sql } = opts.bypassRlsForAdmin ? getOrgPg() : getOrgPgApp();
  // EI-9279: retry a CONNECTION_CLOSED/CONNECT_TIMEOUT hitting a stale pooled
  // connection — but ONLY while `markStarted()` proves the caller's own `fn`
  // hasn't run any query yet (see connect-retry.ts header for why this is
  // provably safe: BEGIN + the SET_CONFIG statements below are side-effect-free,
  // and postgres-js's sql.begin() awaits BEGIN's round trip before invoking the
  // callback at all).
  return retryBeforeCallbackStarts((markStarted) =>
    // postgres-js's `sql.begin` callback receives a TransactionSql which
    // is a subset of Sql; the cast is safe for the operations we perform
    // (templated queries + .unsafe).
    (sql.begin(async (tx) => {
      const txSql = tx as unknown as Sql;
      // postgres-js's TransactionSql is a SUBSET of Sql — it omits
      // `.options` (the parsers/serializers config). drizzle-orm's
      // `drizzle(client)` reads `client.options.parsers` in its
      // constructor, so any `drizzle(tx)` inside a withWorkspace callback
      // throws "Cannot read properties of undefined (reading 'parsers')"
      // (2026-05-22 P5 follow-up — broke harness:list and every other
      // agent-mcp read tool, plus the operator scan-lock). parsers /
      // serializers are connection-scoped, so point the TransactionSql at
      // the parent connection's options object — that satisfies
      // `drizzle(tx)` and is a no-op for raw `tx\`...\`` queries (the
      // parent's options were already drizzle-mutated by getOrgPgApp()).
      const txOpts = txSql as unknown as { options?: unknown };
      txOpts.options ??= (sql as unknown as { options?: unknown }).options;
      // C1-2 of backend-connection-scaling-2026-06-17: under PgBouncer transaction
      // pooling the connect-time search_path is NOT preserved (server connections are
      // shared across clients), so set it per-transaction — mirrors getOrgPg/getOrgPgApp's
      // connect-time value. Gated on pgbouncerEnabled() (the SAME predicate as
      // maybePgbouncer) so the direct-connection default (which already carries the
      // connect-time search_path) is byte-for-byte unchanged, and the pooled path
      // always re-applies the search_path in lockstep with the URL rerouting. This
      // makes the HOT path (every agent tool call) pooler-correct.
      if (pgbouncerEnabled()) {
        await txSql`SELECT set_config('search_path', 'harness_shared, papercusp_shared, public', true)`;
      }
      if (!opts.bypassRlsForAdmin) {
        await txSql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      }
      markStarted();
      return await fn(txSql);
    }) as unknown) as Promise<T>
  );
}

/**
 * Convenience: run a single query in a workspace context. Useful for
 * one-off reads that don't need the multi-statement transaction.
 */
export async function withWorkspaceQuery<T>(
  workspaceId: string,
  query: (tx: Sql) => Promise<T>,
): Promise<T> {
  return withWorkspace(workspaceId, query);
}

/**
 * Run a callback against a harness's per-schema tables/views using a transaction
 * with a per-transaction `SET LOCAL search_path` — the PgBouncer-transaction-safe
 * equivalent of the connect-time search_path that {@link getHarnessPg} sets on its
 * pooled connection. C1-2 of backend-connection-scaling-2026-06-17.
 *
 * Same app role and same search_path order as getHarnessPg. It does NOT set
 * `app.workspace_id`: the per-harness views scope by their baked-in slug and run
 * in the view owner's RLS context (and `harness_issues_consolidated` has no RLS),
 * which is exactly how the getHarnessPg path resolves rows today — verified by the
 * harness-schema integration test. Identifier-quoted the same way connection.ts
 * builds its search_path.
 */
export async function withHarnessSchema<T>(slug: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const searchPath = [slugToSchemaName(slug), 'harness_shared', 'papercusp_shared', 'public']
    .map((s) => `"${s.replace(/"/g, '""')}"`)
    .join(', ');
  const { sql } = getOrgPgApp();
  // EI-9279: same provably-safe retry as withWorkspace above — see connect-retry.ts.
  return retryBeforeCallbackStarts((markStarted) =>
    (sql.begin(async (tx) => {
      const txSql = tx as unknown as Sql;
      // Mirror withWorkspace's options-pointer fix so drizzle(tx) (if ever used) works.
      const txOpts = txSql as unknown as { options?: unknown };
      txOpts.options ??= (sql as unknown as { options?: unknown }).options;
      await txSql`SELECT set_config('search_path', ${searchPath}, true)`;
      markStarted();
      return await fn(txSql);
    }) as unknown) as Promise<T>
  );
}

/**
 * Per-harness-schema query, correct in BOTH connection modes. This is the
 * drop-in replacement for `const { sql } = getHarnessPg(slug); … sql\`…\``.
 *
 *   - Default (direct connection): uses the existing getHarnessPg() pool whose
 *     search_path is set at connect time — byte-identical to today.
 *   - Under PgBouncer (pgbouncerEnabled()): wraps in a transaction with a
 *     per-transaction search_path, because transaction pooling does not preserve
 *     the connect-time one.
 *
 * Multiple statements that must share the harness search_path (e.g. an upsert loop
 * + a reconcile DELETE) MUST go in ONE harnessQuery() callback so they run in the
 * same transaction.
 */
export function harnessQuery<T>(slug: string, fn: (q: Sql) => Promise<T>): Promise<T> {
  if (pgbouncerEnabled()) return withHarnessSchema(slug, fn);
  return fn(getHarnessPg(slug).sql);
}
