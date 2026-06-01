import { afterEach, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { durableOwnedFeatureIdsPg, readFeaturesPg } from './state-pg';

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
