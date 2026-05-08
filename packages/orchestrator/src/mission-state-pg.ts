/**
 * Postgres-backed mission state — Phase 2 of the orchestrator → PG arc.
 *
 * One row per (workspace_id, harness_slug) holding the small bag of
 * "what happened during this mission" facts that previously lived as
 * scattered files in <stateDir>/:
 *
 *   - escalation.md       → escalation_md (TEXT)
 *   - .cost-warn-fired    → cost_warn_fired (BOOLEAN)
 *   - ready-for-prod.flag → ready_for_prod_at (BIGINT epoch ms; null = unset)
 *   - lanes.json          → lanes (JSONB array of LaneRecord)
 *
 * Lanes go in a JSONB column rather than a separate `harness_lanes` table
 * because the orchestrator's lane pool is small (typically <10 entries),
 * per-harness, and gets fully rewritten on every persist — exactly the
 * shape JSONB-document-per-row optimizes for. (The existing harness_lanes
 * table in harness_shared is a separate concern: bash run.sh's per-role
 * lane bookkeeping. They don't overlap.)
 *
 * Schema (apply via the schema bootstrap helper at module bottom or via
 * the operator's existing migration runner):
 *
 *   CREATE TABLE harness_shared.harness_mission_state (
 *     workspace_id      TEXT NOT NULL DEFAULT 'default',
 *     harness_slug      TEXT NOT NULL,
 *     escalation_md     TEXT,
 *     cost_warn_fired   BOOLEAN NOT NULL DEFAULT false,
 *     ready_for_prod_at BIGINT,
 *     lanes             JSONB NOT NULL DEFAULT '[]'::jsonb,
 *     updated_at        BIGINT NOT NULL,
 *     PRIMARY KEY (workspace_id, harness_slug)
 *   );
 */
import type { OrchestratorPg } from './invoke';

export interface MissionStatePgContext {
  pg: OrchestratorPg;
  workspaceId: string;
  harnessSlug: string;
}

export interface LaneRecordRow {
  id: number;
  feature_id: string;
  started_at: number;
  finished_at?: number;
}

export interface MissionState {
  escalationMd: string | null;
  costWarnFired: boolean;
  readyForProdAt: number | null;
  lanes: LaneRecordRow[];
}

const EMPTY_STATE: MissionState = {
  escalationMd: null,
  costWarnFired: false,
  readyForProdAt: null,
  lanes: [],
};

/** SQL DDL for the mission state table. Idempotent. */
export const MISSION_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_mission_state (
    workspace_id      TEXT NOT NULL DEFAULT 'default',
    harness_slug      TEXT NOT NULL,
    escalation_md     TEXT,
    cost_warn_fired   BOOLEAN NOT NULL DEFAULT false,
    ready_for_prod_at BIGINT,
    lanes             JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at        BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug)
  );
`;

interface MissionStateRow {
  escalation_md: string | null;
  cost_warn_fired: boolean;
  ready_for_prod_at: number | bigint | null;
  lanes: LaneRecordRow[];
}

export async function readMissionState(ctx: MissionStatePgContext): Promise<MissionState> {
  const rows = await ctx.pg<MissionStateRow[]>`
    SELECT escalation_md, cost_warn_fired, ready_for_prod_at, lanes
      FROM harness_shared.harness_mission_state
     WHERE workspace_id = ${ctx.workspaceId} AND harness_slug = ${ctx.harnessSlug}
     LIMIT 1
  `;
  if (rows.length === 0) return { ...EMPTY_STATE };
  const r = rows[0];
  return {
    escalationMd: r.escalation_md,
    costWarnFired: r.cost_warn_fired === true,
    readyForProdAt: r.ready_for_prod_at === null ? null : Number(r.ready_for_prod_at),
    lanes: Array.isArray(r.lanes) ? r.lanes : [],
  };
}

/** UPSERT escalation_md. Other columns preserved. */
export async function setEscalationPg(ctx: MissionStatePgContext, bodyMd: string): Promise<void> {
  const now = Date.now();
  await ctx.pg`
    INSERT INTO harness_shared.harness_mission_state
      (workspace_id, harness_slug, escalation_md, updated_at)
    VALUES (${ctx.workspaceId}, ${ctx.harnessSlug}, ${bodyMd}, ${now})
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE
      SET escalation_md = EXCLUDED.escalation_md,
          updated_at    = EXCLUDED.updated_at
  `;
}

/** UPSERT cost_warn_fired = true. Other columns preserved. */
export async function setCostWarnFiredPg(ctx: MissionStatePgContext): Promise<void> {
  const now = Date.now();
  await ctx.pg`
    INSERT INTO harness_shared.harness_mission_state
      (workspace_id, harness_slug, cost_warn_fired, updated_at)
    VALUES (${ctx.workspaceId}, ${ctx.harnessSlug}, true, ${now})
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE
      SET cost_warn_fired = true,
          updated_at      = EXCLUDED.updated_at
  `;
}

/** True iff cost_warn_fired = true for the active harness. */
export async function readCostWarnFiredPg(ctx: MissionStatePgContext): Promise<boolean> {
  const rows = await ctx.pg<{ cost_warn_fired: boolean }[]>`
    SELECT cost_warn_fired FROM harness_shared.harness_mission_state
     WHERE workspace_id = ${ctx.workspaceId} AND harness_slug = ${ctx.harnessSlug}
     LIMIT 1
  `;
  return rows[0]?.cost_warn_fired === true;
}

/** UPSERT ready_for_prod_at = now-ms. Other columns preserved. */
export async function setReadyForProdPg(ctx: MissionStatePgContext): Promise<void> {
  const now = Date.now();
  await ctx.pg`
    INSERT INTO harness_shared.harness_mission_state
      (workspace_id, harness_slug, ready_for_prod_at, updated_at)
    VALUES (${ctx.workspaceId}, ${ctx.harnessSlug}, ${now}, ${now})
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE
      SET ready_for_prod_at = EXCLUDED.ready_for_prod_at,
          updated_at        = EXCLUDED.updated_at
  `;
}

/** UPSERT the entire lanes array. Other columns preserved. */
export async function persistLanesPg(
  ctx: MissionStatePgContext,
  lanes: LaneRecordRow[],
): Promise<void> {
  const now = Date.now();
  await ctx.pg`
    INSERT INTO harness_shared.harness_mission_state
      (workspace_id, harness_slug, lanes, updated_at)
    VALUES (${ctx.workspaceId}, ${ctx.harnessSlug}, ${JSON.stringify(lanes)}, ${now})
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE
      SET lanes      = EXCLUDED.lanes,
          updated_at = EXCLUDED.updated_at
  `;
}
