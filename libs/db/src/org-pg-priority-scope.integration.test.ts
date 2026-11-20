import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { getOrgPg, getOrgPgApp, withPriorityOrgPg, _resetForTests, _resetUrlCacheForTests } from './connection';
import { withWorkspace } from './workspace-context';
import { pgResultDiagnosticSnapshot } from './acquire-registry';

let db: MigratedTestDb;
const keys = ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'PAPERCUSP_DB_POOL_MAX', 'PAPERCUSP_PGBOUNCER'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));

beforeAll(async () => {
  // Fail before allocating a database if this integration prerequisite is missing.
  await new Promise<void>((resolve, reject) => {
    execFile('pgbouncer', ['--version'], { timeout: 2000 }, error => error ? reject(error) : resolve());
  });
  db = await createFreshTestDb({ prefix: 'priorityorg' });
  process.env.HARNESS_ADMIN_DATABASE_URL = db.url;
  process.env.HARNESS_DATABASE_URL = db.url;
  process.env.PAPERCUSP_DB_POOL_MAX = '1';
  process.env.PAPERCUSP_PGBOUNCER = '0';
  await _resetForTests();
}, 120_000);

afterAll(async () => {
  await _resetForTests();
  await db?.drop();
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetUrlCacheForTests();
});

/** A private transaction pooler; it never reads or changes the host's PgBouncer config. */
async function startPrivatePooler(url: string, appRole: string, appPassword: string) {
  const target = new URL(url);
  const user = decodeURIComponent(target.username);
  const database = target.pathname.slice(1);
  const directory = await mkdtemp(join(tmpdir(), 'priority-pooler-'));
  const listener = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') return reject(new Error('No private pooler port'));
      listener.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const authFile = join(directory, 'users.txt');
  const configFile = join(directory, 'pgbouncer.ini');
  await writeFile(authFile,
    `${quote(user)} ${quote(decodeURIComponent(target.password))}\n${quote(appRole)} ${quote(appPassword)}\n`,
    { mode: 0o600 });
  await writeFile(configFile, [
    '[databases]',
    `${database} = host=${target.hostname} port=${target.port || '5432'} dbname=${database}`,
    '[pgbouncer]',
    'listen_addr = 127.0.0.1', `listen_port = ${port}`, 'unix_socket_dir =',
    'auth_type = trust', `auth_file = ${authFile}`, `admin_users = ${user}`,
    'pool_mode = transaction', 'default_pool_size = 1', 'reserve_pool_size = 0',
    'max_client_conn = 20', 'query_wait_timeout = 15',
    // Production clients send search_path, then withWorkspace re-applies it per transaction.
    'ignore_startup_parameters = extra_float_digits,search_path',
    'log_connections = 0', 'log_disconnections = 0',
    `pidfile = ${join(directory, 'pgbouncer.pid')}`, '',
  ].join('\n'), { mode: 0o600 });
  const child = spawn('pgbouncer', [configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  let startupError: Error | undefined;
  child.once('error', error => { startupError = error; });
  let readyTimeout: ReturnType<typeof setTimeout>;
  const ready = new Promise<void>((resolve, reject) => {
    readyTimeout = setTimeout(() => reject(new Error(`Private PgBouncer did not become ready: ${log}`)), 10_000);
    child.once('error', reject);
    child.once('close', (code, signal) => reject(new Error(`Private PgBouncer exited (${code ?? signal}): ${log}`)));
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => {
        log = (log + chunk).slice(-8000);
        if (log.includes('process up:')) resolve();
      });
    }
  });
  const pooled = new URL(url);
  pooled.hostname = '127.0.0.1';
  pooled.port = String(port);
  const consoleUrl = new URL(pooled);
  consoleUrl.pathname = '/pgbouncer';
  const admin = postgres(consoleUrl.toString(), { max: 1, prepare: false, fetch_types: false, connect_timeout: 2 });
  const stop = async () => {
    await admin.end({ timeout: 1 });
    if (child.exitCode === null && child.signalCode === null && !startupError) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await closed; } finally { clearTimeout(kill); }
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    // Hook-safe readiness: a process event, with close/error/timeout failures.
    await ready;
    await admin.unsafe('SHOW VERSION');
    return { url: pooled.toString(), admin, stop, port, directory };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(readyTimeout!);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('priority client slots behind a real transaction pooler', () => {
  let pooler: Awaited<ReturnType<typeof startPrivatePooler>> | undefined;
  let direct: Sql;
  let appRole: string;

  beforeAll(async () => {
    direct = postgres(db.url, { max: 1, onnotice: () => {} });
    appRole = `${db.name}_app`;
    const appPassword = `${db.name}_secret`;
    await direct.unsafe(`CREATE ROLE "${appRole}" LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS`);
    await direct.unsafe(`
      CREATE SCHEMA harness_shared;
      CREATE TABLE harness_shared.priority_policy (workspace_id text PRIMARY KEY, revision integer NOT NULL);
      INSERT INTO harness_shared.priority_policy VALUES ('scope-a', 1), ('scope-b', 99);
      ALTER TABLE harness_shared.priority_policy ENABLE ROW LEVEL SECURITY;
      CREATE POLICY workspace_only ON harness_shared.priority_policy
        USING (workspace_id = current_setting('app.workspace_id', true));
      GRANT USAGE ON SCHEMA harness_shared TO "${appRole}";
      GRANT SELECT ON harness_shared.priority_policy TO "${appRole}";
    `);
    pooler = await startPrivatePooler(db.url, appRole, appPassword);
    const appUrl = new URL(pooler.url);
    appUrl.username = appRole;
    appUrl.password = appPassword;
    await _resetForTests();
    process.env.HARNESS_ADMIN_DATABASE_URL = pooler.url;
    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    process.env.PAPERCUSP_PGBOUNCER = '1';
    _resetUrlCacheForTests();
    // Check the actual client startup contract before interpreting any queue result.
    await withPriorityOrgPg(async () => {
      await getOrgPg().sql`SELECT 1`;
      await withWorkspace('scope-a', tx => tx`SELECT 1`);
    });
  }, 30_000);

  afterAll(async () => {
    await _resetForTests();
    await pooler?.stop();
    if (direct) {
      if (appRole) {
        await direct.unsafe(`DROP OWNED BY "${appRole}"`);
        await direct.unsafe(`DROP ROLE "${appRole}"`);
      }
      await direct.end({ timeout: 1 });
    }
    process.env.HARNESS_ADMIN_DATABASE_URL = db.url;
    process.env.HARNESS_DATABASE_URL = db.url;
    process.env.PAPERCUSP_PGBOUNCER = '0';
    _resetUrlCacheForTests();
  });

  const roles = ['admin', 'app'] as const;
  const client = (role: typeof roles[number]) => role === 'admin' ? getOrgPg().sql : getOrgPgApp().sql;
  const readPolicy = (role: typeof roles[number]) => role === 'admin'
    ? getOrgPg().sql`SELECT revision FROM harness_shared.priority_policy WHERE workspace_id = 'scope-a'`
    : withWorkspace('scope-a', tx => tx`SELECT revision FROM priority_policy`);

  it.each(['scope-a', 'scope-b'])('retains same-SELECT physical server scalars through PgBouncer for %s', async workspace => {
    await withWorkspace(workspace, async tx => {
      // The existing opt-in WeakRef provides the exact server-returned tuple;
      // query_start is a different clock boundary, not an equality oracle.
      const setup = pgResultDiagnosticSnapshot('org-app').results.at(-1)!;
      const observed = pgResultDiagnosticSnapshot('org-app', 1, { includeObjectRefs: true })
        .results[0]!.objectRefs?.decodedResult?.deref() as Array<Record<string, unknown>>;
      expect(observed[0]).toMatchObject({ diagnostic_pg_pid: setup.physicalBackendPid,
        diagnostic_statement_at: setup.serverStatementAt });
      expect(setup.physicalBackendPid).toBeGreaterThan(0);
      expect(setup.serverStatementAt).toMatch(/\.\d{1,6}[+-]/);
      const activity = await direct`SELECT pid, state, xact_start::text AS transaction_started_at,
        query_start::text AS query_started_at, clock_timestamp()::text AS observed_at,
        ${setup.serverStatementAt}::timestamptz BETWEEN xact_start AND clock_timestamp() AS in_transaction
        FROM pg_stat_activity WHERE pid = ${setup.physicalBackendPid}`;
      expect(activity).toHaveLength(1);
      const rows = await tx`SELECT pg_backend_pid() AS physical_pid,
        transaction_timestamp()::text AS held_transaction_at,
        current_setting('app.workspace_id') AS workspace, revision FROM priority_policy`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ physical_pid: setup.physicalBackendPid, workspace,
        revision: workspace === 'scope-a' ? 1 : 99 });
      const clocks = { retained: setup.serverStatementAt, transactionStart: activity[0]!.transaction_started_at,
        queryStart: activity[0]!.query_started_at, observed: activity[0]!.observed_at,
        heldTransaction: rows[0]!.held_transaction_at };
      expect(activity[0], JSON.stringify(clocks)).toMatchObject({ pid: setup.physicalBackendPid,
        state: 'idle in transaction', in_transaction: true });
      // Existing protocol PID stays a separate field, and default snapshots
      // expose neither result rows nor the workspace/GUC values.
      expect(typeof setup.backendPid).toBe('number');
      expect(JSON.stringify(setup)).not.toContain(workspace);
      expect(setup).not.toHaveProperty('objectRefs');
    });
  });

  it.each(roles)('keeps %s priority policy reads available when only an ordinary client slot is held', async role => {
    const ordinary = client(role);
    const held = await ordinary.reserve();
    let finished = false;
    const queued = ordinary`SELECT 1`.then(() => { finished = true; });
    try {
      const rows = await withPriorityOrgPg(async () => {
        expect(client(role)).not.toBe(ordinary);
        expect(client(role).options.port).toEqual([pooler!.port]);
        return readPolicy(role);
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].revision).toBe(1);
      expect(finished).toBe(false);
    } finally {
      held.release();
      await queued;
    }
  }, 15_000);

  it.each(roles)('distinguishes %s priority client capacity from an occupied pooler backend', async role => {
    const ordinary = client(role);
    const entered = deferred();
    const release = deferred();
    const held = ordinary.begin(async tx => {
      await tx`SELECT 1`;
      entered.resolve();
      await release.promise;
    });
    // Always attach a rejection handler, even if setup fails before the finally block.
    void held.catch(() => entered.resolve());
    let pending: Promise<Awaited<ReturnType<typeof readPolicy>>> | undefined;
    let finished = false;
    try {
      await entered.promise;
      pending = withPriorityOrgPg(async () => {
        expect(client(role)).not.toBe(ordinary);
        expect(client(role).options.port).toEqual([pooler!.port]);
        return readPolicy(role);
      });
      void pending.then(() => { finished = true; }, () => { finished = true; });
      const user = role === 'app' ? appRole : decodeURIComponent(new URL(db.url).username);
      // Directly observe the one held backend and priority waiter on this test's pool.
      // The direct-DB control below still works, excluding a database-wide lock or outage.
      await expect.poll(async () => {
        const pools = await pooler!.admin.unsafe('SHOW POOLS');
        const row = pools.find(pool => pool.database === db.name && pool.user === user);
        return { active: Number(row?.sv_active), waiting: Number(row?.cl_waiting) };
      }, { timeout: 5000 }).toEqual({ active: 1, waiting: 1 });
      expect(finished).toBe(false);
      const revision = role === 'admin' ? 2 : 3;
      const updated = await direct`UPDATE harness_shared.priority_policy SET revision = ${revision}
        WHERE workspace_id = 'scope-a' RETURNING revision`;
      expect(updated[0].revision).toBe(revision);
      release.resolve();
      await held;
      const rows = await pending;
      // The queued authority read sees policy changed AFTER it entered the queue.
      // The app path must still hide scope-b through actual RLS on a non-bypass role.
      expect(rows).toHaveLength(1);
      expect(rows[0].revision).toBe(revision);
      expect(client(role)).toBe(ordinary);
    } finally {
      release.resolve();
      await Promise.allSettled([held, ...(pending ? [pending] : [])]);
    }
  }, 20_000);

  it.each(roles)('fails closed if the pooled %s policy target changes inside the priority scope', async role => {
    const key = role === 'admin' ? 'HARNESS_ADMIN_DATABASE_URL' : 'HARNESS_DATABASE_URL';
    const original = process.env[key];
    try {
      await withPriorityOrgPg(async () => {
        process.env[key] = 'postgresql://unused@127.0.0.1:1/changed';
        _resetUrlCacheForTests();
        expect(() => client(role)).toThrow('database target changed during request');
      });
    } finally {
      process.env[key] = original;
      _resetUrlCacheForTests();
    }
  });
});

describe('reserved authority connection capacity', () => {
  it('executes fresh reads while the entire ordinary pool is held', async () => {
    const ordinary = getOrgPg().sql;
    const held = await ordinary.reserve();
    let ordinaryFinished = false;
    const queued = ordinary`SELECT 1 AS value`.then(() => { ordinaryFinished = true; });
    try {
      const rows = await withPriorityOrgPg(async () => {
        expect(getOrgPg().sql).not.toBe(ordinary);
        return getOrgPg().sql`SELECT 42::int AS value`;
      });
      expect(rows[0].value).toBe(42);
      expect(ordinaryFinished).toBe(false);
      expect(getOrgPg().sql).toBe(ordinary);
    } finally {
      held.release();
      await queued;
    }
  }, 15_000);

  it('also isolates fresh workspace policy reads while preserving their RLS context', async () => {
    const ordinary = getOrgPgApp().sql;
    const held = await ordinary.reserve();
    let ordinaryFinished = false;
    const queued = ordinary`SELECT 1`.then(() => { ordinaryFinished = true; });
    try {
      const rows = await withPriorityOrgPg(() => withWorkspace('priority-scope-fixture', async tx => {
        expect(getOrgPgApp().sql).not.toBe(ordinary);
        return tx`SELECT current_setting('app.workspace_id') AS workspace`;
      }));
      expect(rows[0].workspace).toBe('priority-scope-fixture');
      expect(ordinaryFinished).toBe(false);
      expect(getOrgPgApp().sql).toBe(ordinary);
    } finally {
      held.release();
      await queued;
    }
  }, 15_000);

  it('does not lend priority capacity to work that outlives the request', async () => {
    const ordinary = getOrgPg().sql;
    let release!: () => void;
    const later = new Promise<void>(resolve => { release = resolve; });
    let child!: Promise<typeof ordinary>;
    await withPriorityOrgPg(async () => {
      child = later.then(() => getOrgPg().sql);
      expect(getOrgPg().sql).not.toBe(ordinary);
    });
    release();
    expect(await child).toBe(ordinary);
  });

  it('preserves an outer request across nested priority scopes', async () => {
    await withPriorityOrgPg(async () => {
      const outer = getOrgPg().sql;
      await withPriorityOrgPg(async () => { expect(getOrgPg().sql).toBe(outer); });
      expect(getOrgPg().sql).toBe(outer);
    });
  });

  it('fails closed if the database target changes during authority evaluation', async () => {
    const original = process.env.HARNESS_ADMIN_DATABASE_URL;
    try {
      await withPriorityOrgPg(async () => {
        process.env.HARNESS_ADMIN_DATABASE_URL = 'postgresql://unused@127.0.0.1:1/changed';
        _resetUrlCacheForTests();
        expect(() => getOrgPg()).toThrow('Priority org database target changed during request');
      });
    } finally {
      process.env.HARNESS_ADMIN_DATABASE_URL = original;
      _resetUrlCacheForTests();
    }
  });
});
