import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

// Databases are isolated; pg_authid is shared across their cluster. Exercise the
// real migration block with unique role names so no other fixture is modified.
const prefix = `zz_hosted_${randomBytes(6).toString('hex')}`;
const roles = ['owner', 'app', 'service'].map((suffix) => `${prefix}_${suffix}`);
const migration = readFileSync(new URL('../sql/978-hosted-customer-rls.sql', import.meta.url), 'utf8');
const roleBlock = migration.match(/DO \$hosted_roles\$[\s\S]*?\$hosted_roles\$;/)![0]
  .replaceAll('hosted_owner', roles[0])
  .replaceAll('hosted_app', roles[1])
  .replaceAll('hosted_service', roles[2]);
let databases: MigratedTestDb[] = [];
let clients: Sql[] = [];

beforeAll(async () => {
  databases = await Promise.all([createFreshTestDb({ prefix: 'rolea' }), createFreshTestDb({ prefix: 'roleb' })]);
  clients = databases.map((db) => postgres(db.url, { max: 1, onnotice: () => {} }));
  await clients[0].unsafe(roleBlock);
});

afterAll(async () => {
  for (const role of roles) await clients[0]?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
  await Promise.all(databases.map((db) => db.drop()));
});

it('normalizes hosted roles while another database commits a role change', async () => {
  const [writer, migrator] = clients;
  const [{ pid }] = await migrator<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let ready!: () => void;
  const writerReady = new Promise<void>((resolve) => { ready = resolve; });
  const writing = writer.begin(async (tx) => {
    await tx.unsafe(`ALTER ROLE ${roles[0]} LOGIN`);
    ready();
    await released;
  });
  await writerReady;
  const applying = migrator.unsafe(roleBlock).then(() => null, (error: unknown) => error);
  try {
    // Wait for a measured lock conflict, not a timing-dependent simultaneous call.
    // The observer uses another connection because writer owns an open transaction.
    const observer = postgres(databases[0].url, { max: 1, onnotice: () => {} });
    try {
      const deadline = Date.now() + 10_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const rows = await observer<{ waiting: boolean }[]>`
          SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${pid}`;
        waiting = rows[0]?.waiting === true;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting, 'second database must reach the shared role catalog conflict').toBe(true);
    } finally {
      await observer.end({ timeout: 5 });
    }
  } finally {
    release();
    await writing;
  }
  const failure = await applying;
  expect(failure, String(failure)).toBeNull();
  const normalized = await writer<{ safe: boolean }[]>`
    SELECT NOT (rolsuper OR rolbypassrls OR rolreplication OR rolcanlogin
      OR rolcreatedb OR rolcreaterole OR rolinherit) AS safe
    FROM pg_roles WHERE rolname IN ${writer(roles)}`;
  expect(normalized).toHaveLength(3);
  expect(normalized.every((role) => role.safe)).toBe(true);
});
