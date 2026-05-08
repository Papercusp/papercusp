/**
 * Postgres-backed inter-harness dispatch log — Phase 2 of the
 * orchestrator → PG arc. Replaces `<stateDir>/logs/nexth-<slug>-<ts>.json`
 * with structured rows.
 *
 * Schema:
 *
 *   CREATE TABLE harness_shared.harness_dispatches (
 *     workspace_id  TEXT NOT NULL DEFAULT 'default',
 *     parent_slug   TEXT NOT NULL,
 *     child_slug    TEXT NOT NULL,
 *     child_role    TEXT,
 *     dispatch_at   BIGINT NOT NULL,
 *     result_body   JSONB,
 *     PRIMARY KEY (workspace_id, parent_slug, child_slug, dispatch_at)
 *   );
 */
import type { OrchestratorPg } from './invoke';

export interface DispatchesPgContext {
  pg: OrchestratorPg;
  workspaceId: string;
}

/** SQL DDL for the dispatches table. Idempotent. */
export const DISPATCHES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_dispatches (
    workspace_id  TEXT NOT NULL DEFAULT 'default',
    parent_slug   TEXT NOT NULL,
    child_slug    TEXT NOT NULL,
    child_role    TEXT,
    dispatch_at   BIGINT NOT NULL,
    result_body   JSONB,
    PRIMARY KEY (workspace_id, parent_slug, child_slug, dispatch_at)
  );
  CREATE INDEX IF NOT EXISTS harness_dispatches_parent_idx
    ON harness_shared.harness_dispatches (workspace_id, parent_slug, dispatch_at DESC);
`;

export async function recordDispatchPg(
  ctx: DispatchesPgContext,
  parentSlug: string,
  childSlug: string,
  childRole: string | null,
  resultBody: unknown,
): Promise<void> {
  const now = Date.now();
  // postgres-js coerces a JS string into the jsonb column type via the
  // server-side cast that comes with the column declaration; we just need
  // to pass valid JSON or null. NULL passes through cleanly.
  let bodyJson: string | null = null;
  if (resultBody !== undefined && resultBody !== null) {
    try {
      bodyJson = typeof resultBody === 'string' ? resultBody : JSON.stringify(resultBody);
    } catch {
      bodyJson = null;
    }
  }
  await ctx.pg`
    INSERT INTO harness_shared.harness_dispatches
      (workspace_id, parent_slug, child_slug, child_role, dispatch_at, result_body)
    VALUES (${ctx.workspaceId}, ${parentSlug}, ${childSlug}, ${childRole},
            ${now}, ${bodyJson})
    ON CONFLICT (workspace_id, parent_slug, child_slug, dispatch_at) DO NOTHING
  `;
}
