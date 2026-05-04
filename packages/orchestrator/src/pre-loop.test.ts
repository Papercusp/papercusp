import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreLoop } from './pre-loop.js';

interface Fixture {
  harnessDir: string;
  projectDir: string;
  stateDir: string;
  logDir: string;
  cleanup: () => void;
}

function makeFixture(setup: (fx: Omit<Fixture, 'cleanup'>) => void = () => {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-orch-preloop-'));
  const harnessDir = join(root, 'harness');
  const projectDir = join(root, 'project');
  const stateDir = join(projectDir, '.harness');
  const logDir = join(stateDir, 'logs');
  mkdirSync(join(harnessDir, 'prompts'), { recursive: true });
  mkdirSync(join(harnessDir, 'identity'), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  // Stub the prompts pre-loop will call.
  for (const role of ['scoper', 'reviewer']) {
    writeFileSync(join(harnessDir, 'prompts', `${role}.md`), `# ${role}`);
  }
  const fx = { harnessDir, projectDir, stateDir, logDir };
  setup(fx);
  return { ...fx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('runPreLoop — skips scoper when contract + features already exist', async () => {
  const fx = makeFixture();
  writeFileSync(join(fx.stateDir, 'validation-contract.md'), '## contract');
  writeFileSync(
    join(fx.stateDir, 'features.json'),
    JSON.stringify({ features: [{ id: 'F-001', status: 'pending' }] }),
  );
  try {
    const log: string[] = [];
    const r = await runPreLoop(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'cat', // never invoked
        dept: '',
        log: () => {},
      },
      { log: (m) => log.push(m), notifyEvent: () => {} },
      {},
    );
    assert.equal(r.stop, null);
    assert.ok(log.some((l) => l.includes('Skipping scoper')));
  } finally {
    fx.cleanup();
  }
});

test('runPreLoop — fresh mission: invokes scoper, fails when no artifacts produced', async () => {
  const fx = makeFixture();
  // No validation-contract.md, no features.json. cat-as-claude won't write
  // either, so the post-scoper check fails and we exit code 2.
  try {
    const log: string[] = [];
    const r = await runPreLoop(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'cat',
        dept: '',
        log: () => {},
      },
      { log: (m) => log.push(m), notifyEvent: () => {} },
      // planReviewer.enabled defaults to true; scoper-failed exits before review.
      {},
    );
    assert.equal(r.stop, 'scoper-failed');
    assert.equal(r.exitCode, 2);
    assert.ok(log.some((l) => l.includes('Invoking scoper')));
    assert.ok(log.some((l) => l.includes('scoper did not produce required artifacts')));
  } finally {
    fx.cleanup();
  }
});

test('runPreLoop — plan-review reject exits 7 + writes escalation', async () => {
  const fx = makeFixture();
  // Pre-seed contract + features so scoper is skipped.
  writeFileSync(join(fx.stateDir, 'validation-contract.md'), 'contract');
  writeFileSync(
    join(fx.stateDir, 'features.json'),
    JSON.stringify({ features: [{ id: 'F-001', status: 'pending' }] }),
  );
  // Pre-seed a plan-review.md with VERDICT: reject. This simulates what the
  // reviewer agent would have written. (We can't actually run the reviewer
  // here without a real agent; simulate its output.)
  // BUT: pre-loop skips reviewer when plan-review.md already exists. So we
  // need the reviewer to write plan-review.md during invoke. cat does NOT
  // write files. Solution: pre-seed plan-review.md but flip the gate by
  // toggling the pre-existing-skip — actually, this confounds the test.
  //
  // Easier: skip plan review by config, and instead test the reject path
  // via direct invocation in another test fixture that pre-exists the
  // plan-review.md AND the scoper-skipping artifacts.

  // Pre-seed reviewer's output to test the reject-handling code path. We do
  // this by having reviewer.md contain ONLY the verdict line, then use
  // cat-as-claude so reviewer's output IS the prompt body. The pre-loop
  // checks for plan-review.md after invoking reviewer, and we need that
  // file to exist with a reject verdict.
  //
  // The simplest approach: invoke writes the prompt to .out (in plain-text
  // mode for non-claude commands). But our pre-loop reads plan-review.md,
  // not .out. The reviewer agent is responsible for writing plan-review.md
  // in production; we can't simulate that with cat alone.
  //
  // Solution: write a tiny shell script that copies its stdin to plan-review.md
  // (mimicking what a real reviewer would do).
  const fakeReviewer = join(fx.harnessDir, 'fake-reviewer.sh');
  writeFileSync(
    fakeReviewer,
    '#!/usr/bin/env bash\n' +
      `cat > "${join(fx.stateDir, 'plan-review.md')}" <<'EOF'\n` +
      '# Plan review\n\nVERDICT: reject — too ambitious\n' +
      'EOF\n',
  );
  chmodSync(fakeReviewer, 0o755);
  try {
    const log: string[] = [];
    const r = await runPreLoop(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        // Set the claude command to our fake script. invoke()'s stream-json
        // detection only fires when the command mentions "claude", so we
        // get plain-text mode (the .out file just contains the prompt) —
        // doesn't matter because the side effect (plan-review.md) is what
        // we're testing.
        claudeCmd: fakeReviewer,
        dept: '',
        log: () => {},
      },
      { log: (m) => log.push(m), notifyEvent: (e, b) => log.push(`event:${e} ${b ?? ''}`) },
      {},
    );
    assert.equal(r.stop, 'plan-rejected');
    assert.equal(r.exitCode, 7);
    assert.ok(existsSync(join(fx.stateDir, 'escalation.md')));
    assert.match(
      readFileSync(join(fx.stateDir, 'escalation.md'), 'utf8'),
      /Plan-gate rejected/,
    );
    assert.ok(log.some((l) => l.startsWith('event:escalate')));
  } finally {
    fx.cleanup();
  }
});

test('runPreLoop — auto-checkpoint fires when configured + sentinel cleared', async () => {
  const fx = makeFixture();
  writeFileSync(join(fx.stateDir, 'validation-contract.md'), 'contract');
  writeFileSync(
    join(fx.stateDir, 'features.json'),
    JSON.stringify({ features: [{ id: 'F-001', status: 'pending' }] }),
  );
  writeFileSync(
    join(fx.stateDir, 'plan-review.md'),
    'VERDICT: accept — looks good',
  );
  // Config opts in to a post-planner checkpoint.
  const cfg = {
    checkpoints: {
      enabled: true,
      types: [{ name: 'plan-approved', triggerOn: 'post-planner' }],
    },
  };
  try {
    const log: string[] = [];
    const r = await runPreLoop(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'cat',
        dept: '',
        log: () => {},
      },
      { log: (m) => log.push(m), notifyEvent: (e, b) => log.push(`event:${e} ${b ?? ''}`) },
      cfg,
    );
    assert.equal(r.stop, 'auto-checkpoint');
    assert.equal(r.exitCode, 8);
    // Checkpoint file written.
    const cpFile = join(fx.stateDir, 'checkpoint-plan-approved.md');
    assert.ok(existsSync(cpFile));
    // Sentinel created so it doesn't re-fire.
    assert.ok(existsSync(join(fx.stateDir, '.checkpoint-plan-approved.fired')));
    assert.ok(log.some((l) => l.startsWith('event:checkpoint')));
  } finally {
    fx.cleanup();
  }
});

test('runPreLoop — auto-checkpoint suppressed once sentinel exists', async () => {
  const fx = makeFixture();
  writeFileSync(join(fx.stateDir, 'validation-contract.md'), 'contract');
  writeFileSync(
    join(fx.stateDir, 'features.json'),
    JSON.stringify({ features: [{ id: 'F-001', status: 'pending' }] }),
  );
  writeFileSync(join(fx.stateDir, 'plan-review.md'), 'VERDICT: accept');
  writeFileSync(join(fx.stateDir, '.checkpoint-plan-approved.fired'), '');
  const cfg = {
    checkpoints: {
      enabled: true,
      types: [{ name: 'plan-approved', triggerOn: 'post-planner' }],
    },
  };
  try {
    const r = await runPreLoop(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'cat',
        dept: '',
        log: () => {},
      },
      { log: () => {}, notifyEvent: () => {} },
      cfg,
    );
    assert.equal(r.stop, null, 'sentinel should suppress repeat fire');
  } finally {
    fx.cleanup();
  }
});
