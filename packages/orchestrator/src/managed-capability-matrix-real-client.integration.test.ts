/**
 * P-008 — CAP-CONTRACT-P008-REAL-CLIENT-MATRIX@1, REAL-CLIENT layer.
 *
 * The clause declares `requiredTestLayers: {integration, real-client}`. The
 * integration file proves the gate reaches the decision using injected
 * results; THIS file is the layer that refuses to fabricate them: it executes
 * the REAL installed client binary in an ISOLATED profile and asserts the two
 * facts the matrix cannot honestly assume about a client it has never run.
 *
 * WHAT A REAL CLIENT IS ACTUALLY NEEDED FOR. Two things in this design are
 * claims about a client, not about our code, and both fail silently:
 *
 *  1. THE ENFORCEMENT SURFACE EXISTS AND IS SPELLED AS WE SPELL IT. The whole
 *     managed-cutover posture is rendered as `--disallowedTools=<names>`. If a
 *     client release renames or drops that flag, every restriction we "apply"
 *     becomes a no-op while `resolveCapabilityPolicy` keeps reporting it as
 *     applied — a false managed guarantee, which is exactly what R-6 forbids
 *     ("a managed tool name does not confer confinement"). No unit test can
 *     see this; only the real binary's own interface can.
 *
 *  2. THE VERSION IS A REAL, MOVING STRING. The staleness and drift gates are
 *     only as good as the version they compare against, so the version is read
 *     FROM the client rather than pinned in a fixture that can never disagree.
 *
 * WHY IT DOES NOT SKIP. A skipped test is not evidence — `skipped` is exactly
 * what the adequacy evaluator refuses as executable proof. On a host with no
 * `claude` the P-008 real-client claim genuinely cannot be evidenced, so this
 * fails loudly rather than passing vacuously. Every client declared by a
 * managed-cutover restriction is required; other clients are probed
 * informationally without claiming cutover evidence for them.
 *
 * COST + SAFETY. `--version` / `--help` only: no session is started, no tokens
 * are spent, no account is touched, and HOME plus every client config dir are
 * redirected into a throwaway temp profile so the owner's real configuration
 * is never read or written.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MANAGED_CAPABILITY_DISPOSITIONS } from './managed-capability-contract';
import {
  declareRealClientMatrix,
  realClientMatrixReport,
} from './managed-capability-matrix';
import { CAPABILITY_CLIENT_ENFORCEMENT, capabilityPolicyFlags, type CapabilityClientFamily } from './managed-capability-policy';

const PROBE_TIMEOUT_MS = 60_000;

let profile: string;

/** Run a client binary inside a throwaway profile. Never the owner's HOME. */
function probeClient(binary: string, args: readonly string[]) {
  const result = spawnSync(binary, [...args], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    env: {
      ...process.env,
      HOME: profile,
      XDG_CONFIG_HOME: join(profile, '.config'),
      XDG_DATA_HOME: join(profile, '.local', 'share'),
      CLAUDE_CONFIG_DIR: join(profile, '.claude'),
      CODEX_HOME: join(profile, '.codex'),
      // Never let a probe inherit an in-session agent identity.
      PAPERCUSP_SID: '',
    },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message,
  };
}

beforeAll(() => {
  profile = mkdtempSync(join(tmpdir(), 'p008-real-client-'));
});

describe('P-020 installed-client preflight with native features retained', () => {
  const clients = Object.keys(CAPABILITY_CLIENT_ENFORCEMENT) as CapabilityClientFamily[];

  it.each(clients)('%s exposes the installed version and launch/resume interface without claiming a journey ran', (client) => {
    const versionProbe = probeClient(client, ['--version']);
    expect(versionProbe.ok, `${client} --version: ${versionProbe.error ?? versionProbe.stderr}`).toBe(true);
    const version = versionProbe.stdout.trim().match(/\d+\.\d+\.\d+/)?.[0];
    expect(version, `${client} returned no measurable installed version`).toBeDefined();

    const launchHelp = probeClient(client, client === 'codex' ? ['exec', '--help'] : ['--help']);
    expect(launchHelp.ok, `${client} launch help: ${launchHelp.error ?? launchHelp.stderr}`).toBe(true);
    expect(launchHelp.stdout.length).toBeGreaterThan(200);
    if (client === 'codex') {
      const resumeHelp = probeClient(client, ['exec', 'resume', '--help']);
      expect(resumeHelp.ok, resumeHelp.error ?? resumeHelp.stderr).toBe(true);
      expect(resumeHelp.stdout).toContain('SESSION_ID');
      expect(launchHelp.stdout).toContain('resume');
    } else {
      expect(launchHelp.stdout).toMatch(/--resume\b/);
      expect(launchHelp.stdout).toMatch(/--print\b|(?:^|\s)-p(?:\s|,)/m);
    }

    const scenarios = declareRealClientMatrix(undefined, { purpose: 'replacement-acceptance', clients: [client] });
    expect(scenarios.some((scenario) => scenario.kind === 'launch')).toBe(true);
    expect(scenarios.some((scenario) => scenario.kind === 'resume')).toBe(true);
    expect(scenarios.some((scenario) => scenario.kind === 'wake')).toBe(true);
    const report = realClientMatrixReport({ scenarios, clientVersions: { [client]: version! } });
    // Version/help are prerequisite evidence. They cannot satisfy actual client journeys.
    expect(report.rows.every((row) => row.status === 'missing')).toBe(true);
    expect(report.allDeclaredScenariosPassed).toBe(false);
    expect(report.entries).toEqual([]);
    for (const surface of ['launch', 'resume', 'wake'] as const) {
      const names = capabilityPolicyFlags({ client, surface, clientVersions: { [client]: version! } })
        .flatMap((flag) => flag.slice(flag.indexOf('=') + 1).split(','));
      expect(names).not.toContain('Bash');
      expect(names).not.toContain('Read');
      expect(names).not.toContain('Edit');
      expect(names).not.toContain('Write');
    }
    console.info('REAL_CLIENT_ACCEPTANCE_PREFLIGHT', JSON.stringify({ client, version, nativeFeaturesRetained: true,
      inspected: ['version', 'launch-help', 'resume-help'], actualJourneys: 'not-executed' }));
  }, PROBE_TIMEOUT_MS * 4);
});

afterAll(() => {
  if (profile) rmSync(profile, { recursive: true, force: true });
});

describe('P-008 real-client layer — the enforcement surface we render actually exists', () => {
  it(
    'the installed claude accepts the --disallowedTools flag the policy emits',
    () => {
      const help = probeClient('claude', ['--help']);
      expect(
        help.ok,
        `claude --help failed (status ${help.status}${help.error ? `, ${help.error}` : ''}). ` +
          'The P-008 real-client layer cannot be evidenced without a working claude binary.',
      ).toBe(true);

      // POSITIVE CONTROL: prove the probe actually captured a help text before
      // any absence below is read as meaningful. A truncated or empty capture
      // would otherwise make every `toContain` fail for the wrong reason — and
      // an empty haystack is indistinguishable from a renamed flag.
      expect(help.stdout.length, 'claude --help produced no stdout to search').toBeGreaterThan(200);
      expect(help.stdout).toMatch(/--(help|version)\b/);

      // The flag the whole managed-cutover posture is rendered as.
      expect(
        help.stdout,
        'The installed claude no longer documents --disallowedTools. Every managed-cutover ' +
          'restriction would render as a silently inert flag, so the restriction table must be ' +
          're-spelled for this client version before any managed default is enabled.',
      ).toContain('--disallowedTools');
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    'the flag is VARIADIC, which is why the policy emits the single `=` token form',
    () => {
      // Measured on claude 2.1.275: `--disallowedTools, --disallowed-tools <tools...>`.
      // The `<tools...>` arity is load-bearing — the space-separated form would
      // swallow a following positional (the wake path appends wake text
      // positionally), which is the documented reason `flags` uses `=`.
      const help = probeClient('claude', ['--help']);
      expect(help.ok).toBe(true);

      const line = help.stdout
        .split('\n')
        .find((candidate) => candidate.includes('--disallowedTools'));
      expect(line, 'no --disallowedTools line to inspect').toBeDefined();
      expect(
        line,
        'The --disallowedTools arity changed. If it is no longer variadic the `=` form may be ' +
          'wrong; if it became a single value the comma-joined token may be wrong. Either way the ' +
          'rendering in capabilityPolicyFlags must be re-verified against this client.',
      ).toContain('...');

      // And every flag we emit today uses the `=` form, so no emitted token can
      // consume a following positional.
      for (const flag of capabilityPolicyFlags({ client: 'claude', surface: 'wake' })) {
        expect(flag).toMatch(/^--[A-Za-z-]+=/);
      }
    },
    PROBE_TIMEOUT_MS,
  );
});

describe('P-008 real-client layer — the version dimension is read from the client', () => {
  it(
    'reads a real semver-shaped version and drives version-mismatch with it',
    () => {
      const scenarios = declareRealClientMatrix();
      expect(scenarios.length).toBeGreaterThan(0); // calibration
      const clientVersions: Partial<Record<CapabilityClientFamily, string>> = {};
      for (const client of new Set(scenarios.map((scenario) => scenario.client))) {
        const probe = probeClient(client, ['--version']);
        expect(
          probe.ok,
          `${client} --version failed (status ${probe.status}${probe.error ? `, ${probe.error}` : ''}).`,
        ).toBe(true);

        const version = probe.stdout.trim().match(/\d+\.\d+\.\d+/)?.[0];
        expect(
          version,
          `could not parse a version from ${client} --version output: ${JSON.stringify(probe.stdout.slice(0, 200))}`,
        ).toBeDefined();
        clientVersions[client] = version!;
      }

      // Results recorded on a DIFFERENT version than the client really is.
      // The mismatch is detected against a version nobody hard-coded, so this
      // cannot pass by agreeing with its own fixture.
      const stale = realClientMatrixReport({
        scenarios,
        results: scenarios.map((scenario) => ({
          scenarioId: scenario.id,
          outcome: 'pass' as const,
          clientVersion: `${clientVersions[scenario.client]}-superseded`,
          observedAt: new Date().toISOString(),
        })),
        clientVersions,
      });
      expect(stale.rows.every((row) => row.status === 'version-mismatch')).toBe(true);
      expect(stale.allDeclaredScenariosPassed).toBe(false);

      // CALIBRATION: the same results recorded on the client's ACTUAL version
      // pass, so the assertion above is the version check working rather than
      // the matrix being unsatisfiable.
      const current = realClientMatrixReport({
        scenarios,
        results: scenarios.map((scenario) => ({
          scenarioId: scenario.id,
          outcome: 'pass' as const,
          clientVersion: clientVersions[scenario.client]!,
          observedAt: new Date().toISOString(),
        })),
        clientVersions,
      });
      expect(current.allDeclaredScenariosPassed).toBe(true);
    },
    PROBE_TIMEOUT_MS * 3,
  );

  it(
    'records the other installed clients honestly rather than assuming them',
    () => {
      // Codex and OMP have managed-shell restrictions, so both must expose
      // an installed version for their declared cutover scenarios.
      const observed = (['codex', 'omp'] as const).map((binary) => ({
        binary,
        probe: probeClient(binary, ['--version']),
      }));
      const clients = new Set(declareRealClientMatrix().map((scenario) => scenario.client));

      for (const { binary, probe } of observed) {
        const version = probe.stdout.trim().match(/\d+\.\d+\.\d+/)?.[0];
        if (clients.has(binary)) {
          expect(probe.ok, `${binary} --version: ${probe.error ?? probe.stderr}`).toBe(true);
          expect(version, `${binary} has declared cutover scenarios but no measurable version`).toBeDefined();
        }
        if (version === undefined) continue;
        expect(version, `${binary} reported a malformed version`).toMatch(/^\d+\.\d+\.\d+$/);
      }

      // The declared matrix must not silently claim scenarios for a client no
      // restriction covers — that would be a permanently-unprovable cell.
      expect(clients.has('codex')).toBe(true);
      expect(clients.has('omp')).toBe(true);
    },
    PROBE_TIMEOUT_MS * 2,
  );
});

/**
 * R-5 of the acceptance BAR set for plan
 * managed-agent-capability-contract-and-native-cutover-2026-09-13.
 *
 * WHY THIS BLOCK EXISTS. R-5's structured check binds THIS file, and until now
 * nothing in it tested R-5's claim — the file was entirely P-008 real-client
 * probes. The author's own rubric-vetting pass (2026-09-21) measured that and
 * treated it as a defect rather than a formality: a bar whose named probe
 * cannot fail on its own model is decoration, not a gate. The repair is to make
 * the bound file carry the proof, because a bar's `check` is bar-hash material
 * and is not amendable — re-pointing the bar is not an available move.
 *
 * WHAT MAKES R-5 HARD. It asserts an ABSENCE, and the claim is deliberately
 * stronger than "we did not build it": the offline-recovery path must be
 * RECORDED as a deliberate owner-directed exclusion (D-010), rooted in the
 * D-007/D-008 forgeability finding, so a later reader cannot mistake it for an
 * oversight and rebuild it under a weaker authority root.
 *
 * An absence assertion that has gone vacuous is indistinguishable from one that
 * holds, so every negative here is paired with a positive control.
 */
describe('R-5 — offline recovery is a RECORDED deliberate exclusion, not unbuilt work', () => {
  const recoveryFamily = MANAGED_CAPABILITY_DISPOSITIONS.find(
    (entry) => entry.family === 'memory-checkpoint-resume-rewind',
  );

  const assertPermanentExclusion = (reason: string) => {
    expect(reason).toContain('D-010');
    expect(reason).toMatch(/permanent(?:ly)? (?:documented exclusion|excludes offline recovery)/i);
    expect(reason).not.toMatch(/(?:pending|todo|unbuilt) (?:offline )?recovery/i);
  };

  it('the shipped contract records the exclusion and cites D-010 plus its D-007/D-008 root', () => {
    expect(
      recoveryFamily,
      'memory-checkpoint-resume-rewind must stay in the shipped disposition inventory; dropping ' +
        'the family would erase the very record R-5 requires a reader to be able to find.',
    ).toBeDefined();

    const exclusion = recoveryFamily?.gaps.find((gap) => gap.id === 'offline-bounded-recovery');
    expect(
      exclusion,
      'offline-bounded-recovery is the canonical record of the D-010 exclusion; without it the ' +
        'absence reads as an oversight that somebody is entitled to close.',
    ).toBeDefined();

    // 'unsupported' is the kind that says NOBODY owns this. Reclassifying it as
    // 'recovery' or 'parity' would turn a closed decision back into outstanding
    // work and re-open the exact door D-010 shut.
    expect(exclusion?.kind).toBe('unsupported');

    expect(exclusion?.description).toContain('D-010');
    expect(exclusion?.description).toContain('D-007/D-008');
    expect(exclusion?.description).toMatch(/DELIBERATELY EXCLUDED/);
    // "absent and unreachable, not merely unbuilt": the record must carry the
    // forgeability finding, which is WHY no weaker substitute is acceptable.
    expect(exclusion?.description).toMatch(/forgeable/i);

    // A gap with no falsifier cannot be argued with by a later author.
    expect(exclusion?.falsifier ?? '').toMatch(/locally-authorized recovery path/i);
    expect(exclusion?.falsifier ?? '').toMatch(/supersede D-007\/D-008/i);

    // ...and the family-level reason must not describe it as pending work.
    assertPermanentExclusion(recoveryFamily?.cutoverReason ?? '');
    expect(exclusion?.description).toContain('dropped its owning item P-004');
  });

  it('rejects pending recovery work and an exclusion without recorded decision authority', () => {
    expect(() => assertPermanentExclusion('D-010: pending offline recovery implementation')).toThrow();
    expect(() => assertPermanentExclusion('permanently excludes offline recovery')).toThrow();
    expect(() => assertPermanentExclusion('D-010 permanent documented exclusion; pending recovery')).toThrow();
    expect(() => assertPermanentExclusion(recoveryFamily!.cutoverReason)).not.toThrow();
  });

  it('POSITIVE CONTROL: other gap kinds still exist, so the unsupported-kind assertion discriminates', () => {
    // Had every gap in the inventory drifted to 'unsupported', the kind
    // assertion above would keep passing while distinguishing nothing.
    const kinds = new Set(
      MANAGED_CAPABILITY_DISPOSITIONS.flatMap((entry) => entry.gaps.map((gap) => gap.kind)),
    );
    expect(kinds.has('unsupported')).toBe(true);
    expect([...kinds].some((kind) => kind !== 'unsupported')).toBe(true);
  });

  it('no declared managed authority anywhere in the inventory offers a local recovery grant', () => {
    const authorities = MANAGED_CAPABILITY_DISPOSITIONS.flatMap((entry) => [
      ...entry.managedAuthorities,
      ...entry.reuseSites.map((site) => site.path),
    ]);

    // POSITIVE CONTROL: the inventory is the shipped surface declaration and is
    // always populated, which is exactly why the control lives here and NOT on
    // capabilityPolicyFlags — that render is legitimately empty before cutover
    // (every disposition still carries cutoverReady: false), so an empty flag
    // set would satisfy the negative below for the wrong reason.
    expect(authorities.length).toBeGreaterThan(20);
    expect(authorities.some((entry) => entry.includes('capability:bash'))).toBe(true);

    const grantShaped = authorities.filter((entry) =>
      /(offline|local)[-_ ]?recovery|recovery[-_ ]?(grant|key|token)|allow[-_ ]?recovery/i.test(entry),
    );
    expect(
      grantShaped,
      `a managed authority names a local recovery grant, which R-5 forbids: ${grantShaped.join(', ')}`,
    ).toEqual([]);
  });

  it('no rendered policy flag, on any client or surface, carries a recovery grant', () => {
    const clients = ['claude', 'codex', 'omp'] as const;
    const surfaces = ['launch', 'resume', 'wake'] as const;
    const rendered: string[] = [];

    for (const client of clients) {
      for (const surface of surfaces) {
        rendered.push(...capabilityPolicyFlags({ client, surface }));
      }
    }

    // Deliberately NOT asserting `rendered.length > 0` — see the control note
    // above. This assertion tightens as cutover activates restrictions, and is
    // honestly weak (though never false) while the render is still empty.
    const grantShaped = rendered.filter((flag) =>
      /(offline|local)[-_]?recovery|recovery[-_]?(grant|key|token)|allow[-_]?recovery/i.test(flag),
    );
    expect(
      grantShaped,
      `policy rendered a recovery-grant-shaped flag: ${grantShaped.join(', ')}`,
    ).toEqual([]);
  });
});
