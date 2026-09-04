/**
 * Migration 1110 — materialized work-item admission flags.
 *
 * Executes the real migration against a deliberately pre-1110 view so the test proves the
 * columns are added, generated from payload, exposed through engineer_issues, and leave the
 * view's INSTEAD OF trigger attached. The existing issue-admissible branch-equivalence suite
 * separately proves these physical booleans preserve the admission result for true, false,
 * missing, and legacy needsHuman payloads.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '1110-work-items-admission-flags-generated-columns.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 1110 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'workitemflags1110' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql
    .unsafe(
      `
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL DEFAULT 'default',
      harness_slug text NOT NULL DEFAULT 'papercusp',
      feature_id text PRIMARY KEY,
      item_kind text NOT NULL DEFAULT 'bug',
      payload jsonb
    );
    CREATE VIEW harness_shared.engineer_issues AS
      SELECT workspace_id, harness_slug, feature_id AS issue_id, item_kind AS kind, payload
        FROM harness_shared.work_items
       WHERE item_kind IN ('bug', 'change', 'task');
    CREATE FUNCTION harness_shared.engineer_issues_view_dml() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END
      $fn$;
    CREATE TRIGGER engineer_issues_view_dml_trg
      INSTEAD OF INSERT OR UPDATE OR DELETE ON harness_shared.engineer_issues
      FOR EACH ROW EXECUTE FUNCTION harness_shared.engineer_issues_view_dml();
    INSERT INTO harness_shared.work_items (feature_id, payload) VALUES
      ('WI-NULL', NULL),
      ('WI-EMPTY', '{}'::jsonb),
      ('WI-HOLD-BOOL', '{"_claimHold": true}'::jsonb),
      ('WI-HOLD-TEXT', '{"_claimHold": "true"}'::jsonb),
      ('WI-OWNER-BOOL', '{"needsOwnerAction": true}'::jsonb),
      ('WI-OWNER-TEXT', '{"needsOwnerAction": "true"}'::jsonb),
      ('WI-FALSE', '{"_claimHold": false, "needsOwnerAction": false}'::jsonb),
      ('WI-LEGACY', '{"needsHuman": true}'::jsonb);
  `,
    )
    .simple();
  await sql.unsafe(migrationSql).simple();
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1110 — work-item admission generated columns', () => {
  it('adds two boolean ALWAYS-generated columns with the intended payload expressions', async () => {
    const columns = await sql<
      {
        column_name: string;
        data_type: string;
        is_generated: string;
        generation_expression: string | null;
      }[]
    >`
      SELECT column_name, data_type, is_generated, generation_expression
        FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name = 'work_items'
         AND column_name IN ('claim_hold', 'needs_owner_action')
       ORDER BY column_name`;

    expect(columns).toHaveLength(2);
    expect(columns.every((column) => column.data_type === 'boolean')).toBe(true);
    expect(columns.every((column) => column.is_generated === 'ALWAYS')).toBe(true);
    expect(columns.find((column) => column.column_name === 'claim_hold')?.generation_expression).toContain(
      '_claimHold',
    );
    expect(columns.find((column) => column.column_name === 'needs_owner_action')?.generation_expression).toContain(
      'needsOwnerAction',
    );
  });

  it('preserves the old text-comparison semantics and exposes them through engineer_issues', async () => {
    const rows = await sql<
      {
        issue_id: string;
        claim_hold: boolean | null;
        needs_owner_action: boolean | null;
      }[]
    >`
      SELECT issue_id, claim_hold, needs_owner_action
        FROM harness_shared.engineer_issues
       ORDER BY issue_id`;

    expect(rows).toEqual([
      { issue_id: 'WI-EMPTY', claim_hold: null, needs_owner_action: null },
      { issue_id: 'WI-FALSE', claim_hold: false, needs_owner_action: false },
      { issue_id: 'WI-HOLD-BOOL', claim_hold: true, needs_owner_action: null },
      { issue_id: 'WI-HOLD-TEXT', claim_hold: true, needs_owner_action: null },
      { issue_id: 'WI-LEGACY', claim_hold: null, needs_owner_action: null },
      { issue_id: 'WI-NULL', claim_hold: null, needs_owner_action: null },
      { issue_id: 'WI-OWNER-BOOL', claim_hold: null, needs_owner_action: true },
      { issue_id: 'WI-OWNER-TEXT', claim_hold: null, needs_owner_action: true },
    ]);

    await sql`
      UPDATE harness_shared.work_items
         SET payload = '{"_claimHold": true, "needsOwnerAction": true}'::jsonb
       WHERE feature_id = 'WI-EMPTY'`;
    const [updated] = await sql<{ claim_hold: boolean; needs_owner_action: boolean }[]>`
      SELECT claim_hold, needs_owner_action
        FROM harness_shared.engineer_issues
       WHERE issue_id = 'WI-EMPTY'`;
    expect(updated).toEqual({ claim_hold: true, needs_owner_action: true });
  });

  it('keeps the view trigger attached, refuses direct generated-column writes, and is idempotent', async () => {
    await expect(sql`
      UPDATE harness_shared.work_items SET claim_hold = false WHERE feature_id = 'WI-HOLD-BOOL'
    `).rejects.toThrow(/generated|cannot update|only be updated to DEFAULT/i);

    await sql.unsafe(migrationSql).simple();

    const [trigger] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared'
         AND c.relname = 'engineer_issues'
         AND t.tgname = 'engineer_issues_view_dml_trg'
         AND NOT t.tgisinternal`;
    expect(trigger?.count).toBe(1);
  });
});
