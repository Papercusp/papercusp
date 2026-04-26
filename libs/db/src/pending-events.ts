/**
 * pending_events queue helpers (postgres.js).
 *
 * The orchestrator role reads this queue on every tick (alongside features/
 * issues/etc.) and decides which target_role to dispatch in response.
 *
 * Three sources insert events:
 *   - routine ticker (cron-due routines)
 *   - webhook handlers (POSTs to /api/routines/<id>/trigger)
 *   - API triggers (internal substrate calls)
 *   - completion-delta hooks (e.g. task→passed → notify reviewer)
 */

import type { Sql } from 'postgres';

export interface InsertEventInput {
  installSlug: string;
  kind: 'routine' | 'webhook' | 'api' | 'completion';
  targetRole: string;
  payload?: Record<string, unknown> | null;
  dueAt?: Date | null;
  sourceId?: string | null;
}

export interface PendingEvent {
  id: string;
  installSlug: string;
  kind: string;
  targetRole: string;
  payload: Record<string, unknown> | null;
  dueAt: Date | null;
  createdAt: Date;
  consumedAt: Date | null;
  consumedBy: string | null;
  sourceId: string | null;
}

export async function insertPendingEvent(sql: Sql, input: InsertEventInput): Promise<PendingEvent> {
  const id = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const payloadStr = input.payload ? JSON.stringify(input.payload) : null;
  const dueAtStr = input.dueAt ? input.dueAt.toISOString() : null;
  const rows = await sql<any[]>`
    INSERT INTO harness_shared.pending_events
      (id, install_slug, kind, target_role, payload, due_at, source_id)
    VALUES (
      ${id},
      ${input.installSlug},
      ${input.kind},
      ${input.targetRole},
      ${payloadStr}::jsonb,
      ${dueAtStr}::timestamptz,
      ${input.sourceId ?? null}
    )
    RETURNING *
  `;
  return rowToEvent(rows[0]);
}

export async function listUnconsumedEvents(
  sql: Sql,
  installSlug: string,
  opts: { limit?: number; onlyDue?: boolean } = {}
): Promise<PendingEvent[]> {
  const limit = opts.limit ?? 100;
  const dueClause = opts.onlyDue
    ? sql`AND (due_at IS NULL OR due_at <= now())`
    : sql``;

  const rows = await sql<any[]>`
    SELECT * FROM harness_shared.pending_events
     WHERE install_slug = ${installSlug}
       AND consumed_at IS NULL
       ${dueClause}
     ORDER BY due_at ASC NULLS FIRST, created_at ASC
     LIMIT ${limit}
  `;
  return rows.map(rowToEvent);
}

export async function consumeEvent(sql: Sql, eventId: string, consumedBy: string): Promise<boolean> {
  const result = await sql`
    UPDATE harness_shared.pending_events
       SET consumed_at = now(), consumed_by = ${consumedBy}
     WHERE id = ${eventId} AND consumed_at IS NULL
  `;
  return Number((result as { count: number }).count ?? 0) > 0;
}

export async function consumeEvents(sql: Sql, eventIds: string[], consumedBy: string): Promise<number> {
  if (eventIds.length === 0) return 0;
  const result = await sql`
    UPDATE harness_shared.pending_events
       SET consumed_at = now(), consumed_by = ${consumedBy}
     WHERE id = ANY(${eventIds}::text[])
       AND consumed_at IS NULL
  `;
  return Number((result as { count: number }).count ?? 0);
}

function rowToEvent(row: any): PendingEvent {
  return {
    id: row.id,
    installSlug: row.install_slug,
    kind: row.kind,
    targetRole: row.target_role,
    payload: row.payload,
    dueAt: row.due_at,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
    consumedBy: row.consumed_by,
    sourceId: row.source_id,
  };
}
