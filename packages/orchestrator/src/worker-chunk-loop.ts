/**
 * Worker chunk loop — implements the simultaneous-editing model.
 *
 * Lifecycle for a single feature:
 *
 *   1. Plan all chunks up-front (one LLM call → ChunkPlan).
 *   2. For each chunk in order:
 *      a. acquire(chunk.files)  — atomic, FIFO-fair, deadlock-free
 *      b. Worker LLM implements the chunk in a scratch worktree.
 *      c. If the worker writes outside the declared file set:
 *         - tryExtend on the lock queue (free paths → success)
 *         - on contention: release everything, re-acquire the union,
 *           re-implement (one wasted LLM call, no deadlock).
 *      d. L1 typecheck gate runs in the scratch env. If it fails:
 *         - revert edits, release locks, re-plan THIS chunk only
 *           (LLM bundles more work to make a working state)
 *         - on N strikes: escalate to the debugger role.
 *      e. On pass: copy edits back to the main repo, commit with
 *         chunk[F-X-N]: <description>, release locks.
 *   3. When all chunks succeed, the feature is done.
 *
 * This module is dependency-injected — the LLM side (planning,
 * implementing, replanning) and the typecheck side are passed in. That
 * makes the loop unit-testable without an actual model. The real
 * integration with `invoke.ts` happens in main-loop.ts when this gets
 * wired into NEXT_WORKER dispatch.
 */

import { FileLockQueue, type LockHandle } from './file-lock-queue.js';
import {
  type Chunk,
  type ChunkPlan,
  formatChunkCommitMessage,
  parseChunkPlanBlock,
  type ParseError,
  type ParseResult,
} from './chunk-plan.js';
import { runCheck, setup as setupScratch, teardown as teardownScratch, type ScratchEnv } from './scratch-env.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface ChunkLoopFeature {
  /** Stable feature id, e.g. F-AUTH-001. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Long-form description / acceptance criteria. */
  description: string;
  /** Optional context: prior agent notes, related-file hints, etc. */
  context?: string;
}

export type ChunkLoopOutcome =
  | { kind: 'completed'; chunksCommitted: number }
  | { kind: 'planning_failed'; error: string }
  | { kind: 'escalated'; chunk: Chunk; reason: string; strikes: number }
  | { kind: 'aborted'; reason: string };

/** Result of a single chunk's worker LLM call — what files were touched
 *  and a summary of what was attempted (used in re-plan prompts). */
export interface ChunkImplementResult {
  /** Paths the LLM actually wrote to (relative to repoPath). May be a
   *  superset of chunk.files; the loop handles extension. */
  touchedFiles: readonly string[];
  /** One-paragraph plain-English description of what was attempted.
   *  Fed back to the re-plan prompt on typecheck failure. */
  attemptedChange: string;
}

export interface TypecheckResult {
  ok: boolean;
  /** stderr/stdout of the check, useful for diagnostics + re-plan input. */
  output: string;
}

export interface ChunkLoopDeps {
  /** Repo where worker edits land (and where commits happen). */
  repoPath: string;
  /** Lock queue — usually shared across all workers. */
  lockQueue: FileLockQueue;
  /** Plan all chunks for this feature. Returns the LLM's raw response;
   *  the loop parses it and re-asks if invalid. */
  planChunks: (feature: ChunkLoopFeature) => Promise<string>;
  /** Implement one chunk inside the scratch dir. Worker writes its
   *  edits to env.dir/<file>. Returns what was touched + a summary. */
  implementChunk: (
    feature: ChunkLoopFeature,
    chunk: Chunk,
    env: ScratchEnv,
  ) => Promise<ChunkImplementResult>;
  /** Re-plan a failed chunk. Returns the LLM's raw response (one
   *  replacement chunk in chunk-plan format). */
  replanChunk: (
    feature: ChunkLoopFeature,
    failedChunk: Chunk,
    typecheckError: string,
    attemptedChange: string,
  ) => Promise<string>;
  /** L1 typecheck command (e.g. "pnpm typecheck"). Run inside scratch. */
  typecheckCommand: string;
  /** Optional escalation hook fired after `replanStrikes` fails. */
  onEscalate?: (
    feature: ChunkLoopFeature,
    chunk: Chunk,
    typecheckError: string,
    strikes: number,
  ) => Promise<void> | void;
  /** Commit + release-locks side effect. Default copies edits from
   *  scratch → repo, runs `git add -A && git commit`. Override for
   *  tests. */
  commitChunk?: (
    feature: ChunkLoopFeature,
    chunk: Chunk,
    env: ScratchEnv,
    deps: { repoPath: string },
  ) => Promise<void>;
  /** Optional progress callback — fired on every state transition for
   *  the harness UI (visible/persisted plan). */
  onProgress?: (event: ChunkProgressEvent) => Promise<void> | void;
  /** How many typecheck-rejection retries before escalating. Default 3. */
  replanStrikes?: number;
  /** Logger; defaults to console-noop. */
  log?: (msg: string) => void;
  /** Per-chunk typecheck timeout ms. Default 5 minutes. */
  typecheckTimeoutMs?: number;
}

export type ChunkProgressEvent =
  | { kind: 'plan_ready'; plan: ChunkPlan }
  | { kind: 'chunk_start'; chunk: Chunk; index: number; total: number }
  | { kind: 'chunk_committed'; chunk: Chunk; index: number; total: number }
  | { kind: 'chunk_replan'; chunk: Chunk; strikes: number; reason: string }
  | { kind: 'chunk_escalated'; chunk: Chunk; strikes: number };

// ─── The loop ────────────────────────────────────────────────────────

export async function runChunkLoop(
  feature: ChunkLoopFeature,
  deps: ChunkLoopDeps,
): Promise<ChunkLoopOutcome> {
  const log = deps.log ?? (() => {});
  const replanStrikes = deps.replanStrikes ?? 3;
  const typecheckTimeoutMs = deps.typecheckTimeoutMs ?? 5 * 60_000;
  const commitChunk = deps.commitChunk ?? defaultCommitChunk;

  // ─── 1. Plan ────────────────────────────────────────────────────
  let planRaw: string;
  try {
    planRaw = await deps.planChunks(feature);
  } catch (err) {
    return { kind: 'planning_failed', error: `planChunks threw: ${(err as Error).message}` };
  }
  const planParse = parseChunkPlanBlock(planRaw, feature.id);
  if (!planParse.ok) {
    return { kind: 'planning_failed', error: planParse.message };
  }
  const plan: ChunkPlan = planParse.value;
  log(`chunk-loop: plan has ${plan.chunks.length} chunks for ${feature.id}`);
  await emit(deps, { kind: 'plan_ready', plan });

  // ─── 2. Iterate chunks ──────────────────────────────────────────
  let committed = 0;
  for (let i = 0; i < plan.chunks.length; i++) {
    let chunk = plan.chunks[i];
    await emit(deps, {
      kind: 'chunk_start',
      chunk,
      index: i,
      total: plan.chunks.length,
    });

    let strikes = 0;
    while (true) {
      // Acquire locks. May block on the queue.
      const handle = await deps.lockQueue.acquire(`${feature.id}:${chunk.id}`, chunk.files);
      let env: ScratchEnv | null = null;
      try {
        env = await setupScratch({
          repoPath: deps.repoPath,
          owner: chunk.id,
          editedFiles: chunk.files,
        });
      } catch (err) {
        deps.lockQueue.release(handle);
        return { kind: 'aborted', reason: `scratch setup: ${(err as Error).message}` };
      }

      let outcome: 'committed' | 'replan' | 'escalate' | 'aborted' = 'replan';
      let typecheckOutput = '';
      let attemptedChange = '';

      try {
        const impl = await deps.implementChunk(feature, chunk, env);
        attemptedChange = impl.attemptedChange;

        // Lock extension: did the worker touch files outside its
        // declared set? If so, try to extend; on contention, abort
        // this attempt and re-do after re-acquiring the union.
        const extra = impl.touchedFiles.filter((f) => !chunk.files.includes(f));
        if (extra.length > 0) {
          const extended = deps.lockQueue.tryExtend(handle, extra);
          if (!extended) {
            log(`chunk-loop: lock-extension contended for ${chunk.id}; release+reacquire`);
            // Release everything + drop env. Outer while continues with
            // the chunk's `files` field updated to include the extras
            // so the next acquire takes them as a sorted union.
            chunk = { ...chunk, files: [...chunk.files, ...extra] };
            outcome = 'replan'; // not strictly a replan — same chunk, just re-acquire
            // Don't increment strikes — this isn't a typecheck failure.
            continue;
          }
          // Extension succeeded: chunk.files must now reflect the
          // expanded set so the commit step copies + stages every
          // touched path.
          chunk = { ...chunk, files: [...chunk.files, ...extra] };
        }

        // L1 typecheck gate.
        const tc = await runCheck(env, deps.typecheckCommand, { timeoutMs: typecheckTimeoutMs });
        typecheckOutput = tc.output;
        if (tc.exitCode === 0) {
          await commitChunk(feature, chunk, env, { repoPath: deps.repoPath });
          outcome = 'committed';
        } else {
          strikes++;
          log(`chunk-loop: ${chunk.id} typecheck failed (strike ${strikes}/${replanStrikes})`);
          if (strikes >= replanStrikes) {
            outcome = 'escalate';
          } else {
            outcome = 'replan';
          }
        }
      } catch (err) {
        log(`chunk-loop: ${chunk.id} threw during implement: ${(err as Error).message}`);
        // Treat as a soft failure (count toward strikes). This catches
        // LLM API errors, file-write errors, etc.
        strikes++;
        typecheckOutput = `[implement error] ${(err as Error).message}`;
        attemptedChange = attemptedChange || `(no summary — implement threw)`;
        outcome = strikes >= replanStrikes ? 'escalate' : 'replan';
      } finally {
        if (env) await teardownScratch(env, deps.repoPath);
        deps.lockQueue.release(handle);
      }

      if (outcome === 'committed') {
        await emit(deps, {
          kind: 'chunk_committed',
          chunk,
          index: i,
          total: plan.chunks.length,
        });
        committed++;
        break;
      }

      if (outcome === 'escalate') {
        await emit(deps, { kind: 'chunk_escalated', chunk, strikes });
        if (deps.onEscalate) {
          try {
            await deps.onEscalate(feature, chunk, typecheckOutput, strikes);
          } catch (err) {
            log(`chunk-loop: onEscalate threw: ${(err as Error).message}`);
          }
        }
        return {
          kind: 'escalated',
          chunk,
          reason: typecheckOutput,
          strikes,
        };
      }

      // outcome === 'replan'
      await emit(deps, {
        kind: 'chunk_replan',
        chunk,
        strikes,
        reason: typecheckOutput.slice(0, 500),
      });
      if (typecheckOutput) {
        // Real typecheck failure — ask the LLM to bundle more work in.
        let replanRaw: string;
        try {
          replanRaw = await deps.replanChunk(feature, chunk, typecheckOutput, attemptedChange);
        } catch (err) {
          return {
            kind: 'aborted',
            reason: `replanChunk threw: ${(err as Error).message}`,
          };
        }
        const replanParse: ParseResult<ChunkPlan> | ParseError = parseChunkPlanBlock(replanRaw, feature.id);
        if (!replanParse.ok) {
          // Replan response unparseable — count as a strike.
          if (strikes >= replanStrikes) {
            await emit(deps, { kind: 'chunk_escalated', chunk, strikes });
            return {
              kind: 'escalated',
              chunk,
              reason: `replan unparseable: ${replanParse.message}`,
              strikes,
            };
          }
          continue;
        }
        const replanned = replanParse.value.chunks.find((c) => c.id === chunk.id);
        if (!replanned) {
          return {
            kind: 'aborted',
            reason: `replan returned no chunk with id ${chunk.id}`,
          };
        }
        chunk = replanned;
      }
      // If outcome === 'replan' but typecheckOutput is empty, this was
      // the lock-extension contention path — chunk.files was already
      // updated above. Loop body continues.
    }
  }

  return { kind: 'completed', chunksCommitted: committed };
}

// ─── Default commit implementation ──────────────────────────────────

// Process-local mutex for git operations on the main repo. Concurrent
// `git add` / `git commit` from sibling workers race on `.git/index`
// — even though file-level locks prevent them from editing the same
// path, the index itself is a shared resource. Serializing commits is
// the simplest correct answer; commits are fast (<100 ms each) so this
// adds little wall-clock cost compared to the LLM-bound work.
let gitIndexMutex: Promise<void> = Promise.resolve();
async function withGitIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = gitIndexMutex;
  gitIndexMutex = next;
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function defaultCommitChunk(
  feature: ChunkLoopFeature,
  chunk: Chunk,
  env: ScratchEnv,
  deps: { repoPath: string },
): Promise<void> {
  // Copy each edited file from the scratch worktree back into the main
  // repo, then `git add -A && git commit -m chunk[...]: ...`.
  // This module deliberately doesn't shell out to git directly — leave
  // the choice of branching strategy to the caller via override. The
  // default assumes the integration branch model: workers commit
  // straight to the current branch in the main repo.
  void feature;
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');

  // Stage paths individually to handle adds, modifications, and
  // deletes correctly, and to avoid the `git add -A path` "did not
  // match any files" error when a chunk's declared file was deleted.
  // The whole copy + add + commit sequence runs under withGitIndexLock
  // so concurrent workers can't race on `.git/index`.
  await withGitIndexLock(async () => {
    for (const rel of chunk.files) {
      const srcAbs = path.join(env.dir, rel);
      const dstAbs = path.join(deps.repoPath, rel);
      const exists = await fs
        .stat(srcAbs)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        // Worker deleted the file. Remove from working tree + index.
        await fs.rm(dstAbs, { force: true });
        await runGit(['rm', '-f', '--ignore-unmatch', '--', rel], deps.repoPath);
        continue;
      }
      await fs.mkdir(path.dirname(dstAbs), { recursive: true });
      await fs.copyFile(srcAbs, dstAbs);
      await runGit(['add', '--', rel], deps.repoPath);
    }
    await runGit(['commit', '-q', '-m', formatChunkCommitMessage(chunk)], deps.repoPath);
  });

  function runGit(args: readonly string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const c = spawn('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      c.stderr.on('data', (b) => (err += b.toString('utf8')));
      c.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`git ${args.join(' ')} exit=${code}: ${err.trim()}`)),
      );
      c.on('error', (e) => reject(e));
    });
  }
}

async function emit(deps: ChunkLoopDeps, event: ChunkProgressEvent): Promise<void> {
  if (!deps.onProgress) return;
  try {
    await deps.onProgress(event);
  } catch {
    /* swallow — progress is observability, not control flow */
  }
}
