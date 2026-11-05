/** Synthetic ledger controls on real PG, never real-plan replay/pilot proof. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../../packages/operator-core/test/_pg-helpers';
import type { OrgSql } from '../../../../../packages/operator-core/lib/external-bench/reproducibility/db';
import { preregister } from '../../../../../packages/operator-core/lib/external-bench/reproducibility/prereg';
import { emitRollout } from '../../../../../packages/operator-core/lib/external-bench/reproducibility/emit';
import { getManagedCapabilityEffectiveness, listRunResults } from '../../../../../packages/operator-core/lib/external-bench/reproducibility/store';
import { CAPABILITY_CLIENT_ENFORCEMENT, type CapabilityClientFamily } from './managed-capability-policy';

// Notification delivery is not under test; all ledger IO uses the private PG.
vi.mock('../../../../../packages/operator-core/lib/sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

let db: FreshPgDb;
let sql: OrgSql;
let repo: string;
const workspaceId = 'managed-trial-detector-private';
const scope = () => ({ sql, workspaceId });
const clients = Object.keys(CAPABILITY_CLIENT_ENFORCEMENT) as CapabilityClientFamily[];
const suite = 'harness-bench';

beforeAll(async () => {
  db = await createFreshPgDb('managedtrial');
  sql = db.sql as unknown as OrgSql;
  repo = mkdtempSync(join(tmpdir(), 'managed-trial-prereg-'));
  for (const file of ['291-benchmark-reproducibility.sql', '302-bench-run-score.sql',
    '1615-benchmark-frozen-arm-identities.sql']) {
    const source = readFileSync(resolve(import.meta.dirname,
      '../../../libs/db/sql', file), 'utf8').split('\n')
      .filter(line => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line)).join('\n');
    await sql.unsafe(source);
  }
}, 120_000);

afterAll(async () => {
  try { await db?.cleanup(); }
  finally { if (repo) rmSync(repo, { recursive: true, force: true }); }
});

async function seed(runId: string, items = 30) {
  const assignments = clients.flatMap(client => Array.from({ length: items }, (_, i) => ({
    client, clientVersion: 'detector-fixture-version', modelId: 'claude-opus-4-8[1m]',
    taskId: `${client}-item-${i}`, seed: 0, planSlug: 'detector-fixture-plan',
    itemId: `P-${String(i + 1).padStart(3, '0')}`, preImplementationCommit: 'c'.repeat(40),
    graderTestPaths: ['fixture/own.test.ts'], families: ['shell-ssh-interpreters'] as const,
  })));
  const config = { managedCapabilityTrial: { sharedCheckoutRealpath: '/shared/papercusp', assignments } };
  const { preregHash } = await preregister({ ...scope(), runId, suites: [suite], config, repoRoot: repo });
  // Simulate the existing verification writer's stamp in this disposable DB.
  // This does not attest an actual preregistration commit or a real trial.
  await sql`UPDATE harness_shared.benchmark_prereg SET git_committed = true,
    git_commit_sha = ${'b'.repeat(40)}, created_at = '2026-11-01T00:00:00Z'
    WHERE workspace_id = ${workspaceId} AND run_id = ${runId}`;
  for (const assignment of assignments) for (const arm of ['native', 'managed-only'] as const) {
    await emitRollout({ runId, preregHash, suite, taskId: assignment.taskId, arm, seed: 0, modality: 'diff',
      generation: { status: 'completed', tokensIn: 90, tokensOut: 10, tokensTotal: 100,
        tokensCacheRead: 20, tokensCacheWrite: 5, wallClockMs: 1000, turns: 2,
        modelId: assignment.modelId, harnessVersion: 'detector-fixture-harness' },
      grading: { resolved: true, status: 'passed', family: 'fixture-own-tests', version: 'c'.repeat(40),
        rawOutput: 'Synthetic own-test grader passed' },
      provenance: { configSnapshot: config, envFingerprint: {
        client: assignment.client, clientVersion: assignment.clientVersion, toolMode: arm,
        sourceCommit: assignment.preImplementationCommit,
        checkoutRealpath: `/isolated/${runId}/${assignment.taskId}/${arm}`,
        environmentHash: 'detector-fixture-environment', startedAt: '2026-11-01T01:00:00Z',
        graderTestPaths: assignment.graderTestPaths, toolCalls: 4, errors: 0, retries: 0, refusals: 1,
      } } }, scope());
  }
}

describe('R17 benchmark ledger selection, matching and fixed floor (synthetic controls)', () => {
  it('reads the selected workspace/run/suite and preserves cache and outcome metrics', async () => {
    await seed('control-pass');
    // A missing run is not rescued by the populated passing run beside it.
    expect((await getManagedCapabilityEffectiveness('absent', scope())).verdict).toBe('unknown');
    expect((await getManagedCapabilityEffectiveness('control-pass', { sql, workspaceId: 'other' })).verdict).toBe('unknown');
    const rows = await listRunResults({ ...scope(), runId: 'control-pass', suite });
    expect(rows).toHaveLength(180);
    expect(rows[0]).toMatchObject({ tokensIn: 90, tokensOut: 10, tokensCacheRead: 20, tokensCacheWrite: 5 });
    const report = await getManagedCapabilityEffectiveness('control-pass', scope());
    expect(report.verdict).toBe('pass');
    expect(report.clients.map(row => row.client)).toEqual(clients);
    for (const row of report.clients) expect(row).toMatchObject({ assignedItems: 30, matchedPairs: 30,
      native: { successes: 30 }, managed: { successes: 30, tokensCacheRead: 600, tokensCacheWrite: 150 } });
  });

  it('refuses 29 matched items per client even when every persisted attempt passes', async () => {
    await seed('control-under-floor', 29);
    const report = await getManagedCapabilityEffectiveness('control-under-floor', scope());
    expect(report.verdict).toBe('unknown');
    for (const row of report.clients) expect(row.issues).toContain('insufficient-distinct-plan-items');
  });

  it('retains the frozen denominator when a managed ledger result is deleted', async () => {
    await seed('control-missing-pair');
    expect((await getManagedCapabilityEffectiveness('control-missing-pair', scope())).verdict).toBe('pass');
    await sql`DELETE FROM harness_shared.benchmark_run_result WHERE workspace_id = ${workspaceId}
      AND run_id = 'control-missing-pair' AND task_id = 'omp-item-0' AND arm = 'managed-only'`;
    const report = await getManagedCapabilityEffectiveness('control-missing-pair', scope());
    expect(report.verdict).toBe('unknown');
    expect(report.clients.find(row => row.client === 'omp')?.issues).toContain('missing-pair:omp-item-0');
  });

  it('refuses a persisted witness with model or execution-mode drift', async () => {
    await seed('control-drift');
    expect((await getManagedCapabilityEffectiveness('control-drift', scope())).verdict).toBe('pass');
    await sql`UPDATE harness_shared.benchmark_run_result SET model_id = 'another-model'
      WHERE workspace_id = ${workspaceId} AND run_id = 'control-drift' AND task_id = 'codex-item-0' AND arm = 'managed-only'`;
    expect((await getManagedCapabilityEffectiveness('control-drift', scope())).issues[0]).toMatch(/^rollout-witness-unverified:/);
    await sql`UPDATE harness_shared.benchmark_run_result SET model_id = 'claude-opus-4-8[1m]'
      WHERE workspace_id = ${workspaceId} AND run_id = 'control-drift' AND task_id = 'codex-item-0' AND arm = 'managed-only'`;
    await sql`UPDATE harness_shared.benchmark_rollout SET env_fingerprint =
      jsonb_set(env_fingerprint, '{toolMode}', '"native"'::jsonb)
      WHERE workspace_id = ${workspaceId} AND run_id = 'control-drift' AND task_id = 'codex-item-0' AND arm = 'managed-only'`;
    expect((await getManagedCapabilityEffectiveness('control-drift', scope())).verdict).toBe('unknown');
  });

  it('cannot pass by ignoring failures, increased token cost, or missing cache measurements', async () => {
    await seed('control-metrics');
    expect((await getManagedCapabilityEffectiveness('control-metrics', scope())).verdict).toBe('pass');
    await sql`UPDATE harness_shared.benchmark_run_result SET resolved = false
      WHERE workspace_id = ${workspaceId} AND run_id = 'control-metrics'
      AND task_id IN ('omp-item-0', 'omp-item-1') AND arm = 'managed-only'`;
    expect((await getManagedCapabilityEffectiveness('control-metrics', scope())).verdict).toBe('fail');
    await sql`UPDATE harness_shared.benchmark_run_result SET resolved = true, tokens_in = 91, tokens_total = 101
      WHERE workspace_id = ${workspaceId} AND run_id = 'control-metrics' AND arm = 'managed-only'`;
    expect((await getManagedCapabilityEffectiveness('control-metrics', scope())).verdict).toBe('fail');
    await sql`UPDATE harness_shared.benchmark_run_result SET tokens_cache_read = NULL
      WHERE workspace_id = ${workspaceId} AND run_id = 'control-metrics' AND task_id = 'claude-item-0' AND arm = 'managed-only'`;
    expect((await getManagedCapabilityEffectiveness('control-metrics', scope())).verdict).toBe('unknown');
  });

  it('fails closed on uncommitted preregistration and malformed or detached rollout evidence', async () => {
    await seed('control-unverified', 1);
    await sql`UPDATE harness_shared.benchmark_prereg SET git_committed = false
      WHERE workspace_id = ${workspaceId} AND run_id = 'control-unverified'`;
    expect((await getManagedCapabilityEffectiveness('control-unverified', scope())).issues).toContain('preregistration-unverified');
    await sql`UPDATE harness_shared.benchmark_prereg SET git_committed = true
      WHERE workspace_id = ${workspaceId} AND run_id = 'control-unverified'`;
    await sql`UPDATE harness_shared.benchmark_rollout SET env_fingerprint = '{}'::jsonb
      WHERE workspace_id = ${workspaceId} AND run_id = 'control-unverified' AND task_id = 'claude-item-0'`;
    expect((await getManagedCapabilityEffectiveness('control-unverified', scope())).issues[0]).toMatch(/^rollout-witness-unverified:/);
  });
});
