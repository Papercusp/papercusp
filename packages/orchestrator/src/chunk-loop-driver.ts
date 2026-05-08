/**
 * Glue layer that ties the worker chunk loop to the rest of the
 * orchestrator: the harness config (typecheck command, replan strikes,
 * escalation role), the postgres-backed chunk plan persistence, and
 * the LLM invocation for plan/implement/replan/escalate calls.
 *
 * Imported by main-loop.ts when NEXT_WORKER dispatches into the
 * chunk loop instead of the legacy single-shot worker. Not imported
 * by the loop itself — that stays dependency-injected so tests can
 * exercise it without an LLM or a database.
 */

import type { OrchestratorPg } from './invoke.js';
import type { HarnessConfig } from './config.js';
import type { FileLockQueue } from './file-lock-queue.js';
import {
  type ChunkLoopDeps,
  type ChunkLoopFeature,
  type ChunkProgressEvent,
  type ChunkLoopOutcome,
  runChunkLoop,
} from './worker-chunk-loop.js';
import {
  workingStateCheckCommand,
  replanStrikes as replanStrikesFromCfg,
  escalateToRole as escalateToRoleFromCfg,
} from './lanes.js';
import {
  type ChunkPlanPgCtx,
  persistPlan,
  readPlan,
  setChunkStatus,
  updateChunkPlan,
} from './chunk-plan-pg.js';
import { parseChunkPlanBlock } from './chunk-plan.js';

export interface DriverInput {
  feature: ChunkLoopFeature;
  cfg: HarnessConfig;
  /** Lock queue shared across all workers in this orchestrator. */
  lockQueue: FileLockQueue;
  /** Repo path workers commit to. */
  repoPath: string;
  /** PG client + scoping for plan persistence. May be undefined when
   *  the orchestrator runs without PG (legacy fs mode); persistence
   *  is then a no-op. */
  pg?: OrchestratorPg;
  workspaceId?: string;
  harnessSlug?: string;
  /** LLM bridge: each callback runs the worker / debugger role with
   *  the appropriate prompt and returns the raw text. main-loop.ts
   *  wires these to `invoke()`. */
  llm: {
    plan: (feature: ChunkLoopFeature) => Promise<string>;
    implement: ChunkLoopDeps['implementChunk'];
    replan: (
      feature: ChunkLoopFeature,
      failedChunkId: string,
      failedChunkFiles: readonly string[],
      failedChunkDescription: string,
      typecheckError: string,
      attemptedChange: string,
    ) => Promise<string>;
    /** Called on escalation. Receives the chunk + reason; may run a
     *  debugger / scoper / architect. Return `false` to mark the
     *  feature `failing` (user-visible); return `true` if the role
     *  resolved it and the loop should continue (rare). */
    escalate: (
      feature: ChunkLoopFeature,
      failedChunkId: string,
      failedChunkFiles: readonly string[],
      typecheckError: string,
      role: string,
    ) => Promise<boolean>;
  };
  log?: (msg: string) => void;
}

export async function driveChunkLoop(input: DriverInput): Promise<ChunkLoopOutcome> {
  const log = input.log ?? (() => {});
  const pgCtx: ChunkPlanPgCtx | null =
    input.pg && input.workspaceId && input.harnessSlug
      ? { pg: input.pg, workspaceId: input.workspaceId, harnessSlug: input.harnessSlug }
      : null;

  // Crash-recovery: if there's an existing plan for this feature in
  // PG, resume from where we left off — skip planning, skip already-
  // committed chunks. This kicks in when the orchestrator restarts
  // mid-feature.
  let resumeFromPlan: ChunkLoopDeps['resumeFromPlan'];
  if (pgCtx) {
    try {
      const existing = await readPlan(pgCtx, input.feature.id);
      if (existing.length > 0) {
        const committed = existing
          .filter((r) => r.status === 'committed')
          .map((r) => r.chunkId);
        // Don't resume into a plan that's been fully committed —
        // the feature is done; let the orchestrator process its
        // post-state normally. Same for fully-escalated.
        const allDone = existing.every(
          (r) => r.status === 'committed' || r.status === 'escalated',
        );
        if (!allDone) {
          resumeFromPlan = {
            plan: {
              featureId: input.feature.id,
              chunks: existing.map((r) => ({
                id: r.chunkId,
                files: r.files,
                description: r.description,
              })),
            },
            committedChunkIds: committed,
          };
          log(
            `chunk-loop-driver: resuming ${input.feature.id} from PG — ${existing.length} chunks, ${committed.length} already committed`,
          );
        }
      }
    } catch (err) {
      log(`chunk-loop-driver: readPlan failed: ${(err as Error).message}`);
      // Fall through to fresh planning.
    }
  }

  const deps: ChunkLoopDeps = {
    repoPath: input.repoPath,
    lockQueue: input.lockQueue,
    typecheckCommand: workingStateCheckCommand(input.cfg),
    replanStrikes: replanStrikesFromCfg(input.cfg),
    resumeFromPlan,
    log,

    planChunks: input.llm.plan,
    implementChunk: input.llm.implement,
    replanChunk: async (feature, failedChunk, typecheckError, attemptedChange) => {
      return input.llm.replan(
        feature,
        failedChunk.id,
        failedChunk.files,
        failedChunk.description,
        typecheckError,
        attemptedChange,
      );
    },

    onEscalate: async (feature, chunk, reason, strikes) => {
      const role = escalateToRoleFromCfg(input.cfg);
      log(`chunk-loop: escalating ${chunk.id} to role=${role} after ${strikes} strikes`);
      const handled = await input.llm.escalate(
        feature,
        chunk.id,
        chunk.files,
        reason,
        role,
      );
      if (pgCtx) {
        await setChunkStatus(pgCtx, feature.id, chunk.id, 'escalated', {
          strikes,
          lastError: reason.slice(0, 4000),
        }).catch(() => {});
      }
      // The loop returns `escalated` regardless of the boolean — the
      // role's actual fix lands as a separate orchestrator turn. The
      // boolean is reserved for a future "in-place" escalation path
      // (e.g. debugger writes a fix that the worker then commits in a
      // recovery chunk).
      void handled;
    },

    onProgress: async (event: ChunkProgressEvent) => {
      if (!pgCtx) return;
      try {
        switch (event.kind) {
          case 'plan_ready':
            await persistPlan(pgCtx, event.plan);
            break;
          case 'chunk_start':
            await setChunkStatus(pgCtx, input.feature.id, event.chunk.id, 'in_progress');
            break;
          case 'chunk_committed':
            await setChunkStatus(pgCtx, input.feature.id, event.chunk.id, 'committed');
            break;
          case 'chunk_replan':
            // The chunk's content/files may have changed; rewrite and
            // reset to 'pending'.
            await updateChunkPlan(pgCtx, input.feature.id, event.chunk);
            await setChunkStatus(pgCtx, input.feature.id, event.chunk.id, 'failing', {
              strikes: event.strikes,
              lastError: event.reason,
            });
            break;
          case 'chunk_escalated':
            // Final state set by onEscalate above (gives us the full
            // typecheck output as lastError).
            break;
        }
      } catch (err) {
        log(`chunk-loop persistence: ${(err as Error).message}`);
      }
    },
  };

  return runChunkLoop(input.feature, deps);
}

// Re-exports for convenience — main-loop.ts only imports from this module.
export { parseChunkPlanBlock };
export type { ChunkLoopFeature, ChunkLoopOutcome, ChunkProgressEvent };
