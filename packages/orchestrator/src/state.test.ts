import { test, describe } from 'vitest';
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
  stateCtx,
} from './state.js';

function withFeaturesJson(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-orch-state-'));
  if (content !== undefined) {
    writeFileSync(join(dir, 'features.json'), JSON.stringify(content));
  }
  return dir;
}

// ── FS fallback path (no pg context) ─────────────────────────────────

describe('state — filesystem fallback (no pg context)', () => {
  test('readFeatures — missing file returns []', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-orch-state-empty-'));
    try {
      assert.deepEqual(await readFeatures(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readFeatures — handles object form { features: [...] }', async () => {
    const dir = withFeaturesJson({
      features: [{ id: 'F-001', status: 'passed' }],
    });
    try {
      const out = await readFeatures(dir);
      assert.equal(out.length, 1);
      assert.equal(out[0].id, 'F-001');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readFeatures — handles bare array (legacy form)', async () => {
    const dir = withFeaturesJson([{ id: 'F-001', status: 'pending' }]);
    try {
      const out = await readFeatures(dir);
      assert.equal(out.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('featuresExist — false when empty, true otherwise', async () => {
    const empty = withFeaturesJson({ features: [] });
    const populated = withFeaturesJson({ features: [{ id: 'F-001', status: 'pending' }] });
    try {
      assert.equal(await featuresExist(empty), false);
      assert.equal(await featuresExist(populated), true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(populated, { recursive: true, force: true });
    }
  });

  test('featureAttempts — returns 0 for unknown feature', async () => {
    const dir = withFeaturesJson({ features: [{ id: 'F-001', status: 'pending', attempts: 3 }] });
    try {
      assert.equal(await featureAttempts(dir, 'F-001'), 3);
      assert.equal(await featureAttempts(dir, 'F-999'), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('setFeatureStatus — preserves object-form on disk', async () => {
    const dir = withFeaturesJson({
      schemaVersion: 1,
      features: [{ id: 'F-001', status: 'pending' }],
    });
    try {
      await setFeatureStatus(dir, 'F-001', 'passed');
      const raw = JSON.parse(readFileSync(join(dir, 'features.json'), 'utf8'));
      assert.equal(raw.schemaVersion, 1, 'top-level keys preserved');
      assert.equal(raw.features[0].status, 'passed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('setFeatureStatus — bumps attempts when requested', async () => {
    const dir = withFeaturesJson({
      features: [{ id: 'F-001', status: 'pending', attempts: 2 }],
    });
    try {
      await setFeatureStatus(dir, 'F-001', 'in_progress', { bumpAttempts: true });
      assert.equal(await featureAttempts(dir, 'F-001'), 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('setFeatureStatus — resetAttempts forces attempts back to 0', async () => {
    const dir = withFeaturesJson({
      features: [{ id: 'F-001', status: 'failed', attempts: 5 }],
    });
    try {
      await setFeatureStatus(dir, 'F-001', 'todo', { resetAttempts: true });
      assert.equal(await featureAttempts(dir, 'F-001'), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('setFeatureStatus — silently no-ops on unknown id (matches bash)', async () => {
    const dir = withFeaturesJson({ features: [{ id: 'F-001', status: 'pending' }] });
    try {
      const before = await readFeatures(dir);
      await setFeatureStatus(dir, 'F-NOPE', 'passed');
      const after = await readFeatures(dir);
      assert.deepEqual(after, before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────

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

// ── PG path (mock) ───────────────────────────────────────────────────

describe('state — pg path (mocked)', () => {
  function makeMockPg(rows: Record<string, unknown>[]): {
    pg: (template: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
    queries: string[];
    values: unknown[][];
  } {
    const queries: string[] = [];
    const values: unknown[][] = [];
    return {
      pg: async (template, ...vals) => {
        const sql = template.join('?');
        queries.push(sql);
        values.push(vals);
        if (/EXISTS/.test(sql)) return [{ exists: rows.length > 0 }];
        if (/SELECT attempts/.test(sql)) {
          const id = vals[1];
          const f = rows.find((r) => r.feature_id === id);
          return f ? [{ attempts: f.attempts ?? 0 }] : [];
        }
        if (/UPDATE/.test(sql)) return [];
        // Default: read query
        return rows;
      },
      queries,
      values,
    };
  }

  test('readFeatures — uses pg path when ctx provided', async () => {
    const { pg } = makeMockPg([
      { feature_id: 'F-001', title: 'one', status: 'passed', attempts: 0 },
      { feature_id: 'F-002', title: 'two', status: 'todo', attempts: 1 },
    ]);
    const ctx = stateCtx({ pg, workspaceId: 'default' });
    const out = await readFeatures('/nonexistent-fs', ctx);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'F-001');
    assert.equal(out[1].attempts, 1);
  });

  test('featuresExist — uses pg path when ctx provided', async () => {
    const empty = makeMockPg([]);
    const populated = makeMockPg([{ feature_id: 'F-001', title: '', status: 'todo', attempts: 0 }]);
    assert.equal(await featuresExist('/nonexistent', stateCtx({ pg: empty.pg, workspaceId: 'default' })), false);
    assert.equal(await featuresExist('/nonexistent', stateCtx({ pg: populated.pg, workspaceId: 'default' })), true);
  });

  test('featureAttempts — uses pg path when ctx provided', async () => {
    const { pg } = makeMockPg([{ feature_id: 'F-001', title: '', status: 'todo', attempts: 7 }]);
    const ctx = stateCtx({ pg, workspaceId: 'default' });
    assert.equal(await featureAttempts('/nonexistent', 'F-001', ctx), 7);
    assert.equal(await featureAttempts('/nonexistent', 'F-999', ctx), 0);
  });

  test('setFeatureStatus — issues UPDATE then re-reads', async () => {
    const mock = makeMockPg([{ feature_id: 'F-001', title: '', status: 'in_progress', attempts: 1 }]);
    const ctx = stateCtx({ pg: mock.pg, workspaceId: 'default' });
    await setFeatureStatus('/nonexistent', 'F-001', 'passed', { ctx });
    // First query is the UPDATE, second is the readFeaturesPg SELECT
    assert.match(mock.queries[0], /UPDATE/);
    assert.match(mock.queries[1], /SELECT/);
  });

  test('stateCtx — returns undefined when pg or workspaceId missing', () => {
    assert.equal(stateCtx({}), undefined);
    assert.equal(stateCtx({ pg: (() => Promise.resolve([])) as never }), undefined);
    assert.equal(stateCtx({ workspaceId: 'default' }), undefined);
  });
});
