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

import {
  _handleNextValidatorForTests,
  _resetAdaptiveCachesForTests,
  _resetHarnessSlugCacheForTests,
} from './main-loop';
import { buildOrchTestContext } from './test-context-builder';

beforeEach(() => {
  inv.mockReset();
  hook.mockReset();
  // Reset main-loop.ts module-level state. The dispatcher config runs
  // all *.dispatcher.test.ts files in a single fork to avoid re-import
  // overhead, so _adaptiveTelemetryByFeature and _slugCache persist
  // between tests + files without these resets.
  _resetAdaptiveCachesForTests();
  _resetHarnessSlugCacheForTests();
});

// ─── synthesis success path (full dispatcher) ────────────────────

test('handleNextValidator — synth succeeds + validator passes → merge synth branch + fire on-synthesis-won', async () => {
  const p = buildOrchTestContext();
  try {
    p.addLane('F-1', 1, { 'a.txt': 'lane1\n' });
    p.addLane('F-1', 2, { 'a.txt': 'lane2\n' });
    p.writeManifest('F-1', 2);
    p.setFeatures([{ id: 'F-1', status: 'validating' }]);

    inv.mockImplementation(async (_ctx: any, role: string, extras: string[]) => {
      if (role === 'synthesizer') {
        const wt = extras
          .find((e) => e.startsWith('SYNTHESIS_WORKTREE='))!
          .split('=', 2)[1];
        writeFileSync(join(wt, 'a.txt'), 'synthesized\n');
        return { exitCode: 0, output: '', stderr: '', runId: 'r1' };
      }
      if (role === 'validator') {
        p.setFeatures([{ id: 'F-1', status: 'passed' }]);
        return { exitCode: 0, output: '', stderr: '', runId: 'r2' };
      }
      throw new Error(`unexpected role: ${role}`);
    });

    const result = await _handleNextValidatorForTests(
      { verb: 'NEXT_VALIDATOR', arg: 'F-1', raw: 'NEXT_VALIDATOR F-1' } as any,
      p.ctx,
      p.logger,
      p.cfg as any,
      p.lanePool,
    );

    assert.equal(result.terminal, false);
    const roles = inv.mock.calls.map((c: any[]) => c[1]);
    assert.deepEqual(roles, ['synthesizer', 'validator']);
    const show = spawnSync('git', ['show', 'main:a.txt'], {
      cwd: p.projectDir,
      encoding: 'utf8',
    });
    assert.equal(show.stdout, 'synthesized\n');
    const won = hook.mock.calls.filter((c: any[]) => c[0] === 'on-synthesis-won');
    assert.equal(won.length, 1);
    assert.equal(won[0][1].env.FEATURE_ID, 'F-1');
    assert.equal(won[0][1].env.SYNTH_BRANCH, 'harness/F-1-synthesis');
    assert.equal(won[0][1].env.LANE_COUNT, '2');
    assert.equal(existsSync(join(p.stateDir, 'worktrees', 'F-1-synthesis')), false);
    assert.equal(existsSync(join(p.stateDir, 'worktrees', 'F-1-lane-1')), false);
    assert.equal(existsSync(join(p.stateDir, 'worktrees', 'F-1-lane-2')), false);
    assert.equal(existsSync(join(p.stateDir, 'competition-F-1.json')), false);
  } finally {
    p.cleanup();
  }
});


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

// ─── Coverage: synthesizeSingle: false ───────────────────────────

test('handleNextValidator — synthesizeSingle: false → synth never runs even when worktree exists', async () => {
  const p = buildOrchTestContext({
    cfg: { parallelWorkers: { synthesizeSingle: false } },
  });
  try {
    // Pre-create a feature worktree (simulating N=1 worker output) so
    // worktreeEnabled + existsSync would normally trigger singleLane
    // synthesis. The synthesizeSingle:false flag must override that.
    p.addFeatureWorktree('F-S', { 'a.txt': 'worker draft\n' });
    p.setFeatures([{ id: 'F-S', status: 'validating' }]);

    inv.mockImplementation(async (_ctx: any, role: string) => {
      if (role === 'validator') {
        p.setFeatures([{ id: 'F-S', status: 'passed' }]);
        return { exitCode: 0, output: '', stderr: '', runId: 'r' };
      }
      throw new Error(`unexpected role: ${role}`);
    });

    await _handleNextValidatorForTests(
      { verb: 'NEXT_VALIDATOR', arg: 'F-S', raw: 'NEXT_VALIDATOR F-S' } as any,
      p.ctx,
      p.logger,
      p.cfg as any,
      p.lanePool,
    );

    const roles = inv.mock.calls.map((c: any[]) => c[1]);
    assert.deepEqual(roles, ['validator'], 'only validator ran; synth was skipped');
    const won = hook.mock.calls.filter((c: any[]) => c[0] === 'on-synthesis-won');
    assert.equal(won.length, 0, 'on-synthesis-won does not fire when synthesizeSingle: false');
  } finally {
    p.cleanup();
  }
});

// ─── Coverage: useChunkLoop + synthesizeSingle interaction ───────

test('handleNextValidator — useChunkLoop: true + synthesizeSingle: true → synth skipped (no feature worktree exists)', async () => {
  const p = buildOrchTestContext({
    cfg: { parallelWorkers: { useChunkLoop: true } },
  });
  try {
    // chunk-loop commits directly to projectDir/main; no per-feature
    // worktree gets created. The synthetic-1-lane fallback must
    // existsSync-gate on that worktree path and skip synth silently.
    // (handleChunkLoopWorker isn't called here — we're testing only
    // the validator-side dispatch which should detect no worktree.)
    p.setFeatures([{ id: 'F-CL', status: 'validating' }]);

    inv.mockImplementation(async (_ctx: any, role: string) => {
      if (role === 'validator') {
        return { exitCode: 0, output: '', stderr: '', runId: 'r' };
      }
      throw new Error(`unexpected role: ${role}`);
    });

    await _handleNextValidatorForTests(
      { verb: 'NEXT_VALIDATOR', arg: 'F-CL', raw: 'NEXT_VALIDATOR F-CL' } as any,
      p.ctx,
      p.logger,
      p.cfg as any,
      p.lanePool,
    );

    const roles = inv.mock.calls.map((c: any[]) => c[1]);
    assert.deepEqual(roles, ['validator'], 'synth gated off; only validator ran');
  } finally {
    p.cleanup();
  }
});

// ─── Bug L: handleSynthesisOutcome merge-conflict handling ───────

test('handleNextValidator — synth success + validator pass + merge CONFLICT → no false hook, synth preserved', async () => {
  const p = buildOrchTestContext();
  try {
    // Set up a conflict: base (main) has a.txt = "base", the synth
    // branch will produce a.txt = "synth". The handler does `git
    // checkout base && git merge synth` — but we'll move base forward
    // to a conflicting state mid-test so the merge fails.
    spawnSync('git', ['checkout', '-q', 'main'], { cwd: p.projectDir });
    writeFileSync(join(p.projectDir, 'a.txt'), 'base v1\n');
    spawnSync('git', ['add', '-A'], { cwd: p.projectDir });
    spawnSync('git', ['commit', '--quiet', '-m', 'base v1'], { cwd: p.projectDir });

    p.addLane('F-MC', 1, { 'a.txt': 'lane1\n' });
    p.addLane('F-MC', 2, { 'a.txt': 'lane2\n' });
    p.writeManifest('F-MC', 2);
    p.setFeatures([{ id: 'F-MC', status: 'validating' }]);

    inv.mockImplementation(async (_ctx: any, role: string, extras: string[]) => {
      if (role === 'synthesizer') {
        const wt = extras
          .find((e) => e.startsWith('SYNTHESIS_WORKTREE='))!
          .split('=', 2)[1];
        // Note: synth worktree starts from main as it was when synth
        // was invoked. But we'll then update main behind its back.
        writeFileSync(join(wt, 'a.txt'), 'synth version\n');
        // Simulate main moving forward during synth: commit a conflicting
        // change to main from a temp worktree so the synth branch's
        // merge collides.
        const tmpWt = join(p.stateDir, 'worktrees', 'side');
        spawnSync('git', ['worktree', 'add', '-B', 'side-bump', tmpWt, 'main'], {
          cwd: p.projectDir,
        });
        writeFileSync(join(tmpWt, 'a.txt'), 'main moved\n');
        spawnSync('git', ['add', '-A'], { cwd: tmpWt });
        spawnSync('git', ['commit', '--quiet', '-m', 'side move'], { cwd: tmpWt });
        spawnSync('git', ['checkout', 'main'], { cwd: p.projectDir });
        spawnSync('git', ['merge', '--ff-only', 'side-bump'], { cwd: p.projectDir });
        spawnSync('git', ['worktree', 'remove', '--force', tmpWt], { cwd: p.projectDir });
        spawnSync('git', ['branch', '-D', 'side-bump'], { cwd: p.projectDir });
        return { exitCode: 0, output: '', stderr: '', runId: 'r1' };
      }
      if (role === 'validator') {
        p.setFeatures([{ id: 'F-MC', status: 'passed' }]);
        return { exitCode: 0, output: '', stderr: '', runId: 'r2' };
      }
      throw new Error(`unexpected role: ${role}`);
    });

    await _handleNextValidatorForTests(
      { verb: 'NEXT_VALIDATOR', arg: 'F-MC', raw: 'NEXT_VALIDATOR F-MC' } as any,
      p.ctx,
      p.logger,
      p.cfg as any,
      p.lanePool,
    );

    // main has 'main moved\n' (the conflicting change), NOT the
    // synth version (because merge failed and was aborted).
    const show = spawnSync('git', ['show', 'main:a.txt'], {
      cwd: p.projectDir,
      encoding: 'utf8',
    });
    assert.equal(show.stdout, 'main moved\n', 'main not corrupted by failed merge');

    // on-synthesis-won did NOT fire (merge failed).
    const won = hook.mock.calls.filter((c: any[]) => c[0] === 'on-synthesis-won');
    assert.equal(won.length, 0, 'on-synthesis-won does NOT fire on merge conflict');

    // Synth branch preserved for manual recovery.
    const branches = spawnSync('git', ['branch'], {
      cwd: p.projectDir,
      encoding: 'utf8',
    }).stdout;
    assert.ok(branches.includes('F-MC-synthesis'), 'synth branch preserved');
    assert.ok(
      existsSync(join(p.stateDir, 'worktrees', 'F-MC-synthesis')),
      'synth worktree preserved',
    );
  } finally {
    p.cleanup();
  }
});
