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
import { parseDecision } from './decision-parse';
import { invoke } from './invoke';
import { featureAttempts, readFeatures, setFeatureStatus } from './state';
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
import { runPreLoop } from './pre-loop';
import { checkpointGate } from './checkpoints';
import { firePluginHook } from './plugin-hooks';
import {
  competitionManifestPath,
  createLanePool,
  isAdaptiveMode,
  isCompetitionMode,
  isLaneMode,
  parallelAdaptiveTiers,
  parallelMaxWorkers,
  parallelMode,
  parallelWorkersPerFeature,
  parseCompetitionVerdict,
  readCompetitionManifest,
  writeCompetitionManifest,
  type AdaptiveTiers,
} from './lanes';
import type { LanePool } from './lanes';
import { git } from './git';
import { branchIsoBase, worktreePath } from './branch-iso';
import type { InvokeContext } from './invoke';
import type { Logger } from './log';
import type { ParsedDecision } from './decision-parse';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the harness slug for telemetry calls.
 *
 * The orchestrator process inherits HARNESS_SLUG from run.sh. When unset
 * (e.g. tests, ad-hoc invocations), fall back to the basename of the
 * project dir — matches the harness registry's slug derivation rule.
 */
function harnessSlug(ctx: InvokeContext): string {
  const fromEnv = process.env.HARNESS_SLUG ?? process.env.PAPERCUSP_HARNESS_SLUG;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return ctx.projectDir.split(/[\\/]/).filter(Boolean).pop() ?? 'unknown';
}

/**
 * Fetch global adaptive-mode tier settings from the operator API.
 *
 * Falls back to the static defaults when the API is unreachable so the
 * orchestrator never blocks on a flaky operator. Cached at module scope
 * for the lifetime of one main-loop run; tier edits via the settings UI
 * pick up on the next run.
 */
let _adaptiveSettingsCache: AdaptiveTiers | null = null;
async function fetchOrchestratorSettings(): Promise<AdaptiveTiers> {
  if (_adaptiveSettingsCache) return _adaptiveSettingsCache;
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${operatorBase}/api/settings/orchestrator`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = (await res.json()) as Partial<AdaptiveTiers>;
      const tiers = Array.isArray(data.tiers) ? data.tiers : [1, 2, 4];
      const labels = Array.isArray(data.labels) ? data.labels : ['trivial', 'normal', 'hard'];
      const rubric = typeof data.rubric === 'string' ? data.rubric : '';
      if (tiers.length >= 2 && tiers.length === labels.length) {
        _adaptiveSettingsCache = { tiers, labels, rubric };
        return _adaptiveSettingsCache;
      }
    }
  } catch {
    // fall through to defaults
  }
  _adaptiveSettingsCache = { tiers: [1, 2, 4], labels: ['trivial', 'normal', 'hard'], rubric: '' };
  return _adaptiveSettingsCache;
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
  _adaptiveSettingsCache = null;
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
  const cpAction = checkpointGate(ctx.stateDir);
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

  // Adaptive-mode tier configuration is global (DB-backed via the operator
  // settings API). Fetch once at startup so the orchestrator can include
  // the rubric + free-slot budget in its prompt every iteration. Falls
  // back to defaults if the API is unreachable.
  const adaptiveActive = isAdaptiveMode(cfg);
  const adaptiveTiers: AdaptiveTiers = adaptiveActive
    ? await fetchOrchestratorSettings()
    : parallelAdaptiveTiers(cfg);
  if (adaptiveActive) {
    logger.log(
      `ADAPTIVE: tiers=[${adaptiveTiers.tiers.join(', ')}] labels=[${adaptiveTiers.labels.join(', ')}] max=${parallelMaxWorkers(cfg)}`,
    );
  }

  // Fire Papercusp plugin lifecycle: beforeMissionStart.
  fireLifecycleHook(ctx, 'beforeMissionStart', logger.log);

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
    }

    // 1. Invoke the primary advancing role.
    const decisionResult = await invoke(ctx, primaryRole, orchestratorExtras);
    fireLifecycleHook(ctx, 'onPostOrchestrator', logger.log);
    const parsed = parseDecision(decisionResult.output);

    if (parsed === null) {
      logger.log(
        `ERROR: orchestrator returned unparsable decision: '${decisionResult.output.slice(0, 200)}'`,
      );
      logger.log('Aborting. Inspect logs and state, then rerun.');
      await lanePool.waitAll();
      return { exitCode: 4, reason: 'unparsable-decision', iterations: iteration };
    }

    logger.log(`ORCH decision: ${parsed.raw} (role=${primaryRole})`);

    // 2. Dispatch.
    const dispatch = await dispatchDecision(parsed, ctx, logger, cfg, iteration, sleep, lanePool);
    if (dispatch.terminal) {
      // Drain in-flight parallel lanes so they don't outlive this exit
      // (e.g. a worker writing to a directory the caller is about to clean up).
      await lanePool.waitAll();
      return { exitCode: dispatch.exitCode, reason: dispatch.reason, iterations: iteration };
    }

    // 3. Snapshot state (for UI rollback).
    snapshotState(ctx.stateDir, iteration, cfg);

    // 4. Prune oldest agent logs beyond logRetention.
    pruneLogs(ctx.logDir, cfg);

    // 5. Cost cap. Aborts the loop with exit code 6 when total >= cap.
    const cost = evaluateCostCap(cfg, ctx.logDir, ctx.stateDir);
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
      return handleCheckpoint(parsed, ctx, logger, iteration);

    case 'READY_FOR_PROD':
      return handleReadyForProd(ctx, logger);

    case 'NEXT_HARNESS':
      return handleNextHarness(parsed, ctx, logger);

    case 'NEXT_WORKER':
      return handleNextWorker(parsed, ctx, logger, cfg, lanePool);

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

  logger.log('Running documenter in consolidate mode.');
  try {
    const docOut = await invoke(ctx, 'documenter', ['TRIGGER=done', 'FEATURE_ID=-']);
    logger.log(`DOCUMENTER: ${(docOut.output || '').slice(0, 200) || '(no output)'}`);
  } catch (err) {
    logger.log(`DOCUMENTER error: ${(err as Error).message}`);
  }

  // (Skipping optional scoper-on-done + archive-on-done — minor polish.)

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
): Promise<DispatchResult> {
  const fid = parsed.arg ?? '';
  if (!fid) {
    logger.log(`ERROR: NEXT_WORKER without feature id: ${parsed.raw}`);
    return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
  }

  if (isAdaptiveMode(cfg)) {
    return handleAdaptiveWorker(parsed, fid, ctx, logger, cfg, lanePool);
  }
  if (isCompetitionMode(cfg)) {
    return handleCompetitionWorker(fid, ctx, logger, cfg, lanePool);
  }
  if (isLaneMode(cfg)) {
    return handleParallelLaneWorker(fid, ctx, logger, cfg, lanePool);
  }

  // Optional debugger before the worker.
  if (configGet<boolean>(cfg, 'debugger.enabled', true) === true) {
    const threshold = Number(configGet<unknown>(cfg, 'debugger.threshold', 3));
    const attempts = featureAttempts(ctx.stateDir, fid);
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
  setFeatureStatus(ctx.stateDir, fid, 'in_progress', { bumpAttempts: true });

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

  // Capture pre-validator status set so we can detect transitions to
  // 'passed' after the validator returns. Validator updates features.json
  // directly; this is the cheapest way to surface the per-feature event.
  const beforeStatus = new Map<string, string>();
  for (const f of readFeatures(ctx.stateDir)) beforeStatus.set(f.id, f.status);

  let validatorRc = 0;
  try {
    const r = await invoke(worktreedCtx, 'validator', [`FEATURE_ID=${fid}`]);
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
  for (const f of readFeatures(ctx.stateDir)) {
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
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * Competition-mode worker: spawn `workersPerFeature` workers on the SAME
 * feature in sibling git worktrees. Each worker grabs a slot from the
 * shared LanePool so multiple competitions can run concurrently across
 * different features (max=10 + workersPerFeature=2 → up to 5 simultaneous
 * 2-way competitions).
 *
 * Returns immediately after registering the lanes — the actual worker
 * Promise.all + manifest write happen in a void(async) IIFE so the
 * orchestrator can dispatch the next decision (another NEXT_WORKER for
 * a different feature, typically) while these workers run.
 *
 * The validator path drains lanes per-feature (waitForFeature(fid)) so
 * other features' competitions stay live while feature A is being
 * validated.
 */
async function handleCompetitionWorker(
  fid: string,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lanePool: LanePool,
): Promise<DispatchResult> {
  const max = parallelMaxWorkers(cfg);
  const perFeature = parallelWorkersPerFeature(cfg);
  // Clamp: can't run more workers per feature than max (would deadlock
  // the acquire loop). User-set workersPerFeature > max is a config
  // error; clamp + warn rather than hang.
  const effectivePer = Math.min(perFeature, max);
  if (effectivePer !== perFeature) {
    logger.log(
      `  competition: workersPerFeature=${perFeature} > max=${max}; clamping to ${effectivePer}`,
    );
  }
  logger.log(
    `COMPETITION: spawning ${effectivePer} workers on ${fid}` +
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
  setFeatureStatus(ctx.stateDir, fid, 'in_progress', { bumpAttempts: true });

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
    setFeatureStatus(ctx.stateDir, fid, 'validating');
    writeCompetitionManifest(ctx.stateDir, fid, effectivePer);
    logger.log(
      `COMPETITION: manifest ${competitionManifestPath(ctx.stateDir, fid)} written` +
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
  const tiers = await fetchOrchestratorSettings();
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

  // N>1: competition path. Wrap handleCompetitionWorker by overriding
  // workersPerFeature for this single dispatch via a synthetic config.
  // (handleCompetitionWorker reads parallelWorkersPerFeature(cfg); we
  // can't shadow it without a tweak, so call its core logic inline.)
  return handleCompetitionWorkerWithCount(fid, actualN, ctx, logger, cfg, lanePool);
}

/**
 * Competition-mode worker with an explicit count override.
 *
 * Extracted so adaptive mode can choose N per call instead of reading
 * the static `parallelWorkers.workersPerFeature` config. Logic mirrors
 * handleCompetitionWorker exactly — kept as a separate function instead
 * of refactoring to avoid destabilizing the existing competition path.
 */
async function handleCompetitionWorkerWithCount(
  fid: string,
  count: number,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lanePool: LanePool,
): Promise<DispatchResult> {
  const max = parallelMaxWorkers(cfg);
  const effectivePer = Math.min(count, max);
  logger.log(
    `COMPETITION (adaptive): spawning ${effectivePer} workers on ${fid}` +
      ` (pool ${lanePool.count()}/${max} before this)`,
  );
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
  setFeatureStatus(ctx.stateDir, fid, 'in_progress', { bumpAttempts: true });

  const branchIsoCtx = {
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log: logger.log,
  };
  const base = branchIsoBase(branchIsoCtx);
  const worktreesRoot = join(ctx.stateDir, 'worktrees');
  mkdirSync(worktreesRoot, { recursive: true });

  const laneIds: number[] = [];
  for (let i = 1; i <= effectivePer; i++) {
    laneIds.push(await lanePool.acquire(fid));
  }

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
        git(['add', '-A'], { cwd: wt });
        const status = git(['diff', '--cached', '--quiet'], { cwd: wt });
        if (status.exitCode !== 0) {
          const r = git(
            ['commit', '--quiet', '-m', `worker: ${laneFid} (competition lane ${laneNum})`],
            { cwd: wt },
          );
          if (r.outputHead(3)) logger.log(`  ${r.outputHead(3)}`);
        }
        lanePool.release(laneId);
      })();
      lanePromises.push(lanePromise);
    }

    await Promise.all(lanePromises);

    setFeatureStatus(ctx.stateDir, fid, 'validating');
    writeCompetitionManifest(ctx.stateDir, fid, effectivePer);
    logger.log(
      `COMPETITION (adaptive): manifest ${competitionManifestPath(ctx.stateDir, fid)} written` +
        ` (${effectivePer}-way for ${fid})`,
    );
  })();

  return { terminal: false, exitCode: 0, reason: 'idle' };
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
  setFeatureStatus(ctx.stateDir, fid, 'in_progress', { bumpAttempts: true });

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
    setFeatureStatus(ctx.stateDir, fid, 'validating');
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
function handleCheckpoint(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  iteration: number,
): DispatchResult {
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
  writeFileSync(cpFile, body);

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
function handleReadyForProd(ctx: InvokeContext, logger: Logger): DispatchResult {
  const flagPath = join(ctx.stateDir, 'ready-for-prod.flag');
  writeFileSync(flagPath, `${new Date().toISOString()}\n`);
  logger.log('READY_FOR_PROD — flag written for promotion pipeline.');
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
    const ts = Math.floor(Date.now() / 1000);
    const out = join(ctx.logDir, `nexth-${childSlug}-${ts}.json`);
    writeFileSync(out, apiOk.body);
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
    setFeatureStatus(ctx.stateDir, fid, 'todo', { resetAttempts: true });
    logger.log(`ARCHITECT patched spec for ${fid}; reset to todo.`);
  } else if (verdict.startsWith('REVIEW')) {
    setFeatureStatus(ctx.stateDir, fid, 'blocked');
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
