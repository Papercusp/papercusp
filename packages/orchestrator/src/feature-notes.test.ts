import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeFeatureNote } from './feature-notes';

function mockPg(rows: unknown[] = []) {
  const fn = ((_tpl: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.resolve(rows)) as unknown as Parameters<typeof materializeFeatureNote>[0]['pg'];
  return fn;
}

function failingPg() {
  return ((_tpl: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.reject(new Error('pg blew up'))) as unknown as Parameters<typeof materializeFeatureNote>[0]['pg'];
}

test('materializeFeatureNote — without pg returns written:false, no I/O', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fnotes-'));
  try {
    const r = await materializeFeatureNote({
      harnessSlug: 'sheets', featureId: 'F-001', stateDir: dir,
    });
    assert.equal(r.written, false);
    assert.equal(r.path, join(dir, 'notes', 'F-001.md'));
    assert.equal(existsSync(r.path), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('materializeFeatureNote — empty content returns written:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fnotes-'));
  try {
    const pg = mockPg([{ content: '' }]);
    const r = await materializeFeatureNote({
      pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-001', stateDir: dir,
    });
    assert.equal(r.written, false);
    assert.equal(existsSync(r.path), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('materializeFeatureNote — writes file when PG row has content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fnotes-'));
  try {
    const pg = mockPg([{ content: '## user 2026-05-09T00:00:00Z\n\nUse bcrypt cost=12.\n' }]);
    const r = await materializeFeatureNote({
      pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-AUTH-001', stateDir: dir,
    });
    assert.equal(r.written, true);
    assert.equal(r.path, join(dir, 'notes', 'F-AUTH-001.md'));
    const got = readFileSync(r.path, 'utf8');
    assert.match(got, /Use bcrypt cost=12/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('materializeFeatureNote — pg query throws → written:false (no rethrow)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fnotes-'));
  try {
    const r = await materializeFeatureNote({
      pg: failingPg(), workspaceId: 'default',
      harnessSlug: 'sheets', featureId: 'F-001', stateDir: dir,
    });
    assert.equal(r.written, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('materializeFeatureNote — creates notes/ subdirectory if absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fnotes-'));
  try {
    assert.equal(existsSync(join(dir, 'notes')), false);
    const pg = mockPg([{ content: 'x' }]);
    const r = await materializeFeatureNote({
      pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-001', stateDir: dir,
    });
    assert.equal(r.written, true);
    assert.equal(existsSync(join(dir, 'notes')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
