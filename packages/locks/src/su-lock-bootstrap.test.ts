import { afterEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('postgres', () => ({ default: driver.create }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Model PostgreSQL's database-local session locks and non-atomic catalog DDL.
// The first DDL is paused until the second caller reaches the catalog boundary;
// no timing/sleep assumption decides whether the race is exercised.
function catalog(databaseExists: boolean, pauseFirstDdl = true) {
  const ddlStarted = deferred();
  const competing = deferred();
  const continueDdl = deferred();
  const locks = new Map<string, Promise<void>>();
  const applied = new Set<string>();
  const events: string[] = [];
  const admins: Array<{ database: string; release: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }> = [];
  let metaExists = false;
  let creatingDatabase = false;
  let creatingMeta = false;
  let paused = false;
  let failAt = '';
  let held = 0;

  async function pause() {
    if (!pauseFirstDdl || paused) return;
    paused = true;
    ddlStarted.resolve();
    await continueDdl.promise;
  }

  driver.create.mockImplementation((url: string) => {
    const database = new URL(url).pathname.slice(1);
    const admin = database !== 'papercusp_su';
    const number = admin ? admins.length + 1 : 0;
    let unlock: (() => void) | undefined;
    const execute = async (statement: string, values: unknown[] = []) => {
      if (admin && number > 1) competing.resolve();
      if (statement.includes('pg_advisory_lock(')) {
        if (failAt === 'lock') { failAt = ''; throw new Error('lock failure'); }
        const key = `${database}:${values[0]}:${statement.split('hashtext')[1]}`;
        const prior = locks.get(key) ?? Promise.resolve();
        const released = deferred();
        locks.set(key, released.promise);
        await prior;
        held++;
        events.push('locked');
        unlock = () => { held--; released.resolve(); };
        return [];
      }
      if (statement.includes('FROM pg_database')) {
        events.push('probe');
        return [{ exists: databaseExists }];
      }
      if (statement.startsWith('CREATE DATABASE')) {
        events.push('create-database');
        if (databaseExists || creatingDatabase) throw new Error('duplicate pg_database_datname_index');
        creatingDatabase = true;
        try {
          await pause();
          if (failAt === 'database') { failAt = ''; throw new Error('database failure'); }
          databaseExists = true;
        } finally { creatingDatabase = false; }
      } else if (statement.includes('CREATE TABLE IF NOT EXISTS su_meta')) {
        events.push('create-meta');
        if (!metaExists) {
          if (creatingMeta) throw new Error('duplicate pg_type_typname_nsp_index');
          creatingMeta = true;
          try {
            await pause();
            if (failAt === 'meta') { failAt = ''; throw new Error('meta failure'); }
            metaExists = true;
          } finally { creatingMeta = false; }
        }
      } else if (statement.includes('SELECT key FROM su_meta')) {
        return [...applied].map(key => ({ key }));
      } else if (statement.includes('INSERT INTO su_meta')) {
        applied.add(String(values[0]));
      } else if (statement === 'MIGRATION') {
        events.push('migration');
        if (failAt === 'migration') { failAt = ''; throw new Error('migration failure'); }
      }
      return [];
    };
    const query = (strings: TemplateStringsArray, ...values: unknown[]) => execute(strings.join('?'), values);
    const unsafe = (statement: string) => {
      // Classify real migration scripts independently of their contents.
      const promise = execute(admin ? statement : 'MIGRATION');
      return Object.assign(promise, { simple: () => promise });
    };
    // Returning a reservation makes the connection available to the pool.
    // PostgreSQL releases the session advisory lock when the backend closes.
    const release = vi.fn(() => { events.push('returned'); });
    const reserved = Object.assign(query.bind(null), { unsafe, release });
    const sql = Object.assign(
      query,
      {
        reserve: vi.fn(async () => {
          if (failAt === 'reserve') { failAt = ''; throw new Error('reserve failure'); }
          return reserved;
        }),
        unsafe,
        begin: async (run: (tx: unknown) => Promise<unknown>) => run(sql),
        end: vi.fn(async () => { events.push('closed'); unlock?.(); unlock = undefined; }),
      },
    );
    if (admin) admins.push({ database, release, end: sql.end });
    return sql;
  });

  return {
    ddlStarted, competing, continueDdl, admins, events,
    held: () => held,
    failNext: (phase: string) => { failAt = phase; },
  };
}

async function caller(database: string) {
  // Separate module instances model separate embedding processes (and their
  // independent bootstrapped flags), using one shared PostgreSQL catalog.
  vi.resetModules();
  const { configureLocks } = await import('./config');
  configureLocks({ getAdminBaseUrl: () => `postgres://admin:secret@localhost:5432/${database}?sslmode=disable` });
  return import('./su-lock-store');
}

afterEach(() => { driver.create.mockReset(); });

describe('SU-lock bootstrap catalog concurrency', () => {
  it.each([false, true])('serializes first callers with databaseExists=%s across different main databases', async databaseExists => {
    const cluster = catalog(databaseExists);
    const first = await caller('organization_a');
    const second = await caller('organization_b');
    const firstRun = first.ensureBootstrap();
    await cluster.ddlStarted.promise;
    const secondRun = second.ensureBootstrap();
    // Observe rejections immediately, including the historical catalog race.
    const settled = Promise.allSettled([firstRun, secondRun]);
    await cluster.competing.promise;
    const whileFirstPaused = [...cluster.events];
    cluster.continueDdl.resolve();

    expect(await settled).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
    expect(whileFirstPaused.filter(event => event === 'probe')).toHaveLength(1);
    expect(whileFirstPaused.filter(event => event === (databaseExists ? 'create-meta' : 'create-database'))).toHaveLength(1);
    expect(cluster.admins.map(admin => admin.database)).toEqual(['postgres', 'postgres']);
    expect(cluster.events[0]).toBe('locked');
    expect(cluster.events.lastIndexOf('migration')).toBeLessThan(cluster.events.indexOf('returned'));
    expect(cluster.held()).toBe(0);
    for (const admin of cluster.admins) {
      expect(admin.release).toHaveBeenCalledOnce();
      expect(admin.release).toHaveBeenCalledBefore(admin.end);
      expect(admin.end).toHaveBeenCalledOnce();
    }
    await Promise.all([first._resetForTests(), second._resetForTests()]);
  });

  it.each(['reserve', 'lock', 'database', 'meta', 'migration'])('releases the bootstrap session after %s failure and allows retry', async phase => {
    const cluster = catalog(false, false);
    cluster.failNext(phase);
    const store = await caller('organization');
    await expect(store.ensureBootstrap()).rejects.toThrow(`${phase} failure`);
    expect(cluster.held()).toBe(0);
    const [failed] = cluster.admins;
    expect(failed.end).toHaveBeenCalledOnce();
    if (phase === 'reserve') {
      expect(failed.release).not.toHaveBeenCalled();
    } else {
      expect(failed.release).toHaveBeenCalledOnce();
      expect(failed.release).toHaveBeenCalledBefore(failed.end);
    }

    await expect(store.ensureBootstrap()).resolves.toBeUndefined();
    expect(cluster.held()).toBe(0);
    expect(cluster.admins).toHaveLength(2);
    const retried = cluster.admins[1];
    expect(retried.release).toHaveBeenCalledOnce();
    expect(retried.release).toHaveBeenCalledBefore(retried.end);
    await store.ensureBootstrap();
    expect(cluster.admins).toHaveLength(2); // Only success is memoized.
    await store._resetForTests();
  });
});
