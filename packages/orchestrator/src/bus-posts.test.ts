import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { postArchiveEvent, postCuratorOutputs, postTestSnapshot } from './bus-posts';

interface Captured { url: string; bearer: string; body: string }
function capturingServer(captured: Captured[]): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        captured.push({
          url: req.url ?? '',
          bearer: (req.headers.authorization ?? '').replace(/^Bearer\s+/, ''),
          body,
        });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function tempState(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'bus-posts-test-'));
  const stateDir = join(root, '.harness');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ harness_token: 'tok-xyz' }));
  return { dir: stateDir, cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

test('postArchiveEvent — no-op when archive missing', async () => {
  const { dir, cleanup } = tempState();
  try {
    const ok = await postArchiveEvent({ stateDir: dir, archivePath: '/nonexistent/path.tgz' });
    assert.equal(ok, false);
  } finally { cleanup(); }
});

test('postArchiveEvent — no-op when token missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bus-posts-test-'));
  try {
    const stateDir = join(root, '.harness');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'config.json'), '{}');
    const archive = join(root, 'a.tgz');
    writeFileSync(archive, 'x');
    const ok = await postArchiveEvent({ stateDir, archivePath: archive });
    assert.equal(ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('postArchiveEvent — POSTs id/sizeBytes/ts/phase with bearer', async () => {
  const captured: Captured[] = [];
  const srv = await capturingServer(captured);
  const port = (srv.address() as { port: number }).port;
  const prevBase = process.env.PAPERCUSP_OPERATOR_BASE;
  process.env.PAPERCUSP_OPERATOR_BASE = `http://127.0.0.1:${port}`;
  const { dir, cleanup } = tempState();
  try {
    const archive = join(dir, '..', 'snap.tgz');
    writeFileSync(archive, 'hello-world');
    const ok = await postArchiveEvent({ stateDir: dir, archivePath: archive, phase: 'production' });
    assert.equal(ok, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, '/api/internal/archive-event');
    assert.equal(captured[0].bearer, 'tok-xyz');
    const body = JSON.parse(captured[0].body) as { id: string; sizeBytes: number; phase: string; ts: number };
    assert.equal(body.id, 'snap.tgz');
    assert.equal(body.sizeBytes, 11);
    assert.equal(body.phase, 'production');
    assert.ok(typeof body.ts === 'number' && body.ts > 0);
  } finally {
    cleanup();
    if (prevBase === undefined) delete process.env.PAPERCUSP_OPERATOR_BASE; else process.env.PAPERCUSP_OPERATOR_BASE = prevBase;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test('postCuratorOutputs — POSTs identity + skill snapshots', async () => {
  const captured: Captured[] = [];
  const srv = await capturingServer(captured);
  const port = (srv.address() as { port: number }).port;
  const prevBase = process.env.PAPERCUSP_OPERATOR_BASE;
  process.env.PAPERCUSP_OPERATOR_BASE = `http://127.0.0.1:${port}`;

  const root = mkdtempSync(join(tmpdir(), 'bus-posts-test-'));
  try {
    const stateDir = join(root, '.harness');
    const harnessDir = join(root, 'harness');
    mkdirSync(join(harnessDir, 'identity'), { recursive: true });
    mkdirSync(join(stateDir, 'skills'), { recursive: true });
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ harness_token: 'tok-xyz' }));
    writeFileSync(join(harnessDir, 'identity', 'worker.md'), '# worker identity');
    writeFileSync(join(harnessDir, 'identity', 'validator.md'), '# validator identity');
    writeFileSync(join(stateDir, 'skills', 'fix.md'), '# fix skill');

    const result = await postCuratorOutputs({ stateDir, harnessDir });
    assert.equal(result.identity, true);
    assert.equal(result.skills, true);

    const idHit = captured.find((c) => c.url === '/api/internal/identity-snapshot');
    assert.ok(idHit, 'identity-snapshot was posted');
    const idBody = JSON.parse(idHit!.body) as { files: Array<{ role: string; content: string }> };
    assert.deepEqual(idBody.files.map((f) => f.role).sort(), ['validator', 'worker']);

    const skHit = captured.find((c) => c.url === '/api/internal/skill-snapshot');
    assert.ok(skHit, 'skill-snapshot was posted');
    const skBody = JSON.parse(skHit!.body) as { files: Array<{ name: string; content: string }> };
    assert.deepEqual(skBody.files.map((f) => f.name), ['fix.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (prevBase === undefined) delete process.env.PAPERCUSP_OPERATOR_BASE; else process.env.PAPERCUSP_OPERATOR_BASE = prevBase;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test('postCuratorOutputs — clears skills with empty list when dir missing', async () => {
  const captured: Captured[] = [];
  const srv = await capturingServer(captured);
  const port = (srv.address() as { port: number }).port;
  const prevBase = process.env.PAPERCUSP_OPERATOR_BASE;
  process.env.PAPERCUSP_OPERATOR_BASE = `http://127.0.0.1:${port}`;

  const root = mkdtempSync(join(tmpdir(), 'bus-posts-test-'));
  try {
    const stateDir = join(root, '.harness');
    const harnessDir = join(root, 'harness');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ harness_token: 'tok-xyz' }));

    await postCuratorOutputs({ stateDir, harnessDir });
    const skHit = captured.find((c) => c.url === '/api/internal/skill-snapshot');
    assert.ok(skHit);
    assert.equal((JSON.parse(skHit!.body) as { files: unknown[] }).files.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (prevBase === undefined) delete process.env.PAPERCUSP_OPERATOR_BASE; else process.env.PAPERCUSP_OPERATOR_BASE = prevBase;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test('postTestSnapshot — no-op when no tests dir', async () => {
  const { dir, cleanup } = tempState();
  try {
    const ok = await postTestSnapshot({ stateDir: dir });
    assert.equal(ok, false);
  } finally { cleanup(); }
});

test('postTestSnapshot — POSTs parsed test JSON files with phase', async () => {
  const captured: Captured[] = [];
  const srv = await capturingServer(captured);
  const port = (srv.address() as { port: number }).port;
  const prevBase = process.env.PAPERCUSP_OPERATOR_BASE;
  process.env.PAPERCUSP_OPERATOR_BASE = `http://127.0.0.1:${port}`;

  const { dir, cleanup } = tempState();
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'auth.json'), JSON.stringify({ pass: true, ms: 12 }));
    writeFileSync(join(dir, 'tests', 'pay.json'), JSON.stringify({ pass: false, error: 'boom' }));
    writeFileSync(join(dir, 'tests', 'ignore.txt'), 'not json'); // skipped
    writeFileSync(join(dir, 'tests', 'malformed.json'), 'not-json'); // skipped
    const ok = await postTestSnapshot({ stateDir: dir, phase: 'testing' });
    assert.equal(ok, true);
    assert.equal(captured.length, 1);
    const body = JSON.parse(captured[0].body) as {
      files: Array<{ testId: string; payload: { pass: boolean } }>;
      phase: string;
    };
    assert.equal(body.phase, 'testing');
    assert.deepEqual(body.files.map((f) => f.testId).sort(), ['auth', 'pay']);
    assert.equal(body.files.find((f) => f.testId === 'auth')?.payload.pass, true);
  } finally {
    cleanup();
    if (prevBase === undefined) delete process.env.PAPERCUSP_OPERATOR_BASE; else process.env.PAPERCUSP_OPERATOR_BASE = prevBase;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});
