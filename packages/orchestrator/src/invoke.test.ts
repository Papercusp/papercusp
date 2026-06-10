import { test, beforeEach, afterEach } from 'vitest';
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
  claudeSpawnEnvHardening,
  resolveSpawnHome,
  claudeSandboxArgs,
  codexSandboxArgs,
  fleetSandboxEnabled,
  fleetSandboxSettingsForRole,
  resolveFleetAllowedDomains,
  fleetSandboxCacheEnv,
  fleetSrtModelDomains,
  buildFleetSrtSettings,
  wrapSpawnWithSrt,
  backendUsesSrt,
  FLEET_SANDBOX_CACHE_ROOT,
  FLEET_SANDBOX_ALLOWED_DOMAINS,
  FLEET_SANDBOX_DENY_READ,
  FLEET_SANDBOX_DENY_RULES,
  scopeSpawnEnvForRole,
  SPAWN_ENV_ALL_ROLES_STRIP,
  SEARCH_PROVIDER_ENV_KEYS,
} from './invoke.js';
import { ROLE_MODEL_DEFAULTS } from './role-models.js';
import { writeSpawnClaudeConfig } from './spawn-mcp.js';

// Hermetic env: `resolveModel` falls back to the host's `AGENT_MODELS` env var
// (the operator sets e.g. `{"worker":"opus"}` in apps/operator/.env.local). When
// that leaks into the suite — as it does under the green-checkpoint gate, which
// strips `PAPERCUSP_*` but NOT `AGENT_MODELS` — `resolveModel({},'worker')`
// returns "opus" instead of "" and the `invoke(cat)` end-to-end leaks a stray
// `--model opus` arg, so two tests that assume committed defaults fail ONLY under
// the gate (green 107/107 in a clean shell). Clear it per-test so the suite
// measures the committed defaults, never the host's identity; tests that need it
// set it themselves. (release-pipeline-resilience-2026-06-09 P-001.)
let _agentModelsSnapshot: string | undefined;
beforeEach(() => {
  _agentModelsSnapshot = process.env.AGENT_MODELS;
  delete process.env.AGENT_MODELS;
});
afterEach(() => {
  if (_agentModelsSnapshot === undefined) delete process.env.AGENT_MODELS;
  else process.env.AGENT_MODELS = _agentModelsSnapshot;
});

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
  const stateDir = join(projectDir, '.papercusp');
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

// --- P-051: per-spawn HOME (Phase E / D-008) ------------------------------
test('resolveSpawnHome — shared-operator model returns the workspace HOME dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-spawnhome-'));
  try {
    const wsHome = join(root, 'ws1');
    mkdirSync(wsHome, { recursive: true });
    const env = { PAPERCUSP_SHARED_OPERATOR: '1', PAPERCUSP_WORKSPACES_ROOT: root };
    assert.equal(resolveSpawnHome('ws1', env), wsHome);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSpawnHome — null unless the shared-operator flag is set (dev / legacy inherit process HOME)', () => {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-spawnhome-'));
  try {
    mkdirSync(join(root, 'ws1'), { recursive: true });
    // Flag absent → never flip (D-009: don't flip piecemeal in dev).
    assert.equal(resolveSpawnHome('ws1', { PAPERCUSP_WORKSPACES_ROOT: root }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSpawnHome — null when no workspace, when the dir is absent, or when the caller pinned HOME', () => {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-spawnhome-'));
  try {
    const sharedEnv = { PAPERCUSP_SHARED_OPERATOR: '1', PAPERCUSP_WORKSPACES_ROOT: root };
    // no workspace bound
    assert.equal(resolveSpawnHome(undefined, sharedEnv), null);
    // workspace dir not provisioned
    assert.equal(resolveSpawnHome('never-made', sharedEnv), null);
    // caller already pinned a HOME → leave it
    mkdirSync(join(root, 'ws1'), { recursive: true });
    assert.equal(resolveSpawnHome('ws1', sharedEnv, '/some/explicit/home'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

// Brief 49: a crashed prior run is never reused, even when its out_body is non-empty
// (salvaged partial output / codex item.completed fragments). A DBOS step retry needs
// a FRESH attempt — reusing the crash would hand back the same failure forever.
test('findPriorRunForIdempotency — non-zero-exit prior run with salvaged output re-spawns', async () => {
  const wsPg = (() =>
    Promise.resolve([{
      run_id: 'k', role: 'worker', prompt_body: 'p', jsonl_body: '{"type":"assistant"}',
      out_body: 'partial work salvaged before the crash', err_body: 'SIGKILL', exit_code: 137, duration_ms: 100,
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

// Brief 49 partial-output salvage: a truncated stream (crash/timeout — no terminal
// `result` event) salvages the assistant text instead of returning ''.
test('extractResult — salvages last assistant message when no result event (truncated stream)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, [
    '{"type":"system","message":"hi"}',
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'I fixed the parser; ' }, { type: 'text', text: 'running tests now.' }] },
    }),
    '', // stream died here — no result event
  ].join('\n'));
  try {
    assert.equal(extractResult(path, 'claude-stream-json'), 'I fixed the parser; running tests now.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractResult — salvage appends trailing in-flight text deltas after the last complete message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, [
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Step 1 done.' }] },
    }),
    // in-flight message streaming when the process died (--include-partial-messages)
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Step 2: editing inv' } } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'oke.ts' } } }),
    '',
  ].join('\n'));
  try {
    assert.equal(extractResult(path, 'claude-stream-json'), 'Step 1 done.\nStep 2: editing invoke.ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractResult — deltas folded into a completed message are not double-counted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    }),
    '',
  ].join('\n'));
  try {
    assert.equal(extractResult(path, 'claude-stream-json'), 'Hello');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractResult — returns "" when the truncated stream carries no assistant text at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, '{"type":"system","subtype":"init"}\n{"type":"tool_use","name":"Bash"}\n');
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

test('resolveModel — falls back to the committed ROLE_MODEL_DEFAULTS floor (EI-7)', () => {
  const prev = process.env.AGENT_MODELS;
  try {
    delete process.env.AGENT_MODELS; // no env, no config
    // release-manager has a committed default; worker does not.
    assert.equal(resolveModel({}, 'release-manager'), ROLE_MODEL_DEFAULTS['release-manager']);
    assert.equal(resolveModel({}, 'release-manager'), 'opus:xhigh');
    assert.equal(resolveModel({}, 'worker'), '');
  } finally {
    if (prev === undefined) delete process.env.AGENT_MODELS;
    else process.env.AGENT_MODELS = prev;
  }
});

test('resolveModel — AGENT_MODELS / config OVERRIDE the committed default', () => {
  const prev = process.env.AGENT_MODELS;
  try {
    // config wins
    assert.equal(resolveModel({ models: { 'release-manager': 'sonnet' } }, 'release-manager'), 'sonnet');
    // env wins over the committed default
    process.env.AGENT_MODELS = JSON.stringify({ 'release-manager': 'claude-opus-4-8:max' });
    assert.equal(resolveModel({}, 'release-manager'), 'claude-opus-4-8:max');
  } finally {
    if (prev === undefined) delete process.env.AGENT_MODELS;
    else process.env.AGENT_MODELS = prev;
  }
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

test('invoke — a claude agent spawn carries the native-scheduler lockout in its argv', async () => {
  // native-scheduler-lockout-2026-06-09 P-002: the deny flag must reach the
  // actual spawned argv (positive case — the `cat` e2e above is the negative:
  // a non-claude command must NOT get a claude flag).
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'prompts', 'worker.md'), '# WORKER');
  });
  try {
    // A stub whose path NAMES claude (both the backend resolution and the
    // deny discriminator key on that) and which prints its argv to stdout.
    const binDir = join(fx.projectDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const stub = join(binDir, 'claude');
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@"\ncat >/dev/null\n', { mode: 0o755 });
    const result = await invoke(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: stub,
        dept: '',
        log: () => {},
        nowSeconds: () => 1700000002,
      },
      'worker',
      [],
    );
    assert.equal(result.exitCode, 0);
    const argvDump = readFileSync(result.jsonlPath, 'utf8');
    // ONE `=` token (D-002 — the variadic space form would eat positionals),
    // carrying both layers: a T1 scheduler tool + a T2 Bash deny pattern.
    const deny = argvDump.split('\n').find((l) => l.startsWith('--disallowedTools='));
    assert.ok(deny, `deny flag missing from spawned argv:\n${argvDump}`);
    assert.match(deny, /ScheduleWakeup/);
    assert.match(deny, /Bash\(crontab:\*\)/);
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

// Brief 49 partial-output salvage: an omp stream truncated mid-first-message (no
// message_end / done / agent_end anywhere) reconstructs the partial from its deltas.
test('extractResult — omp salvages text deltas when the stream died mid-message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'turn_start' }),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Renaming the gover' } }),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'nor bucket key' } }),
  ].join('\n'));
  try {
    assert.equal(extractResult(path, 'omp-json'), 'Renaming the governor bucket key');
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

const MCP_PATH = '/proj/.papercusp/../.mcp.json';

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

test('fleetAllowedToolsForRole — no roles are write-restricted now; every role gets the full kit', () => {
  // The former expert/feedback API-only roles were removed; FLEET_NO_WRITE_ROLES
  // is currently empty, so every role (writer or unknown) gets the full kit.
  assert.equal(FLEET_NO_WRITE_ROLES.size, 0);
  for (const role of ['worker', 'documenter', 'reviewer', 'totally-unknown-role', '']) {
    assert.deepEqual(fleetAllowedToolsForRole(role), [...FLEET_ALLOWED_TOOLS]);
  }
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

// --- claude-code spawn-env hardening (fleet-coordination-painpoints P-012) ---

test('claudeSpawnEnvHardening — secondary env defense for claude-code (marketplace autoinstall off; autoupdater off)', () => {
  // Secondary to the CLAUDE_CONFIG_DIR isolation (writeSpawnClaudeConfig). The
  // autoinstall var is the meaningful one; DISABLE_AUTOUPDATER is kept only as
  // cheap hygiene — it does NOT gate the marketplace refresh (P-012).
  assert.deepEqual(claudeSpawnEnvHardening('claude-code'), {
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    DISABLE_AUTOUPDATER: '1',
  });
});

test('claudeSpawnEnvHardening — no-op for non-claude backends (no plugin marketplace)', () => {
  assert.deepEqual(claudeSpawnEnvHardening('codex'), {});
  assert.deepEqual(claudeSpawnEnvHardening('omp'), {});
});

test('writeSpawnClaudeConfig — isolated CLAUDE_CONFIG_DIR carries creds but NO plugins/marketplaces (P-012 leak fix)', () => {
  // A "real" home with creds AND the plugin config that triggers the leak.
  const fakeHome = mkdtempSync(join(tmpdir(), 'p012-home-'));
  mkdirSync(join(fakeHome, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(fakeHome, '.claude', '.credentials.json'), '{"claudeAiOauth":"tok"}');
  writeFileSync(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'superpowers@claude-plugins-official': true } }),
  );
  writeFileSync(
    join(fakeHome, '.claude', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ 'claude-plugins-official': {} }),
  );

  const h = writeSpawnClaudeConfig(fakeHome);
  try {
    // Auth IS preserved — the creds are symlinked and resolve to the real bytes
    // (symlink, not copy → an OAuth refresh writes through; no token divergence).
    assert.equal(
      readFileSync(join(h.configDir, '.credentials.json'), 'utf8'),
      '{"claudeAiOauth":"tok"}',
      'creds readable through the symlink',
    );
    // …but the plugin config that drives the leaking external-source checkout is
    // GONE: no settings.json (⇒ no enabledPlugins) and no plugins/ (⇒ no known
    // marketplaces), so the worker resolves zero external marketplace sources.
    assert.throws(
      () => statSync(join(h.configDir, 'settings.json')),
      'no settings.json in the isolated config → no enabledPlugins',
    );
    assert.throws(
      () => statSync(join(h.configDir, 'plugins')),
      'no plugins/ dir in the isolated config → no known marketplaces',
    );
  } finally {
    h.cleanup();
    assert.throws(() => statSync(h.configDir), 'cleanup removes the temp config dir');
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('writeSpawnClaudeConfig — no creds in source home → unauthenticated config, no crash', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'p012-home-nocreds-'));
  const h = writeSpawnClaudeConfig(fakeHome);
  try {
    assert.throws(() => statSync(join(h.configDir, '.credentials.json')), 'no creds symlink when source has none');
  } finally {
    h.cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('writeSpawnClaudeConfig — cleanup preserves session transcripts to the flight recorder (mute-bee evidence)', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'fr-home-'));
  const recorderRoot = mkdtempSync(join(tmpdir(), 'fr-spool-'));
  const prevSpawnId = process.env.PAPERCUSP_SPAWN_ID;
  const prevRoot = process.env.PAPERCUSP_FLIGHT_RECORDER_DIR;
  process.env.PAPERCUSP_SPAWN_ID = 's-test-flightrec';
  process.env.PAPERCUSP_FLIGHT_RECORDER_DIR = recorderRoot;
  const h = writeSpawnClaudeConfig(fakeHome);
  try {
    // Simulate claude writing a session transcript under the isolated config dir.
    const projDir = join(h.configDir, 'projects', '-some-cwd-slug');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'abc.jsonl'), '{"type":"system","content":"mcp mount failed"}\n');

    h.cleanup();

    // The temp config dir is gone, but the transcript survives, keyed by spawn id.
    assert.throws(() => statSync(h.configDir), 'cleanup removes the temp config dir');
    assert.equal(
      readFileSync(join(recorderRoot, 's-test-flightrec', '-some-cwd-slug', 'abc.jsonl'), 'utf8'),
      '{"type":"system","content":"mcp mount failed"}\n',
      'transcript preserved to the flight recorder before deletion',
    );
  } finally {
    if (prevSpawnId === undefined) delete process.env.PAPERCUSP_SPAWN_ID;
    else process.env.PAPERCUSP_SPAWN_ID = prevSpawnId;
    if (prevRoot === undefined) delete process.env.PAPERCUSP_FLIGHT_RECORDER_DIR;
    else process.env.PAPERCUSP_FLIGHT_RECORDER_DIR = prevRoot;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(recorderRoot, { recursive: true, force: true });
  }
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
    // cwd + the allow-listed pkg-cache root (uniform across roles, D-013/P-014)
    assert.deepEqual(s.sandbox.filesystem.allowWrite, ['.', FLEET_SANDBOX_CACHE_ROOT], `${r} cwd write`);
    // cred protection + the registry egress allowlist are uniform across roles
    assert.ok(s.sandbox.filesystem.denyRead.includes('~/.ssh'));
    assert.ok(s.sandbox.network.allowedDomains.includes('registry.npmjs.org'));
  }
});

test('resolveFleetAllowedDomains — base list (registries + common toolchain CDNs) by default (no env)', () => {
  delete process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS;
  delete process.env.PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS;
  const d = resolveFleetAllowedDomains();
  assert.deepEqual(d, [...FLEET_SANDBOX_ALLOWED_DOMAINS]);
  assert.ok(d.includes('registry.npmjs.org'));
  // P-013/D-015: default-on base covers the common toolchain CDNs out-of-box
  assert.ok(d.includes('cdn.playwright.dev'), 'Playwright browser CDN in base');
  assert.ok(d.includes('playwright.download.prss.microsoft.com'), 'Playwright fallback in base');
  assert.ok(d.includes('nodejs.org'), 'node-gyp headers host in base');
  assert.ok(!d.includes('example.com'));
});

test('resolveFleetAllowedDomains — APPEND var adds deployment hosts (comma/space-separated, trimmed, deduped, base kept)', () => {
  delete process.env.PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS;
  // use sentinel hosts NOT in the base, so this tests append (not membership)
  process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS =
    ' mirror.corp.test, registry.npmjs.org\tregistry.internal.corp ';
  try {
    const d = resolveFleetAllowedDomains();
    // base preserved
    assert.ok(d.includes('registry.npmjs.org'));
    assert.ok(d.includes('github.com'));
    // extras appended
    assert.ok(d.includes('mirror.corp.test'));
    assert.ok(d.includes('registry.internal.corp'));
    // deduped: the duplicate registry.npmjs.org appears exactly once
    assert.equal(d.filter((h) => h === 'registry.npmjs.org').length, 1);
  } finally {
    delete process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS;
  }
});

test('resolveFleetAllowedDomains — DENY_ALL_EGRESS lockdown → [] and wins over the append var', () => {
  process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS = 'mirror.corp.test';
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
  process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS = 'mirror.corp.test';
  try {
    const s = fleetSandboxSettingsForRole('validator') as any;
    assert.ok(s.sandbox.network.allowedDomains.includes('mirror.corp.test'));
    assert.ok(s.sandbox.network.allowedDomains.includes('registry.npmjs.org'));
  } finally {
    delete process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS;
  }
});

test('fleetSandboxEnabled — DEFAULT-ON (P-013): on when unset, opt out only with 0/false/off', () => {
  const saved = process.env.PAPERCUSP_FLEET_SANDBOX;
  try {
    delete process.env.PAPERCUSP_FLEET_SANDBOX;
    assert.equal(fleetSandboxEnabled(), true, 'unset → on by default');
    for (const v of ['1', 'true', 'TRUE', 'yes', '']) {
      process.env.PAPERCUSP_FLEET_SANDBOX = v;
      assert.equal(fleetSandboxEnabled(), true, `"${v}" → on`);
    }
    for (const v of ['0', 'false', 'off', 'OFF', 'False']) {
      process.env.PAPERCUSP_FLEET_SANDBOX = v;
      assert.equal(fleetSandboxEnabled(), false, `"${v}" → explicit opt-out`);
    }
  } finally {
    if (saved === undefined) delete process.env.PAPERCUSP_FLEET_SANDBOX;
    else process.env.PAPERCUSP_FLEET_SANDBOX = saved;
  }
});

test('fleetSandboxCacheEnv — redirects pkg-manager caches under the allow-listed cache root (D-013/P-014: $HOME is RO under the sandbox)', () => {
  const env = fleetSandboxCacheEnv('/some/project');
  // every cache path lives under the allow-listed root (so it is writable)
  for (const [k, v] of Object.entries(env)) {
    assert.ok(v.startsWith(FLEET_SANDBOX_CACHE_ROOT + '/'), `${k} (${v}) must be under the cache root`);
  }
  // the ecosystems a fleet toolchain actually hits
  assert.ok(env.npm_config_cache && env.PIP_CACHE_DIR && env.CARGO_HOME && env.YARN_CACHE_FOLDER);
  assert.ok(env.XDG_CACHE_HOME, 'XDG catch-all present (pip/playwright/etc.)');
  // absolute paths (independent of the child HOME)
  assert.ok(env.npm_config_cache.startsWith('/'));
});

test('fleetSandboxCacheEnv — per-project keying: different cwds get distinct cache dirs (no cross-project poisoning)', () => {
  const a = fleetSandboxCacheEnv('/project/a');
  const b = fleetSandboxCacheEnv('/project/b');
  assert.notEqual(a.npm_config_cache, b.npm_config_cache);
  // same cwd → stable (cache persists across spawns of one project)
  assert.equal(fleetSandboxCacheEnv('/project/a').npm_config_cache, a.npm_config_cache);
});

test('fleetSandboxSettingsForRole — allowWrite includes cwd AND the cache root (so a real install can write its cache)', () => {
  const s = fleetSandboxSettingsForRole('worker') as any;
  assert.ok(s.sandbox.filesystem.allowWrite.includes('.'), 'cwd writable');
  assert.ok(
    s.sandbox.filesystem.allowWrite.includes(FLEET_SANDBOX_CACHE_ROOT),
    'cache root writable (else npm/pip/cargo install → EROFS)',
  );
});

// --- codex + omp containment via external srt-wrap (P-017/D-017; D-018/D-019) ---

test('backendUsesSrt — codex + omp wrapped; claude-code uses its own sandbox', () => {
  assert.equal(backendUsesSrt('codex'), true);
  assert.equal(backendUsesSrt('omp'), true);
  assert.equal(backendUsesSrt('claude-code'), false);
});

test('fleetSrtModelDomains — codex gets the OpenAI hosts; omp relies on loopback (cloud via env)', () => {
  const codex = fleetSrtModelDomains('codex');
  assert.ok(codex.includes('api.openai.com'));
  assert.ok(codex.includes('chatgpt.com'));
  // omp's model is loopback here (covered by localhost/127.0.0.1 in the settings);
  // cloud-omp deployments add the host via PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS
  assert.deepEqual(fleetSrtModelDomains('omp'), []);
  assert.deepEqual(fleetSrtModelDomains('claude-code'), []);
});

test('buildFleetSrtSettings — codex: egress allowlist covers operator + model + registries; writes confined; creds hidden', () => {
  delete process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS;
  delete process.env.PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS;
  const codexHome = `${process.env.HOME ?? '/home/x'}/.papercusp/role-codex-homes/session-1`;
  const s = buildFleetSrtSettings({ cwd: '/proj', backend: 'codex', agentHomes: [codexHome] }) as any;
  const dom = s.network.allowedDomains;
  // operator (loopback) + model + registry all reachable through srt's proxy
  assert.ok(dom.includes('127.0.0.1') && dom.includes('localhost'), 'operator loopback');
  assert.ok(dom.includes('api.openai.com'), 'model endpoint');
  assert.ok(dom.includes('registry.npmjs.org'), 'package registry');
  // writes confined to cwd + cache root + the codex home
  assert.ok(s.filesystem.allowWrite.includes('/proj'));
  assert.ok(s.filesystem.allowWrite.includes(codexHome));
  // creds hidden, but the CODEX_HOME (under ~/.papercusp) re-allowed for read
  assert.ok(s.filesystem.denyRead.some((d: string) => d.endsWith('/.papercusp')));
  assert.ok(s.filesystem.allowRead && s.filesystem.allowRead.includes(codexHome),
    'CODEX_HOME re-allowed within the ~/.papercusp denyRead');
});

test('buildFleetSrtSettings — omp: ~/.omp + PI_CODING_AGENT_DIR writable; loopback model reachable; no allowRead (dirs outside denyRead)', () => {
  delete process.env.PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS;
  const home = process.env.HOME ?? '/home/x';
  const ompHome = `${home}/.omp`;
  const piDir = '/proj/.papercusp/pi-sessions';
  const s = buildFleetSrtSettings({ cwd: '/proj', backend: 'omp', agentHomes: [ompHome, piDir] }) as any;
  // omp's agent/auth/models SQLite dirs are writable (else readonly-DB at startup)
  assert.ok(s.filesystem.allowWrite.includes(ompHome));
  assert.ok(s.filesystem.allowWrite.includes(piDir));
  // loopback model + operator reachable through the proxy
  assert.ok(s.network.allowedDomains.includes('127.0.0.1') && s.network.allowedDomains.includes('localhost'));
  // ~/.omp + pi-sessions aren't under a denyRead dir → no allowRead needed
  assert.ok(!s.filesystem.allowRead, 'omp dirs outside denyRead');
});

test('buildFleetSrtSettings — multiple agentHomes; no allowRead when none under a denied dir', () => {
  const s = buildFleetSrtSettings({ cwd: '/proj', backend: 'codex', agentHomes: ['/tmp/codex-home'] }) as any;
  assert.ok(!s.filesystem.allowRead, 'no allowRead needed when home is outside denyRead');
  assert.ok(s.filesystem.allowWrite.includes('/tmp/codex-home'));
});

test('wrapSpawnWithSrt — codex+enabled+srt → srt -s … -c with no_proxy cleared + exec codex; prompt still on stdin', () => {
  const w = wrapSpawnWithSrt('codex', ['exec', '-', '--model', 'gpt-5.5'], {
    enabled: true, backend: 'codex', srtBin: '/usr/bin/srt', settingsPath: '/tmp/s.json',
  });
  assert.equal(w.command, '/usr/bin/srt');
  assert.deepEqual(w.argv.slice(0, 3), ['-s', '/tmp/s.json', '-c']);
  const shell = w.argv[3];
  assert.match(shell, /no_proxy=''/);
  assert.match(shell, /NO_PROXY=''/);
  assert.match(shell, /exec 'codex' 'exec' '-' '--model' 'gpt-5\.5'/);
});

test('wrapSpawnWithSrt — omp+enabled+srt → wrapped (no_proxy cleared + exec omp; @promptfile arg preserved)', () => {
  const w = wrapSpawnWithSrt('omp', ['-p', '@/tmp/prompt.txt', '--model', 'qwen2.5-coder:14b'], {
    enabled: true, backend: 'omp', srtBin: '/usr/bin/srt', settingsPath: '/tmp/s.json',
  });
  assert.equal(w.command, '/usr/bin/srt');
  const shell = w.argv[3];
  assert.match(shell, /no_proxy=''/);
  assert.match(shell, /exec 'omp' '-p' '@\/tmp\/prompt\.txt' '--model' 'qwen2\.5-coder:14b'/);
});

test('wrapSpawnWithSrt — passthrough for claude / disabled / missing srt', () => {
  // disabled
  assert.equal(wrapSpawnWithSrt('codex', ['exec'], { enabled: false, backend: 'codex', srtBin: '/usr/bin/srt', settingsPath: '/tmp/s.json' }).command, 'codex');
  // claude (uses its own --settings, not srt)
  assert.equal(wrapSpawnWithSrt('claude', ['-p'], { enabled: true, backend: 'claude-code', srtBin: '/usr/bin/srt', settingsPath: '/tmp/s.json' }).command, 'claude');
  // srt absent → unwrapped (the spawn site throws before this in practice)
  assert.equal(wrapSpawnWithSrt('omp', ['-p'], { enabled: true, backend: 'omp', srtBin: null, settingsPath: '/tmp/s.json' }).command, 'omp');
});

test('claudeSandboxArgs — enabled + claude-code → --settings with the per-role sandbox block', () => {
  const args = claudeSandboxArgs('claude-code', 'claude-stream-json', 'claude -p', true, true, 'worker');
  assert.equal(args[0], '--settings');
  const parsed = JSON.parse(args[1]);
  assert.equal(parsed.sandbox.enabled, true);
  assert.ok(parsed.sandbox.filesystem.denyRead.includes('~/.ssh'));
  assert.deepEqual(parsed.sandbox.filesystem.allowWrite, ['.', FLEET_SANDBOX_CACHE_ROOT]);
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

// ─── G4 / P-011: scopeSpawnEnvForRole — child agent-CLI env least-privilege ───
// The spawned claude/omp/codex CLI reaches every privileged surface via the
// SIGNED MCP HTTP endpoint (:3070), never via direct PG, so it does not need the
// operator's admin PG creds or the operator_secrets decryption key. The auditor
// is a read-only judge with no web_search → it additionally loses the decrypted
// search-provider API keys. Backend auth is session/OAuth-file based (claude →
// ~/.claude via resolveSpawnHome; codex → ~/.codex/auth.json symlinked into
// CODEX_HOME; omp → Meridian bridge), so NO API-key env must survive for any
// backend to run — stripping the API-key-named search keys is safe.

test('scopeSpawnEnvForRole — all roles drop operator PG/DB secrets, keep PATH/HOME', () => {
  const input = {
    DATABASE_URL: 'postgres://harness_admin:pw@localhost:5432/papercusp',
    PAPERCUSP_PG_DSN: 'postgres://x',
    PAPERCUSP_DB_ENCRYPTION_KEY: 'k-secret',
    PATH: '/usr/bin',
    HOME: '/home/u',
    TAVILY_API_KEY: 'tvly-xxx',
  };
  const out = scopeSpawnEnvForRole(input, 'worker');
  assert.equal(out.DATABASE_URL, undefined, 'admin DATABASE_URL stripped');
  assert.equal(out.PAPERCUSP_PG_DSN, undefined, 'PG DSN stripped');
  assert.equal(out.PAPERCUSP_DB_ENCRYPTION_KEY, undefined, 'decryption key stripped');
  // PATH/HOME survive (HOME is re-derived per-spawn but must not be stripped here).
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.HOME, '/home/u');
  // A worker uses web_search → keeps the search-provider key.
  assert.equal(out.TAVILY_API_KEY, 'tvly-xxx', 'worker keeps search keys (uses web_search)');
});

test('scopeSpawnEnvForRole — auditor additionally strips ALL search-provider keys, keeps PATH/HOME', () => {
  const input: NodeJS.ProcessEnv = {
    DATABASE_URL: 'postgres://x',
    PAPERCUSP_PG_DSN: 'postgres://x',
    PAPERCUSP_DB_ENCRYPTION_KEY: 'k',
    PATH: '/usr/bin',
    HOME: '/home/u',
  };
  // Seed every canonical search-provider env key.
  for (const k of SEARCH_PROVIDER_ENV_KEYS) input[k] = `val-${k}`;
  const out = scopeSpawnEnvForRole(input, 'auditor');
  // PG/DB secrets gone (all-roles rule).
  for (const k of SPAWN_ENV_ALL_ROLES_STRIP) {
    assert.equal(out[k], undefined, `${k} stripped for auditor`);
  }
  // Every search-provider key gone (auditor is read-only; no web_search).
  for (const k of SEARCH_PROVIDER_ENV_KEYS) {
    assert.equal(out[k], undefined, `auditor must not carry search key ${k}`);
  }
  // Backend-auth + non-secret env survives — no API-key env is needed for any
  // backend (session/OAuth-file auth), so the auditor still produces a verdict.
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.HOME, '/home/u');
});

test('scopeSpawnEnvForRole — returns a COPY; never mutates the input', () => {
  const input = {
    DATABASE_URL: 'postgres://x',
    TAVILY_API_KEY: 'tvly-xxx',
    PATH: '/usr/bin',
  };
  const snapshot = { ...input };
  const out = scopeSpawnEnvForRole(input, 'auditor');
  assert.deepEqual(input, snapshot, 'input env object is not mutated');
  assert.notEqual(out, input, 'returns a distinct object');
});

test('scopeSpawnEnvForRole — non-auditor review roles behave like worker (keep search keys, strip PG/DB)', () => {
  const input = {
    DATABASE_URL: 'postgres://x',
    PAPERCUSP_DB_ENCRYPTION_KEY: 'k',
    TAVILY_API_KEY: 'tvly-xxx',
    EXA_API_KEY: 'exa-xxx',
    PATH: '/usr/bin',
  };
  for (const role of ['validator', 'scoper', 'documenter', 'unknown-role', '']) {
    const out = scopeSpawnEnvForRole(input, role);
    assert.equal(out.DATABASE_URL, undefined, `${role}: PG creds stripped`);
    assert.equal(out.PAPERCUSP_DB_ENCRYPTION_KEY, undefined, `${role}: decryption key stripped`);
    assert.equal(out.TAVILY_API_KEY, 'tvly-xxx', `${role}: keeps search keys (not the auditor)`);
    assert.equal(out.EXA_API_KEY, 'exa-xxx', `${role}: keeps search keys`);
    assert.equal(out.PATH, '/usr/bin');
  }
});

test('SEARCH_PROVIDER_ENV_KEYS — mirrors the apps/operator SEARCH_PROVIDERS canonical names', () => {
  // Cross-reference: apps/operator/lib/search-provider-credentials.ts SEARCH_PROVIDERS
  // (primaries + alternates + the SearXNG fields). Kept in sync by hand; this test
  // pins the names so a drift is caught here.
  for (const k of [
    'TAVILY_API_KEY', 'PERPLEXITY_API_KEY', 'PPLX_API_KEY', 'BRAVE_API_KEY',
    'JINA_API_KEY', 'MOONSHOT_SEARCH_API_KEY', 'KIMI_SEARCH_API_KEY', 'MOONSHOT_API_KEY',
    'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CODEX_API_KEY', 'ZAI_API_KEY',
    'EXA_API_KEY', 'PARALLEL_API_KEY', 'KAGI_API_KEY', 'SYNTHETIC_API_KEY',
    'SEARXNG_ENDPOINT', 'SEARXNG_TOKEN', 'SEARXNG_BASIC_USERNAME', 'SEARXNG_BASIC_PASSWORD',
  ]) {
    assert.ok(SEARCH_PROVIDER_ENV_KEYS.includes(k), `${k} must be in SEARCH_PROVIDER_ENV_KEYS`);
  }
});

test('healSandboxZeroByteManifest — repairs ONLY an existing 0-byte package.json (the sandbox mask artifact)', async () => {
  const { healSandboxZeroByteManifest } = await import('./invoke.js');
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-heal-'));
  try {
    // No package.json → untouched (the heal never CREATES one).
    healSandboxZeroByteManifest(dir);
    assert.throws(() => statSync(join(dir, 'package.json')));

    // 0-byte (what claude's sandbox leaves behind in a manifest-less cwd —
    // ERR_INVALID_PACKAGE_CONFIG for every later spawn) → repaired to valid JSON.
    writeFileSync(join(dir, 'package.json'), '');
    const logs: string[] = [];
    healSandboxZeroByteManifest(dir, (m) => logs.push(m));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')), {});
    assert.ok(logs.some((m) => m.includes('healed 0-byte package.json')), 'heal is logged');

    // Non-empty content — even INVALID json — is the project's own; never touched.
    writeFileSync(join(dir, 'package.json'), '{not json');
    healSandboxZeroByteManifest(dir);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{not json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
