import { afterEach, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  durableOwnedFeatureIdsPg,
  isAutoPickable,
  readFeaturesPg,
  setFeatureStatusPg,
} from './state-pg';

const FLAG = 'PAPERCUSP_DBOS_ORCHESTRATOR';
type Ctx = Parameters<typeof durableOwnedFeatureIdsPg>[0];

/** Build a fake tagged-template pg that branches on query text. */
function fakePg(handler: (q: string, vals: unknown[]) => unknown[]) {
  const calls: { q: string; vals: unknown[] }[] = [];
  const pg = async (t: TemplateStringsArray, ...vals: unknown[]) => {
    const q = t.join('?');
    calls.push({ q, vals });
    return handler(q, vals);
  };
  return { pg, calls };
}

describe('readFeaturesPg — plan-provenance filter reads the per-schema column', () => {
  const orig = process.env[FLAG];
  afterEach(() => {
    if (orig === undefined) delete process.env[FLAG];
    else process.env[FLAG] = orig;
  });

  // Bug: commit 25308f6 filtered eligible features by `source_plan_slug`, but that
  // column lives ONLY on harness_shared.harness_features_consolidated (migration
  // 084). The per-schema `harness_features` tables store the plan slug in
  // `metadata->>'source_plan'` (084 backfills the consolidated column FROM it), so
  // the query threw `column "source_plan_slug" does not exist` on every harness —
  // breaking the DBOS dispatcher + the chunk-loop worker (both call readFeaturesPg).
  test("filters on metadata->>'source_plan', NOT a non-existent source_plan_slug column", async () => {
    process.env[FLAG] = '0'; // disable the carve-out so only the feature SELECT runs
    const { pg, calls } = fakePg((q) =>
      /FROM harness_features\b/i.test(q) ? [{ feature_id: 'F-1', status: 'todo' }] : [],
    );
    const ctx = { pg, workspaceId: 'w', harnessSlug: 's' } as unknown as Ctx;
    await readFeaturesPg(ctx as unknown as Parameters<typeof readFeaturesPg>[0]);
    const featureQuery = calls.find((c) => /FROM harness_features\b/i.test(c.q));
    assert.ok(featureQuery, 'readFeaturesPg issued a feature SELECT');
    assert.match(featureQuery!.q, /metadata->>'source_plan'/);
    // The column must not appear as a PREDICATE (the bug: `source_plan_slug IS NULL`
    // / `source_plan_slug IN (…)`). A mention in an explanatory SQL comment is fine.
    assert.doesNotMatch(featureQuery!.q, /source_plan_slug\s+(IS|IN)\b/i);
  });

  // Audit P-018: with no harnessSlug the SQL used to join on '' — the
  // started-plan subquery matched nothing, silently dropping every plan-linked
  // feature from the pick gate. The guard fails empty WITHOUT querying.
  test('no harnessSlug → [] and the SQL never runs (audit P-018)', async () => {
    const { pg, calls } = fakePg(() => [{ feature_id: 'F-LEAK' }]);
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const ctx = { pg, workspaceId: 'w' } as unknown as Ctx;
      const rows = await readFeaturesPg(ctx as unknown as Parameters<typeof readFeaturesPg>[0]);
      assert.deepEqual(rows, []);
      assert.equal(calls.length, 0);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('durableOwnedFeatureIdsPg — Phase 3 carve-out (D-012/D-013)', () => {
  const orig = process.env[FLAG];
  afterEach(() => {
    if (orig === undefined) delete process.env[FLAG];
    else process.env[FLAG] = orig;
  });

  test('flag explicitly OFF (=0, the legacy revert) → empty set, never touches pg', async () => {
    process.env[FLAG] = '0';
    const { pg, calls } = fakePg(() => [{ feature_id: 'F-001' }]);
    const ctx = { pg, workspaceId: 'w', harnessSlug: 's' } as unknown as Ctx;
    const owned = await durableOwnedFeatureIdsPg(ctx);
    assert.equal(owned.size, 0);
    assert.equal(calls.length, 0);
  });

  test('flag DEFAULT (unset) → carve-out ACTIVE (P-009: DBOS is the default orchestrator)', async () => {
    delete process.env[FLAG];
    const { pg, calls } = fakePg((q) =>
      q.includes('to_regclass')
        ? [{ t: 'dbos.workflow_status' }]
        : [{ feature_id: 'F-001' }],
    );
    const ctx = { pg, workspaceId: 'w', harnessSlug: 's' } as unknown as Ctx;
    const owned = await durableOwnedFeatureIdsPg(ctx);
    assert.deepEqual([...owned], ['F-001']); // carve-out ran (was empty pre-P-009)
    assert.ok(calls.length >= 1);
  });

  test('flag ON but no harnessSlug → empty, no query', async () => {
    process.env[FLAG] = '1';
    const { pg, calls } = fakePg(() => [{ feature_id: 'F-001' }]);
    const ctx = { pg, workspaceId: 'w' } as unknown as Ctx;
    const owned = await durableOwnedFeatureIdsPg(ctx);
    assert.equal(owned.size, 0);
    assert.equal(calls.length, 0);
  });

  test('flag ON, dbos schema absent (to_regclass NULL) → empty, no workflow query', async () => {
    process.env[FLAG] = '1';
    const { pg, calls } = fakePg((q) =>
      q.includes('to_regclass') ? [{ t: null }] : [{ feature_id: 'LEAK' }],
    );
    const ctx = { pg, workspaceId: 'w', harnessSlug: 's' } as unknown as Ctx;
    const owned = await durableOwnedFeatureIdsPg(ctx);
    assert.equal(owned.size, 0);
    assert.equal(calls.length, 1); // only the regclass probe — never the workflow query
    assert.match(calls[0].q, /to_regclass/);
  });

  test('flag ON, dbos present → deduped set of owned feature ids, slug-scoped LIKE', async () => {
    process.env[FLAG] = '1';
    const { pg, calls } = fakePg((q) =>
      q.includes('to_regclass')
        ? [{ t: 'dbos.workflow_status' }]
        : [{ feature_id: 'F-001' }, { feature_id: 'F-002' }, { feature_id: 'F-001' }],
    );
    const ctx = { pg, workspaceId: 'w', harnessSlug: 'papercup' } as unknown as Ctx;
    const owned = await durableOwnedFeatureIdsPg(ctx);
    assert.deepEqual([...owned].sort(), ['F-001', 'F-002']);
    // the workflow query bound the slug-scoped LIKE prefix as its only value
    const wfCall = calls.find((c) => c.q.includes('workflow_status') && c.q.includes('LIKE'));
    assert.ok(wfCall, 'workflow query issued');
    assert.equal(wfCall.vals[0], 'pipeline:papercup:%');
  });

  test('flag ON, query throws → empty (off-path safety: never breaks the loop)', async () => {
    process.env[FLAG] = '1';
    const { pg } = fakePg((q) => {
      if (q.includes('to_regclass')) return [{ t: 'dbos.workflow_status' }];
      throw new Error('boom');
    });
    const ctx = { pg, workspaceId: 'w', harnessSlug: 's' } as unknown as Ctx;
    const owned = await durableOwnedFeatureIdsPg(ctx);
    assert.equal(owned.size, 0);
  });

  test('empty / whitespace feature ids are dropped', async () => {
    process.env[FLAG] = '1';
    const { pg } = fakePg((q) =>
      q.includes('to_regclass')
        ? [{ t: 'dbos.workflow_status' }]
        : [{ feature_id: '' }, { feature_id: 'F-009' }],
    );
    const ctx = { pg, workspaceId: 'w', harnessSlug: 's' } as unknown as Ctx;
    const owned = await durableOwnedFeatureIdsPg(ctx);
    assert.deepEqual([...owned], ['F-009']);
  });
});

// EI-13935: setFeatureStatusPg's bumpAttempts/resetAttempts UPDATE used the
// unqualified `harness_features` name unconditionally. On a harness with no
// per-harness schema, that name falls through to the cross-harness
// `harness_shared.harness_features` compat view (497) instead of this one
// harness's own row — a real correctness hazard (feature_id is only unique
// PER HARNESS), not the "fails loudly, read-only" outcome its own doc comment
// assumed (migration 109's default privileges actually make it writable).
describe('setFeatureStatusPg — EI-13935 topology-aware attempts write', () => {
  const orig = process.env[FLAG];
  afterEach(() => {
    if (orig === undefined) delete process.env[FLAG];
    else process.env[FLAG] = orig;
  });

  test('per-harness schema present → unqualified UPDATE (existing TOWER-style path, unchanged)', async () => {
    process.env[FLAG] = '0'; // disable the durable-owned carve-out — only the write + readback matter here
    const { pg, calls } = fakePg((q) => (q.includes('to_regclass') ? [{ t: 'harness_s.harness_features' }] : []));
    const ctx = { pg, workspaceId: 'w', harnessSlug: 's' } as unknown as Ctx;
    await setFeatureStatusPg(ctx as unknown as Parameters<typeof setFeatureStatusPg>[0], 'F-1', 'in_progress', {
      bumpAttempts: true,
    });
    const updateCall = calls.find((c) => /UPDATE\s+harness_features\b/i.test(c.q));
    assert.ok(updateCall, 'wrote through the unqualified per-harness name');
    assert.equal(
      calls.find((c) => /UPDATE\s+harness_shared\.work_items\b/i.test(c.q)),
      undefined,
      'did not take the base-table fallback path when a real per-harness schema exists',
    );
  });

  test('no per-harness schema → writes harness_shared.work_items directly, scoped by harness_slug', async () => {
    process.env[FLAG] = '0';
    const { pg, calls } = fakePg((q) => (q.includes('to_regclass') ? [{ t: null }] : []));
    const ctx = { pg, workspaceId: 'w', harnessSlug: 's' } as unknown as Ctx;
    await setFeatureStatusPg(ctx as unknown as Parameters<typeof setFeatureStatusPg>[0], 'F-1', 'in_progress', {
      bumpAttempts: true,
    });
    const updateCall = calls.find((c) => /UPDATE\s+harness_shared\.work_items\b/i.test(c.q));
    assert.ok(updateCall, 'wrote through harness_shared.work_items directly');
    assert.match(updateCall!.q, /harness_slug\s*=\s*\?/);
    assert.ok(updateCall!.vals.includes('s'), 'harness_slug bound as an explicit predicate value');
    assert.equal(
      calls.find((c) => /UPDATE\s+harness_features\b/i.test(c.q)),
      undefined,
      'never fell through to the unqualified name (would hit the unfiltered cross-harness view)',
    );
  });

  test('no harnessSlug on ctx → cannot detect topology, preserves legacy unqualified behavior', async () => {
    process.env[FLAG] = '0';
    const { pg, calls } = fakePg(() => []);
    const ctx = { pg, workspaceId: 'w' } as unknown as Ctx;
    // readFeaturesPg's own no-harnessSlug console.warn (audit P-018, unrelated to
    // this fix) fires on the post-write readback — expected here, so silence it
    // rather than let vitest-fail-on-console flag it.
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      await setFeatureStatusPg(ctx as unknown as Parameters<typeof setFeatureStatusPg>[0], 'F-1', 'in_progress', {
        bumpAttempts: true,
      });
    } finally {
      console.warn = origWarn;
    }
    assert.ok(
      calls.find((c) => /UPDATE\s+harness_features\b/i.test(c.q)),
      'fell back to the unqualified legacy UPDATE',
    );
    assert.equal(
      calls.find((c) => c.q.includes('to_regclass')),
      undefined,
      'never probed topology without a slug to build the schema name from',
    );
  });
});

// The G2 auditor ADMISSION gate (papercusp-user-protection-gate, migrations
// 097/098): a remote-authored feature must be auditor-admitted before the
// orchestrator pick loop may auto-pick it; local features bypass it. This is a
// SECURITY predicate — a wrong `true` lets an unscreened remote feature into the
// loop. (The agent-e2e surfaced the live half of this: a missing `audit_verdict`
// column crashed the JOIN; this pins the pure decision so the gate can't silently
// flip.)
describe('isAutoPickable — auditor admission gate (origin/audit_verdict)', () => {
  test('LOCAL features always bypass the auditor (no verdict needed)', () => {
    assert.equal(isAutoPickable({ origin: 'local' }), true);
    assert.equal(isAutoPickable({ origin: 'local', audit_verdict: null }), true);
    assert.equal(isAutoPickable({ origin: 'local', audit_verdict: 'reject' }), true);
  });

  test('null/undefined origin is treated as LOCAL (D-006 bypass)', () => {
    assert.equal(isAutoPickable({ origin: null }), true);
    assert.equal(isAutoPickable({}), true);
  });

  test('REMOTE + admitted → pickable', () => {
    assert.equal(isAutoPickable({ origin: 'remote', audit_verdict: 'admit' }), true);
  });

  test('REMOTE + NOT admitted → NOT pickable (the security-critical cases)', () => {
    // pending / null (pre-migration) / reject / unknown verdict all stay OUT.
    assert.equal(isAutoPickable({ origin: 'remote', audit_verdict: 'pending' }), false);
    assert.equal(isAutoPickable({ origin: 'remote', audit_verdict: null }), false);
    assert.equal(isAutoPickable({ origin: 'remote', audit_verdict: 'reject' }), false);
    assert.equal(isAutoPickable({ origin: 'remote' }), false);
    assert.equal(isAutoPickable({ origin: 'remote', audit_verdict: 'Admit' }), false); // exact 'admit' only
  });
});
