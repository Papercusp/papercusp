import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  invoke,
  extractResult,
  splitCommand,
  resolvePromptOverride,
  resolveTimeout,
  resolveModel,
} from './invoke.js';

interface Fixture {
  harnessDir: string;
  projectDir: string;
  stateDir: string;
  logDir: string;
  cleanup: () => void;
}

function makeFixture(setup: (fx: Omit<Fixture, 'cleanup'>) => void): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-orch-invoke-'));
  const harnessDir = join(root, 'harness');
  const projectDir = join(root, 'project');
  const stateDir = join(projectDir, '.harness');
  const logDir = join(stateDir, 'logs');
  mkdirSync(join(harnessDir, 'prompts'), { recursive: true });
  mkdirSync(join(harnessDir, 'identity'), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const fx = { harnessDir, projectDir, stateDir, logDir };
  setup(fx);
  return { ...fx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('splitCommand — whitespace-splits like bash unquoted', () => {
  assert.deepEqual(splitCommand('claude -p'), ['claude', '-p']);
  assert.deepEqual(splitCommand('  claude   -p   --model sonnet '), [
    'claude', '-p', '--model', 'sonnet',
  ]);
  assert.deepEqual(splitCommand('claude'), ['claude']);
});

test('extractResult — pulls "result" event from stream-json log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, [
    '{"type":"system","message":"hi"}',
    '{"type":"assistant","message":"working"}',
    '{"type":"result","result":"NEXT_WORKER F-001","total_cost_usd":0.012}',
    '',
  ].join('\n'));
  try {
    assert.equal(extractResult(path, true), 'NEXT_WORKER F-001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractResult — returns "" if no result event found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, '{"type":"assistant","message":"nothing terminal"}\n');
  try {
    assert.equal(extractResult(path, true), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractResult — plain-text mode returns file as-is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, 'plain output\n');
  try {
    assert.equal(extractResult(path, false), 'plain output\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractResult — handles malformed lines mixed with valid result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, [
    'not json at all',
    '{"type":"result","result":"DONE"}',
    'noise after',
    '',
  ].join('\n'));
  try {
    assert.equal(extractResult(path, true), 'DONE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePromptOverride — empty when nothing set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'override-'));
  try {
    assert.equal(resolvePromptOverride({}, dir, 'worker'), '');
    assert.equal(resolvePromptOverride({ promptOverrides: {} }, dir, 'worker'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePromptOverride — inline string returned literally', () => {
  const dir = mkdtempSync(join(tmpdir(), 'override-'));
  try {
    assert.equal(
      resolvePromptOverride(
        { promptOverrides: { worker: 'Be terse.' } },
        dir,
        'worker',
      ),
      'Be terse.',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePromptOverride — relative path read from stateDir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'override-'));
  writeFileSync(join(dir, 'override.md'), 'from-file content');
  try {
    assert.equal(
      resolvePromptOverride(
        { promptOverrides: { worker: 'override.md' } },
        dir,
        'worker',
      ),
      'from-file content',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTimeout — 0 when not set or invalid', () => {
  assert.equal(resolveTimeout({}, 'worker'), 0);
  assert.equal(resolveTimeout({ timeouts: { worker: -1 } }, 'worker'), 0);
  assert.equal(resolveTimeout({ timeouts: { worker: 'nope' as unknown as number } }, 'worker'), 0);
});

test('resolveTimeout — positive integer passes through', () => {
  assert.equal(resolveTimeout({ timeouts: { worker: 600 } }, 'worker'), 600);
  // Floats floor down (matches `timeout` coreutil's integer expectation).
  assert.equal(resolveTimeout({ timeouts: { worker: 600.7 } }, 'worker'), 600);
});

test('resolveModel — returns empty when missing', () => {
  assert.equal(resolveModel({}, 'worker'), '');
});

test('resolveModel — returns named model', () => {
  assert.equal(resolveModel({ models: { worker: 'sonnet' } }, 'worker'), 'sonnet');
});

test('invoke — end-to-end logs invoke message, returns rc + paths', async () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'prompts', 'worker.md'), '# WORKER');
  });
  try {
    const log: string[] = [];
    const result = await invoke(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        // No "claude" mention → plain-text branch. cat reads stdin.
        claudeCmd: 'cat',
        dept: '',
        log: (m) => log.push(m),
        nowSeconds: () => 1700000000,
      },
      'worker',
      ['MODE=fresh'],
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.jsonlPath, /1700000000-worker\.jsonl$/);
    assert.ok(log.some((l) => l.includes('invoke worker rc=0')));
    // cat echoes our prompt back; the .out (plain-text branch) is the
    // captured prompt itself.
    const outBody = readFileSync(result.outPath, 'utf8');
    assert.match(outBody, /## Runtime context/);
    assert.match(outBody, /MODE=fresh/);
  } finally {
    fx.cleanup();
  }
});

test('invoke — throws when no prompt file exists for role', async () => {
  const fx = makeFixture(() => {
    /* no prompt file written */
  });
  try {
    await assert.rejects(
      () =>
        invoke(
          {
            harnessDir: fx.harnessDir,
            projectDir: fx.projectDir,
            stateDir: fx.stateDir,
            logDir: fx.logDir,
            phase: 'staging',
            claudeCmd: 'bash -c true',
            dept: '',
            log: () => {},
          },
          'nonexistent-role',
          [],
        ),
      /no prompt file for role=nonexistent-role/,
    );
  } finally {
    fx.cleanup();
  }
});

test('invoke — produces .jsonl, .out, .err artifacts', async () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'prompts', 'worker.md'), '# WORKER');
  });
  try {
    const result = await invoke(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'true', // exits 0 with empty output
        dept: '',
        log: () => {},
        nowSeconds: () => 1700000001,
      },
      'worker',
      [],
    );
    assert.equal(result.exitCode, 0);
    // .jsonl exists (may be empty since `true` writes nothing).
    const jsonl = readFileSync(result.jsonlPath, 'utf8');
    assert.equal(jsonl, '');
    // .out exists (plain-text mode = copy of jsonl).
    const out = readFileSync(result.outPath, 'utf8');
    assert.equal(out, '');
  } finally {
    fx.cleanup();
  }
});
