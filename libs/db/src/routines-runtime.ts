/**
 * Routines runtime — the substrate's "routine ticker".
 *
 * Evaluates active cron routines and inserts pending_events when they're due.
 */

import type { Sql } from 'postgres';
import { insertPendingEvent } from './pending-events';

export interface RoutineRow {
  id: string;
  /** Workspace that owns this routine (per-window-workspace-context P-041) —
   *  stamped onto the pending_events it fires so the queue is workspace-scoped. */
  workspaceId: string;
  installSlug: string;
  name: string;
  triggerKind: 'cron' | 'webhook' | 'api';
  // Recurrence dialects: cron (5/6-field) OR the RRULE recurrence SET
  // (scheduled-recurring-plans-2026-06-16 D-004). The engine computes next_fire_at
  // from whichever is present (see operator-core schedule-next.ts) — RRULE is never
  // converted to cron. webhook_token/method are for webhook/api trigger kinds.
  triggerConfig: {
    cron?: string;
    rrule?: string;
    dtstart?: string;
    tzid?: string;
    rdate?: string[];
    exdate?: string[];
    webhook_token?: string;
    method?: string;
  };
  targetRole: string;
  payloadTemplate: Record<string, unknown> | null;
  concurrency: 'queue' | 'skip' | 'cancel-prev';
  catchup: 'skip-old' | 'run-all-backlog';
  active: boolean;
  lastFiredAt: Date | null;
  nextFireAt: Date | null;
}

export async function listDueCronRoutines(sql: Sql): Promise<RoutineRow[]> {
  const rows = await sql<any[]>`
    SELECT * FROM harness_shared.routines
     WHERE active = TRUE
       AND trigger_kind = 'cron'
       AND (next_fire_at IS NULL OR next_fire_at <= now())
     ORDER BY next_fire_at ASC NULLS FIRST
  `;
  return rows.map(rowToRoutine);
}

/**
 * Fire a routine: insert pending_event + advance routine's next_fire_at.
 *
 * Returns the event ID + computed next_fire_at, or null if skipped due to
 * concurrency policy.
 */
export async function fireRoutine(
  sql: Sql,
  routine: RoutineRow,
  computeNextFireAt: (cronExpr: string, from: Date) => Date | null
): Promise<{ eventId: string; nextFireAt: Date | null } | null> {
  // Concurrency check.
  if (routine.concurrency === 'skip' || routine.concurrency === 'cancel-prev') {
    const prior = await sql<{ id: string }[]>`
      SELECT id FROM harness_shared.pending_events
       WHERE source_id = ${routine.id} AND consumed_at IS NULL
    `;
    if (prior.length > 0) {
      if (routine.concurrency === 'skip') {
        const next = routine.triggerConfig.cron
          ? computeNextFireAt(routine.triggerConfig.cron, new Date())
          : null;
        await sql`
          UPDATE harness_shared.routines
             SET last_fired_at = now(), next_fire_at = ${next ? next.toISOString() : null}::timestamptz, updated_at = now()
           WHERE id = ${routine.id}
        `;
        return null;
      }
      // cancel-prev: consume all prior unconsumed events from this routine
      await sql`
        UPDATE harness_shared.pending_events
           SET consumed_at = now(), consumed_by = 'routine-ticker:cancel-prev'
         WHERE source_id = ${routine.id} AND consumed_at IS NULL
      `;
    }
  }

  // Insert the pending event.
  const event = await insertPendingEvent(sql, {
    workspaceId: routine.workspaceId,
    installSlug: routine.installSlug,
    kind: 'routine',
    targetRole: routine.targetRole,
    payload: {
      routine_name: routine.name,
      ...(routine.payloadTemplate ?? {}),
    },
    sourceId: routine.id,
  });

  // Advance next_fire_at.
  const next = routine.triggerConfig.cron
    ? computeNextFireAt(routine.triggerConfig.cron, new Date())
    : null;
  await sql`
    UPDATE harness_shared.routines
       SET last_fired_at = now(), next_fire_at = ${next ? next.toISOString() : null}::timestamptz, updated_at = now()
     WHERE id = ${routine.id}
  `;

  return { eventId: event.id, nextFireAt: next };
}

export async function upsertRoutine(
  sql: Sql,
  input: {
    /** Owning workspace — `harness_shared.routines.workspace_id` is NOT NULL with no
     *  column default and no fill trigger, so the caller MUST supply it (resolve via
     *  the active-workspace registry / the project's workspace_id). */
    workspaceId: string;
    installSlug: string;
    name: string;
    triggerKind: 'cron' | 'webhook' | 'api';
    triggerConfig: Record<string, unknown>;
    targetRole: string;
    payloadTemplate?: Record<string, unknown> | null;
    concurrency?: 'queue' | 'skip' | 'cancel-prev';
    catchup?: 'skip-old' | 'run-all-backlog';
    active?: boolean;
    /** Explicit next fire time — a ONE-SHOT routine (cron-kind, no cron expr,
     *  fires once at this instant and is deactivated on claim). Overrides the
     *  cron-derived computation when present. */
    nextFireAt?: Date | null;
  },
  computeNextFireAt: (cronExpr: string, from: Date) => Date | null
): Promise<RoutineRow> {
  const id = `rt_${input.installSlug}_${input.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const nextFireAt =
    'nextFireAt' in input && input.nextFireAt !== undefined
      ? input.nextFireAt
      : input.triggerKind === 'cron' && input.triggerConfig.cron
        ? computeNextFireAt(String(input.triggerConfig.cron), new Date())
        : null;

  const triggerConfigStr = JSON.stringify(input.triggerConfig);
  const payloadTemplateStr = input.payloadTemplate ? JSON.stringify(input.payloadTemplate) : null;
  const nextFireAtStr = nextFireAt ? nextFireAt.toISOString() : null;
  const rows = await sql<any[]>`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at, workspace_id)
    VALUES (
      ${id},
      ${input.installSlug},
      ${input.name},
      ${input.triggerKind},
      ${triggerConfigStr}::text::jsonb,
      ${input.targetRole},
      ${payloadTemplateStr}::text::jsonb,
      ${input.concurrency ?? 'queue'},
      ${input.catchup ?? 'skip-old'},
      ${input.active ?? true},
      ${nextFireAtStr}::timestamptz,
      ${input.workspaceId}
    )
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_kind     = EXCLUDED.trigger_kind,
      trigger_config   = EXCLUDED.trigger_config,
      target_role      = EXCLUDED.target_role,
      payload_template = EXCLUDED.payload_template,
      concurrency      = EXCLUDED.concurrency,
      catchup          = EXCLUDED.catchup,
      active           = EXCLUDED.active,
      next_fire_at     = EXCLUDED.next_fire_at,
      updated_at       = now()
    RETURNING *
  `;
  return rowToRoutine(rows[0]);
}

export async function setRoutineActive(
  sql: Sql,
  installSlug: string,
  name: string,
  active: boolean
): Promise<boolean> {
  const result = await sql`
    UPDATE harness_shared.routines
       SET active = ${active}, updated_at = now()
     WHERE install_slug = ${installSlug} AND name = ${name}
  `;
  return Number((result as { count: number }).count ?? 0) > 0;
}

export async function deleteRoutine(sql: Sql, installSlug: string, name: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM harness_shared.routines
     WHERE install_slug = ${installSlug} AND name = ${name}
  `;
  return Number((result as { count: number }).count ?? 0) > 0;
}

function rowToRoutine(row: any): RoutineRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    installSlug: row.install_slug,
    name: row.name,
    triggerKind: row.trigger_kind,
    triggerConfig: row.trigger_config,
    targetRole: row.target_role,
    payloadTemplate: row.payload_template,
    concurrency: row.concurrency,
    catchup: row.catchup,
    active: row.active,
    lastFiredAt: row.last_fired_at,
    nextFireAt: row.next_fire_at,
  };
}
