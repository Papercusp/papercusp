/**
 * Unit tests for the worker-chunk-loop outcome metrics (P-020) — the pure
 * outcome→record mapping + the completion-rate / outcome-distribution-by-path
 * aggregation. No PG (the write/read round-trip is covered by an integration test).
 */
import { describe, it, expect } from 'vitest';
import {
  outcomeToRecord,
  recordWorkerChunkOutcome,
  readWorkerChunkOutcomes,
  summarizeWorkerChunkOutcomes,
  type ChunkLoopOutcomeRecord,
} from './worker-chunk-outcome-pg';
import type { ChunkLoopOutcome } from './worker-chunk-loop';
import type { OrchestratorPg } from './invoke';

/** Tagged-template mock pg: records calls + drives SELECT result (mirrors chunk-plan-pg.test). */
function makeMockPg(selectResult: Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pg = ((template: TemplateStringsArray, ...values: unknown[]) => {
    const sql = template.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ sql, params: values });
    if (/^select\b/i.test(sql)) return Promise.resolve(selectResult);
    return Promise.resolve([]);
  }) as OrchestratorPg;
  return { pg, calls };
}

describe('outcomeToRecord', () => {
  it('maps completed → chunksCommitted, no detail', () => {
    const o: ChunkLoopOutcome = { kind: 'completed', chunksCommitted: 4 };
    expect(outcomeToRecord(o, 'op')).toEqual({
      executionPath: 'op',
      outcomeKind: 'completed',
      chunksCommitted: 4,
      replanStrikes: null,
      escalatedChunkId: null,
      detail: null,
      resumed: null,
      abortReason: null,
      totalReplans: null,
      chunksCommittedSoFar: null,
      totalChunksPlanned: null,
    });
  });

  it('maps the P-020 monitoring fields through when the outcome carries them', () => {
    const o: ChunkLoopOutcome = {
      kind: 'completed',
      chunksCommitted: 4,
      resumed: true,
      totalReplans: 2,
      chunksCommittedSoFar: 4,
      totalChunksPlanned: 5,
    };
    expect(outcomeToRecord(o, 'op')).toMatchObject({
      resumed: true,
      totalReplans: 2,
      chunksCommittedSoFar: 4,
      totalChunksPlanned: 5,
    });
  });

  it('maps aborted abortReason → lock_contention', () => {
    const o: ChunkLoopOutcome = {
      kind: 'aborted',
      reason: 'lock busy',
      abortReason: 'lock_contention',
      chunksCommittedSoFar: 1,
      totalChunksPlanned: 3,
      totalReplans: 0,
    };
    expect(outcomeToRecord(o, 'subprocess')).toMatchObject({
      outcomeKind: 'aborted',
      abortReason: 'lock_contention',
      chunksCommittedSoFar: 1,
      totalChunksPlanned: 3,
    });
  });

  it('does not leak abortReason onto a non-aborted kind', () => {
    const o: ChunkLoopOutcome = { kind: 'completed', chunksCommitted: 1 };
    expect(outcomeToRecord(o, 'op').abortReason).toBeNull();
  });

  it('maps planning_failed → detail=error', () => {
    const o: ChunkLoopOutcome = { kind: 'planning_failed', error: 'no parse' };
    const r = outcomeToRecord(o, 'subprocess');
    expect(r.outcomeKind).toBe('planning_failed');
    expect(r.detail).toBe('no parse');
    expect(r.chunksCommitted).toBeNull();
  });

  it('maps escalated → strikes + escalatedChunkId + reason', () => {
    const o: ChunkLoopOutcome = {
      kind: 'escalated',
      chunk: { id: 'C-2', files: ['a.ts'], description: 'x' },
      reason: 'typecheck still failing',
      strikes: 3,
    };
    const r = outcomeToRecord(o, 'op');
    expect(r).toMatchObject({
      outcomeKind: 'escalated',
      replanStrikes: 3,
      escalatedChunkId: 'C-2',
      detail: 'typecheck still failing',
    });
  });

  it('maps aborted → detail=reason', () => {
    const o: ChunkLoopOutcome = { kind: 'aborted', reason: 'governor max wait' };
    expect(outcomeToRecord(o, 'subprocess').detail).toBe('governor max wait');
  });

  it('clamps an over-long detail with an ellipsis', () => {
    const long = 'x'.repeat(5000);
    const o: ChunkLoopOutcome = { kind: 'aborted', reason: long };
    const r = outcomeToRecord(o, 'op');
    expect(r.detail!.length).toBe(2001); // 2000 + the ellipsis char
    expect(r.detail!.endsWith('…')).toBe(true);
  });
});

const rec = (
  executionPath: 'subprocess' | 'op',
  outcomeKind: ChunkLoopOutcome['kind'],
  extra: Partial<ChunkLoopOutcomeRecord> = {},
): ChunkLoopOutcomeRecord => ({
  executionPath,
  outcomeKind,
  chunksCommitted: null,
  replanStrikes: null,
  escalatedChunkId: null,
  detail: null,
  resumed: null,
  abortReason: null,
  totalReplans: null,
  chunksCommittedSoFar: null,
  totalChunksPlanned: null,
  ...extra,
});

describe('summarizeWorkerChunkOutcomes', () => {
  it('returns null rates + zeroed distribution for empty input', () => {
    const m = summarizeWorkerChunkOutcomes([]);
    expect(m.byPath.subprocess.total).toBe(0);
    expect(m.byPath.op.total).toBe(0);
    expect(m.byPath.subprocess.completionRate).toBeNull();
    expect(m.completionRateDelta).toBeNull();
    expect(m.byPath.op.distribution).toEqual({
      completed: 0,
      planning_failed: 0,
      escalated: 0,
      aborted: 0,
    });
  });

  it('splits distribution + completion rate by path and computes the delta', () => {
    const rows: ChunkLoopOutcomeRecord[] = [
      // subprocess: 3 completed / 4 total = 0.75
      rec('subprocess', 'completed', { chunksCommitted: 2 }),
      rec('subprocess', 'completed', { chunksCommitted: 4 }),
      rec('subprocess', 'completed', { chunksCommitted: 6 }),
      rec('subprocess', 'escalated', { replanStrikes: 2, escalatedChunkId: 'C-1' }),
      // op: 1 completed / 2 total = 0.5
      rec('op', 'completed', { chunksCommitted: 3 }),
      rec('op', 'aborted', { detail: 'x' }),
    ];
    const m = summarizeWorkerChunkOutcomes(rows);

    expect(m.byPath.subprocess.total).toBe(4);
    expect(m.byPath.subprocess.completionRate).toBeCloseTo(0.75);
    expect(m.byPath.subprocess.distribution.completed).toBe(3);
    expect(m.byPath.subprocess.distribution.escalated).toBe(1);
    expect(m.byPath.subprocess.avgChunksCommitted).toBeCloseTo((2 + 4 + 6) / 3);
    expect(m.byPath.subprocess.avgReplanStrikes).toBe(2);

    expect(m.byPath.op.total).toBe(2);
    expect(m.byPath.op.completionRate).toBeCloseTo(0.5);
    expect(m.byPath.op.distribution.aborted).toBe(1);
    expect(m.byPath.op.avgReplanStrikes).toBeNull(); // none escalated

    // op (0.5) − subprocess (0.75) = −0.25 (a regression the ramp gate would catch)
    expect(m.completionRateDelta).toBeCloseTo(-0.25);
  });

  it('leaves the delta null when one path has no runs', () => {
    const m = summarizeWorkerChunkOutcomes([rec('subprocess', 'completed', { chunksCommitted: 1 })]);
    expect(m.byPath.op.total).toBe(0);
    expect(m.completionRateDelta).toBeNull();
  });

  it('computes file-lock contention rate from aborted+lock_contention rows', () => {
    const rows: ChunkLoopOutcomeRecord[] = [
      rec('op', 'aborted', { abortReason: 'lock_contention' }),
      rec('op', 'aborted', { abortReason: 'scratch_setup' }),
      rec('op', 'completed', { chunksCommitted: 1 }),
    ];
    const m = summarizeWorkerChunkOutcomes(rows);
    expect(m.byPath.op.lockContentionCount).toBe(1);
    expect(m.byPath.op.lockContentionRate).toBeCloseTo(1 / 3);
    expect(m.byPath.subprocess.lockContentionRate).toBeNull(); // total === 0
  });

  it('computes replan frequency across ALL runs, not just escalated ones', () => {
    const rows: ChunkLoopOutcomeRecord[] = [
      rec('op', 'completed', { chunksCommitted: 2, totalReplans: 0 }),
      rec('op', 'completed', { chunksCommitted: 1, totalReplans: 2 }),
      rec('op', 'escalated', { replanStrikes: 3, escalatedChunkId: 'C-1', totalReplans: 3 }),
    ];
    const m = summarizeWorkerChunkOutcomes(rows);
    expect(m.byPath.op.avgTotalReplans).toBeCloseTo((0 + 2 + 3) / 3);
    expect(m.byPath.op.replanRate).toBeCloseTo(2 / 3); // 2 of 3 runs needed >=1 replan
  });

  it('avgTotalReplans/replanRate are null when no row reports totalReplans (pre-428 data)', () => {
    const m = summarizeWorkerChunkOutcomes([rec('op', 'completed', { chunksCommitted: 1 })]);
    expect(m.byPath.op.avgTotalReplans).toBeNull();
    expect(m.byPath.op.replanRate).toBeNull();
  });

  it('computes crash-resume success rate from resumed rows only', () => {
    const rows: ChunkLoopOutcomeRecord[] = [
      rec('op', 'completed', { chunksCommitted: 1, resumed: true }),
      rec('op', 'aborted', { resumed: true, abortReason: 'lock_contention' }),
      rec('op', 'completed', { chunksCommitted: 1, resumed: false }),
    ];
    const m = summarizeWorkerChunkOutcomes(rows);
    expect(m.byPath.op.resumedCount).toBe(2);
    expect(m.byPath.op.resumedCompletionRate).toBeCloseTo(0.5); // 1 of 2 resumed runs completed
  });

  it('resumedCompletionRate is null when no run resumed', () => {
    const m = summarizeWorkerChunkOutcomes([rec('op', 'completed', { chunksCommitted: 1, resumed: false })]);
    expect(m.byPath.op.resumedCount).toBe(0);
    expect(m.byPath.op.resumedCompletionRate).toBeNull();
  });

  it('computes per-chunk durability as committed/planned across all runs with a plan size', () => {
    const rows: ChunkLoopOutcomeRecord[] = [
      rec('op', 'completed', { chunksCommitted: 3, chunksCommittedSoFar: 3, totalChunksPlanned: 3 }),
      rec('op', 'escalated', {
        replanStrikes: 3,
        escalatedChunkId: 'C-2',
        chunksCommittedSoFar: 1,
        totalChunksPlanned: 4,
      }),
    ];
    const m = summarizeWorkerChunkOutcomes(rows);
    expect(m.byPath.op.perChunkDurability).toBeCloseTo((3 + 1) / (3 + 4));
  });

  it('perChunkDurability is null when no run reports a plan size', () => {
    const m = summarizeWorkerChunkOutcomes([rec('op', 'completed', { chunksCommitted: 1 })]);
    expect(m.byPath.op.perChunkDurability).toBeNull();
  });
});

describe('recordWorkerChunkOutcome (mock pg)', () => {
  it('INSERTs the mapped fields in column order', async () => {
    const m = makeMockPg();
    const ok = await recordWorkerChunkOutcome(
      { pg: m.pg, workspaceId: 'ws-1', harnessSlug: 'sb' },
      {
        featureId: 'F-9',
        executionPath: 'op',
        outcome: { kind: 'completed', chunksCommitted: 5 },
        atMs: 1717,
      },
    );
    expect(ok).toBe(true);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].sql).toMatch(/^insert into harness_shared\.worker_chunk_loop_outcomes/i);
    // (workspace_id, harness_slug, feature_id, execution_path, outcome_kind,
    //  chunks_committed, replan_strikes, escalated_chunk_id, detail, created_ts,
    //  resumed, abort_reason, total_replans, chunks_committed_so_far, total_chunks_planned)
    expect(m.calls[0].params).toEqual([
      'ws-1', 'sb', 'F-9', 'op', 'completed', 5, null, null, null, 1717,
      null, null, null, null, null,
    ]);
  });

  it('is best-effort: returns false (does NOT throw) when the insert errors', async () => {
    const throwingPg = (() => Promise.reject(new Error('boom'))) as unknown as OrchestratorPg;
    let logged = '';
    const ok = await recordWorkerChunkOutcome(
      { pg: throwingPg, workspaceId: 'ws-1', harnessSlug: 'sb' },
      {
        featureId: 'F-9',
        executionPath: 'subprocess',
        outcome: { kind: 'aborted', reason: 'x' },
        log: (s) => (logged = s),
      },
    );
    expect(ok).toBe(false);
    expect(logged).toMatch(/persist failed/i);
  });
});

describe('readWorkerChunkOutcomes (mock pg)', () => {
  it('maps raw rows → ChunkLoopOutcomeRecord and SELECTs with the workspace filter', async () => {
    const m = makeMockPg([
      {
        execution_path: 'op',
        outcome_kind: 'escalated',
        chunks_committed: null,
        replan_strikes: 3,
        escalated_chunk_id: 'C-1',
        detail: 'still failing',
        resumed: null,
        abort_reason: null,
        total_replans: 3,
        chunks_committed_so_far: 1,
        total_chunks_planned: 4,
      },
    ]);
    const rows = await readWorkerChunkOutcomes({ pg: m.pg, workspaceId: 'ws-1' }, { harnessSlug: 'sb' });
    expect(m.calls[0].sql).toMatch(/^select .* from harness_shared\.worker_chunk_loop_outcomes/i);
    expect(rows).toEqual([
      {
        executionPath: 'op',
        outcomeKind: 'escalated',
        chunksCommitted: null,
        replanStrikes: 3,
        escalatedChunkId: 'C-1',
        detail: 'still failing',
        resumed: null,
        abortReason: null,
        totalReplans: 3,
        chunksCommittedSoFar: 1,
        totalChunksPlanned: 4,
      },
    ]);
  });

  it('defaults the new P-020 columns to null when the row omits them (pre-428 rows)', async () => {
    const m = makeMockPg([
      {
        execution_path: 'subprocess',
        outcome_kind: 'completed',
        chunks_committed: 2,
        replan_strikes: null,
        escalated_chunk_id: null,
        detail: null,
      },
    ]);
    const rows = await readWorkerChunkOutcomes({ pg: m.pg, workspaceId: 'ws-1' }, {});
    expect(rows[0]).toMatchObject({
      resumed: null,
      abortReason: null,
      totalReplans: null,
      chunksCommittedSoFar: null,
      totalChunksPlanned: null,
    });
  });
});
