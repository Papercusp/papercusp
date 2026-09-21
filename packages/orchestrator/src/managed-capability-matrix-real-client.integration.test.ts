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
 * fails loudly rather than passing vacuously. `claude` is required because it
 * is the ONLY client any managed-cutover restriction declares; codex and omp
 * are probed informationally, since no cutover targets them yet.
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

import {
  declareRealClientMatrix,
  realClientMatrixReport,
} from './managed-capability-matrix';
import { capabilityPolicyFlags } from './managed-capability-policy';

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
      const probe = probeClient('claude', ['--version']);
      expect(
        probe.ok,
        `claude --version failed (status ${probe.status}${probe.error ? `, ${probe.error}` : ''}).`,
      ).toBe(true);

      const version = probe.stdout.trim().match(/\d+\.\d+\.\d+/)?.[0];
      expect(
        version,
        `could not parse a version from claude --version output: ${JSON.stringify(probe.stdout.slice(0, 200))}`,
      ).toBeDefined();

      const scenarios = declareRealClientMatrix();
      expect(scenarios.length).toBeGreaterThan(0); // calibration

      // Results recorded on a DIFFERENT version than the client really is.
      // The mismatch is detected against a version nobody hard-coded, so this
      // cannot pass by agreeing with its own fixture.
      const stale = realClientMatrixReport({
        scenarios,
        results: scenarios.map((scenario) => ({
          scenarioId: scenario.id,
          outcome: 'pass' as const,
          clientVersion: `${version}-superseded`,
          observedAt: new Date().toISOString(),
        })),
        clientVersions: { claude: version! },
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
          clientVersion: version!,
          observedAt: new Date().toISOString(),
        })),
        clientVersions: { claude: version! },
      });
      expect(current.allDeclaredScenariosPassed).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    'records the other installed clients honestly rather than assuming them',
    () => {
      // No managed-cutover restriction targets codex or omp, so their absence
      // is not a failure — but claiming a real-client matrix without ever
      // looking would be. Whatever is installed is reported; nothing is
      // asserted about a client no cutover declares.
      const observed = (['codex', 'omp'] as const).map((binary) => ({
        binary,
        version: probeClient(binary, ['--version']).stdout.trim().match(/\d+\.\d+\.\d+/)?.[0],
      }));

      for (const { binary, version } of observed) {
        if (version === undefined) continue;
        expect(version, `${binary} reported a malformed version`).toMatch(/^\d+\.\d+\.\d+$/);
      }

      // The declared matrix must not silently claim scenarios for a client no
      // restriction covers — that would be a permanently-unprovable cell.
      const clients = new Set(declareRealClientMatrix().map((scenario) => scenario.client));
      expect(clients.has('codex')).toBe(false);
      expect(clients.has('omp')).toBe(false);
    },
    PROBE_TIMEOUT_MS * 2,
  );
});
