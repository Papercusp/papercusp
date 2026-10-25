/**
 * Tests for per-spawn `.mcp.json` writing.
 * Run with: npx vitest run libs/papercusp/packages/orchestrator/src/spawn-mcp.test.ts
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from '@iarna/toml';
import {
  buildSpawnCodexConfigToml,
  buildSpawnMcpConfig,
  resolveSpawnOperatorBase,
  resolveSpawnOperatorBaseAsync,
  writeSpawnMcp,
  writeSignedSpawnMcp,
  writeSignedSpawnCodexHome,
  restoreSpawnMcp,
  extractChunkId,
  writeSpawnOmpHome,
  OMP_SEEDED_AGENT_ESSENTIALS,
  isLocalOmpModel,
  writeOmpCompactionOverlay,
  ompRemoteCompactionEndpoint,
  OMP_MAINTENANCE_SUMMARIZE_PATH,
  resolveMcpConfigPlacement,
  type McpConfigPlacement,
  type SpawnMcpSigningPg,
} from './spawn-mcp';
import { canonicalizeSpawnParams } from './spawn-signing-core';

describe('resolveMcpConfigPlacement — placement and restore-skip cannot drift', () => {
  const TRACKED = 'spawn-abc123';

  it('a TRACKED claude-code spawn with a workspace persists outside cwd (the resume needs it)', () => {
    expect(resolveMcpConfigPlacement({
      agentBackend: 'claude-code', workspaceId: 'ws-1', trackedSessionSpawnId: TRACKED,
    })).toEqual({ kind: 'session-dir', spawnId: TRACKED, persistsOutsideCwd: true });
  });

  // THE REGRESSION (EI-23336628915114721). Tracked, but a non-claude backend never
  // takes the redirect — the config lands in the SHARED `<cwd>/.mcp.json`, so the
  // close-time restore MUST run. Keying the skip off the tracked id alone stranded
  // that signed config in the shared repo root permanently.
  it('a TRACKED omp spawn stays in cwd and MUST be restored', () => {
    expect(resolveMcpConfigPlacement({
      agentBackend: 'omp', workspaceId: 'ws-1', trackedSessionSpawnId: TRACKED,
    })).toEqual({ kind: 'cwd', persistsOutsideCwd: false });
  });

  it('a TRACKED claude-code spawn with NO workspaceId stays in cwd and MUST be restored', () => {
    expect(resolveMcpConfigPlacement({
      agentBackend: 'claude-code', workspaceId: null, trackedSessionSpawnId: TRACKED,
    })).toEqual({ kind: 'cwd', persistsOutsideCwd: false });
  });

  it('an UNtracked claude-code spawn uses a disposable temp dir', () => {
    expect(resolveMcpConfigPlacement({
      agentBackend: 'claude-code', workspaceId: 'ws-1', trackedSessionSpawnId: '',
    })).toEqual({ kind: 'temp-dir', persistsOutsideCwd: false });
  });

  it('persistsOutsideCwd is true ONLY for a session-dir placement', () => {
    const seen: McpConfigPlacement['kind'][] = [];
    for (const agentBackend of ['claude-code', 'omp', 'codex']) {
      for (const workspaceId of ['ws-1', null]) {
        for (const trackedSessionSpawnId of [TRACKED, '', '   ']) {
          const p = resolveMcpConfigPlacement({ agentBackend, workspaceId, trackedSessionSpawnId });
          seen.push(p.kind);
          expect(p.persistsOutsideCwd).toBe(p.kind === 'session-dir');
        }
      }
    }
    // Calibration: every arm was actually reached, so the assertion above cannot
    // pass vacuously by never producing a persisting placement.
    expect(new Set(seen)).toEqual(new Set(['session-dir', 'temp-dir', 'cwd']));
  });
});

const ROOT = join(tmpdir(), `papercusp-spawn-mcp-test-${process.pid}`);
// These serialization/routing fixtures select a model just as invoke.ts does.
// Omitting it tests model-selection policy instead of the behavior named below.
const TEST_CODEX_MODEL = 'gpt-5.4:high';

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
    // WI-6554700010010138: every agent session asks for the trimmed payload tier
    // [owner 2026-08-10]; without it the host serves the unshaped 'full' tier.
    expect(url.searchParams.get('ctx_tier')).toBe('trimmed');
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

  it('bakes the private detector session key separately from public client identity', () => {
    const cfg = buildSpawnMcpConfig({
      harnessSlug: 'demo', workspaceId: 'ws-1', role: 'judge',
      runId: 'run-1', spawnId: 'spawn-1', clientId: null,
      detectorSessionKey: 'sid-auditor-1',
    });
    const url = new URL(cfg.mcpServers.papercusp!.url);
    expect(url.searchParams.get('detector')).toBe('sid-auditor-1');
    expect(url.searchParams.has('client')).toBe(false);
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
      expect(cfg.mcpServers.papercusp!.url.startsWith('http://env.example/api/mcp?')).toBe(true);
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
    proxyTargetPort: process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT,
  };
  beforeEach(() => {
    delete process.env.PAPERCUSP_HONO_PORT;
    delete process.env.PAPERCUSP_OPERATOR_URL;
    delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    delete process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT;
  });
  afterEach(() => {
    if (saved.port === undefined) delete process.env.PAPERCUSP_HONO_PORT;
    else process.env.PAPERCUSP_HONO_PORT = saved.port;
    if (saved.url === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = saved.url;
    if (saved.proxy === undefined) delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    else process.env.PAPERCUSP_MCP_PROXY_BASE = saved.proxy;
    if (saved.proxyTargetPort === undefined) delete process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT;
    else process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT = saved.proxyTargetPort;
  });

  it('an explicit per-spawn operatorUrl wins over every env source (incl. the proxy base)', () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    process.env.PAPERCUSP_OPERATOR_URL = 'http://env.example/api/mcp';
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    expect(resolveSpawnOperatorBase('http://pin.example:9/sse')).toBe('http://pin.example:9/sse');
  });

  it('keeps a non-green host child on its spawning host instead of a proxy that fronts green', () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    process.env.PAPERCUSP_OPERATOR_URL = 'http://env.example/api/mcp';
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    expect(resolveSpawnOperatorBase()).toBe('http://127.0.0.1:3170/api/mcp');
  });

  // mcp-host-availability-resilience P-005 is preserved for the host the proxy
  // actually fronts: a :3070 restart remains invisible to its spawned clients.
  it('routes a green-host child through the proxy that fronts that same host', () => {
    process.env.PAPERCUSP_HONO_PORT = '3070';
    process.env.PAPERCUSP_OPERATOR_URL = 'http://env.example/api/mcp';
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    expect(resolveSpawnOperatorBase()).toBe('http://127.0.0.1:9071/api/mcp');
  });

  it('honors an explicit nonstandard proxy target when it matches the spawning host', () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9171';
    process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT = '3170';
    expect(resolveSpawnOperatorBase()).toBe('http://127.0.0.1:9171/api/mcp');
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

  it('appends /api/mcp when PAPERCUSP_OPERATOR_URL is a bare proxy origin', () => {
    process.env.PAPERCUSP_OPERATOR_URL = 'http://127.0.0.1:9071';
    expect(resolveSpawnOperatorBase()).toBe('http://127.0.0.1:9071/api/mcp');
  });

  it('repairs the retired /api/sse inherited endpoint', () => {
    process.env.PAPERCUSP_OPERATOR_URL = 'http://env.example/api/sse';
    expect(resolveSpawnOperatorBase()).toBe('http://env.example/api/mcp');
  });

  it('falls back to the hardcoded localhost default when neither env is set', () => {
    // The module-level default is frozen at import from NODE_ENV (:3055 dev /
    // :3070 otherwise) — assert the shape, not a port, to stay env-agnostic.
    const base = resolveSpawnOperatorBase();
    expect(base).toMatch(/^http:\/\/localhost:30(55|70)\/api\/mcp$/);
  });

  it('treats null/empty operatorUrl as unset (env resolution applies)', () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    expect(resolveSpawnOperatorBase(null)).toBe('http://127.0.0.1:3170/api/mcp');
    expect(resolveSpawnOperatorBase('')).toBe('http://127.0.0.1:3170/api/mcp');
  });
});

describe('resolveSpawnOperatorBaseAsync — stale local MCP-port recovery', () => {
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

  it('recovers a dead PAPERCUSP_HONO_PORT on the canonical MCP port', async () => {
    process.env.PAPERCUSP_HONO_PORT = '3271';
    const probed: string[] = [];
    const recoveries: Array<{ configuredBase: string; recoveredBase: string; configuredPort: string | null }> = [];
    const base = await resolveSpawnOperatorBaseAsync(undefined, {
      probe: async (candidate) => {
        probed.push(candidate);
        return candidate === 'http://127.0.0.1:3070/api/mcp';
      },
      onRecovery: (recovery) => recoveries.push(recovery),
    });

    expect(base).toBe('http://127.0.0.1:3070/api/mcp');
    expect(probed).toEqual([
      'http://127.0.0.1:3271/api/mcp',
      'http://127.0.0.1:3070/api/mcp',
    ]);
    expect(recoveries).toEqual([{
      configuredBase: 'http://127.0.0.1:3271/api/mcp',
      recoveredBase: 'http://127.0.0.1:3070/api/mcp',
      configuredPort: '3271',
    }]);
  });

  it('keeps a live non-green spawning host instead of falling through to green', async () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    const probed: string[] = [];
    const base = await resolveSpawnOperatorBaseAsync(undefined, {
      probe: async (candidate) => {
        probed.push(candidate);
        return candidate === 'http://127.0.0.1:3170/api/mcp';
      },
      onRecovery: () => {
        throw new Error('unexpected recovery');
      },
    });

    expect(base).toBe('http://127.0.0.1:3170/api/mcp');
    expect(probed).toEqual(['http://127.0.0.1:3170/api/mcp']);
  });

  it('does not probe or override an explicit per-spawn operator pin', async () => {
    process.env.PAPERCUSP_HONO_PORT = '3271';
    const probe = async () => {
      throw new Error('explicit pins must not probe');
    };
    await expect(resolveSpawnOperatorBaseAsync('http://pin.example:9/api/mcp', { probe }))
      .resolves.toBe('http://pin.example:9/api/mcp');
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
    // WI-6554700010010138: the superuser spawn door asks for the trimmed tier too.
    expect(url.searchParams.get('ctx_tier')).toBe('trimmed');
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

describe('writeSignedSpawnMcp — existing PG signing path', () => {
  it('mints the requested worker principal without a DSN instead of falling back to an unrelated cwd principal', async () => {
    const saved = {
      databaseUrl: process.env.DATABASE_URL,
      papercuspDsn: process.env.PAPERCUSP_PG_DSN,
      suBearer: process.env.PAPERCUSP_SPAWN_SU_BEARER,
    };
    delete process.env.DATABASE_URL;
    delete process.env.PAPERCUSP_PG_DSN;
    delete process.env.PAPERCUSP_SPAWN_SU_BEARER;

    const prior = JSON.stringify({
      mcpServers: {
        papercusp: {
          type: 'http',
          url: 'http://localhost:3170/api/mcp?workspace=ws&harness=demo&role=judge&run=old&spawn=old',
        },
      },
    }, null, 2);
    writeFileSync(join(ROOT, '.mcp.json'), prior, 'utf8');
    let keyReads = 0;
    const pg = (async (template: TemplateStringsArray) => {
      keyReads += 1;
      expect(template.join(' ')).toContain('harness_shared.operator_secrets');
      return [{
        value_b64: Buffer.alloc(32, 7).toString('base64'),
        rotated_at: new Date('2026-08-24T00:00:00Z'),
      }];
    }) as SpawnMcpSigningPg;

    try {
      const handle = await writeSignedSpawnMcp(ROOT, {
        harnessSlug: 'demo',
        workspaceId: 'ws',
        role: 'worker',
        runId: 'worker-parity-canary-omp',
        spawnId: 'spawn-worker-parity-canary-omp',
        chunkId: 'worker-parity-canary',
        mcpToolNames: ['capability:git'],
      }, { pg });
      try {
        const content = JSON.parse(readFileSync(handle.path, 'utf8'));
        const url = new URL(content.mcpServers.papercusp.url);
        expect(url.searchParams.get('role')).toBe('worker');
        expect(url.searchParams.get('run')).toBe('worker-parity-canary-omp');
        expect(url.searchParams.get('chunk')).toBe('worker-parity-canary');
        expect(url.searchParams.get('tools')).toBe('capability:git');
        expect(url.searchParams.get('sig')).toBeTruthy();
        expect(url.searchParams.get('superuser')).toBeNull();
        // WI-6554700010010138: the signed spawn URL carries the trimmed tier, and the
        // tier sits OUTSIDE the HMAC — the canonical signed bytes are identical with and
        // without it, so adding it can never break signature verification.
        expect(url.searchParams.get('ctx_tier')).toBe('trimmed');
        const withTier = canonicalizeSpawnParams(url.searchParams);
        const withoutTierParams = new URLSearchParams(url.searchParams);
        withoutTierParams.delete('ctx_tier');
        const withoutTier = canonicalizeSpawnParams(withoutTierParams);
        expect(withTier.ok && withoutTier.ok).toBe(true);
        if (withTier.ok && withoutTier.ok) {
          expect(withTier.canonical).toEqual(withoutTier.canonical);
        }
        expect(handle.prior).toBe(prior);
        expect(keyReads).toBe(1);
      } finally {
        restoreSpawnMcp(handle);
      }
      expect(readFileSync(join(ROOT, '.mcp.json'), 'utf8')).toBe(prior);
    } finally {
      if (saved.databaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved.databaseUrl;
      if (saved.papercuspDsn === undefined) delete process.env.PAPERCUSP_PG_DSN;
      else process.env.PAPERCUSP_PG_DSN = saved.papercuspDsn;
      if (saved.suBearer === undefined) delete process.env.PAPERCUSP_SPAWN_SU_BEARER;
      else process.env.PAPERCUSP_SPAWN_SU_BEARER = saved.suBearer;
    }
  });
});

describe('async spawn config writers use stale-port recovery', () => {
  const stalePort = process.env.PAPERCUSP_HONO_PORT;
  const suBearer = process.env.PAPERCUSP_SPAWN_SU_BEARER;

  beforeEach(() => {
    process.env.PAPERCUSP_HONO_PORT = '3271';
    process.env.PAPERCUSP_SPAWN_SU_BEARER = 'test-su-bearer-token';
  });

  afterEach(() => {
    if (stalePort === undefined) delete process.env.PAPERCUSP_HONO_PORT;
    else process.env.PAPERCUSP_HONO_PORT = stalePort;
    if (suBearer === undefined) delete process.env.PAPERCUSP_SPAWN_SU_BEARER;
    else process.env.PAPERCUSP_SPAWN_SU_BEARER = suBearer;
    vi.unstubAllEnvs();
  });

  it.each(['auto', 'pin'])('writes the recovered URL to signed .mcp.json and Codex config.toml with ambient %s routing', async ambientRoute => {
    vi.stubEnv('PAPERCUSP_ACCOUNT_ROUTING_MODE', ambientRoute);
    vi.stubEnv('PAPERCUSP_CODEX_GATEWAY', undefined);
    vi.stubEnv('PAPERCUSP_ACCOUNT_ID', undefined);
    const probe = async (candidate: string) => candidate === 'http://127.0.0.1:3070/api/mcp';
    const pg = (async () => [{
      value_b64: Buffer.alloc(32, 7).toString('base64'),
      rotated_at: new Date('2026-08-25T00:00:00Z'),
    }]) as SpawnMcpSigningPg;
    const input = {
      harnessSlug: 'demo',
      workspaceId: 'ws',
      role: 'worker',
      runId: 'run',
      spawnId: 'spawn',
    };

    const mcpHandle = await writeSignedSpawnMcp(ROOT, input, { probe, onRecovery: () => {} });
    try {
      const mcp = JSON.parse(readFileSync(mcpHandle.path, 'utf8'));
      expect(mcp.mcpServers.papercusp.url).toMatch(/^http:\/\/127\.0\.0\.1:3070\/api\/mcp\?/);
    } finally {
      restoreSpawnMcp(mcpHandle);
    }

    const codexHome = join(ROOT, 'codex-home');
    const codexHandle = await writeSignedSpawnCodexHome(input, {
      codexHome,
      cleanup: false,
      model: TEST_CODEX_MODEL,
      // This fixture exercises endpoint recovery with a resolved child route.
      gatewayEnv: { PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' },
      probe,
      onRecovery: () => {},
      pg,
    });
    try {
      expect(readFileSync(join(codexHome, 'config.toml'), 'utf8'))
        .toContain('url = "http://127.0.0.1:3070/api/mcp?');
      expect(readFileSync(join(codexHome, 'config.toml'), 'utf8'))
        .not.toContain('papercusp-codex-gateway');
    } finally {
      codexHandle.cleanup();
    }
  });
});

describe('per-spawn Codex account route', () => {
  afterEach(() => vi.unstubAllEnvs());

  // Non-gateway homes materialize a stripped model catalog. The fake keeps these
  // route tests independent of ~/.codex and of an installed codex binary.
  const catalogWrites: string[] = [];
  const fakeMaterializeModelCatalog = ({ codexHome }: { codexHome: string }) => {
    catalogWrites.push(codexHome);
    const path = join(codexHome, 'papercusp-model-catalog.json');
    writeFileSync(path, '{"models":[{"slug":"stripped"}]}\n');
    return { path, source: 'bundled' as const, sourcePath: null, modelCount: 1, fetchedAt: null };
  };
  beforeEach(() => { catalogWrites.length = 0; });

  async function writtenConfig(gatewayEnv?: Record<string, string | undefined>): Promise<string> {
    return (await writtenHome(gatewayEnv)).toml;
  }

  async function writtenHome(gatewayEnv?: Record<string, string | undefined>) {
    const handle = await writeSignedSpawnCodexHome({
      harnessSlug: 'demo', workspaceId: 'ws', role: 'release-fixer',
      runId: 'route-run', spawnId: 'route-spawn', clientId: 'route-owner',
      operatorUrl: 'http://127.0.0.1:3070',
    }, {
      model: TEST_CODEX_MODEL, gatewayEnv, probe: async () => true,
      pg: (async () => [{ value_b64: Buffer.alloc(32, 7).toString('base64'),
        rotated_at: new Date('2026-08-25T00:00:00Z') }]) as SpawnMcpSigningPg,
      materializeModelCatalog: fakeMaterializeModelCatalog,
    });
    try { return { toml: readFileSync(join(handle.codexHome, 'config.toml'), 'utf8'), codexHome: handle.codexHome }; }
    finally { handle.cleanup(); }
  }

  it('a non-gateway spawn home runs on a stripped model_catalog_json and a gateway spawn home has none', async () => {
    vi.stubEnv('PAPERCUSP_CODEX_GATEWAY', undefined);
    vi.stubEnv('PAPERCUSP_ACCOUNT_ID', undefined);
    const local = await writtenHome({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' });
    const lines = local.toml.split('\n');
    const catalogLine = `model_catalog_json = "${join(local.codexHome, 'papercusp-model-catalog.json')}"`;
    expect(catalogWrites).toEqual([local.codexHome]);
    expect(lines.filter((line) => line === catalogLine)).toHaveLength(1);
    // A root key: it precedes every [table], or TOML would scope it to that table.
    expect(lines.indexOf(catalogLine)).toBeLessThan(lines.findIndex((line) => line.startsWith('[')));
    expect(lines).toEqual(expect.arrayContaining(['multi_agent = false', 'goals = false']));

    catalogWrites.length = 0;
    const gateway = await writtenConfig({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'auto', PAPERCUSP_CODEX_GATEWAY: '1' });
    expect(gateway).toContain('model_provider = "papercusp-codex-gateway"');
    expect(gateway).not.toContain('model_catalog_json');
    expect(catalogWrites).toEqual([]);
    expect(gateway.split('\n')).toEqual(expect.arrayContaining(['multi_agent = false', 'goals = false']));

    // The renderer itself drops a catalog path on the gateway route.
    expect(buildSpawnCodexConfigToml('http://127.0.0.1:3070/api/mcp', null, {
      model: TEST_CODEX_MODEL, gatewayOn: true, modelCatalogPath: '/tmp/catalog.json',
    })).not.toContain('model_catalog_json');
  });

  it('auto route writes gateway config without pin when orchestrator env is unset', async () => {
    vi.stubEnv('PAPERCUSP_CODEX_GATEWAY', undefined);
    vi.stubEnv('PAPERCUSP_ACCOUNT_ID', undefined);
    const toml = await writtenConfig({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'auto', PAPERCUSP_CODEX_GATEWAY: '1' });
    expect(toml).toContain('model_provider = "papercusp-codex-gateway"');
    expect(toml).toContain('base_url = "http://127.0.0.1:');
    expect(toml).toContain('"x-papercusp-owner" = "route-owner"');
    expect(toml).not.toContain('"x-papercusp-account"');
  });

  it('absent route preserves gateway env fallback', async () => {
    vi.stubEnv('PAPERCUSP_CODEX_GATEWAY', '1');
    vi.stubEnv('PAPERCUSP_ACCOUNT_ID', 'legacy-account');
    vi.stubEnv('PAPERCUSP_ACCOUNT_ROUTING_MODE', undefined);
    const toml = await writtenConfig();
    expect(toml).toContain('model_provider = "papercusp-codex-gateway"');
    expect(toml).toContain('"x-papercusp-account" = "legacy-account"');
  });

  it('pinned route writes requested account header', async () => {
    const toml = await writtenConfig({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'pin', PAPERCUSP_CODEX_GATEWAY: '1', PAPERCUSP_ACCOUNT_ID: 'requested-account' });
    expect(toml).toContain('"x-papercusp-account" = "requested-account"');
  });

  it('default route writes local config without env', async () => {
    vi.stubEnv('PAPERCUSP_CODEX_GATEWAY', undefined);
    expect(await writtenConfig({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' })).not.toContain('papercusp-codex-gateway');
  });

  it('unresolvable auto gateway refuses spawn', async () => {
    await expect(writtenConfig({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'auto' })).rejects.toThrow('explicit Codex gateway route is unresolved');
  });

  it('explicit default overrides gateway environment', async () => {
    vi.stubEnv('PAPERCUSP_CODEX_GATEWAY', '1');
    vi.stubEnv('PAPERCUSP_ACCOUNT_ID', 'parent-account');
    expect(await writtenConfig({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' })).not.toContain('papercusp-codex-gateway');
  });

  it('explicit pin overrides parent account environment', async () => {
    vi.stubEnv('PAPERCUSP_ACCOUNT_ID', 'parent-account');
    const toml = await writtenConfig({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'pin', PAPERCUSP_CODEX_GATEWAY: '1', PAPERCUSP_ACCOUNT_ID: 'requested-account' });
    expect(toml).toContain('"x-papercusp-account" = "requested-account"');
    expect(toml).not.toContain('parent-account');
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
  it('renders admitted shell removal inside features while retaining the signed MCP route', () => {
    const toml = buildSpawnCodexConfigToml('http://127.0.0.1:3270/api/mcp?sig=fixture', null, {
      model: TEST_CODEX_MODEL,
      capabilityPolicy: {
        surface: 'wake', clientVersions: { codex: '0.163.0' },
        readiness: [{ family: 'shell-ssh-interpreters', cutoverReady: true, openGapIds: [] }],
        cutoverStaging: { 'shell-ssh-interpreters': 'full' },
        adoption: [{ client: 'codex', family: 'shell-ssh-interpreters',
          managedPathProven: true, nativeBypassRefused: true, atClientVersion: '0.163.0' }],
        matrix: [{ client: 'codex', family: 'shell-ssh-interpreters',
          allScenariosPassed: true, declaredScenarioCount: 7, unmet: [] }],
      },
    });
    const features = toml.slice(toml.indexOf('[features]'), toml.indexOf('[mcp_servers.papercusp]'));
    expect(features).toContain('shell_tool = false');
    expect(toml).toContain('url = "http://127.0.0.1:3270/api/mcp?sig=fixture"');
    expect(toml).not.toContain('--disallowedTools');
    expect(buildSpawnCodexConfigToml('http://127.0.0.1:3270/api/mcp', null,
      { model: TEST_CODEX_MODEL })).not.toContain('shell_tool = false');
  });

  const savedGatewayPort = process.env.PAPERCUSP_GATEWAY_PORT;
  afterEach(() => {
    if (savedGatewayPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
    else process.env.PAPERCUSP_GATEWAY_PORT = savedGatewayPort;
  });

  it('preserves the selected model and effort instead of substituting a default', () => {
    const toml = buildSpawnCodexConfigToml(
      'http://127.0.0.1:3270/api/mcp?harness=papercusp',
      undefined,
      { model: TEST_CODEX_MODEL },
    );
    expect(toml).toContain('model = "gpt-5.4"\n');
    expect(toml).toContain('model_reasoning_effort = "high"\n');
    expect(toml.indexOf('model =')).toBeLessThan(toml.indexOf('[features]'));
  });

  it('prepends a resolved context pair as TOML root keys before every table', () => {
    const toml = buildSpawnCodexConfigToml(
      'http://127.0.0.1:3270/api/mcp?harness=papercusp',
      undefined,
      { model: TEST_CODEX_MODEL, contextConfig: { modelContextWindow: 1_000_000, modelAutoCompactTokenLimit: 900_000 } },
    );
    expect(toml).toMatch(
      /^model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n/,
    );
    expect(toml.indexOf('model_context_window')).toBeLessThan(toml.indexOf('[features]'));
  });

  it('routes model traffic through the gateway when a spawn account is pinned', () => {
    process.env.PAPERCUSP_GATEWAY_PORT = '8799';
    const toml = buildSpawnCodexConfigToml(
      'http://127.0.0.1:3270/api/mcp?harness=papercusp&sig=a"b',
      'aviynw_codex',
      { model: TEST_CODEX_MODEL, ownerId: 's-queen"1', priority: 'mug' },
    );

    expect(toml).toContain('model_provider = "papercusp-codex-gateway"');
    expect(toml).toContain('[model_providers.papercusp-codex-gateway]');
    expect(toml).toContain('base_url = "http://127.0.0.1:8799/v1"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('experimental_bearer_token = "papercusp-gateway"');
    expect(toml).toContain(
      'http_headers = { "originator" = "codex_cli_rs", "x-papercusp-account" = "aviynw_codex", "x-papercusp-owner" = "s-queen\\"1", "x-papercusp-priority" = "mug" }',
    );
    expect(toml).toContain('[mcp_servers.papercusp]');
    expect(toml).toContain('url = "http://127.0.0.1:3270/api/mcp?harness=papercusp&sig=a\\"b"');
    expect(parseToml(toml).mcp_servers).toEqual({ papercusp: {
      url: 'http://127.0.0.1:3270/api/mcp?harness=papercusp&sig=a"b',
      tools: { 'tools:invoke': { approval_mode: 'approve' } },
    } });
  });

  it('leaves the model provider unset when no spawn account is pinned', () => {
    const toml = buildSpawnCodexConfigToml(
      'http://127.0.0.1:3270/api/mcp?harness=papercusp',
      undefined,
      { model: TEST_CODEX_MODEL },
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
      { model: TEST_CODEX_MODEL, gatewayOn: true, ownerId: 's-queen1', priority: 'mug' },
    );

    expect(toml).toContain('model_provider = "papercusp-codex-gateway"');
    expect(toml).toContain('[model_providers.papercusp-codex-gateway]');
    expect(toml).toContain('base_url = "http://127.0.0.1:8799/v1"');
    expect(toml).not.toContain('x-papercusp-account"');
    expect(toml).toContain(
      'http_headers = { "originator" = "codex_cli_rs", "x-papercusp-owner" = "s-queen1", "x-papercusp-priority" = "mug" }',
    );
  });

  it('keeps only the Codex originator header when gatewayOn has no account/owner/priority', () => {
    const toml = buildSpawnCodexConfigToml(
      'http://127.0.0.1:3270/api/mcp?harness=papercusp',
      undefined,
      { model: TEST_CODEX_MODEL, gatewayOn: true },
    );

    expect(toml).toContain('model_provider = "papercusp-codex-gateway"');
    expect(toml).toContain('http_headers = { "originator" = "codex_cli_rs" }');
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

  // A stand-in source `~/.omp/agent` with the real essentials present, a full
  // superuser mcp.json that MUST NOT leak into a scoped child, and a SOURCE
  // models.yml the seeded one must shadow.
  function makeSource(): string {
    const src = join(ROOT, 'src-home', '.omp', 'agent');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'auth.json'), '{"token":"x"}');
    writeFileSync(join(src, 'agent.db'), 'SQLITEDB');
    writeFileSync(join(src, 'config.yml'), 'modelRoles: {}');
    writeFileSync(join(src, 'mcp.json'), '{"mcpServers":{"papercusp-su":{"url":"full-superuser"}}}');
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
    // The source's full superuser MCP config is NOT an auth/config essential.
    // invoke() writes a signed role-scoped .mcp.json in the child cwd; seeding
    // this file loaded both catalogs and produced a 615k-token OMP prompt.
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
