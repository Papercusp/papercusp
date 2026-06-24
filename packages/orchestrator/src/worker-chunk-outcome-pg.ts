/**
 * Persistence + aggregation for worker-chunk-loop OUTCOMES — the monitoring metrics
 * surface for the operator-hosted `worker:chunk-loop` rollout
 * (worker-chunk-loop-operator-hosted-2026-06-14 P-020).
 *
 * ONE row per `runWorkerChunkLoop()` call (a feature attempt) into
 * `harness_shared.worker_chunk_loop_outcomes` (migration 394). The record carries the
 * ChunkLoopOutcome KIND and the execution PATH (subprocess vs the operator-hosted op) —
 * neither of which is captured anywhere else (the feature status collapses to
 * 'validating' | 'failing'). This is what the dark-launch parity diff and the ramp gate
 * read: feature completion RATE + outcome DISTRIBUTION, split by path.
 *
 * The write is BEST-EFFORT at the call site: a metrics-persist hiccup must NEVER fail a
 * real feature run (mirrors the bakeoff-delta persist). `recordWorkerChunkOutcome`
 * therefore never throws.
 */
import { type OrchestratorPg } from './invoke.js';
import type { ChunkLoopOutcome } from './worker-chunk-loop.js';

export type WorkerExecutionPath = 'subprocess' | 'op';

/** The persisted/derived shape of a single worker-chunk-loop outcome record. */
export interface ChunkLoopOutcomeRecord {
  executionPath: WorkerExecutionPath;
  outcomeKind: ChunkLoopOutcome['kind'];
  chunksCommitted: number | null;
  replanStrikes: number | null;
  escalatedChunkId: string | null;
  detail: string | null;
}

export interface WorkerChunkOutcomeCtx {
  pg: OrchestratorPg;
  workspaceId: string;
  harnessSlug: string;
}

const DETAIL_LIMIT = 2000;
const clampDetail = (s: string | undefined | null): string | null =>
  s == null ? null : s.length <= DETAIL_LIMIT ? s : `${s.slice(0, DETAIL_LIMIT)}…`;

/**
 * Pure map ChunkLoopOutcome → the persisted record fields. Exhaustive over the union;
 * unit-tested without PG.
 */
export function outcomeToRecord(
  outcome: ChunkLoopOutcome,
  executionPath: WorkerExecutionPath,
): ChunkLoopOutcomeRecord {
  const base = {
    executionPath,
    outcomeKind: outcome.kind,
    chunksCommitted: null as number | null,
    replanStrikes: null as number | null,
    escalatedChunkId: null as string | null,
    detail: null as string | null,
  };
  switch (outcome.kind) {
    case 'completed':
      return { ...base, chunksCommitted: outcome.chunksCommitted };
    case 'planning_failed':
      return { ...base, detail: clampDetail(outcome.error) };
    case 'escalated':
      return {
        ...base,
        replanStrikes: outcome.strikes,
        escalatedChunkId: outcome.chunk.id,
        detail: clampDetail(outcome.reason),
      };
    case 'aborted':
      return { ...base, detail: clampDetail(outcome.reason) };
  }
}

/**
 * Persist one outcome record. BEST-EFFORT — never throws (a metrics hiccup must not fail
 * the loop). Returns true on a successful insert, false on any error (logged via `log`).
 */
export async function recordWorkerChunkOutcome(
  ctx: WorkerChunkOutcomeCtx,
  args: {
    featureId: string;
    executionPath: WorkerExecutionPath;
    outcome: ChunkLoopOutcome;
    atMs?: number;
    log?: (msg: string) => void;
  },
): Promise<boolean> {
  try {
    const rec = outcomeToRecord(args.outcome, args.executionPath);
    const createdTs = args.atMs ?? Date.now();
    await ctx.pg`
      INSERT INTO harness_shared.worker_chunk_loop_outcomes
        (workspace_id, harness_slug, feature_id, execution_path, outcome_kind,
         chunks_committed, replan_strikes, escalated_chunk_id, detail, created_ts)
      VALUES
        (${ctx.workspaceId}, ${ctx.harnessSlug}, ${args.featureId}, ${rec.executionPath},
         ${rec.outcomeKind}, ${rec.chunksCommitted}, ${rec.replanStrikes},
         ${rec.escalatedChunkId}, ${rec.detail}, ${createdTs})
    `;
    return true;
  } catch (err) {
    args.log?.(
      `worker-chunk outcome persist failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Read recent outcome records for aggregation (operator/dev-tool side). Filters by
 * workspace (RLS + explicit) and an optional time window / harness.
 */
export async function readWorkerChunkOutcomes(
  ctx: { pg: OrchestratorPg; workspaceId: string },
  opts: { sinceMs?: number; harnessSlug?: string; limit?: number } = {},
): Promise<ChunkLoopOutcomeRecord[]> {
  const since = opts.sinceMs ?? 0;
  const limit = Math.max(1, Math.min(opts.limit ?? 5000, 20000));
  const harness = opts.harnessSlug ?? null;
  const rows = (await ctx.pg`
    SELECT execution_path, outcome_kind, chunks_committed, replan_strikes,
           escalated_chunk_id, detail
    FROM harness_shared.worker_chunk_loop_outcomes
    WHERE workspace_id = ${ctx.workspaceId}
      AND created_ts >= ${since}
      AND (${harness}::text IS NULL OR harness_slug = ${harness})
    ORDER BY created_ts DESC
    LIMIT ${limit}
  `) as unknown as Array<{
    execution_path: string;
    outcome_kind: string;
    chunks_committed: number | null;
    replan_strikes: number | null;
    escalated_chunk_id: string | null;
    detail: string | null;
  }>;
  return rows.map((r) => ({
    executionPath: r.execution_path as WorkerExecutionPath,
    outcomeKind: r.outcome_kind as ChunkLoopOutcome['kind'],
    chunksCommitted: r.chunks_committed,
    replanStrikes: r.replan_strikes,
    escalatedChunkId: r.escalated_chunk_id,
    detail: r.detail,
  }));
}

export interface WorkerChunkPathMetrics {
  path: WorkerExecutionPath;
  total: number;
  /** completed / total (0..1); null when total === 0. */
  completionRate: number | null;
  /** counts per outcome kind. */
  distribution: Record<ChunkLoopOutcome['kind'], number>;
  /** mean replan strikes across escalated runs; null when none escalated. */
  avgReplanStrikes: number | null;
  /** mean chunks committed across completed runs; null when none completed. */
  avgChunksCommitted: number | null;
}

export interface WorkerChunkMetrics {
  byPath: Record<WorkerExecutionPath, WorkerChunkPathMetrics>;
  /** op-vs-subprocess completion-rate delta (op − subprocess); null if either path has 0 runs. */
  completionRateDelta: number | null;
}

const ZERO_DIST = (): Record<ChunkLoopOutcome['kind'], number> => ({
  completed: 0,
  planning_failed: 0,
  escalated: 0,
  aborted: 0,
});

function summarizePath(path: WorkerExecutionPath, rows: ChunkLoopOutcomeRecord[]): WorkerChunkPathMetrics {
  const dist = ZERO_DIST();
  let strikeSum = 0;
  let strikeN = 0;
  let chunkSum = 0;
  let chunkN = 0;
  for (const r of rows) {
    dist[r.outcomeKind] = (dist[r.outcomeKind] ?? 0) + 1;
    if (r.outcomeKind === 'escalated' && r.replanStrikes != null) {
      strikeSum += r.replanStrikes;
      strikeN += 1;
    }
    if (r.outcomeKind === 'completed' && r.chunksCommitted != null) {
      chunkSum += r.chunksCommitted;
      chunkN += 1;
    }
  }
  const total = rows.length;
  return {
    path,
    total,
    completionRate: total === 0 ? null : dist.completed / total,
    distribution: dist,
    avgReplanStrikes: strikeN === 0 ? null : strikeSum / strikeN,
    avgChunksCommitted: chunkN === 0 ? null : chunkSum / chunkN,
  };
}

/**
 * Pure aggregation: the P-020 metric — feature completion RATE + outcome DISTRIBUTION,
 * split by execution PATH (subprocess vs op), plus the op−subprocess completion-rate
 * delta the ramp gate compares against baseline. Unit-tested without PG.
 */
export function summarizeWorkerChunkOutcomes(rows: ChunkLoopOutcomeRecord[]): WorkerChunkMetrics {
  const sub = summarizePath('subprocess', rows.filter((r) => r.executionPath === 'subprocess'));
  const op = summarizePath('op', rows.filter((r) => r.executionPath === 'op'));
  const completionRateDelta =
    sub.completionRate == null || op.completionRate == null
      ? null
      : op.completionRate - sub.completionRate;
  return { byPath: { subprocess: sub, op }, completionRateDelta };
}
