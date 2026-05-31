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
import { getOrgPg, getOrgPgApp } from './connection';

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
  // postgres-js's `sql.begin` callback receives a TransactionSql which
  // is a subset of Sql; the cast is safe for the operations we perform
  // (templated queries + .unsafe).
  return (sql.begin(async (tx) => {
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
    if (!opts.bypassRlsForAdmin) {
      await txSql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    }
    return await fn(txSql);
  }) as unknown) as Promise<T>;
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
