/**
 * EI-28957830517847385 / R-46: qualify the existing PostgreSQL statement log as
 * a prospective, SQL-independent evidence source. This capture-only fixture
 * loads the exact draft writer; it does not arm a migration or certify a live
 * interval, authenticated agent, production retention policy or complete schema.
 */
import { createHash } from 'node:crypto';
import { readFile, truncate } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshTestDb, startDedicatedNativePg, type DedicatedNativePg, type FreshTestDb } from '@papercusp/test-config/pg';

const DRAFT = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql', '1643-work-item-custody-audit-capture.sql.DRAFT');
const APPLICATION = 'r46-private-witness';
let cluster: DedicatedNativePg | undefined;
let db: FreshTestDb | undefined;
let sql: Sql;
let logPath: string;
let draftSha256: string;
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
  db = await createFreshTestDb({ prefix: 'custody-witness', provision: async url => {
    const client = postgres(url, { max: 1, onnotice: () => {} });
    try {
      // Minimal capture contract, deliberately not the full migrated schema.
      await client.unsafe(`CREATE SCHEMA harness_shared;
        CREATE TABLE harness_shared.work_items (
          workspace_id text NOT NULL, harness_slug text NOT NULL, feature_id text NOT NULL,
          taken_by text, payload jsonb NOT NULL DEFAULT '{}',
          PRIMARY KEY (workspace_id, harness_slug, feature_id));
        CREATE TABLE harness_shared.audit_log (
          id text PRIMARY KEY, ts bigint NOT NULL, actor text NOT NULL,
          action text NOT NULL, subject text NOT NULL, details jsonb NOT NULL, workspace_id text NOT NULL)`);
      await client.unsafe(draft);
    } finally { await client.end({ timeout: 5 }); }
  } });
  expect(new URL(db.url).port, 'createFreshTestDb must target the owned cluster').toBe(String(cluster.port));
  sql = postgres(db.url, { max: 1, onnotice: () => {}, connection: { application_name: APPLICATION } });
  logPath = join(cluster.dataDir, 'log', 'custody-witness.json');
  const [settings] = await sql`SELECT current_setting('log_statement') AS statements,
    current_setting('log_destination') AS destination, current_setting('logging_collector') AS collector`;
  expect(settings).toEqual({ statements: 'all', destination: 'jsonlog', collector: 'on' });
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
  await cluster?.stop();
  if (priorAdminUrl === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
  else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = priorAdminUrl;
  // Retain the actual independent source bytes in the normal test log before
  // the run-owned cluster is removed. These are synthetic private statements.
  const records = [...retained].join('\n');
  console.info('R46_PRIVATE_WITNESS_EVIDENCE', JSON.stringify({
    scope: 'private-capture-only; no historical, live-continuity or acceptance claim',
    draftSha256, logSha256: digest(records), records,
  }));
}, 30_000);

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
  await sql.unsafe(`INSERT INTO harness_shared.work_items VALUES ('private', 'custody-witness', '${id}', 'su-original', '{}')`);
}

async function receipts(id: string) {
  return sql`SELECT id, ts, actor, details FROM harness_shared.audit_log
    WHERE workspace_id = 'private' AND subject = ${id} ORDER BY ts, id`;
}

describe.sequential('R-46 private server-log witness controls', () => {
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
