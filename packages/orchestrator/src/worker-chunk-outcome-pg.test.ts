/**
 * Unit tests for the worker-chunk-loop outcome metrics (P-020) — the pure
 * outcome→record mapping + the completion-rate / outcome-distribution-by-path
 * aggregation. No PG (the write/read round-trip is covered by an integration test).
 */
import { describe, it, expect } from 'vitest';
import {
  outcomeToRecord,
  summarizeWorkerChunkOutcomes,
  type ChunkLoopOutcomeRecord,
} from './worker-chunk-outcome-pg';
import type { ChunkLoopOutcome } from './worker-chunk-loop';

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
    });
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
});
