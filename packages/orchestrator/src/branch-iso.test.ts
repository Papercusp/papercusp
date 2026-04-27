import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  branchIsoEnabled,
  worktreeEnabled,
  worktreePath,
} from './branch-iso.js';

test('branchIsoEnabled — false by default', () => {
  assert.equal(branchIsoEnabled({}), false);
  assert.equal(branchIsoEnabled({ branchIsolation: {} }), false);
  assert.equal(branchIsoEnabled({ branchIsolation: { enabled: false } }), false);
});

test('branchIsoEnabled — true when explicitly set', () => {
  assert.equal(branchIsoEnabled({ branchIsolation: { enabled: true } }), true);
});

test('worktreeEnabled — requires both branchIsolation.enabled AND useWorktrees', () => {
  assert.equal(worktreeEnabled({}), false);
  assert.equal(
    worktreeEnabled({ branchIsolation: { enabled: true } }),
    false,
    'branchIso alone is not enough',
  );
  assert.equal(
    worktreeEnabled({ branchIsolation: { useWorktrees: true } }),
    false,
    'useWorktrees alone is not enough — branchIso must also be on',
  );
  assert.equal(
    worktreeEnabled({
      branchIsolation: { enabled: true, useWorktrees: true },
    }),
    true,
  );
});

test('worktreePath — composes <stateDir>/worktrees/<fid>', () => {
  assert.equal(worktreePath('/a/.harness', 'F-001'), '/a/.harness/worktrees/F-001');
  assert.equal(worktreePath('/a/.harness', 'F-LANE-2'), '/a/.harness/worktrees/F-LANE-2');
});
