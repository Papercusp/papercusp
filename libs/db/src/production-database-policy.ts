/**
 * Production database policy: fail closed on database configuration.
 *
 * cloud-portal-public-release-2026-10-13 P-005 / R-3 / D-009.
 *
 * Outside production, `connection.ts` resolves its URLs through a forgiving chain:
 * process env, then the operator's `.env.local`, then the embedded-pg discovery
 * file, then a native `localhost:5432` fallback, and it re-keys the app role onto
 * an admin pin with the documented default `harness_app` credentials. Every rung
 * after the first is a silent way for a production process to land on a local or
 * default-credential database.
 *
 * Production mode is the explicit `PAPERCUSP_DEPLOYMENT_ENVIRONMENT=production`.
 * `NODE_ENV=production` and the `hosted-control-plane` distribution profile cannot
 * be the signal: the dev-box hosted control plane sets both while attaching to the
 * local dev database. Under production mode only explicit process env is accepted:
 *
 *   admin URL  HARNESS_ADMIN_DATABASE_URL, then DATABASE_URL
 *   app URL    HARNESS_DATABASE_URL (never derived from the admin pin)
 *
 * and each URL must name a non-loopback host with a real password. This module is
 * pure (no I/O, no postgres import) so the boot path in `apps/operator/bin/serve.ts`
 * can run it before any pool exists.
 */

export const DEPLOYMENT_ENVIRONMENT_VAR = 'PAPERCUSP_DEPLOYMENT_ENVIRONMENT';

export type DeploymentEnvironment = 'production' | 'development';

const KNOWN_DEPLOYMENT_ENVIRONMENTS: ReadonlySet<string> = new Set(['production', 'development']);

/**
 * Passwords that ship as documented defaults (embedded-pg / native dev roles) or
 * are the stock superuser default. A production URL carrying one of these is a
 * default-credential fallback, whatever host it names.
 */
export const DEFAULT_DATABASE_PASSWORDS: ReadonlySet<string> = new Set([
  'harness_app_pwd',
  'harness_admin_pwd',
  'postgres',
]);

type EnvLike = Readonly<Record<string, string | undefined>>;

export class ProductionDatabaseConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Production database configuration refused (${DEPLOYMENT_ENVIRONMENT_VAR}=production):\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\nProduction resolves its database only from explicit process env and never falls back to ' +
        'a local, discovered or default-credential database.',
    );
    this.name = 'ProductionDatabaseConfigError';
    this.problems = problems;
  }
}

/**
 * The deployment environment. Unset or empty means development. Any value other
 * than `production` or `development` throws, so a typo such as `prod` cannot
 * silently switch the fail-closed policy off.
 */
export function deploymentEnvironment(env: EnvLike = process.env): DeploymentEnvironment {
  const raw = env[DEPLOYMENT_ENVIRONMENT_VAR];
  if (raw === undefined || raw.trim() === '') return 'development';
  const value = raw.trim();
  if (!KNOWN_DEPLOYMENT_ENVIRONMENTS.has(value)) {
    throw new ProductionDatabaseConfigError([
      `${DEPLOYMENT_ENVIRONMENT_VAR}=${JSON.stringify(raw)} is not a known deployment environment ` +
        `(expected "production" or "development")`,
    ]);
  }
  return value as DeploymentEnvironment;
}

export function isProductionDeployment(env: EnvLike = process.env): boolean {
  return deploymentEnvironment(env) === 'production';
}

/** A redacted endpoint description: never carries credentials. */
export interface DatabaseEndpoint {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '::' || host === '0.0.0.0') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host.startsWith('::ffff:127.')) return true;
  return false;
}

/**
 * Validate one production database URL. Returns the redacted endpoint, or pushes
 * problems (never including the password) and returns null.
 */
export function validateProductionDatabaseUrl(
  varName: string,
  url: string,
  problems: string[],
): DatabaseEndpoint | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    problems.push(`${varName} is not a parseable URL`);
    return null;
  }
  const before = problems.length;
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    problems.push(`${varName} must be a postgres:// or postgresql:// URL (got ${parsed.protocol})`);
  }
  const host = parsed.hostname;
  if (!host) {
    problems.push(`${varName} names no host (a local socket connection is not allowed in production)`);
  } else if (isLoopbackHost(host)) {
    problems.push(`${varName} points at loopback host ${host}; production must use the managed instance`);
  }
  if (parsed.searchParams.has('host')) {
    problems.push(`${varName} carries a host= query override, which can redirect to a local socket`);
  }
  let password = '';
  try { password = decodeURIComponent(parsed.password); } catch { password = parsed.password; }
  if (!password) {
    problems.push(`${varName} carries no password`);
  } else if (DEFAULT_DATABASE_PASSWORDS.has(password)) {
    problems.push(`${varName} uses a documented default password for role ${parsed.username || '<none>'}`);
  }
  if (problems.length > before) return null;
  return {
    host,
    port: parsed.port || '5432',
    database: parsed.pathname.replace(/^\//, '') || '<default>',
    user: decodeURIComponent(parsed.username),
  };
}

export interface ProductionDatabaseUrls {
  readonly adminUrl: string;
  readonly adminVar: 'HARNESS_ADMIN_DATABASE_URL' | 'DATABASE_URL';
  readonly appUrl: string;
  readonly admin: DatabaseEndpoint;
  readonly app: DatabaseEndpoint;
}

/**
 * Resolve and validate the production admin and app URLs from explicit process env.
 * Collects every problem and throws once, so an operator fixing a unit sees the
 * whole list rather than one error per restart.
 */
export function resolveProductionDatabaseUrls(env: EnvLike = process.env): ProductionDatabaseUrls {
  const problems: string[] = [];
  const adminVar = env.HARNESS_ADMIN_DATABASE_URL
    ? 'HARNESS_ADMIN_DATABASE_URL'
    : env.DATABASE_URL
      ? 'DATABASE_URL'
      : null;
  const adminUrl = adminVar ? env[adminVar]! : null;
  if (!adminUrl) {
    problems.push('HARNESS_ADMIN_DATABASE_URL (or DATABASE_URL) is not set in the process environment');
  }
  const appUrl = env.HARNESS_DATABASE_URL || null;
  if (!appUrl) {
    problems.push(
      'HARNESS_DATABASE_URL is not set in the process environment; production never derives the app ' +
        'role from the admin URL with default credentials',
    );
  }
  const admin = adminUrl && adminVar ? validateProductionDatabaseUrl(adminVar, adminUrl, problems) : null;
  const app = appUrl ? validateProductionDatabaseUrl('HARNESS_DATABASE_URL', appUrl, problems) : null;
  if (problems.length > 0 || !admin || !app || !adminUrl || !appUrl || !adminVar) {
    throw new ProductionDatabaseConfigError(problems);
  }
  return { adminUrl, adminVar, appUrl, admin, app };
}

/**
 * Boot-time assertion for a production process. A no-op returning null outside
 * production; in production it refuses embedded Postgres and validates both URLs.
 */
export function assertProductionDatabaseConfiguration(
  env: EnvLike = process.env,
): ProductionDatabaseUrls | null {
  if (!isProductionDeployment(env)) return null;
  if (env.PAPERCUSP_USE_EMBEDDED_PG !== '0') {
    const problems = [
      `PAPERCUSP_USE_EMBEDDED_PG must be "0" in production (got ${JSON.stringify(env.PAPERCUSP_USE_EMBEDDED_PG ?? null)}); ` +
        'production never starts or attaches an embedded Postgres',
    ];
    try {
      resolveProductionDatabaseUrls(env);
    } catch (e) {
      if (e instanceof ProductionDatabaseConfigError) problems.push(...e.problems);
      else throw e;
    }
    throw new ProductionDatabaseConfigError(problems);
  }
  return resolveProductionDatabaseUrls(env);
}

/** One-line redacted description for boot logs. */
export function describeDatabaseEndpoint(endpoint: DatabaseEndpoint): string {
  return `${endpoint.user}@${endpoint.host}:${endpoint.port}/${endpoint.database}`;
}
