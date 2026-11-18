/**
 * EI-28957830517847385 / R-46: qualify the existing PostgreSQL statement log as
 * a prospective, SQL-independent evidence source. This capture-only fixture
 * loads the exact draft writer over the maintained migrated private schema. It
 * does not arm a migration or certify a live interval, authenticated agent or
 * production retention policy. Owned-schema fingerprints retain their explicit
 * unknown connection-population boundary.
 */
import { createHash } from 'node:crypto';
import { readFile, truncate } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureOwnedDatabaseSchema, createFreshTestDb, startDedicatedNativePg, type DedicatedNativePg, type FreshTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(HERE, '..', 'sql');
const DRAFT = join(SQL_DIR, '1643-work-item-custody-audit-capture.sql.DRAFT');
const RUNNER = join(HERE, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');
// Reuse the full-schema prerequisite/replay order from worked-by-history. 797
// remains parked in production; 1037 must follow 806 to preserve first_claimed_at.
const REPLAY = [
  '797-guard-engineer-issues-terminal-state.sql.PENDING-CODE-DEPLOY',
  '799-guard-797-message-self-diagnosis.sql',
  '804-fix-terminal-close-staging-remedy.sql',
  '806-work-item-worked-history.sql',
  '1037-work-item-first-claim-stamp.sql',
];
const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app') THEN CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero') THEN CREATE ROLE harness_zero LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;
const APPLICATION = 'r46-private-witness';
let cluster: DedicatedNativePg | undefined;
let db: FreshTestDb | undefined;
let sql: Sql;
let logPath: string;
let draftSha256: string;
let schemaBefore: Awaited<ReturnType<typeof captureOwnedDatabaseSchema>>;
let runtime: Record<string, unknown> | undefined;
let appliedMigrations: Array<{ filename: string; sha256: string }> = [];
const sourceDigests = new Map<string, string>();
let fenceNumber = 0;
const retained = new Set<string>();
const priorAdminUrl = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;

type LogRecord = { application_name?: string; message?: string; session_id?: string; vxid?: string; txid?: number };
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

beforeAll(async () => {
  // Server startup settings, not session assertions. No shared server is altered.
  cluster = await startDedicatedNativePg({ settings: {
    logging_collector: 'on', log_destination: 'jsonlog',
    log_filename: 'custody-witness.log', log_rotation_age: '0', log_rotation_size: '0',
    log_statement: 'all', log_min_messages: 'log',
  } });
  process.env.PAPERCUSP_TEST_PG_ADMIN_URL = cluster.getConnectionUri();
  const draft = await readFile(DRAFT, 'utf8');
  draftSha256 = digest(draft);
  for (const path of [fileURLToPath(import.meta.url), RUNNER, DRAFT]) {
    sourceDigests.set(path, digest(await readFile(path)));
  }
  db = await createFreshTestDb({ prefix: 'custody-witness', provision: async url => {
    const client = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await client.unsafe(BOOT_PREREQS_DDL);
      const { applyPendingMigrations } = await import(pathToFileURL(RUNNER).href) as {
        applyPendingMigrations: (options: { client: Sql; sqlDir: string;
          migrationStatementTimeoutMs: number; beforeApply: (file: string, raw: string) => void;
        }) => Promise<{ appliedCount: number; totalKnown: number }>;
      };
      const result = await applyPendingMigrations({ client, sqlDir: SQL_DIR,
        migrationStatementTimeoutMs: 30_000,
        beforeApply: (file, raw) => { sourceDigests.set(join(SQL_DIR, file), digest(raw)); },
      });
      expect(result.appliedCount).toBe(result.totalKnown);
      expect(result.totalKnown).toBeGreaterThan(0);
      appliedMigrations = (await client<{ filename: string; sha256: string }[]>`
        SELECT filename, sha256 FROM harness_shared.schema_migrations ORDER BY filename`)
        .map(row => ({ filename: row.filename, sha256: row.sha256 }));
      expect(appliedMigrations).toHaveLength(result.totalKnown);
      expect(appliedMigrations.some(row => row.filename.startsWith('1643-'))).toBe(false);
      for (const row of appliedMigrations) {
        expect(row.sha256).toBe(sourceDigests.get(join(SQL_DIR, row.filename)));
      }
      for (const file of REPLAY) {
        const raw = await readFile(join(SQL_DIR, file), 'utf8');
        sourceDigests.set(join(SQL_DIR, file), digest(raw));
        await client.unsafe(raw);
      }
      await client.unsafe(draft);
    } finally { await client.end({ timeout: 5 }); }
  } });
  expect(new URL(db.url).port, 'createFreshTestDb must target the owned cluster').toBe(String(cluster.port));
  sql = postgres(db.url, { max: 1, onnotice: () => {}, connection: { application_name: APPLICATION } });
  logPath = join(cluster.dataDir, 'log', 'custody-witness.json');
  const [settings] = await sql`SELECT current_setting('log_statement') AS statements,
    current_setting('log_destination') AS destination, current_setting('logging_collector') AS collector`;
  expect(settings).toEqual({ statements: 'all', destination: 'jsonlog', collector: 'on' });
  [runtime] = await sql`SELECT current_database() AS database, current_user AS role,
    current_setting('server_version_num') AS server_version_num,
    inet_server_addr()::text AS address, inet_server_port() AS port,
    pg_postmaster_start_time()::text AS started_at`;
  schemaBefore = await captureOwnedDatabaseSchema(db.url);
  expect(schemaBefore).not.toBeNull();
}, 240_000);

afterAll(async () => {
  let schemaAfter: typeof schemaBefore = null;
  try {
    if (db && schemaBefore) {
      schemaAfter = await captureOwnedDatabaseSchema(db.url);
      expect(schemaAfter).toEqual(schemaBefore);
      for (const [path, expected] of sourceDigests) {
        expect(digest(await readFile(path)), `source changed during private run: ${path}`).toBe(expected);
      }
    }
  } finally {
    try {
      await sql?.end({ timeout: 5 });
      await db?.drop();
    } finally {
      await cluster?.stop();
      if (priorAdminUrl === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
      else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = priorAdminUrl;
      // Synthetic private statements only; the schema helper emits digests,
      // never role credentials or dump SQL. This is local fixture evidence.
      const records = [...retained].join('\n');
      console.info('R46_PRIVATE_WITNESS_EVIDENCE', JSON.stringify({
        scope: 'private-migrated-schema; no historical, live-continuity or acceptance claim',
        draftSha256, bootstrapSha256: digest(BOOT_PREREQS_DDL), runtime,
        schemaBefore, schemaAfter, replay: REPLAY, appliedMigrations,
        sourceDigests: Object.fromEntries(sourceDigests), logSha256: digest(records), records,
      }));
    }
  }
}, 60_000);

async function fence(): Promise<{ bytes: Buffer; records: LogRecord[] }> {
  const marker = `r46-fence-${++fenceNumber}`;
  await sql.unsafe(`SELECT '${marker}'`);
  // The collector is asynchronous. A SQL return does not mean its log is flushed.
  await expect.poll(async () => (await readFile(logPath, 'utf8')).includes(marker), { timeout: 10_000 }).toBe(true);
  const bytes = await readFile(logPath);
  const complete = bytes.toString('utf8').split('\n').slice(0, -1);
  const records = complete.map(line => JSON.parse(line) as LogRecord)
    .filter(record => record.application_name === APPLICATION);
  for (const line of complete) {
    if ((JSON.parse(line) as LogRecord).application_name === APPLICATION) retained.add(line);
  }
  return { bytes, records };
}

async function seed(id: string): Promise<void> {
  await sql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, taken_by, payload)
    VALUES ('private', 'custody-witness', ${id}, ${id}, 'private witness control', 'open', 'feature', 'local', 'su-original', '{}')`;
}

async function receipts(id: string) {
  return sql`SELECT id, ts, actor, details FROM harness_shared.audit_log
    WHERE workspace_id = 'private' AND subject = ${id} ORDER BY ts, id`;
}

describe.sequential('R-46 private server-log witness controls', () => {
  it('qualifies the migrated writer schema and detects a disabled trigger with equal restored endpoints', async () => {
    const columns = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'harness_shared' AND table_name = 'work_items'`;
    expect(columns.map(row => row.column_name)).toEqual(expect.arrayContaining([
      'status', 'worked_by_history', 'first_claimed_at', 'origin', 'fed_ts',
    ]));
    expect(schemaBefore?.populationStatus).toBe('unknown');
    await sql.unsafe('ALTER TABLE harness_shared.work_items DISABLE TRIGGER capture_work_item_custody_audit_trg');
    try {
      const disabled = await captureOwnedDatabaseSchema(db!.url);
      expect(disabled).not.toBeNull();
      expect(disabled?.fingerprint).not.toBe(schemaBefore?.fingerprint);
    } finally { await sql.unsafe('ALTER TABLE harness_shared.work_items ENABLE TRIGGER capture_work_item_custody_audit_trg'); }
    expect(await captureOwnedDatabaseSchema(db!.url)).toEqual(schemaBefore);
  }, 60_000);

  it('retains more than five committed mutations outside the mutable receipt store', async () => {
    const id = 'WI-witness-positive';
    await seed(id);
    await sql.begin(async tx => {
      for (let i = 0; i < 7; i += 1) {
        await tx.unsafe(`UPDATE harness_shared.work_items SET taken_by = 'su-step-${i}' WHERE feature_id = '${id}'`);
      }
    });
    expect(await receipts(id)).toHaveLength(8);
    const { records } = await fence();
    expect(records.filter(row => row.message?.includes(`WHERE feature_id = '${id}'`))).toHaveLength(7);
    expect(records.some(row => /\bcommit\b/i.test(row.message ?? '') && row.session_id && row.vxid)).toBe(true);
  });

  it('records a disabled/restored capture interval despite equal enabled endpoints and receipt rows', async () => {
    const id = 'WI-witness-trigger';
    await seed(id);
    const before = await receipts(id);
    const trigger = () => sql`SELECT tgenabled, pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid = 'harness_shared.work_items'::regclass AND tgname = 'capture_work_item_custody_audit_trg'`;
    const enabled = await trigger();
    await sql.unsafe('ALTER TABLE harness_shared.work_items DISABLE TRIGGER capture_work_item_custody_audit_trg');
    try {
      await sql.unsafe(`UPDATE harness_shared.work_items SET taken_by = 'su-other' WHERE feature_id = '${id}'`);
      await sql.unsafe(`UPDATE harness_shared.work_items SET taken_by = 'su-original' WHERE feature_id = '${id}'`);
    } finally { await sql.unsafe('ALTER TABLE harness_shared.work_items ENABLE TRIGGER capture_work_item_custody_audit_trg'); }
    expect(await trigger()).toEqual(enabled);
    expect(await receipts(id)).toEqual(before);
    const { records } = await fence();
    expect(records.some(row => row.message?.includes('DISABLE TRIGGER capture_work_item_custody_audit_trg'))).toBe(true);
    expect(records.filter(row => row.message?.includes(`WHERE feature_id = '${id}'`))).toHaveLength(2);
  });

  it('records function replacement and restoration although the original definition and receipts return', async () => {
    const id = 'WI-witness-function';
    await seed(id);
    const before = await receipts(id);
    const definition = async () => (await sql`SELECT pg_get_functiondef('harness_shared.capture_work_item_custody_audit()'::regprocedure) AS body`)[0]!.body as string;
    const original = await definition();
    await sql.unsafe(`CREATE OR REPLACE FUNCTION harness_shared.capture_work_item_custody_audit()
      RETURNS trigger LANGUAGE plpgsql AS $gap$ BEGIN RETURN NULL; END; $gap$`);
    try { await sql.unsafe(`UPDATE harness_shared.work_items SET taken_by = 'su-hidden' WHERE feature_id = '${id}'`); }
    finally { await sql.unsafe(original); }
    expect(await definition()).toBe(original);
    expect(await receipts(id)).toEqual(before);
    const { records } = await fence();
    expect(records.some(row => row.message?.includes('$gap$ BEGIN RETURN NULL; END; $gap$'))).toBe(true);
  });

  it('records audit receipt tampering and restoration outside the restored rows', async () => {
    const id = 'WI-witness-tamper';
    await seed(id);
    const before = await receipts(id);
    await sql.unsafe(`UPDATE harness_shared.audit_log SET actor = 'database:forged' WHERE subject = '${id}'`);
    await sql.unsafe(`UPDATE harness_shared.audit_log SET actor = 'database:postgres' WHERE subject = '${id}'`);
    expect(await receipts(id)).toEqual(before);
    const { records } = await fence();
    expect(records.some(row => row.message?.includes("SET actor = 'database:forged'"))).toBe(true);
  });

  it('retains each deletion batch after the mutable audit prefix is gone', async () => {
    const id = 'WI-witness-retention';
    await seed(id);
    for (let i = 0; i < 7; i += 1) {
      await sql.unsafe(`UPDATE harness_shared.work_items SET taken_by = 'su-retained-${i}' WHERE feature_id = '${id}'`);
    }
    const before = await receipts(id);
    expect(before).toHaveLength(8);
    for (let i = 0; i < 3; i += 1) {
      const removed = await sql.unsafe(`DELETE FROM harness_shared.audit_log WHERE id IN
        (SELECT id FROM harness_shared.audit_log WHERE subject = '${id}' ORDER BY ts, id LIMIT 3) RETURNING id`);
      expect(removed.length).toBe(i === 2 ? 2 : 3);
    }
    expect(await receipts(id)).toHaveLength(0);
    const { records } = await fence();
    expect(records.filter(row => row.message?.includes('DELETE FROM harness_shared.audit_log WHERE id IN')
      && row.message.includes(`subject = '${id}'`))).toHaveLength(3);
  });

  it('exposes logging suppression as an invalidating boundary even when logging later resumes', async () => {
    const id = 'WI-witness-suppressed';
    await seed(id);
    await sql.unsafe("SET log_statement = 'none'");
    try { await sql.unsafe(`UPDATE harness_shared.work_items SET taken_by = 'su-unlogged' WHERE feature_id = '${id}'`); }
    finally { await sql.unsafe("SET log_statement = 'all'"); }
    const { records } = await fence();
    expect(records.some(row => row.message?.includes("SET log_statement = 'none'"))).toBe(true);
    expect(records.some(row => row.message?.includes(`WHERE feature_id = '${id}'`))).toBe(false);
    expect((await receipts(id)).at(-1)?.details.after.taken_by).toBe('su-unlogged');
    // The resumed fence is not continuity. A consumer must reject the interval
    // containing this configuration boundary, not report a verified zero.
  });

  it('detects server-log prefix loss instead of accepting the readable resumed suffix', async () => {
    const before = await fence();
    expect(before.bytes.length).toBeGreaterThan(0);
    // Only this run-owned cluster's log is truncated; retained bytes remain in
    // the independent test process and are emitted into its maintained run log.
    await truncate(logPath, 0);
    const after = await fence();
    expect(after.bytes.subarray(0, before.bytes.length).equals(before.bytes)).toBe(false);
    expect(digest(after.bytes)).not.toBe(digest(before.bytes));
  });
});
