/**
 * The P-006 retention rule, as a measurement rather than a sentence.
 *
 * Clause CAP-CONTRACT-P006-UNPROVEN-RETAINED@1, verbatim: "Every native
 * capability family lacking a semantically equivalent managed adapter remains
 * explicitly retained or unsupported instead of being disabled."
 *
 * ## What no existing test says
 *
 * `managed-capability-policy.test.ts` proves the POLICY resolves the right
 * restriction set per client/surface/audience, and that a managed-cutover is
 * withheld while its replacement is unproven. Every one of its assertions is
 * phrased over RESTRICTIONS. None of them can be phrased over FAMILIES, because
 * before D-012 six of the seven restrictions named no family at all — the
 * `family` field existed only on the `managed-cutover` authority variant. With
 * the mapping absent, "every native capability family" had no referent and the
 * clause was unfalsifiable rather than merely unproven.
 *
 * These tests are the other half: they quantify over
 * MANAGED_CAPABILITY_FAMILY_IDS and ask what actually happens to each one.
 *
 * ## Two properties chosen so the easy false-greens cannot occur
 *
 *  - TOTALITY over the DECLARED id list, never over the inventory. A census
 *    that iterated MANAGED_CAPABILITY_DISPOSITIONS would agree with whatever
 *    the inventory happened to contain, so a family declared and then forgotten
 *    would read as a clean pass. The control below deletes an inventory entry
 *    and requires the census to still produce its row, flagged.
 *  - DISABLEMENT read from the resolved DECISION, never from the table. A
 *    restriction withheld in every context disables nothing; counting table
 *    rows would report the shipped shell cutover as disabling the shell, which
 *    is the exact opposite of what the gate does with it.
 */

import { describe, expect, it } from 'vitest';

import {
  MANAGED_CAPABILITY_DISPOSITIONS,
  MANAGED_CAPABILITY_FAMILY_IDS,
  type ManagedCapabilityFamilyId,
} from './managed-capability-contract';
import {
  CONTRACT_CAPABILITY_READINESS,
  MANAGED_CAPABILITY_RESTRICTIONS,
  capabilityRetentionCensus,
  resolveCapabilityPolicy,
  type CapabilityReadinessSource,
  type CapabilityRetentionDispositionInput,
  type ManagedCapabilityRestriction,
} from './managed-capability-policy';

const SHIPPED_DISPOSITIONS: readonly CapabilityRetentionDispositionInput[] =
  MANAGED_CAPABILITY_DISPOSITIONS;

/** The shipped readiness with an explicit override for the named families. */
function readinessWith(ready: readonly ManagedCapabilityFamilyId[]): CapabilityReadinessSource {
  return CONTRACT_CAPABILITY_READINESS.map((entry) => ({
    ...entry,
    cutoverReady: ready.includes(entry.family),
  }));
}

describe('capability retention census — totality over the declared families', () => {
  it('produces one row per DECLARED family id, in declaration order', () => {
    const census = capabilityRetentionCensus();

    // Calibration: a census over an empty taxonomy would pass every assertion
    // below by never iterating. The contract declares 13 families.
    expect(MANAGED_CAPABILITY_FAMILY_IDS.length).toBeGreaterThanOrEqual(13);
    expect(census.families.map((entry) => entry.family)).toEqual([
      ...MANAGED_CAPABILITY_FAMILY_IDS,
    ]);
  });

  it('resolves the FULL client × surface × audience space, not a single sample', () => {
    const census = capabilityRetentionCensus();
    // 3 clients × 3 surfaces × 2 audiences. A census measuring one context
    // could miss a restriction that only applies on wake, or only headless —
    // which is the precise drift class P-005 was opened for.
    expect(census.contextsMeasured).toBe(18);
  });

  it('CONTROL: the totality detector FIRES when a declared family has no inventory entry', () => {
    const missing: ManagedCapabilityFamilyId = 'delegation';
    const census = capabilityRetentionCensus({
      dispositions: SHIPPED_DISPOSITIONS.filter((entry) => entry.family !== missing),
    });

    // The ROW still exists — that is the whole point of iterating the declared
    // ids. A census over the inventory would simply have 12 rows and look fine.
    expect(census.families).toHaveLength(MANAGED_CAPABILITY_FAMILY_IDS.length);
    const row = census.families.find((entry) => entry.family === missing);
    expect(row?.disposition).toBe('no-recorded-disposition');
    expect(census.violations.join('\n')).toContain(`${missing}:no-recorded-disposition`);

    // Fail-safe reading: an unrecorded family is RETAINED, so nothing may
    // disable it while the omission stands. Never treated as cutover-eligible.
    expect(row?.outcome).toBe('retained');
  });
});

describe('capability retention census — the shipped invariant', () => {
  it('disables no family that lacks a proven managed equivalent', () => {
    const census = capabilityRetentionCensus();

    // CALIBRATION, and the single most important line in this file: if the
    // shipped table disabled NOTHING, the assertion below would hold vacuously
    // and this whole suite would be green about an empty measurement.
    const disabledFamilies = census.families.filter((entry) => entry.disabledBy.length > 0);
    expect(disabledFamilies.length).toBeGreaterThan(0);

    expect(census.violations).toEqual([]);
  });

  it('maps EVERY shipped restriction to a family scope — none left unmapped', () => {
    expect(MANAGED_CAPABILITY_RESTRICTIONS.length).toBeGreaterThan(0);
    const knownFamilies = new Set<string>(MANAGED_CAPABILITY_FAMILY_IDS);

    for (const restriction of MANAGED_CAPABILITY_RESTRICTIONS) {
      const scope = restriction.familyScope;
      expect(scope, `${restriction.id} has no familyScope`).toBeTruthy();
      if (scope.kind === 'contract-family') {
        expect(knownFamilies.has(scope.family), `${restriction.id} names ${scope.family}`).toBe(
          true,
        );
      } else {
        // An out-of-taxonomy claim must SAY what it covers. An empty note is
        // indistinguishable from the unmapped state this field replaced.
        expect(scope.note.trim().length, `${restriction.id} note`).toBeGreaterThan(0);
      }
    }

    expect(capabilityRetentionCensus().malformedRestrictions).toEqual([]);
  });

  it('keeps out-of-taxonomy claims to the reviewed set, under an owner mandate only', () => {
    const census = capabilityRetentionCensus();

    // Deliberately exact. A SECOND restriction claiming to sit outside the R-1
    // taxonomy is a claim that the 13-family inventory is incomplete, and that
    // is a review, not a detail — so adding one must fail here and be argued.
    expect(census.outsideTaxonomyRestrictionIds).toEqual(['no-owner-desktop-notify']);

    for (const id of census.outsideTaxonomyRestrictionIds) {
      const restriction = MANAGED_CAPABILITY_RESTRICTIONS.find((entry) => entry.id === id);
      expect(restriction?.authority.kind, `${id} authority`).toBe('owner-mandate');
    }
  });

  it('states an explicit boundary for every family that is not cutover-eligible', () => {
    const census = capabilityRetentionCensus();
    const notEligible = census.families.filter(
      (entry) => entry.outcome !== 'managed-cutover-eligible',
    );
    // Calibration: nothing is cutover-ready today, so this must cover them all.
    expect(notEligible).toHaveLength(MANAGED_CAPABILITY_FAMILY_IDS.length);

    for (const entry of notEligible) {
      expect(entry.outcome === 'retained' || entry.outcome === 'unsupported').toBe(true);
      expect(entry.boundary.trim().length, `${entry.family} boundary`).toBeGreaterThan(0);
    }
  });

  it('names a real managed authority for every family it calls managed', () => {
    const managed = SHIPPED_DISPOSITIONS.filter(
      (entry) =>
        entry.disposition === 'managed-execution' ||
        entry.disposition === 'managed-backed-native-interface',
    );
    // Calibration: if nothing were classified managed, the loop would be vacuous.
    expect(managed.length).toBeGreaterThan(0);
    for (const entry of managed) {
      expect(entry.managedAuthorities.length, `${entry.family} names no adapter`).toBeGreaterThan(
        0,
      );
    }
  });

  it('classifies the persistent-kernel family as explicitly UNSUPPORTED, and disables nothing for it', () => {
    // P-006 co-owns `persistent-kernel-lifecycle` with P-008 and does NOT close
    // it (D-009, D-012 §5). The honest position is the one the clause allows:
    // explicitly unsupported, with nothing removing the native route meanwhile.
    const kernels = capabilityRetentionCensus().families.find(
      (entry) => entry.family === 'script-orchestration-kernels',
    );
    expect(kernels?.outcome).toBe('unsupported');
    expect(kernels?.openGapIds).toContain('persistent-kernel-lifecycle');
    expect(kernels?.disabledBy).toEqual([]);
  });
});

describe('capability retention census — disablement is read from the DECISION', () => {
  it('records an applied owner mandate as a disablement of ITS family', () => {
    const scheduling = capabilityRetentionCensus().families.find(
      (entry) => entry.family === 'schedules-monitors-wakes',
    );

    expect(scheduling?.disabledBy.length).toBeGreaterThan(0);
    for (const disablement of scheduling?.disabledBy ?? []) {
      expect(disablement.authorityKind).toBe('owner-mandate');
      expect(disablement.contexts.length).toBeGreaterThan(0);
      expect(disablement.deniedNames.length).toBeGreaterThan(0);
    }
    // Legitimately disabled under an owner mandate — so NOT a violation.
    expect(scheduling?.violations).toEqual([]);
  });

  it('counts a restriction that applies NOWHERE as disabling nothing', () => {
    const neverApplies: ManagedCapabilityRestriction = {
      id: 'synthetic-never-applies',
      familyScope: { kind: 'contract-family', family: 'reads-list-search-lsp' },
      title: 'Declared for no client at all',
      authority: { kind: 'owner-mandate', directive: 'synthetic control' },
      aliases: ['Read'],
      nestedRoutes: [],
      clients: [],
      surfaces: ['launch', 'resume', 'wake'],
      audiences: ['headless-agent', 'interactive-su'],
      yieldsToExplicitDenyList: false,
      rationale: 'Never applies; proves the census reads decisions, not rows.',
    };

    const census = capabilityRetentionCensus({ restrictions: [neverApplies] });
    const reads = census.families.find((entry) => entry.family === 'reads-list-search-lsp');
    expect(reads?.disabledBy).toEqual([]);
    expect(census.violations).toEqual([]);
  });

  it('counts the shipped shell cutover as disabling nothing while its replacement is unproven', () => {
    const shell = capabilityRetentionCensus().families.find(
      (entry) => entry.family === 'shell-ssh-interpreters',
    );
    // The restriction EXISTS in the table and is withheld in every context.
    // A table-shaped census would report the native shell as removed.
    expect(
      MANAGED_CAPABILITY_RESTRICTIONS.some((entry) => entry.id === 'managed-shell-cutover'),
    ).toBe(true);
    expect(shell?.outcome).toBe('retained');
    expect(shell?.disabledBy).toEqual([]);
  });

  it('records the same cutover as a legitimate disablement once its replacement IS proven', () => {
    const census = capabilityRetentionCensus({
      readiness: readinessWith(['shell-ssh-interpreters']),
    });
    const shell = census.families.find((entry) => entry.family === 'shell-ssh-interpreters');

    expect(shell?.outcome).toBe('managed-cutover-eligible');
    expect(shell?.disabledBy.map((entry) => entry.restrictionId)).toContain(
      'managed-shell-cutover',
    );
    // Proven equivalent, so removing the native surface is exactly what the
    // clause permits — no violation.
    expect(shell?.violations).toEqual([]);
    expect(census.violations).toEqual([]);
  });
});

describe('capability retention census — falsifiability controls', () => {
  it('CONTROL: the rule FIRES when a family the inventory calls UNSUPPORTED is cut over anyway', () => {
    // The real bug class: readiness is declared for a family the inventory
    // records as `unsupported-gap`. The gate happily applies the cutover — it
    // only consults readiness — and the native route disappears for a
    // capability we simultaneously say we do not offer.
    const mutantTable = MANAGED_CAPABILITY_RESTRICTIONS.map((restriction) =>
      restriction.id === 'managed-shell-cutover'
        ? ({
            ...restriction,
            familyScope: {
              kind: 'contract-family',
              family: 'script-orchestration-kernels',
            },
          } satisfies ManagedCapabilityRestriction)
        : restriction,
    );

    const census = capabilityRetentionCensus({
      restrictions: mutantTable,
      readiness: readinessWith(['script-orchestration-kernels']),
    });
    const kernels = census.families.find(
      (entry) => entry.family === 'script-orchestration-kernels',
    );

    // Calibration: the mutant must actually APPLY, or the control proves
    // nothing about the detector.
    expect(kernels?.disabledBy.map((entry) => entry.restrictionId)).toContain(
      'managed-shell-cutover',
    );
    expect(kernels?.outcome).toBe('unsupported');
    expect(census.violations.join('\n')).toContain(
      'script-orchestration-kernels:disabled-without-proven-equivalent:managed-shell-cutover',
    );

    // And the SHIPPED table is clean under the very same detector, so the green
    // result in the invariant suite above is a real pass.
    expect(capabilityRetentionCensus().violations).toEqual([]);
  });

  it('CONTROL: the rule FIRES when a family is declared cutover-ready with NO adapter named', () => {
    // "Semantically equivalent managed adapter" has to name one. A ready flag
    // over an empty authority list is a cutover to nothing — and it would
    // otherwise earn the family the MOST permissive outcome the census assigns.
    const target: ManagedCapabilityFamilyId = 'reads-list-search-lsp';
    const hollow = SHIPPED_DISPOSITIONS.map((entry) =>
      entry.family === target ? { ...entry, managedAuthorities: [] } : entry,
    );

    const census = capabilityRetentionCensus({
      dispositions: hollow,
      readiness: readinessWith([target]),
    });
    expect(census.families.find((entry) => entry.family === target)?.outcome).toBe(
      'managed-cutover-eligible',
    );
    expect(census.violations.join('\n')).toContain(
      `${target}:cutover-eligible-without-named-adapter`,
    );

    // Calibration: the SAME family with its real authority list is clean under
    // the same detector, so the firing above is the empty list and nothing else.
    expect(capabilityRetentionCensus({ readiness: readinessWith([target]) }).violations).toEqual(
      [],
    );
  });

  it('CONTROL: the mapping detector FIRES on the pre-D-012 state — a restriction with no family scope', () => {
    const unmapped = MANAGED_CAPABILITY_RESTRICTIONS.map((restriction) => {
      if (restriction.id !== 'no-subagent-fanout') return restriction;
      const { familyScope: _dropped, ...rest } = restriction;
      // The cast is the point: this reproduces the shape that existed before
      // familyScope was required, which the type system now rejects outright.
      return rest as unknown as ManagedCapabilityRestriction;
    });

    const census = capabilityRetentionCensus({ restrictions: unmapped });
    expect(census.malformedRestrictions).toContain('no-subagent-fanout:missing-family-scope');

    // The consequence that made the clause unfalsifiable: with no scope, the
    // delegation family reads as untouched while its native fan-out is in fact
    // denied on every claude surface.
    const delegation = census.families.find((entry) => entry.family === 'delegation');
    expect(delegation?.disabledBy).toEqual([]);
    expect(
      capabilityRetentionCensus().families.find((entry) => entry.family === 'delegation')
        ?.disabledBy.length,
    ).toBeGreaterThan(0);
  });

  it('withholds a managed cutover scoped OUTSIDE the taxonomy rather than applying it blind', () => {
    const uncheckable: ManagedCapabilityRestriction = {
      id: 'synthetic-uncheckable-cutover',
      familyScope: {
        kind: 'outside-r1-taxonomy',
        note: 'synthetic control — a cutover for a family the contract does not inventory',
      },
      title: 'A cutover with no disposition to read readiness from',
      authority: { kind: 'managed-cutover' },
      aliases: ['SomeNativeTool'],
      nestedRoutes: [],
      clients: ['claude'],
      surfaces: ['launch', 'resume', 'wake'],
      audiences: ['headless-agent', 'interactive-su'],
      yieldsToExplicitDenyList: false,
      rationale: 'Proves the malformed-cutover path fails safe.',
    };

    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' }, [
      uncheckable,
    ]);
    expect(decision.applied).toEqual([]);
    expect(decision.deniedNames).toEqual([]);
    expect(decision.withheld.map((entry) => entry.reason)).toEqual(['replacement-unproven']);

    const census = capabilityRetentionCensus({ restrictions: [uncheckable] });
    expect(census.malformedRestrictions).toContain(
      'synthetic-uncheckable-cutover:managed-cutover-outside-taxonomy',
    );
  });

  it('CONTROL: the census is not silently vacuous when asked to measure nothing', () => {
    // A census over an empty context set resolves no decision at all. It must
    // SAY so — `contextsMeasured: 0` — rather than returning an empty violation
    // list that reads exactly like a clean bill of health.
    const census = capabilityRetentionCensus({ clients: [] });
    expect(census.contextsMeasured).toBe(0);
    expect(census.violations).toEqual([]);
    expect(census.families.every((entry) => entry.disabledBy.length === 0)).toBe(true);
  });
});
