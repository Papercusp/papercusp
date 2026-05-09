import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDebuggerOutput, materializeFeatureDebugNote } from './feature-debug-notes';

function capturingPg() {
  const calls: Array<{ values: unknown[] }> = [];
  const fn = ((_tpl: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ values });
    return Promise.resolve([]);
  }) as unknown as Parameters<typeof captureDebuggerOutput>[0]['pg'];
  return { pg: fn, calls };
}

function readingPg(rows: unknown[]) {
  return ((_tpl: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.resolve(rows)) as unknown as Parameters<typeof materializeFeatureDebugNote>[0]['pg'];
}

function failingPg() {
  return ((_tpl: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.reject(new Error('pg blew up'))) as unknown as Parameters<typeof captureDebuggerOutput>[0]['pg'];
}

// ── captureDebuggerOutput ──

test('captureDebuggerOutput — no pg → captured:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fdbg-'));
  try {
    const r = await captureDebuggerOutput({
      harnessSlug: 'sheets', featureId: 'F-001', stateDir: dir,
    });
    assert.equal(r.captured, false);
    assert.equal(r.bytes, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('captureDebuggerOutput — file missing → captured:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fdbg-'));
  try {
    const { pg } = capturingPg();
    const r = await captureDebuggerOutput({
      pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-001', stateDir: dir,
    });
    assert.equal(r.captured, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('captureDebuggerOutput — empty file → captured:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fdbg-'));
  try {
    mkdirSync(join(dir, 'debug'), { recursive: true });
    writeFileSync(join(dir, 'debug', 'F-001.md'), '');
    const { pg } = capturingPg();
    const r = await captureDebuggerOutput({
      pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-001', stateDir: dir,
    });
    assert.equal(r.captured, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('captureDebuggerOutput — UPSERT fires with correct args', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fdbg-'));
  try {
    mkdirSync(join(dir, 'debug'), { recursive: true });
    const content = '# Debugger findings\n\nRoot cause: race condition in updateUser.';
    writeFileSync(join(dir, 'debug', 'F-AUTH-005.md'), content);
    const { pg, calls } = capturingPg();
    const r = await captureDebuggerOutput({
      pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-AUTH-005', stateDir: dir,
    });
    assert.equal(r.captured, true);
    assert.equal(r.bytes, content.length);
    assert.equal(calls.length, 1);
    const v = calls[0].values;
    assert.equal(v[0], 'default');
    assert.equal(v[1], 'sheets');
    assert.equal(v[2], 'F-AUTH-005');
    assert.equal(v[3], content);
    assert.ok(typeof v[4] === 'number' && v[4] > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('captureDebuggerOutput — pg failure swallowed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fdbg-'));
  try {
    mkdirSync(join(dir, 'debug'), { recursive: true });
    writeFileSync(join(dir, 'debug', 'F-001.md'), 'content');
    const r = await captureDebuggerOutput({
      pg: failingPg(), workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-001', stateDir: dir,
    });
    assert.equal(r.captured, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── materializeFeatureDebugNote ──

test('materializeFeatureDebugNote — no pg → written:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fdbg-'));
  try {
    const r = await materializeFeatureDebugNote({
      harnessSlug: 'sheets', featureId: 'F-001', stateDir: dir,
    });
    assert.equal(r.written, false);
    assert.equal(existsSync(r.path), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('materializeFeatureDebugNote — empty content → written:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fdbg-'));
  try {
    const r = await materializeFeatureDebugNote({
      pg: readingPg([{ content: '' }]),
      workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-001', stateDir: dir,
    });
    assert.equal(r.written, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('materializeFeatureDebugNote — writes file from PG content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fdbg-'));
  try {
    const r = await materializeFeatureDebugNote({
      pg: readingPg([{ content: '# bug\n\nstack overflow in foo()' }]),
      workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-AUTH-005', stateDir: dir,
    });
    assert.equal(r.written, true);
    assert.equal(r.path, join(dir, 'debug', 'F-AUTH-005.md'));
    const got = readFileSync(r.path, 'utf8');
    assert.match(got, /stack overflow/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('materializeFeatureDebugNote — pg throw → written:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fdbg-'));
  try {
    const r = await materializeFeatureDebugNote({
      pg: failingPg() as unknown as Parameters<typeof materializeFeatureDebugNote>[0]['pg'],
      workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-001', stateDir: dir,
    });
    assert.equal(r.written, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('materializeFeatureDebugNote — creates debug/ dir if absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fdbg-'));
  try {
    assert.equal(existsSync(join(dir, 'debug')), false);
    const r = await materializeFeatureDebugNote({
      pg: readingPg([{ content: 'x' }]),
      workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-001', stateDir: dir,
    });
    assert.equal(r.written, true);
    assert.equal(existsSync(join(dir, 'debug')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
