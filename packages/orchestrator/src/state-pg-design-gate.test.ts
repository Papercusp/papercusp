/**
 * Unit test for the design-phase gate inside setFeatureStatusPg.
 *
 * Mocks the PG client; verifies the gate reads needs_design +
 * design_status from harness_features_consolidated and refuses the
 * 'in_progress' transition when needed.
 *
 * Plan: apps/operator/content/internal-docs/design/design-phase-plan.mdx §2.
 */
import { describe, test, beforeEach, afterEach, expect } from 'vitest';
import { DesignGateError, setFeatureStatusPg } from './state-pg.js';

interface GateRow {
  needs_design: boolean;
  design_status: string | null;
}

function makeMockPg(gateRow: GateRow | null) {
  const calls: { sql: string; params: unknown[] }[] = [];
  // postgres-js's sql tag returns rows for SELECT and undefined/affected
  // count for UPDATE. We track template strings + bound values per call.
  const sql = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const fragment = parts.join('?');
    calls.push({ sql: fragment, params: values });
    if (/SELECT needs_design, design_status/i.test(fragment)) {
      return Promise.resolve(gateRow ? [gateRow] : []);
    }
    if (/UPDATE harness_features/i.test(fragment)) {
      return Promise.resolve(undefined);
    }
    if (/SELECT.*FROM harness_features\b/i.test(fragment)) {
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return { sql: sql as unknown as never, calls };
}

const FEATURE_ID = 'F-1';
const HARNESS_SLUG = 'sheets';
const WORKSPACE_ID = 'default';

const ORIGINAL_GATE = process.env.PAPERCUSP_DESIGN_GATE;

beforeEach(() => {
  delete process.env.PAPERCUSP_DESIGN_GATE;
});
afterEach(() => {
  if (ORIGINAL_GATE === undefined) delete process.env.PAPERCUSP_DESIGN_GATE;
  else process.env.PAPERCUSP_DESIGN_GATE = ORIGINAL_GATE;
});

describe('design-phase gate (PAPERCUSP_DESIGN_GATE=1)', () => {
  test('off by default — passes through even when design_status pending', async () => {
    const mock = makeMockPg({ needs_design: true, design_status: 'pending' });
    await expect(
      setFeatureStatusPg(
        { pg: mock.sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
        FEATURE_ID,
        'in_progress',
      ),
    ).resolves.toBeDefined();
    // No SELECT to harness_features_consolidated when gate is off
    expect(mock.calls.some((c) => /needs_design/i.test(c.sql))).toBe(false);
  });

  test('on, needs_design=false — passes', async () => {
    process.env.PAPERCUSP_DESIGN_GATE = '1';
    const mock = makeMockPg({ needs_design: false, design_status: null });
    await expect(
      setFeatureStatusPg(
        { pg: mock.sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
        FEATURE_ID,
        'in_progress',
      ),
    ).resolves.toBeDefined();
  });

  test('on, needs_design=true, design_status=pending — throws DesignGateError', async () => {
    process.env.PAPERCUSP_DESIGN_GATE = '1';
    const mock = makeMockPg({ needs_design: true, design_status: 'pending' });
    await expect(
      setFeatureStatusPg(
        { pg: mock.sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
        FEATURE_ID,
        'in_progress',
      ),
    ).rejects.toBeInstanceOf(DesignGateError);
  });

  test('on, needs_design=true, design_status=null — throws DesignGateError', async () => {
    process.env.PAPERCUSP_DESIGN_GATE = '1';
    const mock = makeMockPg({ needs_design: true, design_status: null });
    await expect(
      setFeatureStatusPg(
        { pg: mock.sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
        FEATURE_ID,
        'in_progress',
      ),
    ).rejects.toBeInstanceOf(DesignGateError);
  });

  test('on, needs_design=true, design_status=accepted — passes', async () => {
    process.env.PAPERCUSP_DESIGN_GATE = '1';
    const mock = makeMockPg({ needs_design: true, design_status: 'accepted' });
    await expect(
      setFeatureStatusPg(
        { pg: mock.sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
        FEATURE_ID,
        'in_progress',
      ),
    ).resolves.toBeDefined();
  });

  test('on, needs_design=true, design_status=ignored — passes (skipped)', async () => {
    process.env.PAPERCUSP_DESIGN_GATE = '1';
    const mock = makeMockPg({ needs_design: true, design_status: 'ignored' });
    await expect(
      setFeatureStatusPg(
        { pg: mock.sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
        FEATURE_ID,
        'in_progress',
      ),
    ).resolves.toBeDefined();
  });

  test('on, but no harnessSlug in ctx — silently skips gate (compat path)', async () => {
    process.env.PAPERCUSP_DESIGN_GATE = '1';
    const mock = makeMockPg({ needs_design: true, design_status: 'pending' });
    await expect(
      setFeatureStatusPg(
        { pg: mock.sql, workspaceId: WORKSPACE_ID }, // no harnessSlug
        FEATURE_ID,
        'in_progress',
      ),
    ).resolves.toBeDefined();
  });

  test('on, transitioning to NON-in_progress status — passes (gate only fires on in_progress)', async () => {
    process.env.PAPERCUSP_DESIGN_GATE = '1';
    const mock = makeMockPg({ needs_design: true, design_status: 'pending' });
    await expect(
      setFeatureStatusPg(
        { pg: mock.sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
        FEATURE_ID,
        'passed',
      ),
    ).resolves.toBeDefined();
  });

  test('on, no row in consolidated — silently passes (no-op compat)', async () => {
    process.env.PAPERCUSP_DESIGN_GATE = '1';
    const mock = makeMockPg(null);
    await expect(
      setFeatureStatusPg(
        { pg: mock.sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
        FEATURE_ID,
        'in_progress',
      ),
    ).resolves.toBeDefined();
  });

  test('DesignGateError carries featureId + designStatus', async () => {
    process.env.PAPERCUSP_DESIGN_GATE = '1';
    const mock = makeMockPg({ needs_design: true, design_status: 'pending' });
    try {
      await setFeatureStatusPg(
        { pg: mock.sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
        FEATURE_ID,
        'in_progress',
      );
      throw new Error('expected DesignGateError');
    } catch (e) {
      expect(e).toBeInstanceOf(DesignGateError);
      expect((e as DesignGateError).featureId).toBe(FEATURE_ID);
      expect((e as DesignGateError).designStatus).toBe('pending');
    }
  });
});
