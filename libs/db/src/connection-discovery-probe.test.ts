import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _createPortServedProbeForTests,
  _defaultIsPortServed,
  _resetUrlCacheForTests,
  _resolveAdminUrlForTests,
  _resolveUrlsForTests,
} from './connection';

const ENV_KEYS = [
  'PAPERCUSP_HOME',
  'PAPERCUSP_PG_PORT',
  'PAPERCUSP_SKIP_PG_DISCOVERY',
  'HARNESS_ADMIN_DATABASE_URL',
  'HARNESS_DATABASE_URL',
  'DATABASE_URL',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>;
let fixtureHome: string | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  it('uses the operator DB pin before a live desktop discovery endpoint and logs only the redacted target once', () => {
    fixtureHome = mkdtempSync(join(tmpdir(), 'papercusp-discovery-probe-'));
    process.env.PAPERCUSP_HOME = fixtureHome;
    delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    delete process.env.PAPERCUSP_PG_PORT;
    delete process.env.HARNESS_ADMIN_DATABASE_URL;
    delete process.env.HARNESS_DATABASE_URL;
    delete process.env.DATABASE_URL;
    _resetUrlCacheForTests();

    writeFileSync(
      join(fixtureHome, 'embedded-pg.json'),
      JSON.stringify({
        url: 'postgresql://harness_admin:desktop-secret@127.0.0.1:55101/papercusp',
        port: 55101,
        pid: process.pid,
      }),
    );
    const operatorEnvFile = join(fixtureHome, 'operator', '.env.local');
    mkdirSync(join(fixtureHome, 'operator'), { recursive: true });
    writeFileSync(
      operatorEnvFile,
      "DATABASE_URL='postgresql://harness_admin:operator-secret@127.0.0.1:5432/papercusp'\n",
    );
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const operatorUrl = 'postgresql://harness_admin:operator-secret@127.0.0.1:5432/papercusp';
    const urls = _resolveUrlsForTests(operatorEnvFile);
    expect(urls.admin).toBe(operatorUrl);
    expect(urls.app).toBe('postgresql://harness_app:harness_app_pwd@127.0.0.1:5432/papercusp');
    expect(_resolveAdminUrlForTests(() => true, operatorEnvFile)).toBe(operatorUrl);
    expect(info).toHaveBeenCalledTimes(1);
    const report = String(info.mock.calls[0]?.[0]);
    expect(report).toContain('source=operator-env-file');
    expect(report).toContain('endpoint=127.0.0.1:5432');
    expect(report).not.toContain('operator-secret');
  });

  it('does not load the operator DB pin for a discovery-skipped isolated caller', () => {
    fixtureHome = mkdtempSync(join(tmpdir(), 'papercusp-discovery-probe-'));
    process.env.PAPERCUSP_HOME = fixtureHome;
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
    const operatorEnvFile = join(fixtureHome, 'operator', '.env.local');
    mkdirSync(join(fixtureHome, 'operator'), { recursive: true });
    writeFileSync(operatorEnvFile, 'DATABASE_URL=postgresql://harness_admin:operator-secret@127.0.0.1:5432/papercusp\n');
    _resetUrlCacheForTests();

    expect(_resolveAdminUrlForTests(() => true, operatorEnvFile)).toBe(
      'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp',
    );
  });

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
    const operatorEnvFile = join(fixtureHome, 'operator', '.env.local');
    mkdirSync(join(fixtureHome, 'operator'), { recursive: true });
    writeFileSync(operatorEnvFile, '');
    const probes: number[] = [];
    const instrumentedProbe = (port: number) => {
      probes.push(port);
      return true;
    };

    writeEndpoint(55101);
    for (let i = 0; i < 32; i += 1) {
      expect(_resolveAdminUrlForTests(instrumentedProbe, operatorEnvFile)).toBe(
        'postgresql://harness_admin:harness_admin_pwd@127.0.0.1:55101/papercusp',
      );
    }
    expect(probes).toEqual(Array.from({ length: 32 }, () => 55101));

    writeEndpoint(55102);
    expect(_resolveAdminUrlForTests(instrumentedProbe, operatorEnvFile)).toBe(
      'postgresql://harness_admin:harness_admin_pwd@127.0.0.1:55102/papercusp',
    );
    expect(probes).toHaveLength(33);
    expect(probes.at(-1)).toBe(55102);
  });

  it('reuses positive listener results and refreshes them after the bound expires', () => {
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

    // Positive results are reused only within the explicit 100 ms freshness
    // window; after it expires, the closed old listener is rejected.
    tcpTable = '';
    tcp6Table = `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n${listenRow(55102)}\n`;
    now += 99;
    expect(probe(55101)).toBe(true);
    expect(reads).toHaveLength(2);

    now += 1;
    expect(probe(55101)).toBe(false);
    expect(probe(55102)).toBe(true);
    expect(reads).toHaveLength(4);
  });

  it('refreshes a cached miss immediately so a newly bound listener is accepted', () => {
    let now = 1_000;
    let tcp6Table = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
    const reads: string[] = [];
    const probe = _createPortServedProbeForTests(
      (path) => {
        reads.push(path);
        if (path.endsWith('tcp6')) return tcp6Table;
        return 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
      },
      () => now,
    );
    const listeningRow = '  0: 00000000000000000000000000000000:D717 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345';

    expect(probe(55063)).toBe(false);
    expect(reads).toHaveLength(2);

    tcp6Table += `${listeningRow}\n`;
    now += 1;
    expect(probe(55063)).toBe(true);
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
