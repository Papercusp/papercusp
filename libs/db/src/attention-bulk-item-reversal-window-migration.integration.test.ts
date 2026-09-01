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
  it('keeps historical audit truthful and remains compatible with the deployed writer', async () => {
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

    const [shape] = await sql<{ nullable_columns: number; contract_constraints: number }[]>`
      SELECT
        (
          SELECT count(*)::int
            FROM information_schema.columns
           WHERE table_schema = 'harness_shared'
             AND table_name = 'attention_bulk_run_items'
             AND column_name IN ('revert_handle', 'reversal_window_until', 'reverted_at', 'revert_note')
             AND is_nullable = 'YES'
        ) AS nullable_columns,
        (
          SELECT count(*)::int
            FROM pg_constraint
           WHERE conrelid = 'harness_shared.attention_bulk_run_items'::regclass
             AND conname IN (
               'attention_bulk_run_items_auto_resolved_reversal_check',
               'attention_bulk_run_items_compensation_record_check'
             )
        ) AS contract_constraints`;
    expect(shape).toEqual({ nullable_columns: 4, contract_constraints: 0 });

    // The old deployed writer does not mention the new columns. It must remain
    // able to settle a row while this expand migration is ahead of the binary.
    await sql`
      INSERT INTO harness_shared.attention_bulk_run_items
        (workspace_id, run_id, item_id, outcome)
      VALUES ('ws-old-writer', 'run-old-writer', 'item-old-writer', 'pending')`;
    await expect(sql`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'auto_resolved', action_id = 'resolve', decided_at = now()
       WHERE workspace_id = 'ws-old-writer'
    `).resolves.toBeDefined();

    await sql`
      UPDATE harness_shared.attention_bulk_run_items
         SET revert_handle = ${{ kind: 'attention-bulk-item', version: 1 }}::jsonb,
             reversal_window_until = now() + interval '24 hours'
       WHERE workspace_id = 'ws-old-writer'
    `;

    const [expanded] = await sql<{ revert_handle: unknown; reversal_window_until: Date | null }[]>`
      SELECT revert_handle, reversal_window_until
        FROM harness_shared.attention_bulk_run_items
       WHERE workspace_id = 'ws-old-writer'`;
    expect(expanded?.revert_handle).toEqual({ kind: 'attention-bulk-item', version: 1 });
    expect(expanded?.reversal_window_until).toBeInstanceOf(Date);
  });

  it('leaves the contract columns writable for the compatible writer', async () => {
    await sql`
      INSERT INTO harness_shared.attention_bulk_run_items
        (workspace_id, run_id, item_id, outcome)
      VALUES ('ws-new', 'run-new', 'item-new', 'pending')`;

    await sql`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'auto_resolved',
             action_id = 'resolve',
             decided_at = now(),
             revert_handle = ${{ kind: 'attention-bulk-item', version: 1 }}::jsonb,
             reversal_window_until = now() + interval '24 hours'
       WHERE workspace_id = 'ws-new'
    `;

    const [newRow] = await sql<{ outcome: string; revert_handle: unknown; reversal_window_until: Date | null }[]>`
      SELECT outcome, revert_handle, reversal_window_until
        FROM harness_shared.attention_bulk_run_items
       WHERE workspace_id = 'ws-new'`;
    expect(newRow).toMatchObject({
      outcome: 'auto_resolved',
      revert_handle: { kind: 'attention-bulk-item', version: 1 },
    });
    expect(newRow?.reversal_window_until).toBeInstanceOf(Date);
  });

  it('records compensation without rewriting the original decision', async () => {
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
