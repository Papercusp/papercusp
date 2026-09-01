/**
 * Migration 1063 — persisted per-item reversal handles for unattended Inbox
 * bulk actions.
 *
 * The migration intentionally leaves historical auto_resolved rows unmodified
 * while enforcing the handle/window contract on every new or updated row.
 *
 * Run:
 *   npm run test:integration -- src/attention-bulk-item-reversal-window-migration.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = join(HERE, '..', 'sql', '1063-attention-bulk-item-reversal-window.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 1063 not found at ${armed}[.DRAFT]`);
}

const MIGRATION_SQL = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'bulk-reversal-1063' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE harness_shared.attention_bulk_run_items (
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT 'pending',
      action_id TEXT,
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, run_id, item_id)
    );
    INSERT INTO harness_shared.attention_bulk_run_items
      (workspace_id, run_id, item_id, outcome, action_id, decided_at)
    VALUES
      ('ws-legacy', 'run-legacy', 'item-legacy', 'auto_resolved', 'resolve', now() - interval '7 days');
  `);
  await sql.unsafe(MIGRATION_SQL);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1063 — attention bulk item reversal window', () => {
  it('keeps historical audit truthful while enforcing the future auto_resolved contract', async () => {
    const [legacy] = await sql<{
      outcome: string;
      revert_handle: unknown;
      reversal_window_until: Date | null;
    }[]>`
      SELECT outcome, revert_handle, reversal_window_until
        FROM harness_shared.attention_bulk_run_items
       WHERE workspace_id = 'ws-legacy'`;
    expect(legacy).toMatchObject({
      outcome: 'auto_resolved',
      revert_handle: null,
      reversal_window_until: null,
    });

    const [constraint] = await sql<{ convalidated: boolean }[]>`
      SELECT convalidated
        FROM pg_constraint
       WHERE conname = 'attention_bulk_run_items_auto_resolved_reversal_check'`;
    expect(constraint.convalidated).toBe(false);

    await sql`
      INSERT INTO harness_shared.attention_bulk_run_items
        (workspace_id, run_id, item_id, outcome)
      VALUES ('ws-new', 'run-new', 'item-new', 'pending')`;

    await expect(sql`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'auto_resolved', decided_at = now()
       WHERE workspace_id = 'ws-new'
    `).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'attention_bulk_run_items_auto_resolved_reversal_check',
    });

    await expect(sql`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'auto_resolved',
             action_id = 'resolve',
             decided_at = now(),
             revert_handle = ${{ kind: 'attention-bulk-item', version: 1 }}::jsonb,
             reversal_window_until = now() + interval '24 hours'
       WHERE workspace_id = 'ws-new'
    `).resolves.toBeDefined();
  });

  it('rejects malformed handles and non-forward windows', async () => {
    await sql`
      INSERT INTO harness_shared.attention_bulk_run_items
        (workspace_id, run_id, item_id, outcome)
      VALUES
        ('ws-invalid', 'run-invalid', 'missing-kind', 'pending'),
        ('ws-invalid', 'run-invalid', 'expired-window', 'pending')`;

    await expect(sql`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'auto_resolved',
             decided_at = now(),
             revert_handle = ${{ version: 1 }}::jsonb,
             reversal_window_until = now() + interval '1 hour'
       WHERE workspace_id = 'ws-invalid' AND item_id = 'missing-kind'
    `).rejects.toMatchObject({
      constraint_name: 'attention_bulk_run_items_auto_resolved_reversal_check',
    });

    await expect(sql`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'auto_resolved',
             decided_at = now(),
             revert_handle = ${{ kind: 'attention-bulk-item' }}::jsonb,
             reversal_window_until = now() - interval '1 second'
       WHERE workspace_id = 'ws-invalid' AND item_id = 'expired-window'
    `).rejects.toMatchObject({
      constraint_name: 'attention_bulk_run_items_auto_resolved_reversal_check',
    });
  });

  it('records compensation without rewriting the original decision', async () => {
    await expect(sql`
      UPDATE harness_shared.attention_bulk_run_items
         SET reverted_at = now()
       WHERE workspace_id = 'ws-new'
    `).rejects.toMatchObject({
      constraint_name: 'attention_bulk_run_items_compensation_record_check',
    });

    await sql`
      UPDATE harness_shared.attention_bulk_run_items
         SET reverted_at = now(), revert_note = 'restored source state'
       WHERE workspace_id = 'ws-new'`;

    const [row] = await sql<{
      outcome: string;
      action_id: string;
      reverted_at: Date;
      revert_note: string;
    }[]>`
      SELECT outcome, action_id, reverted_at, revert_note
        FROM harness_shared.attention_bulk_run_items
       WHERE workspace_id = 'ws-new'`;
    expect(row).toMatchObject({
      outcome: 'auto_resolved',
      action_id: 'resolve',
      revert_note: 'restored source state',
    });
    expect(row.reverted_at).toBeInstanceOf(Date);
  });

  it('installs the open-window index and is idempotent', async () => {
    await sql.unsafe(MIGRATION_SQL);
    const [shape] = await sql<{ index_count: number; column_count: number }[]>`
      SELECT
        (
          SELECT count(*)::int
            FROM pg_indexes
           WHERE schemaname = 'harness_shared'
             AND indexname = 'attention_bulk_run_items_open_reversal_idx'
        ) AS index_count,
        (
          SELECT count(*)::int
            FROM information_schema.columns
           WHERE table_schema = 'harness_shared'
             AND table_name = 'attention_bulk_run_items'
             AND column_name IN ('revert_handle', 'reversal_window_until', 'reverted_at', 'revert_note')
        ) AS column_count`;
    expect(shape).toEqual({ index_count: 1, column_count: 4 });
  });
});
