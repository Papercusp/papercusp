/**
 * engineer-issues-view-dml.integration.test.ts — EI-7490.
 *
 * Guards the `engineer_issues` compat view trigger against duplicate EI ids
 * introduced by federation. Ordinary UPDATEs must not normalize a legacy
 * empty-slug operator row onto `operator:<workspace>` and collide with an
 * existing local row.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts \
 *     src/engineer-issues-view-dml.integration.test.ts
 */
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, '..', 'sql');
const RUNNER = join(here, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');
const GUIDANCE_MIGRATION = '1089-fix-stale-terminal-close-guidance.sql';

function migrationPath(name: string): string {
  const armed = join(SQL_DIR, name);
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration ${name} not found at ${armed}[.DRAFT]`);
}

const GUIDANCE_MIGRATION_SQL = readFileSync(migrationPath(GUIDANCE_MIGRATION), 'utf8');

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
      throw new Error(`engineer-issues-view-dml provision: applied ${appliedCount}/${totalKnown}`);
    }

    /**
     * The terminal-lifecycle guard is migration 797, which is PARKED on disk
     * (`.sql.PENDING-CODE-DEPLOY`) even though it is recorded APPLIED on the live
     * database — it was armed, applied, then re-parked pending the base-table
     * writer deploy. The runner filters to `*.sql`, so a fresh test database gets
     * NO guard, and every assertion in "engineer_issues terminal lifecycle
     * boundary" below fails against an absence rather than against behaviour.
     * (Measured 2026-08-12: 4 failed / 6 passed for exactly this reason, two of
     * those failures pre-dating migration 799.)
     *
     * So model the live database: apply the parked guard, then re-apply 799 and
     * 804 — both are idempotent and, having already no-op'd during the ordered
     * run above (no guard existed yet), install the current stale-operator
     * diagnosis now.
     */
    for (const file of [
      '797-guard-engineer-issues-terminal-state.sql.PENDING-CODE-DEPLOY',
      '799-guard-797-message-self-diagnosis.sql',
      '804-fix-terminal-close-staging-remedy.sql',
    ]) {
      await client.unsafe(await readFile(join(SQL_DIR, file), 'utf8'));
    }
    // 1089 is kept parked while it is authored. Apply the real draft/final
    // migration explicitly so this suite exercises its idempotent fresh-DB path
    // before the live-body regression below rewrites the function to the older
    // already-applied-804 shape.
    await client.unsafe(GUIDANCE_MIGRATION_SQL);
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;
let legacyIdentityFixtureOpen = false;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'eidml', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

afterEach(async () => {
  if (legacyIdentityFixtureOpen) {
    try {
      await sql.unsafe('ROLLBACK');
      const [identity] = await sql<{ restored: boolean }[]>`
        SELECT to_regclass('harness_shared.work_items_workspace_feature_id_uq') IS NOT NULL AS restored`;
      expect(identity.restored, 'historical fixture must restore the current identity index').toBe(true);
    } finally {
      legacyIdentityFixtureOpen = false;
    }
  }
});

async function seedDuplicateIssueRows(issueId: string): Promise<void> {
  // Migration 1444 now forbids same-workspace twins. These regression cases
  // exercise the compatibility view against historical pre-1444 data. Rewind
  // only that index inside this private fixture transaction; afterEach restores
  // both the index and data, including when an assertion fails.
  await sql.unsafe('BEGIN');
  legacyIdentityFixtureOpen = true;
  await sql.unsafe('DROP INDEX harness_shared.work_items_workspace_feature_id_uq');
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status,
       item_kind, origin, ts, created_ts, updated_ts, payload)
    VALUES
      ('ws1', '', ${issueId}, 'remote replication signal', 'remote body', 'open',
       'bug', 'remote', 1000, 1000, 1000,
       '{"_ei":{"scope":"operator","severity":"major","source":"engineer","created_by":"system:replication-liveness"}}'::jsonb),
      ('ws1', 'operator:ws1', ${issueId}, 'local improvement', 'local body', 'open',
       'change', 'local', 2000, 2000, 2000,
       '{"_ei":{"scope":"operator","severity":"minor","source":"su","created_by":"su-test"}}'::jsonb)`;
}

describe('engineer_issues view DML duplicate-id targeting', () => {
  it('keeps the current workspace identity constraint outside the historical fixture', async () => {
    const issueId = 'EI-900000';
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, created_ts, updated_ts)
      VALUES ('ws1', 'operator:ws1', ${issueId}, 'resident', 'open', 'bug', 'local', 1, 1)`;
    await expect(sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, created_ts, updated_ts)
      VALUES ('ws1', '', ${issueId}, 'twin', 'open', 'bug', 'remote', 1, 1)`
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'work_items_workspace_feature_id_uq' });
  });

  it('updates duplicate logical issue ids without pkey collision, row collapse, or remote mutation', async () => {
    const issueId = 'EI-900001';
    await seedDuplicateIssueRows(issueId);

    await sql`
      UPDATE harness_shared.engineer_issues
         SET payload = COALESCE(payload, '{}'::jsonb) || '{"touched":true}'::jsonb,
             body = body || ' touched'
       WHERE workspace_id = 'ws1' AND issue_id = ${issueId}`;

    const rows = await sql<{ harness_slug: string; origin: string; summary: string; touched: boolean | null }[]>`
      SELECT harness_slug, origin, summary, (payload->>'touched')::boolean AS touched
        FROM harness_shared.work_items
       WHERE workspace_id = 'ws1' AND feature_id = ${issueId}
       ORDER BY harness_slug, origin`;

    expect(rows).toEqual([
      { harness_slug: '', origin: 'remote', summary: 'remote body', touched: null },
      { harness_slug: 'operator:ws1', origin: 'local', summary: 'local body touched', touched: true },
    ]);
  });

  it('does not mutate a remote physical row even when the view UPDATE targets it', async () => {
    const issueId = 'EI-900002';
    await seedDuplicateIssueRows(issueId);

    await sql`
      UPDATE harness_shared.engineer_issues
         SET scope = 'harness:remote-peer'
       WHERE workspace_id = 'ws1'
         AND issue_id = ${issueId}
         AND origin = 'remote'
         AND base_harness_slug = ''`;

    const rows = await sql<{ harness_slug: string; origin: string; scope: string; summary: string }[]>`
      SELECT wi.harness_slug, wi.origin, ei.scope, wi.summary
        FROM harness_shared.work_items wi
        JOIN harness_shared.engineer_issues ei
          ON ei.workspace_id = wi.workspace_id
         AND ei.issue_id = wi.feature_id
         AND ei.origin = wi.origin
         AND ei.base_harness_slug = wi.harness_slug
       WHERE wi.workspace_id = 'ws1' AND wi.feature_id = ${issueId}
       ORDER BY wi.harness_slug, wi.origin`;

    expect(rows).toEqual([
      { harness_slug: '', origin: 'remote', scope: 'operator', summary: 'remote body' },
      { harness_slug: 'operator:ws1', origin: 'local', scope: 'operator', summary: 'local body' },
    ]);
  });
});

describe('engineer_issues terminal lifecycle boundary', () => {
  it('refuses a view UPDATE that transitions an issue into a terminal state', async () => {
    const issueId = 'EI-900020';
    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, title, body, state, kind, scope, severity)
      VALUES ('ws1', ${issueId}, 'terminal guard', 'body', 'open', 'bug', 'harness:hx', 'minor')`;

    await expect(sql`
      UPDATE harness_shared.engineer_issues
         SET state = 'resolved'
       WHERE workspace_id = 'ws1' AND issue_id = ${issueId}`
    ).rejects.toThrow(/terminal transition refused/);

    const [after] = await sql<{ status: string; terminal_owner: string | null; terminal_completion_ref: string | null }[]>`
      SELECT status, terminal_owner, terminal_completion_ref
        FROM harness_shared.work_items
       WHERE workspace_id = 'ws1' AND feature_id = ${issueId}`;
    expect(after).toEqual({ status: 'open', terminal_owner: null, terminal_completion_ref: null });
  });

  it('does not treat caller-supplied terminal attribution as a view lifecycle bypass', async () => {
    const issueId = 'EI-900021';
    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, title, body, state, kind, scope, severity)
      VALUES ('ws1', ${issueId}, 'terminal guard attributed', 'body', 'open', 'bug', 'harness:hx', 'minor')`;

    await expect(sql`
      UPDATE harness_shared.engineer_issues
         SET state = 'done', terminal_owner = 'agent-a', terminal_completion_ref = 'claimed-ref'
       WHERE workspace_id = 'ws1' AND issue_id = ${issueId}`
    ).rejects.toThrow(/terminal transition refused/);
  });

  /**
   * Migration 804 (EI-20219410123616014), building on migration 799
   * (EI-20202062074776959). The refusal used to name
   * `work_items:set_state` / `work_items:complete` as the fix — which is a closed
   * loop for the caller that hits it most: an operator process whose build
   * predates the base-table lifecycle writer, for which those two tools ARE the
   * thing being refused. A current operator writes `work_items` directly and
   * never reaches this trigger, so a `pcusp:%` client arriving here is
   * necessarily stale, and the guard says so instead. The immediate recovery
   * is to re-post the same payload to the staging operator at :3170; a release
   * redeploy/restart is not required.
   *
   * The discriminator is `application_name`, which the operator tags
   * `pcusp:<pool>:p<pid>` — so these two cases are the whole behavioural
   * contract, and testing only one would let the branch silently collapse.
   */
  it('tells a STALE OPERATOR to repost to staging rather than redeploy', async () => {
    const issueId = 'EI-900022';
    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, title, body, state, kind, scope, severity)
      VALUES ('ws1', ${issueId}, 'stale operator diagnosis', 'body', 'open', 'bug', 'harness:hx', 'minor')`;

    const operatorish = postgres(db.url, {
      max: 1,
      onnotice: () => {},
      connection: { application_name: 'pcusp:org-app:p424242' },
    });
    try {
      const err = await operatorish`
        UPDATE harness_shared.engineer_issues
           SET state = 'done'
         WHERE workspace_id = 'ws1' AND issue_id = ${issueId}`.then(
        () => null,
        (e: unknown) => e as { message: string; hint?: string },
      );

      expect(err, 'the terminal transition must still be refused').not.toBeNull();
      // Still the load-bearing substring every other consumer matches on.
      expect(err!.message).toMatch(/terminal transition refused/);
      // The diagnosis: retrying is futile, the process is stale, and WHICH process.
      expect(err!.message).toMatch(/RE-CALLING work_items:complete/);
      expect(err!.message).toMatch(/staging operator at http:\/\/127\.0\.0\.1:3170\/api\/mcp\?superuser=1/);
      expect(err!.message).toMatch(/ptool.*--url=http:\/\/127\.0\.0\.1:3170 explicitly/);
      expect(err!.message).toMatch(/unsetting PAPERCUSP_OPERATOR_URL leaves ptool on its default :3070/);
      expect(err!.message).toMatch(/redeploy.*not required/i);
      expect(err!.message).toContain('pcusp:org-app:p424242');
      expect(err!.hint ?? '').toMatch(/staging operator at http:\/\/127\.0\.0\.1:3170\/api\/mcp\?superuser=1/);
      expect(err!.hint ?? '').toMatch(/ptool.*--url=http:\/\/127\.0\.0\.1:3170 explicitly/);
      expect(err!.hint ?? '').toMatch(/unsetting PAPERCUSP_OPERATOR_URL.*default at :3070/);
      expect(err!.hint ?? '').toMatch(/optional, not required/i);
    } finally {
      await operatorish.end({ timeout: 5 }).catch(() => {});
    }

    // The guard still refused: nothing was written.
    const [after] = await sql<{ status: string }[]>`
      SELECT status FROM harness_shared.work_items
       WHERE workspace_id = 'ws1' AND feature_id = ${issueId}`;
    expect(after).toEqual({ status: 'open' });
  });

  it('keeps the original instruction for a NON-operator (raw/legacy) UPDATE', async () => {
    const issueId = 'EI-900023';
    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, title, body, state, kind, scope, severity)
      VALUES ('ws1', ${issueId}, 'raw update diagnosis', 'body', 'open', 'bug', 'harness:hx', 'minor')`;

    const err = await sql`
      UPDATE harness_shared.engineer_issues
         SET state = 'done'
       WHERE workspace_id = 'ws1' AND issue_id = ${issueId}`.then(
      () => null,
      (e: unknown) => e as { message: string; hint?: string },
    );

    expect(err, 'the terminal transition must still be refused').not.toBeNull();
    expect(err!.message).toMatch(/use setIssueState\/work_items:set_state or work_items:complete/);
    // A raw caller is NOT told its build is stale — that would be the same
    // misdiagnosis in the other direction.
    expect(err!.message).not.toMatch(/RE-CALLING work_items:complete/);
    expect(err!.hint ?? '').toMatch(/not a lifecycle writer/);
  });

  it('repairs the already-applied 804 direct-URL body with ptool-safe guidance', async () => {
    const issueId = 'EI-900024';
    const [{ def: currentDef }] = await sql<{ def: string }[]>`
      SELECT pg_get_functiondef(p.oid) AS def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'harness_shared' AND p.proname = 'engineer_issues_view_dml'`;

    // This is the exact older function shape observed on the live database:
    // make only the two 804 message literals stale, leaving every accumulated
    // trigger guard and write-path change untouched.
    const correctedRaise = `RAISE EXCEPTION 'engineer_issues terminal transition refused for issue % — and RE-CALLING work_items:complete / work_items:set_state CANNOT FIX IT. This UPDATE arrived on operator connection "%", which still routes terminal state through the engineer_issues compatibility view; a CURRENT operator writes harness_shared.work_items directly and never reaches this trigger. So that process is running code older than issues-engineer.ts EI-20092514168581881, the REQUIRES-DEPLOYED half of migration 797. FIX: re-post the same unmodified work_items:complete / work_items:set_state payload to the staging operator. With ptool, pass --url=http://127.0.0.1:3170 explicitly — unsetting PAPERCUSP_OPERATOR_URL leaves ptool on its default :3070. Direct MCP clients may use the staging operator at http://127.0.0.1:3170/api/mcp?superuser=1. The staging writer updates harness_shared.work_items directly. Redeploying or restarting the release operator is not required. Any completion record you already submitted is stored — only the state flip is outstanding.', NEW.issue_id, COALESCE(current_setting('application_name', true), '?')`;
    const staleRaise = `RAISE EXCEPTION 'engineer_issues terminal transition refused for issue % — and RE-CALLING work_items:complete / work_items:set_state CANNOT FIX IT. This UPDATE arrived on operator connection "%", which still routes terminal state through the engineer_issues compatibility view; a CURRENT operator writes harness_shared.work_items directly and never reaches this trigger. So that process is running code older than issues-engineer.ts EI-20092514168581881, the REQUIRES-DEPLOYED half of migration 797. FIX: re-post the same unmodified work_items:complete / work_items:set_state payload to the staging operator at http://127.0.0.1:3170/api/mcp?superuser=1; it writes harness_shared.work_items directly. Redeploying or restarting the release operator is not required. Any completion record you already submitted is stored — only the state flip is outstanding.', NEW.issue_id, COALESCE(current_setting('application_name', true), '?')`;
    const correctedHintMarker = 'For ptool, pass --url=http://127.0.0.1:3170 explicitly';
    const staleHint = `Re-post the same payload to the staging operator at http://127.0.0.1:3170/api/mcp?superuser=1 on this host; it writes harness_shared.work_items directly. Do not keep retrying this release connection. Redeploying or restarting the release operator is optional, not required.`;
    expect(currentDef).toContain(correctedRaise);
    expect(currentDef).toContain(correctedHintMarker);

    try {
      const staleDef = currentDef
        .replace(correctedRaise, staleRaise)
        .replace(/USING HINT = 'Re-post the same payload to the staging operator on this host\..*?';/, `USING HINT = '${staleHint}';`);
      expect(staleDef).toContain(staleRaise);
      expect(staleDef).toContain(staleHint);
      expect(staleDef).not.toContain('--url=http://127.0.0.1:3170 explicitly');
      await sql.unsafe(staleDef);

      await sql.unsafe(GUIDANCE_MIGRATION_SQL);
      const [{ def: repairedDef }] = await sql<{ def: string }[]>`
        SELECT pg_get_functiondef(p.oid) AS def
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'harness_shared' AND p.proname = 'engineer_issues_view_dml'`;
      expect(repairedDef).toContain(correctedRaise);
      expect(repairedDef).toContain(correctedHintMarker);
      expect(repairedDef).not.toContain(staleRaise);
      expect(repairedDef).not.toContain(staleHint);
      expect(repairedDef).not.toContain('--port 3170');
      expect(repairedDef).toContain("NEW.state IN ('resolved', 'closed', 'done', 'dropped')");

      await sql`
        INSERT INTO harness_shared.engineer_issues
          (workspace_id, issue_id, title, body, state, kind, scope, severity)
        VALUES ('ws1', ${issueId}, 'ptool guidance regression', 'body', 'open', 'bug', 'harness:hx', 'minor')`;
      const operatorish = postgres(db.url, {
        max: 1,
        onnotice: () => {},
        connection: { application_name: 'pcusp:org-app:p424244' },
      });
      try {
        const err = await operatorish`
          UPDATE harness_shared.engineer_issues
             SET state = 'done'
           WHERE workspace_id = 'ws1' AND issue_id = ${issueId}`.then(
          () => null,
          (e: unknown) => e as { message: string; hint?: string },
        );
        expect(err).not.toBeNull();
        expect(err!.message).toContain('--url=http://127.0.0.1:3170 explicitly');
        expect(err!.message).not.toContain('--port 3170');
        expect(err!.hint ?? '').toContain('--url=http://127.0.0.1:3170 explicitly');
        expect(err!.hint ?? '').not.toContain('--port 3170');
      } finally {
        await operatorish.end({ timeout: 5 }).catch(() => {});
      }
    } finally {
      // Keep the remaining tests on the checked-in/current 804 definition even
      // if the migration or the behavioural probe fails.
      await sql.unsafe(currentDef);
    }
  });
});

/**
 * EI-19300744792370081 (root-caused under WI-6752), fixed by migration 711.
 *
 * Both write branches used to end `RETURN NEW`. For an INSTEAD OF trigger the
 * returned row is what a caller's RETURNING clause is evaluated against, so
 * RETURNING handed back THE CALLER'S OWN INPUT re-labelled as a result — never
 * read from `work_items`, and therefore never evidence that anything was stored.
 * `createIssue()` builds `{ created: true, ... }` from exactly that RETURNING.
 *
 * `feature_order` is the probe throughout: it is a real view column that neither
 * the INSERT column list nor the UPDATE SET list mentions, so the trigger silently
 * drops it. That is the mig-679 class (`authority` was dropped the same way, for
 * the same reason, and RETURNING cheerfully echoed it back). If RETURNING is read
 * from storage, a dropped column comes back as stored — visibly not what was sent.
 */
describe('engineer_issues view DML RETURNING reflects storage, not caller input', () => {
  it('INSERT..RETURNING returns the stored row — a column the trigger drops does not echo back', async () => {
    const issueId = 'EI-900010';

    const [returned] = await sql<{ issue_id: string; title: string; kind: string; base_harness_slug: string; feature_order: number | null }[]>`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, title, body, state, kind, scope, severity, feature_order)
      VALUES
        ('ws1', ${issueId}, 'returning probe', 'body', 'open', 'bug', 'harness:hx', 'minor', 42)
      RETURNING issue_id, title, kind, base_harness_slug, feature_order`;

    const [stored] = await sql<{ title: string; item_kind: string; harness_slug: string; feature_order: number | null }[]>`
      SELECT title, item_kind, harness_slug, feature_order
        FROM harness_shared.work_items
       WHERE workspace_id = 'ws1' AND feature_id = ${issueId}`;

    // The regression itself: pre-711 this asserted 42 (the caller's input) against
    // a stored NULL — a fully-formed success built from data nobody ever stored.
    expect(stored.feature_order).toBeNull();
    expect(returned.feature_order).toBeNull();

    // And the columns that DO take must carry their stored values through.
    expect(returned).toMatchObject({
      issue_id: issueId,
      title: stored.title,
      kind: stored.item_kind,
      base_harness_slug: stored.harness_slug,
    });
  });

  it('UPDATE..RETURNING returns the stored row — an ignored SET column does not echo back', async () => {
    const issueId = 'EI-900011';
    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, title, body, state, kind, scope, severity)
      VALUES ('ws1', ${issueId}, 'before', 'body', 'open', 'bug', 'harness:hx', 'minor')`;

    const [returned] = await sql<{ title: string; state: string; feature_order: number | null }[]>`
      UPDATE harness_shared.engineer_issues
         SET title = 'after', state = 'wip', feature_order = 99
       WHERE workspace_id = 'ws1' AND issue_id = ${issueId}
      RETURNING title, state, feature_order`;

    const [stored] = await sql<{ title: string; status: string; feature_order: number | null }[]>`
      SELECT title, status, feature_order
        FROM harness_shared.work_items
       WHERE workspace_id = 'ws1' AND feature_id = ${issueId}`;

    expect(stored).toMatchObject({ title: 'after', status: 'wip', feature_order: null });
    expect(returned).toEqual({ title: 'after', state: 'wip', feature_order: null });
  });

  it('still reports a DECLINED write as zero rows + empty RETURNING (EI-7833 remote skip)', async () => {
    // 711 must not convert a deliberate decline into a spurious success — the
    // federated-row skip and the mig-655 claim-race guard both RETURN NULL, and
    // callers already read `rows[0] === undefined` as "did not happen".
    const issueId = 'EI-900012';
    await seedDuplicateIssueRows(issueId);

    const returned = await sql`
      UPDATE harness_shared.engineer_issues
         SET title = 'should not apply'
       WHERE workspace_id = 'ws1'
         AND issue_id = ${issueId}
         AND origin = 'remote'
         AND base_harness_slug = ''
      RETURNING issue_id, title`;

    expect(returned).toHaveLength(0);

    const [remote] = await sql<{ title: string }[]>`
      SELECT title FROM harness_shared.work_items
       WHERE workspace_id = 'ws1' AND feature_id = ${issueId} AND origin = 'remote'`;
    expect(remote.title).toBe('remote replication signal');
  });

  it('no write branch returns NEW — the structural invariant a future migration must not undo', async () => {
    // The behavioural tests above only cover the columns they probe. This asserts
    // the property itself, so a later full-body CREATE OR REPLACE that restores an
    // older definition reds HERE rather than silently reopening the false-success
    // path. (DELETE returns OLD; the two decline paths return NULL — both fine.)
    const [{ def }] = await sql<{ def: string }[]>`
      SELECT pg_get_functiondef(p.oid) AS def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'harness_shared' AND p.proname = 'engineer_issues_view_dml'`;

    expect(def).not.toContain('RETURN NEW;');
    expect(def.split('RETURN v_stored;').length - 1).toBe(2);
  });
});

describe('engineer_issues issue-family expiry removal', () => {
  it('does not derive an expiry when an assigned issue is inserted through the view', async () => {
    const issueId = 'EI-866001';
    const assignedAt = new Date('2026-08-20T12:34:56.000Z');

    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, title, body, state, kind, scope, severity,
         assignee, assigned_at)
      VALUES
        ('ws1', ${issueId}, 'issue expiry regression', 'body', 'open', 'bug',
         'harness:hx', 'major', 'agent-866', ${assignedAt})`;

    const [stored] = await sql<{ expires_at: Date | null; taken_at: Date | null }[]>`
      SELECT expires_at, taken_at
        FROM harness_shared.work_items
       WHERE workspace_id = 'ws1' AND feature_id = ${issueId}`;

    expect(stored.expires_at).toBeNull();
    expect(stored.taken_at).not.toBeNull();
    expect(new Date(String(stored.taken_at)).toISOString()).toBe(assignedAt.toISOString());
  });

  it('clears historical issue expiry while preserving a feature-family lease', async () => {
    const issueId = 'EI-866002';
    const featureId = 'F-866001';
    const issueExpiry = new Date('2026-08-21T00:00:00.000Z');
    const featureExpiry = new Date('2026-08-22T00:00:00.000Z');

    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status,
         item_kind, expires_at, ts, created_ts, updated_ts, payload)
      VALUES
        ('ws1', 'harness-x', ${issueId}, 'historical issue expiry', 'body', 'open',
         'bug', ${issueExpiry}, 1000, 1000, 1000, '{}'::jsonb),
        ('ws1', 'harness-x', ${featureId}, 'feature lease', 'body', 'todo',
         'feature', ${featureExpiry}, 1000, 1000, 1000, '{}'::jsonb)`;

    await sql.unsafe(await readFile(join(SQL_DIR, '866-clear-issue-expiry.sql'), 'utf8'));

    const rows = await sql<{
      feature_id: string;
      item_kind: string;
      expiry_epoch: number | null;
    }[]>`
      SELECT feature_id, item_kind,
             extract(epoch FROM expires_at)::double precision AS expiry_epoch
        FROM harness_shared.work_items
       WHERE workspace_id = 'ws1'
         AND feature_id IN (${issueId}, ${featureId})
       ORDER BY feature_id`;

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.feature_id === issueId)).toMatchObject({
      item_kind: 'bug',
      expiry_epoch: null,
    });
    expect(rows.find((row) => row.feature_id === featureId)).toMatchObject({
      item_kind: 'feature',
      expiry_epoch: featureExpiry.getTime() / 1000,
    });
  });
});
