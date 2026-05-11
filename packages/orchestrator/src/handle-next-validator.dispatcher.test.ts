/**
 * Integration tests for the dispatcher-level handleNextValidator branch.
 *
 * Covers the round-5 Bug C (synth-fail-N>1 skip), round-3 Bug B
 * (on-synthesis-won hook firing), and the synth-success → validator →
 * merge flow that handleSynthesisOutcome wraps. Mocks invoke() at the
 * module boundary so we can drive the role calls without an agent
 * backend.
 *
 * Pairs with test-context-builder.ts (per-test git-project setup).
 */
import { test, vi, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// vi.mock is hoisted; use vi.hoisted to declare the spy alongside it.
const { inv, hook } = vi.hoisted(() => ({
  inv: vi.fn() as ReturnType<typeof vi.fn>,
  hook: vi.fn() as ReturnType<typeof vi.fn>,
}));
vi.mock('./invoke', () => ({ invoke: inv }));
vi.mock('./hooks', () => ({
  runHook: hook,
  // Other hook utilities the orchestrator imports — no-op stubs.
  fireLifecycleHook: () => {},
}));

import { _handleNextValidatorForTests } from './main-loop';
import { buildOrchTestContext } from './test-context-builder';

beforeEach(() => {
  inv.mockReset();
  hook.mockReset();
});

// Note: the synthesis-success → merge → on-synthesis-won hook firing
// path is tested at the handleSynthesisOutcome layer in
// synthesizer-integration.test.ts (which doesn't trigger the
// fire-and-forget HTTP fetches that keep the worker_threads pool alive
// past the handler return). Tests here exercise dispatcher-only branches.

// ─── Bug C: synth-fail N>1 → skip validator, mark failing ────────

test('handleNextValidator — synth fails for N=3 → validator skipped, feature marked failing, lanes cleaned', async () => {
  const p = buildOrchTestContext();
  try {
    p.addLane('F-2', 1, { 'a.txt': '1\n' });
    p.addLane('F-2', 2, { 'a.txt': '2\n' });
    p.addLane('F-2', 3, { 'a.txt': '3\n' });
    p.writeManifest('F-2', 3);
    p.setFeatures([{ id: 'F-2', status: 'validating' }]);

    // Synth writes nothing → synthesized:false from runSynthesizer.
    inv.mockImplementation(async (_ctx: any, role: string) => {
      if (role === 'synthesizer') {
        return { exitCode: 0, output: '', stderr: '', runId: 'r1' };
      }
      throw new Error(`unexpected role invoked: ${role}`);
    });

    await _handleNextValidatorForTests(
      { verb: 'NEXT_VALIDATOR', arg: 'F-2', raw: 'NEXT_VALIDATOR F-2' } as any,
      p.ctx,
      p.logger,
      p.cfg as any,
      p.lanePool,
    );

    // Validator must NOT have been invoked.
    const roles = inv.mock.calls.map((c: any[]) => c[1]);
    assert.ok(!roles.includes('validator'), 'validator was skipped on multi-lane synth fail');
    // Feature marked 'failing' (retry-candidate), not 'failed' (terminal).
    const features = p.readFeatures();
    assert.equal(features.find((f) => f.id === 'F-2')?.status, 'failing');
    // All lane worktrees + manifest cleaned up.
    for (let i = 1; i <= 3; i++) {
      assert.equal(
        existsSync(join(p.stateDir, 'worktrees', `F-2-lane-${i}`)),
        false,
      );
    }
    assert.equal(existsSync(join(p.stateDir, 'competition-F-2.json')), false);
    // Log has the SYNTHESIZER skip message.
    assert.ok(
      p.loggedLines.some((l) => l.includes('skipping validator')),
      'log mentions validator was skipped',
    );
  } finally {
    p.cleanup();
  }
});

// ─── Bug D: chunk-loop + synthesizeSingle interaction ────────────

test('handleNextValidator — no feature worktree → synthesizeSingle silently skips synth, validator runs on worker branch', async () => {
  const p = buildOrchTestContext();
  try {
    // No feature worktree, no manifest. Simulates the chunk-loop case
    // (chunk-loop committed directly to projectDir, no worktree exists).
    p.setFeatures([{ id: 'F-3', status: 'validating' }]);

    inv.mockImplementation(async (_ctx: any, role: string) => {
      if (role === 'validator') {
        return { exitCode: 0, output: '', stderr: '', runId: 'r1' };
      }
      throw new Error(`unexpected role invoked: ${role}`);
    });

    await _handleNextValidatorForTests(
      { verb: 'NEXT_VALIDATOR', arg: 'F-3', raw: 'NEXT_VALIDATOR F-3' } as any,
      p.ctx,
      p.logger,
      p.cfg as any,
      p.lanePool,
    );

    // Synthesizer was NOT invoked — no feature worktree to read from.
    const roles = inv.mock.calls.map((c: any[]) => c[1]);
    assert.deepEqual(roles, ['validator'], 'only validator ran, synth was skipped');
    // No synth-fail log either — silent skip.
    assert.ok(
      !p.loggedLines.some((l) => l.includes('SYNTHESIZER:')),
      'no SYNTHESIZER log lines when synth never attempted',
    );
  } finally {
    p.cleanup();
  }
});

// ─── synth-success but validator fails → cleanup, no merge ───────

test('handleNextValidator — synth succeeds but validator fails → no merge, all worktrees dropped', async () => {
  const p = buildOrchTestContext();
  try {
    p.addLane('F-4', 1, { 'a.txt': '1\n' });
    p.addLane('F-4', 2, { 'a.txt': '2\n' });
    p.writeManifest('F-4', 2);
    p.setFeatures([{ id: 'F-4', status: 'validating' }]);

    inv.mockImplementation(async (_ctx: any, role: string, extras: string[]) => {
      if (role === 'synthesizer') {
        const wt = extras
          .find((e) => e.startsWith('SYNTHESIS_WORKTREE='))!
          .split('=', 2)[1];
        writeFileSync(join(wt, 'a.txt'), 'attempted\n');
        return { exitCode: 0, output: '', stderr: '', runId: 'r1' };
      }
      if (role === 'validator') {
        // Validator marks feature failing (not passed).
        p.setFeatures([{ id: 'F-4', status: 'failing' }]);
        return { exitCode: 1, output: '', stderr: '', runId: 'r2' };
      }
      throw new Error(`unexpected role: ${role}`);
    });

    await _handleNextValidatorForTests(
      { verb: 'NEXT_VALIDATOR', arg: 'F-4', raw: 'NEXT_VALIDATOR F-4' } as any,
      p.ctx,
      p.logger,
      p.cfg as any,
      p.lanePool,
    );

    // No merge happened — main has no a.txt.
    const show = spawnSync('git', ['show', 'main:a.txt'], {
      cwd: p.projectDir,
      encoding: 'utf8',
    });
    assert.notEqual(show.status, 0, 'a.txt not on main');
    // All worktrees gone.
    assert.equal(existsSync(join(p.stateDir, 'worktrees', 'F-4-synthesis')), false);
    assert.equal(existsSync(join(p.stateDir, 'worktrees', 'F-4-lane-1')), false);
    assert.equal(existsSync(join(p.stateDir, 'worktrees', 'F-4-lane-2')), false);
    // on-synthesis-won did NOT fire (no PASS).
    const synthWonCalls = hook.mock.calls.filter(
      (c: any[]) => c[0] === 'on-synthesis-won',
    );
    assert.equal(synthWonCalls.length, 0);
  } finally {
    p.cleanup();
  }
});
