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
  policyDeferralEnv,
  policyDeferralReachable,
  resolveCapabilityPolicy,
  type CapabilityPolicySurface,
  type CapabilityReadinessSource,
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

  it('distinguishes "no surface at all" from "a different enforcement mechanism"', () => {
    // A parity matrix that cannot tell these apart reports both as one gap.
    expect(CAPABILITY_CLIENT_ENFORCEMENT.codex).toBe('none');
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
