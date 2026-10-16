import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDedicatedNativePg } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(HERE, '..', 'sql', '1437-reassert-pg-read-all-stats-harness-admin.sql');
const draftPath = `${migrationPath}.DRAFT`;
const migration = readFileSync(existsSync(migrationPath) ? migrationPath : draftPath, 'utf8');

let pg: Awaited<ReturnType<typeof startDedicatedNativePg>> | undefined;
let sql: Sql | undefined;

beforeAll(async () => {
  // Role membership is cluster-wide, so this suite needs its own cluster.
  // Use the maintained native fixture: allocating a Docker container is an
  // unrelated, unbounded-before-readiness dependency for this single GRANT.
  pg = await startDedicatedNativePg();
  sql = postgres(pg.getConnectionUri(), { max: 1, onnotice: () => {} });
  await sql.unsafe('CREATE ROLE harness_admin NOLOGIN');
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await pg?.stop().catch(() => {});
});

describe('migration 1437 — pg_read_all_stats grant repair', () => {
  it('repairs a missing membership and is safe to replay', async () => {
    const client = sql!;
    const [before] = await client<Array<{ member: boolean }>>`
      SELECT pg_has_role('harness_admin', 'pg_read_all_stats', 'MEMBER') AS member`;
    expect(before?.member).toBe(false);

    await client.unsafe(migration);
    const [after] = await client<Array<{ member: boolean }>>`
      SELECT pg_has_role('harness_admin', 'pg_read_all_stats', 'MEMBER') AS member`;
    expect(after?.member).toBe(true);

    await expect(client.unsafe(migration)).resolves.toBeDefined();
  });
});
