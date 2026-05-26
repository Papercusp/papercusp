/**
 * Postgres-backed feature state — Phase 1 of the orchestrator → PG arc.
 *
 * Schema layout (matches what the operator already reads/writes):
 *
 *   harness_<slug>.harness_features (workspace_id, feature_id, title, status,
 *     attempts, claims, notes, metadata, ...)
 *
 * Each harness gets its own schema; the orchestrator's pg client is
 * expected to be configured with `search_path=harness_<slug>` (the
 * operator's `dbcFor(slug)` pattern). When that's not feasible, callers
 * can pass a fully-qualified writer that does the search_path SET LOCAL
 * inside a tx — this module only references the unqualified table name.
 *
 * All mutations are workspace-scoped via the `workspace_id` column +
 * an explicit predicate on every UPDATE/SELECT so cross-workspace
 * leakage is impossible even if RLS is misconfigured.
 */
import type { OrchestratorPg } from './invoke';
import type { FeatureRecord } from './types';

export interface PgStateContext {
  pg: OrchestratorPg;
  workspaceId: string;
  /** Optional harness slug — when set, used by setFeatureStatusPg for
   *  the design-phase gate (PAPERCUSP_DESIGN_GATE=1). When unset, gate
   *  is skipped silently (preserves the no-op behavior of pre-gate
   *  callers). */
  harnessSlug?: string;
}

interface FeatureRow {
  feature_id: string;
  title: string | null;
  summary: string | null;
  status: string;
  attempts: number | bigint | null;
  claims: string | string[] | null;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  kind: string | null;
  project_id: string | null;
  expected_cost_cents: number | bigint | null;
  tags: string[] | null;
  needs_human_review: boolean | null;
  ts: number | bigint | null;
  created_ts: number | bigint | null;
  updated_ts: number | bigint | null;
}

function toNum(v: number | bigint | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'bigint' ? Number(v) : v;
}

function rowToFeature(r: FeatureRow): FeatureRecord {
  let claims: string[] | undefined;
  if (Array.isArray(r.claims)) claims = r.claims;
  else if (typeof r.claims === 'string' && r.claims.length > 0) {
    try { claims = JSON.parse(r.claims) as string[]; } catch { /* ignore */ }
  }
  return {
    id: r.feature_id,
    title: r.title ?? '',
    status: r.status as FeatureRecord['status'],
    attempts: toNum(r.attempts),
    ...(claims ? { claims } : {}),
    ...(r.notes ? { notes: r.notes } : {}),
    ...(r.summary ? { summary: r.summary } : {}),
    ...(r.kind ? { kind: r.kind } : {}),
  } as FeatureRecord;
}

/** Read every feature row for the active workspace. */
export async function readFeaturesPg(ctx: PgStateContext): Promise<FeatureRecord[]> {
  const rows = await ctx.pg<FeatureRow[]>`
    SELECT feature_id, title, summary, status, attempts, claims, notes,
           metadata, kind, project_id, expected_cost_cents, tags,
           needs_human_review, ts, created_ts, updated_ts
      FROM harness_features
     WHERE workspace_id = ${ctx.workspaceId}
       AND (
         -- Features not linked to any plan are always eligible (legacy/manual).
         source_plan_slug IS NULL
         OR
         -- Features from plans must belong to a started plan.
         source_plan_slug IN (
           SELECT plan_slug
             FROM harness_shared.harness_plan_status
            WHERE workspace_id = ${ctx.workspaceId}
              AND harness_slug  = ${ctx.harnessSlug ?? ''}
              AND status        = 'started'
         )
       )
     ORDER BY feature_id
  `;
  return rows.map(rowToFeature);
}

/** Return plan slugs that are currently 'started' for this harness. */
export async function readStartedPlanSlugsPg(ctx: PgStateContext): Promise<string[]> {
  if (!ctx.harnessSlug) return [];
  const rows = await ctx.pg<{ plan_slug: string }[]>`
    SELECT plan_slug
      FROM harness_shared.harness_plan_status
     WHERE workspace_id = ${ctx.workspaceId}
       AND harness_slug  = ${ctx.harnessSlug}
       AND status        = 'started'
     ORDER BY plan_slug
  `;
  return rows.map((r) => r.plan_slug);
}

/** True iff the active workspace has at least one feature row. */
export async function featuresExistPg(ctx: PgStateContext): Promise<boolean> {
  const rows = await ctx.pg<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM harness_features WHERE workspace_id = ${ctx.workspaceId}
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

/** Attempts count for a feature, 0 if not present. */
export async function featureAttemptsPg(ctx: PgStateContext, featureId: string): Promise<number> {
  const rows = await ctx.pg<{ attempts: number | bigint | null }[]>`
    SELECT attempts FROM harness_features
     WHERE workspace_id = ${ctx.workspaceId} AND feature_id = ${featureId}
     LIMIT 1
  `;
  return rows.length === 0 ? 0 : toNum(rows[0].attempts);
}

/**
 * Design-phase gate: refuses to flip a feature into `in_progress` when
 * the design phase is still pending.
 *
 * Reads needs_design + design_status from harness_shared.harness_features_consolidated
 * (the canonical store, not per-harness). When needs_design is TRUE and
 * design_status is NULL or 'pending', throws DesignGateError.
 *
 * Off by default — only fires when env PAPERCUSP_DESIGN_GATE=1. Lets
 * existing harnesses ship without surprise gating; opt-in per workspace
 * by setting the env in the operator's startup. Once a harness's
 * features have all been triaged (accepted / ignored), turn the flag
 * on for that workspace.
 *
 * See apps/operator/content/internal-docs/design/design-phase-plan.mdx §2.
 */
export class DesignGateError extends Error {
  readonly featureId: string;
  readonly designStatus: string | null;
  constructor(featureId: string, designStatus: string | null) {
    super(
      `feature ${featureId} cannot transition to in_progress: ` +
        `needs_design=true, design_status=${designStatus ?? 'null'} ` +
        `(must be 'accepted' or 'ignored'). Set design_status=ignored to skip the design phase.`,
    );
    this.name = 'DesignGateError';
    this.featureId = featureId;
    this.designStatus = designStatus;
  }
}

function gateEnabled(): boolean {
  return process.env.PAPERCUSP_DESIGN_GATE === '1';
}

async function checkDesignGate(
  ctx: PgStateContext,
  featureId: string,
  harnessSlug: string,
): Promise<void> {
  if (!gateEnabled()) return;
  const rows = await ctx.pg<{ needs_design: boolean; design_status: string | null }[]>`
    SELECT needs_design, design_status
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${harnessSlug} AND feature_id = ${featureId}
     LIMIT 1
  `;
  const r = rows[0];
  if (!r) return; // no row → can't gate; let the no-op behavior of UPDATE handle it
  if (!r.needs_design) return;
  if (r.design_status === 'accepted' || r.design_status === 'ignored') return;
  throw new DesignGateError(featureId, r.design_status);
}

/**
 * Update a feature's status. Bumps or resets attempts per options. Returns
 * the full feature list after the write. No-op if the feature doesn't
 * exist (matches bash `feature_set_status`'s silent no-op behavior).
 */
export async function setFeatureStatusPg(
  ctx: PgStateContext,
  featureId: string,
  status: FeatureRecord['status'],
  options: { bumpAttempts?: boolean; resetAttempts?: boolean } = {},
): Promise<FeatureRecord[]> {
  const slug = ctx.harnessSlug;
  if (status === 'in_progress' && slug) {
    await checkDesignGate(ctx, featureId, slug);
  }
  const now = Date.now();
  if (options.resetAttempts) {
    await ctx.pg`
      UPDATE harness_features
         SET status = ${status}, attempts = 0, updated_ts = ${now}
       WHERE workspace_id = ${ctx.workspaceId} AND feature_id = ${featureId}
    `;
  } else if (options.bumpAttempts) {
    await ctx.pg`
      UPDATE harness_features
         SET status = ${status},
             attempts = COALESCE(attempts, 0) + 1,
             updated_ts = ${now}
       WHERE workspace_id = ${ctx.workspaceId} AND feature_id = ${featureId}
    `;
  } else {
    await ctx.pg`
      UPDATE harness_features
         SET status = ${status}, updated_ts = ${now}
       WHERE workspace_id = ${ctx.workspaceId} AND feature_id = ${featureId}
    `;
  }
  return readFeaturesPg(ctx);
}
