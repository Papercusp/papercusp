import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  invoke,
  findPriorRunForIdempotency,
  extractResult,
  resolveSubstrateSelfSlug,
  splitCommand,
  nextOuterActivityEchoAt,
  OUTER_ACTIVITY_ECHO_THROTTLE_MS,
  resolvePromptOverride,
  resolvePromptOverrideWithStore,
  resolveTimeout,
  resolveModel,
  resolveAgentForRole,
  resolveAgentExecutionEngine,
  selectStreamFormat,
  streamFormatFlags,
  hasOmpTerminalProviderError,
  resolveInvocationExitCode,
  summarizeInvocationStream,
  workerParityPromptHash,
  claudeMcpArgs,
  FLEET_ALLOWED_TOOLS,
  BEE_ALLOWED_TOOLS,
  BEE_MCP_TOOL_NAMES,
  CORE_MCP_TOOL_NAMES,
  CORE_ALLOWED_TOOLS,
  QUEEN_ALLOWED_TOOLS,
  QUEEN_MCP_TOOL_NAMES,
  OVERWATCH_MCP_TOOL_NAMES,
  FLEET_DISALLOWED_TOOLS,
  FLEET_NO_WRITE_ROLES,
  fleetAllowedToolsForRole,
  fleetDisallowedToolsForRole,
  resolveRoleToolScope,
  fleetCapabilityOnlyEnabled,
  FLEET_CAPABILITY_REPLACED_TOOLS,
  FLEET_CAPABILITY_ROLES,
  ensureFleetGitHooksDir,
  gitConfigNoPushEnv,
  claudeSpawnEnvHardening,
  resolveSpawnHome,
  claudeSandboxArgs,
  codexSandboxArgs,
  fleetOmpToolsArgs,
  FLEET_OMP_CAPABILITY_ALLOWED_TOOLS,
  invokeMcpToolNamesForRole,
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
  FAILURE_LOOP_SESSION_KEY_ENV,
  SPAWN_ENV_ALL_ROLES_STRIP,
  SEARCH_PROVIDER_ENV_KEYS,
  normalizeExplicitModelFlagsForBackend,
  codexContextConfigFromArgv,
} from './invoke.js';
import { ROLE_MODEL_DEFAULTS } from './role-models.js';
import { writeSpawnClaudeConfig } from './spawn-mcp.js';

// Hermetic env: several resolvers fall back to host session env vars, so on the
// shared dev box they leak into the suite — green in a clean shell, red under a
// live session / the green-checkpoint gate (which strips `PAPERCUSP_*` but NOT
// `AGENT_MODELS`). The leak vectors:
//   - `AGENT_MODELS`                     → `resolveModel({},'worker')` returns the
//                                          host pick (e.g. "opus") instead of the
//                                          committed default, and the `invoke(cat)`
//                                          end-to-end leaks a stray `--model` arg.
//   - `PAPERCUSP_SPAWN_MODEL`            → outranks the whole `resolveModel` chain
//                                          (same `--model` leak, even harder).
//   - `PAPERCUSP_FLEET_CAPABILITY_ONLY`  → flips the capability cutover, shifting
//                                          `claudeMcpArgs`'s allow-list off-default.
//   - `PAPERCUSP_FLEET_SANDBOX*`         → shift the sandbox enable/egress
//                                          (`resolveFleetAllowedDomains`) assertions.
//   - `AGENT_CMD` / `CLAUDE` / `AGENT_BACKEND` / `PAPERCUSP_SPAWN_BACKEND`
//                                       → make invoke() resolve a fixture `claude`
//                                         stub as the live session's codex backend.
//   - `PAPERCUSP_INTEGRATION_ROOT`       → redirects prompt resolution away from
//                                         the fixture harnessDir to the integration
//                                         checkout, so prompt-content assertions
//                                         read the real built-in prompts.
// Snapshot + clear them per-test so the suite measures the committed defaults,
// never the host's identity; tests that need one set it themselves.
// (release-pipeline-resilience-2026-06-09 P-001; EI-942 env isolation.)
const SESSION_ENV_KEYS = [
  'AGENT_BACKEND',
  'AGENT_CMD',
  'AGENT_MODELS',
  'CLAUDE',
  'PAPERCUSP_INTEGRATION_ROOT',
  'PAPERCUSP_SPAWN_BACKEND',
  'PAPERCUSP_SPAWN_MODEL',
  'HARNESS_CONFIG_JSON',
  'PAPERCUSP_FLEET_CAPABILITY_ONLY',
  'PAPERCUSP_FLEET_SANDBOX',
  'PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS',
  'PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS',
] as const;
const _sessionEnvSnapshot: Partial<Record<(typeof SESSION_ENV_KEYS)[number], string | undefined>> = {};
beforeEach(() => {
  for (const k of SESSION_ENV_KEYS) {
    _sessionEnvSnapshot[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of SESSION_ENV_KEYS) {
    const prev = _sessionEnvSnapshot[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
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
  mkdirSync(join(harnessDir, 'blueprints', 'base', 'prompts'), { recursive: true });
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

test('codexContextConfigFromArgv — copies only a complete valid window pair', () => {
  assert.deepEqual(
    codexContextConfigFromArgv([
      'codex', 'exec', '-c', 'model_context_window=1000000',
      '-c', 'model_auto_compact_token_limit=900000',
    ]),
    { modelContextWindow: 1_000_000, modelAutoCompactTokenLimit: 900_000 },
  );
  assert.equal(codexContextConfigFromArgv(['codex', '-c', 'model_context_window=1000000']), null);
  assert.equal(
    codexContextConfigFromArgv([
      'codex', '-c', 'model_context_window=900000',
      '-c', 'model_auto_compact_token_limit=1000000',
    ]),
    null,
  );
});

// --- WI-3302: outer-process activity echo throttle (last_output_at fix) --
test('nextOuterActivityEchoAt — fires on the very first call (lastEchoAt=null)', () => {
  assert.equal(nextOuterActivityEchoAt(null, 1_000), 1_000);
});

test('nextOuterActivityEchoAt — suppressed within the throttle window', () => {
  const first = nextOuterActivityEchoAt(null, 1_000)!;
  assert.equal(nextOuterActivityEchoAt(first, first + OUTER_ACTIVITY_ECHO_THROTTLE_MS - 1), null);
});

test('nextOuterActivityEchoAt — fires again once the throttle window elapses', () => {
  const first = nextOuterActivityEchoAt(null, 1_000)!;
  const now = first + OUTER_ACTIVITY_ECHO_THROTTLE_MS;
  assert.equal(nextOuterActivityEchoAt(first, now), now);
});

test('nextOuterActivityEchoAt — respects a custom throttle window', () => {
  assert.equal(nextOuterActivityEchoAt(100, 105, 10), null);
  assert.equal(nextOuterActivityEchoAt(100, 110, 10), 110);
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

test('resolveSubstrateSelfSlug — prefers $HARNESS_SLUG (the registry slug) over the config slug (EI-787)', () => {
  const prevHarness = process.env.HARNESS_SLUG;
  const prevPapercusp = process.env.PAPERCUSP_HARNESS_SLUG;
  try {
    process.env.HARNESS_SLUG = 'xbq72ugvaz-the-real-registry-slug';
    delete process.env.PAPERCUSP_HARNESS_SLUG;
    // The config's own `slug` field diverges (the benchmark-harness repro from EI-787) —
    // the env-injected registry slug must win, not the config value.
    assert.equal(
      resolveSubstrateSelfSlug({ slug: 'extbench-q1ubTg' }, '/some/project/dir'),
      'xbq72ugvaz-the-real-registry-slug',
    );
  } finally {
    if (prevHarness === undefined) delete process.env.HARNESS_SLUG; else process.env.HARNESS_SLUG = prevHarness;
    if (prevPapercusp === undefined) delete process.env.PAPERCUSP_HARNESS_SLUG; else process.env.PAPERCUSP_HARNESS_SLUG = prevPapercusp;
  }
});

test('resolveSubstrateSelfSlug — falls back to the config slug when no env/registry slug resolves to it', () => {
  const prevHarness = process.env.HARNESS_SLUG;
  const prevPapercusp = process.env.PAPERCUSP_HARNESS_SLUG;
  try {
    delete process.env.HARNESS_SLUG;
    delete process.env.PAPERCUSP_HARNESS_SLUG;
    // No env override: harnessSlugFromProjectDir resolves to the directory basename
    // (a non-empty string), so the config `slug` fallback is never reached here —
    // this asserts the basename-resolution leg still returns a usable, non-empty slug.
    assert.equal(resolveSubstrateSelfSlug({ slug: 'ignored-when-basename-resolves' }, '/some/my-project-dir'), 'my-project-dir');
  } finally {
    if (prevHarness === undefined) delete process.env.HARNESS_SLUG; else process.env.HARNESS_SLUG = prevHarness;
    if (prevPapercusp === undefined) delete process.env.PAPERCUSP_HARNESS_SLUG; else process.env.PAPERCUSP_HARNESS_SLUG = prevPapercusp;
  }
});

test('resolveModel — returns empty when missing (role without a committed tier default)', () => {
  // `reviewer` is unmapped in ROLE_MODEL_DEFAULTS (merge-resolver served here until the
  // launch-fixer family pinned opus:xhigh — git-sync-content-guard D-008 follow-up).
  assert.equal(resolveModel({}, 'reviewer'), '');
});

test('resolveModel — returns named model', () => {
  assert.equal(resolveModel({ models: { worker: 'sonnet' } }, 'worker'), 'sonnet');
});

test('resolveModel — falls back to the committed ROLE_MODEL_DEFAULTS floor (EI-7)', () => {
  const prev = process.env.AGENT_MODELS;
  try {
    delete process.env.AGENT_MODELS; // no env, no config
    // release-manager has a committed default; an unmapped role (reviewer) does not.
    assert.equal(resolveModel({}, 'release-manager'), ROLE_MODEL_DEFAULTS['release-manager']);
    assert.equal(resolveModel({}, 'release-manager'), 'opus:xhigh');
    assert.equal(resolveModel({}, 'reviewer'), '');
    // P-012 model-tier policy: execution tier = sonnet, volume tier = haiku.
    assert.equal(resolveModel({}, 'worker'), 'sonnet');
    assert.equal(resolveModel({}, 'validator'), 'sonnet');
    assert.equal(resolveModel({}, 'documenter'), 'sonnet');
    // Autonomous-loop floor (WI-4623, owner decision 2026-07-16): cup and judge
    // sit on sonnet-5 trimmed-mode ([1m] window) at high effort. This REVERTS the P-020
    // gpt-5.6-luna:high migration (WI-4640), which handed claude-backend roles a codex-only
    // id and hard-downed kettle@papercusp — see ROLE_MODEL_DEFAULTS' history comment.
    assert.equal(resolveModel({}, 'cup'), 'sonnet[1m]:high');
    assert.equal(resolveModel({}, 'judge'), 'sonnet[1m]:high');
    // ⚠ `scanner` left that floor on 2026-09-02 (owner directive, interactive) — it carries
    // an operator_agent_config roleBackends entry, so it moved to opus:xhigh with mug/kettle.
    // opus is claude-shaped, so the WI-4623 backend invariant above is preserved.
    assert.equal(resolveModel({}, 'scanner'), 'opus:xhigh');
    // The launch-fixer family's committed floors (D-008 follow-up): the two
    // fleet-blast-radius fixers pin opus:xhigh, and as of the same 2026-09-02 directive the
    // bounded content repairer joined them rather than staying on the sonnet execution tier.
    assert.equal(resolveModel({}, 'merge-resolver'), 'opus:xhigh');
    assert.equal(resolveModel({}, 'release-fixer'), 'opus:xhigh');
    assert.equal(resolveModel({}, 'content-fixer'), 'opus:xhigh');
    // The pot's judgment/control-loop layer (queen/bee/mug/kettle/overwatch/sentinel) sits on
    // the same sonnet[1m]:high floor (WI-4623). A trimmed sonnet spec infers the
    // claude/anthropic backend, keeping the spawn binary correct — the inverse of the luna
    // trap. Asserted individually (not via a loop over keys) so a regression on any ONE role
    // fails with that role's name in the assertion.
    assert.equal(resolveModel({}, 'queen'), 'sonnet[1m]:high');
    assert.equal(resolveModel({}, 'bee'), 'sonnet[1m]:high');
    assert.equal(resolveModel({}, 'overwatch'), 'sonnet[1m]:high');
    assert.equal(resolveModel({}, 'sentinel'), 'sonnet[1m]:high');
    // ⚠ mug and kettle left this floor on 2026-09-02 (owner directive, interactive): both
    // carry operator_agent_config roleBackends entries, so they moved to opus:xhigh. The
    // WI-4623 invariant that actually matters is UNCHANGED and still covered by the
    // claude-backend assertions elsewhere — opus is claude-shaped, so neither role can
    // reacquire the codex-only spec that hard-downed kettle@papercusp under P-020.
    assert.equal(resolveModel({}, 'mug'), 'opus:xhigh');
    assert.equal(resolveModel({}, 'kettle'), 'opus:xhigh');
    // operator has no committed default in ROLE_MODEL_DEFAULTS (interactive surface, not autonomous-loop).
    assert.equal(resolveModel({}, 'operator'), '');
  } finally {
    if (prev === undefined) delete process.env.AGENT_MODELS;
    else process.env.AGENT_MODELS = prev;
  }
});

test('resolveModel — per-spawn PAPERCUSP_SPAWN_MODEL outranks config AND env (queen-model-tier-selection P-001)', () => {
  const prevSpawn = process.env.PAPERCUSP_SPAWN_MODEL;
  const prevModels = process.env.AGENT_MODELS;
  try {
    process.env.PAPERCUSP_SPAWN_MODEL = 'opus:high';
    process.env.AGENT_MODELS = JSON.stringify({ worker: 'haiku' });
    // outranks the harness config (an explicit per-task pick is more specific
    // than any standing per-role pin), the env map, and the committed default.
    assert.equal(resolveModel({ models: { worker: 'sonnet' } }, 'worker'), 'opus:high');
    assert.equal(resolveModel({ aiBackend: { roles: { worker: { model: 'sonnet' } } } }, 'worker'), 'opus:high');
    assert.equal(resolveModel({}, 'release-manager'), 'opus:high');
    // empty/whitespace value falls through to the normal chain.
    process.env.PAPERCUSP_SPAWN_MODEL = '  ';
    assert.equal(resolveModel({}, 'worker'), 'haiku');
  } finally {
    if (prevSpawn === undefined) delete process.env.PAPERCUSP_SPAWN_MODEL;
    else process.env.PAPERCUSP_SPAWN_MODEL = prevSpawn;
    if (prevModels === undefined) delete process.env.AGENT_MODELS;
    else process.env.AGENT_MODELS = prevModels;
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
  // Role deliberately has NO committed ROLE_MODEL_DEFAULTS tier (P-012) — a
  // tiered role would get `--model <tier>` appended, which `cat` can't take.
  // (`merge-resolver` served here until the launch-fixer family pinned opus:xhigh
  // — D-008 follow-up; `reviewer` is the remaining floorless judgment role.)
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'reviewer.md'), '# REVIEWER');
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
      'reviewer',
      ['MODE=fresh'],
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.jsonlPath, /1700000000-reviewer\.jsonl$/);
    assert.ok(log.some((l) => l.includes('invoke reviewer rc=0')));
    // cat echoes our prompt back; the .out (plain-text branch) is the
    // captured prompt itself.
    const outBody = readFileSync(result.outPath, 'utf8');
    assert.match(outBody, /## Runtime context/);
    assert.match(outBody, /MODE=fresh/);
  } finally {
    fx.cleanup();
  }
});

test('invoke — accepted operation cannot reach a legacy autonomous worker subprocess', async () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'), '# WORKER');
  });
  const reads: string[] = [];
  try {
    await assert.rejects(
      () => invoke({
        harnessDir: fx.harnessDir, projectDir: fx.projectDir,
        stateDir: fx.stateDir, logDir: fx.logDir, phase: 'staging',
        claudeCmd: '/definitely/not/a/real-agent-binary', workspaceId: 'ws-test',
        pg: (async (strings: TemplateStringsArray) => {
          reads.push(strings.join(' '));
          return [{ payload: { blueprintOperation: { kind: 'blueprint-operation' } } }];
        }) as never,
        log: () => {}, nowSeconds: () => 1700000009,
      }, 'worker', ['FEATURE_ID=WI-1']),
      /accepted blueprint operation WI-1 requires an identity-bound worker launch/,
    );
    assert.equal(reads.length, 1);
    assert.match(reads[0]!, /harness_shared\.work_items/);
  } finally {
    fx.cleanup();
  }
});

test('invoke — standalone OMP ignores inherited fleet sandbox flag without srt', async () => {
  const fx = makeFixture(({ harnessDir, projectDir }) => {
    writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'), '# WORKER');
    const binDir = join(projectDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'omp'),
      "#!/bin/sh\nprintf '%s\\n' '" +
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'standalone ok' }] },
        }) +
        "' '" +
        JSON.stringify({ type: 'agent_end', messages: [] }) +
        "'\n",
      { mode: 0o755 },
    );
  });
  const previousPath = process.env.PATH;
  process.env.PAPERCUSP_FLEET_SANDBOX = '1';
  process.env.PATH = join(fx.projectDir, 'bin');
  try {
    const result = await invoke(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: join(fx.projectDir, 'bin', 'omp'),
        agentBackend: 'omp',
        log: () => {},
        nowSeconds: () => 1700000007,
      },
      'worker',
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'standalone ok');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fx.cleanup();
  }
});

test('invoke — workspace-scoped fleet preflights missing srt before spawning', async () => {
  const fx = makeFixture(({ harnessDir, projectDir }) => {
    writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'), '# WORKER');
    const binDir = join(projectDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'omp'),
      `#!/bin/sh\nprintf spawned > ${join(projectDir, 'spawned')}`,
      { mode: 0o755 },
    );
  });
  const previousPath = process.env.PATH;
  process.env.PAPERCUSP_FLEET_SANDBOX = '1';
  process.env.PATH = join(fx.projectDir, 'bin');
  try {
    await assert.rejects(
      () => invoke(
        {
          harnessDir: fx.harnessDir,
          projectDir: fx.projectDir,
          stateDir: fx.stateDir,
          logDir: fx.logDir,
          phase: 'staging',
          claudeCmd: join(fx.projectDir, 'bin', 'omp'),
          agentBackend: 'omp',
          workspaceId: 'ws-test',
          log: () => {},
          nowSeconds: () => 1700000008,
        },
        'worker',
      ),
      /PAPERCUSP_FLEET_SANDBOX is set.*srt.*not on PATH/,
    );
    assert.equal(existsSync(join(fx.projectDir, 'spawned')), false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fx.cleanup();
  }
});

test('invoke — workspace agent isolates package-manager caches when the OS sandbox is disabled', async () => {
  const fx = makeFixture(({ harnessDir, projectDir }) => {
    writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'), '# WORKER');
    const binDir = join(projectDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'agent'),
      '#!/bin/sh\nprintf "CACHE=%s\\n" "$npm_config_cache"\ncat >/dev/null\n',
      { mode: 0o755 },
    );
  });
  const previousFleetSandbox = process.env.PAPERCUSP_FLEET_SANDBOX;
  process.env.PAPERCUSP_FLEET_SANDBOX = '0';
  try {
    const result = await invoke(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: join(fx.projectDir, 'bin', 'agent'),
        workspaceId: 'ws-test',
        log: () => {},
        nowSeconds: () => 1700000008,
      },
      'worker',
    );

    assert.equal(result.exitCode, 0);
    assert.equal(
      readFileSync(result.outPath, 'utf8').trim(),
      `CACHE=${fleetSandboxCacheEnv(fx.projectDir).npm_config_cache}`,
    );
  } finally {
    if (previousFleetSandbox === undefined) delete process.env.PAPERCUSP_FLEET_SANDBOX;
    else process.env.PAPERCUSP_FLEET_SANDBOX = previousFleetSandbox;
    fx.cleanup();
  }
});

test('invoke — engine=loop uses the injected port and persists native NDJSON without spawning', async () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'), '# WORKER');
  });
  process.env.HARNESS_CONFIG_JSON = JSON.stringify({
    aiBackend: { roles: { worker: { engine: 'loop', model: 'claude-haiku-4-5' } } },
  });
  const seen: Record<string, unknown>[] = [];
  try {
    const result = await invoke(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        // Deliberately nonexistent: reaching spawn() would fail the test.
        claudeCmd: '/definitely/not/a/real-agent-binary',
        workspaceId: 'ws-test',
        ownedLoop: {
          async invoke(request) {
            seen.push(request as unknown as Record<string, unknown>);
            request.emit({ type: 'step_start', stepIndex: 0 });
            request.emit({ type: 'text_delta', stepIndex: 0, text: 'owned result' });
            request.emit({
              type: 'done',
              stopReason: 'complete',
              finalText: 'owned result',
              usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.001 },
              stepCount: 1,
            });
            return { exitCode: 0 };
          },
        },
        log: () => {},
        nowSeconds: () => 1700000005,
      },
      'worker',
      ['FEATURE_ID=F-010', 'CHUNK_ID=ck-parity-010'],
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'owned result');
    const captured = seen[0];
    assert.ok(captured);
    assert.equal(captured.model, 'claude-haiku-4-5');
    assert.equal(captured.role, 'worker');
    assert.equal(captured.featureId, 'F-010');
    assert.equal(captured.chunkId, 'ck-parity-010');
    assert.match(String(captured.prompt), /# WORKER/);
    const jsonl = readFileSync(result.jsonlPath, 'utf8');
    assert.match(jsonl, /"type":"done"/);
    assert.match(jsonl, /"backend":"owned-loop"/);
    const meta = JSON.parse(jsonl.trimEnd().split('\n').at(-1)!) as Record<string, unknown>;
    assert.equal(meta.schemaVersion, 'worker-parity-v1');
    assert.equal(meta.engine, 'loop');
    assert.equal(meta.requestedModel, 'claude-haiku-4-5');
    assert.equal(meta.featureId, 'F-010');
    assert.match(String(meta.promptHash), /^[0-9a-f]{64}$/);
    assert.deepEqual(meta.stream, {
      schemaVersion: 'invocation-stream-summary-v1',
      format: 'loop-ndjson',
      jsonLines: 3,
      malformedLines: 0,
      terminalEvents: 1,
      toolCalls: 0,
      toolResults: 0,
      finalTextChars: 12,
      ok: true,
      issues: [],
    });
    assert.equal(readFileSync(result.outPath, 'utf8'), 'owned result\n');
  } finally {
    fx.cleanup();
  }
});

test('invoke — omp gateway selector stamps requestedModel without the provider prefix (EI-21332047585299058)', async () => {
  const fx = makeFixture(({ harnessDir, projectDir }) => {
    writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'), '# WORKER');
    const binDir = join(projectDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'omp'),
      "#!/bin/sh\nprintf '%s\\n' '" +
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'gateway ok' }] },
        }) +
        "' '" +
        JSON.stringify({ type: 'agent_end', messages: [] }) +
        "'\n",
      { mode: 0o755 },
    );
  });
  const previousPath = process.env.PATH;
  const previousModelsYml = process.env.PAPERCUSP_OMP_MODELS_YML;
  const previousModelSelector = process.env.PAPERCUSP_OMP_MODEL_SELECTOR;
  const previousFleetSandbox = process.env.PAPERCUSP_FLEET_SANDBOX;
  process.env.PATH = join(fx.projectDir, 'bin');
  // Hermetic against hosts that export PAPERCUSP_FLEET_SANDBOX=1: this stub
  // spawn ships no `srt` shim and asserts run_meta stamping, not sandboxing.
  process.env.PAPERCUSP_FLEET_SANDBOX = '0';
  process.env.PAPERCUSP_OMP_MODELS_YML = join(fx.projectDir, 'models.yml');
  process.env.PAPERCUSP_OMP_MODEL_SELECTOR = 'papercusp-gateway/claude-haiku-4-5';
  try {
    const result = await invoke(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: join(fx.projectDir, 'bin', 'omp'),
        agentBackend: 'omp',
        log: () => {},
        nowSeconds: () => 1700000009,
      },
      'worker',
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'gateway ok');
    // Pairing reads the terminal papercusp.run_meta event: `model` keeps the
    // transport selector for cost attribution while `requestedModel` carries
    // the PUBLIC model, so a same-prompt/same-model omp-vs-loop pair is not
    // excluded just because the omp leg routed through the gateway provider.
    const jsonl = readFileSync(result.jsonlPath, 'utf8');
    const meta = JSON.parse(jsonl.trimEnd().split('\n').at(-1)!) as Record<string, unknown>;
    assert.equal(meta.schemaVersion, 'worker-parity-v1');
    assert.equal(meta.model, 'papercusp-gateway/claude-haiku-4-5');
    assert.equal(meta.requestedModel, 'claude-haiku-4-5');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousModelsYml === undefined) delete process.env.PAPERCUSP_OMP_MODELS_YML;
    else process.env.PAPERCUSP_OMP_MODELS_YML = previousModelsYml;
    if (previousModelSelector === undefined) delete process.env.PAPERCUSP_OMP_MODEL_SELECTOR;
    else process.env.PAPERCUSP_OMP_MODEL_SELECTOR = previousModelSelector;
    if (previousFleetSandbox === undefined) delete process.env.PAPERCUSP_FLEET_SANDBOX;
    else process.env.PAPERCUSP_FLEET_SANDBOX = previousFleetSandbox;
    fx.cleanup();
  }
});

test('invoke — engine=loop fails loud when the operator did not inject a port', async () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'), '# WORKER');
  });
  process.env.HARNESS_CONFIG_JSON = JSON.stringify({
    aiBackend: { roles: { worker: { engine: 'loop', model: 'claude-haiku-4-5' } } },
  });
  try {
    await assert.rejects(
      () => invoke({
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: 'true',
        workspaceId: 'ws-test',
        log: () => {},
      }, 'worker'),
      /requires an operator-injected ownedLoop port/,
    );
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
    writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'), '# WORKER');
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
    writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'), '# WORKER');
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
    // A headless claude spawn now carries TWO single-`=`-token denies as separate
    // argv elements (claude unions repeated --disallowedTools): the scheduler
    // lockout AND the subagent-fanout deny (owner mandate 2026-07-02). Each is one
    // `=` token (D-002 — the variadic space form would eat positionals).
    const denyLines = argvDump.split('\n').filter((l) => l.startsWith('--disallowedTools='));
    const schedulerDeny = denyLines.find((l) => l.includes('ScheduleWakeup'));
    assert.ok(schedulerDeny, `scheduler deny flag missing from spawned argv:\n${argvDump}`);
    assert.match(schedulerDeny, /ScheduleWakeup/);
    // The NESTED shell route to the OS scheduler rides as its OWN token, not
    // folded into the tool-lockout token: the ONE policy emits one
    // `--disallowedTools=` per RESTRICTION (P-005), and `no-native-scheduler`
    // (the tools) and `no-os-scheduler-shell` (the shell route) are two.
    // Requiring both names inside a single token asserted the pre-P-005 shape
    // and could only ever fail; the property that matters — the nested route is
    // denied in the argv the kernel delivered — is asserted here instead.
    const shellSchedulerDeny = denyLines.find((l) => l.includes('Bash(crontab:*)'));
    assert.ok(
      shellSchedulerDeny,
      `OS-scheduler shell-route deny flag missing from spawned argv:\n${argvDump}`,
    );
    assert.notEqual(
      shellSchedulerDeny,
      schedulerDeny,
      'the shell route and the tool lockout must be separate tokens (one flag per restriction)',
    );
    // The subagent-fanout deny rides alongside as its own token (Task + Agent).
    const subagentDeny = denyLines.find((l) => l.includes('Task') && l.includes('Agent'));
    assert.ok(subagentDeny, `subagent-fanout deny flag missing from spawned argv:\n${argvDump}`);
  } finally {
    fx.cleanup();
  }
});

// ── identities-v1 D-018 / D-021: sealed replacement is unconditional ────────
test('invoke — claude spawn always gets --system-prompt-file pointing at the sealed replacement base', async () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'), '# WORKER');
    writeFileSync(
      join(harnessDir, 'blueprints', 'base', 'prompts', 'agent-base-preamble.md'),
      '# NEUTRAL BASE',
    );
  });
  try {
    const binDir = join(fx.projectDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const stub = join(binDir, 'claude');
    // Print argv AND the system-prompt-file's contents (the token right after the flag),
    // so we verify the file actually carries our neutral base.
    writeFileSync(
      stub,
      '#!/bin/sh\nprintf "%s\\n" "$@"\nprev=""\nfor a in "$@"; do if [ "$prev" = "--system-prompt-file" ]; then echo "SYSFILE_CONTENT:"; cat "$a"; fi; prev="$a"; done\ncat >/dev/null\n',
      { mode: 0o755 },
    );
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
        nowSeconds: () => 1700000004,
      },
      'worker',
      [],
    );
    assert.equal(result.exitCode, 0);
    const argvDump = readFileSync(result.jsonlPath, 'utf8');
    assert.ok(
      argvDump.split('\n').some((l) => l === '--system-prompt-file'),
      `flag ON must inject --system-prompt-file:\n${argvDump}`,
    );
    // The replacement file carries our neutral preamble (not the Claude default).
    // P-003: the replacement system prompt renders under the kernel SEAL — the precedence
    // statement opens the file and the kernel base text is LAST (identities, when any, above).
    assert.match(argvDump, /SYSFILE_CONTENT:\n<!-- PAPERCUSP-KERNEL:SEAL -->\n## Kernel precedence — the seal\n/);
    assert.match(argvDump, /\n\n# NEUTRAL BASE\n/);
  } finally {
    fx.cleanup();
  }
});

test('invoke — a harness-local blueprint carries its resolved domain parent into the replacement system prompt (P-024)', async () => {
  const fx = makeFixture(({ harnessDir, stateDir }) => {
    writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'), '# WORKER');
    writeFileSync(
      join(harnessDir, 'blueprints', 'base', 'prompts', 'agent-base-preamble.md'),
      '# NEUTRAL BASE',
    );
    mkdirSync(join(harnessDir, 'blueprints', 'papercusp-engineer', 'prompts'), { recursive: true });
    writeFileSync(
      join(harnessDir, 'blueprints', 'papercusp-engineer', 'prompts', 'agent-base-overlay.md'),
      '# PAPERCUSP ENGINEERING DOMAIN',
    );
    writeFileSync(
      join(stateDir, 'blueprint.yaml'),
      [
        'id: papercusp',
        'extends: papercusp-engineer',
        'kind: pot',
        'version: 0.1.0',
        'workItem: { kind: feature, idPrefix: WI }',
        'roles: [{ id: su }]',
        'spine: { decider: su, edges: { DONE: { to: done } }, default: { to: idle } }',
      ].join('\n'),
      'utf8',
    );
  });
  try {
    const binDir = join(fx.projectDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const stub = join(binDir, 'claude');
    writeFileSync(
      stub,
      '#!/bin/sh\nprintf "%s\\n" "$@"\nprev=""\nfor a in "$@"; do if [ "$prev" = "--system-prompt-file" ]; then echo "SYSFILE_CONTENT:"; cat "$a"; fi; prev="$a"; done\ncat >/dev/null\n',
      { mode: 0o755 },
    );
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
        nowSeconds: () => 1700000005,
      },
      'worker',
      [],
    );
    assert.equal(result.exitCode, 0);
    const argvDump = readFileSync(result.jsonlPath, 'utf8');
    assert.match(argvDump, /SYSFILE_CONTENT:[\s\S]*# PAPERCUSP ENGINEERING DOMAIN/);
    assert.match(argvDump, /# PAPERCUSP ENGINEERING DOMAIN[\s\S]*# NEUTRAL BASE/);
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
  assert.deepEqual(streamFormatFlags('loop-ndjson'), []);
  assert.deepEqual(streamFormatFlags('none'), []);
});

test('summarizeInvocationStream — loop stream is green only with one terminal and balanced tools', () => {
  const green = [
    JSON.stringify({ type: 'step_start', stepIndex: 0 }),
    JSON.stringify({ type: 'tool_call', stepIndex: 0, call: { id: 'c1', name: 'capability:read' } }),
    JSON.stringify({ type: 'tool_result', stepIndex: 0, callId: 'c1', name: 'capability:read' }),
    JSON.stringify({ type: 'done', finalText: 'DONE', usage: { inputTokens: 3, outputTokens: 1 } }),
  ].join('\n');
  assert.deepEqual(summarizeInvocationStream(green, 'loop-ndjson', 'DONE'), {
    schemaVersion: 'invocation-stream-summary-v1',
    format: 'loop-ndjson',
    jsonLines: 4,
    malformedLines: 0,
    terminalEvents: 1,
    toolCalls: 1,
    toolResults: 1,
    finalTextChars: 4,
    ok: true,
    issues: [],
  });

  const broken = `${green}\nnot-json\n${JSON.stringify({ type: 'tool_call', call: { id: 'c2' } })}`;
  const summary = summarizeInvocationStream(broken, 'loop-ndjson', 'DONE');
  assert.equal(summary.ok, false);
  assert.equal(summary.malformedLines, 1);
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.toolResults, 1);
  assert.ok(summary.issues.some((issue) => issue.includes('unbalanced native tool events')));
});

test('summarizeInvocationStream — omp requires its agent_end terminal and non-empty extracted text', () => {
  const green = [
    JSON.stringify({ type: 'message_end', message: { role: 'assistant' } }),
    JSON.stringify({ type: 'agent_end', messages: [] }),
  ].join('\n');
  assert.equal(summarizeInvocationStream(green, 'omp-json', 'DONE').ok, true);

  const missingTerminal = summarizeInvocationStream(
    JSON.stringify({ type: 'message_end', message: { role: 'assistant' } }),
    'omp-json',
    'DONE',
  );
  assert.equal(missingTerminal.ok, false);
  assert.ok(missingTerminal.issues.some((issue) => issue.includes('terminal event')));
  assert.equal(summarizeInvocationStream(green, 'omp-json', '').ok, false);
});

test('resolveInvocationExitCode — terminal OMP provider errors override a zero child exit', () => {
  const errorMessage = {
    role: 'assistant',
    stopReason: 'error',
    errorMessage: 'invalid x-api-key',
    errorStatus: 401,
    content: [],
  };
  const stream = [
    JSON.stringify({ type: 'message_end', message: errorMessage }),
    JSON.stringify({ type: 'agent_end', messages: [errorMessage] }),
  ].join('\n');

  assert.equal(hasOmpTerminalProviderError(stream, 'omp-json'), true);
  assert.equal(resolveInvocationExitCode(0, stream, 'omp-json'), 1);
  assert.equal(resolveInvocationExitCode(17, stream, 'omp-json'), 17);
  assert.equal(resolveInvocationExitCode(0, stream, 'claude-stream-json'), 0);
  assert.ok(summarizeInvocationStream(stream, 'omp-json', '').issues.includes('terminal provider error'));
});

test('invoke — OMP terminal provider error is returned as a failed invocation', async () => {
  const fx = makeFixture(({ harnessDir, projectDir }) => {
    writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'), '# WORKER');
    const binDir = join(projectDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'omp'),
      "#!/bin/sh\nprintf '%s\\n' '" +
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'invalid x-api-key',
            errorStatus: 401,
            content: [],
          },
        }) +
        "' '" +
        JSON.stringify({
          type: 'agent_end',
          messages: [{
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'invalid x-api-key',
            errorStatus: 401,
            content: [],
          }],
        }) +
        "'\n",
      { mode: 0o755 },
    );
  });
  try {
    const result = await invoke(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: join(fx.projectDir, 'bin', 'omp'),
        agentBackend: 'omp',
        log: () => {},
        nowSeconds: () => 1700000006,
      },
      'worker',
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.output, '');
    assert.match(readFileSync(result.jsonlPath, 'utf8'), /invalid x-api-key/);
  } finally {
    fx.cleanup();
  }
});

test('workerParityPromptHash — inline canary prompt stays pairable across per-run prompt tails', () => {
  const inline = 'Call capability:read once, then answer PARITY_OK.';
  const a = workerParityPromptHash(`${inline}\nrunId=a`, inline);
  const b = workerParityPromptHash(`${inline}\nrunId=b`, inline);
  assert.equal(a, b);
  assert.notEqual(workerParityPromptHash(`${inline}\nrunId=a`), workerParityPromptHash(`${inline}\nrunId=b`));
});

test('extractResult — owned loop reads terminal done and salvages deltas without it', () => {
  const terminal = [
    JSON.stringify({ type: 'text_delta', stepIndex: 0, text: 'partial' }),
    JSON.stringify({ type: 'done', finalText: 'NEXT_WORKER F-010', usage: {} }),
    JSON.stringify({ type: 'papercusp.run_meta', backend: 'owned-loop' }),
  ].join('\n');
  assert.equal(extractResult(terminal, 'loop-ndjson'), 'NEXT_WORKER F-010');

  const truncated = [
    JSON.stringify({ type: 'text_delta', stepIndex: 0, text: 'working ' }),
    'malformed',
    JSON.stringify({ type: 'text_delta', stepIndex: 0, text: 'state' }),
  ].join('\n');
  assert.equal(extractResult(truncated, 'loop-ndjson'), 'working state');
});

test('resolveAgentForRole — empty config falls through to fallbackCmd', () => {
  const out = resolveAgentForRole({}, 'worker', 'omp -p');
  assert.equal(out.agentCmd, 'omp -p');
  assert.deepEqual(out.extraArgs, []);
});

test('resolveAgentExecutionEngine — defaults subprocess; role loop beats default', () => {
  assert.equal(resolveAgentExecutionEngine({}, 'worker'), 'subprocess');
  assert.equal(
    resolveAgentExecutionEngine({ aiBackend: { default: { engine: 'loop' } } }, 'validator'),
    'loop',
  );
  assert.equal(
    resolveAgentExecutionEngine({
      aiBackend: {
        default: { engine: 'subprocess' },
        roles: { worker: { engine: 'loop' } },
      },
    }, 'worker'),
    'loop',
  );
  assert.throws(
    () => resolveAgentExecutionEngine({ aiBackend: { default: { engine: 'bogus' as never } } }, 'worker'),
    /expected subprocess\|loop/,
  );
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

test('normalizeExplicitModelFlagsForBackend — codex command model flags accept chatgpt aliases', () => {
  assert.deepEqual(
    normalizeExplicitModelFlagsForBackend(['codex', 'exec', '--model', 'chatgpt:5.5', '-c', 'x=y'], 'codex'),
    ['codex', 'exec', '--model', 'gpt-5.5', '-c', 'x=y'],
  );
  assert.deepEqual(
    normalizeExplicitModelFlagsForBackend(['codex', 'exec', '--model=chatgpt:5.5:high'], 'codex'),
    ['codex', 'exec', '--model=gpt-5.5'],
  );
  assert.deepEqual(
    normalizeExplicitModelFlagsForBackend(['claude', '-p', '--model', 'chatgpt:5.5'], 'claude-code'),
    ['claude', '-p', '--model', 'chatgpt:5.5'],
  );
});

// WI-10006244: claude drops an effort carried inside --model, so an explicit
// `<model>:<effort>` on a claude-code command is split into --effort.
test('normalizeExplicitModelFlagsForBackend — claude-code splits an explicit model effort into --effort', () => {
  assert.deepEqual(
    normalizeExplicitModelFlagsForBackend(['claude', '-p', '--model', 'opus:xhigh', '--verbose'], 'claude-code'),
    ['claude', '-p', '--model', 'opus', '--effort', 'max', '--verbose'],
  );
  assert.deepEqual(
    normalizeExplicitModelFlagsForBackend(['claude', '-p', '--model=sonnet[1m]:high'], 'claude-code'),
    ['claude', '-p', '--model', 'sonnet[1m]', '--effort', 'high'],
  );
  // An explicit --effort already on the command wins; only the model is cleaned.
  assert.deepEqual(
    normalizeExplicitModelFlagsForBackend(['claude', '-p', '--effort', 'low', '--model', 'opus:xhigh'], 'claude-code'),
    ['claude', '-p', '--effort', 'low', '--model', 'opus'],
  );
  // No model flag: byte-identical.
  assert.deepEqual(
    normalizeExplicitModelFlagsForBackend(['claude', '-p'], 'claude-code'),
    ['claude', '-p'],
  );
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

test('fleetAllowedToolsForRole — mug uses a compact explicit MCP subset, not the server wildcard', () => {
  const allowed = fleetAllowedToolsForRole('mug');
  assert.deepEqual(allowed, [...QUEEN_ALLOWED_TOOLS]);
  assert.ok(!allowed.includes('mcp__papercusp'), 'mug must not load the full MCP schema wildcard');
  assert.ok(QUEEN_MCP_TOOL_NAMES.includes('pot:survey'), 'queen MCP listing hint must use colon-form names');
  assert.ok(!QUEEN_MCP_TOOL_NAMES.includes('coord:inbox'), 'queen MCP listing hint must omit broad ambient inbox tools');
  for (const required of [
    // P-016 pot-lexicon renames: hive:survey→pot:survey, hive:declare-wake→
    // pot:declare-wake, scout:grade-idea→blender:grade-idea.
    // P-059/D-087: bee:spawn→cup:spawn is RETIRED with the Mug/Kettle/Cup tier,
    // so it is gone from QUEEN_MCP_TOOL_NAMES (see the comment at invoke.ts:645).
    // Per D-087 a retiring ALLOW-list entry is RE-POINTED to whatever now occupies
    // that role, never simply deleted: dropping it would narrow this assert to
    // NOTHING on the spawn/placement axis it exists to hold, in the direction no
    // test detects (every remaining assertion still passes). fleet:place_batch is
    // the surviving placement door in the Queen's kit.
    'mcp__papercusp__pot_survey',
    'mcp__papercusp__pot_declare-wake',
    'mcp__papercusp__fleet_place_batch',
    'mcp__papercusp__fleet_assignments',
    'mcp__papercusp__coord_send',
    'mcp__papercusp__coord_wake',
    'mcp__papercusp__blender_grade-idea',
    'mcp__papercusp__plans_promote',
    'mcp__papercusp__plans_set-plan-status',
    'mcp__papercusp__work_items_create',
    'mcp__papercusp__work_items_set_state',
    'mcp__papercusp__improvements_capture',
    // EI-6076: the wake-GATE control pair coord:glance recommends to the queen
    // audience. Without them seeded, the Queen could detect "wake mode is manual"
    // via glance but had no callable tool to self-recover (ToolSearch reloads never
    // surfaced coord:wake-mode), forcing a human blocker.
    'mcp__papercusp__coord_wake-mode',
    'mcp__papercusp__coord_wake-queue',
  ]) {
    assert.ok(allowed.includes(required), `${required} must remain available to the Queen`);
  }
  // EI-6076 regression: every wake-control tool coord:glance's tips recommend to
  // the QUEEN audience must be in her seeded kit, or the tip points at a tool she
  // cannot invoke on the small-surface queen session.
  for (const wakeCtl of ['coord:wake-mode', 'coord:wake-queue']) {
    assert.ok(
      QUEEN_MCP_TOOL_NAMES.includes(wakeCtl),
      `queen kit must seed ${wakeCtl} — coord:glance recommends it to the queen audience (EI-6076)`,
    );
  }
});

test('fleetAllowedToolsForRole — cup uses a compact worker MCP subset, not the server wildcard', () => {
  const allowed = fleetAllowedToolsForRole('cup');
  assert.deepEqual(allowed, [...BEE_ALLOWED_TOOLS]);
  assert.ok(!allowed.includes('mcp__papercusp'), 'cup must not load the full MCP schema wildcard');
  for (const required of [
    'mcp__papercusp__work_items_claim',
    'mcp__papercusp__work_items_set_state',
    'mcp__papercusp__work_items_comment',
    'mcp__papercusp__locks_acquire_granular',
    'mcp__papercusp__locks_release_granular',
    'mcp__papercusp__dev_service_health',
    'mcp__papercusp__db_next_migration',
    'Read',
    'Edit',
    'Write',
    'Bash',
  ]) {
    assert.ok(allowed.includes(required), `${required} must remain available to bees`);
  }
  assert.ok(BEE_MCP_TOOL_NAMES.includes('work_items:set_state'), 'bee MCP listing hint must use colon-form names');
  assert.ok(!BEE_MCP_TOOL_NAMES.includes('cup:spawn'), 'bee must not receive placement-only fleet spawn tools');
});

test('invokeMcpToolNamesForRole — pipeline worker uses the bounded bee kit', () => {
  assert.equal(invokeMcpToolNamesForRole('worker'), BEE_MCP_TOOL_NAMES);
  assert.equal(invokeMcpToolNamesForRole('cup'), BEE_MCP_TOOL_NAMES);
  assert.equal(invokeMcpToolNamesForRole('mug'), QUEEN_MCP_TOOL_NAMES);
  assert.equal(invokeMcpToolNamesForRole('kettle'), OVERWATCH_MCP_TOOL_NAMES);
  assert.equal(invokeMcpToolNamesForRole('validator'), null);
});

test('OVERWATCH_MCP_TOOL_NAMES — scoped read-heavy supervisor kit (autonomous-loop-full-flow-reliability: unscoped null → "Prompt is too long")', () => {
  // The overwatch launch MUST be scoped: an unscoped (null) mcpToolNames loaded the full
  // tool catalog (~141k tokens) onto its sonnet ~200k window, so the agent died
  // "Prompt is too long" on EVERY fire and never emitted a real 14-criterion scorecard.
  // Its three write verbs + its own wake must be present…
  for (const w of ['coord:send', 'coord:escalate', 'improvements:capture', 'kettle:declare-wake']) {
    assert.ok(OVERWATCH_MCP_TOOL_NAMES.includes(w), `overwatch must hold its write/wake verb ${w}`);
  }
  // …and the retired work-item mail verb must NOT reappear (retire-work-item-mail-surface-2026-07-26 P-006).
  assert.ok(!OVERWATCH_MCP_TOOL_NAMES.includes('messages:send'), 'overwatch must not hold the retired messages:send verb');
  // …and the scorecard/health reads it judges on.
  for (const r of ['scorecards:list', 'rubrics:get', 'pot:status', 'fleet:assignments', 'improvements:digest']) {
    assert.ok(OVERWATCH_MCP_TOOL_NAMES.includes(r), `overwatch must hold the health read ${r}`);
  }
  // The D-001 boundary: the overwatch acts on AGENTS, never on WORK placement, and never
  // edits code (its capability envelope denies fs-write/bash).
  for (const forbidden of ['cup:spawn', 'fleet:place_batch', 'work_items:set_priority', 'work_items:co_locate', 'capability:edit', 'capability:bash', 'capability:write']) {
    assert.ok(!OVERWATCH_MCP_TOOL_NAMES.includes(forbidden), `overwatch must NOT receive ${forbidden} (Queen's placement lane / code-edit — envelope denies)`);
  }
  // Colon-form, no dupes, and small enough to stay well under the model window.
  assert.equal(new Set(OVERWATCH_MCP_TOOL_NAMES).size, OVERWATCH_MCP_TOOL_NAMES.length, 'overwatch kit has no duplicates');
  for (const n of OVERWATCH_MCP_TOOL_NAMES) {
    assert.match(n, /^[a-z_]+:[a-z0-9_-]+$/, `${n} must be a colon-form MCP tool name`);
  }
  assert.ok(OVERWATCH_MCP_TOOL_NAMES.length <= 45, 'overwatch kit stays small (well under the full tool surface)');
});

test('CORE_MCP_TOOL_NAMES — universal small-context spine (tool-discovery-for-weak-models WS1)', () => {
  // coord:orient is THE bootstrap entry point — it must be present, and WS1 also
  // backfilled it into the bee/queen allow-lists (it was missing from both before).
  assert.ok(CORE_MCP_TOOL_NAMES.includes('coord:orient'), 'core must include coord:orient');
  assert.ok(BEE_MCP_TOOL_NAMES.includes('coord:orient'), 'bee allow-list must include coord:orient');
  assert.ok(QUEEN_MCP_TOOL_NAMES.includes('coord:orient'), 'queen allow-list must include coord:orient');
  // No duplicates; colon-form names (the MCP listing-hint convention).
  assert.equal(new Set(CORE_MCP_TOOL_NAMES).size, CORE_MCP_TOOL_NAMES.length, 'core has no duplicate tool names');
  for (const n of CORE_MCP_TOOL_NAMES) {
    assert.match(n, /^[a-z_]+:[a-z0-9_-]+$/, `${n} must be a colon-form MCP tool name`);
  }
  // The spine: orient, coordinate, see/claim work, know things, discover the rest.
  // (EI-7797: locks:acquire_granular was DELIBERATELY cut from the core spine in the
  // 2026-07-05 demand-evidence rebalance — the PreToolUse hook auto-locks every
  // Edit/Write now, so the hand-held lock verb is rare + su-tier; see invoke.ts's own
  // comment beside CORE_MCP_TOOL_NAMES. It stays reachable via tools:find/invoke, and
  // still lives in the bee kit — this assertion was never updated for that cut.)
  for (const required of [
    'coord:orient', 'coord:declare-intent', 'coord:inbox', 'plans:get', 'work_items:list', 'work_items:claim',
    'docs:search', 'memory:search', 'fleet:launch-on-plan', 'tools:find',
  ]) {
    assert.ok(CORE_MCP_TOOL_NAMES.includes(required), `${required} belongs in the universal core`);
  }
  assert.ok(!CORE_MCP_TOOL_NAMES.includes('locks:acquire_granular'), 'locks:acquire_granular was deliberately cut from the core spine (2026-07-05 rebalance) — still reachable via tools:find/invoke, and present in the bee kit');
  // EI-18745029375690371: search:fulltext was never in the spine even though docs:search
  // was, despite root CLAUDE.md recommending both for prose recall — a trimmed session
  // could reach docs:search with zero discovery cost but had to pay one for fulltext.
  assert.ok(CORE_MCP_TOOL_NAMES.includes('search:fulltext'), 'search:fulltext belongs in the universal core (EI-18745029375690371 — was seeded asymmetrically vs docs:search)');
  // search:semantic stays DELIBERATELY unseeded: its own tools:invoke fallback-reach
  // demand (7 reaches/7 callers/14d) is ~3x lower than search:fulltext's (22/11) even
  // among agents who already went out of their way to find it, and it is a narrower
  // paraphrase-recall complement, not the default path — reachable via tools:find/invoke.
  assert.ok(!CORE_MCP_TOOL_NAMES.includes('search:semantic'), 'search:semantic is deliberately NOT in the core spine (EI-18745029375690371) — lower demand-evidence than search:fulltext, reachable via tools:find/invoke');
  // Stays small enough to highlight/pre-load directly (vs the full ~551 surface).
  // Raised 25 → 32 (code-run-self-state-adoption-2026-07-03 P-002): +3 batching/reuse
  // (code:run, recipes:search/run) + +4 self-state (facts:assert/list,
  // work_items:checkpoint, loop:checkpoint). Then +1 → the deliberate 32:
  // plans:new (cross-platform-hardening-and-agent-ergonomics-2026-07-05 P-002, owner
  // directive "plans should be one of the core tools in the trimmed list" — an agent
  // must be able to CREATE a plan without a discovery round-trip). Then +1 → 33:
  // work_items:release (EI-8588) is the handoff half of the worker loop; leaving it
  // deferred stranded misclaimed items when ToolSearch missed the flat MCP verb. The
  // guard now pins "no unreviewed creep past the deliberate 35". EI-8597 then added
  // loop:end/status because the already-seeded loop:arm lifecycle needs a directly
  // callable inspect/stop path when native ToolSearch misses those verbs. Then +3 → 38
  // (fleet-member-dx-improvements-2026-07-10 P-008, EI-9012/EI-9034): events:await/
  // emit/catalog — every persona/leader flow says "don't poll, await the key", but the
  // verbs weren't in the spine, so seeded sessions whose client search missed them
  // falsely concluded the capability didn't exist and fell back to blind poll loops.
  // Then +3 → 41 (EI-10946): work_items:comment, work_items:update, and facts:retract —
  // the CORRECTION verbs for the create/mutate verbs already seeded. The spine carried the
  // WRITE but not the UNDO, so an agent whose client-search missed them concluded no such
  // verb existed and built a strictly-worse workaround (abusing checkpoint as an erratum
  // channel; abandoning a stale-fact retract). Invariant now guarded by
  // core-spine-inverses.test.ts (never seed a create and hide its undo). Then +1 → 42:
  // fleet:launch-on-plan moved from the OMP-only duplicate into the shared seed because
  // the required su routing gate is shared by Codex, Claude, and OMP.
  // Then +1 → 43: search:fulltext (EI-18745029375690371) — root CLAUDE.md's tool-routing
  // table has recommended `search:fulltext` for prose recall since before this spine
  // existed, but it was never seeded (only docs:search was), so every trimmed session
  // needed a discovery round trip to reach it. 22 tools:invoke fallback-reaches/11
  // distinct callers in 14d — comparable demand to other additions above.
  // Then +1 with NO cap change → the array reached EXACTLY 43 (psu-seed-prompt-mandate-
  // alignment-2026-08-09 P-006 / D-006): plans:add-decision, 622 tools:invoke fallback-
  // reaches/65 distinct callers in 14d — the highest demand in the whole ledger — and the
  // verb root CLAUDE.md MANDATES for recording a cross-lane ruling, so the one call an
  // agent must make to comply cost a discovery round-trip on every non-Claude client.
  // WHY NO BUMP ACCOMPANIED IT, since every prior addition above raised this number:
  // MEASURED before that change, the array held 42 entries while this running tally had
  // already reached 43 — so a documented slot existed and was simply unoccupied. (The
  // likeliest cause is one of the deliberate CUTS noted below/above — locks:acquire_granular
  // and recipes:run were both removed in the 2026-07-05 rebalance — decrementing the array
  // without decrementing this tally. Stated as the likely cause, not a verified one.)
  // The net effect is that cap and size now AGREE at 43, which is this ratchet's intended
  // invariant. Then +1 → 44: events:cancel is the correction half of the seeded
  // events:await lifecycle (EI-21345492095209440). Then +1 → 45: work_items:claimable
  // (EI-21503656260697108) — the SSOT claim-floors read root CLAUDE.md's storage-policy
  // table mandates, previously reachable ONLY from Claude's seed (P-003); a non-Claude
  // session calling it directly got "Direct wrapper was not exposed in this session"
  // (watchdog-promoted, reproduced:true). Keep this ratchet explicit so
  // another addition cannot hide behind a stale size ceiling. Then +1 → 46:
  // coord:declare-intent — post-bootstrap lane declaration is the required direct
  // Codex wrapper after coord:orient, so every trimmed client can claim its active intent
  // without an extra tools:find/tools:invoke round trip (EI-21575682931056453).
  // Then +1 → 47: coord:dispatch (WI-2142095, coordination-spec-adoption-2026-08-03
  // P-011). This one is unusual in that the seeding IS the experiment: the P-013
  // falsifier retires the verb on a low call rate, and until 2026-09-02 it sat only in
  // QUEEN_MCP_TOOL_NAMES (the retired mug tier), so no live agent could reach it and the
  // rate measured absence rather than demand. Seeding it is what makes that verdict
  // mean anything. Note this slot is EXPLICITLY temporary in a way the others are not:
  // if the 2026-09-16 read returns `retire`, coord:dispatch leaves the spine and this
  // ratchet goes back to 46 — so do not treat 47 as the new floor.
  // Then +1 → 48: mode:set (WI-37550), the last survivor of the P-003 trio and the
  // deliberate wire-byte budget decision that refusal asked for. Re-measured 14d demand
  // 656 tools:invoke fallback-reaches / 443 distinct callers @ 3,028 B = 216.6 reach/KB —
  // the HIGHEST admission-time reach/KB in this whole changelog (cf. plans:add-decision
  // 149.9, work_items:claimable 62.9) — and the su playbook MANDATES the call on every
  // AUTO/DRAIN/IDEATE flip, since a mode honoured from directive text alone is invisible
  // session state a compaction silently drops. Claude already had it via
  // CLAUDE_SEED_EXTRA_TOOL_NAMES, so this is a relocation there (Claude seed byte-identical)
  // and an addition only for OMP/codex. Then +1 → 49: checkpoint:await is the
  // shared release-gate sleep primitive named by checkpoint-run/trace. Dynamic
  // activation cannot guarantee a same-turn Codex wrapper, so it is seeded from
  // launch.
  // Then +1 → 50: events:status (EI-26236732620541471) is the recovery read paired
  // with the seeded events:await/catalog/cancel lifecycle. A trimmed Codex session
  // must be able to inspect its active await and wake-delivery state without a
  // tools:find/tools:invoke detour.
  // ⚠ AND THE FINDING THAT OUTRANKS THE COUNT: measured 2026-09-05 by a real tools/list
  // call, the 47-entry spine was ALREADY 345,140 B (337 KB) and the Claude seed 395,879 B
  // (387 KB) against D-001's 256 KB wire ceiling — 32% and 51% over, crossed silently
  // because this count is the only guard that runs in CI. Since D-001 measured 190,885 B
  // on 2026-08-09 the seed has more than DOUBLED in bytes while this number moved 43->47.
  // Do not read a passing ratchet as a seed within budget: it cannot see bytes, and the
  // bytes live in schemas (coord:send 39,067 B; work_items:complete 35,093;
  // work_items:checkpoint 31,000), not in the length of this list.
  assert.ok(CORE_MCP_TOOL_NAMES.length <= 50, 'core stays small');
  // (EI-7797: recipes:run was ALSO cut from the core spine in the same 2026-07-05
  // rebalance — recipes:search already returns the run pointer, and the run itself
  // routes via tools:invoke. Still present in the bee/queen kits, checked below.)
  for (const required of ['code:run', 'recipes:search', 'facts:assert', 'work_items:checkpoint']) {
    assert.ok(CORE_MCP_TOOL_NAMES.includes(required), `${required} belongs in the universal core (adoption unlock P-002)`);
  }
  assert.ok(!CORE_MCP_TOOL_NAMES.includes('recipes:run'), 'recipes:run was deliberately cut from the core spine (2026-07-05 rebalance) — reachable via tools:invoke, and present in the bee/queen kits');
  // plans:new is the create verb — pinned into the core so an agent never has to hunt for
  // it (cross-platform-hardening-and-agent-ergonomics-2026-07-05 P-002). plans:get/items/
  // set-status were already core; this closes the CREATE gap the Mac-app agent hit.
  assert.ok(CORE_MCP_TOOL_NAMES.includes('plans:new'), 'plans:new belongs in the universal core (agent-ergonomics P-002)');
  assert.ok(CORE_MCP_TOOL_NAMES.includes('work_items:release'), 'work_items:release belongs in the universal core (EI-8588 worker handoffs)');
  assert.ok(CORE_MCP_TOOL_NAMES.includes('loop:status'), 'loop:status belongs in the universal core (EI-8597 loop wind-down)');
  assert.ok(CORE_MCP_TOOL_NAMES.includes('loop:end'), 'loop:end belongs in the universal core (EI-8597 loop wind-down)');
  assert.ok(CORE_MCP_TOOL_NAMES.includes('fleet:launch-on-plan'), 'fleet:launch-on-plan belongs in the universal core (shared su routing-gate execution)');
  // fleet-member-dx P-008 (EI-9012/EI-9034): the bench-wait verbs must be directly
  // reachable — "don't poll, await the key" is a persona mandate, and a seeded session
  // whose client-side search misses a deferred verb concludes it doesn't exist.
  for (const required of ['events:await', 'events:catalog', 'events:cancel', 'events:status']) {
    assert.ok(CORE_MCP_TOOL_NAMES.includes(required), `${required} belongs in the universal core (fleet-member-dx P-008 bench-wait)`);
  }
  assert.ok(CORE_MCP_TOOL_NAMES.includes('checkpoint:await'), 'checkpoint:await belongs in the universal core so trimmed Codex sessions have a direct wait wrapper from launch');
  // events:emit was deliberately cut from the spine (2026-07-19 rebalance): 29 calls/14d
  // while SEEDED = true rarity, not a discoverability artifact — members await, leaders/peers
  // emit, and the system fires most emits from lifecycle events. Reachable via tools:find/invoke.
  assert.ok(!CORE_MCP_TOOL_NAMES.includes('events:emit'), 'events:emit was deliberately cut from the core spine (2026-07-19 rebalance) — reachable via tools:invoke, not the seeded hot path');
  // The fleet kits carry the batching surface too (P-001) — the 2026-07-03 audit's root
  // finding was code:run absent from the BEE/QUEEN kits while the inline nudge advised it.
  for (const kit of [BEE_MCP_TOOL_NAMES, QUEEN_MCP_TOOL_NAMES]) {
    for (const t of ['code:run', 'code:tools', 'recipes:search', 'recipes:run', 'tools:find', 'tools:invoke']) {
      assert.ok(kit.includes(t), `${t} belongs in the bee+queen kits (adoption unlock P-001)`);
    }
  }
  assert.ok(QUEEN_MCP_TOOL_NAMES.includes('recipes:candidates'), 'queen kit carries her recipe-graduation read');
  assert.ok(BEE_MCP_TOOL_NAMES.includes('work_items:checkpoint'), 'bee kit carries the carry-note checkpoint');
  // Allow-list maps colon→underscore like the other roles.
  assert.deepEqual(CORE_ALLOWED_TOOLS, [
    ...CORE_MCP_TOOL_NAMES.map((n) => `mcp__papercusp__${n.replace(':', '_')}`),
    'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep',
  ]);
});

test('fleetAllowedToolsForRole — the dedicated acceptance judge cannot edit; normal roles keep the full kit', () => {
  assert.deepEqual([...FLEET_NO_WRITE_ROLES], ['judge']);
  for (const role of ['worker', 'documenter', 'reviewer', 'totally-unknown-role', '']) {
    assert.deepEqual(fleetAllowedToolsForRole(role), [...FLEET_ALLOWED_TOOLS]);
  }
  const judge = fleetAllowedToolsForRole('judge');
  assert.ok(!judge.includes('Edit') && !judge.includes('Write'));
  assert.ok(judge.includes('Read') && judge.includes('Glob') && judge.includes('Grep'));
});

test('P-005 — RoleToolScope narrows a role kit (allow replaces base, deny adds, composes w/ cutover)', () => {
  // No scope → full default kit (behavior unchanged).
  assert.deepEqual(fleetAllowedToolsForRole('business', false, undefined), [...FLEET_ALLOWED_TOOLS]);

  // scope.allow REPLACES the base kit — a non-coding role drops Edit/Write/Bash.
  const biz = { allow: ['mcp__papercusp', 'Read', 'Glob', 'Grep', 'WebSearch'] };
  assert.deepEqual(fleetAllowedToolsForRole('business', false, biz), [...biz.allow]);
  for (const dropped of ['Edit', 'Write', 'Bash']) {
    assert.ok(!fleetAllowedToolsForRole('business', false, biz).includes(dropped), `${dropped} dropped by scope.allow`);
  }

  // scope.deny adds to the standing hard-deny list.
  const denied = fleetDisallowedToolsForRole('business', false, { deny: ['WebFetch', 'Bash(curl:*)'] });
  assert.ok(denied.includes('WebFetch') && denied.includes('Bash(curl:*)'));
  for (const std of FLEET_DISALLOWED_TOOLS) assert.ok(denied.includes(std), `keeps standard deny ${std}`);

  // Composes with the B-18 cutover: the cutover strip still applies on top of scope.allow.
  const underCutover = fleetAllowedToolsForRole('worker', true, { allow: ['mcp__papercusp', 'Read', 'Bash', 'Edit'] });
  for (const stripped of ['Bash', 'Edit']) {
    assert.ok(!underCutover.includes(stripped), `cutover strips ${stripped} even from scope.allow`);
  }
  assert.ok(underCutover.includes('Read'), 'read-only native survives');

  // resolveRoleToolScope reads toolScope.<role>.{allow,deny} from the effective config.
  const cfg = { toolScope: { business: { allow: ['Read', 'Glob'], deny: ['Bash(rm:*)'] } } } as unknown as Parameters<typeof resolveRoleToolScope>[0];
  assert.deepEqual(resolveRoleToolScope(cfg, 'business'), { allow: ['Read', 'Glob'], deny: ['Bash(rm:*)'] });
  assert.equal(resolveRoleToolScope(cfg, 'worker'), undefined); // no toolScope.worker → undefined
  assert.equal(resolveRoleToolScope(cfg, undefined), undefined);
});

test('claudeMcpArgs — deny-list hard-removes the dangerous EXEMPT tools (dontAsk gating is non-uniform) + dangerous Bash', () => {
  // These bypass the allow-list under dontAsk (verified: CronCreate/EnterWorktree
  // run despite omission), so they must be explicitly denied to be closed.
  for (const exempt of [
    'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup',
    'EnterWorktree', 'ExitWorktree', 'Workflow', 'Task', 'Agent',
    'RemoteTrigger', 'PushNotification', 'Monitor',
  ]) {
    assert.ok(FLEET_DISALLOWED_TOOLS.includes(exempt), `${exempt} must be deny-listed`);
  }
  // git push is denied (backstop to the pre-push hook); sudo is denied.
  assert.ok(FLEET_DISALLOWED_TOOLS.includes('Bash(git push:*)'));
  assert.ok(FLEET_DISALLOWED_TOOLS.includes('Bash(sudo:*)'));
  // WI-3159: deny patterns match the POST-hook updatedInput, so the rtk
  // token-filter rewrite (`git push` → `rtk git push`) evades the bare
  // `Bash(git push:*)` prefix (e2e-proven 2026-07-06 — the control command
  // was denied, the rewritten push executed). The rtk-prefixed variant must
  // stay deny-listed alongside the bare one.
  assert.ok(FLEET_DISALLOWED_TOOLS.includes('Bash(rtk git push:*)'));
});

test('claudeMcpArgs — subagent-fanout deny carries BOTH tool names (Task pre-rename, Agent current — 2026-07-01)', () => {
  // Re-verified live against claude 2.1.198: `--disallowedTools Task` alone no longer
  // blocks the subagent tool (a spawned Agent-tool subagent still ran and wrote its
  // marker file) — `Agent` is the name that actually blocks it today. Both stay listed
  // so the deny survives either CLI generation; see no-subagent-deny.ts.
  assert.ok(FLEET_DISALLOWED_TOOLS.includes('Task'));
  assert.ok(FLEET_DISALLOWED_TOOLS.includes('Agent'));
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

// --- B-18 fleet cutover (agent-capability-confinement P-020/P-021) ---------
// Under papercusp-fleet-capability-only (surfaced as PAPERCUSP_FLEET_CAPABILITY_ONLY),
// a confined role drops the native write/exec/fetch tools (routed to the gated
// capability:* tools) from --allowed-tools AND hard-denies them. DEFAULT-OFF.

/** Run `fn` with PAPERCUSP_FLEET_CAPABILITY_ONLY=`val` (or unset when null), restoring after. */
function withCutoverEnv<T>(val: string | null, fn: () => T): T {
  const prev = process.env.PAPERCUSP_FLEET_CAPABILITY_ONLY;
  if (val === null) delete process.env.PAPERCUSP_FLEET_CAPABILITY_ONLY;
  else process.env.PAPERCUSP_FLEET_CAPABILITY_ONLY = val;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PAPERCUSP_FLEET_CAPABILITY_ONLY;
    else process.env.PAPERCUSP_FLEET_CAPABILITY_ONLY = prev;
  }
}

test('fleetCapabilityOnlyEnabled — DEFAULT-OFF: only 1/true/on enable it', () => {
  for (const off of [null, '', '0', 'false', 'off', 'no']) {
    assert.equal(withCutoverEnv(off, fleetCapabilityOnlyEnabled), false, `${off} → off`);
  }
  for (const on of ['1', 'true', 'on', 'TRUE', 'On']) {
    assert.equal(withCutoverEnv(on, fleetCapabilityOnlyEnabled), true, `${on} → on`);
  }
});

test('FLEET_CAPABILITY_REPLACED_TOOLS — exactly the native write/exec/fetch tools that have a capability:* replacement', () => {
  assert.deepEqual([...FLEET_CAPABILITY_REPLACED_TOOLS].sort(), ['Bash', 'Edit', 'WebFetch', 'Write']);
  // The read-only natives + WebSearch (no capability replacement) are NOT replaced.
  for (const kept of ['Read', 'Glob', 'Grep', 'WebSearch', 'mcp__papercusp']) {
    assert.ok(!FLEET_CAPABILITY_REPLACED_TOOLS.includes(kept), `${kept} must be kept`);
  }
});

test('fleetAllowedToolsForRole — cutover OFF (default) leaves the full kit for a capability role', () => {
  assert.deepEqual(fleetAllowedToolsForRole('worker', false), [...FLEET_ALLOWED_TOOLS]);
  assert.deepEqual(fleetAllowedToolsForRole('worker'), [...FLEET_ALLOWED_TOOLS]);
});

test('fleetAllowedToolsForRole — cutover ON drops native write/exec/fetch for a capability role, keeps reads + wildcard', () => {
  const allowed = fleetAllowedToolsForRole('worker', true);
  for (const dropped of FLEET_CAPABILITY_REPLACED_TOOLS) {
    assert.ok(!allowed.includes(dropped), `${dropped} must be dropped under the cutover`);
  }
  for (const kept of ['mcp__papercusp', 'Read', 'Glob', 'Grep', 'WebSearch']) {
    assert.ok(allowed.includes(kept), `${kept} must remain under the cutover`);
  }
});

test('fleetAllowedToolsForRole — cutover ON does NOT strand a role without capability:* (keeps native tools)', () => {
  // An auxiliary role outside FLEET_CAPABILITY_ROLES has no capability replacement,
  // so the cutover must NOT remove its native tools (else it loses shell entirely).
  const aux = 'papercup';
  assert.ok(!FLEET_CAPABILITY_ROLES.has(aux));
  assert.deepEqual(fleetAllowedToolsForRole(aux, true), [...FLEET_ALLOWED_TOOLS]);
});

test('fleetDisallowedToolsForRole — cutover ON hard-denies the native write/exec/fetch tools (airtight, beyond the allow-list omission)', () => {
  const denied = fleetDisallowedToolsForRole('worker', true);
  for (const base of FLEET_DISALLOWED_TOOLS) assert.ok(denied.includes(base), `${base} still denied`);
  for (const native of FLEET_CAPABILITY_REPLACED_TOOLS) {
    assert.ok(denied.includes(native), `${native} must be hard-denied under the cutover`);
  }
  // OFF (default) → unchanged.
  assert.deepEqual(fleetDisallowedToolsForRole('worker', false), [...FLEET_DISALLOWED_TOOLS]);
  // Aux role under cutover → unchanged (not stranded, not hard-denied).
  assert.deepEqual(fleetDisallowedToolsForRole('papercup', true), [...FLEET_DISALLOWED_TOOLS]);
});

test('fleetDisallowedToolsForRole — acceptance judge always hard-denies Bash', () => {
  const denied = fleetDisallowedToolsForRole('judge', false);
  assert.ok(denied.includes('Bash'));
  for (const base of FLEET_DISALLOWED_TOOLS) assert.ok(denied.includes(base));
});

test('claudeMcpArgs — under the cutover env, a confined role gets dontAsk + no native write/exec in allow-list + hard-deny (P-021 binding proof)', () => {
  const args = withCutoverEnv('1', () =>
    claudeMcpArgs('claude-code', 'claude-stream-json', 'claude -p', MCP_PATH, true, 'worker'),
  );
  // dontAsk is the binding mode (allow-list restricts the surface under dontAsk,
  // NOT under bypassPermissions — that's the whole point of the cutover, P-021).
  assert.ok(args.includes('--permission-mode'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  // The allow-list value (one space-joined arg after --allowed-tools) excludes natives.
  const allowVal = args[args.indexOf('--allowed-tools') + 1] as string;
  const allowSet = new Set(allowVal.split(' '));
  for (const native of FLEET_CAPABILITY_REPLACED_TOOLS) {
    assert.ok(!allowSet.has(native), `${native} must NOT be allow-listed under the cutover`);
  }
  assert.ok(allowSet.has('mcp__papercusp') && allowSet.has('Read'));
  // The deny-list (separate argv after --disallowed-tools) hard-removes the natives.
  const deny = args.slice(args.indexOf('--disallowed-tools') + 1);
  for (const native of FLEET_CAPABILITY_REPLACED_TOOLS) {
    assert.ok(deny.includes(native), `${native} must be hard-denied under the cutover`);
  }
});

test('claudeMcpArgs — cutover OFF (env unset) is byte-identical to today (no native tool removed)', () => {
  const args = withCutoverEnv(null, () =>
    claudeMcpArgs('claude-code', 'claude-stream-json', 'claude -p', MCP_PATH, true, 'worker'),
  );
  assert.deepEqual(args, [
    '--mcp-config', MCP_PATH, '--strict-mcp-config',
    '--permission-mode', 'dontAsk',
    '--allowed-tools', [...FLEET_ALLOWED_TOOLS].join(' '),
    '--disallowed-tools', ...FLEET_DISALLOWED_TOOLS,
  ]);
});

test('claudeMcpArgs — cutover is CLAUDE-ONLY (P-032): omp/codex backends ignore it (their confinement is the server-side gate + their own sandbox)', () => {
  withCutoverEnv('1', () => {
    // The --allowed-tools mechanism is a claude-CLI flag; the cutover never leaks
    // to other backends. (The capability:* tools + the dispatch envelope DO gate
    // every backend uniformly — that's MCP-layer, client-agnostic.)
    assert.deepEqual(claudeMcpArgs('omp', 'omp-json', 'omp -p', MCP_PATH, true, 'worker'), []);
    assert.deepEqual(claudeMcpArgs('codex', 'none', 'codex exec', MCP_PATH, true, 'worker'), []);
  });
});

test('claudeMcpArgs — cutover hard-deny is a SECURITY INVARIANT: applied even when AGENT_CMD already manages the permission posture (review fix)', () => {
  // A hardened deployment can set --permission-mode in AGENT_CMD; that makes us
  // defer the mode + allow-list to them — but a CONFINED fleet spawn (env armed,
  // role has capability:*) must STILL lose native Bash/Edit/Write/WebFetch, or the
  // cutover silently no-ops. The cutover env is set only by spawnInvokeOnce, so
  // this can never fire for an SU session.
  const args = withCutoverEnv('1', () =>
    claudeMcpArgs('claude-code', 'claude-stream-json', 'claude -p --permission-mode dontAsk', MCP_PATH, true, 'worker'),
  );
  // mode + allow-list deferred to the user…
  assert.ok(!args.includes('--permission-mode'));
  assert.ok(!args.includes('--allowed-tools'));
  // …but the native write/exec/fetch tools are hard-denied regardless.
  assert.ok(args.includes('--disallowed-tools'));
  const deny = args.slice(args.indexOf('--disallowed-tools') + 1);
  for (const native of FLEET_CAPABILITY_REPLACED_TOOLS) {
    assert.ok(deny.includes(native), `${native} must be hard-denied even when AGENT_CMD manages perms`);
  }
});

test('claudeMcpArgs — AGENT_CMD manages perms + cutover OFF → we add nothing (no spurious deny)', () => {
  const args = withCutoverEnv(null, () =>
    claudeMcpArgs('claude-code', 'claude-stream-json', 'claude -p --permission-mode dontAsk', MCP_PATH, true, 'worker'),
  );
  assert.deepEqual(args, ['--mcp-config', MCP_PATH, '--strict-mcp-config']);
});

test('claudeMcpArgs — AGENT_CMD manages perms + cutover ON but NON-capability role → no deny (not stranded, not confined)', () => {
  const args = withCutoverEnv('1', () =>
    claudeMcpArgs('claude-code', 'claude-stream-json', 'claude -p --permission-mode dontAsk', MCP_PATH, true, 'papercup'),
  );
  assert.deepEqual(args, ['--mcp-config', MCP_PATH, '--strict-mcp-config']);
});

test('claudeMcpArgs — SU carve-out (P-023/D-002): the cutover env is the gate, and ONLY spawnInvokeOnce (the fleet chokepoint) sets it — an SU session (no env) keeps native tools', () => {
  // SU/human sessions launch via psu, NOT spawnInvokeOnce, so they never carry
  // PAPERCUSP_FLEET_CAPABILITY_ONLY → fleetCapabilityOnlyEnabled() is false → the
  // cutover never strips their native tools, even for a capability role running with
  // bypassPermissions. (If the env WERE set, the spawn is by definition a confined
  // fleet spawn — not an SU session — and the hard-deny SHOULD apply, per the
  // security-invariant test above.)
  const args = withCutoverEnv(null, () =>
    claudeMcpArgs('claude-code', 'claude-stream-json', 'claude -p --dangerously-skip-permissions', MCP_PATH, true, 'worker'),
  );
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
  // EI-13191: github.com/<org>/<repo>/releases/download/... 302-redirects to this
  // host — a plain `curl -L` of a GitHub release asset 403'd without it, even
  // though github.com/api.github.com/objects.githubusercontent.com all worked.
  assert.ok(d.includes('release-assets.githubusercontent.com'), 'GitHub release-asset CDN redirect target in base');
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

test('selectStreamFormat — codex with bare `exec` subcommand remains managed', () => {
  assert.equal(selectStreamFormat('codex', 'codex exec'), 'codex-json');
});

test('selectStreamFormat — codex with explicit `exec --json` subcommand → none (user-driven stream)', () => {
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
  assert.deepEqual(codexSandboxArgs('codex', 'none', 'codex exec --json', false), bypass);
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

// ── omp leg of the B-18 cutover (P-034) — the omp analog of claudeMcpArgs' native-tool cut ──
test('fleetOmpToolsArgs — cutover ON for a capability role → --tools restricts omp to read-only natives', () => {
  const out = fleetOmpToolsArgs('omp', 'omp -p', 'worker', true);
  assert.deepEqual(out, ['--tools', FLEET_OMP_CAPABILITY_ALLOWED_TOOLS.join(',')]);
  // The dangerous natives are GONE from the allowlist; the gated capability:* MCP tools replace them.
  for (const dropped of ['bash', 'python', 'ssh', 'edit', 'write', 'ast_edit', 'fetch', 'browser', 'task', 'ask', 'lsp']) {
    assert.ok(!FLEET_OMP_CAPABILITY_ALLOWED_TOOLS.includes(dropped), `${dropped} must be dropped under the cutover`);
  }
  // Read-only natives are kept (the omp analog of claude's kept Read/Glob/Grep/WebSearch).
  for (const kept of ['read', 'grep', 'find', 'web_search']) {
    assert.ok(FLEET_OMP_CAPABILITY_ALLOWED_TOOLS.includes(kept), `${kept} must be kept`);
  }
  // Live OMP 0.0.0-20260821 rejects the entire invocation when any of these
  // retired names appears in --tools (the parity canary caught the boot abort).
  for (const unsupported of ['ast_grep', 'calc', 'todo_write', 'poll']) {
    assert.ok(!FLEET_OMP_CAPABILITY_ALLOWED_TOOLS.includes(unsupported), `${unsupported} is not a current OMP built-in`);
  }
});

test('fleetOmpToolsArgs — cutover OFF (default) → [] (omp keeps all native tools)', () => {
  assert.deepEqual(fleetOmpToolsArgs('omp', 'omp -p', 'worker', false), []);
});

test('fleetOmpToolsArgs — non-omp backend → [] (claude/codex unaffected)', () => {
  assert.deepEqual(fleetOmpToolsArgs('claude-code', 'claude -p', 'worker', true), []);
  assert.deepEqual(fleetOmpToolsArgs('codex', 'codex', 'worker', true), []);
});

test('fleetOmpToolsArgs — cutover ON but role has no capability:* → [] (never strand an auxiliary role)', () => {
  const aux = 'merge-resolver'; // a role NOT in FLEET_CAPABILITY_ROLES
  assert.ok(!FLEET_CAPABILITY_ROLES.has(aux));
  assert.deepEqual(fleetOmpToolsArgs('omp', 'omp -p', aux, true), []);
  assert.deepEqual(fleetOmpToolsArgs('omp', 'omp -p', undefined, true), []);
});

test('fleetOmpToolsArgs — user set --tools / --no-tools in AGENT_CMD → defer to them', () => {
  assert.deepEqual(fleetOmpToolsArgs('omp', 'omp -p --tools read,grep', 'worker', true), []);
  assert.deepEqual(fleetOmpToolsArgs('omp', 'omp -p --tools=read,grep', 'worker', true), []);
  assert.deepEqual(fleetOmpToolsArgs('omp', 'omp -p --no-tools', 'worker', true), []);
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

test('scopeSpawnEnvForRole — carries the signed detector identity to child hooks', () => {
  const input: NodeJS.ProcessEnv = {
    PAPERCUSP_SID: 'private-detector-session',
    [FAILURE_LOOP_SESSION_KEY_ENV]: 'stale-inherited-detector',
    PATH: '/usr/bin',
  };
  const out = scopeSpawnEnvForRole(input, 'auditor');
  assert.equal(out[FAILURE_LOOP_SESSION_KEY_ENV], 'private-detector-session');
  assert.equal(input[FAILURE_LOOP_SESSION_KEY_ENV], 'stale-inherited-detector');
});

test('scopeSpawnEnvForRole — clears an inherited detector identity when the producer has no SID', () => {
  const out = scopeSpawnEnvForRole({ [FAILURE_LOOP_SESSION_KEY_ENV]: 'stale-detector' }, 'worker');
  assert.equal(out[FAILURE_LOOP_SESSION_KEY_ENV], undefined);
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
