import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { driveChunkLoop } from './chunk-loop-driver.js';
import { FileLockQueue } from './file-lock-queue.js';
import type { OrchestratorPg } from './invoke.js';
import type { HarnessConfig } from './config.js';

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
  const dir = path.join(os.tmpdir(), `papercusp-driver-test-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  await execSync('git', ['init', '-q', '-b', 'main'], dir);
  await execSync('git', ['config', 'user.email', 'test@papercusp.test'], dir);
  await execSync('git', ['config', 'user.name', 'Test'], dir);
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  await execSync('git', ['add', '.'], dir);
  await execSync('git', ['commit', '-q', '-m', 'initial'], dir);
  return dir;
}

function makeMockPg(): {
  pg: OrchestratorPg;
  calls: Array<{ sql: string }>;
} {
  const calls: Array<{ sql: string }> = [];
  const pg = ((template: TemplateStringsArray, ..._values: unknown[]) => {
    const sql = template.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
    calls.push({ sql });
    return Promise.resolve([]);
  }) as OrchestratorPg;
  return { pg, calls };
}

test('driveChunkLoop persists progress events when pg is wired', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const mockPg = makeMockPg();
    const cfg: HarnessConfig = {
      parallelWorkers: { workingStateCheck: 'true', replanStrikes: 3 },
    } as unknown as HarnessConfig;

    const out = await driveChunkLoop({
      feature: { id: 'F-X', title: 'Demo', description: 'Demo feature' },
      cfg,
      lockQueue,
      repoPath: repo,
      pg: mockPg.pg,
      workspaceId: 'ws-default',
      harnessSlug: 'sheets',
      llm: {
        plan: async () =>
          'Plan:\n```chunk-plan\n{"chunks":[{"id":"F-X-1","files":["a.ts"],"description":"add foo()"}]}\n```',
        implement: async (_f, chunk, env) => {
          await fs.writeFile(path.join(env.dir, 'a.ts'), 'export const a = 2;\n');
          return { touchedFiles: chunk.files, attemptedChange: 'wrote' };
        },
        replan: async () => 'unused',
        escalate: async () => false,
      },
    });

    assert.equal(out.kind, 'completed');

    // Persistence side-effects: persistPlan (1 delete + 1 insert per chunk),
    // chunk_start update (status='in_progress'), chunk_committed update.
    const sqls = mockPg.calls.map((c) => c.sql);
    assert.ok(
      sqls.some((s) => /^delete from harness_shared\.harness_chunk_plans/.test(s)),
      'persistPlan should DELETE existing rows',
    );
    assert.ok(
      sqls.some((s) => /^insert into harness_shared\.harness_chunk_plans/.test(s)),
      'persistPlan should INSERT chunks',
    );
    // Two UPDATEs: chunk_start → in_progress, chunk_committed → committed.
    const updates = sqls.filter((s) => s.startsWith('update harness_shared.harness_chunk_plans'));
    assert.ok(updates.length >= 2, `expected ≥2 UPDATEs (start + committed), got ${updates.length}`);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('driveChunkLoop is a no-op for persistence when pg is omitted', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const cfg: HarnessConfig = {
      parallelWorkers: { workingStateCheck: 'true' },
    } as unknown as HarnessConfig;

    const out = await driveChunkLoop({
      feature: { id: 'F-X', title: 'Demo', description: 'Demo feature' },
      cfg,
      lockQueue,
      repoPath: repo,
      // pg/workspaceId/harnessSlug intentionally omitted
      llm: {
        plan: async () =>
          'Plan:\n```chunk-plan\n{"chunks":[{"id":"F-X-1","files":["a.ts"],"description":"add foo()"}]}\n```',
        implement: async (_f, chunk, env) => {
          await fs.writeFile(path.join(env.dir, 'a.ts'), 'export const a = 2;\n');
          return { touchedFiles: chunk.files, attemptedChange: 'wrote' };
        },
        replan: async () => 'unused',
        escalate: async () => false,
      },
    });

    assert.equal(out.kind, 'completed');
    // No throw, no error. The completion is the test.
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('driveChunkLoop honors config replanStrikes from cfg', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const cfg: HarnessConfig = {
      parallelWorkers: {
        workingStateCheck: 'false', // always fails
        replanStrikes: 1, // escalate after a single strike
        escalateToRole: 'debugger',
      },
    } as unknown as HarnessConfig;

    let escalateCalled = false;
    const out = await driveChunkLoop({
      feature: { id: 'F-X', title: 'Demo', description: 'Demo feature' },
      cfg,
      lockQueue,
      repoPath: repo,
      llm: {
        plan: async () =>
          'Plan:\n```chunk-plan\n{"chunks":[{"id":"F-X-1","files":["a.ts"],"description":"add foo()"}]}\n```',
        implement: async (_f, chunk, env) => {
          await fs.writeFile(path.join(env.dir, 'a.ts'), 'export const a = 2;\n');
          return { touchedFiles: chunk.files, attemptedChange: 'wrote' };
        },
        replan: async () =>
          'Replan:\n```chunk-plan\n{"chunks":[{"id":"F-X-1","files":["a.ts"],"description":"add foo() bigger"}]}\n```',
        escalate: async () => {
          escalateCalled = true;
          return false;
        },
      },
    });

    assert.equal(out.kind, 'escalated');
    assert.equal(escalateCalled, true);
    if (out.kind === 'escalated') {
      assert.equal(out.strikes, 1, 'should escalate after exactly 1 strike per cfg.replanStrikes');
    }
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('driveChunkLoop reads existing plan from pg and resumes (skips planning)', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const cfg: HarnessConfig = {
      parallelWorkers: { workingStateCheck: 'true' },
    } as unknown as HarnessConfig;

    // Mock pg that returns a partial plan on SELECT and accepts writes.
    const calls: string[] = [];
    const pg = ((template: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = template.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push(sql);
      if (sql.startsWith('select')) {
        // Three chunks total; first two committed, third pending.
        return Promise.resolve([
          {
            chunk_id: 'F-X-1',
            chunk_index: 1,
            files: ['a.ts'],
            description: 'add a',
            status: 'committed',
            strikes: 0,
            last_error: null,
            commit_sha: 'aaa1234',
          },
          {
            chunk_id: 'F-X-2',
            chunk_index: 2,
            files: ['b.ts'],
            description: 'add b',
            status: 'committed',
            strikes: 0,
            last_error: null,
            commit_sha: 'bbb1234',
          },
          {
            chunk_id: 'F-X-3',
            chunk_index: 3,
            files: ['c.ts'],
            description: 'add c',
            status: 'pending',
            strikes: 0,
            last_error: null,
            commit_sha: null,
          },
        ]);
      }
      return Promise.resolve([]);
    }) as OrchestratorPg;

    let planCalled = 0;
    let implementCalled = 0;
    const implemented: string[] = [];

    const out = await driveChunkLoop({
      feature: { id: 'F-X', title: 'Demo', description: 'Demo' },
      cfg,
      lockQueue,
      repoPath: repo,
      pg,
      workspaceId: 'ws-default',
      harnessSlug: 'sheets',
      llm: {
        plan: async () => {
          planCalled++;
          return 'should-not-be-called';
        },
        implement: async (_f, c, env) => {
          implementCalled++;
          implemented.push(c.id);
          await fs.writeFile(path.join(env.dir, c.files[0]), `// resumed ${c.id}\n`);
          return { touchedFiles: c.files, attemptedChange: 'wrote' };
        },
        replan: async () => 'unused',
        escalate: async () => false,
      },
    });

    assert.equal(out.kind, 'completed');
    assert.equal(planCalled, 0, 'planChunks should be skipped on resume');
    assert.equal(implementCalled, 1, 'only the third (uncommitted) chunk should be implemented');
    assert.deepEqual(implemented, ['F-X-3']);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('driveChunkLoop passes the configured escalate role to the llm.escalate callback', async () => {
  const repo = await makeRepo();
  try {
    const lockQueue = new FileLockQueue();
    const cfg: HarnessConfig = {
      parallelWorkers: {
        workingStateCheck: 'false',
        replanStrikes: 1,
        escalateToRole: 'architect',
      },
    } as unknown as HarnessConfig;

    let receivedRole: string | null = null;
    await driveChunkLoop({
      feature: { id: 'F-X', title: 'Demo', description: 'Demo feature' },
      cfg,
      lockQueue,
      repoPath: repo,
      llm: {
        plan: async () =>
          'Plan:\n```chunk-plan\n{"chunks":[{"id":"F-X-1","files":["a.ts"],"description":"add foo()"}]}\n```',
        implement: async (_f, chunk, env) => {
          await fs.writeFile(path.join(env.dir, 'a.ts'), 'broken');
          return { touchedFiles: chunk.files, attemptedChange: 'wrote' };
        },
        replan: async () =>
          'Replan:\n```chunk-plan\n{"chunks":[{"id":"F-X-1","files":["a.ts"],"description":"add foo()"}]}\n```',
        escalate: async (_f, _id, _files, _err, role) => {
          receivedRole = role;
          return false;
        },
      },
    });

    assert.equal(receivedRole, 'architect');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
