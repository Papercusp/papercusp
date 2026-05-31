import { afterEach, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { durableOwnedFeatureIdsPg } from './state-pg';

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

describe('durableOwnedFeatureIdsPg — Phase 3 carve-out (D-012/D-013)', () => {
  const orig = process.env[FLAG];
  afterEach(() => {
    if (orig === undefined) delete process.env[FLAG];
    else process.env[FLAG] = orig;
  });

  test('flag OFF → empty set, never touches pg (zero-cost off-path)', async () => {
    delete process.env[FLAG];
    const { pg, calls } = fakePg(() => [{ feature_id: 'F-001' }]);
    const ctx = { pg, workspaceId: 'w', harnessSlug: 's' } as unknown as Ctx;
    const owned = await durableOwnedFeatureIdsPg(ctx);
    assert.equal(owned.size, 0);
    assert.equal(calls.length, 0);
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
