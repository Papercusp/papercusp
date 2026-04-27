#!/usr/bin/env -S npx tsx
/**
 * Orchestrator CLI entry point. Equivalent to invoking
 * `bash <harness>/run.sh`, but routes through the TypeScript implementation
 * when `PAPERCUSP_USE_TS_ORCHESTRATOR=1` is set.
 *
 * Until Stage 4 lands the main loop port, the TS branch falls through to
 * bash. This means setting the env var today is a no-op — it'll start
 * doing real work as later stages land.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolvePaths } from '../src/env.js';
import { createLogger } from '../src/log.js';

const useTs = process.env.PAPERCUSP_USE_TS_ORCHESTRATOR === '1';
const { harnessDir, projectDir, stateDir } = resolvePaths();
const runShPath = `${harnessDir}/run.sh`;

if (!existsSync(runShPath)) {
  process.stderr.write(
    `[papercusp-orchestrate] ERROR: ${runShPath} not found.\n` +
      'Set PAPERCUSP_HARNESS_DIR or place the @papercusp/harness package on disk.\n',
  );
  process.exit(2);
}

if (useTs) {
  // Stage 4+ will live here — the TS main loop. For now, log that the flag
  // was honored and fall through to bash so we exercise the dispatch.
  const log = createLogger(stateDir);
  log.log('PAPERCUSP_USE_TS_ORCHESTRATOR=1 set — TS port handoff active');
  log.log(
    'Stage 0 only: read-only utilities are TS, the iteration loop still ' +
      'runs through bash run.sh until later stages port it.',
  );
}

// Spawn bash run.sh with the same env it would have inherited from a direct
// shell invocation. Inherit stdio so the parent's terminal sees live output.
const child = spawn('bash', [runShPath], {
  cwd: projectDir,
  env: {
    ...process.env,
    HARNESS_DIR: harnessDir,
    PROJECT_DIR: projectDir,
  },
  stdio: 'inherit',
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  process.stderr.write(
    `[papercusp-orchestrate] failed to spawn bash: ${err.message}\n`,
  );
  process.exit(127);
});
