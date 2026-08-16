/**
 * work-items-cdc-capture.integration.test.ts — P-010 unification, the CDC/federation
 * capture phase (migration 375). Provisions the FULL chain (000→375) so work_items is
 * the base table with the kind-branching capture, then proves the capture restores the
 * per-family substrate_outbox contracts the rename (374) broke:
 *   • a feature write → table_name='harness_features_consolidated' (unchanged shape);
 *   • a harness-scoped issue write → table_name='engineer_issues' with the ei wire-shape;
 *   • an operator-scoped issue with no single Hive home stays LOCAL (mig-197 guard);
 *   • a remote-origin write is NOT captured (echo-loop guard).
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts \
 *     src/work-items-cdc-capture.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, '..', 'sql');
const RUNNER = join(here, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');

const SKIP = (f: string) =>
  f.includes('per-harness-template') ||
  f === '040-plugin-configs-backfill.sql' ||
  f === '__seed_restored__.marker';

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
      applyPendingMigrations: (o: { client: Sql; sqlDir: string; skipFile?: (f: string) => boolean }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client, sqlDir: SQL_DIR, skipFile: SKIP });
    if (appliedCount !== totalKnown) throw new Error(`cdc provision: ${appliedCount}/${totalKnown}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;
beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'wicdc', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop().catch(() => {});
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.work_items`;
  await sql`TRUNCATE harness_shared.substrate_outbox RESTART IDENTITY`;
  // harness_shared.hives was renamed to pots (mig 557, cup-lexicon-full-rename-2026-07-09
  // P-011) — this rig provisions the full migration chain, so the live schema has pots.
  await sql`DELETE FROM harness_shared.pots WHERE workspace_id = 'ws1'`;
});

describe('work_items CDC capture (migration 375)', () => {
  it('a feature write captures under table_name=harness_features_consolidated (unchanged shape)', async () => {
    await sql`INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, workspace_id, title, summary, status, item_kind, origin)
      VALUES ('papercup', 'F-10', 'ws1', 'feat', 'feat body', 'todo', 'feature', 'local')`;
    const rows = await sql<{ table_name: string; harness_slug: string; key: string; row: Record<string, unknown> }[]>`
      SELECT table_name, harness_slug, key, row FROM harness_shared.substrate_outbox WHERE key = 'F-10'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].table_name).toBe('harness_features_consolidated');
    // mig 452: the outbox routing slug is canonicalized (retired papercup → papercusp);
    // the row payload keeps the raw value.
    expect(rows[0].harness_slug).toBe('papercusp');
    expect(rows[0].row.feature_id).toBe('F-10');
  });

  it('a harness-scoped issue write captures under table_name=engineer_issues with the ei wire-shape', async () => {
    // Write through the engineer_issues compat view (the issues engine's path) → work_items.
    await sql`INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, title, body, severity, source, state, kind)
      VALUES ('ws1', 'EI-10', 'harness:papercup', 'a bug', 'the body', 'major', 'engineer', 'open', 'bug')`;
    // mig 829: the issue-family outbox key is harness-qualified as <storage slug>/<feature id>.
    // The qualifier is the STORAGE slug (raw `papercup`), NOT the canonicalized routing slug —
    // only the storage identity can safely target a delete (EI-20340649204632164).
    const rows = await sql<{ table_name: string; harness_slug: string; key: string; row: Record<string, unknown> }[]>`
      SELECT table_name, harness_slug, key, row FROM harness_shared.substrate_outbox WHERE key = 'papercup/EI-10'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].table_name).toBe('engineer_issues');
    // pin the mig-829 key shape itself: an unqualified key is what erased same-ID rows in
    // other harnesses, so a silent regression back to the bare id must fail here.
    expect(rows[0].key).toBe('papercup/EI-10');
    // mig 452: routing slug canonicalized (papercup → papercusp).
    expect(rows[0].harness_slug).toBe('papercusp');
    // ei wire-shape (mig-197 contract / EngineerIssueRow): issue_id/scope/body/state mapped.
    expect(rows[0].row.issue_id).toBe('EI-10');
    expect(rows[0].row.scope).toBe('harness:papercup');
    expect(rows[0].row.body).toBe('the body');
    expect(rows[0].row.state).toBe('open');
    expect(rows[0].row.kind).toBe('bug');
    // stamped for per-harness demux from v_slug — canonicalized since mig 452
    expect(rows[0].row.harness_slug).toBe('papercusp');
  });

  it('an operator-scoped issue with no single Hive home stays LOCAL (not enqueued)', async () => {
    await sql`INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, title, body, state, kind)
      VALUES ('ws1', 'EI-11', 'operator', 'op task', '', 'open', 'change')`;
    // match on the wire issue_id, not the key: since mig 829 harness-qualified issue keys,
    // a bare `key = 'EI-11'` predicate can never match ANY row, so it would pass vacuously
    // even if this write were wrongly enqueued.
    const rows = await sql`SELECT 1 FROM harness_shared.substrate_outbox WHERE "row"->>'issue_id' = 'EI-11'`;
    expect(rows).toHaveLength(0);
  });

  it('an operator-scoped issue RIDES the workspace single Hive home (ported mig-197 derivation)', async () => {
    // The operator-scope→Hive-home resolution I earlier worried might be degraded — 375
    // ports it: with exactly one pots row for the workspace, the operator issue federates
    // under that pot_home_slug (table_name=engineer_issues). (hives/home_slug renamed to
    // pots/pot_home_slug by mig 557, cup-lexicon-full-rename-2026-07-09 P-011.)
    await sql`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
      VALUES ('ws1', 'hive-home', ${Buffer.from([1, 2, 3])}, 'kc-ws1', 0)`;
    await sql`INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, title, body, state, kind)
      VALUES ('ws1', 'EI-13', 'operator', 'op task', '', 'open', 'change')`;
    // keyed on the wire issue_id: an operator-scoped issue's mig-829 key qualifier is its
    // storage slug (`operator:…`), which this test never fixes, so asserting the key literal
    // here would couple the test to an identity it does not control.
    const rows = await sql<{ table_name: string; harness_slug: string }[]>`
      SELECT table_name, harness_slug FROM harness_shared.substrate_outbox WHERE "row"->>'issue_id' = 'EI-13'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].table_name).toBe('engineer_issues');
    expect(rows[0].harness_slug).toBe('hive-home');
  });

  it('an issue UPDATE re-federates only on a federated-field change (convergence guard)', async () => {
    await sql`INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, title, body, severity, source, state, kind)
      VALUES ('ws1', 'EI-20', 'harness:papercup', 'conv', 'b', 'minor', 'engineer', 'open', 'bug')`;
    await sql`TRUNCATE harness_shared.substrate_outbox RESTART IDENTITY`;
    // a federated-field change (state→status) re-federates; terminal lifecycle
    // transitions are intentionally reserved for the gated work-items writer.
    await sql`UPDATE harness_shared.engineer_issues
                 SET state = 'wip'
               WHERE workspace_id = 'ws1' AND issue_id = 'EI-20'`;
    expect(await sql`SELECT 1 FROM harness_shared.substrate_outbox WHERE key = 'papercup/EI-20'`).toHaveLength(1);
    await sql`TRUNCATE harness_shared.substrate_outbox RESTART IDENTITY`;
    // a bare re-write of the SAME value: only updated_ts changes → must NOT re-federate
    // (375's issue UPDATE WHEN masks updated_ts; left in, every own-log merge re-enqueues forever).
    await sql`UPDATE harness_shared.engineer_issues SET state = 'wip' WHERE workspace_id = 'ws1' AND issue_id = 'EI-20'`;
    expect(await sql`SELECT 1 FROM harness_shared.substrate_outbox WHERE key = 'papercup/EI-20'`).toHaveLength(0);
  });

  it('a remote-origin write is NOT captured (echo-loop guard)', async () => {
    await sql`INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, workspace_id, title, status, item_kind, origin)
      VALUES ('papercup', 'F-12', 'ws1', 'remote feat', 'todo', 'feature', 'remote')`;
    const rows = await sql`SELECT 1 FROM harness_shared.substrate_outbox WHERE key = 'F-12'`;
    expect(rows).toHaveLength(0);
  });
});
