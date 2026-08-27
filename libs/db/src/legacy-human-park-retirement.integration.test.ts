/**
 * legacy-human-park-retirement.integration.test.ts — migration 870.
 *
 * Reproduces the exact live 30-row recurrence geometry after migrations 867/868,
 * proves census/claim guards fail closed, and verifies all three live typed
 * destinations plus backup, review-ledger, blocker-history, and idempotency.
 *
 * Run:
 *   npm run test:file -- libs/papercusp/libs/db/src/legacy-human-park-retirement.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(HERE, '..', 'sql');
const RUNNER = path.join(HERE, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');

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

function readMigration(name: string): string {
  const armed = path.join(SQL_DIR, name);
  if (existsSync(armed)) return readFileSync(armed, 'utf8');
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return readFileSync(draft, 'utf8');
  throw new Error(`migration ${name} not found at ${armed}[.DRAFT]`);
}

const MIGRATION_870_SQL = readMigration('870-retire-post-868-legacy-human-park-recurrence.sql');

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (options: {
        client: Sql;
        sqlDir: string;
      }) => Promise<{ appliedCount: number; totalKnown: number; failed: unknown[] }>;
    };
    const result = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    if (result.failed.length > 0 || result.appliedCount !== result.totalKnown) {
      throw new Error(
        `migration provision incomplete: ${result.appliedCount}/${result.totalKnown}, failed=${result.failed.length}`,
      );
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;

async function applyMigration(): Promise<void> {
  try {
    await sql.unsafe(`BEGIN;\nSET LOCAL statement_timeout = 0;\n${MIGRATION_870_SQL}\nCOMMIT;`);
  } catch (error) {
    await sql.unsafe('ROLLBACK').catch(() => {});
    throw error;
  }
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'legacypark870', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });

  await sql.unsafe(`
    -- Provision applies the full chain; reset 870's LIKE-based backup so this
    -- raw replay models the migration as pending against the current schema.
    DROP TABLE IF EXISTS harness_shared.bak_20260821_legacy_human_recurrence_870;

    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
       created_ts, updated_ts, payload)
    SELECT 'papercusp-workspace', 'papercusp',
           'REVIEW-' || lpad(n::text, 2, '0'), 'Review recurrence ' || n,
           'needs-human', 'bug', 'local', n, n,
           jsonb_build_object(
             'needsHuman', true,
             'ideaLifecycle', jsonb_build_object('triageDecision', 'gate'),
             'agentReview', jsonb_build_object(
               'status', 'pending',
               'submittedBy', 'review-author-' || n,
               'ledgerIdeaId', 'REVIEW-' || lpad(n::text, 2, '0'),
               'round', 1
             )
           ) || CASE WHEN n = 1 THEN jsonb_build_object(
             'externalBlockers', jsonb_build_array(jsonb_build_object(
               'status', 'active', 'capability', 'product-decision',
               'evidence', 'legacy review gate'
             ))
           ) ELSE '{}'::jsonb END
      FROM generate_series(1, 8) n;

    INSERT INTO harness_shared.bak_20260821_legacy_human_park_manifest
      (workspace_id, harness_slug, feature_id, item_kind, old_status,
       destination, submitted_by, ledger_idea_id)
    SELECT 'papercusp-workspace', 'papercusp',
           'REVIEW-' || lpad(n::text, 2, '0'), 'bug', 'needs-human',
           'agent-review', 'review-author-' || n,
           'REVIEW-' || lpad(n::text, 2, '0')
      FROM generate_series(1, 8) n;

    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
       created_ts, updated_ts, payload)
    SELECT 'papercusp-workspace', 'papercusp',
           'REMOTE-' || lpad(n::text, 2, '0'), 'Remote recurrence ' || n,
           'needs-human', 'bug', 'local', 20 + n, 20 + n,
           jsonb_build_object(
             'needsHuman', true,
             '_legacyHumanParkRepair', jsonb_build_object(
               'migration', 867, 'destination', 'remote-reconciliation'
             )
           )
      FROM generate_series(1, 6) n;

    INSERT INTO harness_shared.bak_20260821_legacy_human_park_manifest
      (workspace_id, harness_slug, feature_id, item_kind, old_status, destination)
    SELECT 'papercusp-workspace', 'papercusp',
           'REMOTE-' || lpad(n::text, 2, '0'), 'bug', 'needs-human',
           'remote-reconciliation'
      FROM generate_series(1, 6) n;

    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
       created_ts, updated_ts, payload)
    SELECT 'papercusp-workspace', 'papercusp',
           'OP-868-' || lpad(n::text, 2, '0'), '868 recurrence ' || n,
           'needs-human', 'bug', 'local', 40 + n, 40 + n,
           jsonb_build_object(
             'needsHuman', true,
             '_legacyHumanParkRepair', jsonb_build_object(
               'migration', 867, 'destination', 'operational'
             ),
             '_legacyHumanParkStatusRepair', jsonb_build_object('migration', 868)
           ) || CASE
             WHEN n = 1 THEN jsonb_build_object(
               'externalBlockers', jsonb_build_array(jsonb_build_object(
                 'status', 'active', 'capability', 'product-decision',
                 'evidence', 'legacy operational decision'
               )))
             WHEN n = 2 THEN jsonb_build_object(
               'externalBlockers', jsonb_build_array(jsonb_build_object(
                 'status', 'active', 'capability', 'live-dependency',
                 'evidence', 'dependency remains live'
               )))
             ELSE '{}'::jsonb
           END
      FROM generate_series(1, 8) n;

    INSERT INTO harness_shared.bak_20260821_legacy_human_park_manifest
      (workspace_id, harness_slug, feature_id, item_kind, old_status, destination)
    SELECT 'papercusp-workspace', 'papercusp',
           'OP-868-' || lpad(n::text, 2, '0'), 'bug', 'needs-human', 'operational'
      FROM generate_series(1, 8) n;

    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
       created_ts, updated_ts, payload)
    SELECT 'papercusp-workspace', 'papercusp',
           'OP-REC-' || lpad(n::text, 2, '0'), 'Writer recurrence ' || n,
           'needs-human', 'bug', 'local', 60 + n, 60 + n,
           jsonb_build_object('needsHuman', true)
           || CASE WHEN n <= 6 THEN jsonb_build_object(
             '_legacyHumanParkRepair', jsonb_build_object(
               'migration', 867, 'destination', 'operational'
             )
           ) ELSE '{}'::jsonb END
      FROM generate_series(1, 8) n;

    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
       created_ts, updated_ts, payload)
    VALUES (
      'papercusp-workspace', 'papercusp', 'TERMINAL-HISTORY',
      'Terminal legacy history remains immutable', 'done', 'bug', 'local',
      100, 100, '{"needsHuman":true}'::jsonb
    );
  `);
}, 300_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 870 — retire the exact post-867/868 recurrence', () => {
  it('fails closed on census drift and any live claim', async () => {
    await sql.unsafe(`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
         created_ts, updated_ts, payload)
      VALUES (
        'papercusp-workspace', 'papercusp', 'DRIFT-EXTRA', 'Drift sentinel',
        'needs-human', 'bug', 'local', 200, 200, '{"needsHuman":true}'::jsonb
      )
    `);
    await expect(applyMigration()).rejects.toThrow(/expected 30=\(6 remote,8 review,0 owner,16 operational\), got 31=/);
    await sql`DELETE FROM harness_shared.work_items WHERE feature_id = 'DRIFT-EXTRA'`;

    await sql`UPDATE harness_shared.work_items SET taken_by = 'su:busy' WHERE feature_id = 'OP-REC-01'`;
    await expect(applyMigration()).rejects.toThrow(/refusing to rewrite claimed legacy human-park row.*OP-REC-01/);
    await sql`UPDATE harness_shared.work_items SET taken_by = NULL WHERE feature_id = 'OP-REC-01'`;
  });

  it('lands the exact typed split and preserves blocker/ownership semantics', async () => {
    await applyMigration();

    const split = (await sql`
      SELECT payload -> '_legacyHumanParkRetirement' ->> 'destination' AS destination,
             count(*)::int AS count
        FROM harness_shared.work_items
       WHERE payload -> '_legacyHumanParkRetirement' ->> 'migration' = '870'
       GROUP BY destination ORDER BY destination
    `) as Array<{ destination: string; count: number }>;
    expect(Object.fromEntries(split.map((row) => [row.destination, row.count]))).toEqual({
      'agent-review': 8,
      operational: 16,
      'remote-reconciliation': 6,
    });

    const [review] = (await sql`
      SELECT status, payload FROM harness_shared.work_items WHERE feature_id = 'REVIEW-01'
    `) as Array<{ status: string; payload: Record<string, any> }>;
    expect(review.status).toBe('open');
    expect(review.payload).not.toHaveProperty('needsHuman');
    expect(review.payload.agentReview).toMatchObject({
      status: 'pending',
      submittedBy: 'review-author-1',
      ledgerIdeaId: 'REVIEW-01',
      round: 1,
    });
    expect(review.payload.externalBlockers[0]).toMatchObject({
      status: 'cleared',
      capability: 'product-decision',
      clearedBy: 'system:migration-870',
    });

    const [remote] = (await sql`
      SELECT status, origin, payload FROM harness_shared.work_items WHERE feature_id = 'REMOTE-01'
    `) as Array<{ status: string; origin: string; payload: Record<string, any> }>;
    expect(remote).toMatchObject({ status: 'open', origin: 'remote' });
    expect(remote.payload).not.toHaveProperty('needsHuman');

    const operational = (await sql`
      SELECT feature_id, status, payload
        FROM harness_shared.work_items
       WHERE feature_id IN ('OP-868-01', 'OP-868-02', 'OP-REC-08')
       ORDER BY feature_id
    `) as Array<{ feature_id: string; status: string; payload: Record<string, any> }>;
    const byId = Object.fromEntries(operational.map((row) => [row.feature_id, row]));
    expect(byId['OP-868-01'].status).toBe('open');
    expect(byId['OP-868-01'].payload.externalBlockers[0]).toMatchObject({
      status: 'cleared',
      capability: 'product-decision',
      clearedBy: 'system:migration-870',
    });
    expect(byId['OP-868-02'].status).toBe('blocked');
    expect(byId['OP-868-02'].payload.externalBlockers[0]).toMatchObject({
      status: 'active',
      capability: 'live-dependency',
    });
    expect(byId['OP-REC-08']).toMatchObject({ status: 'open' });

    const [{ legacy, backups, reviewAuthorities, terminalLegacy }] = (await sql`
      SELECT
        count(*) FILTER (
          WHERE status NOT IN ('done', 'passed', 'deprecated', 'resolved', 'closed', 'dropped')
            AND (payload->>'needsHuman' = 'true'
              OR (status = 'needs-human' AND payload->>'needsOwnerAction' IS DISTINCT FROM 'true'))
        )::int AS legacy,
        (SELECT count(*)::int FROM harness_shared.bak_20260821_legacy_human_recurrence_870) AS backups,
        (SELECT count(*)::int FROM harness_shared.scout_routed_ideas
          WHERE idea_id LIKE 'REVIEW-%' AND routed_ref = 'wi:' || idea_id) AS "reviewAuthorities",
        count(*) FILTER (WHERE feature_id = 'TERMINAL-HISTORY' AND payload->>'needsHuman' = 'true')::int
          AS "terminalLegacy"
      FROM harness_shared.work_items
      WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
    `) as Array<{ legacy: number; backups: number; reviewAuthorities: number; terminalLegacy: number }>;
    expect({ legacy, backups, reviewAuthorities, terminalLegacy }).toEqual({
      legacy: 0,
      backups: 30,
      reviewAuthorities: 8,
      terminalLegacy: 1,
    });
  });

  it('is idempotent after the witnessed 30-row repair', async () => {
    await applyMigration();
    const [{ backups, retired }] = (await sql`
      SELECT
        (SELECT count(*)::int FROM harness_shared.bak_20260821_legacy_human_recurrence_870) AS backups,
        count(*) FILTER (
          WHERE payload->'_legacyHumanParkRetirement'->>'migration' = '870'
        )::int AS retired
      FROM harness_shared.work_items
      WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
    `) as Array<{ backups: number; retired: number }>;
    expect({ backups, retired }).toEqual({ backups: 30, retired: 30 });
  });
});
