/**
 * emit-change-notify-guc.integration.test.ts — migration 368 fixes the GENERIC
 * harness_shared.emit_change_notify() trigger globally (work-item-deps-and-readiness-2026-06-22 P-006).
 *
 * Before 368 the function read current_setting('papercusp.workspace_id') but the runtime sets the GUC
 * under 'app.workspace_id', so EVERY generic-trigger `sync_invalidate` notify carried workspace_id=NULL.
 * 368 (a) reads app.workspace_id, and (b) additively includes the changed row's PK as args.id
 * (to_jsonb(COALESCE(NEW,OLD))->'id' — null/absent for tables without an `id` column).
 *
 * This asserts, on tables wired to the generic trigger (107-dogfood-reactivity-triggers.sql), that the
 * notify now carries workspace_id='test-ws' (NOT null), that args.id appears when the table has an `id`,
 * and that the trigger still fires (backward-compatible) on a table WITHOUT an `id` column.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/emit-change-notify-guc.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, '..', 'sql');
const RUNNER = join(here, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');

const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (o: { client: Sql; sqlDir: string }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    if (appliedCount !== totalKnown) {
      throw new Error(`emit-change-notify-guc provision: applied ${appliedCount}/${totalKnown} (expected zero skips)`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;
let listener: Sql;
interface Notif {
  name: string;
  args: { op: string; workspace_id?: string | null; id?: number | string | null };
}
const received: Notif[] = [];
const notifsFor = (name: string): Notif[] => received.filter((n) => n.name === name);
const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'emitchangeguc', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  // The runtime sets the workspace GUC under `app.workspace_id` (NOT papercusp.workspace_id) —
  // session-scoped so the trigger reads it for every write on this connection.
  await sql.unsafe(`SELECT set_config('app.workspace_id', 'test-ws', false)`);
  listener = postgres(db.url, { max: 1, onnotice: () => {} });
  await listener.listen('sync_invalidate', (payload: string) => {
    try {
      received.push(JSON.parse(payload) as Notif);
    } catch {
      /* ignore */
    }
  });
}, 180_000);

afterAll(async () => {
  await listener?.end({ timeout: 5 }).catch(() => {});
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 368 — generic emit_change_notify reads app.workspace_id', () => {
  it('emits workspace_id="test-ws" (NOT null) on a triggered table with an id column (auto_review_audit)', async () => {
    received.length = 0;
    await sql.unsafe(
      `INSERT INTO harness_shared.auto_review_audit
         (workspace_id, id, harness_slug, pr_number, reviewer_github_id, action)
       VALUES ('test-ws', 4242, 'demo-slug', 7, 99, 'auto_approve')`,
    );
    await settle();
    const n = notifsFor('harness_shared.auto_review_audit.changed');
    expect(n).toHaveLength(1);
    expect(n[0]!.args.op).toBe('INSERT');
    // The bug fix: workspace_id is now the GUC value, NOT null.
    expect(n[0]!.args.workspace_id).toBe('test-ws');
    expect(n[0]!.args.workspace_id).not.toBeNull();
    // Additive: the changed row's primary key.
    expect(String(n[0]!.args.id)).toBe('4242');
  });

  it('emits workspace_id="test-ws" on DELETE and carries the PK from OLD', async () => {
    await sql.unsafe(
      `INSERT INTO harness_shared.auto_review_audit
         (workspace_id, id, harness_slug, pr_number, reviewer_github_id, action)
       VALUES ('test-ws', 4243, 'demo-slug', 8, 99, 'auto_merge')`,
    );
    await settle();
    received.length = 0;
    await sql.unsafe(`DELETE FROM harness_shared.auto_review_audit WHERE id = 4243`);
    await settle();
    const n = notifsFor('harness_shared.auto_review_audit.changed');
    expect(n).toHaveLength(1);
    expect(n[0]!.args.op).toBe('DELETE');
    expect(n[0]!.args.workspace_id).toBe('test-ws');
    expect(String(n[0]!.args.id)).toBe('4243');
  });

  it('still fires (backward-compatible) on a triggered table WITHOUT an id column (known_schema_versions); id is null', async () => {
    received.length = 0;
    await sql.unsafe(
      `INSERT INTO harness_shared.known_schema_versions (workspace_id, harness_slug, max_known_version)
         VALUES ('test-ws', 'demo-slug', 5)`,
    );
    await settle();
    const n = notifsFor('harness_shared.known_schema_versions.changed');
    expect(n).toHaveLength(1);
    expect(n[0]!.args.op).toBe('INSERT');
    expect(n[0]!.args.workspace_id).toBe('test-ws');
    // No `id` column on this table -> args.id is null (absent value), not an error.
    expect(n[0]!.args.id ?? null).toBeNull();
  });
});

describe('migration 625 (WI-4513) — feature_id fallback for id-less work_items + siblings', () => {
  it('emits args.id = feature_id for a work_items write (base table has no `id` column)', async () => {
    received.length = 0;
    await sql.unsafe(
      `INSERT INTO harness_shared.harness_features_consolidated
         (workspace_id, harness_slug, feature_id, title, kind)
       VALUES ('test-ws', 'demo-slug', 'WI-99001', 'wi-4513 fixture', 'change')`,
    );
    await settle();
    const n = notifsFor('harness_shared.harness_features_consolidated.changed');
    expect(n).toHaveLength(1);
    expect(n[0]!.args.op).toBe('INSERT');
    expect(n[0]!.args.workspace_id).toBe('test-ws');
    // The fix: id is no longer null — it falls back to feature_id.
    expect(String(n[0]!.args.id)).toBe('WI-99001');
  });

  it('emits args.id = feature_id for a feature_claims write (a different id-less feature_id sibling)', async () => {
    received.length = 0;
    await sql.unsafe(
      `INSERT INTO harness_shared.feature_claims
         (workspace_id, harness_slug, feature_id, seq, claimer_pubkey, claimer_github_user_id, claimed_at)
       VALUES ('test-ws', 'demo-slug', 'WI-99002', 1, 'pubkey-fixture', 42, now())`,
    );
    await settle();
    const n = notifsFor('harness_shared.feature_claims.changed');
    expect(n).toHaveLength(1);
    expect(String(n[0]!.args.id)).toBe('WI-99002');
  });

  it('still prefers a real `id` column over feature_id when both are present (auto_review_audit unaffected)', async () => {
    received.length = 0;
    await sql.unsafe(
      `INSERT INTO harness_shared.auto_review_audit
         (workspace_id, id, harness_slug, pr_number, reviewer_github_id, action)
       VALUES ('test-ws', 4244, 'demo-slug', 9, 99, 'auto_approve')`,
    );
    await settle();
    const n = notifsFor('harness_shared.auto_review_audit.changed');
    expect(n).toHaveLength(1);
    // Unchanged: this table has its own `id`, so the feature_id fallback never engages.
    expect(String(n[0]!.args.id)).toBe('4244');
  });
});
