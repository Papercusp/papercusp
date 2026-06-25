/**
 * Tests for per-spawn `.mcp.json` writing.
 * Run with: npx vitest run libs/papercusp/packages/orchestrator/src/spawn-mcp.test.ts
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSpawnMcpConfig,
  resolveSpawnOperatorBase,
  writeSpawnMcp,
  restoreSpawnMcp,
  extractChunkId,
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
  };
  beforeEach(() => {
    delete process.env.PAPERCUSP_HONO_PORT;
    delete process.env.PAPERCUSP_OPERATOR_URL;
  });
  afterEach(() => {
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
      harnessSlug: 'demo', workspaceId: 'ws-1', role: 'bee',
      runId: 'opspawn-1780', spawnId: 's-1780-deadbeef',
      clientId: 's-1780-deadbeef',
    });
    const url = new URL(cfg.mcpServers.papercusp!.url);
    expect(url.searchParams.get('client')).toBe('s-1780-deadbeef');
    expect(url.searchParams.get('role')).toBe('bee');
  });

  it('omits `client=` when clientId is not set (legacy pipeline-role path unchanged)', () => {
    const cfg = buildSpawnMcpConfig({
      harnessSlug: 'sheets', workspaceId: 'default', role: 'worker',
      runId: 'r', spawnId: 's',
    });
    const url = new URL(cfg.mcpServers.papercusp!.url);
    expect(url.searchParams.has('client')).toBe(false);
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
  };
  beforeEach(() => {
    delete process.env.PAPERCUSP_HONO_PORT;
    delete process.env.PAPERCUSP_OPERATOR_URL;
  });
  afterEach(() => {
    if (saved.port === undefined) delete process.env.PAPERCUSP_HONO_PORT;
    else process.env.PAPERCUSP_HONO_PORT = saved.port;
    if (saved.url === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = saved.url;
  });

  it('an explicit per-spawn operatorUrl wins over every env source', () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    process.env.PAPERCUSP_OPERATOR_URL = 'http://env.example/api/mcp';
    expect(resolveSpawnOperatorBase('http://pin.example:9/sse')).toBe('http://pin.example:9/sse');
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
