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
import type { InvokeContext } from './invoke.js';
import type { Logger } from './log.js';
import type { ParsedDecision } from './decision-parse.js';
import { existsSync } from 'node:fs';
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
    const dispatch = await dispatchDecision(parsed, ctx, logger, cfg, iteration);
    if (dispatch.terminal) {
      return { exitCode: dispatch.exitCode, reason: dispatch.reason, iterations: iteration };
    }

    // 3. Snapshot / prune / cost cap — Stage 5 will port these. Stage 2b
    //    omits them so a partial port doesn't double-write state.

    // 4. Sleep.
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
): Promise<DispatchResult> {
  switch (parsed.verb) {
    case 'DONE':
      return handleDone(ctx, logger, cfg, iteration);

    case 'IDLE':
      logger.log('IDLE — primary role reports nothing to do this iteration.');
      // bash continues the loop on IDLE (used by org/department primary roles).
      return { terminal: false, exitCode: 0, reason: 'idle' };

    case 'ESCALATE':
      logger.log('🔔 ESCALATE — surfacing to operator.');
      logger.notifyEvent('escalate', parsed.raw);
      return { terminal: true, exitCode: 9, reason: 'escalate' };

    case 'CHECKPOINT':
      logger.log('⏸  CHECKPOINT — primary role requested a pause for grant.');
      logger.notifyEvent('checkpoint', parsed.raw);
      return { terminal: true, exitCode: 8, reason: 'checkpoint' };

    case 'NEXT_WORKER':
      return handleNextWorker(parsed, ctx, logger, cfg);

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

    case 'CONVERTED':
      logger.log('Orchestrator converted issues to fix features. Continuing.');
      return { terminal: false, exitCode: 0, reason: 'idle' };

    case 'FEATURE_FREEZE':
      logger.log(`FEATURE_FREEZE: ${parsed.raw}`);
      return { terminal: false, exitCode: 0, reason: 'idle' };

    case 'RUN_TESTS':
      return handleRunTests(ctx, logger);

    // Verbs that need subsystem ports (worktree / hooks / action blocks /
    // sub-harness spawn). Stay on bash until those land.
    case 'NEXT_WORKER_CEO_MODE':
    case 'NEXT_ARCHITECT':
    case 'READY_FOR_PROD':
    case 'NEXT_HARNESS':
      logger.log(
        `TODO: ${parsed.verb} branch not yet ported — falling back to bash run.sh`,
      );
      return { terminal: true, exitCode: 0, reason: 'todo-branch' };

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
    if (smokeRc === 0) {
      logger.log('Smoke test PASSED.');
      // run_hook on-smoke-pass — Stage 4 will port the hook system; for now
      // we log and skip.
    } else {
      logger.log('Smoke test FAILED — feature reopened. Re-entering loop.');
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
 * Returns true if any of the complex-config flags is on. Stage 2c handles
 * only the sequential, no-branch-iso path; everything else flows back to
 * bash run.sh until Stage 3 ports the worktree subsystem.
 */
function isComplexConfig(cfg: ReturnType<typeof readConfig>): boolean {
  return (
    configGet<boolean>(cfg, 'branchIsolation.enabled', false) === true ||
    configGet<boolean>(cfg, 'branchIsolation.useWorktrees', false) === true ||
    Number(configGet<unknown>(cfg, 'parallelWorkers.max', 1)) > 1 ||
    configGet<string>(cfg, 'parallelWorkers.mode', 'lane') === 'competition'
  );
}

/**
 * NEXT_WORKER handler. Stage 2c implements only the sequential, no-branch-iso,
 * no-parallel path:
 *
 *   - optional debugger if attempts ≥ threshold AND no debug note exists
 *   - log "WORKER <fid> starting"
 *   - invoke worker
 *
 * If the config has branchIsolation / worktrees / parallel / competition,
 * fall through to bash run.sh. Stage 3 will port those subsystems.
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
  if (isComplexConfig(cfg)) {
    logger.log(
      `NEXT_WORKER ${fid}: complex config (branch-iso/worktrees/parallel) ` +
        'not yet ported — falling back to bash',
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

  logger.log(`WORKER ${fid} starting`);
  setFeatureStatus(ctx.stateDir, fid, 'in_progress', { bumpAttempts: true });
  try {
    await invoke(ctx, 'worker', [`FEATURE_ID=${fid}`]);
  } catch (err) {
    logger.log(`WORKER error: ${(err as Error).message}`);
  }
  // bash continues the loop after the worker — validator runs on a later
  // iteration when the orchestrator decides NEXT_VALIDATOR.
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * NEXT_VALIDATOR handler. Stage 2c implements only the sequential,
 * no-branch-iso path — same as NEXT_WORKER. Complex configs fall back.
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
  if (isComplexConfig(cfg)) {
    logger.log(
      `NEXT_VALIDATOR ${fid}: complex config not yet ported — falling back to bash`,
    );
    return { terminal: true, exitCode: 0, reason: 'todo-branch' };
  }

  logger.log(`VALIDATOR ${fid} starting`);
  try {
    await invoke(ctx, 'validator', [`FEATURE_ID=${fid}`]);
  } catch (err) {
    logger.log(`VALIDATOR error: ${(err as Error).message}`);
  }
  // The validator agent is responsible for updating the feature's status to
  // passed/failed via filesystem writes (run.sh's bash equivalent doesn't
  // post-process the validator's exit code either; it relies on the agent's
  // markdown output to update features.json on the next orchestrator turn).
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
