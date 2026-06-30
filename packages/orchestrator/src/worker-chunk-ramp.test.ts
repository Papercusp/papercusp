/**
 * Unit tests for the deterministic worker:chunk-loop ramp-gate (P-021) — the pure
 * advance / hold / rollback recommender over the P-020 metrics. Builds metrics from raw
 * records via summarizeWorkerChunkOutcomes (so the two pieces are tested together).
 */
import { describe, it, expect } from 'vitest';
import { summarizeWorkerChunkOutcomes, type ChunkLoopOutcomeRecord } from './worker-chunk-outcome-pg';
import { decideRampAdvance, DEFAULT_RAMP_THRESHOLDS, type RampStep } from './worker-chunk-ramp';
import type { ChunkLoopOutcome } from './worker-chunk-loop';

const rec = (path: 'subprocess' | 'op', kind: ChunkLoopOutcome['kind']): ChunkLoopOutcomeRecord => ({
  executionPath: path,
  outcomeKind: kind,
  chunksCommitted: kind === 'completed' ? 2 : null,
  replanStrikes: kind === 'escalated' ? 3 : null,
  escalatedChunkId: kind === 'escalated' ? 'C-1' : null,
  detail: null,
  resumed: null,
  abortReason: null,
  totalReplans: null,
  chunksCommittedSoFar: null,
  totalChunksPlanned: null,
});

/** n records on a path with a given completed-fraction (rest aborted), plus optional planning_failed count. */
function rows(path: 'subprocess' | 'op', n: number, completed: number, planningFailed = 0): ChunkLoopOutcomeRecord[] {
  const out: ChunkLoopOutcomeRecord[] = [];
  for (let i = 0; i < completed; i++) out.push(rec(path, 'completed'));
  for (let i = 0; i < planningFailed; i++) out.push(rec(path, 'planning_failed'));
  for (let i = completed + planningFailed; i < n; i++) out.push(rec(path, 'aborted'));
  return out;
}

const decide = (recs: ChunkLoopOutcomeRecord[], step: RampStep) =>
  decideRampAdvance(summarizeWorkerChunkOutcomes(recs), step, DEFAULT_RAMP_THRESHOLDS);

describe('decideRampAdvance', () => {
  it('ADVANCES when op is at parity with a sufficient sample', () => {
    // subprocess 90/100 completed; op 24/25 completed (0.96 ≥ 0.90 − 0.02)
    const d = decide([...rows('subprocess', 100, 90), ...rows('op', 25, 24)], 25);
    expect(d.decision).toBe('advance');
    expect(d.fromStep).toBe(25);
    expect(d.toStep).toBe(50);
  });

  it('HOLDS when the op sample is below the floor', () => {
    const d = decide([...rows('subprocess', 100, 90), ...rows('op', 5, 5)], 0);
    expect(d.decision).toBe('hold');
    expect(d.reasons[0]).toMatch(/insufficient op samples: 5\/20/);
  });

  it('HOLDS when op is below parity but not regressed past the rollback line', () => {
    // subprocess 0.90; op 0.87 (gap 0.03: > parity tol 0.02 but < regression 0.05) ⇒ hold
    const d = decide([...rows('subprocess', 100, 90), ...rows('op', 100, 87)], 25);
    expect(d.decision).toBe('hold');
    expect(d.reasons[0]).toMatch(/not yet at parity/);
  });

  it('ROLLS BACK when op completion-rate regresses past the threshold', () => {
    // subprocess 0.90; op 0.80 (gap 0.10 > 0.05) ⇒ rollback 50 → 25
    const d = decide([...rows('subprocess', 100, 90), ...rows('op', 100, 80)], 50);
    expect(d.decision).toBe('rollback');
    expect(d.fromStep).toBe(50);
    expect(d.toStep).toBe(25);
    expect(d.reasons.join(' ')).toMatch(/regression/);
  });

  it('ROLLS BACK on an op-specific planning_failed spike even if completion-rate looks OK', () => {
    // op: 80 completed, 20 planning_failed → completion 0.80 vs subprocess 0.82 (gap 0.02, NOT a
    // completion regression) but planning_failed rate 0.20 vs ~0 ⇒ the D-005 ctx-build guard fires.
    const d = decide(
      [...rows('subprocess', 100, 82, 0), ...rows('op', 100, 80, 20)],
      50,
    );
    expect(d.decision).toBe('rollback');
    expect(d.reasons.join(' ')).toMatch(/planning_failed/);
  });

  it('HOLDS at the terminal 100% step when healthy', () => {
    const d = decide([...rows('subprocess', 100, 90), ...rows('op', 100, 95)], 100);
    expect(d.decision).toBe('hold');
    expect(d.toStep).toBe(100);
    expect(d.reasons[0]).toMatch(/fully ramped/);
  });

  it('HOLDS when a baseline path has no runs (no comparison possible)', () => {
    const d = decide(rows('op', 30, 30), 25); // no subprocess rows
    expect(d.decision).toBe('hold');
  });

  it('ROLLS BACK on an op-specific file-lock-contention spike even at completion parity', () => {
    const subRows = rows('subprocess', 100, 90);
    const opCompleted = rows('op', 100, 90); // same completion rate as subprocess
    const opLockBusy: ChunkLoopOutcomeRecord[] = Array.from({ length: 10 }, () => ({
      executionPath: 'op',
      outcomeKind: 'aborted',
      chunksCommitted: null,
      replanStrikes: null,
      escalatedChunkId: null,
      detail: 'lock busy',
      resumed: null,
      abortReason: 'lock_contention',
      totalReplans: null,
      chunksCommittedSoFar: null,
      totalChunksPlanned: null,
    }));
    // op: 90 completed + 10 lock_contention aborts out of 100 → 10% lock contention vs
    // subprocess's 0% (delta 0.10 > maxLockContentionRateDelta 0.05) ⇒ rollback, even
    // though completion-rate itself is untouched (90/110 ≈ 0.818, below parity too, but
    // the lock-contention reason must appear regardless).
    const d = decide([...subRows, ...opCompleted.slice(0, 90), ...opLockBusy], 50);
    expect(d.decision).toBe('rollback');
    expect(d.reasons.join(' ')).toMatch(/lock contention/);
  });

  it('ROLLS BACK on an op-specific per-chunk-durability deficit even at completion parity', () => {
    const subRows: ChunkLoopOutcomeRecord[] = Array.from({ length: 25 }, () => ({
      executionPath: 'subprocess',
      outcomeKind: 'completed',
      chunksCommitted: 4,
      replanStrikes: null,
      escalatedChunkId: null,
      detail: null,
      resumed: null,
      abortReason: null,
      totalReplans: 0,
      chunksCommittedSoFar: 4,
      totalChunksPlanned: 4, // subprocess: 100% durability
    }));
    const opRows: ChunkLoopOutcomeRecord[] = Array.from({ length: 25 }, () => ({
      executionPath: 'op',
      outcomeKind: 'completed',
      chunksCommitted: 4,
      replanStrikes: null,
      escalatedChunkId: null,
      detail: null,
      resumed: null,
      abortReason: null,
      totalReplans: 0,
      chunksCommittedSoFar: 2,
      totalChunksPlanned: 4, // op: only 50% of planned chunks survive to a commit
    }));
    const d = decide([...subRows, ...opRows], 50);
    expect(d.decision).toBe('rollback');
    expect(d.reasons.join(' ')).toMatch(/durability/);
  });
});
