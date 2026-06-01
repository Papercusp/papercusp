/**
 * Unit tests for G2 Auditor Dispatch (P-007).
 *
 * Plan: papercusp-user-protection-gate-2026-05-31 Phase 2 P-007.
 *
 * Surfaces tested:
 *   1. parseAuditorOutput — JSON extraction + validation.
 *   2. selectRemotePendingFeatures — selector predicate (mock-PG).
 *   3. applyAuditVerdict — admit/reject/idempotent/local-untouched (mock-PG).
 *   4. dispatchAuditorLane — end-to-end with injected spawn + mock-PG:
 *      - admit → feature becomes pickable (audit_verdict='admit')
 *      - reject → feature stays quarantined + escalation created
 *      - empty lane (no pending features) → no-op
 *      - spawn failure → fail-safe reject + escalation
 *      - idempotent: already-audited feature skipped
 */
import { describe, test, expect, vi } from 'vitest';
import {
  parseAuditorOutput,
  selectRemotePendingFeatures,
  applyAuditVerdict,
  dispatchAuditorLane,
  type AuditorDispatchCtx,
  type AuditVerdict,
  type RemotePendingFeature,
} from './auditor-dispatch.js';
import type { OrchestratorPg } from './invoke.js';

// ─── 1. parseAuditorOutput ───────────────────────────────────────────────────

describe('parseAuditorOutput', () => {
  test('parses a clean admit verdict', () => {
    const raw = '{ "verdict": "admit", "reasons": "Feature looks benign." }';
    expect(parseAuditorOutput(raw)).toEqual({ verdict: 'admit', reasons: 'Feature looks benign.' });
  });

  test('parses a clean reject verdict', () => {
    const raw = '{ "verdict": "reject", "reasons": "Contains shell injection." }';
    expect(parseAuditorOutput(raw)).toEqual({ verdict: 'reject', reasons: 'Contains shell injection.' });
  });

  test('strips markdown code fences before parsing', () => {
    const raw = '```json\n{ "verdict": "admit", "reasons": "ok" }\n```';
    expect(parseAuditorOutput(raw)).toEqual({ verdict: 'admit', reasons: 'ok' });
  });

  test('extracts JSON from a verbose auditor response', () => {
    const raw = 'I reviewed the feature. My verdict:\n{ "verdict": "reject", "reasons": "bad" }\n(end of output)';
    const result = parseAuditorOutput(raw);
    expect(result?.verdict).toBe('reject');
    expect(result?.reasons).toBe('bad');
  });

  test('returns null for empty input', () => {
    expect(parseAuditorOutput('')).toBeNull();
    expect(parseAuditorOutput('  ')).toBeNull();
  });

  test('returns null for invalid JSON', () => {
    expect(parseAuditorOutput('not json at all')).toBeNull();
  });

  test('returns null for unknown verdict value', () => {
    const raw = '{ "verdict": "maybe", "reasons": "unsure" }';
    expect(parseAuditorOutput(raw)).toBeNull();
  });

  test('coerces non-string reasons to string', () => {
    const raw = '{ "verdict": "admit", "reasons": 42 }';
    const result = parseAuditorOutput(raw);
    expect(result?.verdict).toBe('admit');
    expect(typeof result?.reasons).toBe('string');
  });
});

// ─── 2. selectRemotePendingFeatures — selector predicate ─────────────────────

/**
 * Build a mock postgres-js tagged-template function that captures query
 * info and returns the given rows for the features_consolidated SELECT.
 */
function makeSelectorPg(rows: RemotePendingFeature[]) {
  const calls: { q: string; vals: unknown[] }[] = [];
  const pg = (t: TemplateStringsArray, ...vals: unknown[]) => {
    const q = t.join('?');
    calls.push({ q, vals });
    if (/FROM harness_shared\.harness_features_consolidated/i.test(q)) return Promise.resolve(rows);
    return Promise.resolve([]);
  };
  return { pg: pg as unknown as OrchestratorPg, calls };
}

describe('selectRemotePendingFeatures', () => {
  test('queries origin=remote + NULL/pending verdict', async () => {
    const { pg, calls } = makeSelectorPg([]);
    await selectRemotePendingFeatures(pg, 'w1');
    const c = calls.find((c) => /harness_features_consolidated/i.test(c.q))!;
    expect(c.q).toMatch(/origin\s*=\s*'remote'/i);
    expect(c.q).toMatch(/audit_verdict IS NULL OR audit_verdict = 'pending'/i);
  });

  test('passes workspace_id as a bound param', async () => {
    const { pg, calls } = makeSelectorPg([]);
    await selectRemotePendingFeatures(pg, 'ws-abc');
    const c = calls.find((c) => /harness_features_consolidated/i.test(c.q))!;
    expect(c.vals).toContain('ws-abc');
  });

  test('optionally scopes to a single harness', async () => {
    const { pg, calls } = makeSelectorPg([]);
    await selectRemotePendingFeatures(pg, 'ws1', 'alpha');
    const c = calls.find((c) => /harness_features_consolidated/i.test(c.q))!;
    expect(c.vals).toContain('alpha');
  });

  test('returns the rows from the PG mock', async () => {
    const row: RemotePendingFeature = { harness_slug: 'h', feature_id: 'F-1', title: 'T', summary: null };
    const { pg } = makeSelectorPg([row]);
    const result = await selectRemotePendingFeatures(pg, 'w1');
    expect(result).toHaveLength(1);
    expect(result[0].feature_id).toBe('F-1');
  });
});

// ─── 3. applyAuditVerdict ────────────────────────────────────────────────────

/**
 * Build a mock PG that:
 *   - SELECT → returns the given origin + audit_verdict
 *   - UPDATE → captures the SQL
 */
function makeApplyPg(
  origin: string | null,
  existingVerdict: string | null,
) {
  const updates: { q: string; vals: unknown[] }[] = [];
  const pg = (t: TemplateStringsArray, ...vals: unknown[]) => {
    const q = t.join('?');
    if (/SELECT origin, audit_verdict/i.test(q)) {
      return Promise.resolve([{ origin, audit_verdict: existingVerdict }]);
    }
    if (/UPDATE harness_shared/i.test(q)) {
      updates.push({ q, vals });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return { pg: pg as unknown as OrchestratorPg, updates };
}

describe('applyAuditVerdict', () => {
  const admitVerdict: AuditVerdict = { verdict: 'admit', reasons: 'Looks fine.' };
  const rejectVerdict: AuditVerdict = { verdict: 'reject', reasons: 'Injection detected.' };

  test('admit → returns applied + issues UPDATE with audit_verdict=admit', async () => {
    const { pg, updates } = makeApplyPg('remote', null);
    const result = await applyAuditVerdict(pg, 'w1', 'h', 'F-1', admitVerdict);
    expect(result).toBe('applied');
    expect(updates).toHaveLength(1);
    expect(updates[0].q).toMatch(/audit_verdict\s*=\s*'admit'/i);
  });

  test('reject → returns applied + issues UPDATE with audit_verdict=reject + audit_reasons', async () => {
    const { pg, updates } = makeApplyPg('remote', null);
    const result = await applyAuditVerdict(pg, 'w1', 'h', 'F-1', rejectVerdict);
    expect(result).toBe('applied');
    expect(updates).toHaveLength(1);
    expect(updates[0].q).toMatch(/audit_verdict\s*=\s*'reject'/i);
    expect(updates[0].q).toMatch(/audit_reasons/i);
    // The reasons string is a bound param
    expect(updates[0].vals).toContain('Injection detected.');
  });

  test('idempotent: audit_verdict already set → returns idempotent, no UPDATE', async () => {
    const { pg, updates } = makeApplyPg('remote', 'admit');
    const result = await applyAuditVerdict(pg, 'w1', 'h', 'F-1', admitVerdict);
    expect(result).toBe('idempotent');
    expect(updates).toHaveLength(0);
  });

  test("local feature → returns 'local', no UPDATE issued", async () => {
    const { pg, updates } = makeApplyPg('local', null);
    const result = await applyAuditVerdict(pg, 'w1', 'h', 'F-1', admitVerdict);
    expect(result).toBe('local');
    expect(updates).toHaveLength(0);
  });

  test("null origin → treated as local, returns 'local'", async () => {
    const { pg, updates } = makeApplyPg(null, null);
    const result = await applyAuditVerdict(pg, 'w1', 'h', 'F-1', admitVerdict);
    expect(result).toBe('local');
    expect(updates).toHaveLength(0);
  });

  test('no consolidated row → returns idempotent without crashing', async () => {
    const noRowPg = ((t: TemplateStringsArray, ..._v: unknown[]) => {
      const q = t.join('?');
      if (/SELECT origin/i.test(q)) return Promise.resolve([]);
      return Promise.resolve([]);
    }) as unknown as OrchestratorPg;
    const result = await applyAuditVerdict(noRowPg, 'w1', 'h', 'F-1', admitVerdict);
    expect(result).toBe('idempotent');
  });
});

// ─── 4. dispatchAuditorLane — end-to-end ────────────────────────────────────

/**
 * Build a full mock PG that simulates the lane's query pattern:
 *   - SELECT harness_slug … (feature list for selectRemotePendingFeatures) → featureRows
 *   - SELECT origin, audit_verdict … (per-feature apply read) → origin='remote', verdict=null
 *   - UPDATE … → captured
 *
 * Query disambiguation: the feature-list SELECT targets harness_slug/feature_id/title/summary;
 * the apply-read SELECT targets origin/audit_verdict. Use the first SELECTed column to distinguish.
 */
function makeLanePg(featureRows: RemotePendingFeature[]) {
  const updates: { q: string; vals: unknown[] }[] = [];
  const pg = (t: TemplateStringsArray, ...vals: unknown[]) => {
    const q = t.join('?');
    // Per-feature apply read (SELECT origin, audit_verdict)
    if (/SELECT origin, audit_verdict/i.test(q)) {
      return Promise.resolve([{ origin: 'remote', audit_verdict: null }]);
    }
    // Feature list from harness_features_consolidated (SELECT harness_slug, feature_id, ...)
    if (/FROM harness_shared\.harness_features_consolidated/i.test(q)) {
      return Promise.resolve(featureRows);
    }
    // UPDATE
    if (/UPDATE harness_shared/i.test(q)) {
      updates.push({ q, vals });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return { pg: pg as unknown as OrchestratorPg, updates };
}

describe('dispatchAuditorLane', () => {
  const FEATURE_ROWS: RemotePendingFeature[] = [
    { harness_slug: 'my-harness', feature_id: 'F-REM-1', title: 'A remote task', summary: null },
  ];

  function makeCtx(
    featureRows: RemotePendingFeature[],
    spawnResult: AuditVerdict | null,
  ): AuditorDispatchCtx & { escalations: Array<{ featureId: string; harnessSlug: string; reasons: string }> } {
    const { pg } = makeLanePg(featureRows);
    const escalations: Array<{ featureId: string; harnessSlug: string; reasons: string }> = [];
    const ctx: AuditorDispatchCtx & typeof escalations extends Array<infer U> ? never : AuditorDispatchCtx = {
      pg,
      workspaceId: 'w1',
      spawnAuditor: vi.fn().mockResolvedValue(spawnResult),
      createEscalation: vi.fn().mockImplementation(async (input) => {
        escalations.push(input);
      }),
      log: vi.fn(),
    };
    return Object.assign(ctx, { escalations });
  }

  test('admit → feature admitted (audit_verdict update issued), no escalation', async () => {
    const { pg, updates } = makeLanePg(FEATURE_ROWS);
    const escalations: Array<unknown> = [];
    const ctx: AuditorDispatchCtx = {
      pg,
      workspaceId: 'w1',
      spawnAuditor: async () => ({ verdict: 'admit', reasons: 'ok' }),
      createEscalation: async (input) => { escalations.push(input); },
      log: vi.fn(),
    };
    const result = await dispatchAuditorLane(ctx);
    expect(result.admitted).toContain('F-REM-1');
    expect(result.rejected).toHaveLength(0);
    expect(escalations).toHaveLength(0);
    expect(updates.some((u) => /audit_verdict\s*=\s*'admit'/i.test(u.q))).toBe(true);
  });

  test('reject → feature stays quarantined + escalation created', async () => {
    const { pg, updates } = makeLanePg(FEATURE_ROWS);
    const escalations: Array<{ featureId: string; harnessSlug: string; reasons: string }> = [];
    const ctx: AuditorDispatchCtx = {
      pg,
      workspaceId: 'w1',
      spawnAuditor: async () => ({ verdict: 'reject', reasons: 'Shell injection detected.' }),
      createEscalation: async (input) => { escalations.push(input); },
      log: vi.fn(),
    };
    const result = await dispatchAuditorLane(ctx);
    expect(result.rejected).toContain('F-REM-1');
    expect(result.admitted).toHaveLength(0);
    // Verify the feature stays quarantined (audit_verdict='reject', not 'admit')
    expect(updates.some((u) => /audit_verdict\s*=\s*'reject'/i.test(u.q))).toBe(true);
    expect(updates.some((u) => /audit_verdict\s*=\s*'admit'/i.test(u.q))).toBe(false);
    // Escalation is created
    expect(escalations).toHaveLength(1);
    expect(escalations[0].featureId).toBe('F-REM-1');
    expect(escalations[0].harnessSlug).toBe('my-harness');
    expect(escalations[0].reasons).toContain('Shell injection');
  });

  test('no pending features → immediate empty result, no spawn', async () => {
    const { pg } = makeLanePg([]);
    const spawnFn = vi.fn();
    const ctx: AuditorDispatchCtx = {
      pg,
      workspaceId: 'w1',
      spawnAuditor: spawnFn,
      createEscalation: async () => {},
      log: vi.fn(),
    };
    const result = await dispatchAuditorLane(ctx);
    expect(result.admitted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test('spawn returns null (fail-safe) → auto-reject + escalation', async () => {
    const { pg } = makeLanePg(FEATURE_ROWS);
    const escalations: Array<unknown> = [];
    const ctx: AuditorDispatchCtx = {
      pg,
      workspaceId: 'w1',
      spawnAuditor: async () => null,
      createEscalation: async (input) => { escalations.push(input); },
      log: vi.fn(),
    };
    const result = await dispatchAuditorLane(ctx);
    expect(result.rejected).toContain('F-REM-1');
    expect(escalations).toHaveLength(1);
  });

  test('already-audited feature is skipped (idempotent)', async () => {
    // PG returns existing verdict='admit' for the apply-read
    const alreadyAuditedPg = ((t: TemplateStringsArray, ...vals: unknown[]) => {
      const q = t.join('?');
      if (/SELECT origin, audit_verdict/i.test(q)) {
        return Promise.resolve([{ origin: 'remote', audit_verdict: 'admit' }]);
      }
      if (/FROM harness_shared\.harness_features_consolidated/i.test(q)) {
        return Promise.resolve(FEATURE_ROWS);
      }
      return Promise.resolve([]);
    }) as unknown as OrchestratorPg;
    const spawnFn = vi.fn();
    const ctx: AuditorDispatchCtx = {
      pg: alreadyAuditedPg,
      workspaceId: 'w1',
      spawnAuditor: spawnFn,
      createEscalation: async () => {},
      log: vi.fn(),
    };
    const result = await dispatchAuditorLane(ctx);
    // Spawned the auditor (before applyAuditVerdict checks idempotency)
    // but no admitted/rejected because the apply returned 'idempotent'
    expect(result.admitted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  test('escalation create failure is non-fatal', async () => {
    const { pg } = makeLanePg(FEATURE_ROWS);
    const ctx: AuditorDispatchCtx = {
      pg,
      workspaceId: 'w1',
      spawnAuditor: async () => ({ verdict: 'reject', reasons: 'bad' }),
      createEscalation: async () => { throw new Error('coord offline'); },
      log: vi.fn(),
    };
    // Should not throw
    const result = await dispatchAuditorLane(ctx);
    expect(result.rejected).toContain('F-REM-1');
    expect(result.errors.some((e) => e.includes('escalation-error'))).toBe(true);
  });
});
