/**
 * The isolated real-client acceptance matrix (P-008,
 * CAP-CONTRACT-P008-REAL-CLIENT-MATRIX@1).
 *
 * THE CLAUSE: "The isolated real-client matrix passes every declared launch,
 * resume, wake, recovery, lifecycle, sandbox, and native-disable scenario
 * before a managed default is enabled."
 *
 * ITS FALSIFIER: "A managed default is enabled while any declared real-client
 * scenario is missing, failing, stale, or run against a different client
 * version." Those FOUR words are the whole contract, so they are the four
 * non-passing states `RealClientScenarioStatus` can take — no more, no fewer.
 * Replacement acceptance additionally records `unsupported` limitations, which
 * never count as passes or produce cutover admission entries.
 *
 * WHY THIS MODULE EXISTS AT ALL. P-007 left the enabling act deliberately
 * unevidenced: `SHIPPED_CUTOVER_STAGING` is `{}` (every family `off`) and its
 * comment says, verbatim, "Enabling is a separate, stated act (P-008 supplies
 * the measured evidence; this dial admits it in stages)." This module is that
 * evidence plane. Before it, the sentence "the matrix passes every declared
 * scenario" named nothing that resolved from data — there was no manifest, no
 * scenario taxonomy, no result fingerprint and no enablement record anywhere
 * in the tree, so the clause was unfalsifiable in exactly the way D-012
 * diagnosed for P-006. Per D-012 the missing mapping IS the work.
 *
 * DERIVED, NOT HAND-AUTHORED (derived-truth ladder, rung 1). The scenario
 * manifest is computed from the restriction registry: the families come from
 * `familyScope`, the clients from `restriction.clients`, and the three
 * surface-bound scenario kinds are declared only for surfaces the restriction
 * actually covers. A hand-written scenario list would be a second copy of the
 * policy table and would drift from it silently — which is the precise defect
 * D-012 found in `MANAGED_CAPABILITY_RESTRICTIONS` itself.
 * P-020 also derives a separate replacement-acceptance manifest from the
 * disposition inventory and client registry, preserving native features and
 * the permanent offline-recovery exclusion under D-032/D-033.
 *
 * DEPENDENCY DIRECTION. This module imports the policy; the policy never
 * imports this module. The policy declares the minimal shape it needs
 * (`CapabilityMatrixEntry`) exactly as it already does for readiness and
 * adoption, so the gate can be driven from both sides in a test without a real
 * client, and the import graph stays acyclic.
 */

import { createHash } from 'node:crypto';

import {
  MANAGED_CAPABILITY_DISPOSITIONS,
  type ManagedCapabilityDisposition,
  type ManagedCapabilityFamilyId,
  type ManagedCapabilityClaimIdentity,
  type ManagedCapabilityControlRef,
  type ManagedCapabilityInventoryClaim,
} from './managed-capability-contract';
import {
  CAPABILITY_CLIENT_ENFORCEMENT,
  MANAGED_CAPABILITY_RESTRICTIONS,
  type CapabilityClientFamily,
  type CapabilityMatrixEntry,
  type CapabilityMatrixGateSource,
  type CapabilityPolicySurface,
  type ManagedCapabilityRestriction,
} from './managed-capability-policy';

/**
 * The scenario kinds the clause enumerates, in its own order.
 *
 * This tuple is the clause text transcribed once. Every other scenario fact in
 * this module is derived, so if the clause is amended this is the single place
 * the taxonomy changes.
 */
export const REAL_CLIENT_SCENARIO_KINDS = [
  'launch',
  'resume',
  'wake',
  'recovery',
  'lifecycle',
  'sandbox',
  'native-disable',
] as const;

export type RealClientMatrixPurpose = 'cutover' | 'replacement-acceptance';
export type RealClientScenarioKind =
  | (typeof REAL_CLIENT_SCENARIO_KINDS)[number]
  | 'native-retention'
  | 'unsupported-controls';

/** Acceptance with native features retained never executes the excluded offline recovery. */
export const REPLACEMENT_CLIENT_SCENARIO_KINDS = [
  'launch',
  'resume',
  'wake',
  'lifecycle',
  'sandbox',
  'native-retention',
  'unsupported-controls',
] as const satisfies readonly RealClientScenarioKind[];

export interface RealClientMatrixDeclarationOptions {
  readonly purpose?: RealClientMatrixPurpose;
  readonly dispositions?: readonly ManagedCapabilityDisposition[];
  readonly clients?: readonly CapabilityClientFamily[];
  readonly surfaces?: readonly CapabilityPolicySurface[];
}

/**
 * The three scenario kinds that ARE a policy surface.
 *
 * `launch`, `resume` and `wake` are the exact members of
 * `CapabilityPolicySurface`, which is why a scenario of one of these kinds is
 * declared only when the restriction covers that surface: claiming a
 * `resume` scenario for a launch-only restriction would manufacture a
 * permanently-missing scenario and wedge the gate closed forever. The other
 * four kinds are cross-surface properties of the managed replacement, so they
 * are declared for every covered family/client pair.
 */
const SURFACE_BOUND_SCENARIO_KINDS: Readonly<
  Partial<Record<RealClientScenarioKind, CapabilityPolicySurface>>
> = Object.freeze({
  launch: 'launch',
  resume: 'resume',
  wake: 'wake',
});

/** One declared cell of the matrix. */
export interface RealClientScenario {
  /** `<family>:<client>:<kind>` — stable, and deduped across restrictions. */
  readonly id: string;
  readonly family: ManagedCapabilityFamilyId;
  readonly client: CapabilityClientFamily;
  readonly kind: RealClientScenarioKind;
  /** The surface a surface-bound scenario exercises; absent for the rest. */
  readonly surface?: CapabilityPolicySurface;
  /** The restriction ids that caused this cell to be declared. */
  readonly declaredBy: readonly string[];
  /** Omitted by legacy manifests, which always mean cutover. */
  readonly purpose?: RealClientMatrixPurpose;
}

/**
 * Derive the declared matrix from the restriction registry.
 *
 * Only `managed-cutover` restrictions scoped to a contract family can declare
 * cutover scenarios: an owner mandate has no managed replacement to accept, and a
 * restriction scoped outside the family taxonomy has no disposition to trace
 * (the same two exclusions `resolveCapabilityPolicy` already applies before it
 * consults readiness, so the manifest covers exactly the population the gate
 * can act on).
 */
export function declareRealClientMatrix(
  restrictions: readonly ManagedCapabilityRestriction[] = MANAGED_CAPABILITY_RESTRICTIONS,
  options: RealClientMatrixDeclarationOptions = {},
): readonly RealClientScenario[] {
  const byId = new Map<string, { scenario: RealClientScenario; declaredBy: string[] }>();

  // Inventory owns the replacement population; restrictions own only cutover.
  // Separate ids prevent acceptance evidence from being reused to disable native tools.
  if (options.purpose === 'replacement-acceptance') {
    const dispositions = options.dispositions ?? MANAGED_CAPABILITY_DISPOSITIONS;
    const clients = options.clients ??
      (Object.keys(CAPABILITY_CLIENT_ENFORCEMENT) as CapabilityClientFamily[]);
    const surfaces = options.surfaces ?? ['launch', 'resume', 'wake'];
    for (const disposition of dispositions) {
      for (const client of clients) {
        for (const kind of REPLACEMENT_CLIENT_SCENARIO_KINDS) {
          const surface = SURFACE_BOUND_SCENARIO_KINDS[kind];
          if (surface !== undefined && !surfaces.includes(surface)) continue;
          const id = `replacement-acceptance:${disposition.family}:${client}:${kind}`;
          const declaredBy = [disposition.evidence.path, ...disposition.gaps.map((gap) => gap.id)];
          byId.set(id, {
            declaredBy,
            scenario: {
              id,
              family: disposition.family,
              client,
              kind,
              declaredBy,
              purpose: 'replacement-acceptance',
              ...(surface ? { surface } : {}),
            },
          });
        }
      }
    }
    return [...byId.values()].map(({ scenario }) => scenario).sort((a, b) => a.id.localeCompare(b.id));
  }

  for (const restriction of restrictions) {
    if (restriction.authority.kind !== 'managed-cutover') continue;
    if (restriction.familyScope.kind !== 'contract-family') continue;
    const family = restriction.familyScope.family;

    for (const client of restriction.clients) {
      for (const kind of REAL_CLIENT_SCENARIO_KINDS) {
        const surface = SURFACE_BOUND_SCENARIO_KINDS[kind];
        if (surface !== undefined && !restriction.surfaces.includes(surface)) continue;

        const id = `${family}:${client}:${kind}`;
        const existing = byId.get(id);
        if (existing) {
          if (!existing.declaredBy.includes(restriction.id)) existing.declaredBy.push(restriction.id);
          continue;
        }
        const declaredBy = [restriction.id];
        byId.set(id, {
          declaredBy,
          scenario: { id, family, client, kind, ...(surface ? { surface } : {}), declaredBy },
        });
      }
    }
  }

  return [...byId.values()]
    .map(({ scenario }) => scenario)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** What one execution of one scenario, in an isolated client profile, saw. */
export interface RealClientScenarioResult {
  readonly scenarioId: string;
  readonly outcome: 'pass' | 'fail' | 'unsupported';
  /** The client version the isolated profile actually ran. */
  readonly clientVersion: string;
  /** ISO-8601. Staleness is measured from here, never from a file mtime. */
  readonly observedAt: string;
  /**
   * The fingerprint the executor published for this result. Deliberately NOT
   * trusted: the report recomputes the canonical fingerprint from the result's
   * own fields and reports a disagreement as an integrity issue, because a
   * result that misreports its own fingerprint would otherwise satisfy a
   * record comparison it never actually matched.
   */
  readonly fingerprint?: string;
  /** Required for replacement acceptance; a help/version probe is not a journey. */
  readonly evidenceRef?: string;
  /** An unsupported result records a measured limitation, never a passing scenario. */
  readonly unsupportedReason?: string;
}

/**
 * The canonical fingerprint of a result.
 *
 * Deterministic and derived from the three facts that decide whether the
 * result is evidence for a given enablement: WHICH scenario, on WHICH client
 * version, with WHICH outcome. Time is excluded on purpose — re-observing the
 * same pass on the same version must not invalidate an enablement, or the
 * record would need re-pinning on every run and the comparison would become
 * noise instead of a control.
 * Optional execution references and unsupported reasons are also bound when
 * present, so changing the cited evidence cannot retain the same fingerprint.
 *
 * The separator is a NUL escape (never a raw byte, which would make the file
 * unsearchable by ripgrep and binary to git diff) because it is the one byte
 * that cannot occur in a scenario id or a version string, which is what makes
 * the concatenation injective.
 */
export function scenarioResultFingerprint(
  result: Pick<RealClientScenarioResult, 'scenarioId' | 'clientVersion' | 'outcome' | 'evidenceRef' | 'unsupportedReason'>,
): string {
  const evidence = result.evidenceRef !== undefined || result.unsupportedReason !== undefined
    ? `\x00${JSON.stringify([result.evidenceRef ?? null, result.unsupportedReason ?? null])}`
    : '';
  return createHash('sha256')
    .update(`${result.scenarioId}\x00${result.clientVersion}\x00${result.outcome}${evidence}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * What a managed default was enabled AGAINST.
 *
 * This is the "default-enablement record" the falsifier's probe method names.
 * It pins the exact fingerprints that justified the enablement, so a later
 * re-run on a different client version (or a quietly re-declared scenario)
 * cannot inherit the old decision: the pinned fingerprint and the current one
 * stop agreeing, and the gate says so.
 */
export interface CapabilityDefaultEnablementRecord {
  readonly family: ManagedCapabilityFamilyId;
  readonly client: CapabilityClientFamily;
  /** ISO-8601 — when the managed default was enabled. */
  readonly enabledAt: string;
  /** scenarioId -> the fingerprint the enablement was justified by. */
  readonly scenarioFingerprints: Readonly<Record<string, string>>;
}

/**
 * The status of one declared scenario.
 *
 * Cutover retains the four falsifier modes. Replacement acceptance can also
 * record a measured unsupported result; that outcome is never a pass.
 */
export type RealClientScenarioStatus =
  | 'passed'
  | 'missing'
  | 'failing'
  | 'stale'
  | 'version-mismatch'
  | 'unsupported';

export interface RealClientScenarioRow {
  readonly scenario: RealClientScenario;
  readonly status: RealClientScenarioStatus;
  /** The result this row was decided from, when one existed at all. */
  readonly result?: RealClientScenarioResult;
  /** Canonical fingerprint of `result`, when there is a result. */
  readonly fingerprint?: string;
  /**
   * True when a default-enablement record exists for this family/client and
   * its pinned fingerprint for this scenario does not equal `fingerprint`.
   * Tracked SEPARATELY from `status` because drift is what the probe method
   * detects, not a fifth way for a scenario to be unproven.
   */
  readonly enablementDrift: boolean;
  readonly detail: string;
}

export interface RealClientMatrixReportOptions {
  readonly purpose?: RealClientMatrixPurpose;
  readonly scenarios?: readonly RealClientScenario[];
  readonly results?: readonly RealClientScenarioResult[];
  readonly records?: readonly CapabilityDefaultEnablementRecord[];
  /** Replacement acceptance requires a current version; legacy cutover retains its unknown-version behavior. */
  readonly clientVersions?: Readonly<Partial<Record<CapabilityClientFamily, string>>>;
  readonly now?: Date;
  /** How long a result stays evidence. Defaults to {@link DEFAULT_SCENARIO_FRESHNESS_MS}. */
  readonly freshnessWindowMs?: number;
}

/**
 * Seven days.
 *
 * Long enough that an ordinary week of no client releases does not expire a
 * whole matrix, short enough that a silently-abandoned acceptance run stops
 * counting as evidence well before a client ships a new minor. It is a
 * declared window rather than a derived one because nothing in the tree
 * measures client release cadence; when something does, derive it.
 */
export const DEFAULT_SCENARIO_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

export interface RealClientMatrixReport {
  readonly rows: readonly RealClientScenarioRow[];
  /** Cutover entries only. Replacement acceptance cannot disable native features. */
  readonly entries: CapabilityMatrixGateSource;
  /** Results whose published fingerprint contradicts their own fields. */
  readonly integrityIssues: readonly string[];
  readonly declaredCount: number;
  readonly passedCount: number;
  readonly unsupportedCount: number;
  /** True only when every declared scenario passed and nothing drifted. */
  readonly allDeclaredScenariosPassed: boolean;
}

/**
 * Resolve the manifest against observed results and the enablement records.
 *
 * Status precedence is deliberate: `missing` (nothing ran) beats `failing`
 * (it ran and said no) beats `version-mismatch` (it passed, but not on the
 * version this launch is) beats `stale` (it passed on the right version, too
 * long ago). Version-mismatch outranks staleness because a FRESH run on the
 * wrong version is still not evidence about this version, whereas staleness is
 * a statement about age on the RIGHT version — reporting the weaker label
 * first would send a reader to re-run a matrix when they actually need to
 * re-pin a version.
 */
export function realClientMatrixReport(
  options: RealClientMatrixReportOptions = {},
): RealClientMatrixReport {
  const scenarios = options.scenarios ?? declareRealClientMatrix(undefined, { purpose: options.purpose });
  const results = options.results ?? [];
  const records = options.records ?? [];
  const now = options.now ?? new Date();
  const freshnessWindowMs = options.freshnessWindowMs ?? DEFAULT_SCENARIO_FRESHNESS_MS;

  const integrityIssues: string[] = [];

  // Latest result per scenario, so a re-run supersedes rather than accumulates.
  const latest = new Map<string, RealClientScenarioResult>();
  for (const result of results) {
    const canonical = scenarioResultFingerprint(result);
    if (result.fingerprint !== undefined && result.fingerprint !== canonical) {
      integrityIssues.push(
        `${result.scenarioId}: published fingerprint '${result.fingerprint}' does not describe its own ` +
          `result (outcome '${result.outcome}' on version '${result.clientVersion}' fingerprints as '${canonical}').`,
      );
    }
    const prior = latest.get(result.scenarioId);
    if (!prior || Date.parse(result.observedAt) >= Date.parse(prior.observedAt)) {
      latest.set(result.scenarioId, result);
    }
  }

  const recordFor = (family: ManagedCapabilityFamilyId, client: CapabilityClientFamily) =>
    records.find((entry) => entry.family === family && entry.client === client);

  const rows: RealClientScenarioRow[] = scenarios.map((scenario) => {
    const result = latest.get(scenario.id);
    const record = recordFor(scenario.family, scenario.client);

    if (!result) {
      return {
        scenario,
        status: 'missing',
        enablementDrift: record !== undefined,
        detail:
          `No isolated real-client result exists for '${scenario.id}' ` +
          `(${scenario.kind}${scenario.surface ? ` on the ${scenario.surface} surface` : ''}).`,
      };
    }

    const fingerprint = scenarioResultFingerprint(result);
    const pinned = record?.scenarioFingerprints[scenario.id];
    const enablementDrift = record !== undefined && pinned !== fingerprint;
    const driftNote = enablementDrift
      ? ` The enabled default was justified by ${pinned ? `fingerprint '${pinned}'` : 'no fingerprint for this scenario'}, not '${fingerprint}'.`
      : '';

    const base = { scenario, result, fingerprint, enablementDrift } as const;

    if (result.fingerprint !== undefined && result.fingerprint !== fingerprint) {
      return { ...base, status: 'failing', detail: `'${scenario.id}' has a forged result fingerprint.${driftNote}` };
    }

    const replacementAcceptance = scenario.purpose === 'replacement-acceptance';
    if (replacementAcceptance && (!result.evidenceRef?.trim() || !result.clientVersion.trim())) {
      return { ...base, status: 'failing', detail: `'${scenario.id}' lacks a versioned execution evidence reference.` };
    }

    if (result.outcome === 'fail') {
      return {
        ...base,
        status: 'failing',
        detail: `'${scenario.id}' FAILED on client version '${result.clientVersion}'.${driftNote}`,
      };
    }

    const current = options.clientVersions?.[scenario.client];
    if ((replacementAcceptance && !current?.trim()) || (current !== undefined && current !== result.clientVersion)) {
      return {
        ...base,
        status: 'version-mismatch',
        detail:
          `'${scenario.id}' was observed on client version '${result.clientVersion}', but the current version is ` +
          `'${current ?? 'unknown'}'. A version change can respell the native surface, so the result is not ` +
          `evidence for this version.${driftNote}`,
      };
    }

    const ageMs = now.getTime() - Date.parse(result.observedAt);
    if ((replacementAcceptance && (!Number.isFinite(ageMs) || ageMs < 0)) ||
        (Number.isFinite(ageMs) && ageMs > freshnessWindowMs)) {
      return {
        ...base,
        status: 'stale',
        detail:
          `'${scenario.id}' has an expired or invalid observation time '${result.observedAt}' ` +
          `for the ${Math.round(freshnessWindowMs / 3_600_000)}h freshness window.${driftNote}`,
      };
    }

    if (result.outcome === 'unsupported') {
      if (!replacementAcceptance || !result.unsupportedReason?.trim()) {
        return { ...base, status: 'failing', detail: `'${scenario.id}' has no valid measured unsupported disposition.` };
      }
      return { ...base, status: 'unsupported', detail: result.unsupportedReason };
    }

    return {
      ...base,
      status: 'passed',
      detail: enablementDrift
        ? `'${scenario.id}' passes, but its fingerprint no longer matches the enablement record.${driftNote}`
        : `'${scenario.id}' passed on client version '${result.clientVersion}' at ${result.observedAt}.`,
    };
  });

  // Collapse to one entry per family/client — the unit the policy gate asks
  // about, since a restriction is enabled for a family AT a client.
  const entryKeys = new Map<
    string,
    { family: ManagedCapabilityFamilyId; client: CapabilityClientFamily }
  >();
  for (const scenario of scenarios) {
    if (scenario.purpose === 'replacement-acceptance') continue;
    entryKeys.set(`${scenario.family}::${scenario.client}`, {
      family: scenario.family,
      client: scenario.client,
    });
  }

  const entries: CapabilityMatrixEntry[] = [...entryKeys.values()].map(({ family, client }) => {
    const owned = rows.filter(
      (row) => row.scenario.purpose !== 'replacement-acceptance' &&
        row.scenario.family === family && row.scenario.client === client,
    );
    const unmet = owned
      .filter((row) => row.status !== 'passed' || row.enablementDrift)
      .map((row) => ({
        scenarioId: row.scenario.id,
        status: row.enablementDrift && row.status === 'passed' ? 'enablement-drift' : row.status,
        detail: row.detail,
      }));
    return {
      client,
      family,
      allScenariosPassed: owned.length > 0 && unmet.length === 0,
      declaredScenarioCount: owned.length,
      unmet,
    };
  });

  const passedCount = rows.filter((row) => row.status === 'passed' && !row.enablementDrift).length;

  return {
    rows,
    entries,
    integrityIssues,
    declaredCount: rows.length,
    passedCount,
    unsupportedCount: rows.filter((row) => row.status === 'unsupported').length,
    allDeclaredScenariosPassed: rows.length > 0 && passedCount === rows.length,
  };
}

/** The gate source, for handing straight to `resolveCapabilityPolicy`. */
export function realClientMatrixGateSource(
  options: RealClientMatrixReportOptions = {},
): CapabilityMatrixGateSource {
  return realClientMatrixReport(options).entries;
}

export interface ManagedCapabilityMeasuredControl {
  ref: ManagedCapabilityControlRef;
  evidenceRef: string;
  scenarioId: string;
  family: ManagedCapabilityFamilyId;
  client: CapabilityClientFamily;
  identity: ManagedCapabilityClaimIdentity;
  role: 'positive' | 'refusal';
  outcome: 'pass' | 'fail' | 'unknown';
  observedAt: string;
  currentness: 'current' | 'stale' | 'unknown';
  withdrawn: boolean;
  /** Automated contradiction checks cannot supply a reserved live observation. */
  live: boolean;
}

export function managedCapabilityControlKey(ref: ManagedCapabilityControlRef): string {
  return JSON.stringify([ref.bindingId, ref.file, ref.caseTitle, ref.occurrence]);
}

export interface ManagedCapabilityInventoryComparisonOptions {
  /** Derived independently of claims; dropping a claim must not shrink the population. */
  scenarios: readonly RealClientScenario[];
  inventory: readonly ManagedCapabilityDisposition[];
  observations: readonly ManagedCapabilityMeasuredControl[];
  /** Immutable earlier inventory, resolved by the caller from retained evidence. */
  previousInventory?: readonly { family: ManagedCapabilityFamilyId; gapIds: readonly string[] }[];
  clientVersions: Readonly<Partial<Record<CapabilityClientFamily, string>>>;
  now?: Date;
  freshnessWindowMs?: number;
}

/**
 * Claim integrity, not a second functional grade. A current, faithfully reported
 * failing pair can pass this comparison. Missing/uncertain live observations
 * remain unknown, and only a passing exact pair can discharge a named gap.
 * No latest-result reduction: every historical observation remains in the census.
 */
export function compareManagedCapabilityInventory(options: ManagedCapabilityInventoryComparisonOptions) {
  const issues: string[] = [];
  const unknown: string[] = [];
  const population = options.scenarios.map(s => s.id);
  const selected = new Map(options.scenarios.map(s => [s.id, s]));
  const duplicate = <T>(values: readonly T[], key: (value: T) => string, kind: string) => {
    const seen = new Set<string>();
    for (const value of values) {
      const id = key(value);
      if (seen.has(id)) issues.push(`duplicate-${kind}:${id}`);
      seen.add(id);
    }
  };
  duplicate(options.scenarios, s => s.id, 'scenario');
  duplicate(options.inventory, d => d.family, 'family');
  duplicate(options.observations, o => managedCapabilityControlKey(o.ref), 'control');
  if (!population.length) unknown.push('empty-population');
  const now = (options.now ?? new Date()).getTime();
  const maxAge = options.freshnessWindowMs ?? DEFAULT_SCENARIO_FRESHNESS_MS;
  if (!Number.isFinite(now) || !Number.isFinite(maxAge) || maxAge < 0) unknown.push('invalid-measurement-window');
  const controls = new Map(options.observations.map(o => [managedCapabilityControlKey(o.ref), o]));
  const claims = new Map<string, { family: ManagedCapabilityFamilyId; claim: ManagedCapabilityInventoryClaim }>();
  for (const disposition of options.inventory) {
    for (const claim of disposition.parityClaims ?? []) {
      if (claims.has(claim.scenarioId)) issues.push(`duplicate-claim:${claim.scenarioId}`);
      claims.set(claim.scenarioId, { family: disposition.family, claim });
      if (!selected.has(claim.scenarioId)) issues.push(`orphan-claim:${claim.scenarioId}`);
    }
  }
  const checked: string[] = [];
  const notChecked: string[] = [];
  const passing = new Set<string>();
  const sameIdentity = (a: ManagedCapabilityClaimIdentity, b: ManagedCapabilityClaimIdentity) =>
    (Object.keys(a) as Array<keyof ManagedCapabilityClaimIdentity>).length === 9 &&
    (Object.keys(b) as Array<keyof ManagedCapabilityClaimIdentity>).length === 9 &&
    Object.entries(a).every(([key, value]) => value === b[key as keyof ManagedCapabilityClaimIdentity]);
  const validIdentity = (identity: ManagedCapabilityClaimIdentity) =>
    Number.isSafeInteger(identity.specRevision) && identity.specRevision > 0 &&
    ['planSlug', 'specId', 'specFingerprint', 'barHash', 'sourceFingerprint', 'clientVersion',
      'runtimeFingerprint', 'environmentFingerprint'].every(key =>
      typeof identity[key as keyof ManagedCapabilityClaimIdentity] === 'string' &&
      String(identity[key as keyof ManagedCapabilityClaimIdentity]).trim().length > 0);
  for (const scenario of options.scenarios) {
    const entry = claims.get(scenario.id);
    if (!entry) { notChecked.push(scenario.id); continue; }
    const { claim } = entry;
    const before = issues.length;
    if (entry.family !== scenario.family) issues.push(`claim-family:${scenario.id}`);
    if (!validIdentity(claim.identity) || !options.clientVersions[scenario.client] ||
        claim.identity.clientVersion !== options.clientVersions[scenario.client]) issues.push(`claim-identity:${scenario.id}`);
    const history = options.observations.filter(o => o.scenarioId === scenario.id);
    for (const ref of claim.retainedEvidenceRefs) {
      if (!history.some(o => o.evidenceRef === ref)) issues.push(`orphan-evidence-ref:${scenario.id}:${ref}`);
    }
    for (const observation of history) {
      if (!claim.retainedEvidenceRefs.includes(observation.evidenceRef)) issues.push(`erased-observation:${observation.evidenceRef}`);
    }
    if (!claim.controls || ['notChecked', 'unsupported'].includes(claim.outcome)) {
      notChecked.push(scenario.id);
      if (claim.outcome === 'pass' || claim.outcome === 'fail') issues.push(`missing-control-pair:${scenario.id}`);
      if (claim.closesGaps?.length) issues.push(`unproved-gap-removal:${scenario.id}`);
      continue;
    }
    const pair: ManagedCapabilityMeasuredControl[] = [];
    let incomplete = false;
    for (const role of ['positive', 'refusal'] as const) {
      const ref = claim.controls[role];
      const observation = controls.get(managedCapabilityControlKey(ref));
      if (!Number.isSafeInteger(ref.bindingId) || ref.bindingId <= 0 || !ref.file.trim() || !ref.caseTitle.trim() ||
          !Number.isSafeInteger(ref.occurrence) || ref.occurrence < 0 || !observation) {
        issues.push(`missing-selected-case:${scenario.id}:${role}`); incomplete = true; continue;
      }
      pair.push(observation);
      if (observation.role !== role || observation.scenarioId !== scenario.id ||
          observation.family !== scenario.family || observation.client !== scenario.client ||
          !sameIdentity(claim.identity, observation.identity)) issues.push(`misbound-control:${scenario.id}:${role}`);
      const age = now - Date.parse(observation.observedAt);
      if (observation.withdrawn || observation.currentness !== 'current' || !Number.isFinite(age) ||
          age < 0 || age > maxAge) issues.push(`stale-control:${scenario.id}:${role}`);
      if (history.some(o => o.role === role && !o.withdrawn && sameIdentity(o.identity, observation.identity) &&
          Date.parse(o.observedAt) > Date.parse(observation.observedAt))) issues.push(`superseded-control:${scenario.id}:${role}`);
      if (!observation.live || observation.outcome === 'unknown') incomplete = true;
    }
    if (managedCapabilityControlKey(claim.controls.positive) === managedCapabilityControlKey(claim.controls.refusal)) {
      issues.push(`unpaired-control:${scenario.id}`);
    }
    const measured = incomplete ? 'unknown' : pair.some(o => o.outcome === 'fail') ? 'fail' : 'pass';
    if (claim.outcome !== measured) issues.push(`unsupported-claim:${scenario.id}:${claim.outcome}:${measured}`);
    if (incomplete) notChecked.push(scenario.id);
    else checked.push(scenario.id);
    if (measured === 'pass' && before === issues.length) passing.add(scenario.id);
    if (claim.closesGaps?.length && !passing.has(scenario.id)) issues.push(`unproved-gap-removal:${scenario.id}`);
  }
  const currentGaps = new Map(options.inventory.map(d => [d.family, new Set(d.gaps.map(g => g.id))]));
  if (!options.previousInventory) unknown.push('previous-inventory-unavailable');
  for (const disposition of options.inventory) {
    if (!options.previousInventory?.some(d => d.family === disposition.family)) unknown.push(`previous-family-unavailable:${disposition.family}`);
  }
  duplicate(options.previousInventory ?? [], d => d.family, 'previous-family');
  for (const previous of options.previousInventory ?? []) {
    for (const gap of previous.gapIds) {
      if (currentGaps.get(previous.family)?.has(gap)) continue;
      const proved = [...claims.values()].some(({ family, claim }) => family === previous.family &&
        claim.closesGaps?.includes(gap) && passing.has(claim.scenarioId));
      if (!proved) issues.push(`removed-unproved-gap:${previous.family}:${gap}`);
    }
  }
  for (const disposition of options.inventory) {
    if (!disposition.cutoverReady) continue;
    const owned = options.scenarios.filter(s => s.family === disposition.family);
    if (!owned.length || owned.some(s => !passing.has(s.id)) || disposition.gaps.length) {
      issues.push(`premature-readiness:${disposition.family}`);
    }
  }
  const residue = [...new Set([...issues, ...unknown, ...notChecked.map(id => `notChecked:${id}`)])];
  return {
    verdict: issues.length ? 'fail' as const : residue.length ? 'unknown' as const : 'pass' as const,
    integrityIssues: issues, unknownReasons: unknown,
    coverage: { population, checked, notChecked, notApplicable: [] as string[], residue },
    observations: options.observations,
  };
}
