import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { setup, teardown, runCheck, splitCheckCommandArgv } from './scratch-env.js';

function exec(cmd: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const c = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', (b) => (out += b.toString()));
    c.stderr.on('data', (b) => (err += b.toString()));
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exit=${code}: ${err}`))));
  });
}

async function makeRepo(): Promise<string> {
  const dir = path.join(os.tmpdir(), `papercusp-scratch-test-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  await exec('git', ['init', '-q'], dir);
  await exec('git', ['config', 'user.email', 'test@papercusp.test'], dir);
  await exec('git', ['config', 'user.name', 'Test'], dir);
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
  await exec('git', ['add', '.'], dir);
  await exec('git', ['commit', '-q', '-m', 'initial'], dir);
  return dir;
}

async function rimraf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

test('setup creates a worktree at HEAD', async () => {
  const repo = await makeRepo();
  try {
    const env = await setup({ repoPath: repo, owner: 'test1', editedFiles: [] });
    assert.ok(existsSync(env.dir), 'worktree dir should exist');
    assert.ok(existsSync(path.join(env.dir, 'a.ts')), 'a.ts copied via git checkout');
    assert.ok(existsSync(path.join(env.dir, 'src', 'b.ts')), 'src/b.ts present');
    await teardown(env, repo);
    assert.ok(!existsSync(env.dir), 'teardown removed the dir');
  } finally {
    await rimraf(repo);
  }
});

test('setup applies WIP edits over HEAD', async () => {
  const repo = await makeRepo();
  try {
    // Modify a.ts in main repo (uncommitted).
    await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 99;\n');

    const env = await setup({
      repoPath: repo,
      owner: 'test2',
      editedFiles: ['a.ts'],
    });
    const got = await fs.readFile(path.join(env.dir, 'a.ts'), 'utf8');
    assert.equal(got, 'export const a = 99;\n', 'WIP version copied');

    // src/b.ts wasn't in editedFiles, so it should be HEAD's version.
    const bGot = await fs.readFile(path.join(env.dir, 'src', 'b.ts'), 'utf8');
    assert.equal(bGot, 'export const b = 2;\n', 'src/b.ts is HEAD version');

    await teardown(env, repo);
  } finally {
    await rimraf(repo);
  }
});

test('setup creates a brand-new file (not in HEAD) from WIP', async () => {
  const repo = await makeRepo();
  try {
    // Add a brand-new file in main repo (uncommitted, not tracked).
    await fs.writeFile(path.join(repo, 'c.ts'), 'export const c = 3;\n');

    const env = await setup({
      repoPath: repo,
      owner: 'test3',
      editedFiles: ['c.ts'],
    });
    const got = await fs.readFile(path.join(env.dir, 'c.ts'), 'utf8');
    assert.equal(got, 'export const c = 3;\n', 'untracked WIP file copied');
    await teardown(env, repo);
  } finally {
    await rimraf(repo);
  }
});

test('setup creates parent dirs for nested edited files', async () => {
  const repo = await makeRepo();
  try {
    // Create a deeply nested untracked file.
    await fs.mkdir(path.join(repo, 'src', 'foo', 'bar'), { recursive: true });
    await fs.writeFile(path.join(repo, 'src', 'foo', 'bar', 'baz.ts'), 'export const baz = 4;\n');

    const env = await setup({
      repoPath: repo,
      owner: 'test4',
      editedFiles: ['src/foo/bar/baz.ts'],
    });
    assert.ok(existsSync(path.join(env.dir, 'src', 'foo', 'bar', 'baz.ts')));
    await teardown(env, repo);
  } finally {
    await rimraf(repo);
  }
});

test('setup symlinks cache directories that exist in the main repo', async () => {
  const repo = await makeRepo();
  try {
    // Simulate a node_modules dir.
    await fs.mkdir(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(repo, 'node_modules', 'pkg', 'index.js'), '');

    const env = await setup({
      repoPath: repo,
      owner: 'test5',
      editedFiles: [],
    });
    const linkPath = path.join(env.dir, 'node_modules');
    const stat = await fs.lstat(linkPath);
    // Either symlink (POSIX) or junction (Windows reports as symlink for lstat too).
    assert.ok(stat.isSymbolicLink() || stat.isDirectory(), 'node_modules should be a symlink/junction');
    // Reading through the link should see the source contents.
    assert.ok(existsSync(path.join(linkPath, 'pkg', 'index.js')));
    await teardown(env, repo);
  } finally {
    await rimraf(repo);
  }
});

test('setup skips cache dirs that do not exist in the main repo', async () => {
  const repo = await makeRepo();
  try {
    const env = await setup({
      repoPath: repo,
      owner: 'test6',
      editedFiles: [],
    });
    // No node_modules in source — should not be created in the worktree.
    assert.ok(!existsSync(path.join(env.dir, 'node_modules')));
    await teardown(env, repo);
  } finally {
    await rimraf(repo);
  }
});

test('teardown is idempotent', async () => {
  const repo = await makeRepo();
  try {
    const env = await setup({ repoPath: repo, owner: 'test7', editedFiles: [] });
    await teardown(env, repo);
    await teardown(env, repo); // must not throw
    assert.ok(!existsSync(env.dir));
  } finally {
    await rimraf(repo);
  }
});

test('runCheck returns 0 on success and captures output', async () => {
  const repo = await makeRepo();
  try {
    const env = await setup({ repoPath: repo, owner: 'test8', editedFiles: [] });
    const r = await runCheck(env, 'echo hello');
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /hello/);
    await teardown(env, repo);
  } finally {
    await rimraf(repo);
  }
});

test('runCheck returns nonzero on failure', async () => {
  const repo = await makeRepo();
  try {
    const env = await setup({ repoPath: repo, owner: 'test9', editedFiles: [] });
    // Commands run WITHOUT a shell (audit P-030), so use a real binary
    // exiting nonzero — `exit` is a shell builtin that no longer applies.
    await fs.writeFile(path.join(env.dir, 'exit7.cjs'), 'process.exit(7);\n');
    const r = await runCheck(env, 'node exit7.cjs');
    assert.equal(r.exitCode, 7);
    await teardown(env, repo);
  } finally {
    await rimraf(repo);
  }
});

test('runCheck rejects shell metacharacters as exit 126 (unrunnable lane, audit P-030)', async () => {
  const repo = await makeRepo();
  try {
    const env = await setup({ repoPath: repo, owner: 'test9b', editedFiles: [] });
    const r = await runCheck(env, 'echo hi && echo bye');
    assert.equal(r.exitCode, 126);
    assert.match(r.output, /shell metacharacters/);
    await teardown(env, repo);
  } finally {
    await rimraf(repo);
  }
});

test('runCheck maps a missing binary (ENOENT) to exit 127 so the gate fails OPEN', async () => {
  // With shell:true a missing command exited 127 from the shell; without a
  // shell it surfaces as a spawn ENOENT error. isCheckUnrunnable(127) is the
  // chunk loop's fail-open lane (EI from Hetzner frame 138790170) — the
  // mapping must hold or "pnpm: command not found" burns the strike budget.
  const repo = await makeRepo();
  try {
    const env = await setup({ repoPath: repo, owner: 'test9c', editedFiles: [] });
    const r = await runCheck(env, 'definitely-not-a-command-p030 --version');
    assert.equal(r.exitCode, 127);
    assert.match(r.output, /spawn error/);
    await teardown(env, repo);
  } finally {
    await rimraf(repo);
  }
});

test('splitCheckCommandArgv — plain argv splits, shell syntax rejects', () => {
  assert.deepEqual(splitCheckCommandArgv('pnpm typecheck'), ['pnpm', 'typecheck']);
  assert.deepEqual(splitCheckCommandArgv('  tsc   --noEmit '), ['tsc', '--noEmit']);
  assert.equal(splitCheckCommandArgv(''), null);
  for (const bad of ['a && b', 'a | b', 'a; b', 'a > out', 'echo $HOME', 'node -e "x()"', 'a `b`']) {
    assert.equal(splitCheckCommandArgv(bad), null, `should reject: ${bad}`);
  }
});

test('runCheck honors timeoutMs', async () => {
  const repo = await makeRepo();
  try {
    const env = await setup({ repoPath: repo, owner: 'test10', editedFiles: [] });
    const r = await runCheck(env, 'sleep 5', { timeoutMs: 200 });
    // SIGKILL'd → we report 124 (the timeout convention).
    assert.equal(r.exitCode, 124);
    await teardown(env, repo);
  } finally {
    await rimraf(repo);
  }
});

test('multiple parallel scratch envs do not collide', async () => {
  const repo = await makeRepo();
  try {
    const envs = await Promise.all([
      setup({ repoPath: repo, owner: 'pa', editedFiles: [] }),
      setup({ repoPath: repo, owner: 'pb', editedFiles: [] }),
      setup({ repoPath: repo, owner: 'pc', editedFiles: [] }),
    ]);
    const dirs = new Set(envs.map((e) => e.dir));
    assert.equal(dirs.size, 3, 'each env has its own dir');
    for (const e of envs) {
      assert.ok(existsSync(path.join(e.dir, 'a.ts')));
    }
    await Promise.all(envs.map((e) => teardown(e, repo)));
  } finally {
    await rimraf(repo);
  }
});

test('worktree prune in setup reaps stale orphans', async () => {
  const repo = await makeRepo();
  try {
    // Create a worktree, then nuke its on-disk dir to simulate a crash.
    const env = await setup({ repoPath: repo, owner: 'crashed', editedFiles: [] });
    await fs.rm(env.dir, { recursive: true, force: true });
    // Verify the orphan is registered by git.
    const before = await new Promise<string>((res) => {
      let out = '';
      const c = spawn('git', ['worktree', 'list', '--porcelain'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] });
      c.stdout.on('data', (b) => (out += b.toString()));
      c.on('close', () => res(out));
    });
    assert.ok(before.includes(env.dir), 'orphan should be in worktree list');

    // Next setup runs `worktree prune` automatically.
    const env2 = await setup({ repoPath: repo, owner: 'fresh', editedFiles: [] });
    const after = await new Promise<string>((res) => {
      let out = '';
      const c = spawn('git', ['worktree', 'list', '--porcelain'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] });
      c.stdout.on('data', (b) => (out += b.toString()));
      c.on('close', () => res(out));
    });
    assert.ok(!after.includes(env.dir), 'orphan was pruned by setup');
    await teardown(env2, repo);
  } finally {
    await rimraf(repo);
  }
});
