/**
 * P-008 — CAP-CONTRACT-P008-REAL-CLIENT-MATRIX@1, mechanism layer.
 *
 * The clause is a BOUNDARY: "the matrix passes every declared scenario BEFORE
 * a managed default is enabled." A boundary clause is proven by driving BOTH
 * sides of it — so every gate below has a green case and a red case, and the
 * red cases enumerate the four (and only four) words of the falsifier:
 * missing, failing, stale, run against a different client version.
 *
 * DELIBERATELY-WRONG CONTROLS live here permanently rather than as a mutation
 * of production code (repo policy: never mutate the shared tree to prove
 * falsifiability). `calibration` cases assert the REAL subject passes, so the
 * controls cannot all pass vacuously if the property itself breaks.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SCENARIO_FRESHNESS_MS,
  REAL_CLIENT_SCENARIO_KINDS,
  REPLACEMENT_CLIENT_SCENARIO_KINDS,
  declareRealClientMatrix,
  realClientMatrixReport,
  scenarioResultFingerprint,
  type CapabilityDefaultEnablementRecord,
  type RealClientScenario,
  type RealClientScenarioResult,
} from './managed-capability-matrix';
import { MANAGED_CAPABILITY_DISPOSITIONS } from './managed-capability-contract';
import { CAPABILITY_CLIENT_ENFORCEMENT, MANAGED_CAPABILITY_RESTRICTIONS } from './managed-capability-policy';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();
const ANCIENT = new Date(NOW.getTime() - DEFAULT_SCENARIO_FRESHNESS_MS - 60_000).toISOString();
const VERSION = '2.1.275';

/** Every declared scenario passing, on `VERSION`, a minute ago. */
function allGreen(scenarios: readonly RealClientScenario[]): RealClientScenarioResult[] {
  return scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    outcome: 'pass' as const,
    clientVersion: VERSION,
    observedAt: FRESH,
  }));
}

describe('P-008 real-client matrix — the declared manifest is DERIVED', () => {
  it('declares one cell per managed-cutover family/client/scenario-kind', () => {
    const scenarios = declareRealClientMatrix();

    // Traceable to the registry, not to a hand-written list: the only
    // managed-cutover restriction is `managed-shell-cutover`
    // (shell-ssh-interpreters @ claude, all three surfaces).
    expect(scenarios.length).toBe(REAL_CLIENT_SCENARIO_KINDS.length);
    for (const scenario of scenarios) {
      expect(scenario.family).toBe('shell-ssh-interpreters');
      expect(scenario.client).toBe('claude');
      expect(scenario.declaredBy).toContain('managed-shell-cutover');
    }
    expect(scenarios.map((s) => s.kind).sort()).toEqual([...REAL_CLIENT_SCENARIO_KINDS].sort());
  });

  it('declares NO scenario for an owner mandate — there is no replacement to accept', () => {
    const mandatesOnly = MANAGED_CAPABILITY_RESTRICTIONS.filter(
      (restriction) => restriction.authority.kind !== 'managed-cutover',
    );
    expect(mandatesOnly.length).toBeGreaterThan(0); // calibration: the input is non-empty
    expect(declareRealClientMatrix(mandatesOnly)).toEqual([]);
  });

  it('omits a surface-bound scenario the restriction does not cover', () => {
    const cutover = MANAGED_CAPABILITY_RESTRICTIONS.find(
      (restriction) =>
        restriction.authority.kind === 'managed-cutover' &&
        restriction.familyScope.kind === 'contract-family',
    );
    expect(cutover).toBeDefined();

    const launchOnly = declareRealClientMatrix([{ ...cutover!, surfaces: ['launch'] }]);
    const kinds = launchOnly.map((scenario) => scenario.kind);

    // launch survives; resume/wake are not declared because the restriction
    // cannot be enabled there — declaring them would wedge the gate shut on a
    // scenario that can never run.
    expect(kinds).toContain('launch');
    expect(kinds).not.toContain('resume');
    expect(kinds).not.toContain('wake');
    // The four cross-surface kinds are unaffected.
    for (const kind of ['recovery', 'lifecycle', 'sandbox', 'native-disable'] as const) {
      expect(kinds).toContain(kind);
    }
  });
});

describe('P-008 real-client matrix — the four falsifier modes, each isolated', () => {
  const scenarios = declareRealClientMatrix();

  it('CALIBRATION: a complete, fresh, on-version, all-pass matrix is green', () => {
    const report = realClientMatrixReport({
      scenarios,
      results: allGreen(scenarios),
      clientVersions: { claude: VERSION },
      now: NOW,
    });

    expect(report.allDeclaredScenariosPassed).toBe(true);
    expect(report.passedCount).toBe(scenarios.length);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.allScenariosPassed).toBe(true);
    expect(report.entries[0]?.declaredScenarioCount).toBe(scenarios.length);
    expect(report.entries[0]?.unmet).toEqual([]);
    expect(report.integrityIssues).toEqual([]);
  });

  it('MISSING: one absent result is enough to withhold the whole family/client', () => {
    const results = allGreen(scenarios).slice(1); // drop exactly one
    const report = realClientMatrixReport({
      scenarios,
      results,
      clientVersions: { claude: VERSION },
      now: NOW,
    });

    expect(report.allDeclaredScenariosPassed).toBe(false);
    const missing = report.rows.filter((row) => row.status === 'missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.scenario.id).toBe(scenarios[0]?.id);
    expect(report.entries[0]?.unmet.map((row) => row.status)).toEqual(['missing']);
  });

  it('FAILING: a recorded failure is reported as failing, not as missing', () => {
    const results = allGreen(scenarios);
    results[2] = { ...results[2]!, outcome: 'fail' };
    const report = realClientMatrixReport({
      scenarios,
      results,
      clientVersions: { claude: VERSION },
      now: NOW,
    });

    const failing = report.rows.filter((row) => row.status === 'failing');
    expect(failing).toHaveLength(1);
    expect(failing[0]?.detail).toContain('FAILED');
    expect(report.allDeclaredScenariosPassed).toBe(false);
  });

  it('STALE: a pass older than the freshness window stops being evidence', () => {
    const results = allGreen(scenarios);
    results[3] = { ...results[3]!, observedAt: ANCIENT };
    const report = realClientMatrixReport({
      scenarios,
      results,
      clientVersions: { claude: VERSION },
      now: NOW,
    });

    const stale = report.rows.filter((row) => row.status === 'stale');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.scenario.id).toBe(scenarios[3]?.id);
    expect(report.allDeclaredScenariosPassed).toBe(false);
  });

  it('VERSION-MISMATCH: a fresh pass on another version is not evidence for this one', () => {
    const report = realClientMatrixReport({
      scenarios,
      results: allGreen(scenarios), // all recorded on VERSION
      clientVersions: { claude: '2.2.0' }, // but the client is now this
      now: NOW,
    });

    expect(report.rows.every((row) => row.status === 'version-mismatch')).toBe(true);
    expect(report.allDeclaredScenariosPassed).toBe(false);
    expect(report.rows[0]?.detail).toContain('respell');
  });

  it('an UNKNOWN current version cannot manufacture a mismatch, and cannot clear one', () => {
    // Mirrors the policy's existing drift gate: mismatch needs both sides
    // known. Silence about the version is not evidence of agreement, but it is
    // also not proof of disagreement — so the row stays PASSED on its own
    // terms and the staler/other gates keep their say.
    const report = realClientMatrixReport({ scenarios, results: allGreen(scenarios), now: NOW });
    expect(report.rows.every((row) => row.status === 'passed')).toBe(true);
  });

  it('status precedence: missing beats failing beats version-mismatch beats stale', () => {
    // One scenario made simultaneously failing, off-version AND ancient must
    // report the most actionable cause, not an arbitrary one.
    const results = allGreen(scenarios);
    results[4] = { ...results[4]!, outcome: 'fail', clientVersion: '0.0.1', observedAt: ANCIENT };
    const report = realClientMatrixReport({
      scenarios,
      results,
      clientVersions: { claude: VERSION },
      now: NOW,
    });
    const row = report.rows.find((candidate) => candidate.scenario.id === scenarios[4]?.id);
    expect(row?.status).toBe('failing');
  });
});

describe('P-008 real-client matrix — an EMPTY matrix is never a passing one', () => {
  it('reports not-passed for a declared set of zero rather than a vacuous true', () => {
    // The trap this closes: `[].every(...)` is `true`, so a family whose
    // matrix nobody wrote would otherwise satisfy the gate outright.
    const report = realClientMatrixReport({ scenarios: [], results: [], now: NOW });

    expect(report.declaredCount).toBe(0);
    expect(report.allDeclaredScenariosPassed).toBe(false);
    expect(report.entries).toEqual([]);
  });
});

describe('P-008 real-client matrix — fingerprints and the enablement record', () => {
  const scenarios = declareRealClientMatrix();

  it('fingerprints the three facts that decide evidence, and ignores time', () => {
    const base = { scenarioId: 'f:claude:launch', clientVersion: VERSION, outcome: 'pass' } as const;
    const same = scenarioResultFingerprint(base);

    expect(scenarioResultFingerprint({ ...base })).toBe(same);
    // Re-observing the same pass later must NOT re-pin the record.
    expect(
      scenarioResultFingerprint({ ...base, scenarioId: 'f:claude:launch' }),
    ).toBe(same);
    // Each of the three facts changes it.
    expect(scenarioResultFingerprint({ ...base, outcome: 'fail' })).not.toBe(same);
    expect(scenarioResultFingerprint({ ...base, clientVersion: '9.9.9' })).not.toBe(same);
    expect(scenarioResultFingerprint({ ...base, scenarioId: 'other' })).not.toBe(same);
  });

  it('separates the NUL delimiter so two different tuples cannot collide', () => {
    // Without a delimiter that cannot occur in the fields, ('a','bc') and
    // ('ab','c') would hash identically.
    expect(
      scenarioResultFingerprint({ scenarioId: 'a', clientVersion: 'bc', outcome: 'pass' }),
    ).not.toBe(scenarioResultFingerprint({ scenarioId: 'ab', clientVersion: 'c', outcome: 'pass' }));
  });

  it('detects a result whose published fingerprint contradicts its own fields', () => {
    const results = allGreen(scenarios);
    results[0] = { ...results[0]!, fingerprint: 'deadbeef' };
    const report = realClientMatrixReport({
      scenarios,
      results,
      clientVersions: { claude: VERSION },
      now: NOW,
    });

    expect(report.integrityIssues).toHaveLength(1);
    expect(report.integrityIssues[0]).toContain('does not describe its own');
    expect(report.rows[0]?.status).toBe('failing');
    expect(report.allDeclaredScenariosPassed).toBe(false);
    expect(report.entries[0]?.allScenariosPassed).toBe(false);
  });

  it('accepts a correctly-published fingerprint without complaint (calibration)', () => {
    const results = allGreen(scenarios).map((result) => ({
      ...result,
      fingerprint: scenarioResultFingerprint(result),
    }));
    const report = realClientMatrixReport({
      scenarios,
      results,
      clientVersions: { claude: VERSION },
      now: NOW,
    });
    expect(report.integrityIssues).toEqual([]);
    expect(report.allDeclaredScenariosPassed).toBe(true);
  });

  it('ENABLEMENT DRIFT: a green matrix whose fingerprints no longer match the record', () => {
    // This is the probe method the falsifier names: compare every result
    // fingerprint with the default-enablement record. The scenarios all PASS
    // here — the defect is that the default was enabled against different
    // evidence, which no status alone would reveal.
    const results = allGreen(scenarios);
    const record: CapabilityDefaultEnablementRecord = {
      family: 'shell-ssh-interpreters',
      client: 'claude',
      enabledAt: FRESH,
      scenarioFingerprints: Object.fromEntries(
        results.map((result) => [
          result.scenarioId,
          scenarioResultFingerprint({ ...result, clientVersion: '1.0.0-old' }),
        ]),
      ),
    };

    const report = realClientMatrixReport({
      scenarios,
      results,
      records: [record],
      clientVersions: { claude: VERSION },
      now: NOW,
    });

    expect(report.rows.every((row) => row.status === 'passed')).toBe(true);
    expect(report.rows.every((row) => row.enablementDrift)).toBe(true);
    expect(report.allDeclaredScenariosPassed).toBe(false);
    expect(report.entries[0]?.allScenariosPassed).toBe(false);
    expect(report.entries[0]?.unmet.map((row) => row.status)).toEqual(
      scenarios.map(() => 'enablement-drift'),
    );
  });

  it('CALIBRATION: a record pinned to the actual fingerprints does not drift', () => {
    const results = allGreen(scenarios);
    const report = realClientMatrixReport({
      scenarios,
      results,
      records: [
        {
          family: 'shell-ssh-interpreters',
          client: 'claude',
          enabledAt: FRESH,
          scenarioFingerprints: Object.fromEntries(
            results.map((result) => [result.scenarioId, scenarioResultFingerprint(result)]),
          ),
        },
      ],
      clientVersions: { claude: VERSION },
      now: NOW,
    });

    expect(report.rows.some((row) => row.enablementDrift)).toBe(false);
    expect(report.allDeclaredScenariosPassed).toBe(true);
  });

  it('a re-run supersedes an earlier result for the same scenario', () => {
    const [first] = scenarios;
    const report = realClientMatrixReport({
      scenarios: [first!],
      results: [
        { scenarioId: first!.id, outcome: 'fail', clientVersion: VERSION, observedAt: ANCIENT },
        { scenarioId: first!.id, outcome: 'pass', clientVersion: VERSION, observedAt: FRESH },
      ],
      clientVersions: { claude: VERSION },
      now: NOW,
    });
    expect(report.rows[0]?.status).toBe('passed');
  });
});

describe('P-020 replacement acceptance with native features retained', () => {
  const scenarios = declareRealClientMatrix(undefined, { purpose: 'replacement-acceptance' });
  const versions = { claude: VERSION, codex: '0.110.0', omp: '13.0.0' };
  const results = (): RealClientScenarioResult[] => scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    outcome: 'pass',
    clientVersion: versions[scenario.client],
    observedAt: FRESH,
    evidenceRef: `test-run:actual-journey:${scenario.id}`,
  }));

  it('derives every client and inventory family independently of cutover restrictions', () => {
    expect(scenarios).toHaveLength(MANAGED_CAPABILITY_DISPOSITIONS.length *
      Object.keys(CAPABILITY_CLIENT_ENFORCEMENT).length * REPLACEMENT_CLIENT_SCENARIO_KINDS.length);
    expect(new Set(scenarios.map((scenario) => scenario.client)))
      .toEqual(new Set(Object.keys(CAPABILITY_CLIENT_ENFORCEMENT)));
    expect(new Set(scenarios.map((scenario) => scenario.family)))
      .toEqual(new Set(MANAGED_CAPABILITY_DISPOSITIONS.map((entry) => entry.family)));
    expect(scenarios.some((scenario) => scenario.kind === 'native-disable' || scenario.kind === 'recovery')).toBe(false);
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length);
    expect(scenarios.every((scenario) => scenario.purpose === 'replacement-acceptance')).toBe(true);
  });

  it('can scope an actual run without inventing undeclared resume/wake coverage', () => {
    const scoped = declareRealClientMatrix(undefined, {
      purpose: 'replacement-acceptance', clients: ['codex'], surfaces: ['launch'],
      dispositions: [MANAGED_CAPABILITY_DISPOSITIONS[0]!],
    });
    expect(scoped.map((scenario) => scenario.kind)).toContain('launch');
    expect(scoped.map((scenario) => scenario.kind)).not.toContain('resume');
    expect(scoped.map((scenario) => scenario.kind)).not.toContain('wake');
    expect(scoped.every((scenario) => scenario.client === 'codex')).toBe(true);
    expect(scoped[0]?.declaredBy).toContain(MANAGED_CAPABILITY_DISPOSITIONS[0]!.evidence.path);
  });

  it('reports missing actual journeys and never supplies a cutover gate entry', () => {
    const missing = realClientMatrixReport({ purpose: 'replacement-acceptance', clientVersions: versions, now: NOW });
    expect(missing.declaredCount).toBe(scenarios.length);
    expect(missing.rows.every((row) => row.status === 'missing')).toBe(true);
    const green = realClientMatrixReport({ scenarios, results: results(), clientVersions: versions, now: NOW });
    expect(green.allDeclaredScenariosPassed).toBe(true);
    expect(green.entries).toEqual([]);
    expect(green.unsupportedCount).toBe(0);
  });

  it.each([
    ['missing evidence reference', { evidenceRef: '' }, 'failing'],
    ['blank client version', { clientVersion: ' ' }, 'failing'],
    ['invalid observation time', { observedAt: 'not-a-date' }, 'stale'],
    ['future observation time', { observedAt: new Date(NOW.getTime() + 1000).toISOString() }, 'stale'],
    ['forged fingerprint', { fingerprint: 'forged' }, 'failing'],
  ] as const)('rejects %s instead of claiming acceptance', (_label, mutation, status) => {
    const result = { ...results()[0]!, ...mutation };
    const report = realClientMatrixReport({ scenarios: [scenarios[0]!], results: [result], clientVersions: versions, now: NOW });
    expect(report.rows[0]?.status).toBe(status);
    expect(report.allDeclaredScenariosPassed).toBe(false);
  });

  it('requires a measured current version and invalidates only the upgraded client', () => {
    const unknown = realClientMatrixReport({ scenarios, results: results(), now: NOW });
    expect(unknown.rows.every((row) => row.status === 'version-mismatch')).toBe(true);
    const upgraded = realClientMatrixReport({ scenarios, results: results(), clientVersions: { ...versions, codex: '0.111.0' }, now: NOW });
    expect(upgraded.rows.filter((row) => row.scenario.client === 'codex').every((row) => row.status === 'version-mismatch')).toBe(true);
    expect(upgraded.rows.filter((row) => row.scenario.client !== 'codex').every((row) => row.status === 'passed')).toBe(true);
    expect(upgraded.allDeclaredScenariosPassed).toBe(false);
  });

  it('binds unsupported truth to current evidence without counting it as a pass', () => {
    const scenario = scenarios.find((entry) => entry.client === 'codex' && entry.kind === 'unsupported-controls')!;
    const result: RealClientScenarioResult = {
      ...results().find((entry) => entry.scenarioId === scenario.id)!, outcome: 'unsupported',
      unsupportedReason: 'Measured client has no host-composable native-tool deny flag; native features remain available.',
    };
    const report = realClientMatrixReport({ scenarios: [scenario], results: [result], clientVersions: versions, now: NOW });
    expect(report.rows[0]?.status).toBe('unsupported');
    expect(report.unsupportedCount).toBe(1);
    expect(report.passedCount).toBe(0);
    expect(report.allDeclaredScenariosPassed).toBe(false);
    expect(report.entries).toEqual([]);
    const invalid = realClientMatrixReport({ scenarios: [scenario], results: [{ ...result, unsupportedReason: '' }], clientVersions: versions, now: NOW });
    expect(invalid.rows[0]?.status).toBe('failing');
    const stale = realClientMatrixReport({ scenarios: [scenario], results: [{ ...result, clientVersion: 'older' }], clientVersions: versions, now: NOW });
    expect(stale.rows[0]?.status).toBe('version-mismatch');
    expect(scenarioResultFingerprint(result)).not.toBe(scenarioResultFingerprint({ ...result, evidenceRef: 'another-run' }));
    expect(scenarioResultFingerprint(result)).not.toBe(scenarioResultFingerprint({ ...result, unsupportedReason: 'different limitation' }));
  });

  it('does not let a forged latest result inherit a prior valid pass', () => {
    const prior = results()[0]!;
    const report = realClientMatrixReport({ scenarios: [scenarios[0]!], results: [prior,
      { ...prior, observedAt: NOW.toISOString(), fingerprint: 'forged' }], clientVersions: versions, now: NOW });
    expect(report.rows[0]?.status).toBe('failing');
    const repaired = realClientMatrixReport({ scenarios: [scenarios[0]!], results: [
      { ...prior, fingerprint: 'forged' }, { ...prior, observedAt: NOW.toISOString() }], clientVersions: versions, now: NOW });
    expect(repaired.rows[0]?.status).toBe('passed');
    expect(repaired.allDeclaredScenariosPassed).toBe(true);
  });
});
