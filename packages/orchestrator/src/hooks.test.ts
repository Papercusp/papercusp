import { test } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from './hooks.js';

interface Fixture {
  stateDir: string;
  projectDir: string;
  logDir: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-orch-hooks-'));
  const stateDir = join(root, '.harness');
  const projectDir = join(root, 'project');
  const logDir = join(stateDir, 'logs');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  return { stateDir, projectDir, logDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('runHook — no-op when script missing', () => {
  const fx = makeFixture();
  try {
    const log: string[] = [];
    const r = runHook('pre-worker', {
      stateDir: fx.stateDir,
      projectDir: fx.projectDir,
      logDir: fx.logDir,
      env: {},
      log: (m) => log.push(m),
    });
    assert.equal(r.ran, false);
    assert.equal(r.exitCode, undefined);
    assert.equal(log.length, 0);
  } finally {
    fx.cleanup();
  }
});

test('runHook — no-op when script not executable', () => {
  const fx = makeFixture();
  mkdirSync(join(fx.stateDir, 'hooks'));
  writeFileSync(join(fx.stateDir, 'hooks', 'pre-worker.sh'), '#!/usr/bin/env bash\n');
  // Don't chmod +x — should be ignored.
  try {
    const r = runHook('pre-worker', {
      stateDir: fx.stateDir,
      projectDir: fx.projectDir,
      logDir: fx.logDir,
      env: {},
      log: () => {},
    });
    assert.equal(r.ran, false);
  } finally {
    fx.cleanup();
  }
});

test('runHook — runs executable script, captures rc=0', () => {
  const fx = makeFixture();
  mkdirSync(join(fx.stateDir, 'hooks'));
  const script = join(fx.stateDir, 'hooks', 'pre-worker.sh');
  writeFileSync(script, '#!/usr/bin/env bash\necho "hook ran with FID=$FEATURE_ID"\nexit 0\n');
  chmodSync(script, 0o755);
  try {
    const log: string[] = [];
    const r = runHook('pre-worker', {
      stateDir: fx.stateDir,
      projectDir: fx.projectDir,
      logDir: fx.logDir,
      env: { FEATURE_ID: 'F-001' },
      log: (m) => log.push(m),
    });
    assert.equal(r.ran, true);
    assert.equal(r.exitCode, 0);
    assert.ok(r.logfile);
    assert.match(readFileSync(r.logfile!, 'utf8'), /hook ran with FID=F-001/);
    assert.ok(log.some((l) => l.startsWith('HOOK pre-worker running')));
    // No failure log since rc=0.
    assert.ok(!log.some((l) => l.includes('failed rc=')));
  } finally {
    fx.cleanup();
  }
});

test('runHook — failure logged but does NOT throw', () => {
  const fx = makeFixture();
  mkdirSync(join(fx.stateDir, 'hooks'));
  const script = join(fx.stateDir, 'hooks', 'post-worker.sh');
  writeFileSync(script, '#!/usr/bin/env bash\necho "boom" >&2\nexit 7\n');
  chmodSync(script, 0o755);
  try {
    const log: string[] = [];
    const r = runHook('post-worker', {
      stateDir: fx.stateDir,
      projectDir: fx.projectDir,
      logDir: fx.logDir,
      env: {},
      log: (m) => log.push(m),
    });
    assert.equal(r.ran, true);
    assert.equal(r.exitCode, 7);
    assert.ok(log.some((l) => l.includes('HOOK post-worker failed rc=7')));
    // Stderr was captured into the log file.
    assert.match(readFileSync(r.logfile!, 'utf8'), /boom/);
  } finally {
    fx.cleanup();
  }
});

test('runHook — cwd is projectDir, env merged with process.env', () => {
  const fx = makeFixture();
  mkdirSync(join(fx.stateDir, 'hooks'));
  const script = join(fx.stateDir, 'hooks', 'pre-validator.sh');
  writeFileSync(
    script,
    '#!/usr/bin/env bash\n' +
      'echo "cwd=$(pwd)"\n' +
      'echo "ROLE=$ROLE"\n' +
      // PATH inherited from process.env — bash should be found via it.
      'echo "PATH_OK=$([ -n "$PATH" ] && echo yes || echo no)"\n',
  );
  chmodSync(script, 0o755);
  try {
    const r = runHook('pre-validator', {
      stateDir: fx.stateDir,
      projectDir: fx.projectDir,
      logDir: fx.logDir,
      env: { ROLE: 'validator' },
      log: () => {},
    });
    const logBody = readFileSync(r.logfile!, 'utf8');
    // Realpath may resolve symlinks; just require the suffix.
    assert.match(logBody, /cwd=.*\/project/);
    assert.match(logBody, /ROLE=validator/);
    assert.match(logBody, /PATH_OK=yes/);
  } finally {
    fx.cleanup();
  }
});

test('runHook — log files stamp with timestamp + name', () => {
  const fx = makeFixture();
  mkdirSync(join(fx.stateDir, 'hooks'));
  const script = join(fx.stateDir, 'hooks', 'on-smoke-pass.sh');
  writeFileSync(script, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(script, 0o755);
  try {
    runHook('on-smoke-pass', {
      stateDir: fx.stateDir,
      projectDir: fx.projectDir,
      logDir: fx.logDir,
      env: {},
      log: () => {},
    });
    const hookLogs = readdirSync(join(fx.logDir, 'hooks'));
    assert.equal(hookLogs.length, 1);
    assert.match(hookLogs[0], /^\d+-on-smoke-pass\.log$/);
  } finally {
    fx.cleanup();
  }
});
