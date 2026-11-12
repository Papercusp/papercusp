/**
 * su-lock-store.test.ts — migration-source resolution for lazy lock bootstrap.
 *
 * Run: cd libs/papercusp/packages/locks && npx vitest run src/su-lock-store.test.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beginSuLockTransaction, readQueue, resolveLocksSqlDir, tryAcquire, tryHeartbeat } from './su-lock-store';
import { sweepResourceExpired, tryHeartbeatResource } from './resource-lock-store';
import { configureLocks, type ResourceExpiryRelease } from './config';

const roots: string[] = [];

beforeEach(() => {
  // Store calls consult the host's preservation seam even with a fake SQL
  // transaction. Configure that seam before the first acquisition test.
  configureLocks({ getAdminBaseUrl: () => 'postgres://unused' });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'locks-sql-dir-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveLocksSqlDir', () => {
  it('falls back from a removed release dist-host to canonical lock sources', () => {
    const root = fixtureRoot();
    const moduleDir = join(root, 'apps', 'operator', 'dist-host');
    const sourceDir = join(root, 'libs', 'papercusp', 'packages', 'locks', 'src', 'sql');
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });

    expect(resolveLocksSqlDir(moduleDir)).toBe(sourceDir);
  });

  it('prefers the adjacent bundled SQL directory when both layouts exist', () => {
    const root = fixtureRoot();
    const moduleDir = join(root, 'apps', 'operator', 'dist-host');
    const bundledDir = join(moduleDir, 'sql');
    const sourceDir = join(root, 'libs', 'papercusp', 'packages', 'locks', 'src', 'sql');
    mkdirSync(bundledDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });

    expect(resolveLocksSqlDir(moduleDir)).toBe(bundledDir);
  });

  it('keeps the adjacent path as the loud failure target when no layout exists', () => {
    const root = fixtureRoot();
    const moduleDir = join(root, 'apps', 'operator', 'dist-host');
    mkdirSync(moduleDir, { recursive: true });

    expect(resolveLocksSqlDir(moduleDir)).toBe(join(moduleDir, 'sql'));
  });
});

describe('git-sync registry prose migration', () => {
  it('keeps the bare resource description aligned with the workspace barrier', () => {
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'sql', '028-git-sync-registry-prose.sql'),
      'utf8',
    );

    expect(migration).toContain("UPDATE agent_resource_registry");
    expect(migration).toContain("WHERE resource = 'git-sync'");
    expect(migration).toContain('workspace-wide git-sync restart barrier shared by every automated git-sync fire');
    expect(migration).toContain('shared(git-sync)');
    expect(migration).toContain('exclusive(git-sync:<slug>)');
    expect(migration).toContain('dev:restart');
    expect(migration).toContain('updated_ts = clock_timestamp()');
    expect(migration).not.toContain('papercup-only legacy back-off');
  });
});

describe('tryAcquire', () => {
  it('marks a short upsert result as an explicit retryable race, even with no busy snapshot', async () => {
    const tx = ((strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      if (text.includes('WITH wanted')) {
        // Simulate a competing row winning one path after the pre-check. The
        // competing row is then gone before readBusySnapshot, so the snapshot
        // is intentionally empty.
        return [{ path: 'first.ts', lock_id: '00000000-0000-0000-0000-000000000001' }];
      }
      return [];
    }) as unknown as Parameters<typeof tryAcquire>[0];

    const result = await tryAcquire(tx, {
      coordinationDomain: 'test-domain',
      owner: 'requester',
      ownerLabel: 'Requester',
      paths: ['first.ts', 'second.ts'],
      intent: 'race regression',
      ttlSec: 60,
    });

    expect(result).toEqual({
      ok: false,
      busy: [],
      reason: 'upsert_race',
      retryable: true,
    });
  });

  it('keeps an earlier same-owner waiter out of busy and reports the actual holder lease', async () => {
    const waiterUntil = new Date('2026-10-02T03:44:01.010Z');
    const holderAcquired = new Date('2026-10-02T03:00:00.000Z');
    const holderExpires = new Date('2026-10-02T03:59:29.604Z');
    const statements: string[] = [];
    const tx = ((strings: TemplateStringsArray) => {
      const statement = strings.join(' ').replace(/\s+/g, ' ').trim();
      statements.push(statement);
      if (statement.includes('SELECT path, lock_id::text AS lock_id, expires_ts FROM agent_file_locks')) {
        return [];
      }
      if (statement.includes('FROM agent_lock_waiters w')) {
        return [{
          path: 'src/contended.ts',
          owner: 'requester',
          owner_label: 'Requester',
          intent: 'edit',
          expires_ts: waiterUntil,
        }];
      }
      if (statement.includes('SELECT path, owner, owner_label, intent, acquired_ts, expires_ts FROM agent_file_locks')) {
        return [{
          path: 'src/contended.ts',
          owner: 'active-holder',
          owner_label: 'Active holder',
          intent: 'write file',
          acquired_ts: holderAcquired,
          expires_ts: holderExpires,
        }];
      }
      return [];
    }) as unknown as Parameters<typeof tryAcquire>[0];

    const result = await tryAcquire(tx, {
      coordinationDomain: 'test-domain',
      owner: 'requester',
      ownerLabel: 'Requester',
      paths: ['src/contended.ts'],
      intent: 'retry while queued',
      ttlSec: 60,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'queued_waiter',
      busy: [{
        path: 'src/contended.ts',
        owner: 'active-holder',
        owner_label: 'Active holder',
        intent: 'write file',
        acquired_ts: holderAcquired,
        expires_ts: holderExpires,
      }],
    });
    expect(statements.some((statement) => statement.includes('FROM agent_lock_waiters w'))).toBe(true);
    expect(statements.some((statement) => statement.includes('SELECT path, owner, owner_label, intent, acquired_ts, expires_ts FROM agent_file_locks'))).toBe(true);
  });
});

describe.each([
  ['file', tryHeartbeat],
  ['resource', tryHeartbeatResource],
] as const)('%s lease renewal', (_kind, heartbeat) => {
  it('renews the requested lease without depending on unrelated expiry housekeeping', async () => {
    const expires = new Date('2030-01-01T00:00:00Z');
    const tx = (async (strings: TemplateStringsArray) => {
      const query = strings.join(' ').trim();
      // An unrelated expired row may be held by another transaction. Renewing
      // our lease must never require deleting that row or promoting its queue.
      if (/DELETE|grant_cascade|promote_resource/i.test(query)) {
        throw Object.assign(new Error('unrelated expired row locked'), { code: '57014' });
      }
      return query.includes('UPDATE') ? [{ expires_ts: expires, extended: true }] : [];
    }) as unknown as Parameters<typeof tryHeartbeat>[0];

    await expect(heartbeat(tx, 'domain', 'owner', 'lock-id', 120))
      .resolves.toEqual({ extended: true, expires_ts: expires });
  });
});

describe('resource heartbeat refusal evidence', () => {
  const observed = new Date('2030-01-01T00:10:00Z');
  const acquired = new Date('2030-01-01T00:00:00Z');
  const live = new Date('2030-01-01T00:20:00Z');

  it.each([
    { reason: 'missing', expiry: null, domain: null, owner: null },
    { reason: 'domain-mismatch', expiry: live, domain: false, owner: true },
    { reason: 'owner-mismatch', expiry: live, domain: true, owner: false },
    { reason: 'expired', expiry: observed, domain: true, owner: true },
    { reason: 'live-row-not-renewed', expiry: live, domain: true, owner: true },
  ])('preserves $reason without renewing or re-acquiring the lease', async ({ reason, expiry, domain, owner }) => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('$').replace(/\s+/g, ' ').trim();
      statements.push({ query, values });
      return query.includes('WITH renewed') ? [{
        extended: false, expires_ts: null, observed_ts: observed,
        acquired_ts: expiry ? acquired : null, lease_expires_ts: expiry,
        domain_matches: domain, owner_matches: owner,
      }] : [];
    }) as unknown as Parameters<typeof tryHeartbeatResource>[0];

    await expect(tryHeartbeatResource(tx, 'domain', 'owner', 'lock-id', 120)).resolves.toEqual({
      extended: false, expires_ts: null, refusal: {
        reason, observed_ts: observed, acquired_ts: expiry ? acquired : null,
        lease_expires_ts: expiry, domain_matches: domain, owner_matches: owner,
      },
    });
    const renewal = statements.find(({ query }) => query.includes('WITH renewed'))!;
    expect(renewal.query).toContain('AND expires_ts > clock_timestamp()');
    expect(renewal.query).toContain('AND owner = $');
    expect(renewal.query).toContain('WHERE coordination_domain = $');
    expect(renewal.query).toContain('WHERE NOT EXISTS (SELECT 1 FROM renewed)');
    expect(renewal.values).toEqual(['120 seconds', 'domain', 'lock-id', 'owner', 'domain', 'owner', 'lock-id']);
    expect(statements).toHaveLength(2); // timeout + one atomic renewal/observation statement
    expect(statements.some(({ query }) => /INSERT|DELETE|grant_cascade/i.test(query))).toBe(false);
  });
});

describe('readQueue', () => {
  function fakePool(route: (statement: string) => unknown[] = () => []) {
    const statements: string[] = [];
    const sql = Object.assign(
      (strings: TemplateStringsArray) => {
        const statement = strings.join(' ');
        statements.push(statement);
        return Promise.resolve(route(statement));
      },
      { begin: async (run: (tx: unknown) => Promise<unknown>) => run(sql) },
    );
    return { sql: sql as never, statements };
  }

  it.each([false, true])('keeps queue reads free of resource-expiry notices (diagnostics=%s)', async (diagnostics) => {
    const notices: ResourceExpiryRelease[] = [];
    configureLocks({
      getAdminBaseUrl: () => 'postgres://unused',
      onResourceExpired: release => { notices.push(release); },
    });
    const pool = fakePool();

    await readQueue(pool.sql, { coordinationDomain: null, includeCompleted: true },
      diagnostics ? { onPhase: () => {} } : {});

    expect(notices).toEqual([]);
    expect(pool.statements.some(statement => /resource_(?:sweep|note|take)_|DELETE|UPDATE|INSERT/.test(statement))).toBe(false);
  });

  it('delivers a resource sweep receipt through the shared transaction wrapper', async () => {
    const notices: ResourceExpiryRelease[] = [];
    configureLocks({
      getAdminBaseUrl: () => 'postgres://unused',
      onResourceExpired: release => { notices.push(release); },
    });
    const pool = fakePool(statement => {
      if (statement.includes('DELETE FROM agent_resource_locks')) return [{ resource: 'git-sync:test', mode: 'exclusive' }];
      if (statement.includes('resource_take_expiry_releases')) return [{ resource: 'git-sync:test', coordination_domain: 'test-domain' }];
      return [];
    });

    await beginSuLockTransaction(pool.sql, tx => sweepResourceExpired(tx as never, 'test-domain'));

    expect(notices).toEqual([{ resource: 'git-sync:test', coordinationDomain: 'test-domain' }]);
    expect(pool.statements.some(statement => statement.includes('resource_take_expiry_releases'))).toBe(true);
  });

  it('skips the waiter query when a caller only needs active locks', async () => {
    const pool = fakePool();

    const result = await readQueue(pool.sql, {
      coordinationDomain: 'test-domain',
      paths: ['src/file.ts'],
      includeWaiting: false,
    });

    expect(result).toEqual({ active_locks: [], waiting: [] });
    expect(pool.statements.some((statement) => statement.includes('FROM agent_file_locks'))).toBe(true);
    expect(pool.statements.some((statement) => statement.includes('FROM agent_lock_waiters w'))).toBe(false);
  });

  it('continues reading waiters by default for existing queue consumers', async () => {
    const pool = fakePool();

    await readQueue(pool.sql, { coordinationDomain: 'test-domain' });

    expect(pool.statements.some((statement) => statement.includes('FROM agent_lock_waiters w'))).toBe(true);
  });

  it('reports pool acquisition, queue read, and transaction settlement as separate phases', async () => {
    const pool = fakePool();
    const phases: Array<{ phase: string; state: string; durationMs?: number }> = [];

    await readQueue(
      pool.sql,
      { coordinationDomain: 'test-domain', includeWaiting: false },
      { onPhase: (event) => phases.push(event) },
    );

    expect(phases.map(({ phase, state }) => `${phase}:${state}`)).toEqual([
      'pool-acquire-and-begin:start',
      'pool-acquire-and-begin:end',
      'readQueue:start',
      'readQueue:end',
      'transaction-settlement:start',
      'transaction-settlement:end',
    ]);
    expect(phases.filter(({ state }) => state === 'end').every(({ durationMs }) =>
      typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0,
    )).toBe(true);
  });
});
