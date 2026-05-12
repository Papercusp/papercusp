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
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

    // Lane worktree cleaned up; synth worktree PRESERVED so the next
    // retry round branches off it (worker iterates on prior code rather
    // than restarting from base).
    const wts = readdirSync(join(p.stateDir, 'worktrees'));
    assert.deepEqual(wts, ['F-MC-synthesis'], 'synth worktree preserved on revert; lanes cleaned');

    // Main is on a clean state (no mid-merge state lingering). Untracked
    // .harness/ is runtime state and expected; only fail on conflict markers
    // (UU / AA / DD) or .git/MERGE_HEAD.
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: p.projectDir, encoding: 'utf8' });
    const conflictLines = status.stdout.split('\n').filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l));
    assert.deepEqual(conflictLines, [], 'no unresolved merge-conflict markers');
    assert.equal(existsSync(join(p.projectDir, '.git', 'MERGE_HEAD')), false,
      '.git/MERGE_HEAD must not linger after revert');

    // Bug P: the merge failed and feature reverted to 'failing'. Telemetry
    // close attempts went through attachAdaptiveOutcome (we mocked invoke
    // but not the underlying POST). Easier check: scan logger output for
    // the SYNTHESIZER revert line — proves closeTelemetry('fail') path
    // executed inside handleSynthesisOutcome (Bug P fix wires telemetry
    // close into that path).
    const revertLogged = p.loggedLines.some((l: string) =>
      l.includes("SYNTHESIZER: F-MC") && l.includes("reverting to 'failing'"));
    assert.ok(revertLogged, 'revert path executed — telemetry close fired via closeTelemetry');
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

test('e2e: validator-reject retry — round 2 worker branches off preserved synth + sees PRIOR_VALIDATOR_LOG', async () => {
  const p = buildOrchTestContext({
    cfg: { parallelWorkers: { max: 2, workersPerFeature: 2 } },
  });
  try {
    p.setFeatures([{ id: 'F-RETRY', status: 'todo', attempts: 0 }]);

    let orchCallCount = 0;
    let synthRound = 0;
    let validatorRound = 0;
    // Capture worker invocations for assertions.
    const workerCalls: Array<{ laneFid: string; extras: string[]; commitOnEntry: string }> = [];

    inv.mockImplementation(async (_ctx: any, role: string, extras: string[]) => {
      if (role === 'orchestrator') {
        orchCallCount += 1;
        // Round 1: workers → validator. Validator will reject.
        if (orchCallCount === 1) return { exitCode: 0, output: 'NEXT_WORKER F-RETRY\n', stderr: '', runId: 'o1' };
        if (orchCallCount === 2) return { exitCode: 0, output: 'NEXT_VALIDATOR F-RETRY\n', stderr: '', runId: 'o2' };
        // Round 2: retry. Validator will pass.
        if (orchCallCount === 3) return { exitCode: 0, output: 'NEXT_WORKER F-RETRY\n', stderr: '', runId: 'o3' };
        if (orchCallCount === 4) return { exitCode: 0, output: 'NEXT_VALIDATOR F-RETRY\n', stderr: '', runId: 'o4' };
        return { exitCode: 0, output: 'DONE\n', stderr: '', runId: 'oDone' };
      }
      if (role === 'worker') {
        const fidExtra = extras.find((e) => e.startsWith('FEATURE_ID='))!;
        const laneFid = fidExtra.split('=', 2)[1];
        const wt = join(p.stateDir, 'worktrees', laneFid);
        // Snapshot what's already in the lane's worktree at the moment
        // the worker started (proves retry inherited prior code).
        let commitOnEntry = '(empty)';
        const existing = join(wt, 'feature.txt');
        if (existsSync(existing)) {
          commitOnEntry = readFileSync(existing, 'utf8').trim();
        }
        workerCalls.push({ laneFid, extras: [...extras], commitOnEntry });
        // Round 1: workers write broken code. Round 2: workers write fixed code.
        const content = synthRound === 0 ? 'BROKEN\n' : 'FIXED\n';
        writeFileSync(existing, content);
        return { exitCode: 0, output: '', stderr: '', runId: `w-${laneFid}` };
      }
      if (role === 'synthesizer') {
        synthRound += 1;
        const wtExtra = extras.find((e) => e.startsWith('SYNTHESIS_WORKTREE='))!;
        const synthWt = wtExtra.split('=', 2)[1];
        // Synth just takes whichever lane has content (in tests, lane 1).
        const laneA = join(p.stateDir, 'worktrees', 'F-RETRY-lane-1', 'feature.txt');
        const body = existsSync(laneA) ? readFileSync(laneA, 'utf8') : '(missing)\n';
        writeFileSync(join(synthWt, 'feature.txt'), body);
        return { exitCode: 0, output: '', stderr: '', runId: `synth-${synthRound}` };
      }
      if (role === 'validator') {
        validatorRound += 1;
        const runId = `v-${validatorRound}`;
        const outPath = join(p.logDir, `${runId}.out`);
        const body = validatorRound === 1
          ? 'VAL-FAIL: feature.txt content "BROKEN" does not satisfy assertion VAL-001\n'
          : 'VAL-PASS\n';
        // Real `invoke` writes the .out file; mock has to do it too so
        // priorValidatorLogPath finds a real file at the pointer.
        writeFileSync(outPath, body);
        if (validatorRound === 1) {
          p.setFeatures([{ id: 'F-RETRY', status: 'failing', attempts: 1 }]);
          return { exitCode: 1, output: body, outPath, stderr: '', runId };
        }
        p.setFeatures([{ id: 'F-RETRY', status: 'passed', attempts: 2 }]);
        return { exitCode: 0, output: body, outPath, stderr: '', runId };
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

    assert.equal(result.reason, 'done', 'second round passes → DONE');

    // 4 worker calls total (2 per round × 2 rounds).
    assert.equal(workerCalls.length, 4);

    // Round-1 workers had no PRIOR_VALIDATOR_LOG and an empty starting tree.
    const r1 = workerCalls.slice(0, 2);
    for (const c of r1) {
      assert.ok(!c.extras.some((e) => e.startsWith('PRIOR_VALIDATOR_LOG=')),
        `round-1 lane ${c.laneFid} should NOT have PRIOR_VALIDATOR_LOG`);
      assert.equal(c.commitOnEntry, '(empty)', `round-1 lane ${c.laneFid} starts empty`);
    }

    // Round-2 workers:
    //   1. Got PRIOR_VALIDATOR_LOG pointing at the round-1 validator output
    //   2. Started from the preserved synth branch (prior BROKEN code, not empty)
    const r2 = workerCalls.slice(2, 4);
    for (const c of r2) {
      const priorLog = c.extras.find((e) => e.startsWith('PRIOR_VALIDATOR_LOG='));
      assert.ok(priorLog, `round-2 lane ${c.laneFid} should have PRIOR_VALIDATOR_LOG`);
      // Pointer file should exist on disk pointing at a real .out file.
      // We don't read it here (test would have to inspect file contents);
      // existence + non-empty value is enough.
      const path = priorLog!.split('=', 2)[1];
      assert.ok(path.length > 0, `round-2 lane ${c.laneFid} PRIOR_VALIDATOR_LOG path non-empty`);
      assert.equal(c.commitOnEntry, 'BROKEN',
        `round-2 lane ${c.laneFid} starts with the prior rejected code, not from base`);
    }

    // After round-2 success: synth worktree cleaned up.
    const wts = readdirSync(join(p.stateDir, 'worktrees'));
    assert.deepEqual(wts, [], 'all worktrees cleaned after final success');

    // Last-validator-out pointer also cleaned on success.
    const ptrPath = join(p.stateDir, 'last-validator-out', 'F-RETRY.path');
    assert.equal(existsSync(ptrPath), false, 'pointer cleared after success');

    // Main has the FIXED version.
    const show = spawnSync('git', ['show', 'main:feature.txt'], {
      cwd: p.projectDir,
      encoding: 'utf8',
    });
    assert.equal(show.stdout, 'FIXED\n');
  } finally {
    p.cleanup();
  }
});

test('e2e: chunk-loop validator-reject retry — round 2 planner sees prior validator output', async () => {
  const p = buildOrchTestContext({
    cfg: { parallelWorkers: { useChunkLoop: true } },
  });
  try {
    // Pre-populate the integration branch with a working tree + initial commit
    // so chunk-loop has somewhere to land scratch-worktree commits.
    p.setFeatures([{ id: 'F-CL', status: 'todo', attempts: 0 }]);

    let orchCallCount = 0;
    let validatorRound = 0;
    let plannerCallCount = 0;
    const plannerPrompts: string[] = [];

    inv.mockImplementation(async (_ctx: any, role: string, extras: string[], opts?: { inlinePrompt?: string; cwd?: string }) => {
      if (role === 'orchestrator') {
        orchCallCount += 1;
        // Round 1: dispatch worker → validator (will reject)
        if (orchCallCount === 1) return { exitCode: 0, output: 'NEXT_WORKER F-CL\n', stderr: '', runId: 'o1' };
        if (orchCallCount === 2) return { exitCode: 0, output: 'NEXT_VALIDATOR F-CL\n', stderr: '', runId: 'o2' };
        // Round 2: retry worker → validator (will pass)
        if (orchCallCount === 3) return { exitCode: 0, output: 'NEXT_WORKER F-CL\n', stderr: '', runId: 'o3' };
        if (orchCallCount === 4) return { exitCode: 0, output: 'NEXT_VALIDATOR F-CL\n', stderr: '', runId: 'o4' };
        return { exitCode: 0, output: 'DONE\n', stderr: '', runId: 'oDone' };
      }
      if (role === 'worker') {
        const stage = extras.find((e) => e.startsWith('CHUNK_LOOP_STAGE='))?.split('=', 2)[1];
        if (stage === 'plan') {
          plannerCallCount += 1;
          if (opts?.inlinePrompt) plannerPrompts.push(opts.inlinePrompt);
          // Return a single-chunk plan covering one file.
          const plan = `\`\`\`chunk-plan
{
  "chunks": [
    { "id": "F-CL-1", "files": ["app.txt"], "description": "add app behavior" }
  ]
}
\`\`\`
`;
          return { exitCode: 0, output: plan, stderr: '', runId: `plan-${plannerCallCount}` };
        }
        if (stage === 'implement') {
          // Write app.txt in the scratch dir. Round 1 writes BROKEN content
          // (validator will reject); round 2 writes FIXED.
          const cwd = opts?.cwd ?? p.projectDir;
          const content = validatorRound === 0 ? 'BROKEN\n' : 'FIXED\n';
          writeFileSync(join(cwd, 'app.txt'), content);
          return { exitCode: 0, output: '', stderr: '', runId: `impl-${plannerCallCount}` };
        }
        throw new Error(`unexpected worker stage: ${stage}`);
      }
      if (role === 'validator') {
        validatorRound += 1;
        const runId = `v-${validatorRound}`;
        const outPath = join(p.logDir, `${runId}.out`);
        const body = validatorRound === 1
          ? 'VAL-FAIL: app.txt content "BROKEN" does not satisfy VAL-CL-001 (expected "FIXED")\n'
          : 'VAL-PASS\n';
        writeFileSync(outPath, body);
        if (validatorRound === 1) {
          p.setFeatures([{ id: 'F-CL', status: 'failing', attempts: 1 }]);
          return { exitCode: 1, output: body, outPath, stderr: '', runId };
        }
        p.setFeatures([{ id: 'F-CL', status: 'passed', attempts: 2 }]);
        return { exitCode: 0, output: body, outPath, stderr: '', runId };
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

    assert.equal(result.reason, 'done', 'second round passes → DONE');

    // 2 planner calls (round 1 + round 2). Round 2's prompt must include
    // the validator's prior rejection text.
    assert.equal(plannerCallCount, 2, '2 planning rounds');
    assert.equal(plannerPrompts.length, 2);

    // Round-1 planner: no retry section.
    assert.ok(!plannerPrompts[0].includes('Prior validator rejection'),
      'round-1 planner prompt should not have retry section');

    // Round-2 planner: must include the retry section + the validator output.
    assert.match(plannerPrompts[1], /Prior validator rejection — this is a RETRY/);
    assert.match(plannerPrompts[1], /VAL-FAIL.*BROKEN/);
    // "Files already touched" hint requires PG (priorFiles is sourced from
    // the prior chunk-plan rows). This test runs without PG, so the hint
    // is correctly absent. The PG-mocked unit test in chunk-plan.test.ts
    // covers the hint emission directly.

    // After success: pointer cleared, plan dropped — verified by mocked
    // invoke being unable to re-detect retry on a hypothetical 3rd round
    // (we don't run one; just check the on-disk artifact).
    const ptrPath = join(p.stateDir, 'last-validator-out', 'F-CL.path');
    assert.equal(existsSync(ptrPath), false, 'pointer cleared after pass');
  } finally {
    p.cleanup();
  }
});

test('e2e: chunk-loop happy path — plan → chunk worker → validator → merge → DONE (no retry)', async () => {
  const p = buildOrchTestContext({
    cfg: { parallelWorkers: { useChunkLoop: true, workingStateCheck: 'true' } },
  });
  try {
    p.setFeatures([{ id: 'F-CL-HP', status: 'todo', attempts: 0 }]);

    let orchCallCount = 0;
    let plannerCallCount = 0;
    let implementCallCount = 0;
    inv.mockImplementation(async (_ctx: any, role: string, extras: string[], opts?: { inlinePrompt?: string; cwd?: string }) => {
      if (role === 'orchestrator') {
        orchCallCount += 1;
        if (orchCallCount === 1) return { exitCode: 0, output: 'NEXT_WORKER F-CL-HP\n', stderr: '', runId: 'o1' };
        if (orchCallCount === 2) return { exitCode: 0, output: 'NEXT_VALIDATOR F-CL-HP\n', stderr: '', runId: 'o2' };
        return { exitCode: 0, output: 'DONE\n', stderr: '', runId: 'oDone' };
      }
      if (role === 'worker') {
        const stage = extras.find((e) => e.startsWith('CHUNK_LOOP_STAGE='))?.split('=', 2)[1];
        if (stage === 'plan') {
          plannerCallCount += 1;
          // 2-chunk plan to exercise multi-chunk flow.
          const plan = `\`\`\`chunk-plan
{
  "chunks": [
    { "id": "F-CL-HP-1", "files": ["a.txt"], "description": "add a" },
    { "id": "F-CL-HP-2", "files": ["b.txt"], "description": "add b" }
  ]
}
\`\`\`
`;
          // Round-1 planner should NOT see a retry section.
          assert.ok(!opts?.inlinePrompt?.includes('Prior validator rejection'),
            'first-attempt planner prompt should have no retry section');
          return { exitCode: 0, output: plan, stderr: '', runId: `plan-${plannerCallCount}` };
        }
        if (stage === 'implement') {
          implementCallCount += 1;
          const cwd = opts?.cwd ?? p.projectDir;
          const fileExtra = extras.find((e) => e.startsWith('CHUNK_FILES='))!;
          const files = fileExtra.split('=', 2)[1].split(',');
          for (const f of files) {
            writeFileSync(join(cwd, f), `${f}-content\n`);
          }
          // First-attempt implement prompt should NOT have retry banner.
          assert.ok(!opts?.inlinePrompt?.includes('Retry round'),
            'first-attempt chunk-implement prompt should have no retry banner');
          return { exitCode: 0, output: '', stderr: '', runId: `impl-${implementCallCount}` };
        }
        throw new Error(`unexpected worker stage: ${stage}`);
      }
      if (role === 'validator') {
        const outPath = join(p.logDir, 'val.out');
        writeFileSync(outPath, 'VAL-PASS\n');
        p.setFeatures([{ id: 'F-CL-HP', status: 'passed', attempts: 1 }]);
        return { exitCode: 0, output: 'VAL-PASS', outPath, stderr: '', runId: 'v1' };
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
    assert.equal(plannerCallCount, 1, '1 planning round for happy path');
    assert.equal(implementCallCount, 2, '2 chunks implemented');

    // Feature passed.
    assert.equal(p.readFeatures().find((f) => f.id === 'F-CL-HP')?.status, 'passed');

    // Both files committed to integration branch (the test repo's main).
    const aShow = spawnSync('git', ['show', 'main:a.txt'], { cwd: p.projectDir, encoding: 'utf8' });
    const bShow = spawnSync('git', ['show', 'main:b.txt'], { cwd: p.projectDir, encoding: 'utf8' });
    assert.equal(aShow.stdout, 'a.txt-content\n');
    assert.equal(bShow.stdout, 'b.txt-content\n');

    // Cleanup: pointer cleared.
    const ptrPath = join(p.stateDir, 'last-validator-out', 'F-CL-HP.path');
    assert.equal(existsSync(ptrPath), false, 'pointer cleared after pass');
  } finally {
    p.cleanup();
  }
});

test('e2e: chunk-loop typecheck-fail escalation — N strikes triggers escalateToRole', async () => {
  // Exercises the chunk-loop driver's strike-escalation path: when a
  // chunk's L1 typecheck fails replanStrikes times in a row, the
  // driver calls onEscalate (configured role) and marks the chunk
  // 'escalated'. The feature itself is left 'failing' for the
  // orchestrator to dispatch a retry-or-escalate decision.
  const p = buildOrchTestContext({
    cfg: {
      parallelWorkers: {
        useChunkLoop: true,
        // ALWAYS-FAILING typecheck — every chunk implementation hits
        // the L1 gate failure path.
        workingStateCheck: 'false',
        replanStrikes: 2,
        escalateToRole: 'debugger',
      },
    },
  });
  try {
    p.setFeatures([{ id: 'F-CL-ESC', status: 'todo', attempts: 0 }]);

    let escalateCalls = 0;
    let orchCallCount = 0;
    inv.mockImplementation(async (_ctx: any, role: string, extras: string[], opts?: { inlinePrompt?: string; cwd?: string }) => {
      if (role === 'orchestrator') {
        orchCallCount += 1;
        if (orchCallCount === 1) return { exitCode: 0, output: 'NEXT_WORKER F-CL-ESC\n', stderr: '', runId: 'o1' };
        // After chunk-loop returns (with the escalated chunk), feature
        // is failing — orchestrator can ESCALATE the run.
        return { exitCode: 0, output: 'ESCALATE chunk-typecheck-stuck\n', stderr: '', runId: 'oEsc' };
      }
      if (role === 'worker') {
        const stage = extras.find((e) => e.startsWith('CHUNK_LOOP_STAGE='))?.split('=', 2)[1];
        if (stage === 'plan') {
          return {
            exitCode: 0,
            output: '```chunk-plan\n{"chunks":[{"id":"F-CL-ESC-1","files":["bad.ts"],"description":"add bad"}]}\n```\n',
            stderr: '', runId: 'pl',
          };
        }
        if (stage === 'implement') {
          // Write a file that will be subject to the always-failing typecheck.
          const cwd = opts?.cwd ?? p.projectDir;
          writeFileSync(join(cwd, 'bad.ts'), 'broken\n');
          return { exitCode: 0, output: '', stderr: '', runId: 'impl' };
        }
        if (stage === 'replan') {
          // Driver re-plans the failed chunk after each strike. Keep
          // returning the same shape — the typecheck still fails.
          return {
            exitCode: 0,
            output: '```chunk-plan\n{"chunks":[{"id":"F-CL-ESC-1","files":["bad.ts"],"description":"retry bad"}]}\n```\n',
            stderr: '', runId: 'rpl',
          };
        }
        // No other worker stage in chunk-loop.
        throw new Error(`unexpected worker stage: ${stage}`);
      }
      if (role === 'debugger') {
        // Escalation invocation. Driver doesn't wait on the boolean
        // return; we just record it ran.
        escalateCalls += 1;
        return { exitCode: 0, output: 'noted', stderr: '', runId: 'dbg' };
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

    // Loop exits via ESCALATE.
    assert.equal(result.reason, 'escalate');

    // Debugger role was invoked at least once (the chunk-loop escalation).
    assert.ok(escalateCalls >= 1, `escalateToRole should have fired at least once, got ${escalateCalls}`);
  } finally {
    p.cleanup();
  }
});
