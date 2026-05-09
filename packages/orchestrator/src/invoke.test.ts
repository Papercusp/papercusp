import { test } from 'vitest';
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
  resolveAgentForRole,
  selectStreamFormat,
  streamFormatFlags,
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
    assert.equal(extractResult(path, 'claude-stream-json'), 'NEXT_WORKER F-001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractResult — returns "" if no result event found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, '{"type":"assistant","message":"nothing terminal"}\n');
  try {
    assert.equal(extractResult(path, 'claude-stream-json'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractResult — plain-text mode returns file as-is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, 'plain output\n');
  try {
    assert.equal(extractResult(path, 'none'), 'plain output\n');
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
    assert.equal(extractResult(path, 'claude-stream-json'), 'DONE');
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

test('extractResult — omp message_end with assistant text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'turn_start' }),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'NEXT_WORKER ' } }),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'F-001' } }),
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'NEXT_WORKER F-001' }],
        usage: { input: 100, output: 5 },
      },
    }),
  ].join('\n'));
  try {
    assert.equal(extractResult(path, 'omp-json'), 'NEXT_WORKER F-001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractResult — omp falls back to assistantMessageEvent.done', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, [
    JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'done',
        reason: 'stop',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'DONE' }],
          usage: { input: 1, output: 1 },
        },
      },
    }),
  ].join('\n'));
  try {
    assert.equal(extractResult(path, 'omp-json'), 'DONE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractResult — omp returns "" on no terminal event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'turn_start' }) + '\n');
  try {
    assert.equal(extractResult(path, 'omp-json'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selectStreamFormat — claude-code with `claude -p` → claude-stream-json', () => {
  assert.equal(selectStreamFormat('claude-code', 'claude -p'), 'claude-stream-json');
});

test('selectStreamFormat — claude-code with override containing stream-json → none', () => {
  assert.equal(selectStreamFormat('claude-code', 'claude -p --output-format stream-json'), 'none');
});

test('selectStreamFormat — claude-code with non-claude binary → none', () => {
  assert.equal(selectStreamFormat('claude-code', 'cat'), 'none');
  assert.equal(selectStreamFormat('claude-code', 'bash -c echo'), 'none');
});

test('selectStreamFormat — omp with `omp -p` → omp-json', () => {
  assert.equal(selectStreamFormat('omp', 'omp -p'), 'omp-json');
  assert.equal(selectStreamFormat('omp', '/usr/local/bin/omp -p'), 'omp-json');
  assert.equal(selectStreamFormat('omp', 'pi -p'), 'omp-json');
});

test('selectStreamFormat — omp with caller-supplied --mode → none', () => {
  assert.equal(selectStreamFormat('omp', 'omp --mode rpc'), 'none');
});

test('streamFormatFlags — produces backend-specific flag set', () => {
  assert.deepEqual(streamFormatFlags('claude-stream-json'), ['--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
  assert.deepEqual(streamFormatFlags('omp-json'), ['--mode', 'json', '--no-session']);
  assert.deepEqual(streamFormatFlags('none'), []);
});

test('resolveAgentForRole — empty config falls through to fallbackCmd', () => {
  const out = resolveAgentForRole({}, 'worker', 'omp -p');
  assert.equal(out.agentCmd, 'omp -p');
  assert.deepEqual(out.extraArgs, []);
});

test('resolveAgentForRole — default applies to every role', () => {
  const cfg = { aiBackend: { default: { agentCmd: 'claude -p' } } };
  assert.equal(resolveAgentForRole(cfg, 'worker', 'omp -p').agentCmd, 'claude -p');
  assert.equal(resolveAgentForRole(cfg, 'orchestrator', 'omp -p').agentCmd, 'claude -p');
});

test('resolveAgentForRole — role override beats default', () => {
  const cfg = {
    aiBackend: {
      default: { agentCmd: 'claude -p' },
      roles: { worker: { agentCmd: 'omp -p' } },
    },
  };
  assert.equal(resolveAgentForRole(cfg, 'worker', 'fallback').agentCmd, 'omp -p');
  assert.equal(resolveAgentForRole(cfg, 'validator', 'fallback').agentCmd, 'claude -p');
});

test('resolveAgentForRole — extraArgs concatenate (default first, then role)', () => {
  const cfg = {
    aiBackend: {
      default: { extraArgs: ['--max-tokens', '4000'] },
      roles: { worker: { extraArgs: ['--temperature', '0.2'] } },
    },
  };
  const out = resolveAgentForRole(cfg, 'worker', 'omp -p');
  assert.deepEqual(out.extraArgs, ['--max-tokens', '4000', '--temperature', '0.2']);
});

test('resolveAgentForRole — non-role uses only default extraArgs', () => {
  const cfg = {
    aiBackend: {
      default: { extraArgs: ['--default-flag'] },
      roles: { worker: { extraArgs: ['--worker-only'] } },
    },
  };
  assert.deepEqual(resolveAgentForRole(cfg, 'validator', 'omp -p').extraArgs, ['--default-flag']);
});

test('resolveAgentForRole — empty/whitespace agentCmd in role falls through', () => {
  const cfg = {
    aiBackend: {
      default: { agentCmd: 'claude -p' },
      roles: { worker: { agentCmd: '   ' } },
    },
  };
  assert.equal(resolveAgentForRole(cfg, 'worker', 'fallback').agentCmd, 'claude -p');
});

test('resolveModel — aiBackend.roles.<role>.model wins over models.<role>', () => {
  const cfg = {
    models: { worker: 'legacy-model' },
    aiBackend: { roles: { worker: { model: 'new-model' } } },
  };
  assert.equal(resolveModel(cfg as never, 'worker'), 'new-model');
});

test('resolveModel — aiBackend.default.model used when no role override', () => {
  const cfg = {
    aiBackend: { default: { model: 'sonnet-4-6' } },
  };
  assert.equal(resolveModel(cfg as never, 'worker'), 'sonnet-4-6');
});

test('resolveModel — legacy models.<role> still works when aiBackend absent', () => {
  const cfg = { models: { worker: 'legacy-only' } };
  assert.equal(resolveModel(cfg as never, 'worker'), 'legacy-only');
});
