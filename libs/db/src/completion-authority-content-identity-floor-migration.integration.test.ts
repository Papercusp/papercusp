/**
 * Migration 972 — EI-21502635666260946: below-deploy-boundary enforcement of the
 * completion content-identity floor.
 *
 * While the release gate freezes an older build live (:3070 kept serving
 * 6760f8ec31 for ~2.3 days past guard commit ab2adad4f4), work_items:complete on
 * the OLD build can mint `authority='committed'` closes whose persisted
 * `_completionEvidence` carries no provable `treeStamp.contentIdentity` — the
 * exact shape the current source downgrades to `proposed`. These triggers give
 * the DATABASE the same floor, so every writer (any build, any route) is policed.
 *
 * Falsifiability: both directions are asserted. Every DOWNGRADE case names a
 * distinct unproven shape; every KEEPS-committed case (proven identity, empty
 * filesChanged, no evidence surface, unrelated update of a legacy row) would fail
 * a trigger that downgraded indiscriminately or rewrote history retroactively.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(filename: string): string {
  const armed = path.join(HERE, '..', 'sql', filename);
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration not found at ${armed}[.DRAFT]`);
}

const migration972Sql = readFileSync(
  migrationPath('972-completion-authority-content-identity-floor.sql'),
  'utf8',
);

/**
 * The real migration runner speaks psql, so migration files may carry psql
 * meta-commands (`\set ON_ERROR_STOP on`). postgres.js — even via the simple
 * query protocol — sends text to the server verbatim and `\` is a syntax
 * error there. Strip meta-command lines; BEGIN/COMMIT are real SQL and stay.
 */
async function applyMigrationFile(raw: string): Promise<unknown> {
  const serverSql = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('\\'))
    .join('\n');
  const results = (await sql.unsafe(serverSql).simple()) as { command?: string }[];
  lastBatchCommands = JSON.stringify(results.map((r) => r?.command ?? '?'));
  // The simple protocol returns ONE result per top-level statement: BEGIN,
  // 2×CREATE FUNCTION, 2×COMMENT, DROP TRIGGER, CREATE TRIGGER, COMMIT.
  expect(lastBatchCommands).toEqual(
    JSON.stringify([
      'BEGIN',
      'CREATE FUNCTION',
      'COMMENT',
      'CREATE FUNCTION',
      'COMMENT',
      'DROP TRIGGER',
      'CREATE TRIGGER',
      'COMMIT',
    ]),
  );
  return results;
}

let db: MigratedTestDb;
let sql: Sql;
/** Server NOTICE/WARNING lines — the floor trigger announces every downgrade. */
let notices: string[] = [];
/** Command tags the migration batch reported — surfaced in precondition failures. */
let lastBatchCommands = '[]';

/** Minimal stand-in for harness_shared.work_items: just the columns the trigger reads/writes. */
async function createWorkItemsFixture(): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL DEFAULT 'papercusp-workspace',
      harness_slug text NOT NULL DEFAULT 'papercusp',
      feature_id   text,
      item_kind    text NOT NULL DEFAULT 'feature',
      status       text,
      taken_by     text,
      authority    text,
      payload      jsonb,
      updated_ts   bigint
    )`);
}

async function seedOpenItem(id: string, payload: Record<string, unknown> = {}): Promise<void> {
  await sql.unsafe(
    `INSERT INTO harness_shared.work_items (feature_id, status, authority, payload)
     VALUES ($1, 'wip', NULL, $2::jsonb)`,
    [id, JSON.stringify(payload)],
  );
}

/** Simulate the close write a frozen pre-guard build performs. */
async function closeAsCommitted(id: string, evidence: Record<string, unknown>): Promise<'committed' | 'proposed'> {
  await sql.unsafe(
    `UPDATE harness_shared.work_items
        SET status = 'done',
            authority = 'committed',
            payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('_completionEvidence', $2::jsonb)
      WHERE feature_id = $1`,
    [id, JSON.stringify(evidence)],
  );
  const rows = await sql.unsafe<{ authority: string }>(
    `SELECT authority FROM harness_shared.work_items WHERE feature_id = $1`,
    [id],
  );
  return rows[0].authority as 'committed' | 'proposed';
}

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA_B = '0000111122223333444455556666777788889999';

function evidenceWith(identity: unknown, filesChanged: string[] = ['src/fix.ts']) {
  return {
    summary: 'verified',
    filesChanged,
    treeStamp: { repositoryRoot: '/repo', headSha: SHA_A, ...(identity === undefined ? {} : { contentIdentity: identity }) },
  };
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'floor972' });
  sql = postgres(db.url, {
    max: 1,
    onnotice: (n) => {
      notices.push(typeof n === 'string' ? n : (n.message ?? String(n)));
    },
  });
  await sql.unsafe('CREATE SCHEMA harness_shared');
  await createWorkItemsFixture();
  // A silently-absent or disabled trigger would make every keep-case below pass
  // vacuously, so the definition itself is part of the precondition. The probe
  // dumps unqualified ground truth so a mis-targeted DDL cannot hide behind an
  // empty filtered result, and carries the batch's own command tags.
  const [probe] = await sql<{
    db: string;
    triggers: { tgname: string; tbl: string; sch: string; tgenabled: string }[];
    fns: string[];
    relkind: string;
  }[]>`
    SELECT current_database() AS db,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object('tgname', t.tgname,
                                             'tbl', c.relname,
                                             'sch', n.nspname,
                                             'tgenabled', t.tgenabled))
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE t.tgname LIKE 'completion%'),
        '[]'::jsonb) AS triggers,
      COALESCE(
        (SELECT jsonb_agg(proname::text) FROM pg_proc
          WHERE proname LIKE '%content_identity%' OR proname LIKE '%unproven%'),
        '[]'::jsonb) AS fns,
      (SELECT relkind::text FROM pg_class
        WHERE oid = 'harness_shared.work_items'::regclass) AS relkind`;
  expect(
    probe.triggers.map((t) => t.tgname),
    `db=${probe.db} relkind=${probe.relkind} probes=${JSON.stringify(probe)} notices=${JSON.stringify(notices)} lastBatchCommands=${lastBatchCommands}`,
  ).toContain('completion_authority_floor_trg');
  expect(probe.fns.sort()).toEqual([
    'completion_content_identity_proven',
    'downgrade_unproven_committed_close',
  ]);
  expect(probe.relkind).toBe('r');
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 972 — completion authority content-identity floor', () => {
  it('downgrades a frozen-build close whose evidence has NO contentIdentity (the WI-41491 shape)', async () => {
    notices.length = 0;
    await seedOpenItem('WI-CASE-MISSING');
    const observed = await closeAsCommitted('WI-CASE-MISSING', evidenceWith(undefined));
    // The trigger announces every downgrade; assert the announcement FIRST so a
    // silent pass-through ("never fired") is distinguishable from a lost write.
    expect(notices.join('\n'), `server notices: ${JSON.stringify(notices)}`).toMatch(
      /downgraded committed->proposed/,
    );
    expect(observed).toBe('proposed');
  });

  it('downgrades null-blob, mismatched-blob, and empty-array identities', async () => {
    await seedOpenItem('WI-CASE-NULLBLOB');
    expect(await closeAsCommitted('WI-CASE-NULLBLOB', evidenceWith([
      { path: 'src/fix.ts', workingTreeBlobSha: SHA_A, headBlobSha: null },
    ]))).toBe('proposed');

    await seedOpenItem('WI-CASE-MISMATCH');
    expect(await closeAsCommitted('WI-CASE-MISMATCH', evidenceWith([
      { path: 'src/fix.ts', workingTreeBlobSha: SHA_B, headBlobSha: SHA_A },
    ]))).toBe('proposed');

    await seedOpenItem('WI-CASE-EMPTY');
    expect(await closeAsCommitted('WI-CASE-EMPTY', evidenceWith([]))).toBe('proposed');
  });

  it('keeps committed when every declared path proves blob equality', async () => {
    await seedOpenItem('WI-CASE-PROVEN');
    expect(await closeAsCommitted('WI-CASE-PROVEN', evidenceWith([
      { path: 'src/fix.ts', workingTreeBlobSha: SHA_A, headBlobSha: SHA_A },
      { path: 'src/other.ts', workingTreeBlobSha: SHA_B, headBlobSha: SHA_B },
    ], ['src/fix.ts', 'src/other.ts']))).toBe('committed');
  });

  it('leaves closes without the done-route evidence surface or with no declared paths alone', async () => {
    // No _completionEvidence at all (e.g. dropped-route or legacy shape).
    await seedOpenItem('WI-CASE-NOEV');
    expect(await closeAsCommitted('WI-CASE-NOEV', { summary: 'narrative only' })).toBe('committed');

    // Evidence present but filesChanged empty — mirrors the TS length gate.
    await seedOpenItem('WI-CASE-NOPATHS');
    expect(await closeAsCommitted('WI-CASE-NOPATHS', evidenceWith(undefined, []))).toBe('committed');
  });

  it('is never retroactive: an unrelated update of a pre-existing committed row keeps its stored authority', async () => {
    await seedOpenItem('WI-CASE-LEGACY');
    // Seed through the trigger with the evidence surface absent, then strip the
    // surface so the row looks like a pre-fix historical close.
    await sql.unsafe(
      `UPDATE harness_shared.work_items
          SET status = 'done', authority = 'committed', payload = '{}'::jsonb
        WHERE feature_id = 'WI-CASE-LEGACY'`,
    );
    // Unrelated column touch, payload unchanged: must NOT rewrite history.
    await sql.unsafe(
      `UPDATE harness_shared.work_items SET taken_by = 'su-someone' WHERE feature_id = 'WI-CASE-LEGACY'`,
    );
    const rows = await sql.unsafe<{ authority: string }>(
      `SELECT authority FROM harness_shared.work_items WHERE feature_id = 'WI-CASE-LEGACY'`,
    );
    expect(rows[0].authority).toBe('committed');

    // But a RE-ASSERTED payload (the writer touched the evidence again) is held
    // to the floor even though authority itself did not transition.
    await sql.unsafe(
      `UPDATE harness_shared.work_items
          SET payload = jsonb_build_object('_completionEvidence', $1::jsonb)
        WHERE feature_id = 'WI-CASE-LEGACY'`,
      [JSON.stringify(evidenceWith(undefined))],
    );
    const after = await sql.unsafe<{ authority: string }>(
      `SELECT authority FROM harness_shared.work_items WHERE feature_id = 'WI-CASE-LEGACY'`,
    );
    expect(after[0].authority).toBe('proposed');
  });

  it('polices direct INSERTs claiming committed too', async () => {
    await sql.unsafe(
      `INSERT INTO harness_shared.work_items (feature_id, status, authority, payload)
       VALUES ('WI-CASE-INSERT', 'done', 'committed', jsonb_build_object('_completionEvidence', $1::jsonb))`,
      [JSON.stringify(evidenceWith(undefined))],
    );
    const rows = await sql.unsafe<{ authority: string }>(
      `SELECT authority FROM harness_shared.work_items WHERE feature_id = 'WI-CASE-INSERT'`,
    );
    expect(rows[0].authority).toBe('proposed');
  });

  it('re-applies idempotently', async () => {
    await expect(applyMigrationFile(migration972Sql)).resolves.toBeDefined();
  });
});
