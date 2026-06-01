import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { FileLockQueue } from './file-lock-queue.js';
import { FileLockQueueCoordinator } from './file-lock-queue-coordinator.js';
import { runChunkLoop, type ChunkLoopDeps } from './worker-chunk-loop.js';

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
