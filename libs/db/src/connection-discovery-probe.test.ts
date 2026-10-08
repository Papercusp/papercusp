import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetUrlCacheForTests, _resolveAdminUrlForTests } from './connection';

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
});
