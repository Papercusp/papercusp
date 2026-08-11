/**
 * Tests for per-spawn `.mcp.json` writing.
 * Run with: npx vitest run libs/papercusp/packages/orchestrator/src/spawn-mcp.test.ts
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSpawnCodexConfigToml,
  buildSpawnMcpConfig,
  resolveSpawnOperatorBase,
  writeSpawnMcp,
  writeSignedSpawnMcp,
  restoreSpawnMcp,
  extractChunkId,
  writeSpawnOmpHome,
  OMP_SEEDED_AGENT_ESSENTIALS,
  isLocalOmpModel,
  writeOmpCompactionOverlay,
  ompRemoteCompactionEndpoint,
  OMP_MAINTENANCE_SUMMARIZE_PATH,
} from './spawn-mcp';

const ROOT = join(tmpdir(), `papercusp-spawn-mcp-test-${process.pid}`);

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});
afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('buildSpawnMcpConfig', () => {
  // The default/env-override host assertions below must be deterministic
  // regardless of the dev box's exported env: PAPERCUSP_HONO_PORT now feeds
  // resolveSpawnOperatorBase (EI-51), so a host with it exported would
  // otherwise change the resolved base out from under these cases.
  const savedHost = {
    port: process.env.PAPERCUSP_HONO_PORT,
    url: process.env.PAPERCUSP_OPERATOR_URL,
    proxy: process.env.PAPERCUSP_MCP_PROXY_BASE,
  };
  beforeEach(() => {
    delete process.env.PAPERCUSP_HONO_PORT;
    delete process.env.PAPERCUSP_OPERATOR_URL;
    // resolveSpawnOperatorBase now also honors PAPERCUSP_MCP_PROXY_BASE — clear it so a dev box
    // that exports the proxy base can't redirect these host-port assertions out from under them.
    delete process.env.PAPERCUSP_MCP_PROXY_BASE;
  });
  afterEach(() => {
    if (savedHost.proxy === undefined) delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    else process.env.PAPERCUSP_MCP_PROXY_BASE = savedHost.proxy;
    if (savedHost.port === undefined) delete process.env.PAPERCUSP_HONO_PORT;
    else process.env.PAPERCUSP_HONO_PORT = savedHost.port;
    if (savedHost.url === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = savedHost.url;
  });

  it('produces a single mcpServers.papercusp entry with the seven URL params', () => {
    const cfg = buildSpawnMcpConfig({
      harnessSlug: 'sheets',
      workspaceId: 'default',
      role: 'worker',
      runId: 'run_01HXVA0',
      spawnId: 'spw_01HXVA1',
      featureId: 'F-AUTH-003',
      chunkId: 'ck_01HXV9Z',
    });
    expect(Object.keys(cfg.mcpServers)).toEqual(['papercusp']);
    // `type: 'http'` is required by claude-code's --mcp-config schema (omp
    // accepts it too). Regression guard for the claude-code backend restore.
    expect(cfg.mcpServers.papercusp!.type).toBe('http');
    const url = new URL(cfg.mcpServers.papercusp!.url);
    expect(url.searchParams.get('harness')).toBe('sheets');
    expect(url.searchParams.get('workspace')).toBe('default');
    expect(url.searchParams.get('role')).toBe('worker');
    expect(url.searchParams.get('run')).toBe('run_01HXVA0');
    expect(url.searchParams.get('spawn')).toBe('spw_01HXVA1');
    expect(url.searchParams.get('feature')).toBe('F-AUTH-003');
    expect(url.searchParams.get('chunk')).toBe('ck_01HXV9Z');
  });

  it('omits feature/chunk/parent_spawn when not provided', () => {
    const cfg = buildSpawnMcpConfig({
      harnessSlug: 'sheets',
      workspaceId: 'default',
      role: 'architect',
      runId: 'run_X',
      spawnId: 'spw_X',
    });
    const url = new URL(cfg.mcpServers.papercusp!.url);
    expect(url.searchParams.has('feature')).toBe(false);
    expect(url.searchParams.has('chunk')).toBe(false);
    expect(url.searchParams.has('parent_spawn')).toBe(false);
  });

  it('includes parent_spawn when set (Phase 9 spawn-of-spawn)', () => {
    const cfg = buildSpawnMcpConfig({
      harnessSlug: 'sheets',
      workspaceId: 'default',
      role: 'worker',
      runId: 'run_X',
      spawnId: 'spw_2',
      parentSpawnId: 'spw_1',
    });
    const url = new URL(cfg.mcpServers.papercusp!.url);
    expect(url.searchParams.get('parent_spawn')).toBe('spw_1');
  });

  it('bakes the stable coord owner as `client=` when clientId is set (THE UMBILICAL)', () => {
    // The voice-gap fix: the operator's durable `s-…` spawnId rides as the signed
    // URL's `client=` param so resolveAgentIdentity can attribute the bee's coord
    // writes to it. `client` is in the signed-param allowlist, so it's part of the HMAC.
    const cfg = buildSpawnMcpConfig({
      harnessSlug: 'demo', workspaceId: 'ws-1', role: 'cup',
      runId: 'opspawn-1780', spawnId: 's-1780-deadbeef',
      clientId: 's-1780-deadbeef',
    });
    const url = new URL(cfg.mcpServers.papercusp!.url);
    expect(url.searchParams.get('client')).toBe('s-1780-deadbeef');
    expect(url.searchParams.get('role')).toBe('cup');
  });

  it('carries a per-spawn MCP tools listing hint when provided', () => {
    const cfg = buildSpawnMcpConfig({
      harnessSlug: 'papercusp',
      workspaceId: 'default',
      role: 'mug',
      runId: 'run_Q',
      spawnId: 'spw_Q',
      mcpToolNames: ['pot:survey', 'cup:spawn', 'work_items:create'],
    });
    const url = new URL(cfg.mcpServers.papercusp!.url);
    expect(url.searchParams.get('tools')).toBe('pot:survey,cup:spawn,work_items:create');
  });

  it('omits `client=` when clientId is not set (legacy pipeline-role path unchanged)', () => {
    const cfg = buildSpawnMcpConfig({
      harnessSlug: 'sheets', workspaceId: 'default', role: 'worker',
      runId: 'r', spawnId: 's',
    });
    const url = new URL(cfg.mcpServers.papercusp!.url);
    expect(url.searchParams.has('client')).toBe(false);
    expect(url.searchParams.has('tools')).toBe(false);
  });

  it('honors operatorUrl override', () => {
    const cfg = buildSpawnMcpConfig({
      operatorUrl: 'http://op.example:9999/sse',
      harnessSlug: 'sheets',
      workspaceId: 'default',
      role: 'worker',
      runId: 'r',
      spawnId: 's',
    });
    expect(cfg.mcpServers.papercusp!.url.startsWith('http://op.example:9999/sse?')).toBe(true);
  });

  it('honors PAPERCUSP_OPERATOR_URL env var when no explicit override', () => {
    const prev = process.env.PAPERCUSP_OPERATOR_URL;
    process.env.PAPERCUSP_OPERATOR_URL = 'http://env.example/api/sse';
    try {
      const cfg = buildSpawnMcpConfig({
        harnessSlug: 'x', workspaceId: 'y', role: 'z', runId: 'r', spawnId: 's',
      });
      expect(cfg.mcpServers.papercusp!.url.startsWith('http://env.example/api/sse?')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
      else process.env.PAPERCUSP_OPERATOR_URL = prev;
    }
  });

  it('treats null featureId/chunkId/parentSpawnId same as undefined', () => {
    const cfg = buildSpawnMcpConfig({
      harnessSlug: 'sheets', workspaceId: 'default', role: 'architect',
      runId: 'r', spawnId: 's', featureId: null, chunkId: null, parentSpawnId: null,
    });
    const url = new URL(cfg.mcpServers.papercusp!.url);
    expect(url.searchParams.has('feature')).toBe(false);
    expect(url.searchParams.has('chunk')).toBe(false);
  });

  it('targets the spawning host via PAPERCUSP_HONO_PORT, overriding an inherited PAPERCUSP_OPERATOR_URL (EI-51)', () => {
    // The bug: .env.local pins PAPERCUSP_OPERATOR_URL=green :3070, so a non-green
    // host (staging :3170) spawned agents that handshook green's MCP. The host's
    // own serving port must win so a child talks to its spawner.
    process.env.PAPERCUSP_OPERATOR_URL = 'http://localhost:3070/api/mcp';
    process.env.PAPERCUSP_HONO_PORT = '3170';
    const cfg = buildSpawnMcpConfig({
      harnessSlug: 'x', workspaceId: 'y', role: 'z', runId: 'r', spawnId: 's',
    });
    expect(cfg.mcpServers.papercusp!.url.startsWith('http://127.0.0.1:3170/api/mcp?')).toBe(true);
  });
});

describe('resolveSpawnOperatorBase', () => {
  const saved = {
    port: process.env.PAPERCUSP_HONO_PORT,
    url: process.env.PAPERCUSP_OPERATOR_URL,
    proxy: process.env.PAPERCUSP_MCP_PROXY_BASE,
  };
  beforeEach(() => {
    delete process.env.PAPERCUSP_HONO_PORT;
    delete process.env.PAPERCUSP_OPERATOR_URL;
    delete process.env.PAPERCUSP_MCP_PROXY_BASE;
  });
  afterEach(() => {
    if (saved.port === undefined) delete process.env.PAPERCUSP_HONO_PORT;
    else process.env.PAPERCUSP_HONO_PORT = saved.port;
    if (saved.url === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = saved.url;
    if (saved.proxy === undefined) delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    else process.env.PAPERCUSP_MCP_PROXY_BASE = saved.proxy;
  });

  it('an explicit per-spawn operatorUrl wins over every env source (incl. the proxy base)', () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    process.env.PAPERCUSP_OPERATOR_URL = 'http://env.example/api/mcp';
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    expect(resolveSpawnOperatorBase('http://pin.example:9/sse')).toBe('http://pin.example:9/sse');
  });

  // mcp-host-availability-resilience P-005: with the always-up proxy configured, a spawn's
  // .mcp.json points at the proxy (:9071) — NOT directly at :3070 — so a deploy that restarts
  // :3070 is invisible to the bee's MCP client. The proxy base wins over the env-derived host
  // defaults (HONO_PORT / OPERATOR_URL) but not over an explicit operatorUrl (asserted above).
  it('routes through PAPERCUSP_MCP_PROXY_BASE (appends /api/mcp), winning over HONO_PORT + OPERATOR_URL', () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    process.env.PAPERCUSP_OPERATOR_URL = 'http://env.example/api/mcp';
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    expect(resolveSpawnOperatorBase()).toBe('http://127.0.0.1:9071/api/mcp');
  });

  it('normalizes trailing slashes on the proxy base before appending /api/mcp', () => {
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071///';
    expect(resolveSpawnOperatorBase()).toBe('http://127.0.0.1:9071/api/mcp');
  });

  it('an empty/whitespace PAPERCUSP_MCP_PROXY_BASE is treated as unset (direct host base)', () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    process.env.PAPERCUSP_MCP_PROXY_BASE = '   ';
    expect(resolveSpawnOperatorBase()).toBe('http://127.0.0.1:3170/api/mcp');
  });

  it('derives the spawning host base from PAPERCUSP_HONO_PORT (EI-51 core fix)', () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    expect(resolveSpawnOperatorBase()).toBe('http://127.0.0.1:3170/api/mcp');
  });

  it('PAPERCUSP_HONO_PORT wins over an inherited PAPERCUSP_OPERATOR_URL', () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    process.env.PAPERCUSP_OPERATOR_URL = 'http://localhost:3070/api/mcp';
    expect(resolveSpawnOperatorBase()).toBe('http://127.0.0.1:3170/api/mcp');
  });

  it('falls back to PAPERCUSP_OPERATOR_URL when the host port is unknown', () => {
    process.env.PAPERCUSP_OPERATOR_URL = 'http://env.example/api/mcp';
    expect(resolveSpawnOperatorBase()).toBe('http://env.example/api/mcp');
  });

  it('falls back to the hardcoded localhost default when neither env is set', () => {
    // The module-level default is frozen at import from NODE_ENV (:3055 dev /
    // :3070 otherwise) — assert the shape, not a port, to stay env-agnostic.
    const base = resolveSpawnOperatorBase();
    expect(base).toMatch(/^http:\/\/localhost:30(55|70)\/api\/sse$/);
  });

  it('treats null/empty operatorUrl as unset (env resolution applies)', () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    expect(resolveSpawnOperatorBase(null)).toBe('http://127.0.0.1:3170/api/mcp');
    expect(resolveSpawnOperatorBase('')).toBe('http://127.0.0.1:3170/api/mcp');
  });
});


describe('writeSpawnMcp + restoreSpawnMcp', () => {
  const baseInput = {
    harnessSlug: 'sheets', workspaceId: 'default', role: 'worker',
    runId: 'run_X', spawnId: 'spw_X', featureId: 'F-Y', chunkId: 'ck_Z',
  };

  it('writes .mcp.json when no prior file exists', () => {
    const cwd = ROOT;
    const handle = writeSpawnMcp(cwd, baseInput);
    expect(handle.prior).toBeNull();
    expect(handle.backupPath).toBeNull();
    expect(existsSync(handle.path)).toBe(true);
    const content = JSON.parse(readFileSync(handle.path, 'utf8'));
    expect(content.mcpServers.papercusp.url).toContain('harness=sheets');
  });

  it('writes the MCP tools listing hint into .mcp.json when provided', () => {
    const handle = writeSpawnMcp(ROOT, {
      ...baseInput,
      role: 'mug',
      mcpToolNames: ['pot:survey', 'cup:spawn'],
    });
    const content = JSON.parse(readFileSync(handle.path, 'utf8'));
    const url = new URL(content.mcpServers.papercusp.url);
    expect(url.searchParams.get('tools')).toBe('pot:survey,cup:spawn');
  });

  it('restoreSpawnMcp deletes our file when there was no prior', () => {
    const handle = writeSpawnMcp(ROOT, baseInput);
    restoreSpawnMcp(handle);
    expect(existsSync(handle.path)).toBe(false);
  });

  it('saves and restores a prior .mcp.json', () => {
    const cwd = ROOT;
    const priorContent = JSON.stringify({ mcpServers: { user_server: { url: 'http://user.example' } } }, null, 2);
    writeFileSync(join(cwd, '.mcp.json'), priorContent, 'utf8');

    const handle = writeSpawnMcp(cwd, baseInput);
    expect(handle.prior).toBe(priorContent);
    expect(handle.backupPath).toBe(join(cwd, '.mcp.json.papercusp.bak'));
    expect(existsSync(handle.backupPath!)).toBe(true);

    // While the spawn is "running", our config is in place:
    const ourContent = JSON.parse(readFileSync(handle.path, 'utf8'));
    expect(ourContent.mcpServers.papercusp).toBeTruthy();
    expect(ourContent.mcpServers.user_server).toBeUndefined();

    restoreSpawnMcp(handle);
    expect(existsSync(handle.path)).toBe(true);
    expect(readFileSync(handle.path, 'utf8')).toBe(priorContent);
    expect(existsSync(handle.backupPath!)).toBe(false);
  });

  it('restoreSpawnMcp is idempotent (calling twice is safe)', () => {
    const handle = writeSpawnMcp(ROOT, baseInput);
    restoreSpawnMcp(handle);
    restoreSpawnMcp(handle);
    expect(existsSync(handle.path)).toBe(false);
  });
});

describe('writeSignedSpawnMcp — superuser-spawn door (EI-1547 regression guard)', () => {
  // A launched hive/Queen invoke (operator-initiated, loopback-gated via
  // PAPERCUSP_SPAWN_SU_BEARER — see spawn.ts's /harness/:slug/invoke route,
  // and invoke.ts's `mcpHandle = await writeSignedSpawnMcp(...)` call site)
  // connects through the `?superuser=1` branch of writeSignedSpawnMcp, NOT
  // the plain-signed-params branch the tests above (writeSpawnMcp) cover.
  // EI-1547 traced a write-scoping leak (a launched hive Queen's plans:*
  // calls landing under papercup instead of its own home harness) to this
  // door once carrying NO `harness=` param, so ctx.harnessSlug defaulted to
  // the '*' unscoped sentinel (parseRequestContext) and
  // plans/_ctx-opts.ts's ctxToPlanSourceOpts fell back to the operator-home
  // harness. The superuser branch now sets `harness=<input.harnessSlug>`
  // unconditionally — this locks that in.
  const savedBearer = process.env.PAPERCUSP_SPAWN_SU_BEARER;
  beforeEach(() => {
    process.env.PAPERCUSP_SPAWN_SU_BEARER = 'test-su-bearer-token';
  });
  afterEach(() => {
    if (savedBearer === undefined) delete process.env.PAPERCUSP_SPAWN_SU_BEARER;
    else process.env.PAPERCUSP_SPAWN_SU_BEARER = savedBearer;
  });

  it('bakes harness= (the launched project slug) + superuser=1 into the bearer-authed URL', async () => {
    const handle = await writeSignedSpawnMcp(ROOT, {
      harnessSlug: 'offsite-planner-demo',
      workspaceId: 'generic-test',
      role: 'mug',
      runId: 'run_hive',
      spawnId: 'spw_hive',
    });
    const content = JSON.parse(readFileSync(handle.path, 'utf8'));
    const url = new URL(content.mcpServers.papercusp.url);
    expect(url.searchParams.get('superuser')).toBe('1');
    expect(url.searchParams.get('harness')).toBe('offsite-planner-demo');
    expect(url.searchParams.get('workspace')).toBe('generic-test');
    // The Authorization header carries the bearer — the URL itself needs no `sig`.
    expect(content.mcpServers.papercusp.headers?.Authorization).toBe('Bearer test-su-bearer-token');
    expect(url.searchParams.get('sig')).toBeNull();
  });

  it('narrows tools= to the role catalog on the superuser door too', async () => {
    const handle = await writeSignedSpawnMcp(ROOT, {
      harnessSlug: 'offsite-planner-demo',
      workspaceId: 'generic-test',
      role: 'mug',
      runId: 'run_hive',
      spawnId: 'spw_hive',
      mcpToolNames: ['pot:survey', 'cup:spawn'],
    });
    const content = JSON.parse(readFileSync(handle.path, 'utf8'));
    const url = new URL(content.mcpServers.papercusp.url);
    expect(url.searchParams.get('tools')).toBe('pot:survey,cup:spawn');
  });
});

describe('isLocalOmpModel + writeOmpCompactionOverlay (deterministic-context-carry P-001 — local-model fleet spawns)', () => {
  it('detects local provider prefixes, including ollama-cc (the ornith incident model)', () => {
    expect(isLocalOmpModel('ollama-cc/maxwell1500/ornith-35b:IQ3_M')).toBe(true);
    expect(isLocalOmpModel('ollama/qwen3.5:latest')).toBe(true);
    expect(isLocalOmpModel('LMStudio/some-model')).toBe(true); // case-insensitive
    expect(isLocalOmpModel('anthropic/claude-opus-4-8')).toBe(false);
    expect(isLocalOmpModel('papercusp-gateway/claude-sonnet-4-6')).toBe(false); // gateway-pinned = hosted
    expect(isLocalOmpModel('')).toBe(false);
    expect(isLocalOmpModel(null)).toBe(false);
    expect(isLocalOmpModel(undefined)).toBe(false);
  });

  it('writes a shake@70 compaction overlay the spawn passes via --config, and cleanup removes it', () => {
    const handle = writeOmpCompactionOverlay();
    try {
      const written = readFileSync(handle.path, 'utf8');
      expect(written).toMatch(/^compaction:$/m);
      expect(written).toMatch(/\n\s+strategy:\s*shake/);
      expect(written).toMatch(/\n\s+thresholdPercent:\s*70/);
    } finally {
      handle.cleanup();
    }
    expect(existsSync(handle.path)).toBe(false);
    handle.cleanup(); // idempotent
  });

  it('adds remoteEndpoint alongside shake for the local-model shape (P-002)', () => {
    const handle = writeOmpCompactionOverlay({
      strategy: 'shake',
      remoteEndpoint: 'http://127.0.0.1:8788/maintenance/summarize',
    });
    try {
      const written = readFileSync(handle.path, 'utf8');
      expect(written).toMatch(/\n\s+strategy:\s*shake/);
      expect(written).toMatch(/\n\s+thresholdPercent:\s*70/);
      expect(written).toContain('  remoteEndpoint: "http://127.0.0.1:8788/maintenance/summarize"');
    } finally {
      handle.cleanup();
    }
  });

  it('writes an endpoint-ONLY overlay for a gateway-pinned hosted model (strategy: null — native strategy kept)', () => {
    const handle = writeOmpCompactionOverlay({
      strategy: null,
      remoteEndpoint: 'http://127.0.0.1:9911/maintenance/summarize',
    });
    try {
      const written = readFileSync(handle.path, 'utf8');
      expect(written).toMatch(/^compaction:$/m);
      expect(written).not.toContain('strategy');
      expect(written).not.toContain('thresholdPercent');
      expect(written).toContain('  remoteEndpoint: "http://127.0.0.1:9911/maintenance/summarize"');
    } finally {
      handle.cleanup();
    }
  });

  it('rejects the degenerate strategy:null + no-endpoint overlay (bare `compaction:` would null the base block)', () => {
    expect(() => writeOmpCompactionOverlay({ strategy: null })).toThrow(/empty omp compaction overlay/);
  });
});

describe('ompRemoteCompactionEndpoint (deterministic-context-carry P-002 — gateway maintenance lane)', () => {
  it('derives the endpoint from the models.yml baseUrl (anthropic wire: gateway root)', () => {
    const yml = 'providers:\n  papercusp-gateway:\n    baseUrl: "http://127.0.0.1:9911"\n    apiKey: "papercusp-gateway"\n';
    expect(ompRemoteCompactionEndpoint(yml, {})).toBe('http://127.0.0.1:9911/maintenance/summarize');
  });

  it('strips the openai wire\'s trailing /v1 from the baseUrl', () => {
    const yml = 'providers:\n  papercusp-gateway:\n    baseUrl: "http://127.0.0.1:9911/v1"\n';
    expect(ompRemoteCompactionEndpoint(yml, {})).toBe('http://127.0.0.1:9911/maintenance/summarize');
  });

  it('falls back to PAPERCUSP_GATEWAY_PORT (then 8788) when there is no models.yml', () => {
    expect(ompRemoteCompactionEndpoint(null, { PAPERCUSP_GATEWAY_PORT: '8799' })).toBe(
      'http://127.0.0.1:8799/maintenance/summarize',
    );
    expect(ompRemoteCompactionEndpoint('', {})).toBe('http://127.0.0.1:8788/maintenance/summarize');
    expect(ompRemoteCompactionEndpoint(undefined, { PAPERCUSP_GATEWAY_PORT: 'nonsense' })).toBe(
      'http://127.0.0.1:8788/maintenance/summarize',
    );
  });

  it('path constant stays in lockstep with the gateway route', () => {
    expect(OMP_MAINTENANCE_SUMMARIZE_PATH).toBe('/maintenance/summarize');
  });
});

describe('buildSpawnCodexConfigToml', () => {
  const savedGatewayPort = process.env.PAPERCUSP_GATEWAY_PORT;
  afterEach(() => {
    if (savedGatewayPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
    else process.env.PAPERCUSP_GATEWAY_PORT = savedGatewayPort;
  });

  it('routes model traffic through the gateway when a spawn account is pinned', () => {
    process.env.PAPERCUSP_GATEWAY_PORT = '8799';
    const toml = buildSpawnCodexConfigToml(
      'http://127.0.0.1:3270/api/mcp?harness=papercusp&sig=a"b',
      'aviynw_codex',
      { ownerId: 's-queen"1', priority: 'mug' },
    );

    expect(toml).toContain('model_provider = "papercusp-codex-gateway"');
    expect(toml).toContain('[model_providers.papercusp-codex-gateway]');
    expect(toml).toContain('base_url = "http://127.0.0.1:8799/v1"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('experimental_bearer_token = "papercusp-gateway"');
    expect(toml).toContain(
      'http_headers = { "x-papercusp-account" = "aviynw_codex", "x-papercusp-owner" = "s-queen\\"1", "x-papercusp-priority" = "mug" }',
    );
    expect(toml).toContain('[mcp_servers.papercusp]');
    expect(toml).toContain('url = "http://127.0.0.1:3270/api/mcp?harness=papercusp&sig=a\\"b"');
  });

  it('leaves the model provider unset when no spawn account is pinned', () => {
    const toml = buildSpawnCodexConfigToml(
      'http://127.0.0.1:3270/api/mcp?harness=papercusp',
      undefined,
    );

    expect(toml).not.toContain('papercusp-codex-gateway');
    expect(toml).not.toContain('model_provider =');
    expect(toml).toContain('[features]\nremote_compaction_v2 = false');
    expect(toml).toContain('[mcp_servers.papercusp]');
  });

  // WI-3645: an explicit-auto (or unpinned-after-validation-failure) spawn must still route
  // through the gateway — just without the account-pin header — instead of silently bypassing
  // it entirely (the previous behavior, indistinguishable from "gateway off").
  it('routes model traffic through the gateway with NO account-pin header when gatewayOn is set but no account is pinned (auto-routing)', () => {
    process.env.PAPERCUSP_GATEWAY_PORT = '8799';
    const toml = buildSpawnCodexConfigToml(
      'http://127.0.0.1:3270/api/mcp?harness=papercusp',
      undefined,
      { gatewayOn: true, ownerId: 's-queen1', priority: 'mug' },
    );

    expect(toml).toContain('model_provider = "papercusp-codex-gateway"');
    expect(toml).toContain('[model_providers.papercusp-codex-gateway]');
    expect(toml).toContain('base_url = "http://127.0.0.1:8799/v1"');
    expect(toml).not.toContain('x-papercusp-account"');
    expect(toml).toContain('http_headers = { "x-papercusp-owner" = "s-queen1", "x-papercusp-priority" = "mug" }');
  });

  it('omits the http_headers line entirely when gatewayOn is set with no account/owner/priority', () => {
    const toml = buildSpawnCodexConfigToml(
      'http://127.0.0.1:3270/api/mcp?harness=papercusp',
      undefined,
      { gatewayOn: true },
    );

    expect(toml).toContain('model_provider = "papercusp-codex-gateway"');
    expect(toml).not.toContain('http_headers');
  });
});

describe('extractChunkId', () => {
  it('extracts CHUNK_ID=ck_X from extras', () => {
    expect(extractChunkId(['FEATURE_ID=F-A', 'CHUNK_ID=ck_X'])).toBe('ck_X');
  });

  it('returns null when CHUNK_ID is absent', () => {
    expect(extractChunkId(['FEATURE_ID=F-A'])).toBeNull();
  });

  it('returns null when CHUNK_ID is empty', () => {
    expect(extractChunkId(['CHUNK_ID='])).toBeNull();
  });

  it('returns the first match if multiple are present', () => {
    expect(extractChunkId(['CHUNK_ID=first', 'CHUNK_ID=second'])).toBe('first');
  });
});

describe('writeSpawnOmpHome (omp-account-pinning-gateway-2026-06-29 P-006/D-008 — per-spawn omp gateway HOME seeder)', () => {
  const MODELS_YML =
    '# BEGIN PAPERCUSP_OMP_GATEWAY\nproviders:\n  papercusp-gateway:\n    baseUrl: "http://127.0.0.1:8788"\n# END PAPERCUSP_OMP_GATEWAY\n';

  // A stand-in source `~/.omp/agent` with the real essentials present (+ `mcp.json` absent,
  // to exercise the graceful skip) and a SOURCE models.yml the seeded one must shadow.
  function makeSource(): string {
    const src = join(ROOT, 'src-home', '.omp', 'agent');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'auth.json'), '{"token":"x"}');
    writeFileSync(join(src, 'agent.db'), 'SQLITEDB');
    writeFileSync(join(src, 'config.yml'), 'modelRoles: {}');
    writeFileSync(join(src, 'models.yml'), '# the SOURCE models.yml (must be shadowed)');
    mkdirSync(join(src, 'extensions'), { recursive: true });
    return src;
  }

  it('mints a HOME, symlinks present essentials, and AUTHORS the gateway models.yml (shadowing the source)', () => {
    const src = makeSource();
    const handle = writeSpawnOmpHome(MODELS_YML, src);
    const agentDir = join(handle.home, '.omp', 'agent');

    // models.yml is the ONE authored (real, not symlink) file, carrying our bytes — the routing
    // override that shadows the source's own models.yml for THIS session only.
    expect(handle.modelsPath).toBe(join(agentDir, 'models.yml'));
    expect(lstatSync(handle.modelsPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(handle.modelsPath, 'utf8')).toBe(MODELS_YML);

    // essentials present in the source are symlinked BACK to it (no credential copy).
    for (const entry of ['auth.json', 'agent.db', 'config.yml', 'extensions']) {
      const link = join(agentDir, entry);
      expect(existsSync(link)).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(join(src, entry));
    }
    // an absent essential (mcp.json) is skipped, never created.
    expect(existsSync(join(agentDir, 'mcp.json'))).toBe(false);

    handle.cleanup();
    expect(existsSync(handle.home)).toBe(false);
  });

  it('cleanup() removes only the per-spawn HOME — the symlinked source survives', () => {
    const src = makeSource();
    const handle = writeSpawnOmpHome(MODELS_YML, src);
    handle.cleanup();
    expect(existsSync(handle.home)).toBe(false);
    // cleanup removed the symlinks, not their targets — the source agent dir is intact.
    expect(readFileSync(join(src, 'auth.json'), 'utf8')).toContain('token');
    expect(readFileSync(join(src, 'models.yml'), 'utf8')).toContain('SOURCE');
  });

  it('seeds nothing when the source dir is missing (graceful) but still writes models.yml', () => {
    const handle = writeSpawnOmpHome(MODELS_YML, join(ROOT, 'no-such', '.omp', 'agent'));
    expect(readFileSync(handle.modelsPath, 'utf8')).toBe(MODELS_YML);
    for (const entry of OMP_SEEDED_AGENT_ESSENTIALS) {
      expect(existsSync(join(handle.home, '.omp', 'agent', entry))).toBe(false);
    }
    handle.cleanup();
  });
});
