/**
 * Main orchestrator loop. Mirrors bash run.sh's `while [ $iteration -lt
 * $MAX_ITERATIONS ]` block. Drives the harness one iteration at a time:
 *
 *   1. Invoke the primary advancing role (orchestrator / coordinator / etc.)
 *   2. Parse the decision verb
 *   3. Dispatch to the matching handler — this is where most of the bash
 *      lives (worker / validator / curator / documenter pipelines, branch
 *      isolation, competition mode, smoke-test gate on DONE, etc.)
 *   4. Snapshot state, prune logs, check cost cap
 *   5. Sleep briefly, repeat
 *
 * As of Stage 5a, every decision branch from run.sh is handled here —
 * including parallel-lane and competition workers. The TS loop is a full
 * replacement for the bash version when PAPERCUSP_USE_TS_ORCHESTRATOR=1.
 */
import { spawnSync } from 'node:child_process';
import { configGet, readConfig } from './config';
import { parseDecision, parseDecisions } from './decision-parse';
import { invoke } from './invoke';
import { featureAttempts, readFeatures, setFeatureStatus, stateCtx } from './state';
import {
  branchIsoPostValidator,
  branchIsoPostWorker,
  branchIsoPreValidator,
  branchIsoPreWorker,
  worktreeEnabled,
  worktreePath,
} from './branch-iso';
import { runHook } from './hooks';
import { processActionsBlock } from './actions-block';
import { evaluateCostCap } from './cost-cap';
import { pruneLogs } from './prune-logs';
import { snapshotState } from './snapshot-state';
import { postArchiveEvent, postCuratorOutputs, postTestSnapshot } from './bus-posts';
import { runPreLoop } from './pre-loop';
import { checkpointGate } from './checkpoints';
import { firePluginHook } from './plugin-hooks';
import {
  competitionManifestPath,
  createLanePool,
  isAdaptiveMode,
  isCompetitionMode,
  isLaneMode,
  workerCountTiers,
  maxFeaturesInFlight as maxFeaturesInFlightCfg,
  parallelMaxWorkers,
  parallelMode,
  parallelWorkersPerFeature,
  parseCompetitionVerdict,
  readCompetitionManifest,
  useChunkLoop,
  writeCompetitionManifest,
  type WorkerCountTiers,
} from './lanes';
import type { LanePool } from './lanes';
import { FileLockQueue } from './file-lock-queue';
import { driveChunkLoop } from './chunk-loop-driver';
import {
  type ChunkImplementResult,
  type ChunkLoopFeature,
} from './worker-chunk-loop';
import {
  formatChunkCommitMessage,
  planChunksUpfrontPrompt,
  replanChunkPrompt,
} from './chunk-plan';
import { spawnSync as spawnSyncForGit } from 'node:child_process';
import { git } from './git';
import { branchIsoBase, worktreePath } from './branch-iso';
import type { InvokeContext } from './invoke';
import type { Logger } from './log';
import {
  runSynthesizer,
  singleLaneManifest,
  synthesizeSingle,
  useSynthesizer,
} from './synthesizer';
import type { ParsedDecision } from './decision-parse';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Resolve the harness slug for telemetry calls.
 *
 * Resolution order:
 *   1. HARNESS_SLUG / PAPERCUSP_HARNESS_SLUG env (caller-set; fastest).
 *   2. Operator registry reverse lookup (canonical — handles cases where
 *      the slug differs from basename(projectDir), e.g. project at
 *      /home/foo/sheets-clone registered as slug "sheets").
 *   3. basename(projectDir) — matches the registry's default derivation
 *      when no explicit slug was set.
 *
 * Memoized per projectDir so we only hit the operator once per run.
 */
const _slugCache = new Map<string, string>();
function harnessSlug(ctx: InvokeContext): string {
  const fromEnv = process.env.HARNESS_SLUG ?? process.env.PAPERCUSP_HARNESS_SLUG;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const cached = _slugCache.get(ctx.projectDir);
  if (cached) return cached;
  const fromRegistry = lookupSlugFromRegistry(ctx.projectDir);
  if (fromRegistry) {
    _slugCache.set(ctx.projectDir, fromRegistry);
    return fromRegistry;
  }
  const fromBasename = ctx.projectDir.split(/[\\/]/).filter(Boolean).pop() ?? 'unknown';
  _slugCache.set(ctx.projectDir, fromBasename);
  return fromBasename;
}

/**
 * Synchronous reverse lookup against the operator's harness registry.
 * Returns null on any failure (operator down, network hiccup, parse
 * error). Best-effort — caller falls back to basename.
 */
function lookupSlugFromRegistry(projectDir: string): string | null {
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  try {
    // Sync curl. Same pattern as role-prompt-from-slug.ts:lookupProjectDir.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('curl', [
      '-sf', '--max-time', '3', `${operatorBase}/api/harness/projects`,
    ], { encoding: 'utf8', timeout: 4000 });
    const data = JSON.parse(out) as { projects?: Array<{ slug?: string; path?: string }> };
    const norm = projectDir.replace(/\/+$/, '');
    const hit = data.projects?.find((p) => (p.path ?? '').replace(/\/+$/, '') === norm)?.slug;
    return hit && hit.length > 0 ? hit : null;
  } catch {
    return null;
  }
}

/** Test-only — drop the slug cache so a stale lookup doesn't leak across tests. */
export function _resetHarnessSlugCacheForTests(): void {
  _slugCache.clear();
}

/**
 * Map of feature id → telemetry row id for in-flight adaptive decisions.
 * Used by handleNextValidator to attach the outcome (pass/fail) to the
 * decision row recorded at NEXT_WORKER time. Cleared after outcome attaches.
 */
const _adaptiveTelemetryByFeature = new Map<string, { id: number; startedAt: number }>();

/**
 * Record one adaptive-mode allocation decision. Best-effort; logs and
 * continues on any error. Returns the row id (so tests can verify) or null.
 */
async function recordAdaptiveDecision(
  ctx: InvokeContext,
  logger: Logger,
  args: {
    featureId: string;
    requestedN: number;
    actualN: number;
    tierLabel: string | null;
    availableAtDecision: number;
    maxSlots: number;
  },
): Promise<number | null> {
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const slug = harnessSlug(ctx);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(
      `${operatorBase}/api/harness/${slug}/orchestrator/adaptive-telemetry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
        signal: ctrl.signal,
      },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: number };
    if (typeof data.id === 'number') {
      _adaptiveTelemetryByFeature.set(args.featureId, { id: data.id, startedAt: Date.now() });
      return data.id;
    }
  } catch (err) {
    logger.log(`  telemetry: insert failed (${(err as Error).message}); continuing`);
  }
  return null;
}

/** Patch the matching pending telemetry row with an outcome. */
async function attachAdaptiveOutcome(
  ctx: InvokeContext,
  logger: Logger,
  featureId: string,
  outcome: 'pass' | 'fail' | 'cancelled',
): Promise<void> {
  const pending = _adaptiveTelemetryByFeature.get(featureId);
  if (!pending) return;
  _adaptiveTelemetryByFeature.delete(featureId);
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const slug = harnessSlug(ctx);
  const durationMs = Date.now() - pending.startedAt;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    await fetch(
      `${operatorBase}/api/harness/${slug}/orchestrator/adaptive-telemetry/${pending.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome, durationMs }),
        signal: ctrl.signal,
      },
    );
    clearTimeout(timer);
  } catch (err) {
    logger.log(`  telemetry: outcome patch failed (${(err as Error).message}); continuing`);
  }
}

/** Test-only: clear the adaptive caches. */
export function _resetAdaptiveCachesForTests(): void {
  _adaptiveTelemetryByFeature.clear();
}

/** Fire a Papercusp plugin lifecycle hook with InvokeContext defaults. */
function fireLifecycleHook(ctx: InvokeContext, hookName: string, log: (m: string) => void): void {
  firePluginHook({
    hookName,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    pluginsLogPath: join(ctx.logDir, 'plugins.log'),
    log,
  });
}

export interface MainLoopExit {
  /** Process exit code matching bash semantics. */
  exitCode: number;
  /** Why the loop stopped (for tests + observability). */
  reason:
    | 'done'
    | 'escalate'
    | 'idle'
    | 'checkpoint'
    | 'max-iterations'
    | 'unparsable-decision'
    | 'cost-cap'
    | 'plan-rejected'
    | 'auto-checkpoint'
    | 'scoper-failed'
    | 'pending-checkpoint';
  /** Number of iterations executed (1-based). */
  iterations: number;
}

export interface MainLoopOptions {
  ctx: InvokeContext;
  logger: Logger;
  maxIterations: number;
  /** Sleep between iterations (ms). 0 disables for tests. */
  iterationSleepMs: number;
  /** Override for `Date.now()` and `setTimeout` to make tests deterministic. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Skip pre-loop (scoper / plan-reviewer / ensure-docs / etc.) for tests
   *  that want to drive only the iteration loop. Defaults to false. */
  skipPreLoop?: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/** Run the orchestrator loop until exit. Returns when bash would exit. */
export async function runMainLoop(opts: MainLoopOptions): Promise<MainLoopExit> {
  const { ctx, logger, maxIterations } = opts;
  const sleep = opts.sleepFn ?? defaultSleep;
  const cfg = readConfig(ctx.stateDir);
  const primaryRole = configGet<string>(cfg, 'primaryRole', 'orchestrator');

  // Plugin lifecycle: onLoad fires once at orchestrator startup; onUnload
  // fires once at orchestrator shutdown via try/finally below. Fired even
  // if the run aborts so plugins can clean up.
  fireLifecycleHook(ctx, 'onLoad', logger.log);
  try {
    return await runMainLoopBody(opts, ctx, logger, sleep, cfg, primaryRole, maxIterations);
  } finally {
    fireLifecycleHook(ctx, 'onUnload', logger.log);
  }
}

async function runMainLoopBody(
  opts: MainLoopOptions,
  ctx: InvokeContext,
  logger: Logger,
  sleep: (ms: number) => Promise<void>,
  cfg: ReturnType<typeof readConfig>,
  primaryRole: string,
  maxIterations: number,
): Promise<MainLoopExit> {
  // Pre-loop: scoper, plan-reviewer, ensure-docs, post-planner checkpoints,
  // worktree prune.
  if (opts.skipPreLoop !== true) {
    const pre = await runPreLoop(ctx, logger, cfg);
    if (pre.stop !== null) {
      return { exitCode: pre.exitCode, reason: pre.stop, iterations: 0 };
    }
  }

  // Process previously-granted user checkpoints; refuse to start if pending.
  const cpAction = ctx.pg && ctx.workspaceId
    ? await checkpointGate(ctx.stateDir, {
        pg: ctx.pg,
        workspaceId: ctx.workspaceId,
        harnessSlug: (await import('./state')).harnessSlug(ctx.projectDir),
      })
    : checkpointGate(ctx.stateDir);
  if (cpAction.kind === 'granted-cleared') {
    for (const name of cpAction.cleared) {
      logger.log(`✅ Checkpoint granted: ${name.replace(/\.md$/, '')}. Removing.`);
    }
  } else if (cpAction.kind === 'pending') {
    for (const name of cpAction.pending) {
      logger.log(`⏸  Checkpoint pending grant: ${name.replace(/\.md$/, '')}. Exiting.`);
    }
    logger.log(`Grant via UI, or run: touch <stateDir>/<checkpoint>.granted; then re-run.`);
    return { exitCode: 8, reason: 'pending-checkpoint', iterations: 0 };
  }

  // Lane pool — one per loop run. Used by NEXT_WORKER (parallel/competition)
  // and drained by NEXT_VALIDATOR before the validator runs. cfg.parallelWorkers.max
  // is the cap; default 1 (sequential).
  const lanePool = createLanePool(ctx.stateDir, parallelMaxWorkers(cfg));
  // Process-singleton lock queue used by the chunk-loop path. Shared
  // across all NEXT_WORKER dispatches so concurrent workers see each
  // other's holds. Empty / unused when useChunkLoop is false.
  const lockQueue = new FileLockQueue();

  // Adaptive-mode tier configuration is per-harness, stored in the spec
  // at parallelWorkers.adaptive.{tiers,labels,rubric}. Read directly from
  // cfg — no API round-trip — so a flaky operator can never block start.
  const adaptiveActive = isAdaptiveMode(cfg);
  const adaptiveTiers: WorkerCountTiers = workerCountTiers(cfg);
  if (adaptiveActive) {
    logger.log(
      `ADAPTIVE: tiers=[${adaptiveTiers.tiers.join(', ')}] labels=[${adaptiveTiers.labels.join(', ')}] max=${parallelMaxWorkers(cfg)}`,
    );
  }

  // Fire Papercusp plugin lifecycle: beforeMissionStart.
  fireLifecycleHook(ctx, 'beforeMissionStart', logger.log);

  // Reset mission-scoped state so per-mission sentinels (cost-warn-fired,
  // ready-for-prod) start fresh on each `run.sh` invocation. The PG row
  // is keyed (workspace_id, harness_slug); without an explicit reset
  // here, the file-based "fires once per mission" semantic the doc
  // strings claim (e.g. cost-cap.ts:148) silently became "fires once
  // per harness, ever." See clearMissionStatePg's docstring for full
  // rationale.
  if (ctx.pg && ctx.workspaceId) {
    try {
      const { clearMissionStatePg } = await import('./mission-state-pg');
      const { harnessSlug } = await import('./state');
      await clearMissionStatePg({
        pg: ctx.pg,
        workspaceId: ctx.workspaceId,
        harnessSlug: harnessSlug(ctx.projectDir),
      });
    } catch (e) {
      logger.log(`  mission-state reset failed (non-fatal): ${(e as Error).message ?? e}`);
    }
  }

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    logger.log(`── iteration ${iteration} ──`);

    // 1a. Pre-orchestrator slot gate. Block the next orchestrator call
    // until at least one lane slot is free — saves the LLM cost of asking
    // for a decision we'd just have to clamp/reject. Applies to every
    // parallel mode (lane / competition / adaptive). When max=1
    // (sequential) the lane pool only ever holds 0 slots at this point
    // because each iteration is end-to-end synchronous, so the wait is
    // a no-op.
    const maxSlots = parallelMaxWorkers(cfg);
    if (maxSlots > 1 && lanePool.count() >= maxSlots) {
      logger.log(
        `  gate: pool ${lanePool.count()}/${maxSlots} — waiting for a lane to free before invoking orchestrator`,
      );
      while (lanePool.count() >= maxSlots) {
        await sleep(100);
      }
    }
    const availableSlots = Math.max(0, maxSlots - lanePool.count());
    // Optional cap on distinct features in flight. null = no separate
    // cap (only AVAILABLE_SLOTS limits). The orchestrator sees this in
    // its prompt extras and applies it to its greedy fit.
    const maxFeatures = maxFeaturesInFlightCfg(cfg);

    // 1b. Build adaptive-context extras for the primary role's prompt.
    // The orchestrator prompt itself documents how to use ADAPTIVE_*; we
    // just inject the live values here. Empty when adaptive mode isn't
    // active so existing prompts keep their current shape.
    const orchestratorExtras: string[] = [];
    if (adaptiveActive) {
      const tierDocs = adaptiveTiers.tiers
        .map((n, i) => `${n} (${adaptiveTiers.labels[i] ?? `tier-${i}`})`)
        .join(', ');
      orchestratorExtras.push(
        `PARALLEL_MODE=${parallelMode(cfg)}`,
        `MAX_SLOTS=${maxSlots}`,
        `AVAILABLE_SLOTS=${availableSlots}`,
        `ADAPTIVE_TIERS=${tierDocs}`,
      );
      if (maxFeatures !== null) {
        orchestratorExtras.push(`MAX_FEATURES_IN_FLIGHT=${maxFeatures}`);
      }
      if (adaptiveTiers.rubric.trim().length > 0) {
        // Rubric goes through extras as a single line — newlines preserved
        // so the LLM sees the formatted version. Bash-equivalent extras
        // are typed as readonly string[] and joined with newlines later.
        orchestratorExtras.push(`ADAPTIVE_RUBRIC=${adaptiveTiers.rubric}`);
      }
    } else if (maxSlots > 1) {
      orchestratorExtras.push(
        `PARALLEL_MODE=${parallelMode(cfg)}`,
        `MAX_SLOTS=${maxSlots}`,
        `AVAILABLE_SLOTS=${availableSlots}`,
      );
      if (maxFeatures !== null) {
        orchestratorExtras.push(`MAX_FEATURES_IN_FLIGHT=${maxFeatures}`);
      }
    }

    // 1. Invoke the primary advancing role.
    const decisionResult = await invoke(ctx, primaryRole, orchestratorExtras);
    fireLifecycleHook(ctx, 'onPostOrchestrator', logger.log);
    // Batch-aware decision parse — accepts a single decision OR a
    // `DECISIONS … END` envelope with multiple NEXT_WORKER lines.
    // SOLO_VERBS in a multi-decision batch reject the whole batch.
    const batch = parseDecisions(decisionResult.output);

    if (batch.length === 0) {
      logger.log(
        `ERROR: orchestrator returned unparsable decision: '${decisionResult.output.slice(0, 200)}'`,
      );
      logger.log('Aborting. Inspect logs and state, then rerun.');
      await lanePool.waitAll();
      return { exitCode: 4, reason: 'unparsable-decision', iterations: iteration };
    }

    if (batch.length === 1) {
      logger.log(`ORCH decision: ${batch[0].raw} (role=${primaryRole})`);
    } else {
      logger.log(
        `ORCH batch (${batch.length} decisions, role=${primaryRole}): ${batch.map((d) => d.raw).join(' | ')}`,
      );
    }

    // 2. Dispatch — batch-aware. Solo verbs are rejected at parse time
    // when mixed with others, so any batch of length > 1 is all
    // batchable verbs (currently only NEXT_WORKER). Greedy fit:
    // dispatch in order, stop early if a terminal decision lands.
    let dispatch: DispatchResult = { terminal: false, exitCode: 0, reason: 'idle' };
    let dispatched = 0;
    for (const decision of batch) {
      // Honor maxFeaturesInFlight cap — orchestrator should already
      // have respected it, but enforce belt-and-suspenders.
      if (
        maxFeatures !== null
        && decision.verb === 'NEXT_WORKER'
        && dispatched >= maxFeatures
      ) {
        logger.log(
          `  skipping ${decision.raw}: would exceed maxFeaturesInFlight=${maxFeatures}`,
        );
        continue;
      }
      dispatch = await dispatchDecision(
        decision,
        ctx,
        logger,
        cfg,
        iteration,
        sleep,
        lanePool,
        lockQueue,
      );
      dispatched++;
      if (dispatch.terminal) break;
    }
    if (dispatch.terminal) {
      // Drain in-flight parallel lanes so they don't outlive this exit
      // (e.g. a worker writing to a directory the caller is about to clean up).
      await lanePool.waitAll();
      return { exitCode: dispatch.exitCode, reason: dispatch.reason, iterations: iteration };
    }

    // 3. Snapshot state (for UI rollback).
    if (ctx.pg && ctx.workspaceId) {
      const { harnessSlug: getSlug } = await import('./state');
      await snapshotState(ctx.stateDir, iteration, cfg, {
        pg: ctx.pg,
        workspaceId: ctx.workspaceId,
        harnessSlug: getSlug(ctx.projectDir),
      });
    } else {
      snapshotState(ctx.stateDir, iteration, cfg);
    }

    // 4. Prune oldest agent logs beyond logRetention.
    pruneLogs(ctx.logDir, cfg);

    // 5. Cost cap. Aborts the loop with exit code 6 when total >= cap.
    const cost = ctx.pg && ctx.workspaceId
      ? await evaluateCostCap(cfg, ctx.logDir, ctx.stateDir, {
          pg: ctx.pg,
          workspaceId: ctx.workspaceId,
          harnessSlug: (await import('./state')).harnessSlug(ctx.projectDir),
        })
      : evaluateCostCap(cfg, ctx.logDir, ctx.stateDir);
    if (cost.cap !== null) {
      logger.log(`  COST total=${cost.total.toFixed(4)} cap=${cost.cap}`);
    } else {
      logger.log(`  COST total=${cost.total.toFixed(4)} (no cap configured)`);
    }
    if (cost.overCap) {
      logger.log(
        `⛔ COST CAP EXCEEDED: ${cost.total.toFixed(4)} >= ${cost.cap}. Aborting.`,
      );
      logger.notifyEvent(
        'cost-cap',
        `Cost cap exceeded: ${cost.total.toFixed(4)} >= ${cost.cap}`,
      );
      return { exitCode: 6, reason: 'cost-cap', iterations: iteration };
    }
    if (cost.warned && cost.cap !== null) {
      const pct = Math.round((cost.total / cost.cap) * 100);
      logger.log(`⚠ COST WARN: ${cost.total.toFixed(4)} >= ${pct}% of ${cost.cap} cap`);
      logger.notifyEvent(
        'cost-warn',
        `Cost at ${pct}% of cap: ${cost.total.toFixed(4)} of ${cost.cap}`,
      );
    }
    if (cost.shouldPause) {
      logger.log("  auto-pause: SIGSTOP'ing harness process tree (config.maxCostUsdAutoPause=true)");
      try {
        process.kill(process.pid, 'SIGSTOP');
        // Resumes here on SIGCONT.
        logger.log('  auto-pause: resumed');
      } catch (err) {
        logger.log(`  auto-pause failed: ${(err as Error).message}`);
      }
    }

    // 6. Sleep.
    await sleep(opts.iterationSleepMs);
  }

  logger.log(`Hit MAX_ITERATIONS=${maxIterations} without converging. Exiting.`);
  logger.notifyEvent('max-iter', `Hit MAX_ITERATIONS=${maxIterations} without converging`);
  // Drain any in-flight parallel lanes so they don't outlive this exit.
  await lanePool.waitAll();
  return { exitCode: 5, reason: 'max-iterations', iterations: maxIterations };
}

interface DispatchResult {
  /** True if the loop should exit. */
  terminal: boolean;
  /** Bash-equivalent exit code when terminal=true. */
  exitCode: number;
  /** Reason label for the MainLoopExit. */
  reason: MainLoopExit['reason'];
}

/**
 * Dispatch a parsed decision. Returns terminal=true when the loop should
 * stop (DONE / ESCALATE / IDLE-with-config / CHECKPOINT) and false otherwise.
 */
async function dispatchDecision(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  iteration: number,
  sleep: (ms: number) => Promise<void>,
  lanePool: LanePool,
  lockQueue: FileLockQueue,
): Promise<DispatchResult> {
  switch (parsed.verb) {
    case 'DONE':
      return handleDone(ctx, logger, cfg, iteration);

    case 'IDLE':
      // bash sleeps 30s on IDLE to back off polling-style primary roles.
      logger.log('IDLE — sleeping before next iteration');
      await sleep(30_000);
      return { terminal: false, exitCode: 0, reason: 'idle' };

    case 'ESCALATE':
      return handleEscalate(parsed, ctx, logger);

    case 'CHECKPOINT':
      return await handleCheckpoint(parsed, ctx, logger, iteration);

    case 'READY_FOR_PROD':
      return await handleReadyForProd(ctx, logger);

    case 'NEXT_HARNESS':
      return handleNextHarness(parsed, ctx, logger);

    case 'NEXT_WORKER':
      return handleNextWorker(parsed, ctx, logger, cfg, lanePool, lockQueue);

    case 'NEXT_WORKER_CEO_MODE':
      return handleNextWorkerCeoMode(parsed, ctx, logger, cfg);

    case 'NEXT_VALIDATOR':
      return handleNextValidator(parsed, ctx, logger, cfg, lanePool);

    case 'NEXT_TESTER':
      return handleSimpleInvoke(ctx, logger, 'tester', parsed.arg ? [`VAL_ID=${parsed.arg}`] : ['VAL_ID='], `TESTER starting${parsed.arg ? ` for ${parsed.arg}` : ''}`);

    case 'NEXT_SECURITY':
      return handleSimpleInvoke(ctx, logger, 'security-reviewer', [], 'SECURITY sweep starting');

    case 'GENERATE_TESTS':
      return handleSimpleInvoke(ctx, logger, 'test-writer', [], 'TEST_WRITER edge-case expansion starting');

    case 'NEXT_MONITOR':
      return handleSimpleInvoke(ctx, logger, 'monitor', [], 'MONITOR health sweep starting (production phase)');

    case 'NEXT_ARCHITECT':
      return handleNextArchitect(parsed, ctx, logger);

    case 'CONVERTED':
      logger.log('Orchestrator converted issues to fix features. Continuing.');
      return { terminal: false, exitCode: 0, reason: 'idle' };

    case 'FEATURE_FREEZE':
      logger.log(`FEATURE_FREEZE: ${parsed.raw}`);
      return { terminal: false, exitCode: 0, reason: 'idle' };

    case 'RUN_TESTS':
      return handleRunTests(ctx, logger);

    case 'NEXT_EXPERT':
      return handleNextExpert(parsed, ctx, logger);

    case 'NEXT_FEEDBACK':
      return handleNextFeedback(parsed, ctx, logger);

    case 'NEXT_SCOPER':
      return handleNextScoper(parsed, ctx, logger);

    default: {
      // Unreachable — parseDecision narrows to DECISION_VERBS which we
      // exhaustively handle above. The exhaustive check appeases TS.
      const _exhaustive: never = parsed.verb;
      logger.log(`unhandled decision verb (impossible): ${String(_exhaustive)}`);
      return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
    }
  }
}

/**
 * DONE handler. Mirrors bash:
 *   - service-smoke-test gate (configurable; failure reopens the loop)
 *   - curator + documenter consolidate-mode invocations
 *   - optional scoper proposal + reviewer auto-apply (product workflow)
 *   - optional archiveOnDone tar.gz of state dir
 *   - fire afterDone plugin hooks
 *   - notify_event done
 *   - exit 0
 */
async function handleDone(
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  iteration: number,
): Promise<DispatchResult> {
  logger.log('🎉 All features passed.');

  // Smoke-test gate.
  if (
    configGet<boolean>(cfg, 'smokeTest.enabled', false) === true &&
    configGet<boolean>(cfg, 'smokeTest.onDone', true) === true
  ) {
    logger.log('Running service smoke-test (smokeTest.onDone=true)…');
    const smokeRc = runSmokeTest(ctx, logger);
    const hookOpts = {
      stateDir: ctx.stateDir,
      projectDir: ctx.projectDir,
      logDir: ctx.logDir,
      env: { TRIGGER: 'onDone', PROJECT_DIR: ctx.projectDir, STATE_DIR: ctx.stateDir },
      log: logger.log,
    };
    if (smokeRc === 0) {
      logger.log('Smoke test PASSED.');
      runHook('on-smoke-pass', hookOpts);
    } else {
      logger.log('Smoke test FAILED — feature reopened. Re-entering loop.');
      runHook('on-smoke-fail', hookOpts);
      return { terminal: false, exitCode: 0, reason: 'idle' };
    }
  }

  logger.log('Running curator to distill run memory.');
  try {
    const curatorOut = await invoke(ctx, 'curator', ['TRIGGER=done']);
    logger.log(`CURATOR: ${(curatorOut.output || '').slice(0, 200) || '(no output)'}`);
  } catch (err) {
    logger.log(`CURATOR error: ${(err as Error).message}`);
  }
  // G5 — POST identity + skill snapshots after curator finishes.
  // Mirrors bash _post_curator_outputs. Best-effort.
  void postCuratorOutputs({ stateDir: ctx.stateDir, harnessDir: ctx.harnessDir }).catch(() => {});

  logger.log('Running documenter in consolidate mode.');
  try {
    const docOut = await invoke(ctx, 'documenter', ['TRIGGER=done', 'FEATURE_ID=-']);
    logger.log(`DOCUMENTER: ${(docOut.output || '').slice(0, 200) || '(no output)'}`);
  } catch (err) {
    logger.log(`DOCUMENTER error: ${(err as Error).message}`);
  }

  // G4 — archiveOnDone. tar.gz state dir, fire archive event. Mirrors
  // bash run.sh:2326–2336. Default off (config.archiveOnDone=true to
  // enable). Best-effort: archive errors are logged and don't gate exit.
  if (configGet<boolean>(cfg, 'archiveOnDone', false) === true) {
    try {
      const archivesDir = join(ctx.stateDir, 'archives');
      mkdirSync(archivesDir, { recursive: true });
      const archivePath = join(archivesDir, `${Math.floor(Date.now() / 1000)}-done.tar.gz`);
      const tarRes = spawnSync(
        'tar',
        ['czf', archivePath, '-C', ctx.stateDir, '--exclude=archives', '--exclude=./archives', '.'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      if (tarRes.status === 0 && existsSync(archivePath)) {
        const sz = (() => { try { return statSync(archivePath).size; } catch { return 0; } })();
        logger.log(`  archiveOnDone: saved ${basename(archivePath)} (${sz} bytes)`);
        const phase = ctx.phase ?? 'staging';
        void postArchiveEvent({ stateDir: ctx.stateDir, archivePath, phase }).catch(() => {});
      } else {
        logger.log(`  archiveOnDone: tar failed (rc=${tarRes.status})`);
      }
    } catch (err) {
      logger.log(`  archiveOnDone error: ${(err as Error).message}`);
    }
  }

  // Fire registered plugin afterDone hooks (briefings pipeline, etc.).
  firePluginHook({
    hookName: 'afterDone',
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    pluginsLogPath: join(ctx.logDir, 'plugins.log'),
    log: logger.log,
  });

  logger.notifyEvent('done', `Mission complete: all features passed after ${iteration} iterations`);
  return { terminal: true, exitCode: 0, reason: 'done' };
}

/**
 * NEXT_WORKER handler. Routes between three paths:
 *
 *   - **competition** (Stage 5a): N workers on the same feature in
 *     sibling worktrees; validator picks a winner via COMPETITION_WINNER.
 *     Requires branchIsolation + useWorktrees + parallelWorkers.mode=='competition'.
 *   - **parallel lane** (Stage 5a): up to N workers run on different
 *     features in parallel, each on its own branch. Requires
 *     branchIsolation + parallelWorkers.max > 1.
 *   - **sequential** (Stage 2c): single worker; default.
 *
 * All three paths share the optional debugger-threshold pre-check.
 */
async function handleNextWorker(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lanePool: LanePool,
  lockQueue: FileLockQueue,
): Promise<DispatchResult> {
  const fid = parsed.arg ?? '';
  if (!fid) {
    logger.log(`ERROR: NEXT_WORKER without feature id: ${parsed.raw}`);
    return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
  }

  // Chunk-loop path takes priority over the legacy modes when enabled.
  // It runs ONE feature end-to-end through plan → chunk-loop → commit,
  // returning when the feature is done or escalated. Concurrent
  // dispatches share the lockQueue.
  if (useChunkLoop(cfg)) {
    return handleChunkLoopWorker(fid, ctx, logger, cfg, lockQueue);
  }

  if (isAdaptiveMode(cfg)) {
    return handleAdaptiveWorker(parsed, fid, ctx, logger, cfg, lanePool);
  }
  if (isCompetitionMode(cfg)) {
    return handleMultiWorker(fid, parallelWorkersPerFeature(cfg), ctx, logger, cfg, lanePool, 'static');
  }
  if (isLaneMode(cfg)) {
    return handleParallelLaneWorker(fid, ctx, logger, cfg, lanePool);
  }

  // Optional debugger before the worker.
  if (configGet<boolean>(cfg, 'debugger.enabled', true) === true) {
    const threshold = Number(configGet<unknown>(cfg, 'debugger.threshold', 3));
    const attempts = await featureAttempts(ctx.stateDir, fid, stateCtx(ctx));
    const debugNote = join(ctx.stateDir, 'debug', `${fid}.md`);
    if (attempts >= threshold && !existsSync(debugNote)) {
      logger.log(
        `DEBUGGER ${fid} starting (attempts=${attempts} ≥ ${threshold})`,
      );
      try {
        const dout = await invoke(ctx, 'debugger', [`FEATURE_ID=${fid}`]);
        logger.log(
          `DEBUGGER: ${(dout.output || '').slice(0, 200) || '(no output)'}`,
        );
        // PG-canonical capture: read whatever the debugger wrote at
        // <stateDir>/debug/<fid>.md and UPSERT to PG. Replaces the
        // never-built `/api/internal/feature-debug-note-event` poster
        // referenced by bash run.sh. Best-effort.
        if (ctx.pg && ctx.workspaceId) {
          try {
            const { captureDebuggerOutput } = await import('./feature-debug-notes.js');
            const { harnessSlug: getSlug } = await import('./state.js');
            const r = await captureDebuggerOutput({
              pg: ctx.pg,
              workspaceId: ctx.workspaceId,
              harnessSlug: getSlug(ctx.projectDir),
              featureId: fid,
              stateDir: ctx.stateDir,
            });
            if (r.captured) {
              logger.log(`  debugger output captured to PG (${r.bytes} chars)`);
            }
          } catch { /* best-effort */ }
        }
      } catch (err) {
        logger.log(`DEBUGGER error: ${(err as Error).message}`);
      }
    }
  }

  const branchIsoCtx = {
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log: logger.log,
  };

  branchIsoPreWorker(branchIsoCtx, fid);
  // pre-worker hook (user customization point).
  runHook('pre-worker', {
    stateDir: ctx.stateDir,
    projectDir: ctx.projectDir,
    logDir: ctx.logDir,
    env: { ROLE: 'worker', FEATURE_ID: fid, PROJECT_DIR: ctx.projectDir, STATE_DIR: ctx.stateDir },
    log: logger.log,
  });
  logger.log(`WORKER ${fid} starting`);
  await setFeatureStatus(ctx.stateDir, fid, 'in_progress', { bumpAttempts: true, ctx: stateCtx(ctx) });

  // If worktrees enabled, route the worker subprocess to the worktree dir
  // by passing a worktreePathFor callback to invoke().
  const worktreedCtx: InvokeContext = worktreeEnabled(cfg)
    ? {
        ...ctx,
        worktreePathFor: (id) => worktreePath(ctx.stateDir, id),
      }
    : ctx;

  let workerRc = 0;
  try {
    const r = await invoke(worktreedCtx, 'worker', [`FEATURE_ID=${fid}`]);
    workerRc = r.exitCode;
  } catch (err) {
    logger.log(`WORKER error: ${(err as Error).message}`);
    workerRc = 1;
  }

  // post-worker hook.
  runHook('post-worker', {
    stateDir: ctx.stateDir,
    projectDir: ctx.projectDir,
    logDir: ctx.logDir,
    env: {
      ROLE: 'worker',
      FEATURE_ID: fid,
      RC: String(workerRc),
      PROJECT_DIR: ctx.projectDir,
      STATE_DIR: ctx.stateDir,
    },
    log: logger.log,
  });
  fireLifecycleHook(ctx, 'onPostWorker', logger.log);

  branchIsoPostWorker(branchIsoCtx, fid);
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * NEXT_VALIDATOR handler.
 *   - drains parallel worker lanes first (avoid git conflicts with the
 *     validator running concurrently with workers)
 *   - branchIsoPreValidator (switches to feature branch / logs worktree)
 *   - log "VALIDATOR <fid> starting"
 *   - invoke validator (with worktree cwd if applicable)
 *   - branchIsoPostValidator (merges/PRs/keeps on PASS)
 *   - if a competition manifest exists for this feature: parse winner,
 *     merge winner branch, drop loser worktrees.
 */
async function handleNextValidator(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lanePool: LanePool,
): Promise<DispatchResult> {
  const fid = parsed.arg ?? '';
  if (!fid) {
    logger.log(`ERROR: NEXT_VALIDATOR without feature id: ${parsed.raw}`);
    return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
  }

  // Drain THIS feature's parallel worker lanes before running the
  // validator — running git operations concurrently with workers
  // committing in their lanes risks index conflicts. Other features'
  // competitions keep running (the hybrid case: 5 features × 2 workers
  // each — when feature A is ready to validate, only its 2 lanes need
  // to drain; B/C/D/E's 8 lanes keep working).
  const perFeatureCount = lanePool.countForFeature(fid);
  if (perFeatureCount > 0) {
    logger.log(
      `  parallel: waiting on ${perFeatureCount} worker lane(s) for ${fid}…` +
        (lanePool.count() > perFeatureCount
          ? ` (${lanePool.count() - perFeatureCount} other-feature lane(s) keep running)`
          : ''),
    );
    await lanePool.waitForFeature(fid);
  }

  const branchIsoCtx = {
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log: logger.log,
  };

  branchIsoPreValidator(branchIsoCtx, fid);
  // pre-validator hook.
  runHook('pre-validator', {
    stateDir: ctx.stateDir,
    projectDir: ctx.projectDir,
    logDir: ctx.logDir,
    env: { ROLE: 'validator', FEATURE_ID: fid, PROJECT_DIR: ctx.projectDir, STATE_DIR: ctx.stateDir },
    log: logger.log,
  });
  logger.log(`VALIDATOR ${fid} starting`);

  const worktreedCtx: InvokeContext = worktreeEnabled(cfg)
    ? {
        ...ctx,
        worktreePathFor: (id) => worktreePath(ctx.stateDir, id),
      }
    : ctx;

  // ─── Synthesizer step (gated by parallelWorkers.useSynthesizer) ──
  // When enabled, run synthesis BEFORE the validator. Synthesizer reads
  // all candidate lanes (real competition manifest, or a synthetic
  // 1-lane manifest for single-worker dispatches), produces a unified
  // tree in `<fid>-synthesis` worktree. Validator then runs against
  // that worktree as a normal single-branch validation.
  let synthesisWorktree: string | null = null;
  let synthesisBr: string | null = null;
  let synthesisRanWithManifest: { n: number } | null = null;
  if (useSynthesizer(cfg)) {
    let effectiveManifest = readCompetitionManifest(ctx.stateDir, fid);
    if (!effectiveManifest && synthesizeSingle(cfg)) {
      effectiveManifest = singleLaneManifest(ctx.stateDir, fid);
    }
    if (effectiveManifest) {
      const result = await runSynthesizer({
        fid,
        manifest: effectiveManifest,
        ctx,
        cfg,
        log: logger.log,
      });
      if (result.synthesized && result.worktree && result.branch) {
        synthesisWorktree = result.worktree;
        synthesisBr = result.branch;
        synthesisRanWithManifest = { n: effectiveManifest.n };
        // Remove the manifest so the validator doesn't try to score
        // lanes / emit COMPETITION_WINNER. After synth, validator just
        // validates the synthesis worktree as a normal feature branch.
        try {
          unlinkSync(competitionManifestPath(ctx.stateDir, fid));
        } catch {
          // ignore
        }
      } else {
        logger.log(
          `SYNTHESIZER: ${fid} skipped (${result.reason ?? 'unknown'}); falling back to direct validation`,
        );
      }
    }
  }

  const validatorCtx: InvokeContext = synthesisWorktree
    ? { ...ctx, worktreePathFor: () => synthesisWorktree as string }
    : worktreedCtx;

  // Capture pre-validator status set so we can detect transitions to
  // 'passed' after the validator returns. Validator updates features.json
  // directly; this is the cheapest way to surface the per-feature event.
  const beforeStatus = new Map<string, string>();
  for (const f of (await readFeatures(ctx.stateDir, stateCtx(ctx)))) beforeStatus.set(f.id, f.status);

  let validatorRc = 0;
  try {
    const r = await invoke(validatorCtx, 'validator', [`FEATURE_ID=${fid}`]);
    validatorRc = r.exitCode;
  } catch (err) {
    logger.log(`VALIDATOR error: ${(err as Error).message}`);
    validatorRc = 1;
  }

  // post-validator hook.
  runHook('post-validator', {
    stateDir: ctx.stateDir,
    projectDir: ctx.projectDir,
    logDir: ctx.logDir,
    env: {
      ROLE: 'validator',
      FEATURE_ID: fid,
      RC: String(validatorRc),
      PROJECT_DIR: ctx.projectDir,
      STATE_DIR: ctx.stateDir,
    },
    log: logger.log,
  });
  fireLifecycleHook(ctx, 'onPostValidator', logger.log);

  // Pattern 1 — onFeaturePassed fires per newly-passed feature. Diff before
  // vs after to find features that transitioned status → 'passed'. Each
  // fire passes --feature-id=... so plugin scripts can target the event.
  // Also attach an adaptive-telemetry outcome for the matching pending row,
  // if any (see _adaptiveTelemetryByFeature in handleAdaptiveWorker).
  for (const f of (await readFeatures(ctx.stateDir, stateCtx(ctx)))) {
    const before = beforeStatus.get(f.id);
    if (f.status === 'passed' && before !== 'passed') {
      firePluginHook({
        hookName: 'onFeaturePassed',
        projectDir: ctx.projectDir,
        stateDir: ctx.stateDir,
        pluginsLogPath: join(ctx.logDir, 'plugins.log'),
        log: logger.log,
        extraFlags: [`--feature-id=${f.id}`],
      });
      void attachAdaptiveOutcome(ctx, logger, f.id, 'pass');
    } else if (
      (f.status === 'failed' || f.status === 'blocked') &&
      before !== f.status &&
      before !== 'passed'
    ) {
      void attachAdaptiveOutcome(ctx, logger, f.id, 'fail');
    }
  }

  if (synthesisWorktree && synthesisBr && synthesisRanWithManifest) {
    // Synthesis path: validator ran against `<fid>-synthesis`. On PASS,
    // merge the synthesis branch and drop ALL worktrees (synthesis +
    // every lane). On FAIL, drop everything without merging. Skips the
    // legacy branchIsoPostValidator + competition verdict paths since
    // the synthesis branch is the canonical artifact now.
    await handleSynthesisOutcome(
      fid,
      synthesisBr,
      synthesisWorktree,
      synthesisRanWithManifest.n,
      ctx,
      logger,
      cfg,
    );
  } else {
    // Validator updates features.json itself; branchIsoPostValidator reads
    // the (possibly-just-changed) status and merges/PRs on PASS.
    branchIsoPostValidator(branchIsoCtx, fid);

    // Competition mode: if a manifest exists for this feature, the validator
    // is expected to have emitted COMPETITION_WINNER lane-N (or "none"). Read
    // the latest validator .out, parse the verdict, merge the winner branch
    // into base, drop loser worktrees, remove the manifest.
    const manifest = readCompetitionManifest(ctx.stateDir, fid);
    if (manifest) {
      handleCompetitionVerdict(fid, manifest, ctx, logger, cfg);
    }
  }
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * After-validator handling for the synthesizer path.
 *
 * Reads the (just-updated) feature status. On PASS, merges the synthesis
 * branch into base and drops every related worktree (synthesis + each
 * lane). On non-PASS, drops every worktree without merging — feature
 * stays `failing` and the orchestrator decides next move on the next
 * iteration. Either way, the post-state is "no leftover worktrees for
 * this feature."
 */
async function handleSynthesisOutcome(
  fid: string,
  synthBranch: string,
  synthWorktree: string,
  laneCount: number,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
): Promise<void> {
  let status = '';
  for (const f of await readFeatures(ctx.stateDir, stateCtx(ctx))) {
    if (f.id === fid) {
      status = f.status;
      break;
    }
  }

  const branchIsoCtx = {
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log: logger.log,
  };
  const base = branchIsoBase(branchIsoCtx);

  if (status === 'passed') {
    logger.log(`SYNTHESIZER: ${fid} validator passed → merging ${synthBranch}`);
    git(['checkout', base], { cwd: ctx.projectDir });
    const merge = git(
      ['merge', '--no-ff', synthBranch, '-m', `synthesizer winner: ${fid}`],
      { cwd: ctx.projectDir },
    );
    if (merge.outputHead(5)) logger.log(`  ${merge.outputHead(5)}`);
  } else {
    logger.log(
      `SYNTHESIZER: ${fid} validator did not pass (status=${status || '?'}) → cleaning up without merge`,
    );
  }

  // Drop the synthesis worktree + branch regardless of outcome.
  git(['worktree', 'remove', '--force', synthWorktree], { cwd: ctx.projectDir });
  git(['branch', '-D', synthBranch], { cwd: ctx.projectDir });

  // Drop each lane worktree + branch. For the synthetic 1-lane case
  // (single-worker synthesis), this is the feature's own branch — we
  // drop it because the synthesis branch has now replaced it on base
  // (PASS) or it's a dead end (FAIL).
  if (laneCount > 1) {
    for (let i = 1; i <= laneCount; i++) {
      const wt = join(ctx.stateDir, 'worktrees', `${fid}-lane-${i}`);
      const br = `harness/${fid}-lane-${i}`;
      if (existsSync(wt)) {
        git(['worktree', 'remove', '--force', wt], { cwd: ctx.projectDir });
      }
      git(['branch', '-D', br], { cwd: ctx.projectDir });
    }
  } else {
    // 1-lane synthetic manifest path: the lane "is" the feature's own
    // worktree (harness/<fid>). Drop it cleanly.
    const wt = worktreePath(ctx.stateDir, fid);
    const br = `harness/${fid}`;
    if (existsSync(wt)) {
      git(['worktree', 'remove', '--force', wt], { cwd: ctx.projectDir });
    }
    git(['branch', '-D', br], { cwd: ctx.projectDir });
  }

  // Remove any stale manifest (should already be gone if synth ran).
  try {
    unlinkSync(competitionManifestPath(ctx.stateDir, fid));
  } catch {
    // ignore
  }

}

/**
 * Multi-worker dispatch: spawn `count` workers on the SAME feature in
 * sibling git worktrees. Each worker grabs a slot from the shared
 * LanePool so multiple multi-worker dispatches can run concurrently
 * across different features (max=10 + count=2 → up to 5 simultaneous
 * 2-way competitions).
 *
 * Returns immediately after registering the lanes — the actual worker
 * Promise.all + manifest write happen in a void(async) IIFE so the
 * orchestrator can dispatch the next decision (another NEXT_WORKER for
 * a different feature, typically) while these workers run.
 *
 * The validator path drains lanes per-feature (waitForFeature(fid)) so
 * other features' multi-worker rounds stay live while feature A is
 * being validated.
 *
 * `source` controls the log prefix ('static' → "COMPETITION",
 * 'adaptive' → "COMPETITION (adaptive)") and whether a workersPerFeature
 * > max clamp warning fires (only meaningful for the static path; the
 * adaptive caller has already validated against max).
 */
async function handleMultiWorker(
  fid: string,
  count: number,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lanePool: LanePool,
  source: 'static' | 'adaptive' = 'static',
): Promise<DispatchResult> {
  const max = parallelMaxWorkers(cfg);
  // Clamp: can't run more workers per feature than max (would deadlock
  // the acquire loop). User-set count > max is a config error in the
  // static path; clamp + warn rather than hang.
  const effectivePer = Math.min(count, max);
  if (effectivePer !== count && source === 'static') {
    logger.log(
      `  competition: workersPerFeature=${count} > max=${max}; clamping to ${effectivePer}`,
    );
  }
  const tag = source === 'adaptive' ? 'COMPETITION (adaptive)' : 'COMPETITION';
  logger.log(
    `${tag}: spawning ${effectivePer} workers on ${fid}` +
      ` (pool ${lanePool.count()}/${max} before this)`,
  );
  // on-competition-start hook (informational).
  runHook('on-competition-start', {
    stateDir: ctx.stateDir,
    projectDir: ctx.projectDir,
    logDir: ctx.logDir,
    env: {
      FEATURE_ID: fid,
      LANE_COUNT: String(effectivePer),
      PROJECT_DIR: ctx.projectDir,
      STATE_DIR: ctx.stateDir,
    },
    log: logger.log,
  });
  await setFeatureStatus(ctx.stateDir, fid, 'in_progress', { bumpAttempts: true, ctx: stateCtx(ctx) });

  const branchIsoCtx = {
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log: logger.log,
  };
  const base = branchIsoBase(branchIsoCtx);
  const worktreesRoot = join(ctx.stateDir, 'worktrees');
  mkdirSync(worktreesRoot, { recursive: true });

  // Acquire `effectivePer` lane slots up front. Each acquire blocks
  // on the global cap (max), so this naturally serializes when the
  // pool is full. After all slots are reserved, spawn the workers
  // ASYNC and return.
  const laneIds: number[] = [];
  for (let i = 1; i <= effectivePer; i++) {
    laneIds.push(await lanePool.acquire(fid));
  }

  // Spawn workers + manifest write in the background. Orchestrator
  // resumes immediately so the next NEXT_WORKER decision can run.
  void (async () => {
    const lanePromises: Promise<void>[] = [];
    for (let i = 0; i < effectivePer; i++) {
      const laneNum = i + 1;
      const laneId = laneIds[i];
      const laneFid = `${fid}-lane-${laneNum}`;
      const wt = join(worktreesRoot, laneFid);
      const br = `harness/${laneFid}`;
      if (!existsSync(wt)) {
        const r = git(['worktree', 'add', '-B', br, wt, base], { cwd: ctx.projectDir });
        if (r.outputHead(3)) logger.log(`  ${r.outputHead(3)}`);
      }
      logger.log(`  competition lane ${laneNum} (${fid}): ${wt}`);

      const lanePromise = (async () => {
        try {
          await invoke(
            { ...ctx, worktreePathFor: () => wt },
            'worker',
            [
              `FEATURE_ID=${laneFid}`,
              `COMPETITION_PARENT=${fid}`,
              `COMPETITION_LANE=${laneNum}`,
            ],
          );
        } catch (err) {
          logger.log(`  competition lane ${laneNum} (${fid}) error: ${(err as Error).message}`);
        }
        // Commit any staged changes in this lane's worktree.
        git(['add', '-A'], { cwd: wt });
        const status = git(['diff', '--cached', '--quiet'], { cwd: wt });
        if (status.exitCode !== 0) {
          const r = git(
            ['commit', '--quiet', '-m', `worker: ${laneFid} (competition lane ${laneNum})`],
            { cwd: wt },
          );
          if (r.outputHead(3)) logger.log(`  ${r.outputHead(3)}`);
        }
        // Release this lane's slot so other features (or this same
        // feature's next attempt after a fail) can dispatch.
        lanePool.release(laneId);
      })();
      lanePromises.push(lanePromise);
    }

    // Wait for THIS feature's competitors only. Other features keep running.
    await Promise.all(lanePromises);

    // Write the competition manifest so the validator iteration can
    // compare worktrees. handleNextValidator's waitForFeature(fid)
    // ensures it waits until this point before reading the manifest.
    await setFeatureStatus(ctx.stateDir, fid, 'validating', { ctx: stateCtx(ctx) });
    writeCompetitionManifest(ctx.stateDir, fid, effectivePer);
    logger.log(
      `${tag}: manifest ${competitionManifestPath(ctx.stateDir, fid)} written` +
        ` (${effectivePer}-way for ${fid})`,
    );
  })();

  // Return immediately — orchestrator can dispatch another NEXT_WORKER
  // for a different feature while this competition runs in the background.
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * Adaptive-mode worker: orchestrator chose N from the configured tier set
 * (e.g. {1, 2, 4}). N=1 dispatches a single worker (lane-style); N>1
 * dispatches N competing workers on the same feature (competition-style)
 * with manifest write so the validator can pick a winner. The pre-loop
 * slot gate guarantees N ≤ available slots before this point, so we
 * don't need an in-handler clamp (defensive clamp below is for malformed
 * verbs only).
 *
 * Telemetry: each call inserts a pending row in adaptive_telemetry; the
 * validator handler patches the outcome (pass/fail). Failures are silent
 * to avoid blocking dispatch.
 */
async function handleAdaptiveWorker(
  parsed: ParsedDecision,
  fid: string,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lanePool: LanePool,
): Promise<DispatchResult> {
  const max = parallelMaxWorkers(cfg);
  const tiers = workerCountTiers(cfg);
  const requestedN = parsed.n ?? tiers.tiers[0];

  // Validate against the configured tier set. Out-of-vocabulary values
  // clamp to the closest valid tier ≤ requestedN, defaulting to the
  // smallest tier when nothing matches. Logs the override for telemetry.
  let actualN = tiers.tiers[0];
  if (tiers.tiers.includes(requestedN)) {
    actualN = requestedN;
  } else {
    const candidates = tiers.tiers.filter((t) => t <= requestedN);
    actualN = candidates.length > 0 ? candidates[candidates.length - 1] : tiers.tiers[0];
    logger.log(
      `  adaptive: requested N=${requestedN} not in tier set [${tiers.tiers.join(',')}]; using N=${actualN}`,
    );
  }

  // Defensive clamp against the hard concurrency cap. Pre-loop gate makes
  // this nearly always a no-op, but a stale cfg (or a request larger
  // than max) would otherwise deadlock the acquire loop.
  const availableAtDecision = Math.max(0, max - lanePool.count());
  if (actualN > availableAtDecision) {
    logger.log(
      `  adaptive: N=${actualN} > availableSlots=${availableAtDecision}; clamping to ${availableAtDecision || 1}`,
    );
    actualN = Math.max(1, availableAtDecision);
  }

  const tierIdx = tiers.tiers.indexOf(actualN);
  const tierLabel = tierIdx >= 0 ? tiers.labels[tierIdx] : null;

  // Best-effort telemetry insert; never blocks dispatch on its outcome.
  await recordAdaptiveDecision(ctx, logger, {
    featureId: fid,
    requestedN,
    actualN,
    tierLabel,
    availableAtDecision,
    maxSlots: max,
  });

  logger.log(
    `ADAPTIVE: ${fid} → N=${actualN} (${tierLabel ?? '?'})` +
      (requestedN !== actualN ? ` [requested ${requestedN}]` : ''),
  );

  if (actualN === 1) {
    // Single-worker path: behaves like a parallel lane (1 worker, own
    // branch, validator merges on PASS). Reuse handleParallelLaneWorker
    // so the lane pool, branch-iso, and worker hooks fire identically.
    return handleParallelLaneWorker(fid, ctx, logger, cfg, lanePool);
  }

  // N>1: dispatch competition with the orchestrator-picked count.
  return handleMultiWorker(fid, actualN, ctx, logger, cfg, lanePool, 'adaptive');
}

/**
 * Parallel-lane worker: acquire a slot from the lane pool (blocks if at
 * cap), kick off the worker async, and return so the orchestrator can
 * dispatch the next decision while this worker runs in parallel. The
 * NEXT_VALIDATOR branch later drains the pool before its validator runs.
 */
async function handleParallelLaneWorker(
  fid: string,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lanePool: LanePool,
): Promise<DispatchResult> {
  const max = parallelMaxWorkers(cfg);
  if (lanePool.count() >= max) {
    logger.log(
      `  parallel: cap reached (${lanePool.count()}/${max}), waiting for a lane to free`,
    );
  }
  const laneId = await lanePool.acquire(fid);
  logger.log(
    `WORKER ${fid} starting (parallel lane, ${lanePool.count() - 1}/${max} active before this)`,
  );
  await setFeatureStatus(ctx.stateDir, fid, 'in_progress', { bumpAttempts: true, ctx: stateCtx(ctx) });

  const branchIsoCtx = {
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log: logger.log,
  };
  const useWorktrees =
    configGet<boolean>(cfg, 'branchIsolation.useWorktrees', false) === true;

  // Run the worker pipeline async. Each step matches the sequential path's
  // ordering (pre-worker hook → invoke → post-worker hook → branch-iso post).
  void (async () => {
    branchIsoPreWorker(branchIsoCtx, fid);
    runHook('pre-worker', {
      stateDir: ctx.stateDir,
      projectDir: ctx.projectDir,
      logDir: ctx.logDir,
      env: { ROLE: 'worker', FEATURE_ID: fid, PROJECT_DIR: ctx.projectDir, STATE_DIR: ctx.stateDir },
      log: logger.log,
    });
    let workerRc = 0;
    try {
      const r = await invoke(
        useWorktrees
          ? { ...ctx, worktreePathFor: (id) => worktreePath(ctx.stateDir, id) }
          : ctx,
        'worker',
        [`FEATURE_ID=${fid}`],
      );
      workerRc = r.exitCode;
    } catch (err) {
      logger.log(`WORKER (parallel) error: ${(err as Error).message}`);
      workerRc = 1;
    }
    runHook('post-worker', {
      stateDir: ctx.stateDir,
      projectDir: ctx.projectDir,
      logDir: ctx.logDir,
      env: {
        ROLE: 'worker',
        FEATURE_ID: fid,
        RC: String(workerRc),
        PROJECT_DIR: ctx.projectDir,
        STATE_DIR: ctx.stateDir,
      },
      log: logger.log,
    });
    branchIsoPostWorker(branchIsoCtx, fid);
    await setFeatureStatus(ctx.stateDir, fid, 'validating', { ctx: stateCtx(ctx) });
    lanePool.release(laneId);
  })();

  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * Competition-mode validator post-step. Find the validator's most recent
 * .out file, parse COMPETITION_WINNER, merge the winning lane's branch,
 * and clean up loser worktrees.
 */
function handleCompetitionVerdict(
  fid: string,
  manifest: ReturnType<typeof readCompetitionManifest>,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
): void {
  if (!manifest) return;
  // Find the most recent <ts>-validator-<fid>.out file in logDir.
  let latestOut = '';
  let latestTs = 0;
  try {
    const entries = readdirSync(ctx.logDir);
    for (const name of entries) {
      if (!name.endsWith(`-validator-${fid}.out`)) continue;
      const tsMatch = /^(\d+)-validator-/.exec(name);
      if (!tsMatch) continue;
      const ts = parseInt(tsMatch[1], 10);
      if (ts > latestTs) {
        latestTs = ts;
        latestOut = name;
      }
    }
  } catch {
    // ignore — log dir may not exist
  }
  if (!latestOut) {
    logger.log('COMPETITION: no validator .out file found; manifest kept for retry.');
    return;
  }
  const validatorOutput = readFileSync(join(ctx.logDir, latestOut), 'utf8');
  const verdict = parseCompetitionVerdict(validatorOutput);

  if (verdict.kind === 'absent') {
    logger.log('COMPETITION: validator did not emit COMPETITION_WINNER; manifest kept for retry.');
    return;
  }

  if (verdict.kind === 'winner') {
    const winnerName = `lane-${verdict.lane}`;
    logger.log(`COMPETITION: winner is ${winnerName}; merging.`);
    const branchIsoCtx = {
      cfg,
      projectDir: ctx.projectDir,
      stateDir: ctx.stateDir,
      log: logger.log,
    };
    const base = branchIsoBase(branchIsoCtx);
    const winnerBr = `harness/${fid}-${winnerName}`;
    git(['checkout', base], { cwd: ctx.projectDir });
    const merge = git(
      ['merge', '--no-ff', winnerBr, '-m', `competition winner: ${fid} from ${winnerName}`],
      { cwd: ctx.projectDir },
    );
    if (merge.outputHead(5)) logger.log(`  ${merge.outputHead(5)}`);
    // Remove all lane worktrees + branches (including the winner's — base
    // now has the merged content).
    for (let i = 1; i <= manifest.n; i++) {
      const wt = join(ctx.stateDir, 'worktrees', `${fid}-lane-${i}`);
      const br = `harness/${fid}-lane-${i}`;
      git(['worktree', 'remove', '--force', wt], { cwd: ctx.projectDir });
      git(['branch', '-D', br], { cwd: ctx.projectDir });
    }
    try {
      unlinkSync(competitionManifestPath(ctx.stateDir, fid));
    } catch {
      // ignore
    }
    logger.log(`COMPETITION: cleaned up; parent ${fid} now carries winner's changes.`);
    runHook('on-competition-won', {
      stateDir: ctx.stateDir,
      projectDir: ctx.projectDir,
      logDir: ctx.logDir,
      env: {
        FEATURE_ID: fid,
        WINNER: winnerName,
        PROJECT_DIR: ctx.projectDir,
        STATE_DIR: ctx.stateDir,
      },
      log: logger.log,
    });
    return;
  }

  if (verdict.kind === 'none') {
    logger.log('COMPETITION: no lane passed; discarding all.');
    for (let i = 1; i <= manifest.n; i++) {
      const wt = join(ctx.stateDir, 'worktrees', `${fid}-lane-${i}`);
      const br = `harness/${fid}-lane-${i}`;
      git(['worktree', 'remove', '--force', wt], { cwd: ctx.projectDir });
      git(['branch', '-D', br], { cwd: ctx.projectDir });
    }
    try {
      unlinkSync(competitionManifestPath(ctx.stateDir, fid));
    } catch {
      // ignore
    }
  }
}



/**
 * ESCALATE handler. Mirrors bash:
 *   reason = decision after "ESCALATE "
 *   logs, fires on-escalate hook, runs curator with TRIGGER=escalate,
 *   notifies, exits 3.
 */
async function handleEscalate(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
): Promise<DispatchResult> {
  const reason = parsed.arg ?? '';
  logger.log(`⛔ ESCALATED: ${reason}`);
  logger.log(`See ${ctx.stateDir}/escalation.md for details.`);
  runHook('on-escalate', {
    stateDir: ctx.stateDir,
    projectDir: ctx.projectDir,
    logDir: ctx.logDir,
    env: { REASON: reason, PROJECT_DIR: ctx.projectDir, STATE_DIR: ctx.stateDir },
    log: logger.log,
  });
  logger.log('Running curator to distill run memory before exit.');
  try {
    const c = await invoke(ctx, 'curator', ['TRIGGER=escalate', `REASON=${reason}`]);
    logger.log(`CURATOR: ${(c.output || '').slice(0, 200) || '(no output)'}`);
  } catch (err) {
    logger.log(`CURATOR error: ${(err as Error).message}`);
  }
  logger.notifyEvent('escalate', reason);
  return { terminal: true, exitCode: 3, reason: 'escalate' };
}

/**
 * CHECKPOINT handler. Mirrors bash:
 *   name + message = decision tail
 *   writes <stateDir>/checkpoint-<name>.md with markdown body
 *   fires on-checkpoint-fired hook
 *   notify_event checkpoint
 *   exit 8
 */
async function handleCheckpoint(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  iteration: number,
): Promise<DispatchResult> {
  // bash splits "CHECKPOINT <name> <message...>" — reuse parsed.arg as the
  // name token; pull the rest as message from parsed.raw.
  let name = parsed.arg ?? '';
  const stripped = parsed.raw.replace(/^CHECKPOINT\s+\S+\s*/, '').trim();
  const message = stripped;
  if (!name) {
    logger.log('CHECKPOINT emitted without name — treating as unnamed escalation.');
    name = 'unnamed';
  }
  const cpFile = join(ctx.stateDir, `checkpoint-${name}.md`);
  const isoNow = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const body = `# Checkpoint: ${name}

Requested at: ${isoNow}
Iteration: ${iteration}

${message}

## How to grant
Grant via UI, or create \`${cpFile}.granted\`:
\`\`\`
touch ${cpFile}.granted
\`\`\`
Then re-run the harness — it will detect the grant file, delete it and the checkpoint,
and continue.
`;
  if (ctx.pg && ctx.workspaceId) {
    const { fireCheckpointPg } = await import('./checkpoints-pg');
    const { harnessSlug: getSlug } = await import('./state');
    await fireCheckpointPg(
      { pg: ctx.pg, workspaceId: ctx.workspaceId, harnessSlug: getSlug(ctx.projectDir) },
      name,
      body,
    );
  } else {
    writeFileSync(cpFile, body);
  }

  logger.log(`⏸  CHECKPOINT '${name}' requested. See ${cpFile}`);
  runHook('on-checkpoint-fired', {
    stateDir: ctx.stateDir,
    projectDir: ctx.projectDir,
    logDir: ctx.logDir,
    env: {
      CHECKPOINT_NAME: name,
      TRIGGER: 'orchestrator',
      PROJECT_DIR: ctx.projectDir,
      STATE_DIR: ctx.stateDir,
    },
    log: logger.log,
  });
  logger.notifyEvent('checkpoint', `Checkpoint requested: ${name}`);
  return { terminal: true, exitCode: 8, reason: 'checkpoint' };
}

/**
 * READY_FOR_PROD handler. Mirrors bash:
 *   date > <stateDir>/ready-for-prod.flag
 *   log
 *   continue
 */
async function handleReadyForProd(ctx: InvokeContext, logger: Logger): Promise<DispatchResult> {
  if (ctx.pg && ctx.workspaceId) {
    const { setReadyForProdPg } = await import('./mission-state-pg');
    await setReadyForProdPg({
      pg: ctx.pg,
      workspaceId: ctx.workspaceId,
      harnessSlug: (await import('./state')).harnessSlug(ctx.projectDir),
    });
  } else {
    const flagPath = join(ctx.stateDir, 'ready-for-prod.flag');
    writeFileSync(flagPath, `${new Date().toISOString()}\n`);
  }
  logger.log('READY_FOR_PROD — flag recorded for promotion pipeline.');
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * NEXT_WORKER_CEO_MODE handler. Used by org/department harnesses when
 * the business role handles a Directive from the user. Mirrors bash:
 *
 *   invoke worker FEATURE_ID=$fid MODE=ceo MESSAGE_ID=$fid
 *   process_actions_block $worker_out $callingDept
 *
 * The worker's prompt is resolved per the same phase+dept lookup chain
 * as a regular invoke (CEO-mode prompt files live under
 * prompts/department/departments/business/worker.md by convention).
 *
 * The worker's output is expected to contain a markdown-fenced
 * ```actions ... ``` JSON block; each action gets POSTed to
 * /api/org/admin/execute-action.
 */
async function handleNextWorkerCeoMode(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
): Promise<DispatchResult> {
  const fid = parsed.arg ?? '';
  if (!fid) {
    logger.log(`ERROR: NEXT_WORKER_CEO_MODE without feature id: ${parsed.raw}`);
    return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
  }
  logger.log(`NEXT_WORKER_CEO_MODE ${fid} (CEO mode)`);

  let workerOut = '';
  try {
    const r = await invoke(ctx, 'worker', [
      `FEATURE_ID=${fid}`,
      'MODE=ceo',
      `MESSAGE_ID=${fid}`,
    ]);
    workerOut = r.output;
  } catch (err) {
    logger.log(`WORKER (ceo mode) error: ${(err as Error).message}`);
    return { terminal: false, exitCode: 0, reason: 'idle' };
  }
  logger.log(`WORKER (ceo mode): ${workerOut.slice(0, 200) || '(no output)'}`);

  const callingDept = configGet<string>(cfg, 'dept', '');
  const harnessToken = configGet<string>(cfg, 'harness_token', '');
  await processActionsBlock({
    stdout: workerOut,
    callingDept: callingDept || undefined,
    bearerToken: harnessToken || undefined,
    log: logger.log,
  });

  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * NEXT_HARNESS handler. Cross-harness dispatch (harness-of-harnesses).
 * Mirrors bash:
 *
 *   NEXT_HARNESS <child-slug> [--role=<role>] [other args]
 *
 *   1. Try POST http://localhost:3001/api/harness/<slug>/invoke?role=<role>
 *      with 120s timeout. On 2xx, write response to log dir and return.
 *   2. On unreachable (any non-2xx, network error, or timeout): look up
 *      the child's path in ~/.restart-harness-projects.json and recurse:
 *        cd <child_path> && PROJECT_DIR=<child_path> MAX_ITERATIONS=1 \
 *          bash <harnessDir>/run.sh
 *      (One iteration per call so the parent stays in control of cadence.)
 */
async function handleNextHarness(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
): Promise<DispatchResult> {
  const childSlug = parsed.arg ?? '';
  if (!childSlug) {
    logger.log(`ERROR: NEXT_HARNESS without child slug: ${parsed.raw}`);
    return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
  }
  // Pull --role= from raw if present.
  const roleMatch = parsed.raw.match(/--role=(\S+)/);
  const childRole = roleMatch?.[1] ?? 'orchestrator';
  logger.log(`NEXT_HARNESS ${childSlug} --role=${childRole}`);

  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const apiUrl = `${operatorBase}/api/harness/${childSlug}/invoke?role=${childRole}`;
  const apiOk = await postJson(apiUrl, '{}', 120_000);
  if (apiOk.ok) {
    if (ctx.pg && ctx.workspaceId) {
      const { recordDispatchPg } = await import('./dispatches-pg');
      const { harnessSlug: getSlug } = await import('./state');
      await recordDispatchPg(
        { pg: ctx.pg, workspaceId: ctx.workspaceId },
        getSlug(ctx.projectDir),
        childSlug,
        childRole,
        apiOk.body,
      );
    } else {
      const ts = Math.floor(Date.now() / 1000);
      const out = join(ctx.logDir, `nexth-${childSlug}-${ts}.json`);
      writeFileSync(out, apiOk.body);
    }
    logger.log(`  → dispatched via API (${apiUrl})`);
    return { terminal: false, exitCode: 0, reason: 'idle' };
  }

  logger.log('  → API unreachable, falling back to direct shell exec');
  const childPath = lookupHarnessPath(childSlug);
  if (!childPath || !existsSync(childPath)) {
    logger.log(`  ERROR: child harness path not found for slug '${childSlug}'`);
    logger.log('  Check ~/.restart-harness-projects.json');
    return { terminal: false, exitCode: 0, reason: 'idle' };
  }
  // Recurse into the child harness for one iteration.
  const result = spawnSync('bash', [`${ctx.harnessDir}/run.sh`], {
    cwd: childPath,
    env: {
      ...process.env,
      PROJECT_DIR: childPath,
      MAX_ITERATIONS: '1',
      HARNESS_DIR: ctx.harnessDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout?.toString() ?? '';
  const stderr = result.stderr?.toString() ?? '';
  // Tail to the parent's run.log (bash uses tee + head -100).
  for (const line of (stdout + stderr).split(/\r?\n/).slice(0, 100)) {
    if (line.length > 0) logger.log(line);
  }
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

interface PostResult {
  ok: boolean;
  status: number;
  body: string;
}

/** Tiny fetch wrapper. Returns ok=false on any error / non-2xx / timeout. */
async function postJson(url: string, body: string, timeoutMs: number): Promise<PostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text };
  } catch {
    return { ok: false, status: 0, body: '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Look up a child harness's project dir. Tries the operator HTTP API
 * (canonical — PG-backed harness_shared.harness_registry) first, then
 * falls back to the legacy ~/.restart-harness-projects.json.
 *
 * The HTTP call is synchronous via execFileSync(curl) since this fn is
 * called from sync contexts. 3s timeout; falls through silently on any
 * failure.
 */
function lookupHarnessPath(slug: string): string | null {
  const home = process.env.HOME ?? '';
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  // 1. Operator HTTP API.
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('curl', [
      '-sf', '--max-time', '3', `${operatorBase}/api/harness/projects`,
    ], { encoding: 'utf8', timeout: 4000 });
    const data = JSON.parse(out);
    const projects = (data?.projects ?? []) as Array<{ slug?: string; path?: string }>;
    const match = projects.find((p) => p.slug === slug);
    if (match?.path) return match.path;
  } catch { /* fall through */ }
  // 2. Legacy file.
  const legacyPath = join(home, '.restart-harness-projects.json');
  if (existsSync(legacyPath)) {
    try {
      const data = JSON.parse(readFileSync(legacyPath, 'utf8'));
      const projects = (data?.projects ?? []) as Array<{ slug?: string; path?: string }>;
      const match = projects.find((p) => p.slug === slug);
      if (match?.path) return match.path;
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * NEXT_ARCHITECT handler. Mirrors bash:
 *
 *   rest="${decision##NEXT_ARCHITECT }"
 *   fid="${rest%% *}"; reason="${rest#* }"
 *   invoke architect "FEATURE_ID=$fid" "REASON=$reason"
 *   verdict ← grep -E '^(PATCH|REVIEW) '
 *   case verdict:
 *     PATCH*  → set feature.status='todo' attempts=0 (worker retries)
 *     REVIEW* → set feature.status='blocked' + notify review-pending
 *     other   → log no actionable verdict
 */
async function handleNextArchitect(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
): Promise<DispatchResult> {
  // Bash splits "NEXT_ARCHITECT F-001 some reason" into fid + reason. Our
  // parseDecision only captures the next token (F-001). Recover the reason
  // by looking at the raw line: anything after the first whitespace post-arg
  // is the reason.
  const fid = parsed.arg ?? '';
  if (!fid) {
    logger.log(`ERROR: NEXT_ARCHITECT without feature id: ${parsed.raw}`);
    return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
  }
  // Reason is everything after `<verb> <arg>` in the original raw text.
  // parseDecision only matched the verb + first arg token, but the agent
  // may have included more — try to pull it back from the source raw.
  const stripped = parsed.raw.replace(/^NEXT_ARCHITECT\s+\S+\s*/, '').trim();
  const reason = stripped || '(no reason given)';

  logger.log(`ARCHITECT ${fid} starting — reason: ${reason}`);
  // Ensure pending-reviews dir exists for the REVIEW path.
  const pendingDir = join(ctx.stateDir, 'pending-reviews');
  if (!existsSync(pendingDir)) {
    mkdirSync(pendingDir, { recursive: true });
  }

  let archOut = '';
  try {
    const r = await invoke(ctx, 'architect', [`FEATURE_ID=${fid}`, `REASON=${reason}`]);
    archOut = r.output;
  } catch (err) {
    logger.log(`ARCHITECT error: ${(err as Error).message}`);
  }

  // Find the verdict line (last "PATCH ..." or "REVIEW ..." in the output).
  const verdictMatch = archOut
    .split(/\r?\n/)
    .reverse()
    .find((line) => /^(PATCH|REVIEW)\s/.test(line.trim()));
  const verdict = verdictMatch?.trim() ?? '';
  logger.log(`ARCHITECT verdict: ${verdict || '(none)'}`);

  if (verdict.startsWith('PATCH')) {
    await setFeatureStatus(ctx.stateDir, fid, 'todo', { resetAttempts: true, ctx: stateCtx(ctx) });
    logger.log(`ARCHITECT patched spec for ${fid}; reset to todo.`);
  } else if (verdict.startsWith('REVIEW')) {
    await setFeatureStatus(ctx.stateDir, fid, 'blocked', { ctx: stateCtx(ctx) });
    logger.log(`ARCHITECT queued review for ${fid}; blocked until resolved.`);
    logger.notifyEvent('review-pending', `${fid} needs human input`);
  } else {
    logger.log(`ARCHITECT produced no actionable verdict; leaving ${fid} untouched.`);
  }
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * Generic "invoke role + log" handler for the trivial decision branches.
 * Mirrors bash's pattern of `invoke <role> [args]; log "<ROLE>: ${out}"`.
 *
 * The role's output isn't post-processed here — the agent itself updates
 * any state files it needs to (e.g. validator writes a verdict to
 * features.json), and the next orchestrator turn observes those changes.
 */
async function handleSimpleInvoke(
  ctx: InvokeContext,
  logger: Logger,
  role: string,
  extras: readonly string[],
  startLog: string,
): Promise<DispatchResult> {
  logger.log(startLog);
  try {
    const r = await invoke(ctx, role, extras);
    logger.log(`${role.toUpperCase()}: ${(r.output || '').slice(0, 200) || '(no output)'}`);
  } catch (err) {
    logger.log(`${role} error: ${(err as Error).message}`);
  }
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * RUN_TESTS handler. Mirrors bash:
 *   if bin/run-tests.sh is executable: run it
 *   else: log skip
 */
function handleRunTests(ctx: InvokeContext, logger: Logger): DispatchResult {
  const script = `${ctx.harnessDir}/bin/run-tests.sh`;
  logger.log('RUN_TESTS invoked (testing phase)');
  if (!existsSync(script)) {
    logger.log('  (bin/run-tests.sh not implemented yet — skipping)');
    return { terminal: false, exitCode: 0, reason: 'idle' };
  }
  const result = spawnSync('bash', [script, ctx.projectDir], {
    cwd: ctx.projectDir,
    env: {
      ...process.env,
      PROJECT_DIR: ctx.projectDir,
      STATE_DIR: ctx.stateDir,
      HARNESS_DIR: ctx.harnessDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout?.toString() ?? '';
  const stderr = result.stderr?.toString() ?? '';
  for (const line of [...stdout.split(/\r?\n/), ...stderr.split(/\r?\n/)]) {
    if (line.trim().length > 0) logger.log(line);
  }
  // G6 — POST <stateDir>/tests/*.json snapshot to operator. Mirrors
  // bash _post_test_snapshot. Best-effort.
  void postTestSnapshot({ stateDir: ctx.stateDir, phase: ctx.phase }).catch(() => {});
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/** Run bin/service-smoke-test.sh synchronously. Returns the exit code. */
function runSmokeTest(ctx: InvokeContext, logger: Logger): number {
  const script = `${ctx.harnessDir}/bin/service-smoke-test.sh`;
  const result = spawnSync('bash', [script], {
    cwd: ctx.projectDir,
    env: {
      ...process.env,
      PROJECT_DIR: ctx.projectDir,
      STATE_DIR: ctx.stateDir,
      HARNESS_DIR: ctx.harnessDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) {
    for (const line of result.stdout.toString().split(/\r?\n/)) {
      if (line.trim().length > 0) logger.log(line);
    }
  }
  if (result.stderr) {
    for (const line of result.stderr.toString().split(/\r?\n/)) {
      if (line.trim().length > 0) logger.log(`  ${line}`);
    }
  }
  return result.status ?? 1;
}

// ─── Chunk-loop driver path (parallelWorkers.useChunkLoop=true) ─────

/**
 * Concrete LLM bridges that connect the worker-chunk-loop to the
 * existing `invoke()` machinery. The loop itself is dependency-injected
 * so this file is the only place that knows about both sides.
 *
 * High level: each chunk-loop callback (`plan`, `implement`, `replan`,
 * `escalate`) renders the appropriate prompt from chunk-plan.ts, feeds
 * it to `invoke(ctx, role, extras, { inlinePrompt, cwd })`, and
 * returns the agent's raw output. For `implement` we additionally
 * scan `git status --porcelain` in the scratch dir to discover which
 * files the LLM actually touched (reported back to the loop for
 * lock-extension decisions).
 */
async function handleChunkLoopWorker(
  fid: string,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lockQueue: FileLockQueue,
): Promise<DispatchResult> {
  // Resolve the feature record so we can give the LLM a useful
  // description. Falls back to id-only when state isn't readable.
  const features = await readFeatures(ctx.stateDir, stateCtx(ctx)).catch(() => []);
  const fRow = features.find((f: { id: string }) => f.id === fid);
  const feature: ChunkLoopFeature = {
    id: fid,
    title: (fRow?.title as string) ?? fid,
    description: (fRow?.summary as string) ?? `Feature ${fid}`,
    context: typeof fRow?.notes === 'string' ? (fRow.notes as string) : undefined,
  };

  logger.log(`CHUNK_LOOP starting for ${fid}`);
  await setFeatureStatus(ctx.stateDir, fid, 'in_progress', { bumpAttempts: true, ctx: stateCtx(ctx) });

  const outcome = await driveChunkLoop({
    feature,
    cfg,
    lockQueue,
    repoPath: ctx.projectDir,
    pg: ctx.pg,
    workspaceId: ctx.workspaceId,
    // Slug source order: HARNESS_SLUG env → PAPERCUSP_HARNESS_SLUG env →
    // config.slug → basename(projectDir). Matches the harness registry's
    // resolution so chunk-plan rows are queryable from the operator UI
    // without requiring users to set `slug` in config.json.
    harnessSlug:
      (configGet<string>(cfg, 'slug', '') || harnessSlug(ctx)) || undefined,
    log: (msg) => logger.log(msg),
    llm: {
      plan: async (f) => {
        const promptText = planChunksUpfrontPrompt({
          featureId: f.id,
          featureTitle: f.title,
          featureDescription: f.description,
          context: f.context,
        });
        const result = await invoke(ctx, 'worker', [`FEATURE_ID=${f.id}`, 'CHUNK_LOOP_STAGE=plan'], {
          inlinePrompt: promptText,
        });
        return result.output;
      },
      implement: async (f, chunk, env): Promise<ChunkImplementResult> => {
        const result = await invoke(
          ctx,
          'worker',
          [
            `FEATURE_ID=${f.id}`,
            `CHUNK_ID=${chunk.id}`,
            'CHUNK_LOOP_STAGE=implement',
            `CHUNK_FILES=${chunk.files.join(',')}`,
            `CHUNK_DESCRIPTION=${chunk.description}`,
          ],
          {
            cwd: env.dir,
            inlinePrompt: chunkImplementInlinePrompt(f, chunk, env.dir),
          },
        );
        // Discover what the LLM actually wrote by walking git status.
        const touched = listChangedFiles(env.dir);
        return {
          touchedFiles: touched,
          attemptedChange: (result.output || '').slice(0, 1000),
        };
      },
      replan: async (f, failedId, failedFiles, failedDesc, typecheckError, attemptedChange) => {
        const promptText = replanChunkPrompt({
          featureId: f.id,
          failedChunk: { id: failedId, files: failedFiles, description: failedDesc },
          typecheckError,
          attemptedChange,
        });
        const result = await invoke(
          ctx,
          'worker',
          [`FEATURE_ID=${f.id}`, `CHUNK_ID=${failedId}`, 'CHUNK_LOOP_STAGE=replan'],
          { inlinePrompt: promptText },
        );
        return result.output;
      },
      escalate: async (f, chunkId, chunkFiles, typecheckError, role) => {
        // Hand off to the configured role (default 'debugger').
        // The role's existing prompt file applies — we just pass extras
        // so it knows what to investigate.
        try {
          await invoke(ctx, role, [
            `FEATURE_ID=${f.id}`,
            `CHUNK_ID=${chunkId}`,
            `CHUNK_FILES=${chunkFiles.join(',')}`,
            `TYPECHECK_ERROR_HEAD=${typecheckError.slice(0, 500)}`,
          ]);
        } catch (err) {
          logger.log(`CHUNK_LOOP escalate(${role}) failed: ${(err as Error).message}`);
          return false;
        }
        // Mark the feature failing so the user sees it; the escalated
        // role's output is a separate orchestrator turn that may
        // resolve it (e.g., debugger writes a diagnostic note → user
        // resets → next iteration retries).
        return false;
      },
    },
  });

  logger.log(`CHUNK_LOOP ${fid} → ${outcome.kind}`);

  if (outcome.kind === 'completed') {
    await setFeatureStatus(ctx.stateDir, fid, 'validating', { ctx: stateCtx(ctx) });
  } else if (outcome.kind === 'escalated' || outcome.kind === 'planning_failed' || outcome.kind === 'aborted') {
    await setFeatureStatus(ctx.stateDir, fid, 'failing', { ctx: stateCtx(ctx) });
  }

  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * Build the inline prompt for the worker's per-chunk implement call.
 * The worker sees: feature context, chunk metadata, the scratch dir
 * it should edit in, and clear instructions about the L1 invariant
 * and declared-files contract.
 */
function chunkImplementInlinePrompt(
  feature: ChunkLoopFeature,
  chunk: { id: string; files: readonly string[]; description: string },
  scratchDir: string,
): string {
  return `You are the WORKER. Implement ONE chunk of feature ${feature.id}.

Feature: ${feature.title}
${feature.description}

Chunk ${chunk.id}: ${chunk.description}
Declared files: ${chunk.files.join(', ')}

Working directory: ${scratchDir}

This is a transient scratch worktree at integration HEAD. Edit files
here in place — do NOT cd out, do NOT touch the main repo. Heavy
gitignored caches (node_modules, .next, target, etc.) are symlinked
back to the main repo so typecheckers see warm caches.

Constraints:
  - Modify ONLY the declared files. If you discover you need to touch
    additional files, you may — the harness handles lock extension —
    but be intentional about scope.
  - The chunk you commit must leave the project in a working state:
    the typecheck command will run after you finish, and a non-zero
    exit triggers a re-plan that bundles more work into this chunk.
  - When done, exit. The harness will copy your edits to the main
    repo, run the typecheck, and commit.

Do not produce a chunk-plan block — that was already done in the
planning stage. Just implement.`;
}

/**
 * Walk `git status --porcelain` in the scratch dir to find every
 * file the worker wrote (modified, added, or deleted). Returns paths
 * relative to the scratch dir (= relative to the main repo).
 */
function listChangedFiles(dir: string): string[] {
  const r = spawnSyncForGit('git', ['status', '--porcelain', '-z'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (r.status !== 0) return [];
  const out: string[] = [];
  // -z separates entries with NUL; each entry is "XY <path>" where XY
  // is the index/worktree status. Renames have an arrow-form we don't
  // bother with for our case (workers don't rename files via git mv).
  for (const entry of (r.stdout as string).split('\x00')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Entry shape: "XY path" — XY is two chars, then space, then path.
    const path = trimmed.length >= 3 ? trimmed.slice(3) : trimmed;
    if (path) out.push(path);
  }
  return out;
}

// ─── Bash-parity handlers for NEXT_EXPERT / NEXT_FEEDBACK / NEXT_SCOPER ──

/**
 * NEXT_EXPERT EXP-NNN — invokes the `expert` role for the given
 * instanced expert. Identity + state lives in
 * .harness/experts/<EXP-id>/. The invoke pipeline picks up
 * EXPERT_DIR / EXPERT_SPEC from EXPERT_ID via assembleRolePrompt.
 *
 * Mirrors run.sh's NEXT_EXPERT handler (line 2692).
 */
async function handleNextExpert(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
): Promise<DispatchResult> {
  const eid = parsed.arg ?? '';
  if (!eid) {
    logger.log('ERROR: NEXT_EXPERT missing expert id');
    return { terminal: false, exitCode: 0, reason: 'idle' };
  }
  logger.log(`EXPERT ${eid} starting`);
  try {
    await invoke(ctx, 'expert', [`FEATURE_ID=${eid}`, `EXPERT_ID=${eid}`]);
  } catch (err) {
    logger.log(`EXPERT ${eid} error: ${(err as Error).message}`);
  }
  logger.log(`EXPERT ${eid} iteration complete`);
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * NEXT_FEEDBACK EXP-NNN.FB-NNN — invokes the `feedback` role for one
 * feedback instance under an expert. The dot separator is forced by
 * the orchestrator's argument-character class (`.` is allowed; `/`
 * `:` aren't).
 *
 * Reads the persona from
 * `<stateDir>/experts/<EXP>/feedback/<FB>/persona.txt` so the
 * invocation context includes which lens to use.
 *
 * Mirrors run.sh's NEXT_FEEDBACK handler (line 2710).
 */
async function handleNextFeedback(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
): Promise<DispatchResult> {
  const fbArg = parsed.arg ?? '';
  if (!fbArg || !fbArg.includes('.')) {
    logger.log(`ERROR: NEXT_FEEDBACK expects EXP-NNN.FB-NNN; got '${fbArg}'`);
    return { terminal: false, exitCode: 0, reason: 'idle' };
  }
  const dotIdx = fbArg.indexOf('.');
  const eid = fbArg.slice(0, dotIdx);
  const fbid = fbArg.slice(dotIdx + 1);
  if (!eid || !fbid) {
    logger.log(`ERROR: NEXT_FEEDBACK expects EXP-NNN.FB-NNN; got '${fbArg}'`);
    return { terminal: false, exitCode: 0, reason: 'idle' };
  }
  let persona = '';
  const personaPath = join(ctx.stateDir, 'experts', eid, 'feedback', fbid, 'persona.txt');
  if (existsSync(personaPath)) {
    try {
      persona = readFileSync(personaPath, 'utf8').trim();
    } catch {
      // non-fatal — fall through with empty persona
    }
  }
  logger.log(`FEEDBACK ${eid}/${fbid} starting (persona=${persona})`);
  try {
    await invoke(ctx, 'feedback', [
      `FEEDBACK_ID=${fbid}`,
      `EXPERT_ID=${eid}`,
      `FEEDBACK_PERSONA=${persona}`,
    ]);
  } catch (err) {
    logger.log(`FEEDBACK ${eid}/${fbid} error: ${(err as Error).message}`);
  }
  logger.log(`FEEDBACK ${eid}/${fbid} iteration complete`);
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * NEXT_SCOPER [phaseN] — re-invokes the scoper. With no arg, runs the
 * default phase1; with `phase2`, derives features from finalized
 * experts. Idempotent — re-running with no new finalizations is a no-op.
 *
 * Mirrors run.sh's NEXT_SCOPER handler (line 2734).
 */
async function handleNextScoper(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
): Promise<DispatchResult> {
  const phase = parsed.arg ?? '';
  logger.log(`SCOPER starting${phase ? ` (phase=${phase})` : ''}`);
  try {
    const extras = phase ? [`SCOPER_PHASE=${phase}`] : [];
    await invoke(ctx, 'scoper', extras);
  } catch (err) {
    logger.log(`SCOPER error: ${(err as Error).message}`);
  }
  logger.log('SCOPER complete');
  return { terminal: false, exitCode: 0, reason: 'idle' };
}
