/**
 * Migration 1317 — the data-source record (enterprise-data-sources-2026-10-01 P-013, D-010).
 *
 * Applies the REAL trigger_sources migration chain (876 → 879 → 889 → 959 → 960 → 975 → 1269)
 * instead of hand-rolling the table, so this fixture cannot fall a column behind the live
 * schema. Only the out-of-chain prerequisites (plans, datatype registry, users) are stubbed.
 *
 * Pins the five behaviours D-010 depends on: backfill of rows that predate the migration,
 * connector defaults for inserts that omit the new columns (every writer in the deployed
 * release), the WORK/DATA boundary (a destination policy can never express `work`), scope
 * integrity (pot needs scope_ref, personal needs an owner), and retention-policy shape.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(HERE, '..', 'sql');

function migrationPath(file: string): string {
  const armed = path.join(SQL_DIR, file);
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration not found at ${armed}[.DRAFT]`);
}

const CHAIN = [
  '876-external-trigger-core.sql',
  '879-trigger-source-owner-user.sql',
  '889-owned-trigger-source-uniqueness.sql',
  '959-owned-trigger-source-account-identity.sql',
  '960-restore-owned-trigger-legacy-arbiter.sql',
  '975-remove-owned-trigger-legacy-arbiter.sql',
  '1269-webhook-trigger-secrets.sql',
];
const migration1317 = readFileSync(migrationPath('1317-data-source-record.sql'), 'utf8');

const OWNER = '00000000-0000-4000-8000-000000000001';

type SourceRow = {
  kind: string;
  sync_mode: string;
  backfill_status: string;
  scope: string;
  scope_ref: string | null;
  datatype_mappings: Record<string, string>;
  destination_policy: Record<string, string[]>;
  retention_policy: Record<string, number>;
  permission_mapping: { mode: string };
};

let db: MigratedTestDb;
let sql: Sql;
const preexisting: Record<string, string> = {};

async function sourceById(id: string): Promise<SourceRow> {
  const [row] = await sql<SourceRow[]>`
    SELECT kind, sync_mode, backfill_status, scope, scope_ref, datatype_mappings,
           destination_policy, retention_policy, permission_mapping
      FROM harness_shared.trigger_sources
     WHERE id = ${id}`;
  return row;
}

/** Resolves to the violated constraint name, or null when the statement succeeded. */
async function violatedConstraint(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await sql.unsafe('SAVEPOINT probe');
    await run();
    await sql.unsafe('RELEASE SAVEPOINT probe');
    return null;
  } catch (error) {
    await sql.unsafe('ROLLBACK TO SAVEPOINT probe');
    const name = (error as { constraint_name?: string }).constraint_name;
    if (!name) throw error;
    return name;
  }
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'datasource1317' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA harness_shared');
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    -- The columns 1269's webhook-payload seed writes.
    CREATE TABLE harness_shared.datatype_registry (
      workspace_id text NOT NULL,
      id text NOT NULL,
      pot_slug text, title text, description text, tier text, work_item_kind text,
      payload_schema jsonb, authoritative_writer text, self_improvement jsonb,
      status text, published boolean, review_status text, tags text[],
      created_by text, updated_at timestamptz,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE TABLE harness_shared.users (id uuid PRIMARY KEY);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
        CREATE ROLE harness_app;
      END IF;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    INSERT INTO harness_shared.users (id) VALUES ('${OWNER}');
  `);
  for (const file of CHAIN) {
    await sql.unsafe(readFileSync(migrationPath(file), 'utf8'));
  }

  // Rows written by the deployed release, before 1317 exists.
  const seed: Array<[string, string | null]> = [
    ['gmail', OWNER],
    ['gcal', OWNER],
    ['contacts', OWNER],
    ['slack', null],
    ['webhook', null],
    ['custom-crm', null],
  ];
  for (const [kind, owner] of seed) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, credential_ref, status, owner_user_id, provider_account_id)
      VALUES ('ws-a', ${kind}, ${`cred:${kind}`}, 'connected', ${owner},
              ${owner ? `acct-${kind}` : null})
      RETURNING id`;
    preexisting[kind] = row.id;
  }

  await sql.unsafe(migration1317);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1317 — data-source record', () => {
  it('backfills rows that predate it with connector defaults and ownership-derived scope', async () => {
    const gmail = await sourceById(preexisting.gmail);
    expect(gmail).toMatchObject({
      sync_mode: 'poll',
      backfill_status: 'not-requested',
      scope: 'personal',
      scope_ref: null,
      datatype_mappings: { message: 'email-message' },
      destination_policy: { 'email-message': ['document', 'event'] },
      retention_policy: {},
      permission_mapping: { mode: 'owner' },
    });
    expect(await sourceById(preexisting.gcal)).toMatchObject({
      sync_mode: 'poll',
      scope: 'personal',
      datatype_mappings: { event: 'calendar-event' },
    });
    expect(await sourceById(preexisting.contacts)).toMatchObject({
      sync_mode: 'poll',
      datatype_mappings: { person: 'contact' },
    });
    expect(await sourceById(preexisting.slack)).toMatchObject({
      sync_mode: 'socket',
      scope: 'organization',
      datatype_mappings: { message: 'chat-message' },
    });
    expect(await sourceById(preexisting.webhook)).toMatchObject({
      sync_mode: 'webhook',
      destination_policy: { 'webhook-payload': ['event'] },
    });
    expect(await sourceById(preexisting['custom-crm'])).toMatchObject({
      sync_mode: 'manual',
      scope: 'organization',
      datatype_mappings: {},
      destination_policy: {},
    });
  });

  it('is idempotent: a re-apply neither fails nor rewrites existing rows', async () => {
    await sql`
      UPDATE harness_shared.trigger_sources
         SET sync_mode = 'federated', backfill_status = 'complete'
       WHERE id = ${preexisting.slack}`;
    await sql.unsafe(migration1317);
    expect(await sourceById(preexisting.slack)).toMatchObject({
      sync_mode: 'federated',
      backfill_status: 'complete',
      scope: 'organization',
    });
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM pg_trigger
       WHERE tgname = 'trigger_sources_apply_kind_defaults'`;
    expect(count).toBe(1);
  });

  it('fills connector defaults and scope for inserts that omit the new columns', async () => {
    const [org] = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.trigger_sources (workspace_id, kind, credential_ref, status)
      VALUES ('ws-a', 'slack', 'cred:slack-2', 'connected')
      RETURNING id`;
    expect(await sourceById(org.id)).toMatchObject({
      sync_mode: 'socket',
      scope: 'organization',
      datatype_mappings: { message: 'chat-message' },
      destination_policy: { 'chat-message': ['document', 'event'] },
    });

    const [owned] = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, credential_ref, status, owner_user_id, provider_account_id)
      VALUES ('ws-a', 'gmail', 'cred:gmail-2', 'connected', ${OWNER}, 'acct-gmail-2')
      RETURNING id`;
    expect((await sourceById(owned.id)).scope).toBe('personal');

    const [explicit] = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, credential_ref, status, sync_mode, destination_policy)
      VALUES ('ws-a', 'slack', 'cred:slack-3', 'connected', 'federated',
              ${sql.json({ 'chat-message': ['document'] })})
      RETURNING id`;
    expect(await sourceById(explicit.id)).toMatchObject({
      sync_mode: 'federated',
      destination_policy: { 'chat-message': ['document'] },
    });
  });

  it('never lets a destination policy route a datatype into work (D-001)', async () => {
    await sql.unsafe('BEGIN');
    try {
      expect(
        await violatedConstraint(() => sql`
          INSERT INTO harness_shared.trigger_sources
            (workspace_id, kind, credential_ref, status, destination_policy)
          VALUES ('ws-a', 'slack', 'cred:x', 'connected',
                  ${sql.json({ 'chat-message': ['document', 'work'] })})`),
      ).toBe('trigger_sources_destination_policy_chk');
      expect(
        await violatedConstraint(() => sql`
          UPDATE harness_shared.trigger_sources
             SET destination_policy = ${sql.json({ 'chat-message': ['work'] })}
           WHERE id = ${preexisting.slack}`),
      ).toBe('trigger_sources_destination_policy_chk');
      expect(
        await violatedConstraint(() => sql`
          UPDATE harness_shared.trigger_sources
             SET destination_policy = ${sql.json({ 'chat-message': [] })}
           WHERE id = ${preexisting.slack}`),
      ).toBe('trigger_sources_destination_policy_chk');
      expect(
        await violatedConstraint(() => sql`
          UPDATE harness_shared.trigger_sources
             SET destination_policy = ${sql.json({ 'chat-message': ['record', 'document', 'event'] })}
           WHERE id = ${preexisting.slack}`),
      ).toBeNull();
    } finally {
      await sql.unsafe('ROLLBACK');
    }
  });

  it('enforces scope integrity: pot needs scope_ref, personal needs an owner', async () => {
    await sql.unsafe('BEGIN');
    try {
      expect(
        await violatedConstraint(() => sql`
          UPDATE harness_shared.trigger_sources SET scope = 'pot'
           WHERE id = ${preexisting.slack}`),
      ).toBe('trigger_sources_scope_ref_chk');
      expect(
        await violatedConstraint(() => sql`
          UPDATE harness_shared.trigger_sources SET scope = 'organization', scope_ref = 'acme-pot'
           WHERE id = ${preexisting.slack}`),
      ).toBe('trigger_sources_scope_ref_chk');
      expect(
        await violatedConstraint(() => sql`
          UPDATE harness_shared.trigger_sources SET scope = 'personal'
           WHERE id = ${preexisting.slack}`),
      ).toBe('trigger_sources_personal_owner_chk');
      expect(
        await violatedConstraint(() => sql`
          UPDATE harness_shared.trigger_sources SET scope = 'pot', scope_ref = 'acme-pot'
           WHERE id = ${preexisting.slack}`),
      ).toBeNull();
    } finally {
      await sql.unsafe('ROLLBACK');
    }
  });

  it('accepts only positive whole-day retention keys and known permission modes', async () => {
    await sql.unsafe('BEGIN');
    try {
      const setRetention = (policy: Record<string, unknown>) => () => sql`
        UPDATE harness_shared.trigger_sources SET retention_policy = ${sql.json(policy as never)}
         WHERE id = ${preexisting.slack}`;
      expect(await violatedConstraint(setRetention({ maxAgeDays: 1.5 }))).toBe(
        'trigger_sources_retention_policy_chk',
      );
      expect(await violatedConstraint(setRetention({ maxAgeDays: 0 }))).toBe(
        'trigger_sources_retention_policy_chk',
      );
      expect(await violatedConstraint(setRetention({ keepForever: true }))).toBe(
        'trigger_sources_retention_policy_chk',
      );
      // The trigger-automation-consolidation seam (D-010): the delivery dedupe horizon
      // lives on the data source.
      expect(
        await violatedConstraint(setRetention({ maxAgeDays: 365, deliveryDedupeHorizonDays: 14 })),
      ).toBeNull();

      expect(
        await violatedConstraint(() => sql`
          UPDATE harness_shared.trigger_sources
             SET permission_mapping = ${sql.json({ mode: 'everyone' })}
           WHERE id = ${preexisting.slack}`),
      ).toBe('trigger_sources_permission_mapping_chk');
      expect(
        await violatedConstraint(() => sql`
          UPDATE harness_shared.trigger_sources
             SET permission_mapping = ${sql.json({ mode: 'source-acl' })}
           WHERE id = ${preexisting.slack}`),
      ).toBeNull();
      expect(
        await violatedConstraint(() => sql`
          UPDATE harness_shared.trigger_sources SET sync_mode = 'push'
           WHERE id = ${preexisting.slack}`),
      ).toBe('trigger_sources_sync_mode_chk');
    } finally {
      await sql.unsafe('ROLLBACK');
    }
  });
});
