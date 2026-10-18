/**
 * su-lock-store.test.ts — migration-source resolution for lazy lock bootstrap.
 *
 * Run: cd libs/papercusp/packages/locks && npx vitest run src/su-lock-store.test.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readQueue, resolveLocksSqlDir, tryAcquire, tryHeartbeat } from './su-lock-store';
import { tryHeartbeatResource } from './resource-lock-store';

const roots: string[] = [];

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
      if (statement.includes('SELECT path, owner, owner_label, intent, expires_ts FROM agent_file_locks')) {
        return [{
          path: 'src/contended.ts',
          owner: 'active-holder',
          owner_label: 'Active holder',
          intent: 'write file',
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
        expires_ts: holderExpires,
      }],
    });
    expect(statements.some((statement) => statement.includes('FROM agent_lock_waiters w'))).toBe(true);
    expect(statements.some((statement) => statement.includes('SELECT path, owner, owner_label, intent, expires_ts FROM agent_file_locks'))).toBe(true);
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
      return query.startsWith('UPDATE') ? [{ expires_ts: expires }] : [];
    }) as unknown as Parameters<typeof tryHeartbeat>[0];

    await expect(heartbeat(tx, 'domain', 'owner', 'lock-id', 120))
      .resolves.toEqual({ extended: true, expires_ts: expires });
  });
});

describe('readQueue', () => {
  function fakePool() {
    const statements: string[] = [];
    const sql = Object.assign(
      (strings: TemplateStringsArray) => {
        statements.push(strings.join(' '));
        return Promise.resolve([]);
      },
      { begin: async (run: (tx: unknown) => Promise<unknown>) => run(sql) },
    );
    return { sql: sql as never, statements };
  }

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
