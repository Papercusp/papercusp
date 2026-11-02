import { describe, expect, it } from 'vitest';
import type { TaskRunResult } from '@papercusp/bench-metrics';
import { evaluateManagedCapabilityEffectiveness,
  type ManagedTrialManifest, type ManagedTrialRun } from './managed-capability-effectiveness';
import { CAPABILITY_CLIENT_ENFORCEMENT, type CapabilityClientFamily } from './managed-capability-policy';

/** Synthetic evaluator fixtures only: these are never published as live trial proof. */
function fixture(items = 30) {
  const clients = Object.keys(CAPABILITY_CLIENT_ENFORCEMENT) as CapabilityClientFamily[];
  const manifest: ManagedTrialManifest = {
    runId: 'fixture-trial', preregHash: 'a'.repeat(64), registrationCommit: 'b'.repeat(40),
    registeredAt: '2026-11-01T00:00:00Z', sharedCheckoutRealpath: '/shared/papercusp',
    assignments: clients.flatMap(client => Array.from({ length: items }, (_, index) => ({
      client, clientVersion: 'fixture-version', modelId: 'fixture-model', taskId: `task-${index}`,
      seed: 0, planSlug: 'fixture-plan', itemId: `P-${String(index + 1).padStart(3, '0')}`,
      preImplementationCommit: 'c'.repeat(40), graderTestPaths: ['src/own.test.ts'],
      families: ['shell-ssh-interpreters'] as const,
    }))),
  };
  const runs: ManagedTrialRun[] = manifest.assignments.flatMap(assignment =>
    (['native', 'managed-only'] as const).map(arm => ({
      result: {
        runId: manifest.runId, suite: 'harness-bench', modality: 'diff', taskId: assignment.taskId,
        arm, seed: 0, resolved: true, graderStatus: 'passed', graderFamily: 'own-tests', graderVersion: 'c'.repeat(40),
        tokensIn: 90, tokensOut: 10, tokensTotal: 100, tokensCacheRead: 20, tokensCacheWrite: 5,
        costUsd: 0.01, priceTableVersion: 'fixture-prices', wallClockMs: 1000, turns: 2,
        capped: false, generationStatus: 'completed', modelId: assignment.modelId,
        harnessVersion: 'fixture-harness', preregHash: manifest.preregHash,
        rolloutId: `${assignment.client}:${assignment.taskId}:${arm}`, rawGraderOutputRef: 'fixture:grader',
        createdAt: '2026-11-01T01:00:00Z',
      } satisfies TaskRunResult,
      witness: {
        client: assignment.client, clientVersion: assignment.clientVersion, toolMode: arm,
        sourceCommit: assignment.preImplementationCommit,
        checkoutRealpath: `/isolated/${assignment.client}/${assignment.taskId}/${arm}`,
        environmentHash: 'fixture-environment', startedAt: '2026-11-01T00:30:00Z',
        graderTestPaths: assignment.graderTestPaths, toolCalls: 4, errors: 1, retries: 1, refusals: 0,
      },
    })));
  return { manifest, runs };
}

describe('managed capability real-plan effectiveness evaluator (synthetic controls)', () => {
  it('evaluates all registered clients and preserves the measured metrics', () => {
    const { manifest, runs } = fixture();
    const report = evaluateManagedCapabilityEffectiveness(manifest, runs);
    expect(report.verdict).toBe('pass');
    expect(report.clients.map(row => row.client)).toEqual(Object.keys(CAPABILITY_CLIENT_ENFORCEMENT));
    for (const row of report.clients) {
      expect(row).toMatchObject({ assignedItems: 30, matchedPairs: 30, verdict: 'pass', successGap: 0,
        managed: { successes: 30, medianTokensPerSuccess: 100, tokensIn: 2700, tokensOut: 300,
          tokensCacheRead: 600, tokensCacheWrite: 150, wallClockMs: 30000, toolCalls: 120, errors: 30, retries: 30, refusals: 0 } });
    }
  });

  it('does not let empty, undersized or missing-client trials pass', () => {
    for (const items of [0, 29]) {
      const { manifest, runs } = fixture(items);
      expect(evaluateManagedCapabilityEffectiveness(manifest, runs).verdict).toBe('unknown');
    }
    const { manifest, runs } = fixture();
    manifest.assignments = manifest.assignments.filter(row => row.client !== 'omp');
    expect(evaluateManagedCapabilityEffectiveness(manifest, runs.filter(row => row.witness.client !== 'omp')).verdict).toBe('unknown');
  });

  it('keeps the assigned denominator when generation fails instead of dropping failed attempts', () => {
    const { manifest, runs } = fixture();
    const managed = runs.filter(row => row.witness.client === 'codex' && row.result.arm === 'managed-only');
    managed[0]!.result.generationStatus = 'error'; managed[0]!.result.resolved = null;
    expect(evaluateManagedCapabilityEffectiveness(manifest, runs).verdict).toBe('pass');
    managed[1]!.result.generationStatus = 'timeout'; managed[1]!.result.resolved = null;
    const report = evaluateManagedCapabilityEffectiveness(manifest, runs);
    expect(report.verdict).toBe('fail');
    expect(report.clients.find(row => row.client === 'codex')).toMatchObject({ assignedItems: 30, managed: { successes: 28 } });
  });

  it('accepts exactly five percentage points, and rejects a larger success deficit', () => {
    const { manifest, runs } = fixture(40);
    const managed = runs.filter(row => row.witness.client === 'omp' && row.result.arm === 'managed-only');
    managed[0]!.result.resolved = false; managed[1]!.result.resolved = false;
    expect(evaluateManagedCapabilityEffectiveness(manifest, runs).verdict).toBe('pass');
    managed[2]!.result.resolved = false;
    expect(evaluateManagedCapabilityEffectiveness(manifest, runs).verdict).toBe('fail');
  });

  it('uses canonical generation-failure classification even when a stale resolved flag says true', () => {
    const { manifest, runs } = fixture();
    const managed = runs.filter(row => row.witness.client === 'codex' && row.result.arm === 'managed-only');
    for (const row of managed.slice(0, 2)) row.result.generationError = 'observed agent crash';
    expect(evaluateManagedCapabilityEffectiveness(manifest, runs).verdict).toBe('fail');
  });

  it('uses the median per successful completion and catches increased token consumption', () => {
    const { manifest, runs } = fixture();
    const managed = runs.filter(row => row.witness.client === 'claude' && row.result.arm === 'managed-only');
    managed[0]!.result.tokensIn = 9990; managed[0]!.result.tokensTotal = 10000;
    expect(evaluateManagedCapabilityEffectiveness(manifest, runs).verdict).toBe('pass');
    for (const row of managed.slice(1, 16)) { row.result.tokensIn = 91; row.result.tokensTotal = 101; }
    expect(evaluateManagedCapabilityEffectiveness(manifest, runs).verdict).toBe('fail');
  });

  it.each([
    ['missing cache accounting', (runs: ManagedTrialRun[]) => { runs[0]!.result.tokensCacheRead = null; }],
    ['non-finite metric', (runs: ManagedTrialRun[]) => { runs[0]!.witness.toolCalls = NaN; }],
    ['inconsistent token total', (runs: ManagedTrialRun[]) => { runs[0]!.result.tokensTotal++; }],
    ['unknown grader outcome', (runs: ManagedTrialRun[]) => { runs[0]!.result.resolved = null; }],
    ['model drift', (runs: ManagedTrialRun[]) => { runs[0]!.result.modelId = 'another-model'; }],
    ['client drift', (runs: ManagedTrialRun[]) => { runs[0]!.witness.clientVersion = 'another-version'; }],
    ['wrong preregistration', (runs: ManagedTrialRun[]) => { runs[0]!.result.preregHash = 'd'.repeat(64); }],
    ['wrong source commit', (runs: ManagedTrialRun[]) => { runs[0]!.witness.sourceCommit = 'd'.repeat(40); }],
    ['wrong task grader', (runs: ManagedTrialRun[]) => { runs[0]!.witness.graderTestPaths = ['other.test.ts']; }],
    ['shared checkout', (runs: ManagedTrialRun[]) => { runs[0]!.witness.checkoutRealpath = '/shared/papercusp/src'; }],
    ['shared normalized checkout', (runs: ManagedTrialRun[]) => { runs[0]!.witness.checkoutRealpath = '/isolated/../shared/papercusp'; }],
    ['generation predates registration', (runs: ManagedTrialRun[]) => { runs[0]!.witness.startedAt = '2026-10-31T00:00:00Z'; }],
    ['unmatched environment', (runs: ManagedTrialRun[]) => { runs[0]!.witness.environmentHash = 'other-environment'; }],
    ['unmatched grader', (runs: ManagedTrialRun[]) => { runs[0]!.result.graderVersion = 'another-grader'; }],
    ['unmatched caps', (runs: ManagedTrialRun[]) => { runs[0]!.result.budgetTokens = 1000; }],
    ['reused checkout', (runs: ManagedTrialRun[]) => { runs[1]!.witness.checkoutRealpath = runs[0]!.witness.checkoutRealpath; }],
  ])('withholds a verdict for %s', (_name, mutate) => {
    const { manifest, runs } = fixture(); mutate(runs);
    expect(evaluateManagedCapabilityEffectiveness(manifest, runs).verdict).toBe('unknown');
  });

  it('does not count retries, duplicate rollouts or aliases as additional real plan items', () => {
    const { manifest, runs } = fixture();
    expect(evaluateManagedCapabilityEffectiveness(manifest, [...runs, runs[0]!]).verdict).toBe('unknown');
    manifest.assignments = [...manifest.assignments, { ...manifest.assignments[0]!, taskId: 'alias-of-same-plan-item' }];
    expect(evaluateManagedCapabilityEffectiveness(manifest, runs).issues.some(issue => issue.startsWith('duplicate-assignment:'))).toBe(true);
  });

  it('withholds a partial roster instead of silently filtering missing or unassigned cells', () => {
    const { manifest, runs } = fixture();
    expect(evaluateManagedCapabilityEffectiveness(manifest, runs.slice(1)).verdict).toBe('unknown');
    runs[0]!.result.taskId = 'not-preregistered';
    expect(evaluateManagedCapabilityEffectiveness(manifest, runs).issues[0]).toContain('unassigned-run:');
  });
});
