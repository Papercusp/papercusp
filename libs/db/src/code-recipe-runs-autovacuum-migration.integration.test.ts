import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDedicatedNativePg } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL_PATH = path.join(HERE, '..', 'sql', '1630-code-recipe-runs-autovacuum-analyze.sql');
const MIGRATION_SQL = readFileSync(
  existsSync(MIGRATION_SQL_PATH) ? MIGRATION_SQL_PATH : MIGRATION_SQL_PATH + '.DRAFT',
  'utf8',
);

let pg: Awaited<ReturnType<typeof startDedicatedNativePg>> | undefined;
let sql: Sql | undefined;

beforeAll(async () => {
  pg = await startDedicatedNativePg();
  sql = postgres(pg.getConnectionUri(), { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.code_recipe_runs (id bigint PRIMARY KEY);
  `);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await pg?.stop().catch(() => {});
});

describe('migration 1630 — recipe receipt analyze policy', () => {
  it('sets the measured analyze thresholds, is replay-safe, and tolerates an absent table', async () => {
    const client = sql!;
    const readOptions = async () => {
      const [table] = await client<Array<{ reloptions: string[] | null }>>`
        SELECT reloptions
          FROM pg_class
         WHERE oid = 'harness_shared.code_recipe_runs'::regclass`;
      return table?.reloptions ?? [];
    };

    await client.unsafe(MIGRATION_SQL);
    expect(await readOptions()).toEqual(expect.arrayContaining([
      'autovacuum_analyze_scale_factor=0.02',
      'autovacuum_analyze_threshold=10000',
    ]));
    expect(await readOptions()).toHaveLength(2);

    await expect(client.unsafe(MIGRATION_SQL)).resolves.toBeDefined();
    expect(await readOptions()).toEqual(expect.arrayContaining([
      'autovacuum_analyze_scale_factor=0.02',
      'autovacuum_analyze_threshold=10000',
    ]));

    await client.unsafe('DROP TABLE harness_shared.code_recipe_runs');
    await expect(client.unsafe(MIGRATION_SQL)).resolves.toBeDefined();
  });
});
