/**
 * Routines runtime — the substrate's "routine ticker".
 *
 * Evaluates active cron routines and inserts pending_events when they're due.
 */

import type { Sql } from 'postgres';
import { insertPendingEvent } from './pending-events';

// workspace-data-isolation-leaks-2026-06-17 F-E1 (phase 1): when ON, upsertRoutine conflicts
// on (workspace_id, install_slug, name) so a same-slug routine in another workspace is NOT
// clobbered (routines already carry workspace_id). OFF (default) = today's ON CONFLICT
// (install_slug, name), byte-identical. This lib can't read feature flags (layer boundary), so
// operator-core pushes the papercusp-routines-per-workspace flag value via the setter below
// (configure seam) at boot + on flag change. Requires migration 305's composite unique index.
let routinesPerWorkspaceConflict = false;
export function setRoutinesPerWorkspaceConflict(on: boolean): void {
  routinesPerWorkspaceConflict = on;
}

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
  /**
   * The LOOP interval (loop-routines-interval-recurrence-2026-06-20 P-001). A loop is
   * the THIRD recurrence kind: NULL = schedule-only (cron/rrule or one-shot — today's
   * behavior); N = re-fire N sec AFTER the previous turn COMPLETES (claim.ts parks it
   * at next_fire_at='infinity' in-flight, the completion-rebase re-arms it). Dedicated
   * column (D-003), not a trigger_config key.
   */
  rescheduleIntervalSec: number | null;
  /**
   * The coord ownerId of the WARM session a loop wakes (P-004 `coord:send {wake}`
   * recipient). NULL for non-loop routines. The ownerId is the stable coord identity
   * (survives `claude --resume`), so the loop keeps waking the SAME logical agent
   * across iterations; the wake-executor resolves owner→session for inject/resume.
   */
  targetOwnerId: string | null;
}

/**
 * next_fire_at='infinity'::timestamptz is the loop in-flight / parked sentinel
 * (claim.ts P-003): the SQL due-guard `next_fire_at <= now()` is FALSE for it, so a
 * parked loop is never re-claimed mid-turn (skip-if-in-flight, for free). But
 * postgres-js parses an `infinity` timestamptz to an INVALID Date (getTime()===NaN),
 * which would throw on `.toISOString()` and mis-sort. rowToRoutine maps it to this
 * max-valid-Date sentinel so every JS reader stays correct AND consistent with the
 * SQL semantics: `.getTime() <= now()` is false (not due), `Boolean(nextFireAt)` is
 * true (a parked loop IS armed, it will fire after its turn settles), `.toISOString()`
 * works, and it sorts LAST (far future). B-LOOP-2's completion-rebase identifies parked
 * loops in SQL (next_fire_at = 'infinity'), never via this JS field.
 */
export const NEXT_FIRE_PARKED = new Date(8_640_000_000_000_000);

/** True when a routine's nextFireAt is the parked-loop sentinel (NEXT_FIRE_PARKED). */
export function isParkedNextFire(nextFireAt: Date | null): boolean {
  return nextFireAt instanceof Date && nextFireAt.getTime() === NEXT_FIRE_PARKED.getTime();
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
    /** LOOP interval in seconds (P-001) — re-fire N sec after the turn completes.
     *  Omit/NULL for a non-loop (cron/rrule/one-shot) routine. */
    rescheduleIntervalSec?: number | null;
    /** The coord ownerId a loop's warm wake is delivered to (P-004). Omit/NULL for
     *  a non-loop routine. */
    targetOwnerId?: string | null;
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
  // F-E1 (phase 1): conflict on (workspace_id, install_slug, name) when per-workspace
  // routines are enabled — otherwise the legacy global (install_slug, name). Both unique
  // targets exist (migration 305 keeps the old one), so this is a clean flag-gated switch.
  const conflictTarget = routinesPerWorkspaceConflict
    ? sql`(workspace_id, install_slug, name)`
    : sql`(install_slug, name)`;
  const rescheduleIntervalSec =
    input.rescheduleIntervalSec === undefined ? null : input.rescheduleIntervalSec;
  const targetOwnerId = input.targetOwnerId === undefined ? null : input.targetOwnerId;
  const rows = await sql<any[]>`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at, workspace_id,
       reschedule_interval_sec, target_owner_id)
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
      ${input.workspaceId},
      ${rescheduleIntervalSec},
      ${targetOwnerId}
    )
    ON CONFLICT ${conflictTarget} DO UPDATE SET
      trigger_kind            = EXCLUDED.trigger_kind,
      trigger_config          = EXCLUDED.trigger_config,
      target_role             = EXCLUDED.target_role,
      payload_template        = EXCLUDED.payload_template,
      concurrency             = EXCLUDED.concurrency,
      catchup                 = EXCLUDED.catchup,
      active                  = EXCLUDED.active,
      next_fire_at            = EXCLUDED.next_fire_at,
      reschedule_interval_sec = EXCLUDED.reschedule_interval_sec,
      target_owner_id         = EXCLUDED.target_owner_id,
      updated_at              = now()
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

/**
 * Normalize a raw next_fire_at into the RoutineRow JS shape. postgres-js parses
 * `infinity`::timestamptz (the loop parked sentinel) to an INVALID Date
 * (getTime()===NaN); map that to NEXT_FIRE_PARKED (a valid far-future Date) so JS
 * readers stay correct (.toISOString(), .getTime() <= now() === false, sorts last)
 * and consistent with the SQL not-due semantics. A real finite Date passes through;
 * NULL stays NULL.
 */
export function normalizeNextFireAt(raw: unknown): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? NEXT_FIRE_PARKED : raw;
  // postgres-js gives a Date for timestamptz; a non-Date here is unexpected, but be
  // robust — try to parse, and treat an unparseable value as the parked sentinel.
  const d = new Date(raw as any);
  return Number.isNaN(d.getTime()) ? NEXT_FIRE_PARKED : d;
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
    nextFireAt: normalizeNextFireAt(row.next_fire_at),
    rescheduleIntervalSec:
      row.reschedule_interval_sec == null ? null : Number(row.reschedule_interval_sec),
    targetOwnerId: row.target_owner_id ?? null,
  };
}
