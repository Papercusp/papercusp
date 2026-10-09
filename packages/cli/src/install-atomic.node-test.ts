/**
 * Integration tests for `papercusp install` atomic-staging behavior (PR #6).
 *
 * Real bug class this guards against: a transient marketplace 503 / 404 /
 * truncated tarball / bad-manifest tarball used to wipe the existing
 * install before downloading, leaving the user with nothing. The PR
 * switched to download-into-staging + atomic-rename-into-place. These
 * tests pin both the happy path AND the failure-preserves-existing path.
 *
 * Run with:
 *   cd libs/papercusp/packages/cli && node --test --import tsx src/install-atomic.node-test.ts
 *
 * Each test spawns the real `papercusp install` CLI against a per-test
 * mock HTTP marketplace served on a random port. The mock validates the
 * download path and returns a real-shape tarball (or an injected error
 * status) — same artifact format the real marketplace serves.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { spawnSync, spawn as spawnAsync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(__dirname, '..', 'bin', 'papercusp');
const REPO_ROOT = resolve(__dirname, '../../../../..');
const REPO_BIN = join(REPO_ROOT, 'node_modules', '.bin');

/** Build a real gzipped tarball containing papercusp.json + index.js so the
 *  CLI's tar extract + manifest validate paths actually run. */
async function buildFakeTarball(opts: {
  name: string;
  version: string;
  kind?: 'plugin' | 'template';
  capabilities?: string[];
  manifestExtras?: Record<string, unknown>;
}): Promise<Buffer> {
  const stagingDir = await fs.mkdtemp(join(tmpdir(), 'install-atomic-tar-'));
  try {
    const manifest = {
      name: opts.name,
      version: opts.version,
      kind: opts.kind ?? 'plugin',
      capabilities: opts.capabilities ?? [],
      ...(opts.manifestExtras ?? {}),
    };
    await fs.writeFile(join(stagingDir, 'papercusp.json'), JSON.stringify(manifest, null, 2));
    await fs.writeFile(join(stagingDir, 'index.js'), `module.exports = { name: '${opts.name}' };\n`);
    const out = spawnSync('tar', ['czf', '-', '-C', stagingDir, 'papercusp.json', 'index.js'], { stdio: ['ignore', 'pipe', 'inherit'] });
    if (out.status !== 0) throw new Error('tar build failed');
    return out.stdout;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

interface MockMarketplace {
  url: string;
  port: number;
  /** Override the response for a specific (path, status). Most recent
   *  registration wins; useful for switching catalog vs download. */
  setHandler(path: string, handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): void;
  requests: { path: string; elapsedMs: number; status?: number; finishedMs?: number }[];
  close(): Promise<void>;
}

async function startMockMarketplace(): Promise<MockMarketplace> {
  const handlers = new Map<string, (req: any, res: any) => void>();
  const startedAt = performance.now();
  const requests: MockMarketplace['requests'] = [];
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    const request = { path, elapsedMs: Math.round(performance.now() - startedAt) } as MockMarketplace['requests'][number];
    requests.push(request);
    res.once('finish', () => {
      request.status = res.statusCode;
      request.finishedMs = Math.round(performance.now() - startedAt);
    });
    const h = handlers.get(path);
    if (!h) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `no mock handler for ${path}` }));
      return;
    }
    h(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    setHandler: (path, handler) => handlers.set(path, handler),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Run the real CLI. Test-only options exercise the same pipe and deadline fence. */
async function runCli(args: string[], env: NodeJS.ProcessEnv, options: {
  executable?: string;
  timeoutMs?: number;
  killGraceMs?: number;
} = {}) {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    PATH: `${REPO_BIN}:${process.env.PATH ?? ''}`,
  };
  // Node's test runner injects worker-context env vars into child processes.
  // The real CLI is not a test worker; inheriting them can leave the subprocess
  // alive indefinitely under node:test isolation instead of exiting after work.
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;

  const executable = options.executable ?? CLI_BIN;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const startedAt = performance.now();
  const requestOffset = mp.requests.length;
  return await new Promise<{
    code: number; signal: NodeJS.Signals | null; stdout: string; stderr: string;
    timedOut: boolean; closed: true; durationMs: number;
  }>((resolve) => {
    const child = spawnAsync(executable, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const phases: Record<string, number | string> = {};
    const elapsed = () => Math.round(performance.now() - startedAt);
    const signalTree = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          stderr += `\nprocess signal failed: ${String(error)}`;
        }
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      phases.deadlineMs = elapsed();
      stderr += `\nspawn error: ${executable} timed out after ${timeoutMs}ms`;
      signalTree('SIGTERM');
      escalation = setTimeout(() => {
        phases.escalationMs = elapsed();
        signalTree('SIGKILL');
      }, options.killGraceMs ?? 1_000);
    }, timeoutMs);
    child.once('spawn', () => { phases.spawnMs = elapsed(); });
    child.stdout?.on('data', (chunk) => {
      phases.firstStdoutMs ??= elapsed();
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      phases.firstStderrMs ??= elapsed();
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      phases.spawnErrorMs = elapsed();
      stderr += `\nspawn error: ${err.message}`;
    });
    child.once('exit', (code, signal) => {
      phases.exitMs = elapsed();
      phases.exitCode = code ?? 'none';
      phases.exitSignal = signal ?? 'none';
    });
    // 'exit' precedes pipe EOF: descendants can still be writing captured output.
    // Retain deadline/escalation until 'close' so neither output nor ownership is lost.
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      phases.closeMs = elapsed();
      stderr += `\nCLI_PROCESS_RESULT ${JSON.stringify({
        code, signal, timedOut, phases, requests: mp.requests.slice(requestOffset),
      })}`;
      resolve({ code: code ?? -1, signal, stdout, stderr, timedOut, closed: true, durationMs: elapsed() });
    });
  });
}

let mp: MockMarketplace;
let testHome: string;

before(async () => {
  mp = await startMockMarketplace();
});

after(async () => {
  await mp.close();
});

afterEach(async () => {
  if (testHome) await fs.rm(testHome, { recursive: true, force: true });
});

describe('atomic install subprocess lifecycle', () => {
  it('waits for descendant pipe EOF after the immediate child exits', async () => {
    const r = await runCli(['-e', `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', "setTimeout(() => process.stdout.write('late output'), 100)"],
        { stdio: ['ignore', 1, 2] }).unref();
      process.exit(0);
    `], {}, { executable: process.execPath });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'late output');
    assert.equal(r.closed, true);
    assert.equal(r.timedOut, false);
  });

  it('escalates a SIGTERM-resistant owned child and preserves the raw close signal', async () => {
    const r = await runCli(['-e', `
      process.on('SIGTERM', () => {});
      process.stdout.write('ready');
      setInterval(() => {}, 100);
    `], {}, { executable: process.execPath, timeoutMs: 3_000, killGraceMs: 100 });
    assert.equal(r.stdout, 'ready');
    assert.equal(r.timedOut, true);
    assert.equal(r.closed, true);
    assert.equal(r.signal, 'SIGKILL', r.stderr);
    assert.match(r.stderr, /"escalationMs":/);
    assert.match(r.stderr, /"closeMs":/);
  });

  it('settles a spawn failure on close with diagnostic evidence', async () => {
    const r = await runCli([], {}, { executable: join(tmpdir(), 'absent-atomic-cli', 'bin') });
    assert.notEqual(r.code, 0);
    assert.equal(r.signal, null);
    assert.equal(r.timedOut, false);
    assert.equal(r.closed, true);
    assert.match(r.stderr, /ENOENT/);
    assert.match(r.stderr, /CLI_PROCESS_RESULT/);
  });
});

describe('papercusp install — atomic staging', () => {
  it('happy path: downloads + extracts + manifest validated → install dir contains manifest', async () => {
    testHome = await fs.mkdtemp(join(tmpdir(), 'install-atomic-home-'));
    const slug = 'mp-happy';
    const version = '0.1.0';
    const tarball = await buildFakeTarball({ name: slug, version, capabilities: ['tasks:read'] });

    mp.setHandler(`/catalog/${encodeURIComponent(slug)}`, (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ versions: [version], kind: 'plugin', latest: { kind: 'plugin', capabilities: ['tasks:read'] } }));
    });
    mp.setHandler(`/download/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`, (_req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(tarball);
    });

    const r = await runCli(['install', slug], {
      PAPERCUSP_HOME: testHome,
      PAPERCUSP_MARKETPLACE_URL: mp.url,
      PAPERCUSP_ACCEPT_CAPABILITIES: '1',
    });
    assert.equal(r.code, 0, `install failed:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.closed, true);
    assert.equal(r.signal, null);
    assert.equal(r.timedOut, false);
    const receipt = JSON.parse(r.stderr.split('CLI_PROCESS_RESULT ').at(-1)!);
    assert.equal(receipt.requests.length, 2, r.stderr);
    assert.deepEqual(receipt.requests.map((request: { status: number }) => request.status), [200, 200]);
    assert.ok(receipt.phases.closeMs >= receipt.phases.exitMs, r.stderr);

    const installDir = join(testHome, 'global-plugins', slug);
    const manifestPath = join(installDir, 'papercusp.json');
    assert.ok(existsSync(manifestPath), `expected manifest at ${manifestPath}`);
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.equal(m.name, slug);
    assert.equal(m.version, version);
    await fs.rm(testHome, { recursive: true, force: true });
  });

  it('failed download (HTTP 503) preserves the existing install — staging is cleaned up', async () => {
    testHome = await fs.mkdtemp(join(tmpdir(), 'install-atomic-home-'));
    const slug = 'mp-preserve';

    // Seed a working v0.1.0 install via the happy path first.
    const v1 = await buildFakeTarball({ name: slug, version: '0.1.0', capabilities: ['tasks:read'] });
    mp.setHandler(`/catalog/${encodeURIComponent(slug)}`, (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ versions: ['0.1.0'], kind: 'plugin', latest: { kind: 'plugin', capabilities: ['tasks:read'] } }));
    });
    mp.setHandler(`/download/${encodeURIComponent(slug)}/0.1.0`, (_req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(v1);
    });
    const r1 = await runCli(['install', slug], { PAPERCUSP_HOME: testHome, PAPERCUSP_MARKETPLACE_URL: mp.url, PAPERCUSP_ACCEPT_CAPABILITIES: '1' });
    assert.equal(r1.code, 0, `seed install failed: ${r1.stderr}`);

    const installDir = join(testHome, 'global-plugins', slug);
    const v1Manifest = JSON.parse(await fs.readFile(join(installDir, 'papercusp.json'), 'utf8'));
    assert.equal(v1Manifest.version, '0.1.0');

    // Now try to install v0.2.0 but make the download 503.
    mp.setHandler(`/catalog/${encodeURIComponent(slug)}`, (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ versions: ['0.2.0', '0.1.0'], kind: 'plugin', latest: { kind: 'plugin', capabilities: ['tasks:read'] } }));
    });
    mp.setHandler(`/download/${encodeURIComponent(slug)}/0.2.0`, (_req, res) => {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'service unavailable' }));
    });

    const r2 = await runCli(['install', `${slug}@0.2.0`], { PAPERCUSP_HOME: testHome, PAPERCUSP_MARKETPLACE_URL: mp.url, PAPERCUSP_ACCEPT_CAPABILITIES: '1' });
    assert.notEqual(r2.code, 0, 'expected install to fail on 503');

    // Atomic-staging contract: the v0.1.0 install survives the failed
    // attempt. (Pre-PR-#6 behavior: install dir wiped before download
    // started, then user left with nothing.)
    assert.ok(existsSync(join(installDir, 'papercusp.json')), 'v0.1.0 manifest must still exist after failed v0.2.0 install');
    const surviving = JSON.parse(await fs.readFile(join(installDir, 'papercusp.json'), 'utf8'));
    assert.equal(surviving.version, '0.1.0', 'surviving install must still be v0.1.0 — atomic install never overwrote it');

    // No staging dir should remain (finally-clause cleanup).
    const globalPlugins = join(testHome, 'global-plugins');
    const entries = await fs.readdir(globalPlugins);
    const staged = entries.filter((e) => e.startsWith(`.${slug}-staging-`));
    assert.equal(staged.length, 0, `staging dirs should be cleaned up; found: ${staged.join(', ')}`);

    await fs.rm(testHome, { recursive: true, force: true });
  });

  it('bad-manifest tarball is rejected before swap → existing install preserved', async () => {
    testHome = await fs.mkdtemp(join(tmpdir(), 'install-atomic-home-'));
    const slug = 'mp-badmanifest';

    // Seed v0.1.0
    const v1 = await buildFakeTarball({ name: slug, version: '0.1.0', capabilities: [] });
    mp.setHandler(`/catalog/${encodeURIComponent(slug)}`, (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ versions: ['0.1.0'], kind: 'plugin', latest: { kind: 'plugin' } }));
    });
    mp.setHandler(`/download/${encodeURIComponent(slug)}/0.1.0`, (_req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(v1);
    });
    const r1 = await runCli(['install', slug], { PAPERCUSP_HOME: testHome, PAPERCUSP_MARKETPLACE_URL: mp.url, PAPERCUSP_ACCEPT_CAPABILITIES: '1' });
    assert.equal(r1.code, 0, `seed install failed: ${r1.stderr}`);

    // v0.2.0 tarball has a manifest with the WRONG slug — manifest validation should reject it.
    const v2Wrong = await buildFakeTarball({ name: 'wrong-slug-not-mp-badmanifest', version: '0.2.0' });
    mp.setHandler(`/catalog/${encodeURIComponent(slug)}`, (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ versions: ['0.2.0', '0.1.0'], kind: 'plugin', latest: { kind: 'plugin' } }));
    });
    mp.setHandler(`/download/${encodeURIComponent(slug)}/0.2.0`, (_req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(v2Wrong);
    });

    const r2 = await runCli(['install', `${slug}@0.2.0`], { PAPERCUSP_HOME: testHome, PAPERCUSP_MARKETPLACE_URL: mp.url, PAPERCUSP_ACCEPT_CAPABILITIES: '1' });
    assert.notEqual(r2.code, 0, 'expected install to fail on manifest mismatch');

    // v0.1.0 must survive — manifest validation should have happened in the
    // staging dir before any rename.
    const installDir = join(testHome, 'global-plugins', slug);
    const surviving = JSON.parse(await fs.readFile(join(installDir, 'papercusp.json'), 'utf8'));
    assert.equal(surviving.version, '0.1.0');
    assert.equal(surviving.name, slug);

    await fs.rm(testHome, { recursive: true, force: true });
  });
});
