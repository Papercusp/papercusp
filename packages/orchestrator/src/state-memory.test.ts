/**
 * state-memory.test.ts — the in-memory FeatureRecord store used by tests and
 * standalone CLI mode (no PG). Pure, process-local, stateDir-keyed. The
 * load-bearing properties: returned arrays are COPIES (callers can't mutate the
 * internal store), per-stateDir isolation, and setFeatureStatusMem's attempts
 * semantics (bump vs reset, reset wins, missing-id is a no-op).
 *
 * Submodule unit test (orchestrator) — tab-NEUTRAL (separate test-config), but
 * genuine "entire app" coverage.
 *
 * Run: cd libs/papercusp/packages/orchestrator && npx vitest run src/state-memory.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FeatureRecord } from './types';
import {
  readFeaturesMem,
  featuresExistMem,
  featureAttemptsMem,
  setFeatureStatusMem,
  seedMemoryStore,
  _resetMemoryStateForTests,
  type MemoryStateContext,
} from './state-memory';

const ctx = (stateDir: string): MemoryStateContext => ({ kind: 'memory', stateDir });
const feat = (id: string, attempts = 0, status: FeatureRecord['status'] = 'pending'): FeatureRecord =>
  ({ id, status, attempts }) as FeatureRecord;

beforeEach(() => _resetMemoryStateForTests());

describe('empty store', () => {
  it('reads as empty and reports no features', () => {
    expect(readFeaturesMem(ctx('/a'))).toEqual([]);
    expect(featuresExistMem(ctx('/a'))).toBe(false);
    expect(featureAttemptsMem(ctx('/a'), 'F-1')).toBe(0);
  });
});

describe('seedMemoryStore + reads', () => {
  it('exposes seeded features and reports existence', () => {
    seedMemoryStore('/a', [feat('F-1'), feat('F-2', 3, 'failed')]);
    expect(readFeaturesMem(ctx('/a')).map((f) => f.id)).toEqual(['F-1', 'F-2']);
    expect(featuresExistMem(ctx('/a'))).toBe(true);
    expect(featureAttemptsMem(ctx('/a'), 'F-2')).toBe(3);
    expect(featureAttemptsMem(ctx('/a'), 'missing')).toBe(0);
  });

  it('returns a fresh array — push/splice on the result does not corrupt the store', () => {
    seedMemoryStore('/a', [feat('F-1')]);
    const out = readFeaturesMem(ctx('/a'));
    out.push(feat('F-injected'));
    out.splice(0, 1);
    // array-level copy: structural edits to the result never leak back
    expect(readFeaturesMem(ctx('/a')).map((f) => f.id)).toEqual(['F-1']);
  });

  it('re-seeding overwrites prior state for that stateDir', () => {
    seedMemoryStore('/a', [feat('F-1')]);
    seedMemoryStore('/a', [feat('F-9')]);
    expect(readFeaturesMem(ctx('/a')).map((f) => f.id)).toEqual(['F-9']);
  });
});

describe('setFeatureStatusMem', () => {
  it('updates the status of an existing feature', () => {
    seedMemoryStore('/a', [feat('F-1', 0, 'pending')]);
    const out = setFeatureStatusMem(ctx('/a'), 'F-1', 'passed');
    expect(out.find((f) => f.id === 'F-1')?.status).toBe('passed');
    // persisted
    expect(readFeaturesMem(ctx('/a'))[0].status).toBe('passed');
  });

  it('is a no-op (returns a copy, no change) for an unknown feature id', () => {
    seedMemoryStore('/a', [feat('F-1')]);
    const out = setFeatureStatusMem(ctx('/a'), 'nope', 'failed');
    expect(out.map((f) => f.id)).toEqual(['F-1']);
    expect(readFeaturesMem(ctx('/a'))[0].status).toBe('pending');
  });

  it('bumpAttempts increments; resetAttempts zeroes; reset wins over bump', () => {
    seedMemoryStore('/a', [feat('F-1', 2, 'pending')]);
    expect(setFeatureStatusMem(ctx('/a'), 'F-1', 'failed', { bumpAttempts: true }).find((f) => f.id === 'F-1')?.attempts).toBe(3);
    // now at 3; reset → 0 (and reset takes precedence when both flags set)
    expect(setFeatureStatusMem(ctx('/a'), 'F-1', 'pending', { resetAttempts: true, bumpAttempts: true }).find((f) => f.id === 'F-1')?.attempts).toBe(0);
  });

  it('leaves attempts untouched when neither flag is set', () => {
    seedMemoryStore('/a', [feat('F-1', 5)]);
    const out = setFeatureStatusMem(ctx('/a'), 'F-1', 'in_progress');
    expect(out.find((f) => f.id === 'F-1')?.attempts).toBe(5);
  });
});

describe('stateDir isolation + reset', () => {
  it('keeps separate stateDirs independent', () => {
    seedMemoryStore('/a', [feat('A-1')]);
    seedMemoryStore('/b', [feat('B-1'), feat('B-2')]);
    expect(readFeaturesMem(ctx('/a')).map((f) => f.id)).toEqual(['A-1']);
    expect(readFeaturesMem(ctx('/b')).map((f) => f.id)).toEqual(['B-1', 'B-2']);
  });

  it('_resetMemoryStateForTests clears every stateDir', () => {
    seedMemoryStore('/a', [feat('A-1')]);
    seedMemoryStore('/b', [feat('B-1')]);
    _resetMemoryStateForTests();
    expect(featuresExistMem(ctx('/a'))).toBe(false);
    expect(featuresExistMem(ctx('/b'))).toBe(false);
  });
});
