import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { FileLockQueue } from './file-lock-queue.js';
import { FileLockQueueCoordinator } from './file-lock-queue-coordinator.js';
import {
  runChunkLoop,
  type ChunkLoopDeps,
  type ChunkLoopFeature,
} from './worker-chunk-loop.js';

/**
 * Concurrency suite for the chunk loop. Real git, real scratch
 * worktrees, real FileLockQueue — multiple workers run in parallel
 * with overlapping file declarations to make sure:
 *
 *   - Locks serialize concurrent edits to the same file
 *   - Workers on disjoint files run truly in parallel (no head-waiter
 *     starvation)
 *   - All commits land in a clean linear history (no merge conflicts,
 *     no lost edits)
 *   - The lock queue ends empty (no leaked holds)
 *   - The repo's working tree is clean at the end (no orphan worktrees)
 *
 * These are the "would the real production scenario actually work"
 * tests. They use a fast-typecheck (`true`) so the wall clock is
 * dominated by lock contention + git ops, not by LLM thinking — but
 * the structural concurrency is what we're proving.
 */

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

async function makeRepo(initialFiles: Record<string, string>): Promise<string> {
  const dir = path.join(os.tmpdir(), `papercusp-conc-test-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  await execSync('git', ['init', '-q', '-b', 'main'], dir);
  await execSync('git', ['config', 'user.email', 'test@papercusp.test'], dir);
  await execSync('git', ['config', 'user.name', 'Test'], dir);
  for (const [rel, content] of Object.entries(initialFiles)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  await execSync('git', ['add', '.'], dir);
  await execSync('git', ['commit', '-q', '-m', 'initial'], dir);
  return dir;
}

function planResponse(chunks: { id: string; files: string[]; description: string }[]): string {
  return `\`\`\`chunk-plan\n${JSON.stringify({ chunks })}\n\`\`\``;
}

interface WorkerSpec {
  feature: ChunkLoopFeature;
  /**
   * Each chunk: which files to touch and what content to write to
   * each. Description is auto-generated as 'add <fileBase>'.
   */
  chunks: Array<{ id: string; edits: Record<string, string> }>;
}

function depsFor(
  spec: WorkerSpec,
  ctx: { repoPath: string; lockQueue: FileLockQueue },
): ChunkLoopDeps {
  return {
    repoPath: ctx.repoPath,
    lockCoordinator: new FileLockQueueCoordinator(ctx.lockQueue),
    typecheckCommand: 'true',
    planChunks: async () =>
      planResponse(
        spec.chunks.map((c) => ({
          id: c.id,
          files: Object.keys(c.edits),
          description: `add ${path.basename(Object.keys(c.edits)[0]).split('.')[0]}`,
        })),
      ),
    implementChunk: async (_f, chunk, env) => {
      const def = spec.chunks.find((c) => c.id === chunk.id);
      if (!def) throw new Error(`no spec for ${chunk.id}`);
      for (const [rel, content] of Object.entries(def.edits)) {
        const abs = path.join(env.dir, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
      }
      return {
        touchedFiles: Object.keys(def.edits),
        attemptedChange: `wrote ${Object.keys(def.edits).length} files`,
      };
    },
    replanChunk: async () => {
      throw new Error('no replan expected — typecheck is true');
    },
  };
}

test('two workers on disjoint files run concurrently and commit cleanly', async () => {
  const repo = await makeRepo({ 'a.ts': 'export const a = 0;\n', 'b.ts': 'export const b = 0;\n' });
  try {
    const lockQueue = new FileLockQueue();

    const wA: WorkerSpec = {
      feature: { id: 'F-A', title: 'Edit a', description: 'A' },
      chunks: [{ id: 'F-A-1', edits: { 'a.ts': 'export const a = 1;\n' } }],
    };
    const wB: WorkerSpec = {
      feature: { id: 'F-B', title: 'Edit b', description: 'B' },
      chunks: [{ id: 'F-B-1', edits: { 'b.ts': 'export const b = 1;\n' } }],
    };

    const [outA, outB] = await Promise.all([
      runChunkLoop(wA.feature, depsFor(wA, { repoPath: repo, lockQueue })),
      runChunkLoop(wB.feature, depsFor(wB, { repoPath: repo, lockQueue })),
    ]);

    assert.equal(outA.kind, 'completed');
    assert.equal(outB.kind, 'completed');

    const log = await execSync('git', ['log', '--format=%s'], repo);
    assert.match(log, /chunk\[F-A-1\]/);
    assert.match(log, /chunk\[F-B-1\]/);

    // Both edits landed in the working tree.
    assert.match(await fs.readFile(path.join(repo, 'a.ts'), 'utf8'), /a = 1/);
    assert.match(await fs.readFile(path.join(repo, 'b.ts'), 'utf8'), /b = 1/);

    // Lock queue clean.
    assert.deepEqual(lockQueue.snapshot(), { held: {}, queueLength: 0 });
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('two workers on the same file serialize via the lock queue', async () => {
  const repo = await makeRepo({ 'shared.ts': 'export const v = 0;\n' });
  try {
    const lockQueue = new FileLockQueue();

    const wA: WorkerSpec = {
      feature: { id: 'F-A', title: 'A', description: 'A' },
      chunks: [{ id: 'F-A-1', edits: { 'shared.ts': '// A\nexport const v = 1;\n' } }],
    };
    const wB: WorkerSpec = {
      feature: { id: 'F-B', title: 'B', description: 'B' },
      chunks: [{ id: 'F-B-1', edits: { 'shared.ts': '// B\nexport const v = 2;\n' } }],
    };

    const start = Date.now();
    const [outA, outB] = await Promise.all([
      runChunkLoop(wA.feature, depsFor(wA, { repoPath: repo, lockQueue })),
      runChunkLoop(wB.feature, depsFor(wB, { repoPath: repo, lockQueue })),
    ]);
    const elapsed = Date.now() - start;

    assert.equal(outA.kind, 'completed');
    assert.equal(outB.kind, 'completed');

    // Both commits made it onto integration branch — proving the lock
    // serialized them rather than producing a merge conflict.
    const log = await execSync('git', ['log', '--format=%s'], repo);
    const aFirst = log.indexOf('F-A-1');
    const bFirst = log.indexOf('F-B-1');
    assert.notEqual(aFirst, -1);
    assert.notEqual(bFirst, -1);

    // Whichever one committed last won the working-tree state.
    const final = await fs.readFile(path.join(repo, 'shared.ts'), 'utf8');
    assert.ok(/A|B/.test(final), 'one of A or B must be the final content');

    assert.deepEqual(lockQueue.snapshot(), { held: {}, queueLength: 0 });
    // Should be fast — typecheck is `true`, no LLM, so lock contention
    // should resolve in well under a second.
    assert.ok(elapsed < 5_000, `serialization took ${elapsed}ms — possible deadlock or slow path`);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('three workers with mixed overlap all complete (no deadlocks, no missed commits)', async () => {
  const repo = await makeRepo({
    'a.ts': 'export const a = 0;\n',
    'b.ts': 'export const b = 0;\n',
    'c.ts': 'export const c = 0;\n',
  });
  try {
    const lockQueue = new FileLockQueue();

    // F-X touches a + b
    // F-Y touches b + c   ← conflicts with F-X on b
    // F-Z touches a + c   ← conflicts with F-X on a, F-Y on c
    // No two workers can run concurrently in their entirety, but at
    // any moment at least one can make progress. Single-chunk plans.
    const specs: WorkerSpec[] = [
      {
        feature: { id: 'F-X', title: 'X', description: 'X' },
        chunks: [
          {
            id: 'F-X-1',
            edits: {
              'a.ts': '// X\nexport const a = 1;\n',
              'b.ts': '// X\nexport const b = 1;\n',
            },
          },
        ],
      },
      {
        feature: { id: 'F-Y', title: 'Y', description: 'Y' },
        chunks: [
          {
            id: 'F-Y-1',
            edits: {
              'b.ts': '// Y\nexport const b = 2;\n',
              'c.ts': '// Y\nexport const c = 1;\n',
            },
          },
        ],
      },
      {
        feature: { id: 'F-Z', title: 'Z', description: 'Z' },
        chunks: [
          {
            id: 'F-Z-1',
            edits: {
              'a.ts': '// Z\nexport const a = 2;\n',
              'c.ts': '// Z\nexport const c = 2;\n',
            },
          },
        ],
      },
    ];

    const start = Date.now();
    const outs = await Promise.all(
      specs.map((s) => runChunkLoop(s.feature, depsFor(s, { repoPath: repo, lockQueue }))),
    );
    const elapsed = Date.now() - start;

    for (const out of outs) {
      assert.equal(out.kind, 'completed');
    }

    // All three commits land — no merge conflicts, lock queue is the
    // serialization mechanism.
    const log = await execSync('git', ['log', '--format=%s'], repo);
    assert.match(log, /F-X-1/);
    assert.match(log, /F-Y-1/);
    assert.match(log, /F-Z-1/);

    assert.deepEqual(lockQueue.snapshot(), { held: {}, queueLength: 0 });
    assert.ok(elapsed < 10_000, `3-worker concurrent run took ${elapsed}ms`);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('worktrees from concurrent workers do not collide on disk', async () => {
  // Stress: 5 workers, each producing a single committable chunk on
  // its own file. They all spin up scratch worktrees in parallel —
  // a previous bug had setup() writing to a shared dir name and they'd
  // step on each other. Each scratch dir must be unique even under
  // simultaneous setup.
  const initial: Record<string, string> = {};
  for (let i = 0; i < 5; i++) {
    initial[`f${i}.ts`] = `export const f${i} = 0;\n`;
  }
  const repo = await makeRepo(initial);
  try {
    const lockQueue = new FileLockQueue();
    const specs: WorkerSpec[] = Array.from({ length: 5 }, (_, i) => ({
      feature: { id: `F-${i}`, title: `f${i}`, description: `f${i}` },
      chunks: [
        {
          id: `F-${i}-1`,
          edits: { [`f${i}.ts`]: `// edited\nexport const f${i} = 1;\n` },
        },
      ],
    }));

    const outs = await Promise.all(
      specs.map((s) => runChunkLoop(s.feature, depsFor(s, { repoPath: repo, lockQueue }))),
    );
    for (const out of outs) {
      assert.equal(out.kind, 'completed');
    }

    // No leftover worktrees — git worktree prune in next setup() reaps
    // anything stale, but a clean run shouldn't even leave traces.
    const wtList = await execSync('git', ['worktree', 'list', '--porcelain'], repo);
    // Expect just the main worktree.
    const wtCount = wtList.split('\n').filter((l) => l.startsWith('worktree ')).length;
    assert.equal(wtCount, 1, `expected only main worktree, got: ${wtList}`);

    // All edits applied.
    for (let i = 0; i < 5; i++) {
      const c = await fs.readFile(path.join(repo, `f${i}.ts`), 'utf8');
      assert.match(c, new RegExp(`f${i} = 1`));
    }
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('lock-queue stays clean when a worker throws mid-implement', async () => {
  // Implementation regression: an implementChunk throw used to leak
  // the lock handle. Verify finally-block release runs.
  const repo = await makeRepo({ 'a.ts': 'export const a = 0;\n' });
  try {
    const lockQueue = new FileLockQueue();

    const out = await runChunkLoop(
      { id: 'F-X', title: 'X', description: 'X' },
      {
        repoPath: repo,
        lockCoordinator: new FileLockQueueCoordinator(lockQueue),
        typecheckCommand: 'true',
        replanStrikes: 1, // single attempt — escalate instead of replan-loop
        planChunks: async () =>
          planResponse([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo()' }]),
        implementChunk: async () => {
          throw new Error('simulated worker crash');
        },
        replanChunk: async () =>
          planResponse([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo()' }]),
        onEscalate: () => {},
      },
    );
    // After replanStrikes hits, escalates.
    assert.equal(out.kind, 'escalated');
    assert.deepEqual(lockQueue.snapshot(), { held: {}, queueLength: 0 });
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
