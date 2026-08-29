import { describe, it, expect } from 'vitest';
import { checkFleetSandboxHostDeps, type SandboxDepProbes } from './sandbox-deps';

/** Probe stub: declare which bins exist on PATH + which files exist + file contents. */
function probes(opts: {
  platform: NodeJS.Platform;
  bins?: string[];
  files?: string[];
  contents?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}): SandboxDepProbes {
  const bins = new Set(opts.bins ?? []);
  const files = new Set(opts.files ?? []);
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', ...(opts.env ?? {}) };
  return {
    platform: () => opts.platform,
    env: () => env,
    fileExists: (p) => {
      if (files.has(p)) return true;
      const m = /^\/usr\/bin\/(.+)$/.exec(p);
      return m ? bins.has(m[1]) : false;
    },
    readFile: (p) => opts.contents?.[p] ?? null,
  };
}

describe('checkFleetSandboxHostDeps', () => {
  it('passes on a fully-provisioned Linux host (bwrap+socat+srt, no userns restriction)', () => {
    const r = checkFleetSandboxHostDeps(
      probes({ platform: 'linux', bins: ['bwrap', 'socat', 'srt'] }),
    );
    expect(r.supported).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.container).toBe(false);
    expect(r.checks.find((c) => c.name === 'bwrap')?.ok).toBe(true);
    expect(r.checks.find((c) => c.name === 'socat')?.ok).toBe(true);
    expect(r.checks.find((c) => c.name === 'srt')?.ok).toBe(true);
  });

  it('fails required checks when bwrap/socat are missing, with remedies', () => {
    const r = checkFleetSandboxHostDeps(probes({ platform: 'linux' }));
    expect(r.ok).toBe(false);
    const bwrap = r.checks.find((c) => c.name === 'bwrap');
    expect(bwrap?.ok).toBe(false);
    expect(bwrap?.required).toBe(true);
    expect(bwrap?.remedy).toMatch(/bubblewrap/);
    expect(r.checks.find((c) => c.name === 'socat')?.remedy).toMatch(/socat/);
  });

  // WI-600814: a flat `required: false` here reported ok:true on a host where
  // every codex fleet spawn threw at the invoke.ts srt guard. Requiredness is
  // now derived from the same condition that guard uses.
  it('missing srt GATES a sandboxed host that can spawn codex', () => {
    const r = checkFleetSandboxHostDeps(
      probes({ platform: 'linux', bins: ['bwrap', 'socat'] }),
    );
    expect(r.ok).toBe(false);
    const srt = r.checks.find((c) => c.name === 'srt');
    expect(srt?.ok).toBe(false);
    expect(srt?.required).toBe(true);
    expect(srt?.detail).toMatch(/THROWS before producing a turn/);
    expect(srt?.remedy).toMatch(/sandbox-runtime/);
  });

  it('missing srt is advisory when the host declares no codex spawns', () => {
    const r = checkFleetSandboxHostDeps(
      probes({ platform: 'linux', bins: ['bwrap', 'socat'] }),
      { codexSpawns: false },
    );
    expect(r.ok).toBe(true);
    const srt = r.checks.find((c) => c.name === 'srt');
    expect(srt?.ok).toBe(false);
    expect(srt?.required).toBe(false);
    expect(srt?.detail).toMatch(/does not spawn codex agents/);
  });

  it('missing srt is advisory when the fleet sandbox is switched off', () => {
    const r = checkFleetSandboxHostDeps(
      probes({
        platform: 'linux',
        bins: ['bwrap', 'socat'],
        env: { PAPERCUSP_FLEET_SANDBOX: '0' },
      }),
    );
    expect(r.ok).toBe(true);
    const srt = r.checks.find((c) => c.name === 'srt');
    expect(srt?.required).toBe(false);
    expect(srt?.detail).toMatch(/PAPERCUSP_FLEET_SANDBOX=0/);
  });

  it('AppArmor userns restriction without a bwrap profile is a gating failure', () => {
    const r = checkFleetSandboxHostDeps(
      probes({
        platform: 'linux',
        bins: ['bwrap', 'socat', 'srt'],
        contents: { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' },
      }),
    );
    expect(r.ok).toBe(false);
    const aa = r.checks.find((c) => c.name === 'apparmor-userns');
    expect(aa?.ok).toBe(false);
    expect(aa?.required).toBe(true);
    expect(aa?.remedy).toMatch(/apparmor/i);
  });

  it('AppArmor restriction with the distro bwrap profile passes', () => {
    const r = checkFleetSandboxHostDeps(
      probes({
        platform: 'linux',
        bins: ['bwrap', 'socat', 'srt'],
        files: ['/etc/apparmor.d/bwrap'],
        contents: { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === 'apparmor-userns')?.ok).toBe(true);
  });

  it('container detection adds the advisory enableWeakerNestedSandbox check', () => {
    const r = checkFleetSandboxHostDeps(
      probes({
        platform: 'linux',
        bins: ['bwrap', 'socat', 'srt'],
        files: ['/.dockerenv'],
      }),
    );
    expect(r.container).toBe(true);
    const c = r.checks.find((ch) => ch.name === 'container');
    expect(c?.ok).toBe(false);
    expect(c?.required).toBe(false);
    expect(c?.remedy).toMatch(/enableWeakerNestedSandbox/);
    expect(r.ok).toBe(true); // advisory — doesn't gate
  });

  it('macOS relies on built-in Seatbelt', () => {
    const r = checkFleetSandboxHostDeps(
      probes({
        platform: 'darwin',
        bins: ['srt'],
        files: ['/usr/bin/sandbox-exec'],
      }),
    );
    expect(r.supported).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === 'seatbelt')?.ok).toBe(true);
  });

  it('Windows is unsupported with a WSL/opt-out remedy', () => {
    const r = checkFleetSandboxHostDeps(probes({ platform: 'win32' }));
    expect(r.supported).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.checks[0]?.remedy).toMatch(/WSL|PAPERCUSP_FLEET_SANDBOX=0/);
  });

  it('reports enabled=false when PAPERCUSP_FLEET_SANDBOX opts out', () => {
    const r = checkFleetSandboxHostDeps(
      probes({
        platform: 'linux',
        bins: ['bwrap', 'socat'],
        env: { PAPERCUSP_FLEET_SANDBOX: '0' },
      }),
    );
    expect(r.enabled).toBe(false);
  });
});
