import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('runMainLoop — IDLE keeps iterating until max', async () => {
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
    });
    assert.equal(result.exitCode, 5);
    assert.equal(result.reason, 'max-iterations');
    assert.equal(result.iterations, 3);
    // 3 iteration headers
    const headers = log.filter((l) => l.includes('── iteration '));
    assert.equal(headers.length, 3);
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — ESCALATE exits with code 9', async () => {
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
        claudeCmd: 'bash -c echo${IFS}ESCALATE',
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
    assert.equal(result.exitCode, 9);
    assert.equal(result.reason, 'escalate');
    assert.ok(log.some((l) => l === 'event:escalate'));
  } finally {
    fx.cleanup();
  }
});

test('runMainLoop — CHECKPOINT exits with code 8', async () => {
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
        claudeCmd: 'bash -c echo${IFS}CHECKPOINT',
        dept: '',
        log: () => {},
      },
      logger: { log: () => {}, notifyEvent: () => {} },
      maxIterations: 5,
      iterationSleepMs: 0,
    });
    assert.equal(result.exitCode, 8);
    assert.equal(result.reason, 'checkpoint');
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

test('runMainLoop — NEXT_WORKER hits TODO branch (signals bash fallback)', async () => {
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
        claudeCmd: 'bash -c echo${IFS}NEXT_WORKER${IFS}F-001',
        dept: '',
        log: () => {},
      },
      logger: {
        log: (m) => log.push(m),
        notifyEvent: () => {},
      },
      maxIterations: 5,
      iterationSleepMs: 0,
    });
    assert.equal(result.reason, 'todo-branch');
    assert.ok(
      log.some((l) => l.includes('NEXT_WORKER branch not yet ported')),
      'should log the TODO',
    );
  } finally {
    fx.cleanup();
  }
});
