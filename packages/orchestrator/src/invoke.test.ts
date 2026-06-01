import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  invoke,
  findPriorRunForIdempotency,
  extractResult,
  splitCommand,
  resolvePromptOverride,
  resolvePromptOverrideWithStore,
  resolveTimeout,
  resolveModel,
  resolveAgentForRole,
  selectStreamFormat,
  streamFormatFlags,
  claudeMcpArgs,
  FLEET_ALLOWED_TOOLS,
  FLEET_DISALLOWED_TOOLS,
  FLEET_NO_WRITE_ROLES,
  fleetAllowedToolsForRole,
  ensureFleetGitHooksDir,
  gitConfigNoPushEnv,
  claudeSandboxArgs,
  codexSandboxArgs,
  fleetSandboxSettingsForRole,
  resolveFleetAllowedDomains,
  FLEET_SANDBOX_ALLOWED_DOMAINS,
  FLEET_SANDBOX_DENY_READ,
  FLEET_SANDBOX_DENY_RULES,
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

// --- P-015: invoke() idempotency short-circuit (DBOS Phase 3) -------------
test('findPriorRunForIdempotency — reconstructs InvokeResult from a prior run (no re-spawn)', async () => {
  const fakePg = (() =>
    Promise.resolve([{
      run_id: 'k', role: 'worker', prompt_body: '', jsonl_body: '',
      out_body: 'PRIOR OUTPUT\n', err_body: '', exit_code: 0, duration_ms: 42,
      started_at: 1, ended_at: 2,
    }])) as unknown as Parameters<typeof findPriorRunForIdempotency>[0];
  const r = await findPriorRunForIdempotency(fakePg, 'ws', 'h', 'k', 'worker', () => {});
  assert.equal(r?.output, 'PRIOR OUTPUT'); // trailing newline stripped
  assert.equal(r?.exitCode, 0);
  assert.equal(r?.durationMs, 42);
});

test('findPriorRunForIdempotency — returns null when no prior run (→ caller spawns)', async () => {
  const fakePg = (() => Promise.resolve([])) as unknown as Parameters<typeof findPriorRunForIdempotency>[0];
  const r = await findPriorRunForIdempotency(fakePg, 'ws', 'h', 'k', 'worker', () => {});
  assert.equal(r, null);
});

test('findPriorRunForIdempotency — does NOT reuse an empty-output prior run (→ re-spawn so a transient empty recovers)', async () => {
  // A rc=0 run that produced no output is not a meaningful completed run (an
  // agent that emitted nothing did no work). Reusing it would poison the
  // decide-step retries / a re-trigger with the empty result (P-010). Treat it
  // as "no prior run" so the caller re-spawns.
  const emptyPg = (() =>
    Promise.resolve([{
      run_id: 'k', role: 'director', prompt_body: 'p', jsonl_body: '',
      out_body: '', err_body: '', exit_code: 0, duration_ms: 4500,
      started_at: 1, ended_at: 2,
    }])) as unknown as Parameters<typeof findPriorRunForIdempotency>[0];
  const r = await findPriorRunForIdempotency(emptyPg, 'ws', 'h', 'k', 'director', () => {});
  assert.equal(r, null);
});

test('findPriorRunForIdempotency — whitespace-only output is also treated as empty (re-spawn)', async () => {
  const wsPg = (() =>
    Promise.resolve([{
      run_id: 'k', role: 'worker', prompt_body: 'p', jsonl_body: '',
      out_body: '   \n  ', err_body: '', exit_code: 0, duration_ms: 100,
      started_at: 1, ended_at: 2,
    }])) as unknown as Parameters<typeof findPriorRunForIdempotency>[0];
  const r = await findPriorRunForIdempotency(wsPg, 'ws', 'h', 'k', 'worker', () => {});
  assert.equal(r, null);
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

// --- store-aware override (Phase 1b read-side cutover, D-7) ---
// mock pg: a tagged-template fn returning canned rows (or throwing).
const mkPg = (rows: unknown[]) => ((..._a: unknown[]) => Promise.resolve(rows)) as never;
const throwPg = (() => Promise.reject(new Error('table absent'))) as never;

test('resolvePromptOverrideWithStore — PG store value wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'override-'));
  try {
    const got = await resolvePromptOverrideWithStore(
      { promptOverrides: { worker: 'file inline' } },
      dir,
      'worker',
      { pg: mkPg([{ prompt_md: '# from store' }]), workspaceId: 'ws1', harnessSlug: 'sheets' },
    );
    assert.equal(got, '# from store');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePromptOverrideWithStore — falls back to file when store empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'override-'));
  try {
    const got = await resolvePromptOverrideWithStore(
      { promptOverrides: { worker: 'file inline' } },
      dir,
      'worker',
      { pg: mkPg([]), workspaceId: 'ws1', harnessSlug: 'sheets' },
    );
    assert.equal(got, 'file inline');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePromptOverrideWithStore — PG error degrades to file (no throw)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'override-'));
  try {
    const got = await resolvePromptOverrideWithStore(
      { promptOverrides: { worker: 'file inline' } },
      dir,
      'worker',
      { pg: throwPg, workspaceId: 'ws1', harnessSlug: 'sheets' },
    );
    assert.equal(got, 'file inline');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePromptOverrideWithStore — no pg/ws/slug uses file resolver (CLI mode)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'override-'));
  try {
    assert.equal(
      await resolvePromptOverrideWithStore({ promptOverrides: { worker: 'file inline' } }, dir, 'worker', {}),
      'file inline',
    );
    assert.equal(await resolvePromptOverrideWithStore({}, dir, 'worker', { pg: mkPg([{ prompt_md: 'x' }]) }), '');
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

// --- claudeMcpArgs: makes claude-code load the per-spawn signed .mcp.json ---

const MCP_PATH = '/proj/.harness/../.mcp.json';

// The permission posture appended after the MCP-load flags, for a given role:
// a closed whitelist (dontAsk auto-denies anything not allow-listed in headless
// -p) plus the Bash command deny backstop. Replaces the old blanket
// bypassPermissions. The allow-list is per-role (see fleetAllowedToolsForRole).
const permPosture = (role: string) => [
  '--permission-mode', 'dontAsk',
  '--allowed-tools', fleetAllowedToolsForRole(role).join(' '),
  '--disallowed-tools', ...FLEET_DISALLOWED_TOOLS,
];

test('claudeMcpArgs — claude-code + claude-stream + workspace → mcp-load + closed whitelist', () => {
  const args = claudeMcpArgs('claude-code', 'claude-stream-json', 'claude -p', MCP_PATH, true, 'worker');
  assert.deepEqual(args, [
    '--mcp-config', MCP_PATH, '--strict-mcp-config',
    ...permPosture('worker'),
  ]);
});

test('claudeMcpArgs — allow-list is the safe dev kit + mcp__papercusp wildcard, no dangerous built-ins', () => {
  // The wildcard carries the (already role-scoped server-side) MCP surface.
  assert.ok(FLEET_ALLOWED_TOOLS.includes('mcp__papercusp'));
  // The safe built-in dev kit every role needs is present.
  for (const safe of ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']) {
    assert.ok(FLEET_ALLOWED_TOOLS.includes(safe), `${safe} must be allow-listed`);
  }
  // Dangerous automation built-ins must NOT be allow-listed.
  for (const dangerous of ['Workflow', 'CronCreate', 'EnterWorktree', 'RemoteTrigger', 'Task', 'Monitor']) {
    assert.ok(!FLEET_ALLOWED_TOOLS.includes(dangerous), `${dangerous} must not be allow-listed`);
  }
});

test('fleetAllowedToolsForRole — API-only roles (expert/feedback) drop Edit/Write; others keep full kit', () => {
  // expert + feedback prompts explicitly forbid the Write/Edit tools.
  for (const role of FLEET_NO_WRITE_ROLES) {
    const kit = fleetAllowedToolsForRole(role);
    assert.ok(!kit.includes('Edit'), `${role} must not get Edit`);
    assert.ok(!kit.includes('Write'), `${role} must not get Write`);
    // still gets the read/exec base + MCP surface
    assert.ok(kit.includes('Read') && kit.includes('Bash') && kit.includes('mcp__papercusp'));
  }
  // A writer role and an unknown role both get the full kit (never silently
  // strip a tool from a role we don't recognise).
  for (const role of ['worker', 'documenter', 'totally-unknown-role', '']) {
    assert.deepEqual(fleetAllowedToolsForRole(role), [...FLEET_ALLOWED_TOOLS]);
  }
});

test('claudeMcpArgs — expert role gets the no-write kit in its --allowed-tools', () => {
  const args = claudeMcpArgs('claude-code', 'claude-stream-json', 'claude -p', MCP_PATH, true, 'expert');
  assert.deepEqual(args, [
    '--mcp-config', MCP_PATH, '--strict-mcp-config',
    ...permPosture('expert'),
  ]);
  // sanity: the emitted allow-list string has no Edit/Write
  const allowIdx = args.indexOf('--allowed-tools');
  assert.ok(!/\bEdit\b/.test(args[allowIdx + 1]) && !/\bWrite\b/.test(args[allowIdx + 1]));
});

test('claudeMcpArgs — deny-list hard-removes the dangerous EXEMPT tools (dontAsk gating is non-uniform) + dangerous Bash', () => {
  // These bypass the allow-list under dontAsk (verified: CronCreate/EnterWorktree
  // run despite omission), so they must be explicitly denied to be closed.
  for (const exempt of [
    'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup',
    'EnterWorktree', 'ExitWorktree', 'Workflow', 'Task',
    'RemoteTrigger', 'PushNotification', 'Monitor',
  ]) {
    assert.ok(FLEET_DISALLOWED_TOOLS.includes(exempt), `${exempt} must be deny-listed`);
  }
  // git push is denied (backstop to the pre-push hook); sudo is denied.
  assert.ok(FLEET_DISALLOWED_TOOLS.includes('Bash(git push:*)'));
  assert.ok(FLEET_DISALLOWED_TOOLS.includes('Bash(sudo:*)'));
});

test('claudeMcpArgs — omp backend → [] (omp path-discovers .mcp.json)', () => {
  assert.deepEqual(claudeMcpArgs('omp', 'omp-json', 'omp -p', MCP_PATH, true, 'worker'), []);
});

test('claudeMcpArgs — claude-code but no workspace → [] (no .mcp.json is written)', () => {
  assert.deepEqual(claudeMcpArgs('claude-code', 'claude-stream-json', 'claude -p', MCP_PATH, false, 'worker'), []);
});

test('claudeMcpArgs — non-claude stream (stub binary) → []', () => {
  assert.deepEqual(claudeMcpArgs('claude-code', 'none', 'cat', MCP_PATH, true, 'worker'), []);
});

test('claudeMcpArgs — user already passed --mcp-config → we do not double-add it (posture still applied)', () => {
  const args = claudeMcpArgs('claude-code', 'claude-stream-json', 'claude -p --mcp-config /x.json', MCP_PATH, true, 'worker');
  assert.deepEqual(args, permPosture('worker'));
});

test('claudeMcpArgs — user passed --dangerously-skip-permissions → they manage perms, we add none of the posture', () => {
  const args = claudeMcpArgs('claude-code', 'claude-stream-json', 'claude -p --dangerously-skip-permissions', MCP_PATH, true, 'worker');
  assert.deepEqual(args, ['--mcp-config', MCP_PATH, '--strict-mcp-config']);
});

test('claudeMcpArgs — user set --permission-mode → we do not impose ours (whole posture deferred)', () => {
  const args = claudeMcpArgs('claude-code', 'claude-stream-json', 'claude -p --permission-mode plan', MCP_PATH, true, 'worker');
  assert.deepEqual(args, ['--mcp-config', MCP_PATH, '--strict-mcp-config']);
});

test('claudeMcpArgs — user set --allowed-tools → we defer the whole posture to them', () => {
  const args = claudeMcpArgs('claude-code', 'claude-stream-json', 'claude -p --allowed-tools Read', MCP_PATH, true, 'worker');
  assert.deepEqual(args, ['--mcp-config', MCP_PATH, '--strict-mcp-config']);
});

// --- no-push enforcement: spawn-env-scoped pre-push hook ------------------

test('ensureFleetGitHooksDir — writes an executable pre-push that exits non-zero', () => {
  const dir = ensureFleetGitHooksDir();
  const hook = join(dir, 'pre-push');
  const body = readFileSync(hook, 'utf8');
  assert.ok(body.startsWith('#!/bin/sh'), 'has a shebang');
  assert.ok(/exit 1/.test(body), 'blocks (exit 1)');
  // owner-executable bit set so git can run it.
  assert.ok((statSync(hook).mode & 0o100) !== 0, 'pre-push is executable');
});

test('gitConfigNoPushEnv — points git at the hooks dir via GIT_CONFIG (fresh env → index 0)', () => {
  const env = gitConfigNoPushEnv({}, '/tmp/hooks');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath');
  assert.equal(env.GIT_CONFIG_VALUE_0, '/tmp/hooks');
});

test('gitConfigNoPushEnv — composes with a pre-existing GIT_CONFIG_COUNT (no clobber)', () => {
  // A caller already injected one config entry (index 0); ours must append at 1.
  const env = gitConfigNoPushEnv({ GIT_CONFIG_COUNT: '1' }, '/tmp/hooks');
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_1, 'core.hooksPath');
  assert.equal(env.GIT_CONFIG_VALUE_1, '/tmp/hooks');
  // does not overwrite the pre-existing index-0 slot
  assert.equal(env.GIT_CONFIG_KEY_0, undefined);
});

test('gitConfigNoPushEnv — junk GIT_CONFIG_COUNT falls back to index 0', () => {
  const env = gitConfigNoPushEnv({ GIT_CONFIG_COUNT: 'not-a-number' }, '/tmp/hooks');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath');
});

// --- fleet OS sandbox (plan fleet-spawn-sandbox-2026-06-01, Phase 1) -------

test('fleetSandboxSettingsForRole — cred reads + egress closed uniformly; Read/Edit deny rules present', () => {
  const s = fleetSandboxSettingsForRole('worker') as any;
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.failIfUnavailable, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  // credential dirs hidden from the sandboxed Bash subprocess
  for (const p of ['~/.ssh', '~/.aws', '~/.papercusp']) {
    assert.ok(s.sandbox.filesystem.denyRead.includes(p), `denyRead must include ${p}`);
  }
  // egress is allowlisted to package registries (so build/test roles work),
  // everything else blocked — verified mechanism (D-011); NOT deny-all anymore.
  assert.ok(s.sandbox.network.allowedDomains.includes('registry.npmjs.org'));
  assert.ok(!s.sandbox.network.allowedDomains.includes('example.com'));
  // the Read/Edit TOOLS bypass the sandbox → must be denied via permission rules
  assert.ok(s.permissions.deny.includes('Read(~/.ssh/**)'));
  assert.ok(s.permissions.deny.includes('Edit(~/.ssh/**)'));
  assert.ok(FLEET_SANDBOX_DENY_READ.includes('~/.ssh') && FLEET_SANDBOX_DENY_RULES.includes('Read(~/.aws/**)'));
});

test('fleetSandboxSettingsForRole — cwd-write is uniform (P-004: sandbox cwd is always writable, per-role write tightening not achievable here)', () => {
  // Every role gets cwd write — claude's sandbox can't express "no cwd write"
  // (verified P-004); write-discipline per role lives at the allowed-tools layer.
  for (const r of [...FLEET_NO_WRITE_ROLES, 'worker', 'documenter', 'unknown-role', undefined]) {
    const s = fleetSandboxSettingsForRole(r as any) as any;
    assert.deepEqual(s.sandbox.filesystem.allowWrite, ['.'], `${r} cwd write`);
    // cred protection + the registry egress allowlist are uniform across roles
    assert.ok(s.sandbox.filesystem.denyRead.includes('~/.ssh'));
    assert.ok(s.sandbox.network.allowedDomains.includes('registry.npmjs.org'));
  }
});

test('resolveFleetAllowedDomains — base registry list by default (no env)', () => {
  delete process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS;
  delete process.env.PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS;
  const d = resolveFleetAllowedDomains();
  assert.deepEqual(d, [...FLEET_SANDBOX_ALLOWED_DOMAINS]);
  assert.ok(d.includes('registry.npmjs.org'));
  assert.ok(!d.includes('example.com'));
});

test('resolveFleetAllowedDomains — APPEND var adds deployment hosts (comma/space-separated, trimmed, deduped, base kept)', () => {
  delete process.env.PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS;
  process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS =
    ' cdn.playwright.dev, registry.npmjs.org\tregistry.internal.corp ';
  try {
    const d = resolveFleetAllowedDomains();
    // base preserved
    assert.ok(d.includes('registry.npmjs.org'));
    assert.ok(d.includes('github.com'));
    // extras appended
    assert.ok(d.includes('cdn.playwright.dev'));
    assert.ok(d.includes('registry.internal.corp'));
    // deduped: the duplicate registry.npmjs.org appears exactly once
    assert.equal(d.filter((h) => h === 'registry.npmjs.org').length, 1);
  } finally {
    delete process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS;
  }
});

test('resolveFleetAllowedDomains — DENY_ALL_EGRESS lockdown → [] and wins over the append var', () => {
  process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS = 'cdn.playwright.dev';
  process.env.PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS = '1';
  try {
    assert.deepEqual(resolveFleetAllowedDomains(), []);
    // and it flows through the settings builder
    const s = fleetSandboxSettingsForRole('worker') as any;
    assert.deepEqual(s.sandbox.network.allowedDomains, []);
  } finally {
    delete process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS;
    delete process.env.PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS;
  }
});

test('fleetSandboxSettingsForRole — emits the env-resolved allowlist (deployment extension flows through)', () => {
  delete process.env.PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS;
  process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS = 'cdn.playwright.dev';
  try {
    const s = fleetSandboxSettingsForRole('validator') as any;
    assert.ok(s.sandbox.network.allowedDomains.includes('cdn.playwright.dev'));
    assert.ok(s.sandbox.network.allowedDomains.includes('registry.npmjs.org'));
  } finally {
    delete process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS;
  }
});

test('claudeSandboxArgs — enabled + claude-code → --settings with the per-role sandbox block', () => {
  const args = claudeSandboxArgs('claude-code', 'claude-stream-json', 'claude -p', true, true, 'worker');
  assert.equal(args[0], '--settings');
  const parsed = JSON.parse(args[1]);
  assert.equal(parsed.sandbox.enabled, true);
  assert.ok(parsed.sandbox.filesystem.denyRead.includes('~/.ssh'));
  assert.deepEqual(parsed.sandbox.filesystem.allowWrite, ['.']);
});

test('claudeSandboxArgs — disabled flag → [] (off by default)', () => {
  assert.deepEqual(claudeSandboxArgs('claude-code', 'claude-stream-json', 'claude -p', true, false, 'worker'), []);
});

test('claudeSandboxArgs — non-claude backend → [] (no-op for omp/codex)', () => {
  assert.deepEqual(claudeSandboxArgs('omp', 'omp-json', 'omp -p', true, true, 'worker'), []);
});

test('claudeSandboxArgs — no workspace → []', () => {
  assert.deepEqual(claudeSandboxArgs('claude-code', 'claude-stream-json', 'claude -p', false, true, 'worker'), []);
});

test('claudeSandboxArgs — user already passed --settings → defer to them', () => {
  assert.deepEqual(claudeSandboxArgs('claude-code', 'claude-stream-json', 'claude -p --settings /x.json', true, true, 'worker'), []);
});

// ── codex backend (Phase 2 / P-011) ──

test('selectStreamFormat — codex with `codex` → codex-json', () => {
  assert.equal(selectStreamFormat('codex', 'codex'), 'codex-json');
});

test('selectStreamFormat — codex with explicit `exec` subcommand → none (user-driven)', () => {
  assert.equal(selectStreamFormat('codex', 'codex exec --json'), 'none');
});

test('streamFormatFlags — codex-json carries exec + json only (sandbox decided by codexSandboxArgs)', () => {
  assert.deepEqual(
    streamFormatFlags('codex-json'),
    ['exec', '--json', '--skip-git-repo-check', '--ephemeral'],
  );
});

test('codexSandboxArgs — always danger-full-access; the flag does NOT switch codex (workspace-write cancels MCP — P-012/D-009)', () => {
  // codex is not sandboxable for the fleet: workspace-write cancels its MCP
  // tool calls, so the flag must NOT switch it (that would make codex tool-less).
  const bypass = ['-s', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox'];
  assert.deepEqual(codexSandboxArgs('codex', 'codex-json', 'codex', true), bypass);
  assert.deepEqual(codexSandboxArgs('codex', 'codex-json', 'codex', false), bypass);
});

test('codexSandboxArgs — non-codex → [] (no-op for claude/omp)', () => {
  assert.deepEqual(codexSandboxArgs('claude-code', 'claude-stream-json', 'claude -p', true), []);
  assert.deepEqual(codexSandboxArgs('omp', 'omp-json', 'omp -p', true), []);
});

test('codexSandboxArgs — user set their own -s/--sandbox/bypass → defer to them', () => {
  assert.deepEqual(codexSandboxArgs('codex', 'codex-json', 'codex -s read-only', true), []);
  assert.deepEqual(codexSandboxArgs('codex', 'codex-json', 'codex --sandbox workspace-write', false), []);
  assert.deepEqual(codexSandboxArgs('codex', 'codex-json', 'codex --dangerously-bypass-approvals-and-sandbox', true), []);
});

// omp via srt was removed after P-012 (D-010): srt wraps omp's whole process,
// so its egress filter breaks omp's own model/MCP connections. Deferred until a
// per-omp egress allowlist + real-spawn verification. omp runs unsandboxed.

test('extractResult — codex-json concatenates agent_message item.completed text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-extract-'));
  const path = join(dir, 'r.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'item.started', item: { type: 'agent_message' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'NEXT_WORKER ' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'harness:list' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'F-001' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } }),
  ].join('\n') + '\n', 'utf8');
  assert.equal(extractResult(path, 'codex-json'), 'NEXT_WORKER F-001');
  rmSync(dir, { recursive: true, force: true });
});

test('extractResult — codex-json returns "" when no agent_message present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-extract-'));
  const path = join(dir, 'r.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n', 'utf8');
  assert.equal(extractResult(path, 'codex-json'), '');
  rmSync(dir, { recursive: true, force: true });
});
