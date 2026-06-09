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
  type ChunkProgressEvent,
} from './worker-chunk-loop.js';
import type { ScratchEnv } from './scratch-env.js';

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
  const dir = path.join(os.tmpdir(), `papercusp-loop-test-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  await execSync('git', ['init', '-q', '-b', 'main'], dir);
  await execSync('git', ['config', 'user.email', 'test@papercusp.test'], dir);
  await execSync('git', ['config', 'user.name', 'Test'], dir);
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  await execSync('git', ['add', '.'], dir);
  await execSync('git', ['commit', '-q', '-m', 'initial'], dir);
  return dir;
}

const FEATURE: ChunkLoopFeature = {
  id: 'F-X',
  title: 'Test feature',
  description: 'Demonstrate the chunk loop',
};

function makePlanResponse(chunks: { id: string; files: string[]; description: string }[]): string {
  return `Plan:\n\n\`\`\`chunk-plan\n${JSON.stringify({ chunks })}\n\`\`\`\n`;
}

function makeReplanResponse(chunk: { id: string; files: string[]; description: string }): string {
  return `Revised:\n\n\`\`\`chunk-plan\n${JSON.stringify({ chunks: [chunk] })}\n\`\`\`\n`;
}

test('happy path: single chunk plan, succeeds first try', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const events: ChunkProgressEvent[] = [];

    const deps: ChunkLoopDeps = {
      repoPath: repo,
      lockCoordinator: new FileLockQueueCoordinator(lockQueue),
      planChunks: async () =>
        makePlanResponse([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo()' }]),
      implementChunk: async (_f, chunk, env) => {
        // Worker writes valid code to env.
        await fs.writeFile(
          path.join(env.dir, 'a.ts'),
          'export const a = 1;\nexport const foo = () => 2;\n',
        );
        return { touchedFiles: chunk.files, attemptedChange: 'added foo()' };
      },
      replanChunk: async () => {
        throw new Error('replan should not be called on happy path');
      },
      typecheckCommand: 'true', // exit 0
      onProgress: async (e) => {
        events.push(e);
      },
    };

    const out = await runChunkLoop(FEATURE, deps);
    assert.deepEqual(out, { kind: 'completed', chunksCommitted: 1 });

    // Verify commit landed.
    const log = await execSync('git', ['log', '--format=%s'], repo);
    assert.match(log, /chunk\[F-X-1\]: add foo\(\)/);
    // Verify file content updated.
    const content = await fs.readFile(path.join(repo, 'a.ts'), 'utf8');
    assert.match(content, /foo = \(\) => 2/);

    // Verify event sequence: plan_ready → chunk_start → chunk_committed
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ['plan_ready', 'chunk_start', 'chunk_committed']);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('typecheck failure triggers re-plan, succeeds on second try', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    let typecheckCallCount = 0;
    let implementCallCount = 0;

    const deps: ChunkLoopDeps = {
      repoPath: repo,
      lockCoordinator: new FileLockQueueCoordinator(lockQueue),
      planChunks: async () =>
        makePlanResponse([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo()' }]),
      implementChunk: async (_f, chunk, env) => {
        implementCallCount++;
        await fs.writeFile(path.join(env.dir, 'a.ts'), 'whatever\n');
        return {
          touchedFiles: chunk.files,
          attemptedChange: `attempt ${implementCallCount}`,
        };
      },
      replanChunk: async (_f, failed) =>
        makeReplanResponse({
          id: failed.id,
          files: ['a.ts', 'b.ts'],
          description: 'add foo() and wire it up',
        }),
      typecheckCommand: process.platform === 'win32'
        // First call exits 1, subsequent calls exit 0. We use a script
        // file because portable.
        ? 'cmd /c exit 0'
        : 'true',
      // Override typecheckCommand via shadowing — actually we'll use a
      // counter approach below since we can't easily switch cmd between
      // calls.
      onProgress: () => {},
    };
    // Replace typecheckCommand with a counter-based mock by overriding
    // runCheck via a custom command. Simpler: use a script in tmpdir.
    const tickFile = path.join(os.tmpdir(), `tc-tick-${Math.random().toString(36).slice(2, 8)}`);
    await fs.writeFile(tickFile, '0');
    const tcScript = path.join(os.tmpdir(), `tc-script-${Math.random().toString(36).slice(2, 8)}.sh`);
    await fs.writeFile(
      tcScript,
      `#!/usr/bin/env bash
n=$(cat "${tickFile}")
echo $((n+1)) > "${tickFile}"
if [ "$n" = "0" ]; then echo "TC ERROR"; exit 1; fi
exit 0
`,
      { mode: 0o755 },
    );
    deps.typecheckCommand = `bash "${tcScript}"`;

    const out = await runChunkLoop(FEATURE, deps);
    assert.equal(out.kind, 'completed');
    if (out.kind === 'completed') assert.equal(out.chunksCommitted, 1);

    // Worker LLM was called twice (once per attempt) due to typecheck-driven re-plan.
    assert.equal(implementCallCount, 2, 'implement called once per attempt');
    typecheckCallCount; // referenced
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('escalates after replanStrikes typecheck failures', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const escalations: { strikes: number; reason: string }[] = [];

    const deps: ChunkLoopDeps = {
      repoPath: repo,
      lockCoordinator: new FileLockQueueCoordinator(lockQueue),
      planChunks: async () =>
        makePlanResponse([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo()' }]),
      implementChunk: async (_f, chunk, env) => {
        await fs.writeFile(path.join(env.dir, 'a.ts'), 'broken');
        return { touchedFiles: chunk.files, attemptedChange: 'broke it' };
      },
      replanChunk: async (_f, failed) =>
        makeReplanResponse({
          id: failed.id,
          files: failed.files,
          description: 'fix it again',
        }),
      typecheckCommand: 'false', // always fails
      replanStrikes: 2,
      onEscalate: (_f, _c, reason, strikes) => {
        escalations.push({ reason, strikes });
      },
    };

    const out = await runChunkLoop(FEATURE, deps);
    assert.equal(out.kind, 'escalated');
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].strikes, 2);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('lock extension is automatic when worker touches additional file', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();

    const deps: ChunkLoopDeps = {
      repoPath: repo,
      lockCoordinator: new FileLockQueueCoordinator(lockQueue),
      planChunks: async () =>
        makePlanResponse([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo()' }]),
      implementChunk: async (_f, _chunk, env: ScratchEnv) => {
        await fs.writeFile(path.join(env.dir, 'a.ts'), 'export const a = 2;\n');
        await fs.writeFile(path.join(env.dir, 'b.ts'), 'export const b = 3;\n');
        return {
          touchedFiles: ['a.ts', 'b.ts'],
          attemptedChange: 'wrote a + b',
        };
      },
      replanChunk: async () => {
        throw new Error('no replan expected');
      },
      typecheckCommand: 'true',
    };

    const out = await runChunkLoop(FEATURE, deps);
    assert.equal(out.kind, 'completed');

    const log = await execSync('git', ['log', '--format=%s'], repo);
    assert.match(log, /chunk\[F-X-1\]: add foo\(\)/);
    assert.ok(await fs.stat(path.join(repo, 'b.ts')).then(() => true), 'b.ts should be committed');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('lock extension contention falls back to release-and-reacquire', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();

    // Pre-hold `b.ts` so the first extension attempt fails.
    const blockingHandle = await lockQueue.acquire('blocker', ['b.ts']);

    let implementCalls = 0;
    let releasedAfterFirstCall = false;

    const deps: ChunkLoopDeps = {
      repoPath: repo,
      lockCoordinator: new FileLockQueueCoordinator(lockQueue),
      planChunks: async () =>
        makePlanResponse([{ id: 'F-X-1', files: ['a.ts'], description: 'add foo()' }]),
      implementChunk: async (_f, _chunk, env) => {
        implementCalls++;
        await fs.writeFile(path.join(env.dir, 'a.ts'), `export const v = ${implementCalls};\n`);
        if (implementCalls === 1) {
          // First call: touch b.ts (we don't have its lock; tryExtend will fail).
          return {
            touchedFiles: ['a.ts', 'b.ts'],
            attemptedChange: 'wrote a + b',
          };
        }
        // After release, second attempt succeeds (we still touch a + b
        // but now b is also locked since chunk.files was extended).
        await fs.writeFile(path.join(env.dir, 'b.ts'), 'export const x = 1;\n');
        return { touchedFiles: ['a.ts', 'b.ts'], attemptedChange: 'wrote a + b again' };
      },
      replanChunk: async () => {
        throw new Error('no replan expected');
      },
      typecheckCommand: 'true',
    };

    // Release the blocker AFTER the first attempt has run + been
    // rejected. Use a small delay; the loop is async so it'll release
    // its locks (via tryExtend failure → continue), and then the
    // re-acquire will block waiting for `blocker` to release.
    setTimeout(() => {
      releasedAfterFirstCall = true;
      lockQueue.release(blockingHandle);
    }, 500);

    const out = await runChunkLoop(FEATURE, deps);
    assert.equal(out.kind, 'completed');
    assert.equal(implementCalls, 2, 'implement called twice (initial + re-after-extension)');
    assert.equal(releasedAfterFirstCall, true);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('planning_failed when LLM response is unparseable', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const deps: ChunkLoopDeps = {
      repoPath: repo,
      lockCoordinator: new FileLockQueueCoordinator(lockQueue),
      planChunks: async () => 'no fenced block here',
      implementChunk: async () => {
        throw new Error('should not be called');
      },
      replanChunk: async () => {
        throw new Error('should not be called');
      },
      typecheckCommand: 'true',
    };

    const out = await runChunkLoop(FEATURE, deps);
    assert.equal(out.kind, 'planning_failed');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('multiple chunks commit in order', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const deps: ChunkLoopDeps = {
      repoPath: repo,
      lockCoordinator: new FileLockQueueCoordinator(lockQueue),
      planChunks: async () =>
        makePlanResponse([
          { id: 'F-X-1', files: ['a.ts'], description: 'add foo()' },
          { id: 'F-X-2', files: ['a.ts'], description: 'add bar()' },
          { id: 'F-X-3', files: ['a.ts'], description: 'wire foo and bar together' },
        ]),
      implementChunk: async (_f, chunk, env) => {
        const cur = await fs.readFile(path.join(env.dir, 'a.ts'), 'utf8').catch(() => '');
        await fs.writeFile(
          path.join(env.dir, 'a.ts'),
          cur + `// ${chunk.description}\n`,
        );
        return { touchedFiles: chunk.files, attemptedChange: chunk.description };
      },
      replanChunk: async () => {
        throw new Error('no replan');
      },
      typecheckCommand: 'true',
    };

    const out = await runChunkLoop(FEATURE, deps);
    assert.equal(out.kind, 'completed');
    if (out.kind === 'completed') assert.equal(out.chunksCommitted, 3);

    const log = await execSync('git', ['log', '--format=%s', '--reverse'], repo);
    const lines = log.trim().split('\n');
    assert.equal(lines[0], 'initial');
    assert.equal(lines[1], 'chunk[F-X-1]: add foo()');
    assert.equal(lines[2], 'chunk[F-X-2]: add bar()');
    assert.equal(lines[3], 'chunk[F-X-3]: wire foo and bar together');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('UNRUNNABLE check (exit 127) fails OPEN: chunk commits, no strikes, no replan', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const logs: string[] = [];
    const deps: ChunkLoopDeps = {
      repoPath: repo,
      lockCoordinator: new FileLockQueueCoordinator(lockQueue),
      planChunks: async () =>
        makePlanResponse([{ id: 'F-X-1', files: ['a.ts'], description: 'add bar()' }]),
      implementChunk: async (_f, chunk, env) => {
        await fs.writeFile(
          path.join(env.dir, 'a.ts'),
          'export const a = 1;\nexport const bar = () => 3;\n',
        );
        return { touchedFiles: chunk.files, attemptedChange: 'added bar()' };
      },
      replanChunk: async () => {
        throw new Error('replan must NOT be called — an unrunnable gate cannot be fixed by replanning');
      },
      // The frame failure mode: the configured tool does not exist in this
      // environment → shell exit 127 ("command not found").
      typecheckCommand: 'definitely-not-a-real-command-papercusp',
      log: (m) => logs.push(m),
    };

    const out = await runChunkLoop(FEATURE, deps);
    assert.equal(out.kind, 'completed');
    assert.ok(
      logs.some((m) => m.includes('UNRUNNABLE') && m.includes('definitely-not-a-real-command-papercusp')),
      `expected a loud unrunnable-gate log; got: ${logs.join(' | ')}`,
    );
    // The chunk actually committed to the repo.
    const committed = await execSync('git', ['show', 'HEAD:a.ts'], repo);
    assert.ok(committed.includes('bar'), 'chunk edit must be committed despite the unrunnable gate');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('a directory in chunk.files (sandbox node_modules leak) is SKIPPED by the commit, not EISDIR-fatal', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const deps: ChunkLoopDeps = {
      repoPath: repo,
      lockCoordinator: new FileLockQueueCoordinator(lockQueue),
      // The poisoned shape: a real file edit PLUS a directory entry (what the
      // sandbox's node_modules/ artifact looked like after lock-extension).
      planChunks: async () =>
        makePlanResponse([
          { id: 'F-X-1', files: ['a.ts', 'node_modules'], description: 'add baz()' },
        ]),
      implementChunk: async (_f, _chunk, env) => {
        await fs.mkdir(path.join(env.dir, 'node_modules'), { recursive: true });
        await fs.writeFile(
          path.join(env.dir, 'a.ts'),
          'export const a = 1;\nexport const baz = () => 4;\n',
        );
        return { touchedFiles: ['a.ts'], attemptedChange: 'added baz()' };
      },
      replanChunk: async () => {
        throw new Error('replan must NOT be called — the dir entry is skipped, not fatal');
      },
      typecheckCommand: 'true',
    };

    const out = await runChunkLoop(FEATURE, deps);
    assert.equal(out.kind, 'completed');
    const committed = await execSync('git', ['show', 'HEAD:a.ts'], repo);
    assert.ok(committed.includes('baz'), 'the real file edit committed; the dir entry was skipped');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
