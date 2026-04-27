import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, configGet, resolvePhase } from './config.js';

function withTempStateDir(cfg: object | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-orch-config-'));
  if (cfg !== null) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
  }
  return dir;
}

test('readConfig — missing file returns {}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-orch-config-empty-'));
  try {
    assert.deepEqual(readConfig(dir), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig — malformed JSON returns {}', () => {
  const dir = withTempStateDir(null);
  writeFileSync(join(dir, 'config.json'), '{not json}');
  try {
    assert.deepEqual(readConfig(dir), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configGet — top-level path with default fallback', () => {
  const cfg = { phase: 'staging' };
  assert.equal(configGet(cfg, 'phase', 'department'), 'staging');
  assert.equal(configGet(cfg, 'missing', 'fallback'), 'fallback');
});

test('configGet — dotted path resolves', () => {
  const cfg = {
    phases: { staging: { port: 3055, dbPath: '/tmp/db' } },
    reviewer: { replanOnAccept: true },
  };
  assert.equal(configGet(cfg, 'phases.staging.port', 0), 3055);
  assert.equal(configGet(cfg, 'reviewer.replanOnAccept', false), true);
});

test('configGet — missing intermediate returns default', () => {
  const cfg = { phases: { staging: {} } };
  assert.equal(configGet(cfg, 'phases.production.port', 9999), 9999);
  assert.equal(configGet(cfg, 'reviewer.missing.deeply', 'fb'), 'fb');
});

test('resolvePhase — defaults to staging when phase missing', () => {
  const out = resolvePhase({});
  assert.equal(out.phase, 'staging');
  assert.equal(out.port, '');
  assert.equal(out.dbPath, '');
});

test('resolvePhase — pulls phase-specific port and dbPath', () => {
  const out = resolvePhase({
    phase: 'department',
    phases: {
      department: { port: 4000, dbPath: '/var/db/dept' },
      staging: { port: 3055 },
    },
  });
  assert.equal(out.phase, 'department');
  assert.equal(out.port, '4000');
  assert.equal(out.dbPath, '/var/db/dept');
});

test('resolvePhase — coerces numeric port to string', () => {
  const out = resolvePhase({
    phase: 'staging',
    phases: { staging: { port: 3055 } },
  });
  assert.equal(out.port, '3055');
});
