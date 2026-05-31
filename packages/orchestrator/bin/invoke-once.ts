#!/usr/bin/env -S npx tsx
/**
 * Single-invoke CLI — ports the bash pattern
 *
 *   source <(awk '/^(invoke)\(\)/,/^}/' "$HARNESS_DIR/run.sh")
 *   invoke <role> EXTRAS...
 *
 * to a TypeScript entry. Reads role + extras from env (plus the usual
 * PROJECT_DIR / STATE_DIR / HARNESS_DIR), constructs an InvokeContext,
 * and runs `invoke()` once.
 *
 * Used by the operator's scoper-background and direct-invoke endpoints
 * so they no longer need to source bash function library from run.sh.
 *
 * Env contract:
 *   PROJECT_DIR        (required)
 *   STATE_DIR          default <PROJECT_DIR>/.harness
 *   HARNESS_DIR        default resolved via @papercusp/harness/paths
 *   ROLE               (required)
 *   EXTRAS_JSON        JSON array of "K=V" strings (optional)
 *   RESULT_PATH        if set, stdout is teed to this file; sentinel
 *                      `__INVOCATION_DONE__` is appended on exit.
 *   MAX_ITERATIONS     informational only (the harness uses this
 *                      elsewhere; ignored here since we run exactly one
 *                      invoke).
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { harnessRoot } from '@papercusp/harness/paths';
import { readConfig, resolvePhase } from '../src/config.js';
import { resolveAgentBackend, resolveAgentCmd } from '../src/env.js';
import { createLogger } from '../src/log.js';
import { invoke } from '../src/invoke.js';
import { bootstrapOrchestratorPg } from '../src/pg-bootstrap.js';
import { activeWorkspaceId } from '../src/workspace.js';
import { harnessSlug } from '../src/state.js';

async function main(): Promise<number> {
  const projectDir = process.env.PROJECT_DIR;
  const role = process.env.ROLE;
  if (!projectDir || !role) {
    process.stderr.write(
      'invoke-once: PROJECT_DIR and ROLE env vars are required\n',
    );
    return 2;
  }

  const stateDir = process.env.STATE_DIR ?? `${projectDir}/.harness`;
  const harnessDir = process.env.HARNESS_DIR ?? harnessRoot();
  const logDir = `${stateDir}/logs`;

  let extras: string[] = [];
  if (process.env.EXTRAS_JSON) {
    try {
      const parsed = JSON.parse(process.env.EXTRAS_JSON);
      if (Array.isArray(parsed)) {
        extras = parsed.filter((s) => typeof s === 'string');
      }
    } catch {
      process.stderr.write('invoke-once: EXTRAS_JSON malformed; ignoring\n');
    }
  }

  const resultPath = process.env.RESULT_PATH ?? '';
  if (resultPath) {
    mkdirSync(dirname(resultPath), { recursive: true });
    if (!existsSync(resultPath)) writeFileSync(resultPath, '');
  }

  // Ensure log dir exists so createLogger can write run.log.
  mkdirSync(logDir, { recursive: true });

  const cfg = readConfig(stateDir);
  const { phase } = resolvePhase(cfg);
  const claudeCmd = resolveAgentCmd();
  const agentBackend = resolveAgentBackend(claudeCmd);

  const logger = createLogger(stateDir);

  // Tee stdout/stderr to RESULT_PATH if requested. The bash version did
  // this via `2>&1 | tee`; mirror it here so callers polling the file
  // see the same output.
  let teeAppend: ((line: string) => void) | undefined;
  if (resultPath) {
    teeAppend = (line: string) => {
      try { appendFileSync(resultPath, line.endsWith('\n') ? line : line + '\n'); } catch { /* best-effort */ }
    };
  }

  // Wrap logger.log so its messages also tee to RESULT_PATH (mirrors
  // bash run.sh's `tee` behavior).
  const wrappedLog = (msg: string): void => {
    logger.log(msg);
    teeAppend?.(msg);
  };

  // Optional PG bootstrap (same as bin/run.ts).
  const slug = harnessSlug(projectDir);
  const pgBoot = await bootstrapOrchestratorPg(wrappedLog, { harnessSlug: slug });
  const workspaceId = pgBoot.pg ? activeWorkspaceId() : undefined;

  let exitCode = 0;
  try {
    const result = await invoke(
      {
        harnessDir,
        projectDir,
        stateDir,
        logDir,
        phase,
        claudeCmd,
        agentBackend,
        log: wrappedLog,
        ...(pgBoot.pg ? { pg: pgBoot.pg, workspaceId } : {}),
      },
      role,
      extras,
      // dbos-durable-jobs Phase 3 P-015: when the durable pipeline spawns
      // invoke-once with IDEMPOTENCY_KEY set, invoke() keys the run row by it
      // and reuses a prior completed run instead of re-spawning the agent.
      process.env.IDEMPOTENCY_KEY ? { idempotencyKey: process.env.IDEMPOTENCY_KEY } : {},
    );
    if (typeof result.output === 'string' && result.output.length > 0) {
      // Surface the agent's actual output to stdout so callers reading
      // the result file (or the spawn's stdout) see the decision line.
      process.stdout.write(result.output);
      teeAppend?.(result.output);
    }
    exitCode = result.exitCode ?? 0;
  } catch (err) {
    process.stderr.write(
      `invoke-once: invoke threw: ${(err as Error).message}\n`,
    );
    exitCode = 1;
  } finally {
    if (pgBoot.cleanup) await pgBoot.cleanup();
    if (teeAppend) teeAppend('__INVOCATION_DONE__');
  }
  return exitCode;
}

main()
  .then((rc) => process.exit(rc))
  .catch((err) => {
    process.stderr.write(
      `invoke-once: uncaught: ${(err as Error).message}\n`,
    );
    process.exit(1);
  });
