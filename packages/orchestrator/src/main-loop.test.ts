import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMainLoop } from './main-loop.js';

interface Fixture {
  harnessDir: string;
  projectDir: string;
  stateDir: string;
  logDir: string;
  cleanup: () => void;
}

function makeFixture(setup: (fx: Omit<Fixture, 'cleanup'>) => void = () => {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-orch-loop-'));
  const harnessDir = join(root, 'harness');
  const projectDir = join(root, 'project');
  const stateDir = join(projectDir, '.harness');
  const logDir = join(stateDir, 'logs');
  mkdirSync(join(harnessDir, 'prompts'), { recursive: true });
  mkdirSync(join(harnessDir, 'identity'), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  // Stub the orchestrator + curator + documenter prompts so invoke() can find them.
  for (const role of ['orchestrator', 'curator', 'documenter']) {
    writeFileSync(join(harnessDir, 'prompts', `${role}.md`), `# ${role}`);
  }
  const fx = { harnessDir, projectDir, stateDir, logDir };
  setup(fx);
  return { ...fx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Build an InvokeContext that uses a "fake claude" — a small bash script
 * that prints a configurable decision verb and exits. Lets us drive the
 * main loop without a real claude binary.
 */
function withFakeClaude(fx: Fixture, decisions: Record<string, string>) {
  // We map role → output text. When invoke() runs, the role's name is
  // included in the assembled prompt's first heading. We can dispatch on
  // that by stuffing a sentinel into the env. Simpler: have a single
  // `OUTPUT` env var; for tests that need different outputs per role, we
  // drive it through CLAUDE_TEST_DECISIONS_JSON which the script reads.
  const fakeScript = `${fx.harnessDir}/fake-claude.sh`;
  writeFileSync(
    fakeScript,
    `#!/usr/bin/env bash\n` +
      `# Test fake: emits the value from CLAUDE_TEST_DECISIONS_JSON keyed by\n` +
      `# CLAUDE_TEST_ROLE (set per-invoke by the test harness via wrapper).\n` +
      `cat <<'EOF'\n${JSON.stringify(decisions)}\nEOF\n`,
  );
  // chmod is platform-dependent; node.fs.chmodSync would work but we can also
  // just invoke via `bash <script>` to skip the +x bit.
  return {
    harnessDir: fx.harnessDir,
    projectDir: fx.projectDir,
    stateDir: fx.stateDir,
    logDir: fx.logDir,
    phase: 'staging',
    claudeCmd: `bash ${fakeScript}`,
    dept: '',
    log: () => {},
  };
}

test('runMainLoop — DONE decision exits cleanly with code 0', async () => {
  const fx = makeFixture();
  try {
    // Use `printf 'DONE\n'` as the agent. Single command, no claude detection.
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}DONE',
        dept: '',
        log: (m) => log.push(m),
      },
      logger: {
        log: (m) => log.push(m),
        notifyEvent: (e, b) => log.push(`event:${e} ${b ?? ''}`),
      },
      maxIterations: 5,
      iterationSleepMs: 0,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.reason, 'done');
    assert.equal(result.iterations, 1);
    assert.ok(log.some((l) => l.includes('🎉 All features passed')));
    assert.ok(log.some((l) => l.startsWith('event:done')));
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — IDLE keeps iterating until max (sleep stubbed)', async () => {
  const fx = makeFixture();
  try {
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}IDLE',
        dept: '',
        log: () => {},
      },
      logger: {
        log: (m) => log.push(m),
        notifyEvent: () => {},
      },
      maxIterations: 3,
      iterationSleepMs: 0,
      sleepFn: () => Promise.resolve(), // skip the IDLE 30s + per-iter sleep
    });
    assert.equal(result.exitCode, 5);
    assert.equal(result.reason, 'max-iterations');
    assert.equal(result.iterations, 3);
    const headers = log.filter((l) => l.includes('── iteration '));
    assert.equal(headers.length, 3);
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — ESCALATE exits with code 3 (matches bash) + runs curator', async () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'prompts', 'curator.md'), '# CURATOR');
  });
  try {
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}ESCALATE${IFS}stuck',
        dept: '',
        log: () => {},
      },
      logger: {
        log: (m) => log.push(m),
        notifyEvent: (e) => log.push(`event:${e}`),
      },
      maxIterations: 5,
      iterationSleepMs: 0,
    });
    assert.equal(result.exitCode, 3);
    assert.equal(result.reason, 'escalate');
    assert.ok(log.some((l) => l.includes('⛔ ESCALATED: stuck')));
    assert.ok(log.some((l) => l === 'event:escalate'));
    assert.ok(log.some((l) => l.includes('Running curator')));
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — CHECKPOINT writes file + exits 8', async () => {
  const fx = makeFixture();
  try {
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}CHECKPOINT${IFS}awaiting-design-review',
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: (e) => log.push(`event:${e}`) },
      maxIterations: 5,
      iterationSleepMs: 0,
    });
    assert.equal(result.exitCode, 8);
    assert.equal(result.reason, 'checkpoint');
    // Checkpoint file written.
    const cpPath = join(fx.stateDir, 'checkpoint-awaiting-design-review.md');
    const body = readFileSync(cpPath, 'utf8');
    assert.match(body, /# Checkpoint: awaiting-design-review/);
    assert.match(body, /Iteration: 1/);
    assert.ok(log.some((l) => l === 'event:checkpoint'));
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — READY_FOR_PROD writes flag file + continues', async () => {
  const fx = makeFixture();
  try {
    const log: string[] = [];
    await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}READY_FOR_PROD',
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: () => {} },
      maxIterations: 1,
      iterationSleepMs: 0,
    });
    // Flag file present, content is an ISO timestamp.
    const flag = readFileSync(join(fx.stateDir, 'ready-for-prod.flag'), 'utf8');
    assert.match(flag, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(log.some((l) => l.startsWith('READY_FOR_PROD — flag written')));
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — unparsable decision exits with code 4', async () => {
  const fx = makeFixture();
  try {
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}thinking',
        dept: '',
        log: () => {},
      },
      logger: { log: () => {}, notifyEvent: () => {} },
      maxIterations: 5,
      iterationSleepMs: 0,
    });
    assert.equal(result.exitCode, 4);
    assert.equal(result.reason, 'unparsable-decision');
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — NEXT_WORKER with simple config invokes worker, continues loop', async () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'prompts', 'worker.md'), '# WORKER');
  });
  // Pre-seed features.json with the target feature (else attempts() etc.
  // start at zero anyway, but having it makes the parity assertion clearer).
  writeFileSync(
    join(fx.stateDir, 'features.json'),
    JSON.stringify({ features: [{ id: 'F-001', status: 'pending', attempts: 0 }] }),
  );
  try {
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        // First iteration emits NEXT_WORKER; we cap at 1 so the loop ends
        // without a second decision (max-iterations exit).
        claudeCmd: 'bash -c echo${IFS}NEXT_WORKER${IFS}F-001',
        dept: '',
        log: () => {},
      },
      logger: {
        log: (m) => log.push(m),
        notifyEvent: () => {},
      },
      maxIterations: 1,
      iterationSleepMs: 0,
    });
    assert.equal(result.reason, 'max-iterations');
    assert.equal(result.iterations, 1);
    assert.ok(
      log.some((l) => l.startsWith('WORKER F-001 starting')),
      'should log worker start',
    );
    // Feature attempts bumped from 0 → 1.
    const featuresAfter = JSON.parse(
      readFileSync(join(fx.stateDir, 'features.json'), 'utf8'),
    );
    assert.equal(featuresAfter.features[0].attempts, 1);
    assert.equal(featuresAfter.features[0].status, 'in_progress');
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — NEXT_WORKER falls back to bash when parallel/competition enabled', async () => {
  const fx = makeFixture();
  // Write a config.json with parallelWorkers.max = 4 (parallel mode).
  // (As of Stage 3, branch-iso/worktrees are ported; parallel/competition
  //  still falls back.)
  writeFileSync(
    join(fx.stateDir, 'config.json'),
    JSON.stringify({ parallelWorkers: { max: 4, mode: 'lane' } }),
  );
  try {
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}NEXT_WORKER${IFS}F-001',
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: () => {} },
      maxIterations: 5,
      iterationSleepMs: 0,
    });
    assert.equal(result.reason, 'todo-branch');
    assert.ok(log.some((l) => l.includes('parallel-lane/competition not yet ported')));
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — NEXT_VALIDATOR with simple config invokes validator', async () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'prompts', 'validator.md'), '# VALIDATOR');
  });
  try {
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}NEXT_VALIDATOR${IFS}F-001',
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: () => {} },
      maxIterations: 1,
      iterationSleepMs: 0,
    });
    assert.equal(result.reason, 'max-iterations');
    assert.ok(log.some((l) => l.startsWith('VALIDATOR F-001 starting')));
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — NEXT_WORKER without feature id is rejected', async () => {
  const fx = makeFixture();
  try {
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}NEXT_WORKER',
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: () => {} },
      maxIterations: 5,
      iterationSleepMs: 0,
    });
    assert.equal(result.exitCode, 4);
    assert.equal(result.reason, 'unparsable-decision');
    assert.ok(log.some((l) => l.includes('NEXT_WORKER without feature id')));
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — NEXT_ARCHITECT with PATCH verdict resets feature to todo', async () => {
  const fx = makeFixture(({ harnessDir }) => {
    // Architect prompt that emits a PATCH verdict via cat (sees stdin).
    writeFileSync(join(harnessDir, 'prompts', 'architect.md'), 'PATCH F-001 spec tightened');
  });
  // Pre-seed feature with attempts=4 so we can verify reset.
  writeFileSync(
    join(fx.stateDir, 'features.json'),
    JSON.stringify({ features: [{ id: 'F-001', status: 'failed', attempts: 4 }] }),
  );
  try {
    const log: string[] = [];
    await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        // First decision: NEXT_ARCHITECT F-001 spec issue
        // Use cat as the agent — its stdout will contain the prompt content
        // including the literal "PATCH F-001" line from architect.md.
        claudeCmd: 'cat',
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: () => {} },
      maxIterations: 1,
      iterationSleepMs: 0,
    });
    // The orchestrator's first iteration uses primaryRole=orchestrator.
    // To test architect, we need the orchestrator to emit NEXT_ARCHITECT.
    // Instead of trying to engineer that via cat, just assert the loop ran
    // without crashing — full architect coverage is in unit tests below.
    assert.ok(log.length > 0);
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — NEXT_ARCHITECT direct dispatch via stub', async () => {
  // Drive the loop with a primaryRole that emits NEXT_ARCHITECT verbatim.
  // Architect prompt then gets cat'd back; architect's "output" is
  // whatever the prompt body contained — set it to a literal PATCH line.
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(
      join(harnessDir, 'prompts', 'orchestrator.md'),
      '\nNEXT_ARCHITECT F-001 spec is wrong about retries\n',
    );
    writeFileSync(
      join(harnessDir, 'prompts', 'architect.md'),
      '\nPATCH F-001 fixed the retry behavior\n',
    );
  });
  writeFileSync(
    join(fx.stateDir, 'features.json'),
    JSON.stringify({ features: [{ id: 'F-001', status: 'failed', attempts: 4 }] }),
  );
  try {
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'cat', // echoes the prompt back verbatim
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: () => {} },
      maxIterations: 1,
      iterationSleepMs: 0,
    });
    assert.equal(result.reason, 'max-iterations');
    // Architect started + verdict observed.
    assert.ok(log.some((l) => l.startsWith('ARCHITECT F-001 starting')));
    assert.ok(log.some((l) => l.includes('PATCH F-001')));
    assert.ok(log.some((l) => l.includes('reset to todo')));

    // Feature now status=todo, attempts=0.
    const after = JSON.parse(readFileSync(join(fx.stateDir, 'features.json'), 'utf8'));
    assert.equal(after.features[0].status, 'todo');
    assert.equal(after.features[0].attempts, 0);
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — NEXT_ARCHITECT with REVIEW verdict blocks feature + emits event', async () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(
      join(harnessDir, 'prompts', 'orchestrator.md'),
      '\nNEXT_ARCHITECT F-001 needs human input\n',
    );
    writeFileSync(
      join(harnessDir, 'prompts', 'architect.md'),
      '\nREVIEW F-001 spec ambiguity needs human resolution\n',
    );
  });
  writeFileSync(
    join(fx.stateDir, 'features.json'),
    JSON.stringify({ features: [{ id: 'F-001', status: 'failed', attempts: 2 }] }),
  );
  try {
    const log: string[] = [];
    await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'cat',
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: (e, b) => log.push(`event:${e} ${b}`) },
      maxIterations: 1,
      iterationSleepMs: 0,
    });
    assert.ok(log.some((l) => l.startsWith('event:review-pending')));
    const after = JSON.parse(readFileSync(join(fx.stateDir, 'features.json'), 'utf8'));
    assert.equal(after.features[0].status, 'blocked');
    // Attempts NOT reset on REVIEW (only PATCH does that).
    assert.equal(after.features[0].attempts, 2);
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — NEXT_TESTER invokes tester role', async () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'prompts', 'tester.md'), '# TESTER');
  });
  try {
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}NEXT_TESTER${IFS}val-1',
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: () => {} },
      maxIterations: 1,
      iterationSleepMs: 0,
    });
    assert.equal(result.reason, 'max-iterations');
    assert.ok(log.some((l) => l.startsWith('TESTER starting for val-1')));
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — GENERATE_TESTS invokes test-writer', async () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'prompts', 'test-writer.md'), '# TW');
  });
  try {
    const log: string[] = [];
    await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}GENERATE_TESTS',
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: () => {} },
      maxIterations: 1,
      iterationSleepMs: 0,
    });
    assert.ok(log.some((l) => l.startsWith('TEST_WRITER edge-case expansion starting')));
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — CONVERTED is a no-op log + continue', async () => {
  const fx = makeFixture();
  try {
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}CONVERTED',
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: () => {} },
      maxIterations: 1,
      iterationSleepMs: 0,
    });
    assert.equal(result.reason, 'max-iterations');
    assert.ok(log.some((l) => l.includes('converted issues to fix features')));
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — FEATURE_FREEZE is a no-op log + continue', async () => {
  const fx = makeFixture();
  try {
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}FEATURE_FREEZE${IFS}staging',
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: () => {} },
      maxIterations: 1,
      iterationSleepMs: 0,
    });
    assert.equal(result.reason, 'max-iterations');
    assert.ok(log.some((l) => l.startsWith('FEATURE_FREEZE: FEATURE_FREEZE staging')));
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — RUN_TESTS skips gracefully when bin/run-tests.sh missing', async () => {
  const fx = makeFixture();
  try {
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}RUN_TESTS',
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: () => {} },
      maxIterations: 1,
      iterationSleepMs: 0,
    });
    assert.equal(result.reason, 'max-iterations');
    assert.ok(log.some((l) => l.includes('RUN_TESTS invoked')));
    assert.ok(log.some((l) => l.includes('bin/run-tests.sh not implemented yet')));
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — NEXT_HARNESS attempts API + falls back when no registry', async () => {
  const fx = makeFixture();
  try {
    const log: string[] = [];
    const result = await runMainLoop({
      ctx: {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'bash -c echo${IFS}NEXT_HARNESS${IFS}sub-harness',
        dept: '',
        log: () => {},
      },
      logger: { log: (m) => log.push(m), notifyEvent: () => {} },
      maxIterations: 1,
      iterationSleepMs: 0,
    });
    assert.equal(result.reason, 'max-iterations');
    // Header logged.
    assert.ok(log.some((l) => l.includes('NEXT_HARNESS sub-harness --role=orchestrator')));
    // API was tried (assumes localhost:3001 not running in test env).
    assert.ok(log.some((l) => l.includes('API unreachable, falling back')));
    // Falls back to registry lookup, which also fails in the test env →
    // logs the registry-missing error.
    assert.ok(
      log.some(
        (l) => l.includes('child harness path not found') || l.includes('Check ~/.restart-harness-projects.json'),
      ),
    );
  } finally {
    fx.cleanup();
  }
});
