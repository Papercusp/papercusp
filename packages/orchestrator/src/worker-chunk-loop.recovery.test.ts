import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { FileLockQueue } from './file-lock-queue.js';
import { FileLockQueueCoordinator } from './file-lock-queue-coordinator.js';
import { runChunkLoop, runChunkLoopCore, type ChunkLoopDeps } from './worker-chunk-loop.js';

function execSync(cmd: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const c = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', (b) => (out += b.toString()));
    c.stderr.on('data', (b) => (err += b.toString()));
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd}: exit ${code}: ${err}`))));
  });
}

async function makeRepo(): Promise<string> {
  const dir = path.join(os.tmpdir(), `papercusp-recovery-test-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  await execSync('git', ['init', '-q', '-b', 'main'], dir);
  await execSync('git', ['config', 'user.email', 'test@papercusp.test'], dir);
  await execSync('git', ['config', 'user.name', 'Test'], dir);
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 0;\n');
  await fs.writeFile(path.join(dir, 'b.ts'), 'export const b = 0;\n');
  await fs.writeFile(path.join(dir, 'c.ts'), 'export const c = 0;\n');
  await execSync('git', ['add', '.'], dir);
  await execSync('git', ['commit', '-q', '-m', 'initial'], dir);
  return dir;
}

test('resumeFromPlan skips planning and already-committed chunks', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    let planChunksCalled = 0;
    let implementCalled = 0;
    const implementOrder: string[] = [];

    const deps: ChunkLoopDeps = {
      repoPath: repo,
      lockCoordinator: new FileLockQueueCoordinator(lockQueue),
      typecheckCommand: 'true',
      planChunks: async () => {
        planChunksCalled++;
        return 'unused';
      },
      implementChunk: async (_f, chunk, env) => {
        implementCalled++;
        implementOrder.push(chunk.id);
        const file = chunk.files[0];
        await fs.writeFile(path.join(env.dir, file), `export const v = ${chunk.id};\n`);
        return { touchedFiles: chunk.files, attemptedChange: 'wrote' };
      },
      replanChunk: async () => 'unused',
      // Resume: pretend the orchestrator restarted mid-feature.
      // Chunks 1 and 2 are already committed (in a hypothetical prior
      // run); chunk 3 is what's left to do.
      resumeFromPlan: {
        plan: {
          featureId: 'F-X',
          chunks: [
            { id: 'F-X-1', files: ['a.ts'], description: 'add a' },
            { id: 'F-X-2', files: ['b.ts'], description: 'add b' },
            { id: 'F-X-3', files: ['c.ts'], description: 'add c' },
          ],
        },
        committedChunkIds: ['F-X-1', 'F-X-2'],
      },
    };

    const out = await runChunkLoop({ id: 'F-X', title: 'X', description: 'X' }, deps);

    assert.equal(out.kind, 'completed');
    assert.equal(planChunksCalled, 0, 'planChunks must NOT be called when resumeFromPlan is set');
    assert.equal(implementCalled, 1, 'only the uncommitted chunk should be implemented');
    assert.deepEqual(implementOrder, ['F-X-3']);

    // Only F-X-3 commit should land — the test runner doesn't include
    // the F-X-1 / F-X-2 commits because we're synthesizing the resume
    // state without actually having them.
    const log = await execSync('git', ['log', '--format=%s'], repo);
    assert.match(log, /chunk\[F-X-3\]/);
    assert.doesNotMatch(log, /chunk\[F-X-1\]/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('resumeFromPlan with all chunks committed is a no-op (returns completed)', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    let implementCalled = 0;
    let planCalled = 0;

    const out = await runChunkLoop(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: 'true',
        planChunks: async () => {
          planCalled++;
          return 'unused';
        },
        implementChunk: async (_f, _c, env) => {
          implementCalled++;
          await fs.writeFile(path.join(env.dir, 'a.ts'), 'edited');
          return { touchedFiles: ['a.ts'], attemptedChange: 'x' };
        },
        replanChunk: async () => 'unused',
        resumeFromPlan: {
          plan: {
            featureId: 'F-X',
            chunks: [{ id: 'F-X-1', files: ['a.ts'], description: 'add a' }],
          },
          committedChunkIds: ['F-X-1'],
        },
      },
    );

    assert.equal(out.kind, 'completed');
    if (out.kind === 'completed') assert.equal(out.chunksCommitted, 1);
    assert.equal(planCalled, 0);
    assert.equal(implementCalled, 0);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('resumeFromPlan does not emit plan_ready (avoid clobbering persisted state)', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const events: string[] = [];

    await runChunkLoop(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: 'true',
        planChunks: async () => 'unused',
        implementChunk: async (_f, _c, env) => {
          await fs.writeFile(path.join(env.dir, 'a.ts'), 'edited');
          return { touchedFiles: ['a.ts'], attemptedChange: 'x' };
        },
        replanChunk: async () => 'unused',
        onProgress: (e) => {
          events.push(e.kind);
        },
        resumeFromPlan: {
          plan: {
            featureId: 'F-X',
            chunks: [{ id: 'F-X-1', files: ['a.ts'], description: 'add a' }],
          },
          committedChunkIds: [],
        },
      },
    );

    // Sequence: chunk_start → chunk_committed. NO plan_ready (would
    // re-trigger persistPlan in the driver and DELETE the existing
    // persisted state).
    assert.deepEqual(events, ['chunk_start', 'chunk_committed']);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('resumeFromPlan handles partial completion correctly (resumes mid-plan)', async () => {
  // Real-world crash-recovery: 5-chunk plan, chunks 1-3 succeeded
  // before the crash, chunks 4-5 still need to run.
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const implementOrder: string[] = [];

    const out = await runChunkLoop(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: 'true',
        planChunks: async () => 'unused',
        implementChunk: async (_f, chunk, env) => {
          implementOrder.push(chunk.id);
          await fs.writeFile(path.join(env.dir, chunk.files[0]), `// ${chunk.id}\n`);
          return { touchedFiles: chunk.files, attemptedChange: 'x' };
        },
        replanChunk: async () => 'unused',
        resumeFromPlan: {
          plan: {
            featureId: 'F-X',
            chunks: [
              { id: 'F-X-1', files: ['a.ts'], description: 'add a' },
              { id: 'F-X-2', files: ['b.ts'], description: 'add b' },
              { id: 'F-X-3', files: ['c.ts'], description: 'add c' },
              { id: 'F-X-4', files: ['a.ts'], description: 'rewrite a' },
              { id: 'F-X-5', files: ['b.ts'], description: 'rewrite b' },
            ],
          },
          committedChunkIds: ['F-X-1', 'F-X-2', 'F-X-3'],
        },
      },
    );

    assert.equal(out.kind, 'completed');
    assert.deepEqual(implementOrder, ['F-X-4', 'F-X-5']);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('runChunkLoopCore runs a PRE-RESOLVED plan directly, skipping committed chunks (the extracted seam — D-015 stage-a)', async () => {
  // The reusable seam a future deterministic `worker:chunk-loop` blueprint step
  // calls: given an already-resolved plan + the committed-chunk set, iterate the
  // remaining chunks — NO plan phase (planChunks must never be called).
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const implementOrder: string[] = [];
    const deps: ChunkLoopDeps = {
      repoPath: repo,
      lockCoordinator: new FileLockQueueCoordinator(lockQueue),
      typecheckCommand: 'true',
      planChunks: async () => {
        throw new Error('planChunks must NOT be called — runChunkLoopCore takes a resolved plan');
      },
      implementChunk: async (_f, chunk, env) => {
        implementOrder.push(chunk.id);
        await fs.writeFile(path.join(env.dir, chunk.files[0]), `// ${chunk.id}\n`);
        return { touchedFiles: chunk.files, attemptedChange: 'x' };
      },
      replanChunk: async () => 'unused',
    };
    const out = await runChunkLoopCore(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        featureId: 'F-X',
        chunks: [
          { id: 'F-X-1', files: ['a.ts'], description: 'add a' },
          { id: 'F-X-2', files: ['b.ts'], description: 'add b' },
        ],
      },
      deps,
      new Set(['F-X-1']),
    );
    assert.equal(out.kind, 'completed');
    if (out.kind === 'completed') assert.equal(out.chunksCommitted, 2); // 1 skipped (counted) + 1 implemented
    assert.deepEqual(implementOrder, ['F-X-2']); // only the uncommitted chunk implemented
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('FileLockQueue.reap unblocks waiters when a worker dies mid-acquire', async () => {
  // Lock-queue level: simulate orchestrator crash where a worker held
  // a path but didn't release. The reaper unblocks queued waiters
  // for that path.
  const lockQueue = new FileLockQueue();

  // "Crashed" worker takes a path and abandons it.
  await lockQueue.acquire('crashed-worker', ['shared.ts']);

  // Concurrent waiter blocks on the path.
  let waiterCompleted = false;
  const waiterPromise = lockQueue.acquire('waiter', ['shared.ts']).then((h) => {
    waiterCompleted = true;
    lockQueue.release(h);
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(waiterCompleted, false, 'waiter should still be blocked');

  // Reaper sees the crashed worker (in production: PID heartbeat
  // missed) and force-releases its locks.
  const reaped = lockQueue.reap('crashed-worker');
  assert.equal(reaped, 1);

  await waiterPromise;
  assert.equal(waiterCompleted, true);
  assert.deepEqual(lockQueue.snapshot(), { held: {}, queueLength: 0 });
});

test('multiple crashed workers reaped in one call unblock the right waiters', async () => {
  const lockQueue = new FileLockQueue();

  await lockQueue.acquire('w1', ['a', 'b']);
  await lockQueue.acquire('w2', ['c']);
  // Independent waiter on 'a' (held by w1).
  let aDone = false;
  const aP = lockQueue.acquire('aw', ['a']).then((h) => {
    aDone = true;
    lockQueue.release(h);
  });
  // Waiter on 'c' (held by w2).
  let cDone = false;
  const cP = lockQueue.acquire('cw', ['c']).then((h) => {
    cDone = true;
    lockQueue.release(h);
  });

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(aDone, false);
  assert.equal(cDone, false);

  // Reap w1 only — c stays held by w2.
  assert.equal(lockQueue.reap('w1'), 2);
  await aP;
  assert.equal(aDone, true);
  assert.equal(cDone, false);

  // Reap w2 — c finally frees.
  assert.equal(lockQueue.reap('w2'), 1);
  await cP;
  assert.equal(cDone, true);
});

// ─── Crash-during-X resume (worker-chunk-loop-operator-hosted-2026-06-14 P-005) ──
// The existing resume tests above cover the skip-list (already-committed chunks are
// skipped). These ADD the three crash WINDOWS: a chunk that crashed mid-implement /
// mid-commit / mid-replan is NOT in committedChunkIds, so on resume it re-runs from a
// FRESH scratch + a FRESH strike budget, with the idempotent commit absorbing any
// partial work the crash left in HEAD. The op-hosted runner resumes off the SAME PG
// plan store the subprocess path does (D-004), so these guard its crash-recovery.

/** A replan response in the chunk-plan block format `replanChunk` returns. */
function replanBlock(chunk: { id: string; files: string[]; description: string }): string {
  return `Revised:\n\n\`\`\`chunk-plan\n${JSON.stringify({ chunks: [chunk] })}\n\`\`\`\n`;
}

test('crash-during-implement: the in-flight (uncommitted) chunk re-implements from a FRESH scratch on resume', async () => {
  // Chunks 1-2 committed before the crash; chunk 3 was mid-implement (NOT committed)
  // → resume re-implements ONLY chunk 3, and a partial edit the crashed attempt may
  // have written to its scratch never leaks (each attempt gets a fresh worktree).
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const implementOrder: string[] = [];
    const out = await runChunkLoopCore(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        featureId: 'F-X',
        chunks: [
          { id: 'F-X-1', files: ['a.ts'], description: 'a' },
          { id: 'F-X-2', files: ['b.ts'], description: 'b' },
          { id: 'F-X-3', files: ['c.ts'], description: 'c' },
        ],
      },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: 'true',
        planChunks: async () => {
          throw new Error('planChunks must NOT run on resume');
        },
        implementChunk: async (_f, chunk, env) => {
          implementOrder.push(chunk.id);
          // The scratch is fresh: c.ts holds only the initial repo content, never a
          // partial edit from the "crashed" attempt.
          const cur = await fs.readFile(path.join(env.dir, 'c.ts'), 'utf8');
          assert.equal(cur, 'export const c = 0;\n', 'resume implement must see a fresh scratch, not partial edits');
          await fs.writeFile(path.join(env.dir, 'c.ts'), 'export const c = 3;\n');
          return { touchedFiles: chunk.files, attemptedChange: 'wrote c' };
        },
        replanChunk: async () => 'unused',
      },
      new Set(['F-X-1', 'F-X-2']),
    );
    assert.equal(out.kind, 'completed');
    if (out.kind === 'completed') assert.equal(out.chunksCommitted, 3); // 2 skipped (counted) + 1 implemented
    assert.deepEqual(implementOrder, ['F-X-3']);
    // The resume's content is what landed.
    assert.equal(await fs.readFile(path.join(repo, 'c.ts'), 'utf8'), 'export const c = 3;\n');
    const log = await execSync('git', ['log', '--format=%s'], repo);
    assert.match(log, /chunk\[F-X-3\]/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('crash-during-commit: a chunk committed to HEAD but NOT recorded re-runs as an idempotent no-op (no false strike/escalate)', async () => {
  // The crash window between `git commit` landing and the chunk id being persisted to
  // the PG plan: on resume the chunk is still "uncommitted", so it re-implements +
  // re-commits. Its effect is already in HEAD → the commit is an empty no-op, which
  // must NOT strike or escalate (it is a clean replay, not a typecheck failure).
  const repo = await makeRepo();
  try {
    // Simulate chunk F-X-2's commit having ALREADY landed in HEAD pre-crash.
    await fs.writeFile(path.join(repo, 'b.ts'), 'export const b = 2;\n');
    await execSync('git', ['commit', '-q', '-am', 'chunk[F-X-2]: b (pre-crash, not yet recorded)'], repo);

    const lockQueue = new FileLockQueue();
    let escalated = false;
    const out = await runChunkLoopCore(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        featureId: 'F-X',
        chunks: [
          { id: 'F-X-1', files: ['a.ts'], description: 'a' },
          { id: 'F-X-2', files: ['b.ts'], description: 'b' },
        ],
      },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: 'true',
        planChunks: async () => 'unused',
        implementChunk: async (_f, chunk, env) => {
          // Re-implement writes the SAME content the pre-crash attempt did.
          await fs.writeFile(path.join(env.dir, chunk.files[0]), 'export const b = 2;\n');
          return { touchedFiles: chunk.files, attemptedChange: 'rewrote b (replay)' };
        },
        replanChunk: async () => 'unused',
        onEscalate: () => {
          escalated = true;
        },
      },
      new Set(['F-X-1']), // F-X-2 NOT recorded (the crash window) → it re-runs
    );
    assert.equal(out.kind, 'completed');
    assert.equal(escalated, false, 'an idempotent replay commit must not escalate');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('crash-during-replan: strikes do NOT persist across resume — a chunk re-running gets a FRESH strike budget', async () => {
  // The crash happened mid-replan of chunk 2 (after burning a strike). The strike
  // counter is in-memory, not persisted, so on resume chunk 2 starts fresh: one
  // typecheck failure → replan → pass, well within the (default 3) budget → completed,
  // NOT escalated. Proves a crash during replan can't compound strikes into a false
  // escalation.
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    // A tick script that fails the FIRST typecheck then passes — persists across the
    // fresh-scratch attempts because it lives in tmpdir, not the worktree.
    const tickFile = path.join(os.tmpdir(), `rc-tc-tick-${Math.random().toString(36).slice(2, 8)}`);
    await fs.writeFile(tickFile, '0');
    const tcScript = path.join(os.tmpdir(), `rc-tc-${Math.random().toString(36).slice(2, 8)}.sh`);
    await fs.writeFile(
      tcScript,
      `#!/usr/bin/env bash\nn=$(cat "${tickFile}")\necho $((n+1)) > "${tickFile}"\nif [ "$n" = "0" ]; then echo "TC ERROR"; exit 1; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    let escalated = false;
    let implementCount = 0;
    const out = await runChunkLoopCore(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        featureId: 'F-X',
        chunks: [
          { id: 'F-X-1', files: ['a.ts'], description: 'a' },
          { id: 'F-X-2', files: ['b.ts'], description: 'b' },
        ],
      },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: `bash ${tcScript}`,
        planChunks: async () => 'unused',
        implementChunk: async (_f, chunk, env) => {
          implementCount++;
          await fs.writeFile(path.join(env.dir, chunk.files[0]), `export const b = ${implementCount};\n`);
          return { touchedFiles: chunk.files, attemptedChange: `attempt ${implementCount}` };
        },
        replanChunk: async (_f, failed) => replanBlock({ id: failed.id, files: failed.files, description: 'retry b' }),
        replanStrikes: 3,
        onEscalate: () => {
          escalated = true;
        },
      },
      new Set(['F-X-1']), // chunk 2 resumes uncommitted with a FRESH strike budget
    );
    assert.equal(out.kind, 'completed');
    assert.equal(escalated, false);
    assert.equal(implementCount, 2, 'one failed attempt + one replan attempt — a fresh budget, not pre-loaded strikes');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
