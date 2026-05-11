/**
 * End-to-end orchestrator loop test with stubbed agent backend.
 *
 * Drives `runMainLoop` for a real iteration sequence:
 *   orchestrator → NEXT_WORKER → worker (commit to lane) → orchestrator
 *   → NEXT_VALIDATOR → synthesizer (merge candidates) → validator → merge
 *   → orchestrator → DONE.
 *
 * Every agent invocation is mocked at the `invoke` module boundary,
 * so no real LLM tokens are spent. The git operations, lane pool,
 * worktree management, synthesis branch + merge, hook firing, and
 * status transitions all run for real against a temp git repo.
 *
 * This is the closest thing to a "run a real harness" test the suite
 * can provide. Verifies the synthesizer plan's full pipeline:
 *   worker writes → synthesizer ships → validator gates → merge if pass.
 */
import { test, vi, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const { inv, hook } = vi.hoisted(() => ({
  inv: vi.fn() as ReturnType<typeof vi.fn>,
  hook: vi.fn() as ReturnType<typeof vi.fn>,
}));
vi.mock('./invoke', () => ({ invoke: inv }));
vi.mock('./hooks', () => ({ runHook: hook }));

import {
  runMainLoop,
  _resetAdaptiveCachesForTests,
  _resetHarnessSlugCacheForTests,
} from './main-loop';
import { buildOrchTestContext } from './test-context-builder';

beforeEach(() => {
  inv.mockReset();
  hook.mockReset();
  _resetAdaptiveCachesForTests();
  _resetHarnessSlugCacheForTests();
});

test('e2e: N=2 feature flows worker → synth → validator → merge → DONE', async () => {
  const p = buildOrchTestContext({
    cfg: { parallelWorkers: { max: 4, workersPerFeature: 2 } },
  });
  try {
    // Single feature in 'todo' state — orchestrator should pick it,
    // dispatch 2 workers, synth merges, validator passes, DONE.
    p.setFeatures([{ id: 'F-E2E', status: 'todo', attempts: 0 }]);

    // Drive the orchestrator's decision sequence by iteration count.
    // (The orchestrator role is invoked once per iteration; we return
    // a different decision each time based on call count.)
    let orchCallCount = 0;
    inv.mockImplementation(async (_ctx: any, role: string, extras: string[]) => {
      if (role === 'orchestrator') {
        orchCallCount += 1;
        if (orchCallCount === 1) {
          // First call: dispatch a worker round.
          return {
            exitCode: 0,
            output: 'NEXT_WORKER F-E2E\n',
            stderr: '',
            runId: `orch-${orchCallCount}`,
          };
        }
        if (orchCallCount === 2) {
          // Second call: feature is 'validating' after workers committed;
          // dispatch the validator.
          return {
            exitCode: 0,
            output: 'NEXT_VALIDATOR F-E2E\n',
            stderr: '',
            runId: `orch-${orchCallCount}`,
          };
        }
        // Third call: feature is 'passed', emit DONE to exit cleanly.
        return {
          exitCode: 0,
          output: 'DONE\n',
          stderr: '',
          runId: `orch-${orchCallCount}`,
        };
      }
      if (role === 'worker') {
        // Worker writes a file in its lane worktree. Find it via
        // FEATURE_ID env — lane fids are F-E2E-lane-1 / F-E2E-lane-2.
        const fidExtra = extras.find((e) => e.startsWith('FEATURE_ID='))!;
        const laneFid = fidExtra.split('=', 2)[1];
        const laneNum = laneFid.split('-lane-')[1];
        const wt = join(p.stateDir, 'worktrees', laneFid);
        writeFileSync(
          join(wt, 'feature.txt'),
          `implementation from lane ${laneNum}\n`,
        );
        return { exitCode: 0, output: '', stderr: '', runId: `worker-${laneFid}` };
      }
      if (role === 'synthesizer') {
        // Synthesizer picks lane 1's version.
        const wtExtra = extras.find((e) => e.startsWith('SYNTHESIS_WORKTREE='))!;
        const synthWt = wtExtra.split('=', 2)[1];
        writeFileSync(
          join(synthWt, 'feature.txt'),
          'implementation from lane 1\n',
        );
        // Optional synthesis note.
        const noteExtra = extras.find((e) => e.startsWith('SYNTHESIS_NOTE_PATH='));
        if (noteExtra) {
          const notePath = noteExtra.split('=', 2)[1];
          writeFileSync(
            notePath,
            '# F-E2E synthesis\n\nTook feature.txt from lane 1; lane 2 was a near-duplicate.\n',
          );
        }
        return { exitCode: 0, output: '', stderr: '', runId: 'synth' };
      }
      if (role === 'validator') {
        // Validator certifies the synthesized branch by marking the
        // feature 'passed' in features.json. (Real validator would
        // PATCH PG; the test setup uses FS fallback.)
        p.setFeatures([{ id: 'F-E2E', status: 'passed', attempts: 1 }]);
        return { exitCode: 0, output: '', stderr: '', runId: 'val' };
      }
      throw new Error(`unexpected role: ${role}`);
    });

    // Run the loop. Cap iterations at 5 — orchestrator should emit
    // DONE by iteration 3.
    const result = await runMainLoop({
      ctx: p.ctx,
      logger: p.logger,
      maxIterations: 5,
      iterationSleepMs: 0,
      skipPreLoop: true,
    });

    // Loop exited cleanly via DONE.
    assert.equal(result.reason, 'done', 'loop exited via DONE');
    assert.equal(result.exitCode, 0);

    // Orchestrator was invoked 3 times, in order: NEXT_WORKER → NEXT_VALIDATOR → DONE.
    assert.equal(orchCallCount, 3);

    // All 4 distinct roles fired during the run.
    const rolesByName = inv.mock.calls.reduce<Record<string, number>>(
      (acc: Record<string, number>, c: any[]) => {
        const role = c[1] as string;
        acc[role] = (acc[role] ?? 0) + 1;
        return acc;
      },
      {},
    );
    assert.equal(rolesByName.orchestrator, 3, '3 orchestrator decisions');
    assert.equal(rolesByName.worker, 2, '2 workers (N=2)');
    assert.equal(rolesByName.synthesizer, 1, '1 synthesizer pass');
    assert.equal(rolesByName.validator, 1, '1 validator pass');

    // Feature ended 'passed' on main.
    const features = p.readFeatures();
    assert.equal(features.find((f) => f.id === 'F-E2E')?.status, 'passed');
    const show = spawnSync('git', ['show', 'main:feature.txt'], {
      cwd: p.projectDir,
      encoding: 'utf8',
    });
    assert.equal(
      show.stdout,
      'implementation from lane 1\n',
      'main contains the merged synthesizer output',
    );

    // on-synthesis-won fired exactly once with correct env.
    const won = hook.mock.calls.filter((c: any[]) => c[0] === 'on-synthesis-won');
    assert.equal(won.length, 1);
    assert.equal(won[0][1].env.FEATURE_ID, 'F-E2E');
    assert.equal(won[0][1].env.SYNTH_BRANCH, 'harness/F-E2E-synthesis');
    assert.equal(won[0][1].env.LANE_COUNT, '2');

    // All worktrees gone. The 2 lane worktrees + 1 synthesis worktree
    // should have been cleaned up by handleSynthesisOutcome.
    const worktreeEntries = readdirSync(join(p.stateDir, 'worktrees'));
    assert.deepEqual(worktreeEntries, [], 'no leftover worktrees after DONE');

    // Synthesis note was written + survives.
    assert.ok(
      existsSync(join(p.stateDir, 'synthesis-notes', 'F-E2E.md')),
      'synthesis-notes/F-E2E.md exists',
    );

    // Competition manifest was cleaned up.
    assert.equal(existsSync(join(p.stateDir, 'competition-F-E2E.json')), false);

    // Branches cleaned up (-lane-N and -synthesis gone; main remains).
    const branches = spawnSync('git', ['branch'], {
      cwd: p.projectDir,
      encoding: 'utf8',
    }).stdout;
    assert.ok(!branches.includes('F-E2E-lane-1'));
    assert.ok(!branches.includes('F-E2E-lane-2'));
    assert.ok(!branches.includes('F-E2E-synthesis'));
    assert.ok(branches.includes('main'));
  } finally {
    p.cleanup();
  }
});

test('e2e: N=1 + synthesizeSingle true → worker → synth (polish) → validator → merge → DONE', async () => {
  const p = buildOrchTestContext({
    cfg: { parallelWorkers: { max: 1, workersPerFeature: 1, synthesizeSingle: true } },
  });
  try {
    p.setFeatures([{ id: 'F-E2E-1', status: 'todo', attempts: 0 }]);

    let orchCallCount = 0;
    inv.mockImplementation(async (_ctx: any, role: string, extras: string[]) => {
      if (role === 'orchestrator') {
        orchCallCount += 1;
        if (orchCallCount === 1) return { exitCode: 0, output: 'NEXT_WORKER F-E2E-1\n', stderr: '', runId: 'o1' };
        if (orchCallCount === 2) return { exitCode: 0, output: 'NEXT_VALIDATOR F-E2E-1\n', stderr: '', runId: 'o2' };
        return { exitCode: 0, output: 'DONE\n', stderr: '', runId: 'o3' };
      }
      if (role === 'worker') {
        // N=1 path writes directly to the feature's worktree.
        const wt = join(p.stateDir, 'worktrees', 'F-E2E-1');
        writeFileSync(join(wt, 'a.txt'), 'worker draft\n');
        return { exitCode: 0, output: '', stderr: '', runId: 'w1' };
      }
      if (role === 'synthesizer') {
        // For N=1 with synthesizeSingle on, synth polishes the worker's draft.
        const wtExtra = extras.find((e) => e.startsWith('SYNTHESIS_WORKTREE='))!;
        const synthWt = wtExtra.split('=', 2)[1];
        writeFileSync(join(synthWt, 'a.txt'), 'polished\n');
        return { exitCode: 0, output: '', stderr: '', runId: 's1' };
      }
      if (role === 'validator') {
        p.setFeatures([{ id: 'F-E2E-1', status: 'passed', attempts: 1 }]);
        return { exitCode: 0, output: '', stderr: '', runId: 'v1' };
      }
      throw new Error(`unexpected role: ${role}`);
    });

    const result = await runMainLoop({
      ctx: p.ctx,
      logger: p.logger,
      maxIterations: 5,
      iterationSleepMs: 0,
      skipPreLoop: true,
    });

    assert.equal(result.reason, 'done');

    const rolesByName = inv.mock.calls.reduce<Record<string, number>>(
      (acc: Record<string, number>, c: any[]) => {
        const role = c[1] as string;
        acc[role] = (acc[role] ?? 0) + 1;
        return acc;
      },
      {},
    );
    assert.equal(rolesByName.worker, 1, 'single worker for N=1');
    assert.equal(rolesByName.synthesizer, 1, 'synthesizer ran for N=1 (synthesizeSingle: true)');

    // Main has the POLISHED version, not the worker's draft.
    const show = spawnSync('git', ['show', 'main:a.txt'], {
      cwd: p.projectDir,
      encoding: 'utf8',
    });
    assert.equal(show.stdout, 'polished\n', 'main has synthesizer polish, not raw worker draft');

    assert.equal(
      p.readFeatures().find((f) => f.id === 'F-E2E-1')?.status,
      'passed',
    );
  } finally {
    p.cleanup();
  }
});

test('e2e: synthesizeSingle false → worker → validator (no synth) → merge → DONE', async () => {
  const p = buildOrchTestContext({
    cfg: { parallelWorkers: { max: 1, workersPerFeature: 1, synthesizeSingle: false } },
  });
  try {
    p.setFeatures([{ id: 'F-E2E-NS', status: 'todo', attempts: 0 }]);

    let orchCallCount = 0;
    inv.mockImplementation(async (_ctx: any, role: string) => {
      if (role === 'orchestrator') {
        orchCallCount += 1;
        if (orchCallCount === 1) return { exitCode: 0, output: 'NEXT_WORKER F-E2E-NS\n', stderr: '', runId: 'o1' };
        if (orchCallCount === 2) return { exitCode: 0, output: 'NEXT_VALIDATOR F-E2E-NS\n', stderr: '', runId: 'o2' };
        return { exitCode: 0, output: 'DONE\n', stderr: '', runId: 'o3' };
      }
      if (role === 'worker') {
        const wt = join(p.stateDir, 'worktrees', 'F-E2E-NS');
        writeFileSync(join(wt, 'a.txt'), 'worker output (final)\n');
        return { exitCode: 0, output: '', stderr: '', runId: 'w1' };
      }
      if (role === 'validator') {
        p.setFeatures([{ id: 'F-E2E-NS', status: 'passed', attempts: 1 }]);
        return { exitCode: 0, output: '', stderr: '', runId: 'v1' };
      }
      throw new Error(`unexpected role: ${role}`);
    });

    const result = await runMainLoop({
      ctx: p.ctx,
      logger: p.logger,
      maxIterations: 5,
      iterationSleepMs: 0,
      skipPreLoop: true,
    });

    assert.equal(result.reason, 'done');

    const rolesByName = inv.mock.calls.reduce<Record<string, number>>(
      (acc: Record<string, number>, c: any[]) => {
        const role = c[1] as string;
        acc[role] = (acc[role] ?? 0) + 1;
        return acc;
      },
      {},
    );
    assert.equal(rolesByName.synthesizer, undefined, 'synth skipped when synthesizeSingle:false');
    assert.equal(rolesByName.worker, 1);
    assert.equal(rolesByName.validator, 1);

    // Worker's output shipped (no synth polish).
    const show = spawnSync('git', ['show', 'main:a.txt'], {
      cwd: p.projectDir,
      encoding: 'utf8',
    });
    assert.equal(show.stdout, 'worker output (final)\n');
  } finally {
    p.cleanup();
  }
});

test('e2e: merge-conflict reverts feature to failing, no false on-synthesis-won (Bug L+O)', async () => {
  const p = buildOrchTestContext({
    cfg: { parallelWorkers: { max: 1, workersPerFeature: 1, synthesizeSingle: true } },
  });
  try {
    p.setFeatures([{ id: 'F-MC', status: 'todo', attempts: 0 }]);

    let orchCallCount = 0;
    inv.mockImplementation(async (_ctx: any, role: string, extras: string[]) => {
      if (role === 'orchestrator') {
        orchCallCount += 1;
        if (orchCallCount === 1) return { exitCode: 0, output: 'NEXT_WORKER F-MC\n', stderr: '', runId: 'o1' };
        if (orchCallCount === 2) return { exitCode: 0, output: 'NEXT_VALIDATOR F-MC\n', stderr: '', runId: 'o2' };
        // Iteration 3 sees feature back at 'failing' — we just want to exit cleanly.
        return { exitCode: 0, output: 'ESCALATE merge-conflict-test\n', stderr: '', runId: 'o3' };
      }
      if (role === 'worker') {
        const wt = join(p.stateDir, 'worktrees', 'F-MC');
        writeFileSync(join(wt, 'shared.txt'), 'worker version\n');
        return { exitCode: 0, output: '', stderr: '', runId: 'w1' };
      }
      if (role === 'synthesizer') {
        const wtExtra = extras.find((e) => e.startsWith('SYNTHESIS_WORKTREE='))!;
        const synthWt = wtExtra.split('=', 2)[1];
        writeFileSync(join(synthWt, 'shared.txt'), 'synth version\n');
        // Simulate base moving during synth: commit a conflicting change directly to main.
        writeFileSync(join(p.projectDir, 'shared.txt'), 'main-moved version\n');
        spawnSync('git', ['add', 'shared.txt'], { cwd: p.projectDir });
        spawnSync('git', ['commit', '--quiet', '-m', 'concurrent main edit'], { cwd: p.projectDir });
        return { exitCode: 0, output: '', stderr: '', runId: 's1' };
      }
      if (role === 'validator') {
        p.setFeatures([{ id: 'F-MC', status: 'passed', attempts: 1 }]);
        return { exitCode: 0, output: '', stderr: '', runId: 'v1' };
      }
      throw new Error(`unexpected role: ${role}`);
    });

    const result = await runMainLoop({
      ctx: p.ctx,
      logger: p.logger,
      maxIterations: 5,
      iterationSleepMs: 0,
      skipPreLoop: true,
    });

    // Loop exits via the ESCALATE (we asked for it on iter 3 just to terminate the test).
    assert.equal(result.reason, 'escalate');

    // Bug O: feature is back at 'failing', NOT stuck at 'passed' that wouldn't be retried.
    const features = p.readFeatures();
    assert.equal(features.find((f) => f.id === 'F-MC')?.status, 'failing',
      'merge conflict must revert feature to failing for retry');

    // Bug L: on-synthesis-won did NOT fire — merge actually failed.
    const won = hook.mock.calls.filter((c: any[]) => c[0] === 'on-synthesis-won');
    assert.equal(won.length, 0, 'on-synthesis-won must not fire on merge-conflict');

    // Main has the concurrent edit, NOT the synth output.
    const show = spawnSync('git', ['show', 'main:shared.txt'], { cwd: p.projectDir, encoding: 'utf8' });
    assert.equal(show.stdout, 'main-moved version\n', 'main retains the concurrent edit (synth was reverted)');

    // Synth worktree + lane worktree both cleaned up.
    const wts = readdirSync(join(p.stateDir, 'worktrees'));
    assert.deepEqual(wts, [], 'all worktrees cleaned after revert');

    // Main is on a clean state (no mid-merge state lingering). Untracked
    // .harness/ is runtime state and expected; only fail on conflict markers
    // (UU / AA / DD) or .git/MERGE_HEAD.
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: p.projectDir, encoding: 'utf8' });
    const conflictLines = status.stdout.split('\n').filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l));
    assert.deepEqual(conflictLines, [], 'no unresolved merge-conflict markers');
    assert.equal(existsSync(join(p.projectDir, '.git', 'MERGE_HEAD')), false,
      '.git/MERGE_HEAD must not linger after revert');
  } finally {
    p.cleanup();
  }
});

test('e2e: synth fails → feature failing, no merge, retry round runs cleanly', async () => {
  const p = buildOrchTestContext({
    cfg: { parallelWorkers: { max: 2, workersPerFeature: 2 } },
  });
  try {
    p.setFeatures([{ id: 'F-SF', status: 'todo', attempts: 0 }]);

    let orchCallCount = 0;
    let workerInvokes = 0;
    let synthInvokes = 0;
    inv.mockImplementation(async (_ctx: any, role: string, extras: string[]) => {
      if (role === 'orchestrator') {
        orchCallCount += 1;
        if (orchCallCount === 1) return { exitCode: 0, output: 'NEXT_WORKER F-SF\n', stderr: '', runId: 'o1' };
        if (orchCallCount === 2) return { exitCode: 0, output: 'NEXT_VALIDATOR F-SF\n', stderr: '', runId: 'o2' };
        // After synth failure feature is 'failing'. Retry: NEXT_WORKER again.
        if (orchCallCount === 3) return { exitCode: 0, output: 'NEXT_WORKER F-SF\n', stderr: '', runId: 'o3' };
        if (orchCallCount === 4) return { exitCode: 0, output: 'NEXT_VALIDATOR F-SF\n', stderr: '', runId: 'o4' };
        return { exitCode: 0, output: 'DONE\n', stderr: '', runId: 'oDone' };
      }
      if (role === 'worker') {
        workerInvokes += 1;
        const fidExtra = extras.find((e) => e.startsWith('FEATURE_ID='))!;
        const laneFid = fidExtra.split('=', 2)[1];
        const wt = join(p.stateDir, 'worktrees', laneFid);
        writeFileSync(join(wt, 'f.txt'), `try ${Math.ceil(workerInvokes / 2)} lane ${laneFid}\n`);
        return { exitCode: 0, output: '', stderr: '', runId: `w-${workerInvokes}` };
      }
      if (role === 'synthesizer') {
        synthInvokes += 1;
        if (synthInvokes === 1) {
          // First synth attempt: simulate LLM failure (non-zero exit, no commit).
          return { exitCode: 1, output: '', stderr: 'synth failed', runId: 's-fail' };
        }
        // Retry attempt: synth succeeds.
        const wtExtra = extras.find((e) => e.startsWith('SYNTHESIS_WORKTREE='))!;
        const synthWt = wtExtra.split('=', 2)[1];
        writeFileSync(join(synthWt, 'f.txt'), 'retry synth output\n');
        return { exitCode: 0, output: '', stderr: '', runId: 's-ok' };
      }
      if (role === 'validator') {
        p.setFeatures([{ id: 'F-SF', status: 'passed', attempts: 2 }]);
        return { exitCode: 0, output: '', stderr: '', runId: 'v' };
      }
      throw new Error(`unexpected role: ${role}`);
    });

    const result = await runMainLoop({
      ctx: p.ctx,
      logger: p.logger,
      maxIterations: 10,
      iterationSleepMs: 0,
      skipPreLoop: true,
    });

    assert.equal(result.reason, 'done', 'second round eventually passes → DONE');

    const rolesByName = inv.mock.calls.reduce<Record<string, number>>(
      (acc: Record<string, number>, c: any[]) => {
        const role = c[1] as string;
        acc[role] = (acc[role] ?? 0) + 1;
        return acc;
      },
      {},
    );
    assert.equal(rolesByName.worker, 4, '2 workers per round × 2 rounds');
    assert.equal(rolesByName.synthesizer, 2, '1 synth per round × 2 rounds');
    // Validator runs only when synth produced a branch (round 2 only).
    assert.equal(rolesByName.validator, 1, 'validator only runs after successful synth');

    // Feature passed on retry.
    assert.equal(p.readFeatures().find((f) => f.id === 'F-SF')?.status, 'passed');
    const show = spawnSync('git', ['show', 'main:f.txt'], { cwd: p.projectDir, encoding: 'utf8' });
    assert.equal(show.stdout, 'retry synth output\n');

    // No worktrees leaked across the failure round.
    const wts = readdirSync(join(p.stateDir, 'worktrees'));
    assert.deepEqual(wts, [], 'no worktree leak after synth-fail + retry');
  } finally {
    p.cleanup();
  }
});

test('e2e: adaptive tiers → orchestrator picks N=k, telemetry row recorded', async () => {
  const p = buildOrchTestContext({
    cfg: {
      parallelWorkers: {
        max: 4,
        adaptive: { tiers: [1, 2, 4], labels: ['trivial', 'normal', 'hard'], rubric: 'test rubric' },
      },
    },
  });
  try {
    p.setFeatures([{ id: 'F-AD', status: 'todo', attempts: 0 }]);

    let orchCallCount = 0;
    let extrasCaptured: string[][] = [];
    inv.mockImplementation(async (_ctx: any, role: string, extras: string[]) => {
      if (role === 'orchestrator') {
        orchCallCount += 1;
        // Capture extras (lets us verify ADAPTIVE_TIERS / AVAILABLE_SLOTS got injected).
        if (orchCallCount === 1) extrasCaptured.push([...extras]);
        if (orchCallCount === 1) return { exitCode: 0, output: 'NEXT_WORKER F-AD N=2\n', stderr: '', runId: 'o1' };
        if (orchCallCount === 2) return { exitCode: 0, output: 'NEXT_VALIDATOR F-AD\n', stderr: '', runId: 'o2' };
        return { exitCode: 0, output: 'DONE\n', stderr: '', runId: 'o3' };
      }
      if (role === 'worker') {
        const fidExtra = extras.find((e) => e.startsWith('FEATURE_ID='))!;
        const laneFid = fidExtra.split('=', 2)[1];
        const wt = join(p.stateDir, 'worktrees', laneFid);
        writeFileSync(join(wt, 'g.txt'), `${laneFid}\n`);
        return { exitCode: 0, output: '', stderr: '', runId: 'w' };
      }
      if (role === 'synthesizer') {
        const wtExtra = extras.find((e) => e.startsWith('SYNTHESIS_WORKTREE='))!;
        const synthWt = wtExtra.split('=', 2)[1];
        writeFileSync(join(synthWt, 'g.txt'), 'synth-of-N2\n');
        return { exitCode: 0, output: '', stderr: '', runId: 's' };
      }
      if (role === 'validator') {
        p.setFeatures([{ id: 'F-AD', status: 'passed', attempts: 1 }]);
        return { exitCode: 0, output: '', stderr: '', runId: 'v' };
      }
      throw new Error(`unexpected role: ${role}`);
    });

    const result = await runMainLoop({
      ctx: p.ctx,
      logger: p.logger,
      maxIterations: 5,
      iterationSleepMs: 0,
      skipPreLoop: true,
    });

    assert.equal(result.reason, 'done');

    // Orchestrator got the adaptive context.
    const orchExtras = extrasCaptured[0];
    assert.ok(orchExtras.some((e) => e.startsWith('PARALLEL_MODE=adaptive')),
      'PARALLEL_MODE=adaptive injected when tiers configured');
    assert.ok(orchExtras.some((e) => e.startsWith('ADAPTIVE_TIERS=')),
      'ADAPTIVE_TIERS extras line injected');
    assert.ok(orchExtras.some((e) => e.startsWith('AVAILABLE_SLOTS=')),
      'AVAILABLE_SLOTS extras line injected');

    // Orchestrator requested N=2; dispatcher honored it. 2 worker invocations.
    const workerCalls = inv.mock.calls.filter((c: any[]) => c[1] === 'worker');
    assert.equal(workerCalls.length, 2, 'dispatcher honored N=2 from orchestrator');

    // Feature passed, synth output shipped.
    assert.equal(p.readFeatures().find((f) => f.id === 'F-AD')?.status, 'passed');
    const show = spawnSync('git', ['show', 'main:g.txt'], { cwd: p.projectDir, encoding: 'utf8' });
    assert.equal(show.stdout, 'synth-of-N2\n');
  } finally {
    p.cleanup();
  }
});
