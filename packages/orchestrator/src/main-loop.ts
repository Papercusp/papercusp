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
import type { InvokeContext } from './invoke.js';
import type { Logger } from './log.js';
import type { ParsedDecision } from './decision-parse.js';

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

    // The rest of the verbs require complex per-feature branching that
    // Stages 2c+ will port. For now, signal "fall through to bash".
    case 'NEXT_WORKER':
    case 'NEXT_WORKER_CEO_MODE':
    case 'NEXT_VALIDATOR':
    case 'NEXT_ARCHITECT':
    case 'NEXT_TESTER':
    case 'NEXT_SECURITY':
    case 'GENERATE_TESTS':
    case 'RUN_TESTS':
    case 'NEXT_MONITOR':
    case 'READY_FOR_PROD':
    case 'FEATURE_FREEZE':
    case 'NEXT_HARNESS':
    case 'CONVERTED':
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
