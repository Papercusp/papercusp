/**
 * P-008 — CAP-CONTRACT-P008-REAL-CLIENT-MATRIX@1, INTEGRATION layer.
 *
 * The unit layer (`managed-capability-matrix.test.ts`) proves the report
 * classifies each scenario correctly. This layer proves the thing the clause
 * actually asserts: that the classification REACHES THE DECISION — a managed
 * default is not enabled while any declared scenario is missing, failing,
 * stale or on another client version.
 *
 * No mocks and no injected registry: the real `MANAGED_CAPABILITY_RESTRICTIONS`
 * table, the real derivation, the real `resolveCapabilityPolicy`. The only
 * injected values are the ones a real acceptance run would produce (scenario
 * results) and the two dials P-007 already owns (readiness, staging), because
 * without those the upstream gates short-circuit before the matrix is ever
 * consulted — which would make every assertion below vacuously green.
 */

import { describe, expect, it } from 'vitest';

import {
  declareRealClientMatrix,
  realClientMatrixGateSource,
  scenarioResultFingerprint,
  DEFAULT_SCENARIO_FRESHNESS_MS,
  type RealClientScenarioResult,
} from './managed-capability-matrix';
import {
  CONTRACT_CAPABILITY_READINESS,
  resolveCapabilityPolicy,
  type CapabilityPolicyRequest,
  type CapabilityReadinessSource,
} from './managed-capability-policy';

const FAMILY = 'shell-ssh-interpreters';
const RESTRICTION = 'managed-shell-cutover';
const VERSION = '2.1.275';
const NOW = new Date('2026-09-21T12:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

/** Parity proven, so the matrix gate is the one under test. */
const PROVEN: CapabilityReadinessSource = CONTRACT_CAPABILITY_READINESS.map((entry) =>
  entry.family === FAMILY ? { ...entry, cutoverReady: true, openGapIds: [] } : entry,
);

const SCENARIOS = declareRealClientMatrix();

function greenResults(): RealClientScenarioResult[] {
  return SCENARIOS.map((scenario) => ({
    scenarioId: scenario.id,
    outcome: 'pass' as const,
    clientVersion: VERSION,
    observedAt: FRESH,
  }));
}

/** Everything upstream of the matrix gate satisfied. */
function request(
  results: readonly RealClientScenarioResult[],
  extra: Partial<CapabilityPolicyRequest> = {},
): CapabilityPolicyRequest {
  return {
    client: 'claude',
    surface: 'launch',
    readiness: PROVEN,
    cutoverStaging: { [FAMILY]: 'full' },
    adoption: [
      { client: 'claude', family: FAMILY, managedPathProven: true, nativeBypassRefused: true },
    ],
    matrix: realClientMatrixGateSource({
      scenarios: SCENARIOS,
      results,
      clientVersions: { claude: VERSION },
      now: NOW,
    }),
    ...extra,
  };
}

const withheldReason = (decision: ReturnType<typeof resolveCapabilityPolicy>) =>
  decision.withheld.find((entry) => entry.id === RESTRICTION)?.reason;

describe('P-008 matrix gate — reaches the real policy decision', () => {
  it('CALIBRATION: a fully green matrix lets the managed default be enabled', () => {
    // Without this case every assertion below could pass because the
    // restriction is withheld for some unrelated reason.
    const decision = resolveCapabilityPolicy(request(greenResults()));

    expect(decision.applied.map((entry) => entry.id)).toContain(RESTRICTION);
    expect(decision.deniedNames).toContain('Bash');
    expect(withheldReason(decision)).toBeUndefined();
  });

  it('withholds the managed default when the matrix source is omitted entirely', () => {
    // The fail-safe default. Forgetting to supply matrix evidence must deny,
    // never enable — "missing" is the first word of the falsifier.
    const { matrix: _dropped, ...withoutMatrix } = request(greenResults());
    const decision = resolveCapabilityPolicy(withoutMatrix as CapabilityPolicyRequest);

    expect(decision.applied.map((entry) => entry.id)).not.toContain(RESTRICTION);
    expect(decision.deniedNames).not.toContain('Bash');
    expect(withheldReason(decision)).toBe('matrix-scenario-unproven');
    expect(
      decision.withheld.find((entry) => entry.id === RESTRICTION)?.detail,
    ).toContain('no matrix verdict was supplied');
  });

  it.each([
    [
      'missing',
      () => greenResults().slice(1),
    ],
    [
      'failing',
      () => {
        const results = greenResults();
        results[2] = { ...results[2]!, outcome: 'fail' };
        return results;
      },
    ],
    [
      'stale',
      () => {
        const results = greenResults();
        results[3] = {
          ...results[3]!,
          observedAt: new Date(NOW.getTime() - DEFAULT_SCENARIO_FRESHNESS_MS - 60_000).toISOString(),
        };
        return results;
      },
    ],
    [
      'version-mismatch',
      () => greenResults().map((result) => ({ ...result, clientVersion: '0.0.1-other' })),
    ],
  ])('withholds the managed default when a declared scenario is %s', (mode, build) => {
    const decision = resolveCapabilityPolicy(request(build()));

    expect(decision.applied.map((entry) => entry.id)).not.toContain(RESTRICTION);
    expect(decision.deniedNames).not.toContain('Bash');
    expect(withheldReason(decision)).toBe('matrix-scenario-unproven');
    // The denial must NAME the defect, so an operator is not left grepping.
    expect(decision.withheld.find((entry) => entry.id === RESTRICTION)?.detail).toContain(mode);
  });

  it('withholds when the matrix is green but drifted from the enablement record', () => {
    const results = greenResults();
    const decision = resolveCapabilityPolicy(
      request(results, {
        matrix: realClientMatrixGateSource({
          scenarios: SCENARIOS,
          results,
          clientVersions: { claude: VERSION },
          now: NOW,
          records: [
            {
              family: FAMILY,
              client: 'claude',
              enabledAt: FRESH,
              scenarioFingerprints: Object.fromEntries(
                results.map((result) => [
                  result.scenarioId,
                  scenarioResultFingerprint({ ...result, clientVersion: '1.0.0-old' }),
                ]),
              ),
            },
          ],
        }),
      }),
    );

    expect(decision.applied.map((entry) => entry.id)).not.toContain(RESTRICTION);
    expect(withheldReason(decision)).toBe('matrix-scenario-unproven');
    expect(decision.withheld.find((entry) => entry.id === RESTRICTION)?.detail).toContain(
      'enablement-drift',
    );
  });

  it('withholds on an EMPTY declared matrix rather than treating it as passing', () => {
    const decision = resolveCapabilityPolicy(
      request([], {
        matrix: [
          { client: 'claude', family: FAMILY, allScenariosPassed: false, declaredScenarioCount: 0, unmet: [] },
        ],
      }),
    );

    expect(withheldReason(decision)).toBe('matrix-scenario-unproven');
    expect(decision.withheld.find((entry) => entry.id === RESTRICTION)?.detail).toContain(
      'declares NO scenario',
    );
  });
});

describe('P-008 matrix gate — precedence and blast radius', () => {
  it('defers to the CHEAPER upstream reason, so a denial names the narrowest cause', () => {
    // Parity not proven: the reader must be told that, not "the matrix is red".
    const decision = resolveCapabilityPolicy({
      ...request([]),
      readiness: CONTRACT_CAPABILITY_READINESS,
    });
    expect(withheldReason(decision)).toBe('replacement-unproven');
  });

  it('does not gate an owner mandate — it has no managed replacement to accept', () => {
    // An empty matrix source must not disarm the owner prohibitions, which is
    // the blast radius that would matter most if this gate were misplaced.
    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });

    expect(decision.deniedNames).toContain('Agent');
    expect(decision.deniedNames).toContain('ToolSearch');
  });

  it('changes nothing about the SHIPPED posture — no managed default is enabled today', () => {
    // The live boundary. Production passes no matrix (and no staging), so the
    // clause "no managed default is enabled without matrix evidence" holds in
    // the deployed configuration by construction. If this ever flips, the
    // enabling act owes the evidence this module produces.
    for (const surface of ['launch', 'resume', 'wake'] as const) {
      const decision = resolveCapabilityPolicy({ client: 'claude', surface });
      expect(decision.applied.map((entry) => entry.id)).not.toContain(RESTRICTION);
      expect(decision.deniedNames).not.toContain('Bash');
    }
  });
});
