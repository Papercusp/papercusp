import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _createPortServedProbeForTests,
  _defaultIsPortServed,
  _resetUrlCacheForTests,
  _resolveAdminUrlForTests,
} from './connection';

const ENV_KEYS = [
  'PAPERCUSP_HOME',
  'PAPERCUSP_SKIP_PG_DISCOVERY',
  'HARNESS_ADMIN_DATABASE_URL',
  'DATABASE_URL',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>;
let fixtureHome: string | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
  fixtureHome = undefined;
  _resetUrlCacheForTests();
});

describe('discovery port-probe cost on the getOrgPg resolver path', () => {
  it('uses the lazy Node monotonic clock independently of the global performance object', () => {
    vi.stubGlobal('performance', { now: () => { throw new Error('global performance is unavailable'); } });
    _resetUrlCacheForTests();
    // A listening TCP socket is assigned a nonzero port. On hosts without
    // procfs the existing permissive fallback remains appropriate.
    expect(_defaultIsPortServed(0)).toBe(!existsSync('/proc/net/tcp') && !existsSync('/proc/net/tcp6'));
  });
  it('probes once per repeated admin URL resolution and notices a changed local discovery port', () => {
    fixtureHome = mkdtempSync(join(tmpdir(), 'papercusp-discovery-probe-'));
    process.env.PAPERCUSP_HOME = fixtureHome;
    delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    delete process.env.HARNESS_ADMIN_DATABASE_URL;
    delete process.env.DATABASE_URL;
    _resetUrlCacheForTests();

    const discoveryFile = join(fixtureHome, 'embedded-pg.json');
    const writeEndpoint = (port: number) => {
      writeFileSync(
        discoveryFile,
        JSON.stringify({
          url: `postgresql://harness_admin:harness_admin_pwd@127.0.0.1:${port}/papercusp`,
          port,
          pid: process.pid,
          startedAt: 'controlled-test-fixture',
        }),
      );
    };
    const probes: number[] = [];
    const instrumentedProbe = (port: number) => {
      probes.push(port);
      return true;
    };

    writeEndpoint(55101);
    for (let i = 0; i < 32; i += 1) {
      expect(_resolveAdminUrlForTests(instrumentedProbe)).toBe(
        'postgresql://harness_admin:harness_admin_pwd@127.0.0.1:55101/papercusp',
      );
    }
    expect(probes).toEqual(Array.from({ length: 32 }, () => 55101));

    writeEndpoint(55102);
    expect(_resolveAdminUrlForTests(instrumentedProbe)).toBe(
      'postgresql://harness_admin:harness_admin_pwd@127.0.0.1:55102/papercusp',
    );
    expect(probes).toHaveLength(33);
    expect(probes.at(-1)).toBe(55102);
  });

  it('reuses a short listener snapshot and sees a changed port after the bound expires', () => {
    let now = 1_000;
    let tcpTable = '';
    let tcp6Table = '';
    const reads: string[] = [];
    const probe = _createPortServedProbeForTests(
      (path) => {
        reads.push(path);
        return path.endsWith('tcp6') ? tcp6Table : tcpTable;
      },
      () => now,
    );
    const listenRow = (port: number) => `  0: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345`;

    tcpTable = `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n${listenRow(55101)}\n`;
    expect(probe(55101)).toBe(true);
    expect(reads).toEqual(['/proc/net/tcp', '/proc/net/tcp6']);

    // A port change remains invisible only within the explicit 100 ms freshness
    // window; the resolver still reads the discovery file on every call.
    tcpTable = '';
    tcp6Table = `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n${listenRow(55102)}\n`;
    now += 99;
    expect(probe(55101)).toBe(true);
    expect(probe(55102)).toBe(false);
    expect(reads).toHaveLength(2);

    now += 1;
    expect(probe(55101)).toBe(false);
    expect(probe(55102)).toBe(true);
    expect(reads).toHaveLength(4);
  });

  it('keeps the permissive fallback when neither /proc table is readable', () => {
    const probe = _createPortServedProbeForTests(
      () => { throw new Error('procfs unavailable'); },
      () => 1_000,
    );

    expect(probe(55103)).toBe(true);
  });
});
