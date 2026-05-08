/**
 * Postgres-backed checkpoint signaling — Phase 3 of the orchestrator → PG arc.
 *
 * Replaces filesystem semantics:
 *   - `<stateDir>/checkpoint-<name>.md`         → row with status='pending'
 *   - `<stateDir>/checkpoint-<name>.md.granted` → UPDATE status='granted'
 *   - `<stateDir>/.checkpoint-<name>.fired`     → ANY row's existence (any status)
 *
 * Lifecycle:
 *   pending → granted (via operator UI/CLI) → consumed (orchestrator clears
 *     the gate on its next pre-loop pass).
 *
 * The "any row exists" predicate replaces the FS sentinel: once a checkpoint
 * has been fired even once, re-firing is suppressed regardless of status.
 *
 * Schema:
 *
 *   CREATE TABLE harness_shared.harness_checkpoints (
 *     workspace_id TEXT NOT NULL DEFAULT 'default',
 *     harness_slug TEXT NOT NULL,
 *     name         TEXT NOT NULL,
 *     body_md      TEXT NOT NULL,
 *     status       TEXT NOT NULL DEFAULT 'pending',
 *     fired_at     BIGINT NOT NULL,
 *     resolved_at  BIGINT,
 *     PRIMARY KEY (workspace_id, harness_slug, name)
 *   );
 *
 * The operator can subscribe to LISTEN 'checkpoint:fired' for real-time UI
 * updates (writers issue pg_notify on insert); orchestrator can LISTEN
 * 'checkpoint:granted' to wake immediately on user grant. Both notifications
 * are best-effort — the row state is canonical.
 */
import type { OrchestratorPg } from './invoke';

export interface CheckpointsPgContext {
  pg: OrchestratorPg;
  workspaceId: string;
  harnessSlug: string;
}

export const CHECKPOINTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_checkpoints (
    workspace_id TEXT NOT NULL DEFAULT 'default',
    harness_slug TEXT NOT NULL,
    name         TEXT NOT NULL,
    body_md      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    fired_at     BIGINT NOT NULL,
    resolved_at  BIGINT,
    PRIMARY KEY (workspace_id, harness_slug, name)
  );
  CREATE INDEX IF NOT EXISTS harness_checkpoints_status_idx
    ON harness_shared.harness_checkpoints (workspace_id, harness_slug, status);
`;

/**
 * Fire (or re-acknowledge) a checkpoint. INSERT ON CONFLICT DO NOTHING —
 * matches the FS-sentinel "skip if any prior row exists" semantic.
 *
 * Returns true when a new row was inserted (the checkpoint actually
 * fired this call), false when the row already existed (no-op).
 */
export async function fireCheckpointPg(
  ctx: CheckpointsPgContext,
  name: string,
  bodyMd: string,
): Promise<boolean> {
  const now = Date.now();
  const rows = await ctx.pg<{ inserted: boolean }[]>`
    INSERT INTO harness_shared.harness_checkpoints
      (workspace_id, harness_slug, name, body_md, status, fired_at)
    VALUES (${ctx.workspaceId}, ${ctx.harnessSlug}, ${name}, ${bodyMd},
            'pending', ${now})
    ON CONFLICT (workspace_id, harness_slug, name) DO NOTHING
    RETURNING TRUE AS inserted
  `;
  const inserted = rows.length > 0;
  // Best-effort notify — operator UI subscribers wake on this.
  if (inserted) {
    try {
      await ctx.pg`
        SELECT pg_notify('checkpoint:fired',
          ${JSON.stringify({
            workspace: ctx.workspaceId,
            harness: ctx.harnessSlug,
            name,
          })})
      `;
    } catch {
      /* notify failed; row is canonical */
    }
  }
  return inserted;
}

/** Pending and granted checkpoint names for the active harness. */
export interface CheckpointStatus {
  pending: string[];
  granted: string[];
}

export async function listCheckpointsPg(ctx: CheckpointsPgContext): Promise<CheckpointStatus> {
  const rows = await ctx.pg<{ name: string; status: string }[]>`
    SELECT name, status FROM harness_shared.harness_checkpoints
     WHERE workspace_id = ${ctx.workspaceId}
       AND harness_slug = ${ctx.harnessSlug}
       AND status IN ('pending', 'granted')
     ORDER BY fired_at
  `;
  const pending: string[] = [];
  const granted: string[] = [];
  for (const r of rows) {
    if (r.status === 'pending') pending.push(r.name);
    else if (r.status === 'granted') granted.push(r.name);
  }
  return { pending, granted };
}

/**
 * Mark every granted checkpoint for this harness as 'consumed' (the
 * orchestrator has acknowledged the grant and is proceeding). Returns
 * the names that were cleared.
 */
export async function clearGrantedCheckpointsPg(
  ctx: CheckpointsPgContext,
): Promise<string[]> {
  const now = Date.now();
  const rows = await ctx.pg<{ name: string }[]>`
    UPDATE harness_shared.harness_checkpoints
       SET status      = 'consumed',
           resolved_at = COALESCE(resolved_at, ${now})
     WHERE workspace_id = ${ctx.workspaceId}
       AND harness_slug = ${ctx.harnessSlug}
       AND status       = 'granted'
    RETURNING name
  `;
  return rows.map((r) => r.name);
}

/** Operator-facing helper: mark a specific checkpoint granted. */
export async function grantCheckpointPg(
  ctx: CheckpointsPgContext,
  name: string,
): Promise<boolean> {
  const now = Date.now();
  const rows = await ctx.pg<{ updated: boolean }[]>`
    UPDATE harness_shared.harness_checkpoints
       SET status = 'granted', resolved_at = ${now}
     WHERE workspace_id = ${ctx.workspaceId}
       AND harness_slug = ${ctx.harnessSlug}
       AND name         = ${name}
       AND status       = 'pending'
    RETURNING TRUE AS updated
  `;
  if (rows.length > 0) {
    try {
      await ctx.pg`
        SELECT pg_notify('checkpoint:granted',
          ${JSON.stringify({
            workspace: ctx.workspaceId,
            harness: ctx.harnessSlug,
            name,
          })})
      `;
    } catch {
      /* notify is best-effort */
    }
  }
  return rows.length > 0;
}
