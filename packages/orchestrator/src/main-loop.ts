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
 * Stage 2b ships the loop scaffolding + the simple decision branches
 * (DONE / IDLE / ESCALATE / CHECKPOINT). The complex branches
 * (NEXT_WORKER family, NEXT_VALIDATOR, NEXT_HARNESS) currently emit a
 * "TODO: not yet ported" log and fall through to bash run.sh via the
 * fallback path in bin/run.ts.
 */
import { spawnSync } from 'node:child_process';
import { configGet, readConfig } from './config.js';
import { parseDecision } from './decision-parse.js';
import { invoke } from './invoke.js';
import { featureAttempts, setFeatureStatus } from './state.js';
import {
  branchIsoPostValidator,
  branchIsoPostWorker,
  branchIsoPreValidator,
  branchIsoPreWorker,
  worktreeEnabled,
  worktreePath,
} from './branch-iso.js';
import { runHook } from './hooks.js';
import { processActionsBlock } from './actions-block.js';
import { evaluateCostCap } from './cost-cap.js';
import { pruneLogs } from './prune-logs.js';
import { snapshotState } from './snapshot-state.js';
import type { InvokeContext } from './invoke.js';
import type { Logger } from './log.js';
import type { ParsedDecision } from './decision-parse.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
    | 'todo-branch'; // ports incomplete — fall back to bash
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
}

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/** Run the orchestrator loop until exit. Returns when bash would exit. */
export async function runMainLoop(opts: MainLoopOptions): Promise<MainLoopExit> {
  const { ctx, logger, maxIterations } = opts;
  const sleep = opts.sleepFn ?? defaultSleep;
  const cfg = readConfig(ctx.stateDir);
  const primaryRole = configGet<string>(cfg, 'primaryRole', 'orchestrator');

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    logger.log(`── iteration ${iteration} ──`);

    // 1. Invoke the primary advancing role.
    const decisionResult = await invoke(ctx, primaryRole);
    const parsed = parseDecision(decisionResult.output);

    if (parsed === null) {
      logger.log(
        `ERROR: orchestrator returned unparsable decision: '${decisionResult.output.slice(0, 200)}'`,
      );
      logger.log('Aborting. Inspect logs and state, then rerun.');
      return { exitCode: 4, reason: 'unparsable-decision', iterations: iteration };
    }

    logger.log(`ORCH decision: ${parsed.raw} (role=${primaryRole})`);

    // 2. Dispatch.
    const dispatch = await dispatchDecision(parsed, ctx, logger, cfg, iteration, sleep);
    if (dispatch.terminal) {
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
 *
 * Stage 2b implements the simple branches inline. The complex branches
 * (NEXT_WORKER family) return terminal=true with reason='todo-branch' so
 * the caller's fallback path can hand off to bash run.sh.
 */
async function dispatchDecision(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  iteration: number,
  sleep: (ms: number) => Promise<void>,
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
      return handleNextWorker(parsed, ctx, logger, cfg);

    case 'NEXT_WORKER_CEO_MODE':
      return handleNextWorkerCeoMode(parsed, ctx, logger, cfg);

    case 'NEXT_VALIDATOR':
      return handleNextValidator(parsed, ctx, logger, cfg);

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

  // Skip the optional scoper-on-done + archive-on-done + plugin-hooks for
  // Stage 2b (Stage 4 + 5 add them). Bash run.sh covers them on the bash
  // path; we just won't emit the events from TS yet.

  logger.notifyEvent('done', `Mission complete: all features passed after ${iteration} iterations`);
  return { terminal: true, exitCode: 0, reason: 'done' };
}

/**
 * Returns true if a feature-level subsystem we haven't ported yet is on.
 * Currently: parallel-lane and competition-mode. (Branch isolation +
 * worktrees ARE ported as of Stage 3.)
 */
function isParallelOrCompetition(cfg: ReturnType<typeof readConfig>): boolean {
  return (
    Number(configGet<unknown>(cfg, 'parallelWorkers.max', 1)) > 1 ||
    configGet<string>(cfg, 'parallelWorkers.mode', 'lane') === 'competition'
  );
}

/**
 * NEXT_WORKER handler. Stage 3 wires in branch isolation + worktrees:
 *
 *   - optional debugger if attempts ≥ threshold AND no debug note exists
 *   - branchIsoPreWorker (creates branch or worktree)
 *   - log "WORKER <fid> starting"
 *   - invoke worker (with worktree cwd if applicable)
 *   - branchIsoPostWorker (commits in branch or worktree)
 *
 * Parallel-lane / competition mode still falls back to bash — those need
 * lane-management subsystems (Stage 5+).
 */
async function handleNextWorker(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
): Promise<DispatchResult> {
  const fid = parsed.arg ?? '';
  if (!fid) {
    logger.log(`ERROR: NEXT_WORKER without feature id: ${parsed.raw}`);
    return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
  }
  if (isParallelOrCompetition(cfg)) {
    logger.log(
      `NEXT_WORKER ${fid}: parallel-lane/competition not yet ported — falling back to bash`,
    );
    return { terminal: true, exitCode: 0, reason: 'todo-branch' };
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

  branchIsoPostWorker(branchIsoCtx, fid);
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * NEXT_VALIDATOR handler. Stage 3 wires in branch isolation + worktrees:
 *
 *   - branchIsoPreValidator (switches to feature branch / logs worktree)
 *   - log "VALIDATOR <fid> starting"
 *   - invoke validator (with worktree cwd if applicable)
 *   - branchIsoPostValidator (merges/PRs/keeps on PASS)
 */
async function handleNextValidator(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
): Promise<DispatchResult> {
  const fid = parsed.arg ?? '';
  if (!fid) {
    logger.log(`ERROR: NEXT_VALIDATOR without feature id: ${parsed.raw}`);
    return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
  }
  if (isParallelOrCompetition(cfg)) {
    logger.log(
      `NEXT_VALIDATOR ${fid}: parallel/competition not yet ported — falling back to bash`,
    );
    return { terminal: true, exitCode: 0, reason: 'todo-branch' };
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

  // Validator updates features.json itself; branchIsoPostValidator reads
  // the (possibly-just-changed) status and merges/PRs on PASS.
  branchIsoPostValidator(branchIsoCtx, fid);
  return { terminal: false, exitCode: 0, reason: 'idle' };
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
  await processActionsBlock({
    stdout: workerOut,
    callingDept: callingDept || undefined,
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

  const apiUrl = `http://localhost:3001/api/harness/${childSlug}/invoke?role=${childRole}`;
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
 * Look up a child harness's project dir from `~/.restart-harness-projects.json`.
 * Mirrors bash's python heredoc.
 */
function lookupHarnessPath(slug: string): string | null {
  const registryPath = join(process.env.HOME ?? '', '.restart-harness-projects.json');
  if (!existsSync(registryPath)) return null;
  try {
    const data = JSON.parse(readFileSync(registryPath, 'utf8'));
    const projects = (data?.projects ?? []) as Array<{ slug?: string; path?: string }>;
    const match = projects.find((p) => p.slug === slug);
    return match?.path ?? null;
  } catch {
    return null;
  }
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
