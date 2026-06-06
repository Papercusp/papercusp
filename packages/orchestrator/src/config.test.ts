import { test } from 'vitest';
import assert from 'node:assert/strict';
import { configGet, resolvePhase } from './config.js';

// readConfig() was removed (deprecate-harness-config-json-2026-06-06): .papercusp/
// config.json is no longer a runtime config source. configGet/resolvePhase operate
// on the in-memory effective config (blueprint ⊕ workspace-PG instance) instead.

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
