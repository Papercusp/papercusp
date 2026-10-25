/**
 * Behavioural tests for the ONE capability policy (P-005).
 *
 * These assert PROPERTIES, not a transcription of the table: the point of the
 * module is that launch/resume/wake cannot drift apart, so the tests are
 * written so that re-introducing the drift fails them.
 */

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_CLIENT_ENFORCEMENT,
  CONTRACT_CAPABILITY_READINESS,
  MANAGED_CAPABILITY_RESTRICTIONS,
  capabilityPolicyFlags,
  composeOmpCapabilityTools,
  policyDeferralEnv,
  policyDeferralReachable,
  resolveCapabilityPolicy,
  type CapabilityPolicySurface,
  type CapabilityPolicyRequest,
  type CapabilityReadinessSource,
  type ManagedCapabilityRestriction,
} from './managed-capability-policy';
import { NO_SUBAGENT_TOOLS_DENY } from './no-subagent-deny';
import { NATIVE_TOOL_SEARCH_DENY } from './native-tool-search-deny';
import { OWNER_DESKTOP_NOTIFY_BASH_DENY } from './owner-desktop-notify-deny';
import { OS_SCHEDULER_BASH_DENY } from './native-scheduler-deny';

const SURFACES: readonly CapabilityPolicySurface[] = ['launch', 'resume', 'wake'];

describe('managed capability policy — surface parity', () => {
  it('resolves an IDENTICAL denied-name set on launch, resume and wake', () => {
    // THE regression this module exists to prevent. Before it, the wake path
    // re-armed three of four denies and silently dropped the desktop-notify
    // one, so a restriction that held at launch lapsed on the first wake.
    const [launch, resume, wake] = SURFACES.map((surface) =>
      resolveCapabilityPolicy({ client: 'claude', surface }),
    );

    expect(resume.deniedNames).toEqual(launch.deniedNames);
    expect(wake.deniedNames).toEqual(launch.deniedNames);
    expect(wake.flags).toEqual(launch.flags);
  });

  it('re-arms the owner-desktop-notify deny on wake, not only at launch', () => {
    // The exact name that drifted. Pinned by value so a future refactor that
    // re-drops it from the wake path fails here rather than in production.
    const wake = resolveCapabilityPolicy({ client: 'claude', surface: 'wake' });
    for (const name of OWNER_DESKTOP_NOTIFY_BASH_DENY) {
      expect(wake.deniedNames).toContain(name);
    }
  });

  it('accounts for EVERY restriction on every surface — none silently dropped', () => {
    for (const surface of SURFACES) {
      const decision = resolveCapabilityPolicy({ client: 'claude', surface });
      const accounted = new Set([
        ...decision.applied.map((entry) => entry.id),
        ...decision.withheld.map((entry) => entry.id),
      ]);
      expect(accounted.size).toBe(MANAGED_CAPABILITY_RESTRICTIONS.length);
    }
  });
});

describe('managed capability policy — aliases and nested execution', () => {
  it('denies every alias of the subagent fan-out, not just the current name', () => {
    // 'Task' is the pre-rename spelling of 'Agent'. Denying one leaves the
    // other reachable, which is a restriction in name only.
    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });
    for (const alias of NO_SUBAGENT_TOOLS_DENY) {
      expect(decision.deniedNames).toContain(alias);
    }
    expect(NO_SUBAGENT_TOOLS_DENY.length).toBeGreaterThan(1);
  });

  it('denies the NESTED Bash route to the OS scheduler alongside the direct tools', () => {
    // Denying CronCreate while leaving Bash(crontab:*) open restricts nothing.
    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });
    expect(decision.deniedNames).toContain('CronCreate');
    for (const nested of OS_SCHEDULER_BASH_DENY) {
      expect(decision.deniedNames).toContain(nested);
    }
  });

  it('keeps every emitted flag a single `=` token with no spaces', () => {
    // The space form of --disallowedTools is variadic and would swallow the
    // positional wake text that the wake path appends after these flags.
    for (const flag of capabilityPolicyFlags({ client: 'claude', surface: 'wake' })) {
      expect(flag.startsWith('--disallowedTools=')).toBe(true);
      expect(flag).not.toContain(' ');
    }
  });
});

describe('managed capability policy — overrides', () => {
  it('clears the subagent restriction on the owner opt-in, and only that one', () => {
    const decision = resolveCapabilityPolicy({
      client: 'claude',
      surface: 'launch',
      overrides: ['allow-subagents'],
    });

    expect(decision.deniedNames).not.toContain('Agent');
    const withheld = decision.withheld.find((entry) => entry.id === 'no-subagent-fanout');
    expect(withheld?.reason).toBe('owner-override');
    // The opt-in must not leak into unrelated restrictions.
    expect(decision.deniedNames).toContain('ToolSearch');
  });

  it('defers ONLY the carve-out restrictions to an operator-supplied deny list', () => {
    const decision = resolveCapabilityPolicy({
      client: 'claude',
      surface: 'launch',
      explicitDenyList: true,
    });

    // D-004 carve-out: the scheduler posture yields to the operator...
    expect(decision.withheld.find((e) => e.id === 'no-native-scheduler')?.reason).toBe(
      'explicit-deny-list',
    );
    // ...but the subagent and tool-search mandates compose regardless, because
    // claude unions repeated --disallowedTools occurrences.
    expect(decision.deniedNames).toContain('Agent');
    for (const alias of NATIVE_TOOL_SEARCH_DENY) {
      expect(decision.deniedNames).toContain(alias);
    }
  });

  it('keeps the scheduling SKILLS for the interactive owner but not a headless agent', () => {
    const headless = resolveCapabilityPolicy({
      client: 'claude',
      surface: 'launch',
      audience: 'headless-agent',
    });
    const interactive = resolveCapabilityPolicy({
      client: 'claude',
      surface: 'launch',
      audience: 'interactive-su',
    });

    expect(headless.deniedNames).toContain('Skill(schedule)');
    expect(interactive.deniedNames).not.toContain('Skill(schedule)');
    // The underlying scheduler TOOLS are still denied to the owner session —
    // it is only the human-typed slash-command surface that is preserved.
    expect(interactive.deniedNames).toContain('CronCreate');
    expect(
      interactive.withheld.find((e) => e.id === 'no-native-scheduler-skills')?.reason,
    ).toBe('audience-not-covered');
  });
});

describe('managed capability policy — replacement-quality gating', () => {
  it('retains native features on every client and lifecycle surface even when replacement evidence passes', () => {
    const proven: CapabilityReadinessSource = CONTRACT_CAPABILITY_READINESS.map((entry) => ({
      ...entry,
      cutoverReady: true,
      openGapIds: [],
    }));
    for (const client of ['claude', 'codex', 'omp'] as const) {
      for (const surface of SURFACES) {
        const baseline = resolveCapabilityPolicy({ client, surface });
        const decision = resolveCapabilityPolicy({
          client,
          surface,
          readiness: proven,
          adoption: proven.map((entry) => ({
            client,
            family: entry.family,
            managedPathProven: true,
            nativeBypassRefused: true,
          })),
          matrix: proven.map((entry) => ({
            client,
            family: entry.family,
            allScenariosPassed: true,
            declaredScenarioCount: 1,
            unmet: [],
          })),
          // Deliberately use the shipped rollout default: proof never enables it.
        });
        expect(decision.flags).toEqual(baseline.flags);
        expect(decision.deniedNames).toEqual(baseline.deniedNames);
        expect(decision.applied.filter((entry) => entry.authorityKind === 'managed-cutover')).toEqual([]);
        expect(decision.deniedNames).not.toContain('Bash');
      }
    }
  });

  it('withholds a managed-cutover restriction while its replacement is unproven', () => {
    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });
    const withheld = decision.withheld.find((entry) => entry.id === 'managed-shell-cutover');

    expect(withheld?.reason).toBe('replacement-unproven');
    // The native shell must remain reachable — restricting it before the
    // managed replacement is proven strands the agent.
    expect(decision.deniedNames).not.toContain('Bash');
    // The denial is TEACHING: it names the family's open gaps rather than
    // reporting a bare refusal.
    expect(withheld?.detail).toContain('shell-ssh-interpreters');
  });

  it('applies the same restriction once the replacement IS proven', () => {
    // Both sides of the gate, so "withheld" is proven to be the gate working
    // rather than the restriction being permanently inert.
    const proven: CapabilityReadinessSource = CONTRACT_CAPABILITY_READINESS.map((entry) =>
      entry.family === 'shell-ssh-interpreters'
        ? { ...entry, cutoverReady: true, openGapIds: [] }
        : entry,
    );

    const decision = resolveCapabilityPolicy({
      client: 'claude',
      surface: 'launch',
      readiness: proven,
      // P-007 added two further gates AFTER this one: a cutover must also be
      // staged for the audience and evidenced on both control arms. They are
      // satisfied here so this test keeps isolating the READINESS gate it was
      // written for. Their own both-sides coverage lives in
      // `managed-capability-adoption.test.ts`; proving parity alone no longer
      // enables a restriction is the point of P-007, not a regression here.
      cutoverStaging: { 'shell-ssh-interpreters': 'full' },
      adoption: [
        {
          client: 'claude',
          family: 'shell-ssh-interpreters',
          managedPathProven: true,
          nativeBypassRefused: true,
        },
      ],
      // P-008 added a THIRD downstream gate: the isolated real-client matrix
      // must have passed every declared scenario. Satisfied here for the same
      // reason the P-007 pair above is — so this test keeps isolating the
      // READINESS gate it was written for. Its own both-sides coverage lives
      // in `managed-capability-matrix.test.ts`.
      matrix: [
        {
          client: 'claude',
          family: 'shell-ssh-interpreters',
          allScenariosPassed: true,
          declaredScenarioCount: 7,
          unmet: [],
        },
      ],
    });

    expect(decision.deniedNames).toContain('Bash');
    expect(decision.applied.find((e) => e.id === 'managed-shell-cutover')?.authorityKind).toBe(
      'managed-cutover',
    );
  });

  it('gates cutover restrictions ONLY — an owner mandate needs no replacement proof', () => {
    // An owner prohibition has nothing to prove ready, so an empty readiness
    // source must not silently disarm the mandates.
    const decision = resolveCapabilityPolicy({
      client: 'claude',
      surface: 'launch',
      readiness: [],
    });

    expect(decision.deniedNames).toContain('Agent');
    expect(decision.deniedNames).toContain('ToolSearch');
    expect(decision.deniedNames).not.toContain('Bash');
  });

  it('derives readiness from the shipped contract rather than restating it', () => {
    // Every family in the readiness source must trace to a contract entry; a
    // hand-maintained copy would be free to drift from the evidence.
    expect(CONTRACT_CAPABILITY_READINESS.length).toBeGreaterThan(0);
    for (const entry of CONTRACT_CAPABILITY_READINESS) {
      expect(typeof entry.cutoverReady).toBe('boolean');
    }
  });
});

describe('managed capability policy — honest per-client coverage', () => {
  it('renders no claude deny flags for a client that cannot consume them', () => {
    for (const client of ['codex', 'omp'] as const) {
      const decision = resolveCapabilityPolicy({ client, surface: 'launch' });
      expect(decision.flags).toEqual([]);
      expect(decision.deniedNames).toEqual([]);
    }
  });

  it('distinguishes the measured config controls from the other enforcement mechanisms', () => {
    // A parity matrix that cannot tell these apart reports both as one gap.
    expect(CAPABILITY_CLIENT_ENFORCEMENT.codex).toBe('feature-switches');
    expect(CAPABILITY_CLIENT_ENFORCEMENT.omp).toBe('allow-list-cut');
    expect(CAPABILITY_CLIENT_ENFORCEMENT.claude).toBe('deny-list');

    const omp = resolveCapabilityPolicy({ client: 'omp', surface: 'launch' });
    const ompWithheld = omp.withheld.find((e) => e.id === 'no-subagent-fanout');
    // 'client-not-covered' means the restriction was never declared for OMP;
    // that is a different fact from "declared but unenforceable here".
    expect(ompWithheld?.reason).toBe('client-not-covered');
  });

  it('reports an unenforceable restriction rather than dropping it', () => {
    // A restriction declared for a client whose enforcement surface cannot
    // render it must surface as withheld with the mechanism named.
    const decision = resolveCapabilityPolicy(
      { client: 'omp', surface: 'launch' },
      [
        {
          ...MANAGED_CAPABILITY_RESTRICTIONS[0],
          clients: ['omp'],
        },
      ],
    );

    const withheld = decision.withheld[0];
    expect(withheld?.reason).toBe('no-client-enforcement-surface');
    expect(withheld?.detail).toContain('allow-list');
    expect(decision.flags).toEqual([]);
  });
});

describe('Codex version-pinned removal controls', () => {
  const admitted: CapabilityPolicyRequest = {
    client: 'codex', surface: 'launch', clientVersions: { codex: '0.163.0' },
    readiness: [{ family: 'shell-ssh-interpreters', cutoverReady: true, openGapIds: [] }],
    cutoverStaging: { 'shell-ssh-interpreters': 'full' },
    adoption: [{ client: 'codex', family: 'shell-ssh-interpreters',
      managedPathProven: true, nativeBypassRefused: true, atClientVersion: '0.163.0' }],
    matrix: [{ client: 'codex', family: 'shell-ssh-interpreters',
      allScenariosPassed: true, declaredScenarioCount: 7, unmet: [] }],
  };

  it.each(SURFACES)('removes the measured native shell aliases on %s without Claude flags', surface => {
    const decision = resolveCapabilityPolicy({ ...admitted, surface });
    expect(decision.featureSwitches).toEqual({ shell_tool: false });
    expect(decision.deniedNames).toEqual(['exec_command', 'write_stdin']);
    expect(decision.flags).toEqual([]);
  });

  it.each([undefined, '0.163.1', 'unknown'])('withholds controls for unvalidated version %s', version => {
    // Omit the adoption version too: the control's own version guard must hold
    // independently of the older adoption-to-current comparison.
    const decision = resolveCapabilityPolicy({ ...admitted,
      clientVersions: version ? { codex: version } : {},
      adoption: admitted.adoption!.map(row => ({ ...row, atClientVersion: undefined })),
    });
    expect(decision.featureSwitches).toEqual({});
    expect(decision.applied).toEqual([]);
    expect(decision.withheld.find(row => row.id === 'managed-shell-cutover')?.reason)
      .toBe('client-version-drift');
  });

  it('keeps parity, rollout, and matrix admission ahead of config emission', () => {
    for (const request of [
      { ...admitted, readiness: [] }, { ...admitted, adoption: [] },
      { ...admitted, matrix: [] }, { ...admitted, cutoverStaging: {} },
      { client: 'codex' as const, surface: 'launch' as const },
    ]) expect(resolveCapabilityPolicy(request).featureSwitches).toEqual({});
  });

  it('reports an unmeasured control even when an owner mandate covers Codex', () => {
    const decision = resolveCapabilityPolicy(admitted, [{
      ...MANAGED_CAPABILITY_RESTRICTIONS[0], clients: ['codex'],
    }]);
    expect(decision.featureSwitches).toEqual({});
    expect(decision.withheld[0]?.reason).toBe('no-client-enforcement-surface');
  });
});

describe('OMP version-pinned removal and allow-list composition', () => {
  const admitted: CapabilityPolicyRequest = {
    client: 'omp', surface: 'launch', clientVersions: { omp: '18.0.3' },
    ompNativeTools: ['read', 'bash', 'grep'],
    readiness: [{ family: 'shell-ssh-interpreters', cutoverReady: true, openGapIds: [] }],
    cutoverStaging: { 'shell-ssh-interpreters': 'full' },
    adoption: [{ client: 'omp', family: 'shell-ssh-interpreters',
      managedPathProven: true, nativeBypassRefused: true, atClientVersion: '18.0.3' }],
    matrix: [{ client: 'omp', family: 'shell-ssh-interpreters',
      allScenariosPassed: true, declaredScenarioCount: 7, unmet: [] }],
  };

  it.each(SURFACES)('cuts bash on %s and preserves an explicit narrower selection', surface => {
    expect(resolveCapabilityPolicy({ ...admitted, surface }).deniedNames).toEqual(['bash']);
    expect(composeOmpCapabilityTools(['--tools', 'read,bash,grep'], { ...admitted, surface }))
      .toEqual(['--tools', 'read,grep']);
    expect(composeOmpCapabilityTools(['--tools=bash'], { ...admitted, surface })).toEqual(['--no-tools']);
    expect(composeOmpCapabilityTools(['--no-tools'], { ...admitted, surface })).toEqual(['--no-tools']);
  });

  it('normalizes repeated flags so an operator selection cannot restore bash', () => {
    const argv = ['--print', '--tools', 'read,bash', '--tools=grep,bash'];
    const result = composeOmpCapabilityTools(argv, admitted);
    expect(result).toEqual(['--print', '--tools', 'grep']);
    // Wrong implementation: appending a second selection lets its bash win.
    expect([...result, '--tools', 'bash'].at(-1)).toBe('bash');
  });

  it.each([undefined, '18.0.4', 'unknown'])('retains the surface for an unvalidated version %s', version => {
    const request = { ...admitted, clientVersions: version ? { omp: version } : {},
      adoption: admitted.adoption!.map(row => ({ ...row, atClientVersion: undefined })) };
    expect(resolveCapabilityPolicy(request).withheld.find(row => row.id === 'managed-shell-cutover')?.reason)
      .toBe('client-version-drift');
    expect(composeOmpCapabilityTools(['--tools', 'read,bash'], request)).toEqual(['--tools', 'read,bash']);
  });

  it('keeps each evidence gate ahead of allow-list emission', () => {
    for (const request of [{ ...admitted, readiness: [] }, { ...admitted, adoption: [] },
      { ...admitted, matrix: [] }, { ...admitted, cutoverStaging: {} }]) {
      expect(composeOmpCapabilityTools([], request)).toEqual([]);
    }
  });

  it('retains unmeasured and code-mode surfaces instead of losing eval/hub or enabling other tools', () => {
    for (const ompNativeTools of [undefined, [], ['read', 'bash', 'eval', 'hub']]) {
      const request = { ...admitted, ompNativeTools };
      expect(composeOmpCapabilityTools([], request)).toEqual([]);
      expect(resolveCapabilityPolicy(request).withheld.find(row => row.id === 'managed-shell-cutover')?.reason)
        .toBe('no-client-enforcement-surface');
    }
    expect(() => composeOmpCapabilityTools(['--tools', 'browser,bash'], admitted))
      .toThrow('selection changed after measurement');
  });
});

describe('managed capability policy — derived deferral env', () => {
  it('never emits ENABLE_TOOL_SEARCH while ToolSearch is denied', () => {
    // Both halves shipped independently once and contradicted each other in
    // production for four days, each reading healthy alone.
    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });
    expect(decision.deniedNames).toContain('ToolSearch');
    expect(policyDeferralReachable(decision)).toBe(false);
    expect(policyDeferralEnv(decision)).toEqual({});
  });

  it('re-enables the deferral env when the deny is absent', () => {
    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' }, []);
    expect(policyDeferralReachable(decision)).toBe(true);
    expect(policyDeferralEnv(decision)).toEqual({ ENABLE_TOOL_SEARCH: 'true' });
  });
});

/**
 * FALSIFIABILITY CONTROLS — permanently retained, per CLAUDE.md § "Proving a
 * guard is falsifiable" (tier 1: a module you `import`).
 *
 * Every assertion ABOVE is a property that passes. Passing tests cannot
 * distinguish "this suite checks the policy" from "this suite asserts nothing":
 * 22 greens that have never been observed to fail are, to a reader, the same
 * artifact either way. These controls close that gap by driving THE REAL
 * DETECTORS against deliberately DRIFTED tables and requiring them to fire.
 *
 * `resolveCapabilityPolicy` takes the restriction table as its second
 * parameter precisely so this can be done WITHOUT mutating the shared tree —
 * no copy-out, no sweep race, no lock (the in-tree `cp`/mutate/restore idiom
 * has committed a mutant here before).
 *
 * Each control is PAIRED with a calibration on the REAL table. Without the
 * pair, a control still passes when the property itself is broken — it would
 * only prove the drifted table differs from something, not that the shipped
 * one is correct.
 */

/**
 * Rewrite ONE restriction in the real table, leaving every other entry intact.
 *
 * Throws when the id is unknown or the patch changes nothing. A control whose
 * anchor silently matches nothing degenerates into comparing the program
 * against itself, which is the single most common way a mutation control lies
 * — it reports a confident "caught" having mutated exactly zero bytes.
 */
function drift(
  id: string,
  patch: Partial<ManagedCapabilityRestriction>,
): readonly ManagedCapabilityRestriction[] {
  const target = MANAGED_CAPABILITY_RESTRICTIONS.find((entry) => entry.id === id);
  if (!target) {
    throw new Error(
      `falsifiability control targeted unknown restriction id '${id}' — the table was renamed and this control stopped mutating anything`,
    );
  }
  const drifted = MANAGED_CAPABILITY_RESTRICTIONS.map((entry) =>
    entry.id === id ? { ...entry, ...patch } : entry,
  );
  if (JSON.stringify(drifted) === JSON.stringify(MANAGED_CAPABILITY_RESTRICTIONS)) {
    throw new Error(
      `falsifiability control for '${id}' produced a NO-OP drift — it would compare the real table against itself`,
    );
  }
  return drifted;
}

describe('managed capability policy — falsifiability controls', () => {
  it('CONTROL: the surface-parity detector FIRES when wake silently drops a restriction', () => {
    // Reproduces THE regression this module exists to prevent: before it, the
    // wake path re-armed three of four denies and dropped desktop-notify, so a
    // restriction that held at launch lapsed on the first wake.
    const drifted = drift('no-owner-desktop-notify', { surfaces: ['launch', 'resume'] });

    const launch = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' }, drifted);
    const wake = resolveCapabilityPolicy({ client: 'claude', surface: 'wake' }, drifted);

    expect(wake.deniedNames).not.toEqual(launch.deniedNames);
    for (const name of OWNER_DESKTOP_NOTIFY_BASH_DENY) {
      expect(wake.deniedNames).not.toContain(name);
    }

    // CALIBRATION: the shipped table passes the very assertion the drift breaks.
    const realLaunch = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });
    const realWake = resolveCapabilityPolicy({ client: 'claude', surface: 'wake' });
    expect(realWake.deniedNames).toEqual(realLaunch.deniedNames);
  });

  it('CONTROL: the alias detector FIRES when a restriction denies only one spelling', () => {
    // A restriction in name only: denying 'Agent' while 'Task' stays reachable.
    const [firstAlias] = NO_SUBAGENT_TOOLS_DENY;
    const drifted = drift('no-subagent-fanout', { aliases: [firstAlias] });

    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' }, drifted);
    const missed = NO_SUBAGENT_TOOLS_DENY.filter((alias) => !decision.deniedNames.includes(alias));
    expect(missed.length).toBeGreaterThan(0);

    // CALIBRATION: the shipped table leaves no spelling reachable.
    const real = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });
    for (const alias of NO_SUBAGENT_TOOLS_DENY) {
      expect(real.deniedNames).toContain(alias);
    }
  });

  it('CONTROL: the nested-route detector FIRES when the shell route to the OS scheduler is dropped', () => {
    // Denying CronCreate while leaving `Bash(crontab:*)` open restricts nothing.
    const drifted = drift('no-os-scheduler-shell', { nestedRoutes: [] });

    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' }, drifted);
    expect(decision.deniedNames).toContain('CronCreate');
    for (const nested of OS_SCHEDULER_BASH_DENY) {
      expect(decision.deniedNames).not.toContain(nested);
    }

    // CALIBRATION: the shipped table closes the nested route alongside the tool.
    const real = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });
    for (const nested of OS_SCHEDULER_BASH_DENY) {
      expect(real.deniedNames).toContain(nested);
    }
  });

  it('CONTROL: the audience detector FIRES when the shell routes are folded back onto the all-audience deny', () => {
    // This is not a hypothetical drift — it is the ACTUAL pre-fix table, as it
    // stood in commit 340985364b before the audience split. Folding
    // OS_SCHEDULER_BASH_DENY onto the all-audience scheduler restriction hands
    // the INTERACTIVE su session a strictly WIDER posture than the launcher
    // ships, taking `Bash(systemd-run:*)` away from capability:bash and
    // scripts/verify-tauri-headless.sh, which both shell out to it.
    const preFix: readonly ManagedCapabilityRestriction[] = MANAGED_CAPABILITY_RESTRICTIONS.filter(
      (entry) => entry.id !== 'no-os-scheduler-shell',
    ).map((entry) =>
      entry.id === 'no-native-scheduler'
        ? { ...entry, nestedRoutes: OS_SCHEDULER_BASH_DENY }
        : entry,
    );
    // Assert the reconstruction actually differs from what shipped, so a later
    // refactor cannot quietly turn this control into a self-comparison.
    expect(JSON.stringify(preFix)).not.toBe(JSON.stringify(MANAGED_CAPABILITY_RESTRICTIONS));

    const interactive = resolveCapabilityPolicy(
      { client: 'claude', surface: 'launch', audience: 'interactive-su' },
      preFix,
    );
    for (const nested of OS_SCHEDULER_BASH_DENY) {
      expect(interactive.deniedNames).toContain(nested);
    }

    // CALIBRATION: the shipped table keeps those shell routes OPEN for the
    // interactive owner, matching what psu-launcher actually sends.
    const real = resolveCapabilityPolicy({
      client: 'claude',
      surface: 'launch',
      audience: 'interactive-su',
    });
    for (const nested of OS_SCHEDULER_BASH_DENY) {
      expect(real.deniedNames).not.toContain(nested);
    }
  });

  it('CONTROL: the replacement-quality gate FIRES when a cutover is declared ready without evidence', () => {
    // The gate's whole purpose is that a managed-cutover restriction cannot be
    // applied while its replacement is unproven. Forging readiness must be the
    // ONLY thing that lets it through.
    const forged: CapabilityReadinessSource = CONTRACT_CAPABILITY_READINESS.map((entry) => ({
      ...entry,
      cutoverReady: true,
      openGapIds: [],
    }));

    const forgedDecision = resolveCapabilityPolicy({
      client: 'claude',
      surface: 'launch',
      readiness: forged,
    });
    const forgedWithheld = forgedDecision.withheld.find((e) => e.id === 'managed-shell-cutover');
    expect(forgedWithheld?.reason).not.toBe('replacement-unproven');

    // CALIBRATION: against the REAL shipped readiness the same restriction is
    // withheld, and withheld for exactly that reason.
    const real = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });
    expect(real.withheld.find((e) => e.id === 'managed-shell-cutover')?.reason).toBe(
      'replacement-unproven',
    );
  });

  it('CONTROL: the accounting detector FIRES when a restriction is neither applied nor withheld', () => {
    // `accounted.size === MANAGED_CAPABILITY_RESTRICTIONS.length` is the
    // assertion that catches a silently-vanishing restriction. Prove it can
    // fail by resolving against a table that is SHORT one entry while the
    // expectation still counts the real table.
    const short = MANAGED_CAPABILITY_RESTRICTIONS.slice(1);
    expect(short.length).toBe(MANAGED_CAPABILITY_RESTRICTIONS.length - 1);

    const decision = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' }, short);
    const accounted = new Set([
      ...decision.applied.map((entry) => entry.id),
      ...decision.withheld.map((entry) => entry.id),
    ]);
    expect(accounted.size).not.toBe(MANAGED_CAPABILITY_RESTRICTIONS.length);

    // CALIBRATION: the shipped table accounts for every restriction.
    const real = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' });
    const realAccounted = new Set([
      ...real.applied.map((entry) => entry.id),
      ...real.withheld.map((entry) => entry.id),
    ]);
    expect(realAccounted.size).toBe(MANAGED_CAPABILITY_RESTRICTIONS.length);
  });
});

/**
 * P-005 clause: "preserve sandbox/access policy".
 *
 * The clause is satisfied by NON-INTERFERENCE, not by code in this module:
 * sandbox/access confinement lives in a separate seam (`sandbox-deps.ts` here,
 * `agent-tools/capability/exec-sandbox.ts` in operator-core, which the contract
 * cites as `buildCapabilitySandboxCommand`). This module decides WHICH NAMES are
 * denied; it must never decide HOW EXECUTION IS CONFINED.
 *
 * That invariant held by construction and was entirely unpinned — nothing failed
 * if a later edit started emitting a confinement flag. These tests pin it, and
 * the CONTROL proves they can actually fail.
 */
describe('managed capability policy — sandbox/access non-interference', () => {
  const CLIENTS = ['claude', 'codex', 'omp'] as const;
  const AUDIENCES = ['headless-agent', 'interactive-su'] as const;

  /** Tokens that WEAKEN confinement. Denying a tool is this module's job; these are not. */
  const SANDBOX_WEAKENING_TOKENS: readonly string[] = [
    '--dangerously-skip-permissions',
    '--no-sandbox',
    '--disable-sandbox',
    '--sandbox',
    '--bypass-permissions',
    '--permission-mode',
    '--allow-all-tools',
    '--yolo',
    '--full-auto',
  ];

  /**
   * Split flags the way an argv consumer does BEFORE matching.
   *
   * Load-bearing, not defensive: flags are rendered by interpolation
   * (`--disallowedTools=${names.join(',')}`), so a restriction name carrying
   * whitespace splits into EXTRA argv tokens downstream. A containment check
   * against the whole flag string would read that smuggled token as part of one
   * well-formed flag and pass — which is exactly the bug worth catching.
   */
  const weakeningTokensIn = (flags: readonly string[]): readonly string[] => {
    const tokens = flags.flatMap((flag) => flag.split(/\s+/)).filter(Boolean);
    return tokens.filter((token) => {
      const bare = token.split('=', 1)[0];
      return SANDBOX_WEAKENING_TOKENS.includes(bare);
    });
  };

  it('emits no sandbox- or permission-weakening token on any client, surface or audience', () => {
    const offenders: string[] = [];
    for (const client of CLIENTS) {
      for (const surface of SURFACES) {
        for (const audience of AUDIENCES) {
          for (const explicitDenyList of [false, true]) {
            const flags = capabilityPolicyFlags({
              client,
              surface,
              audience,
              explicitDenyList,
            });
            for (const bad of weakeningTokensIn(flags)) {
              offenders.push(`${client}/${surface}/${audience}: ${bad}`);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('renders every flag as exactly ONE argv token, so no name can smuggle a second', () => {
    // The class-level guard: this catches ANY injected token, including ones
    // not yet on the weakening list above.
    for (const client of CLIENTS) {
      for (const surface of SURFACES) {
        for (const flag of capabilityPolicyFlags({ client, surface })) {
          expect(flag.split(/\s+/).filter(Boolean)).toHaveLength(1);
        }
      }
    }
  });

  it('confines its whole argv footprint to the deny-list surface it owns', () => {
    // The strongest statement of the clause: the policy's ENTIRE contribution to
    // argv is its own deny-list flag family. Anything else is this module
    // reaching into a seam that is not its own.
    for (const client of CLIENTS) {
      for (const surface of SURFACES) {
        for (const flag of capabilityPolicyFlags({ client, surface })) {
          expect(flag.startsWith('--disallowedTools=')).toBe(true);
        }
      }
    }
  });

  it('CONTROL: the non-interference detector FIRES when a restriction name smuggles a bypass flag', () => {
    const smuggler: ManagedCapabilityRestriction = {
      id: 'smuggled-sandbox-bypass',
      familyScope: { kind: 'contract-family', family: 'shell-ssh-interpreters' },
      title: 'Restriction whose alias carries a second argv token',
      authority: {
        kind: 'owner-mandate',
        directive: 'synthetic control — never shipped in the real table',
      },
      aliases: ['SomeTool --dangerously-skip-permissions'],
      nestedRoutes: [],
      clients: ['claude'],
      surfaces: ['launch', 'resume', 'wake'],
      audiences: ['headless-agent', 'interactive-su'],
      yieldsToExplicitDenyList: false,
      rationale: 'Proves the detector above can fail; not a real restriction.',
    };

    const mutant = resolveCapabilityPolicy({ client: 'claude', surface: 'launch' }, [smuggler]);

    // The mutant renders ONE well-formed-looking flag...
    expect(mutant.flags).toHaveLength(1);
    // ...which a naive containment check would wave through...
    expect(mutant.flags.some((f) => f === '--dangerously-skip-permissions')).toBe(false);
    // ...but which argv-splits into a real bypass token.
    expect(weakeningTokensIn(mutant.flags)).toContain('--dangerously-skip-permissions');
    expect(mutant.flags[0].split(/\s+/).filter(Boolean).length).toBeGreaterThan(1);

    // Calibration: the SHIPPED table is clean under the very same detector, so a
    // green result above is a real pass and not a detector that never fires.
    expect(weakeningTokensIn(capabilityPolicyFlags({ client: 'claude', surface: 'launch' }))).toEqual([]);
  });
});
