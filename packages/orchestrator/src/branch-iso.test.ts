import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  branchIsoEnabled,
  worktreeEnabled,
  worktreePath,
} from './branch-iso.js';

// useChunkLoop now defaults to true (chunk-loop is the canonical worker
// model). Branch-iso tests must explicitly disable it to exercise the
// synth-pipeline behavior.
const NO_CHUNK_LOOP = { parallelWorkers: { useChunkLoop: false } };

test('branchIsoEnabled — false by default', () => {
  // Default config: useChunkLoop=true → branchIso short-circuited to false.
  assert.equal(branchIsoEnabled({}), false);
  // Even with branchIsolation.enabled=true, chunk-loop wins by default.
  assert.equal(branchIsoEnabled({ branchIsolation: { enabled: true } }), false);
  // With chunk-loop explicitly off, the branchIsolation field is consulted.
  assert.equal(branchIsoEnabled({ ...NO_CHUNK_LOOP }), false);
  assert.equal(branchIsoEnabled({ ...NO_CHUNK_LOOP, branchIsolation: {} }), false);
  assert.equal(
    branchIsoEnabled({ ...NO_CHUNK_LOOP, branchIsolation: { enabled: false } }),
    false,
  );
});

test('branchIsoEnabled — true when explicitly set + chunk-loop off', () => {
  assert.equal(
    branchIsoEnabled({ ...NO_CHUNK_LOOP, branchIsolation: { enabled: true } }),
    true,
  );
});

test('worktreeEnabled — requires chunk-loop off + branchIso enabled + useWorktrees', () => {
  assert.equal(worktreeEnabled({}), false);
  assert.equal(
    worktreeEnabled({ ...NO_CHUNK_LOOP, branchIsolation: { enabled: true } }),
    false,
    'branchIso alone is not enough',
  );
  assert.equal(
    worktreeEnabled({ ...NO_CHUNK_LOOP, branchIsolation: { useWorktrees: true } }),
    false,
    'useWorktrees alone is not enough — branchIso must also be on',
  );
  assert.equal(
    worktreeEnabled({
      ...NO_CHUNK_LOOP,
      branchIsolation: { enabled: true, useWorktrees: true },
    }),
    true,
  );
  // chunk-loop on → worktreeEnabled false even with branchIso+useWorktrees set.
  assert.equal(
    worktreeEnabled({
      branchIsolation: { enabled: true, useWorktrees: true },
    }),
    false,
    'chunk-loop short-circuits worktree mode',
  );
});

test('worktreePath — composes <stateDir>/worktrees/<fid>', () => {
  assert.equal(worktreePath('/a/.papercusp', 'F-001'), '/a/.papercusp/worktrees/F-001');
  assert.equal(worktreePath('/a/.papercusp', 'F-LANE-2'), '/a/.papercusp/worktrees/F-LANE-2');
});
