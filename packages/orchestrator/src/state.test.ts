import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readFeatures,
  featuresExist,
  featureAttempts,
  setFeatureStatus,
  harnessSlug,
  passedFraction,
} from './state.js';

function withFeaturesJson(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-orch-state-'));
  if (content !== undefined) {
    writeFileSync(join(dir, 'features.json'), JSON.stringify(content));
  }
  return dir;
}

test('readFeatures — missing file returns []', () => {
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-orch-state-empty-'));
  try {
    assert.deepEqual(readFeatures(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readFeatures — handles object form { features: [...] }', () => {
  const dir = withFeaturesJson({
    features: [{ id: 'F-001', status: 'passed' }],
  });
  try {
    const out = readFeatures(dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'F-001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readFeatures — handles bare array (legacy form)', () => {
  const dir = withFeaturesJson([{ id: 'F-001', status: 'pending' }]);
  try {
    assert.equal(readFeatures(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('featuresExist — false when empty, true otherwise', () => {
  const empty = withFeaturesJson({ features: [] });
  const populated = withFeaturesJson({ features: [{ id: 'F-001', status: 'pending' }] });
  try {
    assert.equal(featuresExist(empty), false);
    assert.equal(featuresExist(populated), true);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(populated, { recursive: true, force: true });
  }
});

test('featureAttempts — returns 0 for unknown feature', () => {
  const dir = withFeaturesJson({ features: [{ id: 'F-001', status: 'pending', attempts: 3 }] });
  try {
    assert.equal(featureAttempts(dir, 'F-001'), 3);
    assert.equal(featureAttempts(dir, 'F-999'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setFeatureStatus — preserves object-form on disk', () => {
  const dir = withFeaturesJson({
    schemaVersion: 1,
    features: [{ id: 'F-001', status: 'pending' }],
  });
  try {
    setFeatureStatus(dir, 'F-001', 'passed');
    const raw = JSON.parse(readFileSync(join(dir, 'features.json'), 'utf8'));
    assert.equal(raw.schemaVersion, 1, 'top-level keys preserved');
    assert.equal(raw.features[0].status, 'passed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setFeatureStatus — bumps attempts when requested', () => {
  const dir = withFeaturesJson({
    features: [{ id: 'F-001', status: 'pending', attempts: 2 }],
  });
  try {
    setFeatureStatus(dir, 'F-001', 'in_progress', { bumpAttempts: true });
    assert.equal(featureAttempts(dir, 'F-001'), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setFeatureStatus — resetAttempts forces attempts back to 0', () => {
  const dir = withFeaturesJson({
    features: [{ id: 'F-001', status: 'failed', attempts: 5 }],
  });
  try {
    setFeatureStatus(dir, 'F-001', 'todo', { resetAttempts: true });
    assert.equal(featureAttempts(dir, 'F-001'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setFeatureStatus — silently no-ops on unknown id (matches bash)', () => {
  const dir = withFeaturesJson({ features: [{ id: 'F-001', status: 'pending' }] });
  try {
    const before = readFeatures(dir);
    setFeatureStatus(dir, 'F-NOPE', 'passed');
    const after = readFeatures(dir);
    assert.deepEqual(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('harnessSlug — basename of project dir', () => {
  assert.equal(harnessSlug('/tmp/abc/sheets-clone'), 'sheets-clone');
  assert.equal(harnessSlug('/tmp/abc/sheets-clone/'), 'sheets-clone');
});

test('passedFraction — 0 when no features', () => {
  assert.equal(passedFraction([]), 0);
});

test('passedFraction — counts only "passed"', () => {
  const f = [
    { id: 'a', status: 'passed' as const },
    { id: 'b', status: 'failed' as const },
    { id: 'c', status: 'passed' as const },
    { id: 'd', status: 'pending' as const },
  ];
  assert.equal(passedFraction(f), 2 / 4);
});
