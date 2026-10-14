/**
 * cloud-portal-public-release-2026-10-13 P-005 / R-3 / D-009: production database URL
 * resolution fails closed.
 *
 * Under PAPERCUSP_DEPLOYMENT_ENVIRONMENT=production, connection.ts must resolve only explicit
 * process env and refuse the operator .env.local, the embedded-pg discovery file, the native
 * localhost fallback and the default-credential app-role re-key. Each refusal case is paired
 * with a development-mode control on the same fixture, so a test cannot pass merely because
 * the fixture was unreachable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetUrlCacheForTests, _resolveUrlsForTests } from './connection';
import {
  DEPLOYMENT_ENVIRONMENT_VAR,
  ProductionDatabaseConfigError,
  assertProductionDatabaseConfiguration,
  deploymentEnvironment,
  isProductionDeployment,
  resolveProductionDatabaseUrls,
} from './production-database-policy';

const ENV_KEYS = [
  DEPLOYMENT_ENVIRONMENT_VAR,
  'PAPERCUSP_HOME',
  'PAPERCUSP_PG_PORT',
  'PAPERCUSP_SKIP_PG_DISCOVERY',
  'PAPERCUSP_USE_EMBEDDED_PG',
  'HARNESS_ADMIN_DATABASE_URL',
  'HARNESS_DATABASE_URL',
  'DATABASE_URL',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>;
let fixtureHome: string | undefined;

const REMOTE_ADMIN = 'postgresql://papercusp_admin:s3cret-admin@10.20.0.5:5432/papercusp';
const REMOTE_APP = 'postgresql://harness_app:s3cret-app@10.20.0.5:5432/papercusp';
const OPERATOR_FILE_ADMIN = 'postgresql://harness_admin:file-secret@db-from-file.internal:5432/papercusp';

function clearDbEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

/** A home with BOTH local fallbacks present: an operator .env.local pin and a discovery file. */
function fixtureWithLocalFallbacks(): string {
  fixtureHome = mkdtempSync(join(tmpdir(), 'papercusp-prod-db-policy-'));
  process.env.PAPERCUSP_HOME = fixtureHome;
  writeFileSync(
    join(fixtureHome, 'embedded-pg.json'),
    JSON.stringify({
      url: 'postgresql://harness_admin:desktop-secret@127.0.0.1:55109/papercusp',
      port: 55109,
      pid: process.pid,
    }),
  );
  mkdirSync(join(fixtureHome, 'operator'), { recursive: true });
  const operatorEnvFile = join(fixtureHome, 'operator', '.env.local');
  writeFileSync(operatorEnvFile, `DATABASE_URL=${OPERATOR_FILE_ADMIN}\n`);
  return operatorEnvFile;
}

function captureError(fn: () => unknown): ProductionDatabaseConfigError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProductionDatabaseConfigError);
    return e as ProductionDatabaseConfigError;
  }
  throw new Error('expected a ProductionDatabaseConfigError, but nothing was thrown');
}

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

describe('deployment environment signal', () => {
  it('treats unset and empty as development and recognises production', () => {
    expect(deploymentEnvironment({})).toBe('development');
    expect(deploymentEnvironment({ [DEPLOYMENT_ENVIRONMENT_VAR]: '  ' })).toBe('development');
    expect(deploymentEnvironment({ [DEPLOYMENT_ENVIRONMENT_VAR]: 'development' })).toBe('development');
    expect(isProductionDeployment({ [DEPLOYMENT_ENVIRONMENT_VAR]: 'production' })).toBe(true);
  });

  it('refuses an unknown value instead of silently disabling the policy', () => {
    for (const typo of ['prod', 'Production', 'staging']) {
      const err = captureError(() => deploymentEnvironment({ [DEPLOYMENT_ENVIRONMENT_VAR]: typo }));
      expect(err.message).toContain('not a known deployment environment');
    }
  });
});

describe('connection.ts URL resolution under production mode', () => {
  it('does not fall back to the operator .env.local or the discovery file', () => {
    clearDbEnv();
    const operatorEnvFile = fixtureWithLocalFallbacks();

    // Control: in development the same fixture resolves through the operator .env.local pin.
    _resetUrlCacheForTests();
    expect(_resolveUrlsForTests(operatorEnvFile).admin).toBe(OPERATOR_FILE_ADMIN);

    process.env[DEPLOYMENT_ENVIRONMENT_VAR] = 'production';
    _resetUrlCacheForTests();
    const err = captureError(() => _resolveUrlsForTests(operatorEnvFile));
    expect(err.problems.join('\n')).toMatch(/HARNESS_DATABASE_URL is not set/);
    expect(err.problems.join('\n')).toMatch(/HARNESS_ADMIN_DATABASE_URL \(or DATABASE_URL\) is not set/);
  });

  it('never re-keys the app role onto an admin pin with default credentials', () => {
    clearDbEnv();
    process.env.DATABASE_URL = REMOTE_ADMIN;

    // Control: development derives harness_app with the default password from the admin pin.
    _resetUrlCacheForTests();
    expect(_resolveUrlsForTests().app).toContain('harness_app:harness_app_pwd@10.20.0.5');

    process.env[DEPLOYMENT_ENVIRONMENT_VAR] = 'production';
    _resetUrlCacheForTests();
    const err = captureError(() => _resolveUrlsForTests());
    expect(err.problems).toHaveLength(1);
    expect(err.problems[0]).toMatch(/HARNESS_DATABASE_URL is not set/);
  });

  it('refuses the native localhost fallback when no env is set', () => {
    clearDbEnv();
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';

    // Control: development lands on localhost.
    _resetUrlCacheForTests();
    expect(_resolveUrlsForTests().admin).toContain('@localhost:');

    process.env[DEPLOYMENT_ENVIRONMENT_VAR] = 'production';
    _resetUrlCacheForTests();
    captureError(() => _resolveUrlsForTests());
  });

  it('resolves exactly the explicit, valid remote URLs', () => {
    clearDbEnv();
    process.env[DEPLOYMENT_ENVIRONMENT_VAR] = 'production';
    process.env.HARNESS_ADMIN_DATABASE_URL = REMOTE_ADMIN;
    process.env.HARNESS_DATABASE_URL = REMOTE_APP;
    _resetUrlCacheForTests();
    expect(_resolveUrlsForTests()).toEqual({ admin: REMOTE_ADMIN, app: REMOTE_APP });
  });

  it('accepts DATABASE_URL as the admin pin when HARNESS_ADMIN_DATABASE_URL is absent', () => {
    clearDbEnv();
    process.env[DEPLOYMENT_ENVIRONMENT_VAR] = 'production';
    process.env.DATABASE_URL = REMOTE_ADMIN;
    process.env.HARNESS_DATABASE_URL = REMOTE_APP;
    _resetUrlCacheForTests();
    expect(_resolveUrlsForTests()).toEqual({ admin: REMOTE_ADMIN, app: REMOTE_APP });
    expect(resolveProductionDatabaseUrls(process.env).adminVar).toBe('DATABASE_URL');
  });
});

describe('production URL validation', () => {
  const base = { [DEPLOYMENT_ENVIRONMENT_VAR]: 'production', HARNESS_ADMIN_DATABASE_URL: REMOTE_ADMIN };

  it.each([
    ['localhost', 'postgresql://harness_app:s3cret@localhost:5432/papercusp', /loopback host localhost/],
    ['127.0.0.1', 'postgresql://harness_app:s3cret@127.0.0.1:5432/papercusp', /loopback host 127\.0\.0\.1/],
    ['127.x', 'postgresql://harness_app:s3cret@127.8.9.10/papercusp', /loopback host/],
    ['::1', 'postgresql://harness_app:s3cret@[::1]:5432/papercusp', /loopback host/],
    ['*.localhost', 'postgresql://harness_app:s3cret@db.localhost/papercusp', /loopback host/],
    ['no host', 'postgresql:///papercusp', /names no host/],
    ['host= socket override', 'postgresql://harness_app:s3cret@10.20.0.5/papercusp?host=/var/run/postgresql', /host= query override/],
    ['no password', 'postgresql://harness_app@10.20.0.5/papercusp', /carries no password/],
    ['default app password', 'postgresql://harness_app:harness_app_pwd@10.20.0.5/papercusp', /documented default password/],
    ['default admin password', 'postgresql://harness_admin:harness_admin_pwd@10.20.0.5/papercusp', /documented default password/],
    ['postgres password', 'postgresql://postgres:postgres@10.20.0.5/papercusp', /documented default password/],
    ['wrong scheme', 'mysql://harness_app:s3cret@10.20.0.5/papercusp', /must be a postgres/],
    ['unparseable', 'not a url', /not a parseable URL/],
  ])('refuses %s', (_label, appUrl, problem) => {
    const err = captureError(() => resolveProductionDatabaseUrls({ ...base, HARNESS_DATABASE_URL: appUrl }));
    expect(err.problems.join('\n')).toMatch(problem);
  });

  it('reports every problem at once and never echoes a password', () => {
    const err = captureError(() =>
      resolveProductionDatabaseUrls({
        [DEPLOYMENT_ENVIRONMENT_VAR]: 'production',
        HARNESS_ADMIN_DATABASE_URL: 'postgresql://harness_admin:topsecret-admin@localhost/papercusp',
        HARNESS_DATABASE_URL: 'postgresql://harness_app:topsecret-app@127.0.0.1/papercusp',
      }),
    );
    expect(err.problems).toHaveLength(2);
    expect(err.message).not.toContain('topsecret');
  });
});

describe('boot-time assertion (apps/operator/bin/serve.ts ensurePostgres)', () => {
  it('is a no-op outside production, even with no database configured at all', () => {
    expect(assertProductionDatabaseConfiguration({})).toBeNull();
  });

  it('refuses a production boot that would start or attach embedded Postgres', () => {
    const err = captureError(() =>
      assertProductionDatabaseConfiguration({
        [DEPLOYMENT_ENVIRONMENT_VAR]: 'production',
        HARNESS_ADMIN_DATABASE_URL: REMOTE_ADMIN,
        HARNESS_DATABASE_URL: REMOTE_APP,
      }),
    );
    expect(err.problems[0]).toMatch(/PAPERCUSP_USE_EMBEDDED_PG must be "0"/);
  });

  it('refuses a production boot without an explicit database URL', () => {
    const err = captureError(() =>
      assertProductionDatabaseConfiguration({
        [DEPLOYMENT_ENVIRONMENT_VAR]: 'production',
        PAPERCUSP_USE_EMBEDDED_PG: '0',
      }),
    );
    expect(err.problems).toHaveLength(2);
  });

  it('returns redacted endpoints for a valid production configuration', () => {
    const resolved = assertProductionDatabaseConfiguration({
      [DEPLOYMENT_ENVIRONMENT_VAR]: 'production',
      PAPERCUSP_USE_EMBEDDED_PG: '0',
      HARNESS_ADMIN_DATABASE_URL: REMOTE_ADMIN,
      HARNESS_DATABASE_URL: REMOTE_APP,
    });
    expect(resolved?.admin).toEqual({ host: '10.20.0.5', port: '5432', database: 'papercusp', user: 'papercusp_admin' });
    expect(resolved?.app.user).toBe('harness_app');
    expect(JSON.stringify(resolved?.admin)).not.toContain('s3cret');
  });
});
