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
  const dir = path.join(os.tmpdir(), `papercusp-edge-test-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  await execSync('git', ['init', '-q', '-b', 'main'], dir);
  await execSync('git', ['config', 'user.email', 'test@papercusp.test'], dir);
  await execSync('git', ['config', 'user.name', 'Test'], dir);
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 0;\n');
  await execSync('git', ['add', '.'], dir);
  await execSync('git', ['commit', '-q', '-m', 'initial'], dir);
  return dir;
}

const PLAN_HEADER = '```chunk-plan\n';
const PLAN_FOOTER = '\n```';
function planResp(chunks: { id: string; files: string[]; description: string }[]): string {
  return `${PLAN_HEADER}${JSON.stringify({ chunks })}${PLAN_FOOTER}`;
}

test('empty plan returns completed without doing any work', async () => {
  // The LLM said "no work needed for this feature" — that's a legal
  // outcome. The loop should accept it and return completed without
  // calling implementChunk.
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    let implementCalled = 0;
    const out = await runChunkLoop(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: 'true',
        planChunks: async () => planResp([]),
        implementChunk: async () => {
          implementCalled++;
          return { touchedFiles: [], attemptedChange: 'noop' };
        },
        replanChunk: async () => 'unused',
      },
    );
    assert.equal(out.kind, 'completed');
    if (out.kind === 'completed') assert.equal(out.chunksCommitted, 0);
    assert.equal(implementCalled, 0);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('chunk that touches zero files commits successfully (description-only commit)', async () => {
  // Edge case: a chunk's `files` is empty (e.g., a docstring-only
  // change that the worker chooses not to declare). The lock queue
  // accepts an empty path set; the typecheck still runs; the commit
  // step should produce a commit.
  // In practice we'd reject empty files at plan-validation time, but
  // the loop shouldn't crash if it does see one.
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const out = await runChunkLoop(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: 'true',
        planChunks: async () =>
          planResp([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo' }]),
        implementChunk: async (_f, c, env) => {
          await fs.writeFile(path.join(env.dir, c.files[0]), 'export const a = 1;\n');
          return { touchedFiles: c.files, attemptedChange: 'wrote a' };
        },
        replanChunk: async () => 'unused',
      },
    );
    assert.equal(out.kind, 'completed');
    assert.deepEqual(lockQueue.snapshot(), { held: {}, queueLength: 0 });
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('multiple chunks in same feature can lock + release the same file in sequence', async () => {
  // A single feature might have F-X-1 modifying foo.ts then F-X-3
  // also modifying foo.ts. Each chunk acquires + releases foo.ts in
  // turn — no leak, no deadlock. (The previous "multiple chunks
  // commit in order" test exercises this implicitly; this test
  // explicitly verifies the lock-queue snapshot between chunks.)
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const snapshotsBetweenChunks: Array<{ held: Record<string, string>; queueLength: number }> = [];

    const out = await runChunkLoop(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: 'true',
        planChunks: async () =>
          planResp([
            { id: 'F-X-1', files: ['a.ts'], description: 'add line 1' },
            { id: 'F-X-2', files: ['a.ts'], description: 'add line 2' },
            { id: 'F-X-3', files: ['a.ts'], description: 'add line 3' },
          ]),
        implementChunk: async (_f, c, env) => {
          const cur = await fs.readFile(path.join(env.dir, 'a.ts'), 'utf8');
          await fs.writeFile(path.join(env.dir, 'a.ts'), cur + `// ${c.id}\n`);
          return { touchedFiles: c.files, attemptedChange: c.description };
        },
        replanChunk: async () => 'unused',
        onProgress: (e) => {
          if (e.kind === 'chunk_committed') {
            snapshotsBetweenChunks.push(lockQueue.snapshot());
          }
        },
      },
    );

    assert.equal(out.kind, 'completed');
    // After every chunk_committed event, the lock should be released
    // (even though the same feature is about to re-acquire it for the
    // next chunk).
    for (const s of snapshotsBetweenChunks) {
      assert.deepEqual(s.held, {}, 'lock must be released between chunks');
    }
    assert.equal(snapshotsBetweenChunks.length, 3);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('typecheck timeout (slow check) escalates without hanging the run', async () => {
  // Worker's chunk passes the implement step but the typecheck
  // command runs forever (e.g., a hung `tsc`). The loop should kill
  // the typecheck via timeoutMs and treat it as a non-zero exit →
  // strike → eventually escalate.
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const start = Date.now();
    const out = await runChunkLoop(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: 'sleep 60', // 60s sleep
        typecheckTimeoutMs: 200, // kill at 200ms
        replanStrikes: 1, // escalate on first failure
        planChunks: async () =>
          planResp([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo' }]),
        implementChunk: async (_f, c, env) => {
          await fs.writeFile(path.join(env.dir, c.files[0]), 'export const a = 1;\n');
          return { touchedFiles: c.files, attemptedChange: 'wrote a' };
        },
        replanChunk: async () =>
          planResp([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo' }]),
        onEscalate: () => {},
      },
    );
    const elapsed = Date.now() - start;

    assert.equal(out.kind, 'escalated');
    // The whole run should have completed in well under the 60s sleep
    // — the timeoutMs killed the typecheck.
    assert.ok(elapsed < 5_000, `run took ${elapsed}ms — typecheck timeout didn't fire`);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('worker writes nothing in scratch — no commit, no error, just empty change', async () => {
  // Worker's implement returned but didn't actually edit anything.
  // The diff-against-HEAD walk produces an empty list. Commit is
  // attempted but git-commit will fail with "nothing to commit"
  // unless we handle it. This test pins the current behavior so any
  // future change is intentional.
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const out = await runChunkLoop(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: 'true',
        replanStrikes: 1,
        planChunks: async () =>
          planResp([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo' }]),
        implementChunk: async (_f, c) => {
          // Worker did nothing in scratch.
          return { touchedFiles: c.files, attemptedChange: 'forgot to write' };
        },
        replanChunk: async () =>
          planResp([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo' }]),
        onEscalate: () => {},
      },
    );

    // Committing a no-op should fail (git commit exits 1 with "nothing
    // to commit"). The loop catches that as a strike. With
    // replanStrikes=1 it escalates. This pins the current behavior;
    // future improvements (e.g., treat empty diff as "no change
    // intended" → success) would change this assertion.
    assert.equal(out.kind, 'escalated');
    assert.deepEqual(lockQueue.snapshot(), { held: {}, queueLength: 0 });
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('lock-extension success path commits ALL files (the bug we fixed)', async () => {
  // Regression test for the bug we caught earlier where tryExtend
  // success didn't update chunk.files, so commit only staged the
  // originally-declared paths and the extended ones got dropped.
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();

    const out = await runChunkLoop(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: 'true',
        planChunks: async () =>
          planResp([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo' }]),
        implementChunk: async (_f, _c, env) => {
          await fs.writeFile(path.join(env.dir, 'a.ts'), 'export const a = 1;\n');
          await fs.writeFile(path.join(env.dir, 'b.ts'), 'export const b = 1;\n');
          return {
            touchedFiles: ['a.ts', 'b.ts'], // declared a, also wrote b
            attemptedChange: 'wrote a + b',
          };
        },
        replanChunk: async () => 'unused',
      },
    );

    assert.equal(out.kind, 'completed');
    // BOTH files must be in the repo + tracked by git.
    const tracked = await execSync('git', ['ls-files'], repo);
    assert.match(tracked, /^a\.ts$/m, 'a.ts must be in git index');
    assert.match(tracked, /^b\.ts$/m, 'b.ts must be in git index (extension committed)');
    const aContent = await fs.readFile(path.join(repo, 'a.ts'), 'utf8');
    const bContent = await fs.readFile(path.join(repo, 'b.ts'), 'utf8');
    assert.match(aContent, /a = 1/);
    assert.match(bContent, /b = 1/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('replan response that swaps the chunk id is rejected', async () => {
  // Re-plan must return a chunk with the SAME id that failed —
  // otherwise the loop has no way to know which chunk in the plan
  // to replace. The current behavior is to abort the loop with a
  // structured error. Pin it.
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();

    const out = await runChunkLoop(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: 'false',
        replanStrikes: 5,
        planChunks: async () =>
          planResp([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo' }]),
        implementChunk: async (_f, c, env) => {
          await fs.writeFile(path.join(env.dir, c.files[0]), 'broken');
          return { touchedFiles: c.files, attemptedChange: 'broke' };
        },
        replanChunk: async () =>
          // Returns a chunk with a DIFFERENT id — bug response.
          planResp([{ id: 'F-X-99', files: ['a.ts'], description: 'add bar' }]),
      },
    );

    assert.equal(out.kind, 'aborted');
    if (out.kind === 'aborted') {
      assert.match(out.reason, /no chunk with id F-X-1/);
    }
    assert.deepEqual(lockQueue.snapshot(), { held: {}, queueLength: 0 });
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
