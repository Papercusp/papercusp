import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  path.join(HERE, '..', 'sql', '1010-hosted-provider-delegation-metadata.sql'),
  'utf8',
);

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'hosteddelegation1010' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.workspace_host_connections (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      target TEXT NOT NULL,
      label TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
  `);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1010 — hosted provider delegation metadata', () => {
  it('is idempotent, defaults to an object, and rejects non-object metadata', async () => {
    await sql.unsafe(migration);
    await sql.unsafe(migration);
    await sql`
      INSERT INTO harness_shared.workspace_host_connections
        (workspace_id, id, target, label, credential_ref, status)
      VALUES
        ('ws-1010', 'connection-1', 'gcp', 'Hosted GCP',
         'resolver://workspace-1/gcp/generation-1', 'connected')
    `;
    const rows = await sql<Array<{ provider_config: Record<string, unknown> }>>`
      SELECT provider_config
      FROM harness_shared.workspace_host_connections
      WHERE workspace_id = 'ws-1010' AND id = 'connection-1'
    `;
    expect(rows).toEqual([{ provider_config: {} }]);
    await expect(sql`
      UPDATE harness_shared.workspace_host_connections
      SET provider_config = '[]'::jsonb
      WHERE workspace_id = 'ws-1010' AND id = 'connection-1'
    `).rejects.toThrow(/workspace_host_connections_provider_config_check/);
  });
});
