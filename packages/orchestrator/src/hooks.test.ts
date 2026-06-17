import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from './hooks.js';

// Hermetic env: `runHook` resolves OPERATOR_BASE from `PAPERCUSP_OPERATOR_BASE`
// when no `operatorBase` is passed, and injects HARNESS_SLUG from the `harnessSlug`
// param or the project dirname. On the shared dev box these session vars leak in
// and break the Phase-6 defaults (green in a clean shell, red under a live session).
// Snapshot + clear them per-test so the suite measures the committed defaults;
// tests that need specific values set their own.
// (EI-941 env isolation / EI-964 env isolation.)
let _operatorBaseSnapshot: string | undefined;
const HARNESS_SLUG_ENV_KEYS = ['HARNESS_SLUG', 'PAPERCUSP_HARNESS_SLUG'] as const;
const _harnessSlugEnvSnapshot: Partial<Record<(typeof HARNESS_SLUG_ENV_KEYS)[number], string | undefined>> = {};
beforeEach(() => {
  _operatorBaseSnapshot = process.env.PAPERCUSP_OPERATOR_BASE;
  delete process.env.PAPERCUSP_OPERATOR_BASE;
  for (const k of HARNESS_SLUG_ENV_KEYS) {
    _harnessSlugEnvSnapshot[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  if (_operatorBaseSnapshot === undefined) delete process.env.PAPERCUSP_OPERATOR_BASE;
  else process.env.PAPERCUSP_OPERATOR_BASE = _operatorBaseSnapshot;
  for (const k of HARNESS_SLUG_ENV_KEYS) {
    const prev = _harnessSlugEnvSnapshot[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
});

interface Fixture {
  stateDir: string;
  projectDir: string;
  logDir: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-orch-hooks-'));
  const stateDir = join(root, '.papercusp');
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

test('runHook — Phase 6: auto-injects HARNESS_SLUG, OPERATOR_BASE, optional WORKSPACE_ID', () => {
  const fx = makeFixture();
  mkdirSync(join(fx.stateDir, 'hooks'));
  const script = join(fx.stateDir, 'hooks', 'pre-worker.sh');
  // Echo the contract env vars so we can assert them in the log.
  writeFileSync(
    script,
    '#!/usr/bin/env bash\n' +
    'echo "HARNESS_SLUG=$HARNESS_SLUG"\n' +
    'echo "WORKSPACE_ID=$WORKSPACE_ID"\n' +
    'echo "OPERATOR_BASE=$OPERATOR_BASE"\n' +
    'exit 0\n',
  );
  chmodSync(script, 0o755);
  try {
    const r = runHook('pre-worker', {
      stateDir: fx.stateDir,
      projectDir: fx.projectDir, // basename = 'project' → default HARNESS_SLUG
      logDir: fx.logDir,
      env: {},
      log: () => {},
      workspaceId: 'ws-test',
    });
    const out = readFileSync(r.logfile!, 'utf8');
    assert.match(out, /HARNESS_SLUG=project/);
    assert.match(out, /WORKSPACE_ID=ws-test/);
    // EI-113 (audit P-038): the operator API default is :3070 — :3055 is the
    // Vite content port with no /api routes.
    assert.match(out, /OPERATOR_BASE=http:\/\/localhost:3070/);
  } finally {
    fx.cleanup();
  }
});

test('runHook — explicit harnessSlug overrides projectDir basename', () => {
  const fx = makeFixture();
  mkdirSync(join(fx.stateDir, 'hooks'));
  const script = join(fx.stateDir, 'hooks', 'pre-worker.sh');
  writeFileSync(
    script,
    '#!/usr/bin/env bash\necho "HARNESS_SLUG=$HARNESS_SLUG"\nexit 0\n',
  );
  chmodSync(script, 0o755);
  try {
    const r = runHook('pre-worker', {
      stateDir: fx.stateDir,
      projectDir: fx.projectDir,
      logDir: fx.logDir,
      env: {},
      log: () => {},
      harnessSlug: 'sheets',
    });
    assert.match(readFileSync(r.logfile!, 'utf8'), /HARNESS_SLUG=sheets/);
  } finally {
    fx.cleanup();
  }
});

test('runHook — caller env wins over auto-injection', () => {
  const fx = makeFixture();
  mkdirSync(join(fx.stateDir, 'hooks'));
  const script = join(fx.stateDir, 'hooks', 'pre-worker.sh');
  writeFileSync(
    script,
    '#!/usr/bin/env bash\necho "HARNESS_SLUG=$HARNESS_SLUG"\nexit 0\n',
  );
  chmodSync(script, 0o755);
  try {
    const r = runHook('pre-worker', {
      stateDir: fx.stateDir,
      projectDir: fx.projectDir,
      logDir: fx.logDir,
      env: { HARNESS_SLUG: 'override' },
      log: () => {},
      harnessSlug: 'auto',
    });
    assert.match(readFileSync(r.logfile!, 'utf8'), /HARNESS_SLUG=override/);
  } finally {
    fx.cleanup();
  }
});

test('runHook — OPERATOR_BASE honors PAPERCUSP_OPERATOR_BASE env', () => {
  const fx = makeFixture();
  mkdirSync(join(fx.stateDir, 'hooks'));
  const script = join(fx.stateDir, 'hooks', 'pre-worker.sh');
  writeFileSync(
    script,
    '#!/usr/bin/env bash\necho "OPERATOR_BASE=$OPERATOR_BASE"\nexit 0\n',
  );
  chmodSync(script, 0o755);
  const prev = process.env.PAPERCUSP_OPERATOR_BASE;
  process.env.PAPERCUSP_OPERATOR_BASE = 'http://my-operator:3070';
  try {
    const r = runHook('pre-worker', {
      stateDir: fx.stateDir,
      projectDir: fx.projectDir,
      logDir: fx.logDir,
      env: {},
      log: () => {},
    });
    assert.match(readFileSync(r.logfile!, 'utf8'), /OPERATOR_BASE=http:\/\/my-operator:3070/);
  } finally {
    if (prev === undefined) delete process.env.PAPERCUSP_OPERATOR_BASE;
    else process.env.PAPERCUSP_OPERATOR_BASE = prev;
    fx.cleanup();
  }
});
