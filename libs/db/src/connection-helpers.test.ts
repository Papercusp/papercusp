/**
 * Unit tests for the connection-routing helpers `pgbouncerEnabled` (P-004) +
 * `maybePgbouncer` (C2) — backend-connection-scaling-2026-06-17. No Postgres
 * needed: importing ./connection does not open a connection (all pools are lazy).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// pgbouncerEnabled() consults getResourceProfile().hostClass for the default
// (unset-env) case. Mock it so the default is deterministic regardless of the
// test host's core count. Same module specifier connection.ts imports.
const mockProfile = vi.hoisted(() => ({ hostClass: 'server' as 'server' | 'workstation' | 'laptop' }));
vi.mock('../../../../../packages/operator-core/lib/resource-profile', () => ({
  getResourceProfile: () => ({ hostClass: mockProfile.hostClass }),
}));

import {
  buildConnectionOptions,
  connectionBudgetStatus,
  maybePgbouncer,
  pgbouncerEnabled,
  _resetUrlCacheForTests,
  _resolveUrlsForTests,
} from './connection';

const DIRECT = 'postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp';
const POOLED = 'postgresql://harness_app:harness_app_pwd@127.0.0.1:6432/papercusp';

const saved = {
  on: process.env.PAPERCUSP_PGBOUNCER,
  port: process.env.PAPERCUSP_PGBOUNCER_PORT,
  pgPort: process.env.PAPERCUSP_PG_PORT,
};
afterEach(() => {
  if (saved.on === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
  else process.env.PAPERCUSP_PGBOUNCER = saved.on;
  if (saved.port === undefined) delete process.env.PAPERCUSP_PGBOUNCER_PORT;
  else process.env.PAPERCUSP_PGBOUNCER_PORT = saved.port;
  if (saved.pgPort === undefined) delete process.env.PAPERCUSP_PG_PORT;
  else process.env.PAPERCUSP_PG_PORT = saved.pgPort;
  mockProfile.hostClass = 'server';
});

describe('buildConnectionOptions — PgBouncer-safe startup params (no "unsupported startup parameter")', () => {
  const base = { searchPath: '"harness_shared", "public"', applicationName: 'pcusp:org-app:p1' };

  it('DIRECT: sends idle_in_transaction_session_timeout + statement_timeout at startup', () => {
    const c = buildConnectionOptions({ ...base, idleInTxMs: 60000, stmtTimeoutMs: 30000, pooled: false });
    expect(c.idle_in_transaction_session_timeout).toBe('60000');
    expect(c.statement_timeout).toBe('30000');
    expect(c.search_path).toBe(base.searchPath);
    expect(c.application_name).toBe(base.applicationName);
  });

  it('POOLED: OMITS both timeout GUCs — the pooler rejects them as startup parameters', () => {
    const c = buildConnectionOptions({ ...base, idleInTxMs: 60000, stmtTimeoutMs: 30000, pooled: true });
    // The bug: these were sent as libpq startup params and PgBouncer 502'd the plans:* writes.
    expect(c).not.toHaveProperty('statement_timeout');
    expect(c).not.toHaveProperty('idle_in_transaction_session_timeout');
    // search_path + application_name still sent (pooler-allowed/ignored; search_path re-applied per-tx).
    expect(c.search_path).toBe(base.searchPath);
    expect(c.application_name).toBe(base.applicationName);
  });

  it('DIRECT with stmtTimeoutMs=0 omits statement_timeout but keeps idle (pre-WI-832 behaviour)', () => {
    const c = buildConnectionOptions({ ...base, idleInTxMs: 60000, stmtTimeoutMs: 0, pooled: false });
    expect(c).not.toHaveProperty('statement_timeout');
    expect(c.idle_in_transaction_session_timeout).toBe('60000');
  });

  // WI-3816: ClientWrite-zombie guard — a backend whose client is gone/not-reading
  // must notice and abort itself instead of surviving pg_cancel_backend forever.
  it('DIRECT with clientConnCheckMs set: sends client_connection_check_interval + tightened TCP keepalives', () => {
    const c = buildConnectionOptions({ ...base, idleInTxMs: 60000, stmtTimeoutMs: 30000, pooled: false, clientConnCheckMs: 30000 });
    expect(c.client_connection_check_interval).toBe('30000');
    expect(c.tcp_keepalives_idle).toBe('30');
    expect(c.tcp_keepalives_interval).toBe('10');
    expect(c.tcp_keepalives_count).toBe('3');
  });

  it('DIRECT with clientConnCheckMs omitted/0: omits the dead-client GUCs (opt-out preserved)', () => {
    const withoutArg = buildConnectionOptions({ ...base, idleInTxMs: 60000, stmtTimeoutMs: 30000, pooled: false });
    expect(withoutArg).not.toHaveProperty('client_connection_check_interval');
    expect(withoutArg).not.toHaveProperty('tcp_keepalives_idle');
    const zero = buildConnectionOptions({ ...base, idleInTxMs: 60000, stmtTimeoutMs: 30000, pooled: false, clientConnCheckMs: 0 });
    expect(zero).not.toHaveProperty('client_connection_check_interval');
  });

  it('POOLED: OMITS the dead-client GUCs too — same PgBouncer-startup-param rejection risk', () => {
    const c = buildConnectionOptions({ ...base, idleInTxMs: 60000, stmtTimeoutMs: 30000, pooled: true, clientConnCheckMs: 30000 });
    expect(c).not.toHaveProperty('client_connection_check_interval');
    expect(c).not.toHaveProperty('tcp_keepalives_idle');
  });
});

describe('pgbouncerEnabled — P-004 default-on for server-class native PG', () => {
  it('defaults ON when env is unset and the host is server-class', () => {
    delete process.env.PAPERCUSP_PGBOUNCER;
    mockProfile.hostClass = 'server';
    expect(pgbouncerEnabled()).toBe(true);
  });

  it('defaults OFF when env is unset and the host is laptop/workstation (the Tauri desktop)', () => {
    delete process.env.PAPERCUSP_PGBOUNCER;
    mockProfile.hostClass = 'laptop';
    expect(pgbouncerEnabled()).toBe(false);
    mockProfile.hostClass = 'workstation';
    expect(pgbouncerEnabled()).toBe(false);
  });

  it('PAPERCUSP_PGBOUNCER=1 forces ON even on a laptop', () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    mockProfile.hostClass = 'laptop';
    expect(pgbouncerEnabled()).toBe(true);
  });

  it('PAPERCUSP_PGBOUNCER=0 is the kill-switch — forces OFF even on a server', () => {
    process.env.PAPERCUSP_PGBOUNCER = '0';
    mockProfile.hostClass = 'server';
    expect(pgbouncerEnabled()).toBe(false);
  });

  it('an unrecognized flag value falls through to the host-class default', () => {
    process.env.PAPERCUSP_PGBOUNCER = 'true';
    mockProfile.hostClass = 'server';
    expect(pgbouncerEnabled()).toBe(true); // server → default on
    mockProfile.hostClass = 'laptop';
    expect(pgbouncerEnabled()).toBe(false); // laptop → default off
  });

  // WI-1666: a "fresh, isolated" hive-from-repo smoke witness on a server-class
  // shared dev box got its org-pool connection silently rerouted through the
  // box-wide PgBouncer (which fronts the SHARED native PG) instead of its own
  // freshly-booted, empty embedded PG on an explicit PAPERCUSP_PG_PORT — so it
  // read another process's pre-existing shared_repo_binding_cache rows. An
  // explicit PAPERCUSP_PG_PORT means this process owns its OWN dedicated,
  // isolated embedded PG (smoke witnesses / desktop sidecars / Hetzner rigs
  // always set it; the real dev/staging operators on this box never do), so it
  // must bypass the box's shared pooler regardless of hostClass.
  it('PAPERCUSP_PG_PORT set forces OFF even on a server-class host (WI-1666 isolation fix)', () => {
    delete process.env.PAPERCUSP_PGBOUNCER;
    mockProfile.hostClass = 'server';
    process.env.PAPERCUSP_PG_PORT = '19532';
    expect(pgbouncerEnabled()).toBe(false);
  });

  it('PAPERCUSP_PGBOUNCER=1 still forces ON even with PAPERCUSP_PG_PORT set (explicit override wins)', () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    mockProfile.hostClass = 'server';
    process.env.PAPERCUSP_PG_PORT = '19532';
    expect(pgbouncerEnabled()).toBe(true);
  });

  it('unset PAPERCUSP_PG_PORT leaves the server-class default untouched', () => {
    delete process.env.PAPERCUSP_PGBOUNCER;
    delete process.env.PAPERCUSP_PG_PORT;
    mockProfile.hostClass = 'server';
    expect(pgbouncerEnabled()).toBe(true);
  });
});

describe('maybePgbouncer', () => {
  it('returns the URL untouched when pooling is disabled (laptop default, env unset)', () => {
    delete process.env.PAPERCUSP_PGBOUNCER;
    mockProfile.hostClass = 'laptop';
    expect(maybePgbouncer(DIRECT)).toBe(DIRECT);
  });

  it('routes through the pooler by DEFAULT on a server-class host (P-004), env unset', () => {
    delete process.env.PAPERCUSP_PGBOUNCER;
    mockProfile.hostClass = 'server';
    expect(maybePgbouncer(DIRECT)).toBe(POOLED);
  });

  it('routes to 127.0.0.1:6432 when forced on, preserving credentials + database', () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    delete process.env.PAPERCUSP_PGBOUNCER_PORT;
    expect(maybePgbouncer(DIRECT)).toBe(POOLED);
  });

  it('honors PAPERCUSP_PGBOUNCER_PORT', () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    process.env.PAPERCUSP_PGBOUNCER_PORT = '7000';
    expect(maybePgbouncer(DIRECT)).toContain('@127.0.0.1:7000/');
  });

  it('kill-switch PAPERCUSP_PGBOUNCER=0 keeps the URL direct even on a server', () => {
    process.env.PAPERCUSP_PGBOUNCER = '0';
    mockProfile.hostClass = 'server';
    expect(maybePgbouncer(DIRECT)).toBe(DIRECT);
  });

  it('leaves an unparseable URL untouched (never throws)', () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    expect(maybePgbouncer('not a url')).toBe('not a url');
  });

  // EI-2437: the local PgBouncer instance fronts ONLY the box's own native PG
  // (NATIVE_FALLBACK, always localhost:5432) — a URL that already points
  // somewhere else (a testcontainer's random ephemeral port; a future
  // remote/managed PG) is an explicit override and must NOT be rerouted.
  describe('EI-2437: only reroutes a URL that already targets the native-PG default (localhost:5432)', () => {
    it('a testcontainer URL on a random port is left DIRECT even with pooling forced on', () => {
      process.env.PAPERCUSP_PGBOUNCER = '1';
      const TESTCONTAINER = 'postgresql://harness_app:harness_app_pwd@127.0.0.1:33019/org_abc123';
      expect(maybePgbouncer(TESTCONTAINER)).toBe(TESTCONTAINER);
    });

    it('a testcontainer URL is left DIRECT under the server-class DEFAULT-ON path too (not just forced)', () => {
      delete process.env.PAPERCUSP_PGBOUNCER;
      mockProfile.hostClass = 'server';
      const TESTCONTAINER = 'postgresql://harness_app:harness_app_pwd@127.0.0.1:33019/org_abc123';
      expect(maybePgbouncer(TESTCONTAINER)).toBe(TESTCONTAINER);
    });

    it('a non-local host is left DIRECT (a future remote/managed PG) even when the port is 5432', () => {
      process.env.PAPERCUSP_PGBOUNCER = '1';
      const REMOTE = 'postgresql://harness_app:harness_app_pwd@db.example.internal:5432/papercusp';
      expect(maybePgbouncer(REMOTE)).toBe(REMOTE);
    });

    it('an omitted port on the native host still reroutes (implicit 5432 counts as the default)', () => {
      process.env.PAPERCUSP_PGBOUNCER = '1';
      delete process.env.PAPERCUSP_PGBOUNCER_PORT;
      const NO_PORT = 'postgresql://harness_app:harness_app_pwd@localhost/papercusp';
      expect(maybePgbouncer(NO_PORT)).toBe(POOLED);
    });

    it('the native-default URL (localhost:5432) still reroutes exactly as before (no regression)', () => {
      process.env.PAPERCUSP_PGBOUNCER = '1';
      expect(maybePgbouncer(DIRECT)).toBe(POOLED);
    });
  });
});

describe('connectionBudgetStatus — EI-3379 pooler-aware backend budget', () => {
  // The live 15-worker dev-box cluster: poolMax 24 → org 48, harness 8, fixed 13,
  // 16 procs (15 workers + primary), max_connections 512.
  const devBox = { orgPools: 48, harnessPools: 8, fixedOverhead: 13, expectedProcesses: 16, liveMax: 512 };

  it('POOLED: excludes org pools (pgbouncer client slots) → not DANGER', () => {
    const r = connectionBudgetStatus({ ...devBox, pooled: true });
    expect(r.directPerProc).toBe(21); // 0 org + 8 harness + 13 fixed
    expect(r.fleetWorst).toBe(336); // 21 × 16, well under 512
    expect(r.danger).toBe(false);
  });

  it('DIRECT (no pooler): counts org pools → DANGER (the pre-fix false alarm WAS the real direct risk)', () => {
    const r = connectionBudgetStatus({ ...devBox, pooled: false });
    expect(r.directPerProc).toBe(69); // 48 org + 8 harness + 13 fixed
    expect(r.fleetWorst).toBe(1104); // 69 × 16, way over 512
    expect(r.danger).toBe(true);
  });

  it('POOLED but the DIRECT pools genuinely exhaust → still DANGER (the check still bites)', () => {
    // e.g. a runaway per-harness pool cap multiplied across many processes
    const r = connectionBudgetStatus({
      orgPools: 48,
      harnessPools: 40,
      fixedOverhead: 13,
      expectedProcesses: 16,
      liveMax: 512,
      pooled: true,
    });
    expect(r.directPerProc).toBe(53); // org excluded, but 40 harness + 13 fixed
    expect(r.fleetWorst).toBe(848); // 53 × 16 > 512
    expect(r.danger).toBe(true);
  });

  it('liveMax unknown (0, PG unreachable) is never DANGER', () => {
    expect(connectionBudgetStatus({ ...devBox, pooled: false, liveMax: 0 }).danger).toBe(false);
  });
});

describe('URL resolution env precedence (WI-5244)', () => {
  const savedUrls = {
    HARNESS_ADMIN_DATABASE_URL: process.env.HARNESS_ADMIN_DATABASE_URL,
    HARNESS_DATABASE_URL: process.env.HARNESS_DATABASE_URL,
    DATABASE_URL: process.env.DATABASE_URL,
  } as const;
  afterEach(() => {
    for (const k of Object.keys(savedUrls) as Array<keyof typeof savedUrls>) {
      if (savedUrls[k] === undefined) delete process.env[k];
      else process.env[k] = savedUrls[k];
    }
    _resetUrlCacheForTests();
  });

  it('DATABASE_URL beats the discovery file: admin uses it as-is, app re-keys the endpoint onto the app role', () => {
    // The WI-5244 incident: a local install rewrote ~/.papercusp/embedded-pg.json
    // and hijacked every pool on a host that sets DATABASE_URL but not HARNESS_*.
    delete process.env.HARNESS_ADMIN_DATABASE_URL;
    delete process.env.HARNESS_DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://harness_admin:pw@dbhost.example:5999/papercusp';
    _resetUrlCacheForTests();
    const { app, admin } = _resolveUrlsForTests();
    expect(admin).toBe('postgresql://harness_admin:pw@dbhost.example:5999/papercusp');
    expect(app).toBe('postgresql://harness_app:harness_app_pwd@dbhost.example:5999/papercusp');
  });

  it('HARNESS_* env still wins over DATABASE_URL', () => {
    process.env.HARNESS_ADMIN_DATABASE_URL = 'postgresql://a:b@adminhost:5432/papercusp';
    process.env.HARNESS_DATABASE_URL = 'postgresql://c:d@apphost:5432/papercusp';
    process.env.DATABASE_URL = 'postgresql://harness_admin:pw@other:5999/papercusp';
    _resetUrlCacheForTests();
    const { app, admin } = _resolveUrlsForTests();
    expect(admin).toBe('postgresql://a:b@adminhost:5432/papercusp');
    expect(app).toBe('postgresql://c:d@apphost:5432/papercusp');
  });
});
