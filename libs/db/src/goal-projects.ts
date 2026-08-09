/**
 * The goal ↔ project edge: which harnesses (projects) a goal is pursued
 * through, and what a goal has cost.
 *
 * Sits beside `goal-lineage.ts` rather than in `operator-core/lib` because both
 * sides of the platform need it and only one of them can import the other:
 * `packages/agent-mcp` (which owns the goals:* write tools) does NOT depend on
 * operator-core, while both reach `@papercusp/db-org`.
 *
 * ── The invariant this module exists to protect ─────────────────────────────
 * A project can serve MORE THAN ONE goal (goal-mode-2026-08-07 D-021). "Build
 * the payments library" is genuinely part of *ship a paid app* AND of *cut
 * checkout abandonment* — forcing a project to pick one parent would make the
 * link useless for exactly the projects that matter most. The consequence is
 * counter-intuitive and it is a trap:
 *
 *     GOAL METERS DO NOT SUM.
 *
 * A shared project's spend counts IN FULL against every goal it serves,
 * because from each goal's point of view that is what pursuing it costs. So
 * `goalSpend(A) + goalSpend(B)` DOUBLE-COUNTS anything A and B share, and is
 * never the portfolio total. `portfolioSpend` exists precisely so nobody has to
 * remember that: it sums over DISTINCT projects. The recurrence guard for this
 * lives in `goal-projects.test.ts` — two goals sharing one project must total
 * that project's cost exactly once.
 *
 * ── One MAIN OWNER per project ─────────────────────────────────────────────
 * Every link carries a role. `owner` is the goal a project primarily belongs
 * to; `contributing` is a real but secondary claim. That is enforced by a
 * PARTIAL UNIQUE INDEX in migration 765
 * (`goal_projects_one_owner_per_project`), not by convention here — so
 * `setMainOwner` demotes the incumbent in the same statement rather than
 * racing it.
 *
 * ── Unlink is a tombstone, never a DELETE ──────────────────────────────────
 * `removed_at` is set instead. "This project used to belong to that goal" is
 * exactly the kind of history the owner asks about when a goal's spend looks
 * wrong, and a DELETE destroys it. Every live-set query therefore carries
 * `WHERE removed_at IS NULL`, and the uniqueness indexes are partial on the
 * same predicate so a re-link after a removal is legal.
 */

import type { Sql } from 'postgres';

export type GoalProjectRole = 'owner' | 'contributing';

export interface GoalProjectLink {
  id: string;
  goalId: string;
  harnessSlug: string;
  role: GoalProjectRole;
  addedAt: string;
  addedBy: string | null;
  note: string | null;
  /** Per-link, because a shared project can warrant different criteria per goal. */
  killCriterion: string | null;
}

export interface GoalProjectScope {
  workspaceId: string;
  goalId: string;
  harnessSlug: string;
}

/** One project's contribution to a goal's spend. */
export interface ProjectSpend {
  harnessSlug: string;
  costUsd: number;
  samples: number;
}

export interface GoalSpend {
  goalId: string;
  /** Sum over this goal's linked projects. NOT additive across goals. */
  costUsd: number;
  byProject: ProjectSpend[];
}

interface RawLink {
  id: string;
  goal_id: string;
  harness_slug: string;
  role: string;
  added_at: string | Date;
  added_by: string | null;
  note: string | null;
  kill_criterion: string | null;
}

function toLink(r: RawLink): GoalProjectLink {
  return {
    id: String(r.id),
    goalId: r.goal_id,
    harnessSlug: r.harness_slug,
    role: r.role === 'owner' ? 'owner' : 'contributing',
    addedAt: r.added_at instanceof Date ? r.added_at.toISOString() : String(r.added_at),
    addedBy: r.added_by,
    note: r.note,
    killCriterion: r.kill_criterion,
  };
}

/**
 * Attach a project to a goal, or refresh an existing live link.
 *
 * Idempotent on the live pair: re-linking an already-linked project updates its
 * role/note instead of erroring, because the calling agent is usually asserting
 * a desired state ("this project serves this goal") rather than performing a
 * one-shot transition.
 *
 * Linking as `owner` DEMOTES whatever goal currently owns the project — the
 * partial unique index would otherwise reject the write, and failing here would
 * leave the caller with no way to express a legitimate hand-over.
 */
export async function linkProject(
  sql: Sql,
  opts: GoalProjectScope & {
    role?: GoalProjectRole;
    by?: string | null;
    note?: string | null;
    /** What would make THIS goal stop pursuing THIS project (clause 4). */
    killCriterion?: string | null;
  },
): Promise<GoalProjectLink> {
  const role: GoalProjectRole = opts.role ?? 'contributing';
  if (role === 'owner') {
    await demoteIncumbentOwner(sql, opts);
  }
  const rows = await sql<RawLink[]>`
    INSERT INTO harness_shared.goal_projects
      (workspace_id, goal_id, harness_slug, role, added_by, note, kill_criterion)
    VALUES
      (${opts.workspaceId}, ${opts.goalId}, ${opts.harnessSlug}, ${role},
       ${opts.by ?? null}, ${opts.note ?? null}, ${opts.killCriterion ?? null})
    ON CONFLICT (workspace_id, goal_id, harness_slug) WHERE removed_at IS NULL
    DO UPDATE SET role = EXCLUDED.role,
                  -- COALESCE, so re-attaching to change a role does not erase the
                  -- criterion or the note recorded when the project was adopted.
                  note = COALESCE(EXCLUDED.note, harness_shared.goal_projects.note),
                  kill_criterion = COALESCE(EXCLUDED.kill_criterion,
                                            harness_shared.goal_projects.kill_criterion)
    RETURNING id, goal_id, harness_slug, role, added_at, added_by, note, kill_criterion
  `;
  return toLink(rows[0]!);
}

/**
 * Clear the `owner` role from whichever goal currently holds it for this
 * project — demoting to `contributing` rather than unlinking, because the old
 * owner's involvement is real and losing it would silently drop the project off
 * that goal's page.
 */
async function demoteIncumbentOwner(
  sql: Sql,
  opts: { workspaceId: string; goalId: string; harnessSlug: string },
): Promise<void> {
  await sql`
    UPDATE harness_shared.goal_projects
       SET role = 'contributing'
     WHERE workspace_id = ${opts.workspaceId}
       AND harness_slug = ${opts.harnessSlug}
       AND goal_id <> ${opts.goalId}
       AND role = 'owner'
       AND removed_at IS NULL
  `;
}

/** Promote an existing (or new) link to be the project's one main owner. */
export async function setMainOwner(
  sql: Sql,
  opts: GoalProjectScope & { by?: string | null },
): Promise<GoalProjectLink> {
  return linkProject(sql, { ...opts, role: 'owner' });
}

/**
 * Tombstone the link. Returns false when there was no live link to remove, so
 * a caller can tell "unlinked" from "was never linked" instead of reporting a
 * no-op as success.
 */
export async function unlinkProject(
  sql: Sql,
  opts: GoalProjectScope & { by?: string | null },
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.goal_projects
       SET removed_at = now(), removed_by = ${opts.by ?? null}
     WHERE workspace_id = ${opts.workspaceId}
       AND goal_id = ${opts.goalId}
       AND harness_slug = ${opts.harnessSlug}
       AND removed_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/** The goal's live projects, main owner first. */
export async function projectsForGoal(
  sql: Sql,
  opts: { workspaceId: string; goalId: string },
): Promise<GoalProjectLink[]> {
  const rows = await sql<RawLink[]>`
    SELECT id, goal_id, harness_slug, role, added_at, added_by, note
      FROM harness_shared.goal_projects
     WHERE workspace_id = ${opts.workspaceId}
       AND goal_id = ${opts.goalId}
       AND removed_at IS NULL
     ORDER BY (role = 'owner') DESC, added_at ASC
  `;
  return rows.map(toLink);
}

/**
 * The goals a project serves. This is the read behind the "shared with N goals"
 * badge — the one signal that stops a shared project's spend from looking like
 * a double charge when the owner sees it on two pages.
 */
export async function goalsForProject(
  sql: Sql,
  opts: { workspaceId: string; harnessSlug: string },
): Promise<GoalProjectLink[]> {
  const rows = await sql<RawLink[]>`
    SELECT id, goal_id, harness_slug, role, added_at, added_by, note
      FROM harness_shared.goal_projects
     WHERE workspace_id = ${opts.workspaceId}
       AND harness_slug = ${opts.harnessSlug}
       AND removed_at IS NULL
     ORDER BY (role = 'owner') DESC, added_at ASC
  `;
  return rows.map(toLink);
}

/**
 * What this goal has cost: `agent_usage_samples.cost_usd` summed over its
 * linked projects.
 *
 * ⚠ CALL IT FLEET SPEND, NOT "TOTAL GOAL COST". Measured over 7 days, the
 * spawned roles (cup/mug/kettle/release-fixer/content-fixer) are ~100%
 * harness-attributed, but `role='interactive'` — the goal agent's OWN turns —
 * measures ≈$0 because those are subscription-billed rather than metered. So
 * this number is what the goal's spawned CHILDREN cost, which is the number
 * that actually moves and the one a ceiling should govern; it is not a total
 * cost of ownership.
 */
export async function goalSpend(
  sql: Sql,
  opts: { workspaceId: string; goalId: string; sinceMs?: number },
): Promise<GoalSpend> {
  const since = opts.sinceMs ?? 0;
  const rows = await sql<Array<{ harness_slug: string; cost: string | null; samples: string }>>`
    SELECT s.harness_slug,
           COALESCE(SUM(s.cost_usd), 0) AS cost,
           COUNT(*)                     AS samples
      FROM harness_shared.agent_usage_samples s
      JOIN harness_shared.goal_projects gp
        ON gp.harness_slug = s.harness_slug
       AND gp.workspace_id = s.workspace_id
       AND gp.removed_at IS NULL
     WHERE s.workspace_id = ${opts.workspaceId}
       AND gp.goal_id = ${opts.goalId}
       AND s.ts >= ${since}
     GROUP BY s.harness_slug
     ORDER BY cost DESC
  `;
  const byProject: ProjectSpend[] = rows.map((r) => ({
    harnessSlug: r.harness_slug,
    costUsd: Number(r.cost ?? 0),
    samples: Number(r.samples),
  }));
  return {
    goalId: opts.goalId,
    costUsd: byProject.reduce((acc, p) => acc + p.costUsd, 0),
    byProject,
  };
}

/**
 * Spend across SEVERAL goals, counting each project once.
 *
 * This is NOT `goalSpend` summed. A project serving two of the goals would be
 * charged twice by that sum, inflating the portfolio total by exactly the
 * shared work — the overlap being largest precisely where goals are most
 * related, i.e. where the owner is most likely to be looking. The DISTINCT is
 * the whole point of the function.
 *
 * Pass no `goalIds` to total every goal in the workspace.
 */
export async function portfolioSpend(
  sql: Sql,
  opts: { workspaceId: string; goalIds?: string[]; sinceMs?: number },
): Promise<{ costUsd: number; projects: number; byProject: ProjectSpend[] }> {
  const since = opts.sinceMs ?? 0;
  const goalIds = opts.goalIds ?? null;
  const rows = await sql<Array<{ harness_slug: string; cost: string | null; samples: string }>>`
    WITH linked AS (
      -- DISTINCT is load-bearing: without it a project linked to two of the
      -- named goals joins the usage rows twice and its cost is counted twice.
      SELECT DISTINCT harness_slug
        FROM harness_shared.goal_projects
       WHERE workspace_id = ${opts.workspaceId}
         AND removed_at IS NULL
         AND (${goalIds}::text[] IS NULL OR goal_id = ANY(${goalIds}::text[]))
    )
    SELECT s.harness_slug,
           COALESCE(SUM(s.cost_usd), 0) AS cost,
           COUNT(*)                     AS samples
      FROM harness_shared.agent_usage_samples s
      JOIN linked l ON l.harness_slug = s.harness_slug
     WHERE s.workspace_id = ${opts.workspaceId}
       AND s.ts >= ${since}
     GROUP BY s.harness_slug
     ORDER BY cost DESC
  `;
  const byProject: ProjectSpend[] = rows.map((r) => ({
    harnessSlug: r.harness_slug,
    costUsd: Number(r.cost ?? 0),
    samples: Number(r.samples),
  }));
  return {
    costUsd: byProject.reduce((acc, p) => acc + p.costUsd, 0),
    projects: byProject.length,
    byProject,
  };
}
