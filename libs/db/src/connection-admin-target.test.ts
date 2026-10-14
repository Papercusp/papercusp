// WI-6554700010012344: resolvedAdminDatabaseTarget reports WHICH resolution step chose
// the admin DB, so a shipping caller (cut-seed-cli --workspace-id) can refuse a
// discovery- or fallback-sourced cluster. These cases pin each source and that the
// endpoint never carries credentials.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetUrlCacheForTests, resolvedAdminDatabaseTarget } from './connection';

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
let fixtureHome = '';
let operatorEnvFile = '';

beforeEach(() => {
  fixtureHome = mkdtempSync(join(tmpdir(), 'papercusp-admin-target-'));
  process.env.PAPERCUSP_HOME = fixtureHome;
  for (const key of ENV_KEYS) if (key !== 'PAPERCUSP_HOME') delete process.env[key];
  operatorEnvFile = join(fixtureHome, 'operator', '.env.local');
  mkdirSync(join(fixtureHome, 'operator'), { recursive: true });
  writeFileSync(operatorEnvFile, '');
  _resetUrlCacheForTests();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fixtureHome, { recursive: true, force: true });
  _resetUrlCacheForTests();
});

function advertiseEmbeddedPg(port: number): void {
  writeFileSync(
    join(fixtureHome, 'embedded-pg.json'),
    JSON.stringify({
      url: `postgresql://harness_admin:desktop-secret@127.0.0.1:${port}/papercusp`,
      port,
      pid: process.pid,
      startedAt: 'controlled-test-fixture',
    }),
  );
}

describe('resolvedAdminDatabaseTarget (WI-6554700010012344)', () => {
  it('reports an explicit DATABASE_URL as env, without credentials', () => {
    process.env.DATABASE_URL = 'postgresql://harness_admin:env-secret@127.0.0.1:5432/papercusp';
    advertiseEmbeddedPg(55101);
    const target = resolvedAdminDatabaseTarget({ isPortServed: () => true, operatorEnvironmentFile: operatorEnvFile });
    expect(target).toEqual({ source: 'env', endpoint: '127.0.0.1:5432' });
    expect(JSON.stringify(target)).not.toContain('secret');
  });

  it('reports the operator env file ahead of a live discovery advertisement', () => {
    writeFileSync(operatorEnvFile, 'DATABASE_URL=postgresql://harness_admin:operator-secret@127.0.0.1:5432/papercusp\n');
    advertiseEmbeddedPg(55101);
    expect(
      resolvedAdminDatabaseTarget({ isPortServed: () => true, operatorEnvironmentFile: operatorEnvFile }),
    ).toEqual({ source: 'operator-env-file', endpoint: '127.0.0.1:5432' });
  });

  it('reports discovery when nothing pins the DB and an embedded PG is advertised (the foreign-cluster case)', () => {
    advertiseEmbeddedPg(55101);
    const target = resolvedAdminDatabaseTarget({ isPortServed: () => true, operatorEnvironmentFile: operatorEnvFile });
    expect(target).toEqual({ source: 'discovery', endpoint: '127.0.0.1:55101' });
    expect(JSON.stringify(target)).not.toContain('secret');
  });

  it('reports fallback when nothing pins the DB and nothing is advertised', () => {
    expect(
      resolvedAdminDatabaseTarget({ isPortServed: () => false, operatorEnvironmentFile: operatorEnvFile }),
    ).toEqual({ source: 'fallback', endpoint: 'localhost:5432' });
  });
});
