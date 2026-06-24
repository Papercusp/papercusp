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
});
