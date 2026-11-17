/**
 * EI-19457370414604336 — the shared-base writer for prior-worker attribution.
 *
 * The trigger is intentionally tested at the base table because both direct
 * feature updates and engineer_issues INSTEAD-OF view updates land there.
 * This catches a future claim/release path that bypasses one compatibility
 * view, and proves remote projection churn stays out of local history.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

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

let db: MigratedTestDb;
let sql: Sql;

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (o: { client: Sql; sqlDir: string }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const result = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    if (result.appliedCount !== result.totalKnown) {
      throw new Error(`worked-by-history provision: applied ${result.appliedCount}/${result.totalKnown}`);
    }
    // 797 is intentionally parked pending its code companion; mirror the live
    // database shape used by the adjacent engineer-issues DML integration test.
    // ORDER IS LOAD-BEARING: 806 re-applies `CREATE OR REPLACE FUNCTION
    // record_work_item_worked_by_history`, which would silently revert the
    // first_claimed_at stamp that 1037 adds to that same function. Replaying 1037
    // after it restores the production end state; drop it and this file would
    // green against the PRE-FIX function while claiming to test the fixed one.
    for (const file of [
      '797-guard-engineer-issues-terminal-state.sql.PENDING-CODE-DEPLOY',
      '799-guard-797-message-self-diagnosis.sql',
      '804-fix-terminal-close-staging-remedy.sql',
      '806-work-item-worked-history.sql',
      '1037-work-item-first-claim-stamp.sql',
    ]) {
      await client.unsafe(await readFile(join(SQL_DIR, file), 'utf8'));
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'worked-history', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

async function seed(id: string, itemKind: string, origin = 'local') {
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, payload)
    VALUES
      ('default', 'worked-history', ${id}, ${id}, 'history test', 'open', ${itemKind}, ${origin}, '{}'::jsonb)`;
}

async function history(id: string): Promise<Array<{ owner?: string; at?: string }>> {
  const rows = await sql<{ worked_by_history: Array<{ owner?: string; at?: string }> | null }[]>`
    SELECT worked_by_history FROM harness_shared.work_items
     WHERE workspace_id = 'default' AND feature_id = ${id}`;
  return rows[0]?.worked_by_history ?? [];
}

describe('migration 806 — shared-base worked_by_history writer', () => {
  it('records one owner on claim and release, but not on an idempotent same-holder update', async () => {
    await seed('WI-history-feature', 'feature');

    await sql`
      UPDATE harness_shared.work_items
         SET taken_by = 'su-history'
       WHERE workspace_id = 'default' AND feature_id = 'WI-history-feature'`;
    expect(await history('WI-history-feature')).toHaveLength(1);
    expect((await history('WI-history-feature'))[0]?.owner).toBe('su-history');

    await sql`
      UPDATE harness_shared.work_items
         SET taken_by = 'su-history', title = 'same holder'
       WHERE workspace_id = 'default' AND feature_id = 'WI-history-feature'`;
    expect(await history('WI-history-feature')).toHaveLength(1);

    await sql`
      UPDATE harness_shared.work_items
         SET taken_by = NULL
       WHERE workspace_id = 'default' AND feature_id = 'WI-history-feature'`;
    const entries = await history('WI-history-feature');
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.owner)).toEqual(['su-history', 'su-history']);
    expect(entries.every((entry) => typeof entry.at === 'string' && entry.at.length > 0)).toBe(true);
  });

  it('covers engineer_issues view writes because they land on the same base table', async () => {
    await seed('EI-history-issue', 'bug');

    await sql`
      UPDATE harness_shared.engineer_issues
         SET assignee = 'su-issue'
       WHERE workspace_id = 'default' AND issue_id = 'EI-history-issue'`;
    expect((await history('EI-history-issue')).map((entry) => entry.owner)).toEqual(['su-issue']);

    await sql`
      UPDATE harness_shared.engineer_issues
         SET assignee = NULL
       WHERE workspace_id = 'default' AND issue_id = 'EI-history-issue'`;
    expect((await history('EI-history-issue')).map((entry) => entry.owner)).toEqual(['su-issue', 'su-issue']);
  });

  it('does not turn remote projection churn into local prior-worker attribution', async () => {
    await seed('WI-history-remote', 'bug', 'remote');
    await sql`
      UPDATE harness_shared.work_items
         SET taken_by = 'peer-agent', fed_ts = 1
       WHERE workspace_id = 'default' AND feature_id = 'WI-history-remote'`;
    expect(await history('WI-history-remote')).toEqual([]);
  });
});

/**
 * Non-su modernization P-001 / R-46 qualification of THIS writer, not a claim
 * that prior-worker attribution is already a complete custody witness. The
 * positive control must retain a whole interval; the negative controls expose
 * paths for which endpoint equality plus worked_by_history cannot prove one.
 * Every mutation below is confined to createFreshTestDb's disposable database.
 * Keep these characterizations when adding capture at the existing audit seam:
 * a future witness must detect them from independent evidence, not relabel an
 * unchanged history array as proof that no transition occurred.
 */
describe('R-46 qualification — holder-history interval and evidence boundaries', () => {
  it('retains transfer/restore and release/reclaim history beyond five entries', async () => {
    const id = 'WI-custody-long-interval';
    await seed(id, 'feature');
    await claim(id, 'su-original');
    const baseline = await history(id);
    const expected = ['su-original'];

    for (let i = 0; i < 6; i += 1) {
      await claim(id, `su-other-${i}`);
      await claim(id, 'su-original');
      expected.push(`su-other-${i}`, 'su-original');
    }
    await claim(id, null);
    await claim(id, 'su-original');
    expected.push('su-original', 'su-original');

    const actual = await history(id);
    expect(actual.map(entry => entry.owner)).toEqual(expected);
    expect(actual.slice(0, baseline.length)).toEqual(baseline);
    expect(actual.length).toBeGreaterThan(5);
    expect(actual.every(entry => typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at)))).toBe(true);
    const [row] = await sql`
      SELECT taken_by FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
    expect(row?.taken_by).toBe('su-original');
    expect(actual).not.toEqual(baseline);
  });

  it('cannot witness a local transfer/restore when each write also advances fed_ts', async () => {
    const id = 'WI-custody-fed-clock-gap';
    await seed(id, 'feature');
    await claim(id, 'su-original');
    const baseline = await history(id);

    // This is a LOCAL row, unlike the existing remote-projection control. The
    // function's fed_ts guard returns before recording either real transition.
    for (const holder of ['su-other', 'su-original']) {
      await sql`
        UPDATE harness_shared.work_items
           SET taken_by = ${holder}, fed_ts = COALESCE(fed_ts, 0) + 1
         WHERE workspace_id = 'default' AND feature_id = ${id}`;
      const [row] = await sql`
        SELECT taken_by, origin FROM harness_shared.work_items
         WHERE workspace_id = 'default' AND feature_id = ${id}`;
      expect(row).toMatchObject({ taken_by: holder, origin: 'local' });
    }
    expect(await history(id)).toEqual(baseline);
  });

  it('does not protect the history prefix from direct replacement or truncation', async () => {
    const id = 'WI-custody-history-replacement';
    await seed(id, 'feature');
    await claim(id, 'su-original');
    const baseline = await history(id);
    expect(baseline).toHaveLength(1);

    // UPDATE OF taken_by does not fire for a history-only write. Restoring the
    // exact prefix afterwards also leaves no trace in this field itself.
    await sql`
      UPDATE harness_shared.work_items SET worked_by_history = '[]'::jsonb
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
    expect(await history(id)).toEqual([]);
    await sql`
      UPDATE harness_shared.work_items SET worked_by_history = ${sql.json(baseline)}::jsonb
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
    expect(await history(id)).toEqual(baseline);
  });

  it('captures normal content and claims in the outbox but not history-only replacement/restoration', async () => {
    const id = 'WI-custody-outbox-boundary';
    await seed(id, 'feature');
    const outboxCount = async () => {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
         WHERE workspace_id = 'default' AND harness_slug = 'worked-history'
           AND table_name = 'harness_features_consolidated' AND key = ${id}`;
      return row!.n;
    };

    // A missing or disabled capture writer must fail the positive control,
    // rather than make an empty outbox look like an observed omission.
    const inserted = await outboxCount();
    expect(inserted).toBeGreaterThan(0);
    await sql`
      UPDATE harness_shared.work_items SET title = 'normal content control'
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
    const content = await outboxCount();
    expect(content).toBeGreaterThan(inserted);
    await claim(id, 'su-original');
    const claimed = await outboxCount();
    expect(claimed).toBeGreaterThan(content);
    const baseline = await history(id);
    expect(baseline).toHaveLength(1);

    // Migration 1226 compares the feature wire projection. Local history is
    // deliberately outside it, so even an active federation capture is not a
    // substitute for independent history-mutation evidence.
    await sql`
      UPDATE harness_shared.work_items SET worked_by_history = '[]'::jsonb
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
    expect(await history(id)).toEqual([]);
    expect(await outboxCount()).toBe(claimed);
    await sql`
      UPDATE harness_shared.work_items SET worked_by_history = ${sql.json(baseline)}::jsonb
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
    expect(await history(id)).toEqual(baseline);
    expect(await outboxCount()).toBe(claimed);
  });

  it('does not reconstruct custody from an inserted held row or a deleted/reseeded identity', async () => {
    const id = 'WI-custody-delete-reseed';
    await seed(id, 'feature');
    await claim(id, 'su-original');
    expect(await history(id)).toHaveLength(1);
    await sql`
      DELETE FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, taken_by, payload)
      VALUES ('default', 'worked-history', ${id}, ${id}, 'history test', 'open', 'feature', 'local', 'su-original', '{}'::jsonb)`;

    const [row] = await sql`
      SELECT taken_by FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
    expect(row?.taken_by).toBe('su-original');
    expect(await history(id)).toEqual([]);
  });

  it('cannot prove continuity across a disabled and subsequently restored trigger', async () => {
    const id = 'WI-custody-disabled-trigger';
    await seed(id, 'feature');
    await claim(id, 'su-original');
    const baseline = await history(id);

    await sql.unsafe('ALTER TABLE harness_shared.work_items DISABLE TRIGGER record_work_item_worked_by_history_trg');
    try {
      await claim(id, 'su-other');
      await claim(id, 'su-original');
    } finally {
      await sql.unsafe('ALTER TABLE harness_shared.work_items ENABLE TRIGGER record_work_item_worked_by_history_trg');
    }

    const [trigger] = await sql`
      SELECT tgenabled FROM pg_trigger
       WHERE tgrelid = 'harness_shared.work_items'::regclass
         AND tgname = 'record_work_item_worked_by_history_trg'`;
    expect(trigger?.tgenabled).toBe('O');
    expect(await history(id)).toEqual(baseline);
  });

  it('keeps a same-holder positive control stable across more than five writes', async () => {
    const id = 'WI-custody-no-transition';
    await seed(id, 'feature');
    await claim(id, 'su-original');
    const baseline = await history(id);
    expect(baseline).toHaveLength(1);

    for (let i = 0; i < 8; i += 1) {
      await sql`
        UPDATE harness_shared.harness_features_consolidated
           SET taken_by = 'su-original', title = ${`same holder ${i}`}
         WHERE workspace_id = 'default' AND feature_id = ${id}`;
    }
    const [row] = await sql`
      SELECT taken_by, title FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
    expect(row).toMatchObject({ taken_by: 'su-original', title: 'same holder 7' });
    expect(await history(id)).toEqual(baseline);
  });

  it('cannot infer a zero terminal/reopen suffix from unchanged holder history', async () => {
    const id = 'WI-custody-terminal-reopen';
    await seed(id, 'feature');
    await claim(id, 'su-original');
    const baseline = await history(id);
    const intents = new Set<string>();

    // Exercise real terminal and reopen writes with all production triggers
    // enabled. The holder is deliberately unchanged throughout the interval.
    for (let i = 0; i < 7; i += 1) {
      await sql`
        UPDATE harness_shared.work_items SET status = 'passed'
         WHERE workspace_id = 'default' AND feature_id = ${id}`;
      const [closed] = await sql`
        SELECT status, payload->>'_completionEventIntentId' AS intent
          FROM harness_shared.work_items
         WHERE workspace_id = 'default' AND feature_id = ${id}`;
      expect(closed?.status).toBe('passed');
      expect(typeof closed?.intent).toBe('string');
      intents.add(closed!.intent);
      await sql`
        UPDATE harness_shared.work_items SET status = 'open'
         WHERE workspace_id = 'default' AND feature_id = ${id}`;
      const [reopened] = await sql`
        SELECT status, payload->>'_completionEventIntentId' AS intent
          FROM harness_shared.work_items
         WHERE workspace_id = 'default' AND feature_id = ${id}`;
      expect(reopened).toMatchObject({ status: 'open', intent: null });
    }
    expect(intents.size).toBe(7);
    expect(await history(id)).toEqual(baseline);
  });

  it('cannot detect a replaced/restored history function from its endpoint definition', async () => {
    const id = 'WI-custody-replaced-function';
    await seed(id, 'feature');
    await claim(id, 'su-original');
    const baseline = await history(id);
    const definition = async () => {
      const [row] = await sql`
        SELECT pg_get_functiondef('harness_shared.record_work_item_worked_by_history()'::regprocedure) AS body`;
      return row!.body as string;
    };
    const original = await definition();
    await sql.unsafe(`CREATE OR REPLACE FUNCTION harness_shared.record_work_item_worked_by_history()
      RETURNS trigger LANGUAGE plpgsql AS $gap$ BEGIN RETURN NEW; END; $gap$`);
    try {
      expect(await definition()).not.toBe(original);
      await claim(id, 'su-other');
      await claim(id, 'su-original');
    } finally {
      await sql.unsafe(original);
    }
    expect(await definition()).toBe(original);
    expect(await history(id)).toEqual(baseline);
    // Prove restoration actually executes, rather than trusting its text.
    await claim(id, 'su-after-restore');
    expect((await history(id)).at(-1)?.owner).toBe('su-after-restore');
  });

  it('cannot infer uninterrupted outbox capture from a restored enabled trigger', async () => {
    const id = 'WI-custody-disabled-capture';
    await seed(id, 'feature');
    await claim(id, 'su-original');
    const count = async () => {
      const [row] = await sql`
        SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
         WHERE workspace_id = 'default' AND harness_slug = 'worked-history'
           AND table_name = 'harness_features_consolidated' AND key = ${id}`;
      return row!.n as number;
    };
    const before = await count();
    expect(before).toBeGreaterThan(0);
    const prefix = await history(id);
    await sql.unsafe('ALTER TABLE harness_shared.work_items DISABLE TRIGGER capture_work_items_feature_upd_trg');
    try {
      await claim(id, 'su-other');
      await claim(id, 'su-original');
    } finally {
      await sql.unsafe('ALTER TABLE harness_shared.work_items ENABLE TRIGGER capture_work_items_feature_upd_trg');
    }
    const [trigger] = await sql`
      SELECT tgenabled FROM pg_trigger
       WHERE tgrelid = 'harness_shared.work_items'::regclass
         AND tgname = 'capture_work_items_feature_upd_trg'`;
    expect(trigger?.tgenabled).toBe('O');
    expect(await count()).toBe(before);
    expect((await history(id)).slice(prefix.length).map(entry => entry.owner))
      .toEqual(['su-other', 'su-original']);
    await claim(id, 'su-after-restore');
    expect(await count()).toBeGreaterThan(before);
  });

  it('cannot qualify a DDL event trigger from equal enabled endpoints and its own audit rows', async () => {
    // Qualify the proposed existing-seam extension before trusting it: a DDL
    // event trigger records ordinary ALTER TABLE, but cannot witness its own
    // disabled/restored interval. Everything here is in createFreshTestDb.
    await sql.unsafe(`CREATE FUNCTION harness_shared.r46_ddl_probe()
      RETURNS event_trigger LANGUAGE plpgsql AS $probe$
      BEGIN
        INSERT INTO harness_shared.audit_log
          (id, ts, actor, action, subject, details, workspace_id)
        VALUES (gen_random_uuid()::text,
          (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
          'private-r46-probe', 'work_items:custody:ddl-probe', 'r46-ddl-probe',
          jsonb_build_object('commandTag', TG_TAG), 'default');
      END; $probe$`);
    await sql.unsafe(`CREATE EVENT TRIGGER r46_ddl_probe
      ON ddl_command_end EXECUTE FUNCTION harness_shared.r46_ddl_probe()`);
    const events = () => sql`
      SELECT id, details->>'commandTag' AS tag FROM harness_shared.audit_log
       WHERE workspace_id = 'default' AND subject = 'r46-ddl-probe'
         AND action = 'work_items:custody:ddl-probe' ORDER BY ts, id`;
    const enabled = async () => {
      const [row] = await sql`SELECT evtenabled FROM pg_event_trigger WHERE evtname = 'r46_ddl_probe'`;
      return row?.evtenabled;
    };
    try {
      expect(await enabled()).toBe('O');
      await sql.unsafe('ALTER TABLE harness_shared.work_items DISABLE TRIGGER capture_work_items_feature_upd_trg');
      await sql.unsafe('ALTER TABLE harness_shared.work_items ENABLE TRIGGER capture_work_items_feature_upd_trg');
      const before = await events();
      expect(before).toHaveLength(2);
      expect(before.map(row => row.tag)).toEqual(['ALTER TABLE', 'ALTER TABLE']);

      await sql.unsafe('ALTER EVENT TRIGGER r46_ddl_probe DISABLE');
      await sql.unsafe('ALTER TABLE harness_shared.work_items DISABLE TRIGGER capture_work_items_feature_upd_trg');
      await sql.unsafe('ALTER TABLE harness_shared.work_items ENABLE TRIGGER capture_work_items_feature_upd_trg');
      await sql.unsafe('ALTER EVENT TRIGGER r46_ddl_probe ENABLE');
      expect(await enabled()).toBe('O');
      expect(await events()).toEqual(before);

      // The recorder really resumes; an empty interval is still not a zero.
      await sql.unsafe('ALTER TABLE harness_shared.work_items DISABLE TRIGGER capture_work_items_feature_upd_trg');
      await sql.unsafe('ALTER TABLE harness_shared.work_items ENABLE TRIGGER capture_work_items_feature_upd_trg');
      expect(await events()).toHaveLength(4);
    } finally {
      await sql.unsafe('ALTER TABLE harness_shared.work_items ENABLE TRIGGER capture_work_items_feature_upd_trg');
      await sql.unsafe('DROP EVENT TRIGGER IF EXISTS r46_ddl_probe');
      await sql.unsafe('DROP FUNCTION IF EXISTS harness_shared.r46_ddl_probe()');
    }
  });

  it('omits a holder transition before the later stamp normalizes remote origin', async () => {
    const id = 'WI-custody-origin-restore';
    await seed(id, 'feature');
    await claim(id, 'su-original');
    const baseline = await history(id);
    expect(baseline).toHaveLength(1);

    // Qualify the base-table branch used by origin-heal writers. This is not
    // an invocation of selfHealOwnNodeOriginIfStranded: its author-key and
    // workspace checks have their own operator-core integration suite.
    await sql`
      UPDATE harness_shared.work_items SET origin = 'remote'
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
    const [remote] = await sql`
      SELECT origin FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
    expect(remote?.origin).toBe('remote');
    await claim(id, 'su-other');
    const [changed] = await sql`
      SELECT taken_by, origin FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
    // record_work_item_worked_by_history runs before the federation stamp.
    // It skips NEW.origin='remote', then the stamp normalizes the local write.
    expect(changed).toMatchObject({ taken_by: 'su-other', origin: 'local' });
    expect(await history(id)).toEqual(baseline);
    await claim(id, 'su-original');
    const [restored] = await sql`
      SELECT taken_by, origin FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
    expect(restored).toMatchObject({ taken_by: 'su-original', origin: 'local' });
    // Recording resumes, but cannot reconstruct the omitted su-other entry.
    expect((await history(id)).slice(baseline.length).map(entry => entry.owner))
      .toEqual(['su-original']);
  });

  it('does not witness a changed and restored physical key or author identity', async () => {
    const id = 'WI-custody-key-restore';
    const movedId = 'WI-custody-key-moved';
    await seed(id, 'feature');
    await claim(id, 'su-original');
    const baseline = await history(id);
    expect(baseline).toHaveLength(1);
    const [before] = await sql`
      SELECT author_pubkey FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND harness_slug = 'worked-history' AND feature_id = ${id}`;

    await sql`
      UPDATE harness_shared.work_items
         SET harness_slug = 'worked-history-moved', feature_id = ${movedId}, author_pubkey = 'r46-moved-author'
       WHERE workspace_id = 'default' AND harness_slug = 'worked-history' AND feature_id = ${id}`;
    const originalKey = await sql`
      SELECT feature_id FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND harness_slug = 'worked-history' AND feature_id = ${id}`;
    expect(originalKey).toHaveLength(0);
    const [moved] = await sql`
      SELECT taken_by, author_pubkey, worked_by_history FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND harness_slug = 'worked-history-moved' AND feature_id = ${movedId}`;
    expect(moved).toMatchObject({ taken_by: 'su-original', author_pubkey: 'r46-moved-author', worked_by_history: baseline });

    await sql`
      UPDATE harness_shared.work_items
         SET harness_slug = 'worked-history', feature_id = ${id}, author_pubkey = ${before!.author_pubkey}
       WHERE workspace_id = 'default' AND harness_slug = 'worked-history-moved' AND feature_id = ${movedId}`;
    const [restored] = await sql`
      SELECT taken_by, author_pubkey FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND harness_slug = 'worked-history' AND feature_id = ${id}`;
    expect(restored).toMatchObject({ taken_by: 'su-original', author_pubkey: before!.author_pubkey });
    expect(await history(id)).toEqual(baseline);
    const movedKey = await sql`
      SELECT feature_id FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND harness_slug = 'worked-history-moved' AND feature_id = ${movedId}`;
    expect(movedKey).toHaveLength(0);
  });

  it('does not make processed outbox rows into retained interval evidence', async () => {
    const id = 'WI-custody-outbox-retention';
    await seed(id, 'feature');
    await claim(id, 'su-original');
    for (let i = 0; i < 6; i += 1) {
      await claim(id, `su-other-${i}`);
      await claim(id, 'su-original');
    }
    const retainedHistory = await history(id);
    expect(retainedHistory.length).toBeGreaterThan(5);
    const rows = await sql`
      UPDATE harness_shared.substrate_outbox SET drained_at = 1
       WHERE workspace_id = 'default' AND harness_slug = 'worked-history'
         AND table_name = 'harness_features_consolidated' AND key = ${id}
       RETURNING id`;
    expect(rows.length).toBeGreaterThan(5);
    // Characterize deletability under the drainer's processed-row predicate,
    // in bounded batches. This is not a claim to have run the background GC.
    let removed = 0;
    for (;;) {
      const deleted = await sql`
        WITH batch AS (
          SELECT id FROM harness_shared.substrate_outbox
           WHERE workspace_id = 'default' AND harness_slug = 'worked-history'
             AND table_name = 'harness_features_consolidated' AND key = ${id}
             AND drained_at IS NOT NULL AND drained_at < 2
             AND (to_jsonb(substrate_outbox.*)->>'fanout_retry_at') IS NULL
           ORDER BY id LIMIT 2 FOR UPDATE SKIP LOCKED
        ) DELETE FROM harness_shared.substrate_outbox o USING batch
           WHERE o.id = batch.id RETURNING o.id`;
      removed += deleted.length;
      if (deleted.length === 0) break;
    }
    expect(removed).toBe(rows.length);
    const [remaining] = await sql`
      SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
       WHERE workspace_id = 'default' AND harness_slug = 'worked-history'
         AND table_name = 'harness_features_consolidated' AND key = ${id}`;
    expect(remaining?.n).toBe(0);
    expect(await history(id)).toEqual(retainedHistory);
  });
});

async function firstClaimedAt(id: string): Promise<string | null> {
  const rows = await sql<{ first_claimed_at: string | null }[]>`
    SELECT first_claimed_at FROM harness_shared.work_items
     WHERE workspace_id = 'default' AND feature_id = ${id}`;
  return rows[0]?.first_claimed_at ?? null;
}

const claim = (id: string, holder: string | null) => sql`
  UPDATE harness_shared.work_items
     SET taken_by = ${holder}
   WHERE workspace_id = 'default' AND feature_id = ${id}`;

/**
 * Migration 1037 — the first_claimed_at writer (work-queue-admission-and-bulk-dedup
 * D-003).
 *
 * The column shipped in 952 with two readers and NO writer, so it was NULL on every
 * row and both readers reported an empty sample forever — which reads exactly like a
 * healthy system rather than a broken one. These cases pin the writer's semantics at
 * the base table, where one trigger covers all four claim call sites (three of which
 * write through the harness_features_consolidated view, which does not even expose
 * this column).
 *
 * CORRECTION TO 1037'S OWN HEADER (that file is applied, so the migration-immutability
 * guard refuses an edit to it; this is the live copy of the reasoning). 1037 justifies
 * skipping the backfill partly by "~19 holder transitions/hour on admitted rows, so the
 * readers populate within the hour". The RATE is real but the inference is wrong: those
 * transitions are overwhelmingly RE-claims of rows whose first claim predates this
 * writer, and set-once means a re-claim stamps nothing. Measured minutes after 1037 went
 * live: 142 rows stamped and climbing, while admitted-AND-stamped was still exactly 0 —
 * the populations are disjoint. What actually populates the readers is the standing pool
 * of admitted-but-never-claimed rows (331 of 830 at the time), each yielding one sample
 * on its first claim, replenished at ~12 admissions/hour. The backfill-skip decision
 * stands on that; it does not stand on the claim-churn rate.
 */
describe('migration 1037 — first_claimed_at stamp', () => {
  it('stamps on the first real claim', async () => {
    await seed('WI-fc-basic', 'feature');
    expect(await firstClaimedAt('WI-fc-basic')).toBeNull();

    await claim('WI-fc-basic', 'su-first');
    expect(await firstClaimedAt('WI-fc-basic')).not.toBeNull();
  });

  it('is SET-ONCE: a release and re-claim keeps the original stamp', async () => {
    await seed('WI-fc-setonce', 'feature');
    await claim('WI-fc-setonce', 'su-one');
    const original = await firstClaimedAt('WI-fc-setonce');
    expect(original).not.toBeNull();

    // taken_at is cleared by release; first_claimed_at must NOT be. That divergence
    // is the entire reason the column exists rather than reusing taken_at.
    await claim('WI-fc-setonce', null);
    expect(await firstClaimedAt('WI-fc-setonce')).toEqual(original);

    await claim('WI-fc-setonce', 'su-two');
    expect(await firstClaimedAt('WI-fc-setonce')).toEqual(original);

    const rows = await sql<{ taken_at: string | null }[]>`
      SELECT taken_at FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND feature_id = 'WI-fc-setonce'`;
    expect(rows[0]?.taken_at).toBeNull();
  });

  it('never stamps on a release-only transition', async () => {
    await seed('WI-fc-release', 'feature');
    // A real holder transition (history records it) that is NOT a claim.
    await claim('WI-fc-release', null);
    expect(await firstClaimedAt('WI-fc-release')).toBeNull();
  });

  it('ignores the legacy unassigned sentinel', async () => {
    await seed('WI-fc-sentinel', 'feature');
    await claim('WI-fc-sentinel', 'unassigned');
    expect(await firstClaimedAt('WI-fc-sentinel')).toBeNull();
  });

  it('does not stamp remote projection churn', async () => {
    await seed('WI-fc-remote', 'bug', 'remote');
    await sql`
      UPDATE harness_shared.work_items
         SET taken_by = 'peer-agent', fed_ts = 1
       WHERE workspace_id = 'default' AND feature_id = 'WI-fc-remote'`;
    expect(await firstClaimedAt('WI-fc-remote')).toBeNull();
  });

  it('the TRIGGER owns the column on a claim: an explicit value in the same UPDATE loses', async () => {
    // Deliberate, not accidental. On the transaction that actually performs the
    // claim, the observed stamp beats a caller-supplied one — a caller passing a
    // different first_claimed_at *while claiming* is describing an event this
    // trigger is watching happen. Nothing in the tree does this today (the one
    // fixture that writes the column never touches taken_by, so it never fires
    // this path), and the legitimate replay case — a peer's row carrying its own
    // history — is already excluded by the remote/fed_ts guard above.
    // If an import path ever needs to supply a true historical value, the change
    // is COALESCE(OLD.first_claimed_at, NEW.first_claimed_at, clock_timestamp())
    // in a NEW migration; 1037 is applied and immutable.
    await seed('WI-fc-explicit', 'feature');
    const supplied = '2020-01-02T03:04:05Z';
    await sql`
      UPDATE harness_shared.work_items
         SET taken_by = 'su-explicit', first_claimed_at = ${supplied}::timestamptz
       WHERE workspace_id = 'default' AND feature_id = 'WI-fc-explicit'`;

    const actual = await firstClaimedAt('WI-fc-explicit');
    expect(actual).not.toBeNull();
    expect(new Date(actual as string).getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('covers view writes, because three of the four claim sites are view writes', async () => {
    await seed('EI-fc-issue', 'bug');
    await sql`
      UPDATE harness_shared.engineer_issues
         SET assignee = 'su-via-view'
       WHERE workspace_id = 'default' AND issue_id = 'EI-fc-issue'`;
    expect(await firstClaimedAt('EI-fc-issue')).not.toBeNull();
  });
});

/**
 * FALSIFIABILITY CONTROL for the block above.
 *
 * A guard that has only ever been green is not evidence: every assertion above
 * would pass identically against a trigger that stamped the column unconditionally,
 * or against some OTHER migration having done the work. This drives the function
 * both ways on the disposable test database — never the shared tree, where a
 * git-sync sweep can commit a mutation even when nothing goes wrong.
 *
 * It also pins the specific regression this file is most exposed to: 806 and 1037
 * define the SAME function, so replaying 806 after 1037 silently reverts the stamp.
 * That is not hypothetical — 806 was itself edited on disk after applying and never
 * re-ran, which is why migration 1036 had to exist.
 */
describe('migration 1037 — the control that makes the cases above discriminating', () => {
  it('PRE-FIX (806 body) does not stamp, and restoring 1037 makes it stamp again', async () => {
    // 1. Revert to the pre-fix function by replaying 806 alone.
    await sql.unsafe(await readFile(join(SQL_DIR, '806-work-item-worked-history.sql'), 'utf8'));

    await seed('WI-fc-control-pre', 'feature');
    await claim('WI-fc-control-pre', 'su-control');
    // The claim genuinely happened — history proves the trigger ran at all, so a
    // null stamp here is the ABSENT WRITER, not an inert or missing trigger.
    expect(await history('WI-fc-control-pre')).toHaveLength(1);
    expect(await firstClaimedAt('WI-fc-control-pre')).toBeNull();

    // 2. Restore the fix and prove the same claim now stamps.
    await sql.unsafe(await readFile(join(SQL_DIR, '1037-work-item-first-claim-stamp.sql'), 'utf8'));

    await seed('WI-fc-control-post', 'feature');
    await claim('WI-fc-control-post', 'su-control');
    expect(await history('WI-fc-control-post')).toHaveLength(1);
    expect(await firstClaimedAt('WI-fc-control-post')).not.toBeNull();
  });
});
