/**
 * Scratch environment for the worker chunk loop's L1 typecheck gate.
 *
 * The chunk loop wants to run the project's typecheck on the worker's
 * current edits BEFORE committing them, but in a tree that doesn't see
 * other concurrent workers' WIP edits (they'd contaminate the typecheck
 * signal). The cleanest cross-platform answer is a transient git
 * worktree at integration HEAD plus the worker's pending edits applied
 * on top, with the heavy gitignore'd cache directories (`node_modules`,
 * `.next`, `.turbo`, etc.) shared back to the main repo via symlinks.
 *
 * This module is the primitive: setup creates the worktree, applies the
 * edits for the locked files, returns the dir. teardown removes the
 * worktree. Caller runs whatever check it wants in the dir between.
 *
 * Design constraints:
 *   - Cross-platform (Linux/macOS/Windows native via junctions).
 *   - No FS-specific dependencies (reflink, btrfs, overlayfs).
 *   - Cleanup is self-healing: `git worktree prune` in setup
 *     reclaims orphans from previous crashes.
 *   - Parallelism: many workers can have scratch envs simultaneously.
 *
 * The cost-shape: setup is ~60 ms (git worktree add + a handful of
 * symlinks), teardown is ~50 ms. Test execution itself is whatever
 * `tsc`/`vitest`/etc. would have taken in the main repo, since the
 * cache symlinks share the warm caches.
 */

import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

/** Exported so listChangedFiles (run-worker-chunk-loop) can exclude the cache
 *  symlinks setup() itself creates — in a repo that doesn't gitignore them they
 *  show as untracked entries (`?? node_modules` — a symlink, NO trailing slash)
 *  and get mistaken for worker edits, poisoning the chunk's files[] (live on
 *  frame 138805161, 2026-06-09: the commit then EISDIR'd against the real
 *  repo's node_modules directory). */
export const CACHE_SYMLINKS = [
  'node_modules',
  '.next',
  '.turbo',
  '.parcel-cache',
  '.vite',
  '.cache',
  'target',     // Rust / Java
  '__pycache__', // Python
  'dist',       // a lot of bundlers
  '.tsbuildinfo', // TS incremental cache
];

export interface ScratchEnv {
  /** Absolute path to the worktree directory. */
  readonly dir: string;
  /** Owner identifier used in diagnostics + cleanup. */
  readonly owner: string;
}

export interface SetupOptions {
  /** Absolute path to the main repo (worktree's source). */
  repoPath: string;
  /** Identifier for diagnostics. Typically `<feature>-<chunk>`. */
  owner: string;
  /**
   * Files in the main repo whose current contents we want copied into
   * the worktree (the worker's WIP edits). Paths are relative to
   * `repoPath`. The worktree starts as a clean checkout of HEAD; we
   * then overwrite these paths with their main-tree versions.
   *
   * If empty, the worktree is just a clean HEAD checkout.
   */
  editedFiles: readonly string[];
  /**
   * Optional override for cache directories to symlink. Defaults to
   * `CACHE_SYMLINKS` exported above.
   */
  cacheDirs?: readonly string[];
}

/**
 * Create a scratch worktree. Does NOT swallow errors — callers should
 * try/finally with `teardown` to make sure the worktree is removed.
 */
export async function setup(opts: SetupOptions): Promise<ScratchEnv> {
  const { repoPath, owner, editedFiles, cacheDirs = CACHE_SYMLINKS } = opts;

  // Reap stale worktrees from previous crashes. Cheap (`git worktree
  // prune` is a few stat calls under .git/worktrees/).
  await runGit(['worktree', 'prune'], repoPath).catch(() => {});

  // Pick a unique scratch path under the OS tmpdir.
  const scratchDir = path.join(
    os.tmpdir(),
    `papercusp-scratch-${sanitize(owner)}-${randomSuffix()}`,
  );

  // git worktree add --detach <dir> HEAD — creates a new working tree
  // pinned to the current HEAD commit, no branch. Hard-links objects
  // so this is fast.
  await runGit(['worktree', 'add', '--detach', scratchDir, 'HEAD'], repoPath);

  // Symlink cache dirs from main into the worktree. Doing this BEFORE
  // applying the WIP edits matters for typecheckers that read
  // node_modules — without the symlink, `tsc` would error on every
  // imported package.
  for (const cache of cacheDirs) {
    const src = path.join(repoPath, cache);
    const dst = path.join(scratchDir, cache);
    if (!existsSync(src)) continue;
    if (existsSync(dst)) continue; // unlikely; checkout shouldn't have it
    await symlinkPortable(src, dst);
  }

  // Copy the worker's current versions of locked files into the
  // worktree. These are the worker's WIP edits, replacing what HEAD
  // had. Files that don't exist in the main tree (e.g. brand-new files
  // the worker is adding) get copied as-is; files that don't exist on
  // disk are skipped (worker may have intended to delete them — caller
  // is responsible for that case).
  for (const rel of editedFiles) {
    const srcAbs = path.join(repoPath, rel);
    const dstAbs = path.join(scratchDir, rel);
    if (!existsSync(srcAbs)) continue; // file deleted in WIP — skip; caller can `git rm`
    await fs.mkdir(path.dirname(dstAbs), { recursive: true });
    await fs.copyFile(srcAbs, dstAbs);
  }

  return { dir: scratchDir, owner };
}

/**
 * Remove the scratch worktree. Idempotent — calling on an already-torn-
 * down env is a no-op. Doesn't throw on cleanup errors (logs them);
 * the orphan reaper in the next `setup` will mop them up.
 */
export async function teardown(
  env: ScratchEnv,
  repoPath: string,
): Promise<void> {
  if (!existsSync(env.dir)) return;
  // `git worktree remove --force <dir>` cleans both .git/worktrees
  // metadata and the on-disk dir. --force handles "uncommitted changes"
  // (which our WIP-applied files definitionally have).
  try {
    await runGit(['worktree', 'remove', '--force', env.dir], repoPath);
  } catch {
    // Fall back: rm -rf. git's metadata orphan will be cleaned by the
    // next setup's `worktree prune`.
    await fs.rm(env.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run a check command inside the scratch dir. Returns exit code +
 * combined stdout/stderr. Spawns the command with `shell: true` so the
 * caller can pass things like `pnpm typecheck` without parsing.
 *
 * Doesn't throw — non-zero exit codes are returned to the caller.
 */
export async function runCheck(
  env: ScratchEnv,
  command: string,
  options: { timeoutMs?: number } = {},
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    // `detached: true` on POSIX puts the child in its own process
    // group so `kill(-pid, ...)` reaches the entire group. Without
    // this, killing a `shell: true` wrapper leaves child commands
    // orphaned and holding stdio fds open — runCheck never resolves.
    // Windows ignores the flag (process groups work differently); a
    // straight child.kill is best-effort there.
    const isPosix = process.platform !== 'win32';
    const child = spawn(command, {
      cwd: env.dir,
      shell: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: isPosix,
    });
    child.stdout.on('data', (b) => {
      output += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      output += b.toString('utf8');
    });
    const killTree = () => {
      if (isPosix && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
    };
    let timer: NodeJS.Timeout | null = null;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, options.timeoutMs);
    }
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : code ?? -1,
        output,
      });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: -1, output: `${output}\n[spawn error] ${err.message}` });
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Cross-platform symlink. On Windows, file symlinks need admin or
 * Developer Mode, but DIRECTORY junctions don't — and our cache dirs
 * are always directories. Use 'junction' on Windows for directories,
 * regular symlink everywhere else.
 */
async function symlinkPortable(src: string, dst: string): Promise<void> {
  if (process.platform === 'win32') {
    // Directory junction works without admin.
    await fs.symlink(src, dst, 'junction');
  } else {
    await fs.symlink(src, dst);
  }
}

/**
 * Run a git command, returning its stdout. Throws on non-zero exit
 * with stderr in the message.
 */
function runGit(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} exit=${code}: ${stderr.trim()}`));
    });
    child.on('error', (err) => reject(err));
  });
}
