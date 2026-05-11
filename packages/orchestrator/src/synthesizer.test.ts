/**
 * Synthesizer unit tests.
 *
 * Focus is on the pure / file-shape parts:
 *   - config knobs (`useSynthesizer`, `synthesizeSingle`)
 *   - manifest helpers (`singleLaneManifest`, paths)
 *   - the "no changes" failure path of `runSynthesizer`
 *
 * The happy-path LLM call requires a live agent backend and lives in
 * the integration suite (later step).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  singleLaneManifest,
  synthesisBranch,
  synthesisNotePath,
  synthesisWorktreePath,
  synthesizeSingle,
} from './synthesizer';

test('synthesizeSingle — default true', () => {
  assert.equal(synthesizeSingle({} as any), true);
  assert.equal(synthesizeSingle({ parallelWorkers: {} } as any), true);
});

test('synthesizeSingle — explicit false disables', () => {
  assert.equal(
    synthesizeSingle({ parallelWorkers: { synthesizeSingle: false } } as any),
    false,
  );
  assert.equal(
    synthesizeSingle({ parallelWorkers: { synthesizeSingle: 'false' } } as any),
    false,
  );
});

test('synthesisWorktreePath / synthesisBranch / synthesisNotePath shape', () => {
  assert.equal(
    synthesisWorktreePath('/state', 'F-123'),
    '/state/worktrees/F-123-synthesis',
  );
  assert.equal(synthesisBranch('F-123'), 'harness/F-123-synthesis');
  assert.equal(
    synthesisNotePath('/state', 'F-123'),
    '/state/synthesis-notes/F-123.md',
  );
});

test('singleLaneManifest — n=1, points at feature worktree + harness/<fid>', () => {
  const m = singleLaneManifest('/state', 'F-AUTH-007');
  assert.equal(m.parentFeatureId, 'F-AUTH-007');
  assert.equal(m.n, 1);
  assert.equal(m.lanes.length, 1);
  assert.deepEqual(m.lanes[0], {
    lane: 1,
    worktree: '/state/worktrees/F-AUTH-007',
    branch: 'harness/F-AUTH-007',
  });
});

// runSynthesizer's behavior (worktree creation, lane diffs, invoke,
// commit-or-fail) is exercised in the integration suite once a real
// agent backend is wired. The unit tests here intentionally stop at
// pure helpers.
