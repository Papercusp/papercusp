/**
 * R-17 / P-028: evaluate matched real-plan replays from the existing benchmark
 * ledger. This is an evaluator, not a runner, receipt authenticator or cutover
 * authority. The caller must resolve preregistration, rollout and grader records
 * before constructing these inputs. Fixture tests do not establish a live trial.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { classifyAttemptOutcome, type TaskRunResult } from '@papercusp/bench-metrics';
import { CAPABILITY_CLIENT_ENFORCEMENT, type CapabilityClientFamily } from './managed-capability-policy';
import type { ManagedCapabilityFamilyId } from './managed-capability-contract';

export const MANAGED_TRIAL_MIN_ITEMS = 30;
export const MANAGED_TRIAL_MAX_SUCCESS_GAP = 0.05;
export type ManagedTrialArm = 'native' | 'managed-only';
export type ManagedTrialVerdict = 'pass' | 'fail' | 'unknown';

export interface ManagedTrialAssignment {
  client: CapabilityClientFamily;
  clientVersion: string;
  modelId: string;
  taskId: string;
  seed: number;
  planSlug: string;
  itemId: string;
  preImplementationCommit: string;
  graderTestPaths: readonly string[];
  families: readonly ManagedCapabilityFamilyId[];
}

/** Resolved from the committed benchmark preregistration, never inferred from runs. */
export interface ManagedTrialManifest {
  runId: string;
  preregHash: string;
  registeredAt: string;
  registrationCommit: string;
  sharedCheckoutRealpath: string;
  assignments: readonly ManagedTrialAssignment[];
}

/** Actual execution observations accompanying an existing TaskRunResult. */
export interface ManagedTrialRun {
  result: TaskRunResult;
  witness: {
    client: CapabilityClientFamily;
    clientVersion: string;
    toolMode: ManagedTrialArm;
    sourceCommit: string;
    checkoutRealpath: string;
    environmentHash: string;
    startedAt: string;
    graderTestPaths: readonly string[];
    toolCalls: number;
    errors: number;
    retries: number;
    refusals: number;
  };
}

export interface ManagedTrialMetrics {
  successes: number;
  medianTokensPerSuccess: number | null;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  wallClockMs: number;
  toolCalls: number;
  errors: number;
  retries: number;
  refusals: number;
}

const arms = ['native', 'managed-only'] as const;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const instant = (value: string) => Date.parse(value);
const key = (client: string, task: string, seed: number, arm?: string) => JSON.stringify([client, task, seed, arm]);
const samePaths = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function isIsolated(checkout: string, shared: string): boolean {
  if (!isAbsolute(checkout) || !isAbsolute(shared)) return false;
  const path = relative(resolve(shared), resolve(checkout));
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function metrics(rows: readonly ManagedTrialRun[]): ManagedTrialMetrics {
  const successful = rows.filter(row =>
    ['scored', 'budget_exhausted'].includes(classifyAttemptOutcome(row.result)) && row.result.resolved === true);
  const sum = (read: (row: ManagedTrialRun) => number) => rows.reduce((total, row) => total + read(row), 0);
  return {
    successes: successful.length,
    medianTokensPerSuccess: median(successful.map(row => row.result.tokensTotal)),
    tokensIn: sum(row => row.result.tokensIn),
    tokensOut: sum(row => row.result.tokensOut),
    tokensCacheRead: sum(row => row.result.tokensCacheRead!),
    tokensCacheWrite: sum(row => row.result.tokensCacheWrite!),
    wallClockMs: sum(row => row.result.wallClockMs),
    toolCalls: sum(row => row.witness.toolCalls),
    errors: sum(row => row.witness.errors),
    retries: sum(row => row.witness.retries),
    refusals: sum(row => row.witness.refusals),
  };
}

export function evaluateManagedCapabilityEffectiveness(manifest: ManagedTrialManifest, runs: readonly ManagedTrialRun[]) {
  const issues: string[] = [];
  const registeredAt = instant(manifest.registeredAt);
  if (!nonempty(manifest.runId) || !/^[a-f0-9]{64}$/.test(manifest.preregHash) ||
      !/^[a-f0-9]{40}$/.test(manifest.registrationCommit) || !Number.isFinite(registeredAt) ||
      !isAbsolute(manifest.sharedCheckoutRealpath)) issues.push('preregistration-unmeasured');

  const expected = new Map<string, ManagedTrialAssignment>();
  const planItems = new Set<string>();
  for (const assignment of manifest.assignments) {
    const id = key(assignment.client, assignment.taskId, assignment.seed);
    const planItem = JSON.stringify([assignment.client, assignment.planSlug, assignment.itemId]);
    if (expected.has(id) || planItems.has(planItem)) issues.push(`duplicate-assignment:${id}`);
    expected.set(id, assignment);
    planItems.add(planItem);
    if (!Object.hasOwn(CAPABILITY_CLIENT_ENFORCEMENT, assignment.client) ||
        ![assignment.taskId, assignment.planSlug, assignment.clientVersion, assignment.modelId].every(nonempty) ||
        !/^P-\d{3,}$/.test(assignment.itemId) || !count(assignment.seed) ||
        !/^[a-f0-9]{40}$/.test(assignment.preImplementationCommit) ||
        !assignment.graderTestPaths.length || !assignment.graderTestPaths.every(nonempty) || !assignment.families.length) {
      issues.push(`assignment-unmeasured:${id}`);
    }
  }

  const byCell = new Map<string, ManagedTrialRun>();
  const rolloutIds = new Set<string>();
  for (const run of runs) {
    const { result, witness } = run;
    const assignmentId = key(witness.client, result.taskId, result.seed);
    const id = key(witness.client, result.taskId, result.seed, result.arm);
    const assignment = expected.get(assignmentId);
    if (!assignment || !arms.some(arm => arm === result.arm)) {
      issues.push(`unassigned-run:${id}`);
      continue;
    }
    if (byCell.has(id) || rolloutIds.has(result.rolloutId)) issues.push(`duplicate-run:${id}`);
    byCell.set(id, run);
    rolloutIds.add(result.rolloutId);
    if (result.runId !== manifest.runId || result.preregHash !== manifest.preregHash ||
        result.modelId !== assignment.modelId || witness.clientVersion !== assignment.clientVersion ||
        witness.toolMode !== result.arm || witness.sourceCommit !== assignment.preImplementationCommit ||
        !samePaths(witness.graderTestPaths, assignment.graderTestPaths) ||
        !nonempty(result.rolloutId) || !nonempty(result.rawGraderOutputRef) || !nonempty(witness.environmentHash) ||
        !isIsolated(witness.checkoutRealpath, manifest.sharedCheckoutRealpath) ||
        !Number.isFinite(instant(witness.startedAt)) || instant(witness.startedAt) < registeredAt) {
      issues.push(`execution-mismatch:${id}`);
    }
    // The benchmark writer derives tokensTotal from input + output; cache fields
    // remain separately reported. Unknown cache usage cannot silently become zero.
    if (![result.tokensIn, result.tokensOut, result.tokensTotal, result.tokensCacheRead, result.tokensCacheWrite,
      result.wallClockMs, witness.toolCalls, witness.errors, witness.retries, witness.refusals].every(count) ||
      result.tokensTotal !== result.tokensIn + result.tokensOut) issues.push(`metrics-unmeasured:${id}`);
    const outcome = classifyAttemptOutcome(result);
    if (!['completed', 'error', 'timeout'].includes(result.generationStatus) ||
        ['invalid', 'grader_error'].includes(outcome) ||
        (outcome !== 'generation_failed' && typeof result.resolved !== 'boolean')) {
      issues.push(`grading-unmeasured:${id}`);
    }
  }

  const clients = (Object.keys(CAPABILITY_CLIENT_ENFORCEMENT) as CapabilityClientFamily[]).map(client => {
    const assignments = manifest.assignments.filter(assignment => assignment.client === client);
    const clientIssues: string[] = [];
    const native: ManagedTrialRun[] = [], managed: ManagedTrialRun[] = [];
    if (assignments.length < MANAGED_TRIAL_MIN_ITEMS) clientIssues.push('insufficient-distinct-plan-items');
    for (const assignment of assignments) {
      const pair = arms.map(arm => byCell.get(key(client, assignment.taskId, assignment.seed, arm)));
      if (!pair[0] || !pair[1]) {
        clientIssues.push(`missing-pair:${assignment.taskId}`);
        continue;
      }
      if (pair[0].witness.environmentHash !== pair[1].witness.environmentHash ||
          pair[0].result.graderFamily !== pair[1].result.graderFamily ||
          pair[0].result.graderVersion !== pair[1].result.graderVersion ||
          pair[0].result.budgetTokens !== pair[1].result.budgetTokens ||
          resolve(pair[0].witness.checkoutRealpath) === resolve(pair[1].witness.checkoutRealpath)) {
        clientIssues.push(`unmatched-controls:${assignment.taskId}`);
      }
      native.push(pair[0]); managed.push(pair[1]);
    }
    // Never compute a headline from an incomplete or malformed retained subset.
    if (issues.length || clientIssues.length) return {
      client, verdict: 'unknown' as ManagedTrialVerdict, assignedItems: assignments.length,
      matchedPairs: native.length, issues: clientIssues, native: null, managed: null,
    };
    const nativeMetrics = metrics(native), managedMetrics = metrics(managed);
    const successGap = (nativeMetrics.successes - managedMetrics.successes) / assignments.length;
    const tokenMeasured = nativeMetrics.medianTokensPerSuccess !== null && managedMetrics.medianTokensPerSuccess !== null;
    const successPass = successGap <= MANAGED_TRIAL_MAX_SUCCESS_GAP + Number.EPSILON;
    const tokenPass = tokenMeasured && managedMetrics.medianTokensPerSuccess! <= nativeMetrics.medianTokensPerSuccess!;
    const verdict: ManagedTrialVerdict = !successPass || (tokenMeasured && !tokenPass) ? 'fail'
      : tokenMeasured ? 'pass' : 'unknown';
    return { client, verdict, assignedItems: assignments.length, matchedPairs: native.length,
      issues: tokenMeasured ? [] : ['completion-token-median-unmeasured'],
      native: nativeMetrics, managed: managedMetrics, successGap };
  });
  const verdict: ManagedTrialVerdict = clients.some(client => client.verdict === 'fail') ? 'fail'
    : issues.length || clients.some(client => client.verdict === 'unknown') ? 'unknown' : 'pass';
  return { verdict, issues, clients };
}
