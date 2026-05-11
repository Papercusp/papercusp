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
