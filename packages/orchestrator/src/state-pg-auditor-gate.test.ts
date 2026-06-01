/**
 * Unit tests for the G2 Auditor-admission pick-gate (P-008).
 *
 * Plan: papercusp-user-protection-gate-2026-05-31 P-008 + P-014.
 *
 * Two test surfaces:
 *   1. isAutoPickable — pure predicate, exhaustively tested in isolation.
 *   2. readFeaturesPg — mock-PG tests verifying the SQL WHERE clause
 *      applies the gate and preserves backward compat.
 *
 * Integration tests that spin up a real PG and exercise the actual JOIN
 * would live here too, but require Docker (testcontainer); skip-annotated
 * placeholders document what they'd assert.
 */
import { describe, test, expect } from 'vitest';
import { isAutoPickable, readFeaturesPg } from './state-pg.js';

// ─── 1. isAutoPickable predicate ─────────────────────────────────────────────

describe('isAutoPickable — G2 pick-gate predicate (P-008 / D-006)', () => {
  // Local features are always pickable — no verdict needed.
  test("origin='local', audit_verdict=null → true", () => {
    expect(isAutoPickable({ origin: 'local', audit_verdict: null })).toBe(true);
  });
  test("origin='local', audit_verdict='pending' → true (local bypasses audit)", () => {
    expect(isAutoPickable({ origin: 'local', audit_verdict: 'pending' })).toBe(true);
  });
  test("origin='local', audit_verdict='reject' → true (local bypasses audit)", () => {
    expect(isAutoPickable({ origin: 'local', audit_verdict: 'reject' })).toBe(true);
  });
  test("origin='local', audit_verdict='admit' → true", () => {
    expect(isAutoPickable({ origin: 'local', audit_verdict: 'admit' })).toBe(true);
  });

  // Null / undefined origin: treat as local (pre-G1 rows, no hfc row yet).
  test('origin=null, audit_verdict=null → true (backward compat)', () => {
    expect(isAutoPickable({ origin: null, audit_verdict: null })).toBe(true);
  });
  test('origin=undefined, audit_verdict=null → true (backward compat)', () => {
    expect(isAutoPickable({ audit_verdict: null })).toBe(true);
  });

  // Remote features: admitted only.
  test("origin='remote', audit_verdict='admit' → true (auditor admitted)", () => {
    expect(isAutoPickable({ origin: 'remote', audit_verdict: 'admit' })).toBe(true);
  });

  // Remote features: not-admitted cases.
  test("origin='remote', audit_verdict=null → false (not yet screened)", () => {
    expect(isAutoPickable({ origin: 'remote', audit_verdict: null })).toBe(false);
  });
  test("origin='remote', audit_verdict=undefined → false", () => {
    expect(isAutoPickable({ origin: 'remote' })).toBe(false);
  });
  test("origin='remote', audit_verdict='pending' → false", () => {
    expect(isAutoPickable({ origin: 'remote', audit_verdict: 'pending' })).toBe(false);
  });
  test("origin='remote', audit_verdict='reject' → false (rejected, escalated to human)", () => {
    expect(isAutoPickable({ origin: 'remote', audit_verdict: 'reject' })).toBe(false);
  });
});

// ─── 2. readFeaturesPg — gate applied in SQL ─────────────────────────────────

type PgCtx = Parameters<typeof readFeaturesPg>[0];

/**
 * Minimal fake postgres-js tag function.
 *
 * Returns rows based on which query is being issued:
 *   - workflow_status regclass    → null (DBOS carve-out disabled; no workflows)
 *   - main harness_features query → caller-provided rows (plan-status sub-select
 *     is inlined in the same template; we return feature rows for this call)
 *
 * Note: the main feature SELECT contains a nested sub-select referencing
 * harness_plan_status, so the entire outer query text contains both
 * "harness_features" AND "harness_plan_status". We check for harness_features
 * FIRST (more specific) to avoid the plan-status branch stealing the call.
 */
function makeFakePg(featureRows: object[]) {
  const calls: { q: string; vals: unknown[] }[] = [];
  const pg = (t: TemplateStringsArray, ...vals: unknown[]) => {
    const q = t.join('?');
    calls.push({ q, vals });

    // DBOS carve-out path
    if (/to_regclass/i.test(q)) return Promise.resolve([{ t: null }]);
    // Main feature SELECT (contains harness_plan_status inline — match feature first)
    if (/FROM harness_features\b/i.test(q)) return Promise.resolve(featureRows);

    return Promise.resolve([]);
  };
  return { pg: pg as unknown as PgCtx['pg'], calls };
}

describe('readFeaturesPg — G2 gate in SQL WHERE clause', () => {
  test('gate clause appears in the main feature SELECT', async () => {
    const { pg, calls } = makeFakePg([]);
    await readFeaturesPg({
      pg,
      workspaceId: 'w1',
      harnessSlug: 'my-harness',
    } as unknown as PgCtx);

    const featureCall = calls.find((c) => /FROM harness_features/i.test(c.q));
    expect(featureCall, 'readFeaturesPg must issue a harness_features SELECT').toBeTruthy();

    const q = featureCall!.q;

    // G2 gate: LEFT JOIN on consolidated + the three-branch OR
    expect(q).toMatch(/LEFT JOIN harness_shared\.harness_features_consolidated/i);
    expect(q).toMatch(/hfc\.feature_id IS NULL/i);
    expect(q).toMatch(/hfc\.origin\s*=\s*'local'/i);
    expect(q).toMatch(/hfc\.audit_verdict\s*=\s*'admit'/i);
  });

  test('query still filters on metadata source_plan (not non-existent column)', async () => {
    const { pg, calls } = makeFakePg([]);
    await readFeaturesPg({
      pg,
      workspaceId: 'w1',
      harnessSlug: 'my-harness',
    } as unknown as PgCtx);

    const featureCall = calls.find((c) => /FROM harness_features/i.test(c.q))!;
    expect(featureCall.q).toMatch(/metadata->>'source_plan'/);
    expect(featureCall.q).not.toMatch(/source_plan_slug\s+(IS|IN)\b/i);
  });

  test('local feature (hfc.origin=local) row is returned', async () => {
    // The fakePg returns whatever rows we provide; the WHERE filtering is in the
    // real DB. Here we verify the SELECT returns rows given by the mock (i.e.
    // the JS layer does not do a second in-memory filter beyond durable carve-out).
    const localRow = { feature_id: 'F-LOCAL', status: 'todo', title: 'local feat' };
    const { pg } = makeFakePg([localRow]);
    const features = await readFeaturesPg({
      pg,
      workspaceId: 'w1',
      harnessSlug: 'my-harness',
    } as unknown as PgCtx);
    expect(features.some((f) => f.id === 'F-LOCAL')).toBe(true);
  });

  test('admitted-remote feature row is returned', async () => {
    const admittedRow = { feature_id: 'F-REMOTE-OK', status: 'todo', title: 'admitted remote' };
    const { pg } = makeFakePg([admittedRow]);
    const features = await readFeaturesPg({
      pg,
      workspaceId: 'w1',
      harnessSlug: 'my-harness',
    } as unknown as PgCtx);
    expect(features.some((f) => f.id === 'F-REMOTE-OK')).toBe(true);
  });

  test('pending/rejected remote rows excluded by the SQL gate (no rows returned)', async () => {
    // The real exclusion happens in PG via the LEFT JOIN WHERE; the mock simulates
    // this by returning no rows (i.e. PG already filtered them). Verify the JS
    // layer returns an empty list and does not synthesise rows out of thin air.
    const { pg } = makeFakePg([]);
    const features = await readFeaturesPg({
      pg,
      workspaceId: 'w1',
      harnessSlug: 'my-harness',
    } as unknown as PgCtx);
    expect(features).toHaveLength(0);
  });

  test('harness_slug is bound as param in the LEFT JOIN ON clause', async () => {
    const { pg, calls } = makeFakePg([]);
    await readFeaturesPg({
      pg,
      workspaceId: 'w1',
      harnessSlug: 'alpha-harness',
    } as unknown as PgCtx);

    const featureCall = calls.find((c) => /FROM harness_features/i.test(c.q))!;
    // postgres-js interpolates template values; the slug should be a bound param
    expect(featureCall.vals).toContain('alpha-harness');
  });
});

// ─── 3. Integration note ─────────────────────────────────────────────────────
//
// The following integration assertions require a real PG (testcontainer).
// They are documented here but not executed; a follow-up can enable them
// by adding the testcontainer setup from @papercusp/test-config/getTestPg.
//
// Integration assertions to add (P-014):
//   a) Seed harness_features + harness_features_consolidated rows with
//      origin='local' — verify readFeaturesPg returns them.
//   b) Seed a remote-admitted row (origin='remote', audit_verdict='admit') —
//      verify returned.
//   c) Seed a remote-pending row (origin='remote', audit_verdict=NULL) —
//      verify NOT returned.
//   d) Seed a remote-rejected row (origin='remote', audit_verdict='reject') —
//      verify NOT returned.
//   e) Seed a row with no hfc entry (LEFT JOIN returns NULL) —
//      verify returned (backward compat).
