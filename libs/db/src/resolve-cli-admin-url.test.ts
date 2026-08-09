/**
 * EI-19949168182332635: pull-schema.mjs / drizzle.config.ts used to hand-roll
 * their own discovery-file read (bare fs.readFileSync + JSON.parse, no
 * liveness check), so a STALE discovery file (embedded PG crashed / desktop
 * closed) silently won over the live native-PG fallback — drizzle-kit then
 * connected to a dead port and failed with a content-free "0 tables
 * fetching", indistinguishable from a real DB outage. This pins the fixed
 * resolver's config: it must delegate to `resolvePgUrl` (which carries the
 * pid+port liveness gates — already unit-tested at
 * libs/generic/embedded-pg-discovery/src/index.test.ts, not re-tested here)
 * with the SAME env-var precedence and discovery path getHarnessAdminUrl()
 * uses, and must honor the PAPERCUSP_SKIP_PG_DISCOVERY / PAPERCUSP_HOME
 * escape hatches every other DB-touching path in this repo respects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NATIVE_FALLBACK_ADMIN_URL,
  redactAdminUrl,
  resolveAdminUrl,
  resolveAdminUrlWithSource,
} from './resolve-cli-admin-url.mjs';

const ENV_VARS = ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL'] as const;

describe('resolveAdminUrlWithSource', () => {
  let tmpHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of [...ENV_VARS, 'PAPERCUSP_HOME', 'PAPERCUSP_SKIP_PG_DISCOVERY']) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
    tmpHome = mkdtempSync(join(tmpdir(), 'resolve-cli-admin-url-test-'));
    process.env.PAPERCUSP_HOME = tmpHome;
  });

  afterEach(() => {
    for (const [v, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[v];
      else process.env[v] = val;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('prefers HARNESS_ADMIN_DATABASE_URL, then DATABASE_URL, then PAPERCUSP_PG_URL, in that order', () => {
    process.env.PAPERCUSP_PG_URL = 'postgres://pg-url/db';
    expect(resolveAdminUrlWithSource()).toEqual({ url: 'postgres://pg-url/db', source: 'env' });

    process.env.DATABASE_URL = 'postgres://database-url/db';
    expect(resolveAdminUrlWithSource()).toEqual({ url: 'postgres://database-url/db', source: 'env' });

    process.env.HARNESS_ADMIN_DATABASE_URL = 'postgres://harness-admin/db';
    expect(resolveAdminUrlWithSource()).toEqual({ url: 'postgres://harness-admin/db', source: 'env' });
  });

  it('falls through a MISSING discovery file to the native fallback (not empty)', () => {
    // No embedded-pg.json written under tmpHome at all.
    expect(resolveAdminUrlWithSource()).toEqual({ url: NATIVE_FALLBACK_ADMIN_URL, source: 'fallback' });
  });

  it('falls through a STALE discovery file (dead pid) to the native fallback — the EI-19949168182332635 case', () => {
    // A pid that cannot possibly be alive.
    writeFileSync(
      join(tmpHome, 'embedded-pg.json'),
      JSON.stringify({ url: 'postgresql://harness_admin:harness_admin_pwd@localhost:19819/papercusp', pid: 999999999 }),
    );
    expect(resolveAdminUrlWithSource()).toEqual({ url: NATIVE_FALLBACK_ADMIN_URL, source: 'fallback' });
  });

  it('honors PAPERCUSP_SKIP_PG_DISCOVERY=1 by skipping the discovery file even when present and well-formed', () => {
    writeFileSync(
      join(tmpHome, 'embedded-pg.json'),
      JSON.stringify({ url: 'postgres://would-win/db' }),
    );
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
    expect(resolveAdminUrlWithSource()).toEqual({ url: NATIVE_FALLBACK_ADMIN_URL, source: 'fallback' });
  });

  it('resolveAdminUrl returns just the url half of resolveAdminUrlWithSource', () => {
    process.env.HARNESS_ADMIN_DATABASE_URL = 'postgres://plain-url/db';
    expect(resolveAdminUrl()).toBe('postgres://plain-url/db');
  });
});

describe('redactAdminUrl', () => {
  it('masks the password, keeping the rest of the URL intact', () => {
    const redacted = redactAdminUrl('postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp');
    expect(redacted).not.toContain('harness_admin_pwd');
    expect(redacted).toContain('harness_admin');
    expect(redacted).toContain('localhost:5432');
    expect(redacted).toContain('papercusp');
  });

  it('passes through an unparseable value unchanged rather than throwing', () => {
    expect(redactAdminUrl('not-a-url')).toBe('not-a-url');
  });
});
