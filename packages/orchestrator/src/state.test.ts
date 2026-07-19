import { test, describe, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { seedMemoryStore, _resetMemoryStateForTests } from './state-memory.js';

// Hermetic env: harnessSlug falls back to process.env.HARNESS_SLUG /
// process.env.PAPERCUSP_HARNESS_SLUG when not found in the registry. On the
// shared dev box, these env vars are set by the live operator session, causing
// the test to see live values instead of the expected basename. Snapshot +
// clear them per-test so the suite measures the committed defaults; tests that
// need them set their own values.
// (EI-964 env isolation.)
const SLUG_ENV_KEYS = ['HARNESS_SLUG', 'PAPERCUSP_HARNESS_SLUG'] as const;
const _slugEnvSnapshot: Partial<Record<(typeof SLUG_ENV_KEYS)[number], string | undefined>> = {};
beforeEach(() => {
  _resetMemoryStateForTests();
  for (const k of SLUG_ENV_KEYS) {
    _slugEnvSnapshot[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of SLUG_ENV_KEYS) {
    const prev = _slugEnvSnapshot[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
});

// ── In-memory backend (no PG context) ────────────────────────────────

describe('state — in-memory backend', () => {
  test('readFeatures — empty store returns []', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-mem-'));
    try {
      const ctx = stateCtx({ stateDir: dir });
      assert.deepEqual(await readFeatures(dir, ctx), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readFeatures — returns seeded features', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-mem-'));
    try {
      seedMemoryStore(dir, [
        { id: 'F-001', title: 'one', status: 'passed', attempts: 0 },
        { id: 'F-002', title: 'two', status: 'todo', attempts: 1 },
      ]);
      const ctx = stateCtx({ stateDir: dir });
      const out = await readFeatures(dir, ctx);
      assert.equal(out.length, 2);
      assert.equal(out[0].id, 'F-001');
      assert.equal(out[1].attempts, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('featuresExist — false when empty, true after seed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-mem-'));
    try {
      const ctx = stateCtx({ stateDir: dir });
      assert.equal(await featuresExist(dir, ctx), false);
      seedMemoryStore(dir, [{ id: 'F-001', title: '', status: 'todo', attempts: 0 }]);
      assert.equal(await featuresExist(dir, ctx), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('featureAttempts — returns 0 for unknown id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-mem-'));
    try {
      const ctx = stateCtx({ stateDir: dir });
      seedMemoryStore(dir, [{ id: 'F-001', title: '', status: 'todo', attempts: 7 }]);
      assert.equal(await featureAttempts(dir, 'F-001', ctx), 7);
      assert.equal(await featureAttempts(dir, 'F-999', ctx), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('setFeatureStatus — updates status, returns new list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-mem-'));
    try {
      const ctx = stateCtx({ stateDir: dir });
      seedMemoryStore(dir, [{ id: 'F-001', title: '', status: 'todo', attempts: 1 }]);
      const out = await setFeatureStatus(dir, 'F-001', 'passed', { ctx });
      assert.equal(out[0].status, 'passed');
      assert.equal(out[0].attempts, 1);
      // Re-read confirms the store was updated, not just the return value.
      const fresh = await readFeatures(dir, ctx);
      assert.equal(fresh[0].status, 'passed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('setFeatureStatus — bumpAttempts increments, resetAttempts zeroes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-mem-'));
    try {
      const ctx = stateCtx({ stateDir: dir });
      seedMemoryStore(dir, [{ id: 'F-001', title: '', status: 'todo', attempts: 2 }]);
      let out = await setFeatureStatus(dir, 'F-001', 'in_progress', { ctx, bumpAttempts: true });
      assert.equal(out[0].attempts, 3);
      out = await setFeatureStatus(dir, 'F-001', 'todo', { ctx, resetAttempts: true });
      assert.equal(out[0].attempts, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('setFeatureStatus — silently no-ops on unknown id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-mem-'));
    try {
      const ctx = stateCtx({ stateDir: dir });
      seedMemoryStore(dir, [{ id: 'F-001', title: '', status: 'todo', attempts: 1 }]);
      const before = await readFeatures(dir, ctx);
      await setFeatureStatus(dir, 'F-NOPE', 'passed', { ctx });
      const after = await readFeatures(dir, ctx);
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

describe('harnessSlug — non-blocking registry warm (audit P-038 / EI-113)', () => {
  test('cold call answers basename immediately; the registry hit corrects later calls', async () => {
    const origBase = process.env.PAPERCUSP_OPERATOR_BASE;
    const origSlugEnv = process.env.HARNESS_SLUG;
    const origSlugEnv2 = process.env.PAPERCUSP_HARNESS_SLUG;
    const origFetch = globalThis.fetch;
    delete process.env.PAPERCUSP_OPERATOR_BASE;
    delete process.env.HARNESS_SLUG;
    delete process.env.PAPERCUSP_HARNESS_SLUG;
    const urls: string[] = [];
    let resolveFetch!: (r: unknown) => void;
    globalThis.fetch = ((url: unknown) => {
      urls.push(String(url));
      return new Promise((res) => {
        resolveFetch = res;
      });
    }) as typeof fetch;
    try {
      const dir = '/tmp/p038/widgets-clone';
      // Must answer NOW — the old execFileSync(curl) blocked the event loop
      // here for up to 4s while the fetch was in flight.
      assert.equal(harnessSlug(dir), 'widgets-clone');
      assert.equal(urls.length, 1);
      // EI-113: the operator API serves :3070 (:3055 is the Vite content port).
      assert.match(urls[0], /localhost:3070\/api\/harness\/projects$/);
      resolveFetch({
        ok: true,
        json: async () => ({ projects: [{ slug: 'widgets', path: dir }] }),
      });
      await new Promise((r) => setTimeout(r, 0));
      // The background warm corrected the cache for later calls.
      assert.equal(harnessSlug(dir), 'widgets');
    } finally {
      globalThis.fetch = origFetch;
      if (origBase === undefined) delete process.env.PAPERCUSP_OPERATOR_BASE;
      else process.env.PAPERCUSP_OPERATOR_BASE = origBase;
      if (origSlugEnv === undefined) delete process.env.HARNESS_SLUG;
      else process.env.HARNESS_SLUG = origSlugEnv;
      if (origSlugEnv2 === undefined) delete process.env.PAPERCUSP_HARNESS_SLUG;
      else process.env.PAPERCUSP_HARNESS_SLUG = origSlugEnv2;
    }
  });
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

// ── stateCtx dispatcher ──────────────────────────────────────────────

describe('stateCtx — backend selection', () => {
  test('returns memory ctx when pg or workspaceId missing', () => {
    const c1 = stateCtx({ stateDir: '/x' });
    assert.equal((c1 as { kind?: string }).kind, 'memory');
    const c2 = stateCtx({ stateDir: '/x', pg: (() => Promise.resolve([])) as never });
    assert.equal((c2 as { kind?: string }).kind, 'memory');
    const c3 = stateCtx({ stateDir: '/x', workspaceId: 'default' });
    assert.equal((c3 as { kind?: string }).kind, 'memory');
  });

  test('returns PG ctx when pg AND workspaceId both set', () => {
    const c = stateCtx({
      stateDir: '/x',
      pg: (() => Promise.resolve([])) as never,
      workspaceId: 'default',
    });
    assert.equal((c as { pg?: unknown }).pg !== undefined, true);
    assert.equal((c as { workspaceId?: string }).workspaceId, 'default');
  });

  test('derives harness slug from projectDir when not explicitly set', () => {
    const c = stateCtx({
      stateDir: '/x',
      pg: (() => Promise.resolve([])) as never,
      workspaceId: 'default',
      projectDir: '/home/me/sheets-clone',
    });
    assert.equal((c as { harnessSlug?: string }).harnessSlug, 'sheets-clone');
  });
});

// ── PG path (mock) ───────────────────────────────────────────────────

describe('state — PG path (mocked)', () => {
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
        if (/to_regclass/.test(sql)) return [{ t: 'harness_sheets.harness_features' }]; // EI-13935 topology probe: pretend a real per-harness schema exists (the common case)
        if (/EXISTS/.test(sql)) return [{ exists: rows.length > 0 }];
        if (/SELECT attempts/.test(sql)) {
          const id = vals[1];
          const f = rows.find((r) => r.feature_id === id);
          return f ? [{ attempts: f.attempts ?? 0 }] : [];
        }
        if (/UPDATE/.test(sql)) return [];
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
    // projectDir supplies the harness slug — a slug-less ctx now fails empty
    // by design (audit P-018) instead of joining on ''.
    const ctx = stateCtx({ stateDir: '/x', pg, workspaceId: 'default', projectDir: '/x/sheets' });
    const out = await readFeatures('/x', ctx);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'F-001');
    assert.equal(out[1].attempts, 1);
  });

  test('featuresExist — uses pg path when ctx provided', async () => {
    const empty = makeMockPg([]);
    const populated = makeMockPg([{ feature_id: 'F-001', title: '', status: 'todo', attempts: 0 }]);
    assert.equal(await featuresExist('/x', stateCtx({ stateDir: '/x', pg: empty.pg, workspaceId: 'default' })), false);
    assert.equal(await featuresExist('/x', stateCtx({ stateDir: '/x', pg: populated.pg, workspaceId: 'default' })), true);
  });

  test('featureAttempts — uses pg path when ctx provided', async () => {
    const { pg } = makeMockPg([{ feature_id: 'F-001', title: '', status: 'todo', attempts: 7 }]);
    const ctx = stateCtx({ stateDir: '/x', pg, workspaceId: 'default' });
    assert.equal(await featureAttempts('/x', 'F-001', ctx), 7);
    assert.equal(await featureAttempts('/x', 'F-999', ctx), 0);
  });

  test('setFeatureStatus — issues UPDATE then re-reads', async () => {
    const mock = makeMockPg([{ feature_id: 'F-001', title: '', status: 'in_progress', attempts: 1 }]);
    // projectDir supplies the harness slug (audit P-018 — see readFeatures above).
    const ctx = stateCtx({ stateDir: '/x', pg: mock.pg, workspaceId: 'default', projectDir: '/x/sheets' });
    await setFeatureStatus('/x', 'F-001', 'passed', { ctx });
    // First query is the UPDATE, second is the readFeaturesPg SELECT.
    assert.match(mock.queries[0], /UPDATE/);
    assert.match(mock.queries[1], /SELECT/);
  });
});
