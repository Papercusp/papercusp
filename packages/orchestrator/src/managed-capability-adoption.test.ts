/**
 * The P-007 cutover-evidence rule, as a measurement rather than a sentence.
 *
 * Clause CAP-CONTRACT-P007-CUTOVER-EVIDENCE@1, verbatim: "The adoption report
 * shows a positive managed-path result and a negative native-bypass result for
 * every client capability enabled for cutover."
 *
 * Its falsifier, verbatim: "A cutover-enabled client capability lacks either a
 * successful managed-path observation or a refused native-bypass observation."
 *
 * ## What no existing test says
 *
 * `managed-capability-policy.test.ts` proves the resolver picks the right
 * restriction set per client/surface/audience, and that a managed-cutover is
 * withheld while its REPLACEMENT is unproven. `managed-capability-retention.test.ts`
 * (P-006) quantifies over FAMILIES and asks what happens to each one. Neither
 * can be phrased over (client, family) ACCEPTANCE, because before this change
 * nothing recorded either control arm: `replacement-unproven` is a property of
 * the adapter, while this clause is quantified over the adapter AT a client.
 *
 * ## The two ways this clause could be fake, and the controls against them
 *
 *  1. VACUOUSLY TRUE. No family is `cutoverReady` on the shipped contract, so
 *     "every cutover-enabled client capability" is the EMPTY SET and the
 *     sentence holds while measuring nothing — precisely the P-006 trap D-012
 *     was written about. Controlled two ways: the shipped case must report
 *     `no-cutover-enabled` rather than `satisfied`, and every falsifiable
 *     assertion below first makes the intended set NON-EMPTY (asserted, not
 *     assumed) via the injectable readiness/staging seams.
 *
 *  2. CIRCULARLY TRUE. The policy gate withholds a cutover lacking evidence, so
 *     a report enumerating what the gate ADMITTED could never fail. Controlled
 *     by `enumerates cutover INTENT, not what the gate admitted`: the report
 *     must name a pair as cutover-enabled-and-unevidenced at the same moment
 *     the resolver refuses to apply it.
 */

import { describe, expect, it } from 'vitest';

import {
  MANAGED_CAPABILITY_DISPOSITIONS,
  MANAGED_CAPABILITY_FAMILY_IDS,
  type ManagedCapabilityFamilyId,
} from './managed-capability-contract';
import {
  CAPABILITY_CLIENT_ENFORCEMENT,
  MANAGED_CAPABILITY_RESTRICTIONS,
  cutoverStageAudiences,
  resolveCapabilityPolicy,
  type CapabilityAudience,
  type CapabilityClientFamily,
  type CapabilityReadinessSource,
} from './managed-capability-policy';
import {
  capabilityAdoptionGateSource,
  capabilityAdoptionReport,
  capabilityDecisionTeaching,
  capabilityDenialTeaching,
  type CapabilityAdoptionObservation,
} from './managed-capability-adoption';

/** The one managed-cutover restriction in the shipped table. */
const CUTOVER_FAMILY: ManagedCapabilityFamilyId = 'shell-ssh-interpreters';
const CUTOVER_CLIENT: CapabilityClientFamily = 'claude';
const CUTOVER_RESTRICTION = 'managed-shell-cutover';

/** Readiness with ONE family proven at parity — the seam P-005 left open. */
function readyFor(family: ManagedCapabilityFamilyId): CapabilityReadinessSource {
  return MANAGED_CAPABILITY_DISPOSITIONS.map((entry) => ({
    family: entry.family,
    cutoverReady: entry.family === family,
    openGapIds: entry.family === family ? [] : entry.gaps.map((gap) => gap.id),
  }));
}

function observation(
  overrides: Partial<CapabilityAdoptionObservation> = {},
): CapabilityAdoptionObservation {
  return {
    client: CUTOVER_CLIENT,
    family: CUTOVER_FAMILY,
    surface: 'launch',
    arm: 'managed-path',
    outcome: 'managed-success',
    clientVersion: '1.2.3',
    evidenceRef: 'test-run:managed',
    observedAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

const MANAGED_OK = observation();
const BYPASS_REFUSED = observation({
  arm: 'native-bypass',
  outcome: 'bypass-refused',
  evidenceRef: 'test-run:bypass',
});

/** Both arms, one family, one client: the only shape the clause accepts. */
const ACCEPTED_PAIR = [MANAGED_OK, BYPASS_REFUSED];

function reportWithCutoverStaged(observations: readonly CapabilityAdoptionObservation[]) {
  return capabilityAdoptionReport({
    observations,
    readiness: readyFor(CUTOVER_FAMILY),
    cutoverStaging: { [CUTOVER_FAMILY]: 'full' },
  });
}

describe('adoption report — the measurement is not vacuous', () => {
  it('reports the shipped empty quantification as no-cutover-enabled, NOT as satisfied', () => {
    const report = capabilityAdoptionReport();

    // The whole point: an empty "every" is a fact about the measurement.
    expect(report.clauseVerdict).toBe('no-cutover-enabled');
    expect(report.cutoverEnabled).toHaveLength(0);

    // ...and it is empty because nothing is READY, not because nothing was measured.
    expect(report.pairsMeasured).toBeGreaterThan(0);
    expect(report.contextsResolved).toBeGreaterThan(0);
  });

  it('is TOTAL over the declared family and client lists', () => {
    const report = capabilityAdoptionReport();
    const clients = Object.keys(CAPABILITY_CLIENT_ENFORCEMENT) as CapabilityClientFamily[];

    expect(report.rows).toHaveLength(clients.length * MANAGED_CAPABILITY_FAMILY_IDS.length);
    for (const client of clients) {
      for (const family of MANAGED_CAPABILITY_FAMILY_IDS) {
        expect(
          report.rows.some((row) => row.client === client && row.family === family),
        ).toBe(true);
      }
  }
  });

  it('still produces a row for a family the INVENTORY has forgotten', () => {
    // RED CONTROL for totality. A report that iterated the inventory would
    // agree with whatever it happened to contain, so a declared-then-dropped
    // family would read as a clean pass instead of an absence.
    const report = capabilityAdoptionReport({
      readiness: MANAGED_CAPABILITY_DISPOSITIONS.filter(
        (entry) => entry.family !== CUTOVER_FAMILY,
      ).map((entry) => ({
        family: entry.family,
        cutoverReady: false,
        openGapIds: [],
      })),
    });

    expect(report.rows.some((row) => row.family === CUTOVER_FAMILY)).toBe(true);
  });
});

describe('adoption report — both control arms, and the falsifier', () => {
  it('SATISFIED only when both arms are present for every enabled pair', () => {
    const report = reportWithCutoverStaged(ACCEPTED_PAIR);

    // Guard against a vacuous pass: the quantification must be non-empty.
    expect(report.cutoverEnabled.length).toBeGreaterThan(0);
    expect(report.clauseVerdict).toBe('satisfied');
    expect(report.unevidenced).toHaveLength(0);

    const row = report.cutoverEnabled.find((entry) => entry.family === CUTOVER_FAMILY);
    expect(row?.verdict).toBe('accepted');
    expect(row?.managedPathEvidence).toEqual(['test-run:managed']);
    expect(row?.nativeBypassEvidence).toEqual(['test-run:bypass']);
    expect(row?.enablingRestrictionIds).toContain(CUTOVER_RESTRICTION);
  });

  it('VIOLATED when the managed-path arm is missing (the falsifier, arm 1)', () => {
    const report = reportWithCutoverStaged([BYPASS_REFUSED]);

    expect(report.cutoverEnabled.length).toBeGreaterThan(0);
    expect(report.clauseVerdict).toBe('violated');
    expect(report.unevidenced.map((row) => row.verdict)).toContain('managed-path-missing');
  });

  it('VIOLATED when the native-bypass arm is missing (the falsifier, arm 2)', () => {
    const report = reportWithCutoverStaged([MANAGED_OK]);

    expect(report.cutoverEnabled.length).toBeGreaterThan(0);
    expect(report.clauseVerdict).toBe('violated');
    expect(report.unevidenced.map((row) => row.verdict)).toContain('native-bypass-missing');
  });

  it('an ADMITTED bypass is a violation, not a satisfied arm', () => {
    // The most dangerous state: someone believes the restriction is enforced
    // while the native route is demonstrably open. It must outrank every other
    // verdict so it cannot hide behind a missing observation.
    const report = reportWithCutoverStaged([
      MANAGED_OK,
      observation({ arm: 'native-bypass', outcome: 'bypass-admitted', evidenceRef: 'r:open' }),
    ]);

    expect(report.clauseVerdict).toBe('violated');
    expect(report.unevidenced.map((row) => row.verdict)).toContain('native-bypass-admitted');
  });

  it('a FAILING managed path is a violation, distinct from a missing one', () => {
    const report = reportWithCutoverStaged([
      BYPASS_REFUSED,
      observation({ outcome: 'managed-failure', evidenceRef: 'r:broke' }),
    ]);

    expect(report.clauseVerdict).toBe('violated');
    expect(report.unevidenced.map((row) => row.verdict)).toContain('managed-path-failing');
  });

  it('enumerates cutover INTENT, not what the gate admitted', () => {
    // RED CONTROL for circularity. With no telemetry the gate applies nothing,
    // so a report reading the gate's output would see an empty set and call the
    // clause vacuously fine. The report must instead name the staged pair as
    // enabled-and-unevidenced at the same moment the resolver refuses it.
    const report = reportWithCutoverStaged([]);
    const decision = resolveCapabilityPolicy({
      client: CUTOVER_CLIENT,
      surface: 'launch',
      readiness: readyFor(CUTOVER_FAMILY),
      cutoverStaging: { [CUTOVER_FAMILY]: 'full' },
      adoption: [],
    });

    expect(report.clauseVerdict).toBe('violated');
    expect(report.unevidenced.some((row) => row.family === CUTOVER_FAMILY)).toBe(true);
    expect(decision.applied.map((entry) => entry.id)).not.toContain(CUTOVER_RESTRICTION);
  });

  it('reports an outcome that does not belong to its arm instead of counting it', () => {
    // RED CONTROL: a 'bypass-refused' outcome filed under the managed-path arm
    // must satisfy NEITHER arm. Silently accepting it would let one observation
    // masquerade as both halves of the evidence the clause requires.
    const report = reportWithCutoverStaged([
      observation({ arm: 'managed-path', outcome: 'bypass-refused', evidenceRef: 'r:mixed' }),
    ]);

    expect(report.malformedObservations).toHaveLength(1);
    expect(report.malformedObservations[0]).toContain('r:mixed');
    expect(report.clauseVerdict).toBe('violated');
    expect(report.unevidenced.map((row) => row.verdict)).toContain('managed-path-missing');
  });

  it('collapses observations to the gate shape through ONE function', () => {
    // The gate and the report must not be able to disagree about what was seen.
    const [entry] = capabilityAdoptionGateSource(ACCEPTED_PAIR);
    expect(entry).toMatchObject({
      client: CUTOVER_CLIENT,
      family: CUTOVER_FAMILY,
      managedPathProven: true,
      nativeBypassRefused: true,
      atClientVersion: '1.2.3',
    });

    // A negative outcome is never evidence of acceptance.
    const [negative] = capabilityAdoptionGateSource([
      observation({ outcome: 'managed-failure' }),
      observation({ arm: 'native-bypass', outcome: 'bypass-admitted' }),
    ]);
    expect(negative?.managedPathProven).toBe(false);
    expect(negative?.nativeBypassRefused).toBe(false);
  });
});

describe('policy gate — prove the arms BEFORE enabling the restriction', () => {
  const base = {
    client: CUTOVER_CLIENT,
    surface: 'launch' as const,
    readiness: readyFor(CUTOVER_FAMILY),
    cutoverStaging: { [CUTOVER_FAMILY]: 'full' as const },
  };

  function withheldReason(decision: ReturnType<typeof resolveCapabilityPolicy>) {
    return decision.withheld.find((entry) => entry.id === CUTOVER_RESTRICTION)?.reason;
  }

  it('APPLIES the cutover once parity, staging and both arms are satisfied', () => {
    const decision = resolveCapabilityPolicy({
      ...base,
      adoption: capabilityAdoptionGateSource(ACCEPTED_PAIR),
    });

    expect(decision.applied.map((entry) => entry.id)).toContain(CUTOVER_RESTRICTION);
  });

  it('WITHHOLDS it when adoption telemetry is absent entirely', () => {
    const decision = resolveCapabilityPolicy({ ...base, adoption: [] });

    expect(withheldReason(decision)).toBe('adoption-unproven');
    expect(
      decision.withheld.find((entry) => entry.id === CUTOVER_RESTRICTION)?.detail,
    ).toContain('no adoption telemetry recorded');
  });

  it('WITHHOLDS it on one arm alone — each arm named in the denial', () => {
    const managedOnly = resolveCapabilityPolicy({
      ...base,
      adoption: capabilityAdoptionGateSource([MANAGED_OK]),
    });
    expect(withheldReason(managedOnly)).toBe('adoption-unproven');
    expect(managedOnly.withheld.find((e) => e.id === CUTOVER_RESTRICTION)?.detail).toContain(
      'refused native-bypass observation',
    );

    const bypassOnly = resolveCapabilityPolicy({
      ...base,
      adoption: capabilityAdoptionGateSource([BYPASS_REFUSED]),
    });
    expect(withheldReason(bypassOnly)).toBe('adoption-unproven');
    expect(bypassOnly.withheld.find((e) => e.id === CUTOVER_RESTRICTION)?.detail).toContain(
      'successful managed-path observation',
    );
  });

  it('omitting the adoption argument fails SAFE rather than open', () => {
    // The default must be the restrictive reading: a caller who forgets the
    // evidence must not thereby pass the evidence gate.
    const decision = resolveCapabilityPolicy({ ...base });
    expect(withheldReason(decision)).toBe('adoption-unproven');
  });

  it('leaves every owner-mandate restriction untouched by the adoption gate', () => {
    // The gate is scoped to managed-cutover authority. An owner mandate denies
    // because the owner said so, and no amount of missing adoption telemetry
    // may quietly re-open it.
    const decision = resolveCapabilityPolicy({ client: CUTOVER_CLIENT, surface: 'launch' });
    const ownerMandates = MANAGED_CAPABILITY_RESTRICTIONS.filter(
      (restriction) =>
        restriction.authority.kind === 'owner-mandate' &&
        restriction.clients.includes(CUTOVER_CLIENT) &&
        restriction.surfaces.includes('launch') &&
        restriction.audiences.includes('headless-agent'),
    );

    expect(ownerMandates.length).toBeGreaterThan(0);
    for (const restriction of ownerMandates) {
      expect(decision.applied.map((entry) => entry.id)).toContain(restriction.id);
    }
  });
});

describe('canary and rollback — through the existing controls', () => {
  const proven = {
    client: CUTOVER_CLIENT,
    surface: 'launch' as const,
    readiness: readyFor(CUTOVER_FAMILY),
    adoption: capabilityAdoptionGateSource(ACCEPTED_PAIR),
  };

  it('stage off withholds even a fully evidenced cutover', () => {
    const decision = resolveCapabilityPolicy({ ...proven, cutoverStaging: {} });

    expect(
      decision.withheld.find((entry) => entry.id === CUTOVER_RESTRICTION)?.reason,
    ).toBe('cutover-stage-withheld');
  });

  it('canary admits the ATTENDED audience only', () => {
    expect(cutoverStageAudiences('canary')).toEqual(['interactive-su']);
    expect(cutoverStageAudiences('off')).toEqual([]);

    const staging = { [CUTOVER_FAMILY]: 'canary' as const };
    const attended = resolveCapabilityPolicy({
      ...proven,
      cutoverStaging: staging,
      audience: 'interactive-su',
    });
    const headless = resolveCapabilityPolicy({
      ...proven,
      cutoverStaging: staging,
      audience: 'headless-agent',
    });

    expect(attended.applied.map((entry) => entry.id)).toContain(CUTOVER_RESTRICTION);
    expect(
      headless.withheld.find((entry) => entry.id === CUTOVER_RESTRICTION)?.reason,
    ).toBe('cutover-stage-withheld');
  });

  it('ROLLBACK: flipping the stage back to off withholds an enabled cutover', () => {
    const staged = { ...proven, cutoverStaging: { [CUTOVER_FAMILY]: 'full' as const } };
    expect(resolveCapabilityPolicy(staged).applied.map((e) => e.id)).toContain(
      CUTOVER_RESTRICTION,
    );

    const rolledBack = resolveCapabilityPolicy({
      ...staged,
      cutoverStaging: { [CUTOVER_FAMILY]: 'off' },
    });
    expect(rolledBack.applied.map((e) => e.id)).not.toContain(CUTOVER_RESTRICTION);
    expect(rolledBack.deniedNames).not.toContain('Bash');
  });

  it('ROLLBACK: the existing owner overrideKey still clears it', () => {
    // Reuse, not a second rollback path: whichever override the table declares
    // must remain a working escape after the P-007 gates were added ahead of it.
    const restriction = MANAGED_CAPABILITY_RESTRICTIONS.find(
      (entry) => entry.id === CUTOVER_RESTRICTION,
    );
    const overrideKey = restriction?.overrideKey;
    if (!overrideKey) {
      expect(restriction).toBeDefined();
      return;
    }

    const decision = resolveCapabilityPolicy({
      ...proven,
      cutoverStaging: { [CUTOVER_FAMILY]: 'full' },
      overrides: [overrideKey],
    });
    expect(decision.withheld.find((e) => e.id === CUTOVER_RESTRICTION)?.reason).toBe(
      'owner-override',
    );
  });
});

describe('version-change checks — acceptance cannot outlive its surface', () => {
  const proven = {
    client: CUTOVER_CLIENT,
    surface: 'launch' as const,
    readiness: readyFor(CUTOVER_FAMILY),
    cutoverStaging: { [CUTOVER_FAMILY]: 'full' as const },
    adoption: capabilityAdoptionGateSource(ACCEPTED_PAIR),
  };

  it('withholds the cutover when the client version moved since acceptance', () => {
    const decision = resolveCapabilityPolicy({
      ...proven,
      clientVersions: { [CUTOVER_CLIENT]: '2.0.0' },
    });

    const withheld = decision.withheld.find((entry) => entry.id === CUTOVER_RESTRICTION);
    expect(withheld?.reason).toBe('client-version-drift');
    expect(withheld?.detail).toContain('1.2.3');
    expect(withheld?.detail).toContain('2.0.0');
  });

  it('applies it when the running version matches the accepted one', () => {
    const decision = resolveCapabilityPolicy({
      ...proven,
      clientVersions: { [CUTOVER_CLIENT]: '1.2.3' },
    });
    expect(decision.applied.map((entry) => entry.id)).toContain(CUTOVER_RESTRICTION);
  });

  it('an UNKNOWN running version is not treated as drift', () => {
    // Absence of a measurement is not evidence of a change. Withholding here
    // would make every caller that does not report a version lose enforcement.
    const decision = resolveCapabilityPolicy({ ...proven, clientVersions: {} });
    expect(decision.applied.map((entry) => entry.id)).toContain(CUTOVER_RESTRICTION);
  });

  it('re-measuring on the new version clears the drift', () => {
    const decision = resolveCapabilityPolicy({
      ...proven,
      adoption: capabilityAdoptionGateSource([
        MANAGED_OK,
        BYPASS_REFUSED,
        observation({
          clientVersion: '2.0.0',
          observedAt: '2026-09-22T00:00:00.000Z',
          evidenceRef: 'r:managed-v2',
        }),
        observation({
          arm: 'native-bypass',
          outcome: 'bypass-refused',
          clientVersion: '2.0.0',
          observedAt: '2026-09-22T00:00:01.000Z',
          evidenceRef: 'r:bypass-v2',
        }),
      ]),
      clientVersions: { [CUTOVER_CLIENT]: '2.0.0' },
    });

    expect(decision.applied.map((entry) => entry.id)).toContain(CUTOVER_RESTRICTION);
  });

  it('the report marks stale acceptance without calling it accepted', () => {
    const report = capabilityAdoptionReport({
      observations: ACCEPTED_PAIR,
      readiness: readyFor(CUTOVER_FAMILY),
      cutoverStaging: { [CUTOVER_FAMILY]: 'full' },
      clientVersions: { [CUTOVER_CLIENT]: '9.9.9' },
    });

    expect(report.clauseVerdict).toBe('violated');
    expect(report.unevidenced.map((row) => row.verdict)).toContain('acceptance-stale');
  });
});

describe('teaching denials — a denial names where the capability went', () => {
  it('teaches the managed authority for every denied native name', () => {
    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });
    const teaching = capabilityDecisionTeaching(decision);

    expect(decision.deniedNames.length).toBeGreaterThan(0);
    // TOTAL over the decision: every denied name gets a record, so a name that
    // teaches nothing is visible rather than simply absent.
    expect(teaching.map((entry) => entry.nativeName).sort()).toEqual(
      [...decision.deniedNames].sort(),
    );

    const taught = teaching.filter((entry) => !entry.strands);
    expect(taught.length).toBeGreaterThan(0);
    for (const entry of taught) {
      expect(entry.managedAlternatives.length).toBeGreaterThan(0);
      // The alternative is DERIVED from the contract, never restated here.
      const authorities = MANAGED_CAPABILITY_DISPOSITIONS.find(
        (disposition) => disposition.family === entry.family,
      )?.managedAuthorities;
      expect(entry.managedAlternatives).toEqual(authorities);
      expect(entry.message).toContain(entry.managedAlternatives[0]!);
    }
  });

  it('a denial with no inventoried replacement says UNSUPPORTED, not "use one of: "', () => {
    // RED CONTROL. An empty alternatives list rendered into teaching prose is
    // the failure mode: it reads as helpful while naming nothing. The shipped
    // table carries an outside-taxonomy restriction, which is exactly this case.
    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });
    const stranding = capabilityDecisionTeaching(decision).filter((entry) => entry.strands);

    expect(stranding.length).toBeGreaterThan(0);
    for (const entry of stranding) {
      expect(entry.managedAlternatives).toEqual([]);
      expect(entry.message).not.toContain('Use  instead');
      expect(entry.message).toMatch(/unsupported|no managed replacement|names no replacement/i);
    }
  });

  it('carries the outside-taxonomy note rather than inventing a family', () => {
    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });
    const outside = capabilityDecisionTeaching(decision).filter(
      (entry) => entry.family === null,
    );

    expect(outside.length).toBeGreaterThan(0);
    for (const entry of outside) {
      expect(entry.outsideTaxonomyNote).toBeTruthy();
      expect(entry.strands).toBe(true);
    }
  });

  it('looks up a single denied name, and answers null for one that is allowed', () => {
    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });
    const denied = decision.deniedNames[0]!;

    expect(capabilityDenialTeaching(decision, denied)?.nativeName).toBe(denied);
    expect(capabilityDenialTeaching(decision, 'definitely-not-a-denied-tool')).toBeNull();
  });

  it('teaches nothing for a client with no deny-list surface', () => {
    // Not an empty-because-broken result: these clients have no composable
    // restriction surface at all, so there is no denial to teach about.
    const clients = Object.keys(CAPABILITY_CLIENT_ENFORCEMENT) as CapabilityClientFamily[];
    const nonDenyList = clients.filter(
      (client) => CAPABILITY_CLIENT_ENFORCEMENT[client] !== 'deny-list',
    );

    expect(nonDenyList.length).toBeGreaterThan(0);
    for (const client of nonDenyList) {
      const decision = resolveCapabilityPolicy({ client, surface: 'launch' });
      expect(capabilityDecisionTeaching(decision)).toEqual([]);
    }
  });
});

describe('no regression on the shipped posture', () => {
  it('resolves every shipped context with the cutover still withheld', () => {
    // The P-007 gates are added AHEAD of a cutover that nothing has proven, so
    // the shipped decision must be byte-for-byte the same posture as before:
    // owner mandates applied, the one cutover withheld, nothing newly denied.
    const clients = Object.keys(CAPABILITY_CLIENT_ENFORCEMENT) as CapabilityClientFamily[];
    const audiences: readonly CapabilityAudience[] = ['headless-agent', 'interactive-su'];
    let contexts = 0;

    for (const client of clients) {
      for (const surface of ['launch', 'resume', 'wake'] as const) {
        for (const audience of audiences) {
          contexts += 1;
          const decision = resolveCapabilityPolicy({ client, surface, audience });
          expect(decision.applied.map((entry) => entry.id)).not.toContain(CUTOVER_RESTRICTION);
          for (const applied of decision.applied) {
            expect(applied.authorityKind).toBe('owner-mandate');
          }
          // Every restriction still lands in exactly one bucket.
          expect(decision.applied.length + decision.withheld.length).toBe(
            MANAGED_CAPABILITY_RESTRICTIONS.length,
          );
        }
      }
    }

    expect(contexts).toBe(clients.length * 3 * audiences.length);
  });
});
