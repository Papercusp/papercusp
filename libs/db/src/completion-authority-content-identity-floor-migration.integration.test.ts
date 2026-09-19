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

const migration972Sql = readFileSync(migrationPath('972-completion-authority-content-identity-floor.sql'), 'utf8');
/**
 * EI-21937921955988010: 1044 replaces completion_content_identity_proven() so the floor
 * understands multi-repository completions and out-of-repo artifact citations. It is
 * applied ON TOP of 972 (never instead of it) so this suite keeps proving the ORIGINAL
 * contract survives the replacement, not just the new cases.
 */
const migration1044Sql = readFileSync(migrationPath('1044-completion-identity-multi-repo-artifact-floor.sql'), 'utf8');
/**
 * EI-22381221975733348: 1144 is the forward repair for already-applied 972/1044
 * definitions. Those migration files were later edited to understand deletions,
 * but production had already recorded them and therefore never re-ran the edits.
 */
const migration1144Sql = readFileSync(migrationPath('1144-completion-identity-deletion-artifact-floor.sql'), 'utf8');
/**
 * EI-23577999135289807: 1180 forwards the artifact-only correction without
 * editing the already-applied 1144 migration.
 */
const migration1180Sql = readFileSync(migrationPath('1180-completion-identity-out-of-repo-artifact-floor-followup.sql'), 'utf8');

/**
 * Exact semantic shape observed in production before migration 1144: 1044's
 * artifact exclusion knew nothing about deletions, while 972's trigger scoped
 * the floor to filesChanged only. Recreating it here makes the forward migration
 * necessary; reading today's edited 972/1044 files alone would hide the defect.
 */
const historicalLiveFloorSql = String.raw`
CREATE OR REPLACE FUNCTION harness_shared.completion_content_identity_proven(
  p_identity jsonb
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT p_identity IS NOT NULL
     AND jsonb_typeof(p_identity) = 'array'
     AND jsonb_array_length(p_identity) > 0
     AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_identity) AS e
            WHERE COALESCE((e->>'outOfRepoArtifact')::boolean, false) = false
         )
     AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_identity) AS e
            WHERE COALESCE((e->>'outOfRepoArtifact')::boolean, false) = false
              AND (
                    e->>'workingTreeBlobSha' IS NULL
                 OR e->>'headBlobSha' IS NULL
                 OR e->>'workingTreeBlobSha' <> e->>'headBlobSha'
              )
         )
$fn$;

CREATE OR REPLACE FUNCTION harness_shared.downgrade_unproven_committed_close()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_evidence      jsonb;
  v_files_changed jsonb;
BEGIN
  IF NEW.authority IS DISTINCT FROM 'committed' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.authority = 'committed'
     AND OLD.payload IS NOT DISTINCT FROM NEW.payload THEN
    RETURN NEW;
  END IF;
  v_evidence := NEW.payload->'_completionEvidence';
  IF v_evidence IS NULL THEN
    RETURN NEW;
  END IF;
  v_files_changed := v_evidence->'filesChanged';
  IF jsonb_typeof(v_files_changed) IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_files_changed) = 0 THEN
    RETURN NEW;
  END IF;
  IF harness_shared.completion_content_identity_proven(
       v_evidence->'treeStamp'->'contentIdentity') THEN
    RETURN NEW;
  END IF;
  NEW.authority := 'proposed';
  RETURN NEW;
END;
$fn$;
`;

/**
 * The real migration runner speaks psql, so migration files may carry psql
 * meta-commands (`\set ON_ERROR_STOP on`). postgres.js — even via the simple
 * query protocol — sends text to the server verbatim and `\` is a syntax
 * error there. Strip meta-command lines; BEGIN/COMMIT are real SQL and stay.
 */
async function applyMigrationFile(raw: string): Promise<void> {
  const serverSql = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('\\'))
    .join('\n');
  await sql.unsafe(serverSql).simple();
  // postgres.js .simple() does not surface per-statement tags here, so the
  // batch's effect is proven by the catalog probe in beforeAll below, not by
  // this call's return value.
  lastBatchCommands = 'applied';
}

let db: MigratedTestDb;
let sql: Sql;
/** Server NOTICE/WARNING lines — the floor trigger announces every downgrade. */
let notices: string[] = [];
/** Command tags the migration batch reported — surfaced in precondition failures. */
let lastBatchCommands = '[]';
/** Backend pid that executed the most recent seed INSERT — pairs with the reader pid. */
let lastSeedPid = -1;
/** The production-shaped failure must be present before 1144 repairs it. */
let historicalPre1144Probe: { deletionOk: boolean; artifactMixOk: boolean } | undefined;

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
  const inserted = await sql.unsafe<{ feature_id: string; pid: number }[]>(
    `INSERT INTO harness_shared.work_items (feature_id, status, authority, payload)
     VALUES ($1, 'wip', NULL, $2)
     RETURNING feature_id, pg_backend_pid() AS pid`,
    // postgres.js types json() as its strict JSONValue; these fixtures are plain JSON
    // whose INFERRED type (Record<string, unknown>) TS cannot prove is JSONValue.
    [id, sql.json(payload as Parameters<typeof sql.json>[0])],
  );
  if (!inserted.length) throw new Error(`seedOpenItem(${id}): INSERT returned no row`);
  lastSeedPid = inserted[0].pid;
}

/** Simulate the close write a frozen pre-guard build performs. */
async function closeAsCommitted(id: string, evidence: Record<string, unknown>): Promise<'committed' | 'proposed'> {
  const rows = await sql.unsafe<{ authority: string; matched: number }[]>(
    `WITH updated AS (
       UPDATE harness_shared.work_items
          SET status = 'done',
              authority = 'committed',
              payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('_completionEvidence', $2)
         WHERE feature_id = $1
       RETURNING authority
     ) SELECT authority, count(*) OVER () AS matched FROM updated`,
    [id, sql.json(evidence as Parameters<typeof sql.json>[0])],
  );
  if (!rows.length) throw new Error(`closeAsCommitted(${id}): UPDATE matched 0 rows — seed missing`);
  return rows[0].authority as 'committed' | 'proposed';
}

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA_B = '0000111122223333444455556666777788889999';

function evidenceWith(identity: unknown, filesChanged: string[] = ['src/fix.ts'], filesDeleted: string[] = []) {
  return {
    summary: 'verified',
    filesChanged,
    ...(filesDeleted.length ? { filesDeleted } : {}),
    treeStamp: {
      repositoryRoot: '/repo',
      headSha: SHA_A,
      ...(identity === undefined ? {} : { contentIdentity: identity }),
    },
  };
}

function outOfRepoArtifact(path: string) {
  return {
    path,
    workingTreeBlobSha: null,
    headBlobSha: null,
    outOfRepoArtifact: true,
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
  await applyMigrationFile(migration972Sql);
  // Prove the base migration already understands intentional deletions before
  // migration 1044 replaces the function for multi-repository/artifact cases.
  const [baseDeletionFloor] = await sql<{ valid: boolean; presentInTree: boolean }[]>`
    SELECT
      harness_shared.completion_content_identity_proven(
        ${sql.json([{ path: 'src/deleted.ts', deletion: true, workingTreeBlobSha: null, headBlobSha: null }])}
      ) AS valid,
      harness_shared.completion_content_identity_proven(
        ${sql.json([{ path: 'src/deleted.ts', deletion: true, workingTreeBlobSha: SHA_A, headBlobSha: null }])}
      ) AS "presentInTree"`;
  expect(baseDeletionFloor).toEqual({ valid: true, presentInTree: false });
  await applyMigrationFile(migration1044Sql);
  // Recreate the definitions that were actually installed before the source
  // files were edited in place, then prove the live failure exists.
  await sql.unsafe(historicalLiveFloorSql).simple();
  [historicalPre1144Probe] = await sql<{ deletionOk: boolean; artifactMixOk: boolean }[]>`
    SELECT
      harness_shared.completion_content_identity_proven(
        ${sql.json([{ path: 'src/deleted.ts', deletion: true, workingTreeBlobSha: null, headBlobSha: null }])}
      ) AS "deletionOk",
      harness_shared.completion_content_identity_proven(
        ${sql.json([
          { path: 'src/fix.ts', workingTreeBlobSha: SHA_A, headBlobSha: SHA_A },
          outOfRepoArtifact('/tmp/proof.png'),
        ])}
      ) AS "artifactMixOk"`;
  expect(historicalPre1144Probe).toEqual({ deletionOk: false, artifactMixOk: true });
  await applyMigrationFile(migration1144Sql);
  await applyMigrationFile(migration1180Sql);
  // A silently-absent or disabled trigger would make every keep-case below pass
  // vacuously, so the definition itself is part of the precondition. The probe
  // dumps unqualified ground truth so a mis-targeted DDL cannot hide behind an
  // empty filtered result, and carries the batch's own command tags.
  const [probe] = await sql<
    {
      db: string;
      triggers: { tgname: string; tbl: string; sch: string; tgenabled: string }[];
      fns: string[];
      relkind: string;
    }[]
  >`
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
  const floor = probe.triggers.find((t) => t.tgname === 'completion_authority_floor_trg');
  expect(
    floor,
    `triggers=${JSON.stringify(probe.triggers)} notices=${JSON.stringify(notices)} lastBatchCommands=${lastBatchCommands} db=${probe.db}`,
  ).toBeDefined();
  expect(floor?.tgenabled, `floor trigger state: ${JSON.stringify(floor)}`).toBe('O');
  expect(probe.fns.sort()).toEqual(['completion_content_identity_proven', 'downgrade_unproven_committed_close']);
  expect(probe.relkind).toBe('r');
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migrations 972 + 1044 + 1144 + 1180 — completion authority content-identity floor', () => {
  it('reproduces the historical live deletion rejection before the 1144 forward repair', () => {
    expect(historicalPre1144Probe).toEqual({ deletionOk: false, artifactMixOk: true });
  });

  it('downgrades a frozen-build close whose evidence has NO contentIdentity (the WI-41491 shape)', async () => {
    notices.length = 0;
    await seedOpenItem('WI-CASE-MISSING');
    const observed = await closeAsCommitted('WI-CASE-MISSING', evidenceWith(undefined));
    const [diag] = await sql<{ has_ev: boolean; pt: string }[]>`
      SELECT payload->'_completionEvidence' IS NOT NULL AS has_ev,
             jsonb_typeof(payload) AS pt
        FROM harness_shared.work_items WHERE feature_id = 'WI-CASE-MISSING'`;
    expect(
      { observed, notices, diag },
      `diag=${JSON.stringify(diag)} notices=${JSON.stringify(notices)} observed=${observed}`,
    ).toEqual({
      observed: 'proposed',
      notices: [expect.stringMatching(/downgraded committed->proposed/)],
      diag: { has_ev: true, pt: 'object' },
    });
    // The SQL mirror must agree with the TS truth table on canonical shapes.
    const [p] = await sql<{ p_null: boolean; p_ok: boolean; p_mismatch: boolean; p_artifact_only: boolean }[]>`
      SELECT harness_shared.completion_content_identity_proven(NULL::jsonb) AS p_null,
        harness_shared.completion_content_identity_proven(
          ${sql.json([{ path: 'a', workingTreeBlobSha: SHA_A, headBlobSha: SHA_A }])}) AS p_ok,
        harness_shared.completion_content_identity_proven(
          ${sql.json([{ path: 'a', workingTreeBlobSha: SHA_B, headBlobSha: SHA_A }])}) AS p_mismatch,
        harness_shared.completion_content_identity_proven(
          ${sql.json([outOfRepoArtifact('/tmp/proof.png')])}) AS p_artifact_only`;
    expect(p, `proven()=${JSON.stringify(p)}`).toEqual({
      p_null: false,
      p_ok: true,
      p_mismatch: false,
      p_artifact_only: true,
    });
  });

  it('downgrades null-blob, mismatched-blob, and empty-array identities', async () => {
    await seedOpenItem('WI-CASE-NULLBLOB');
    expect(
      await closeAsCommitted(
        'WI-CASE-NULLBLOB',
        evidenceWith([{ path: 'src/fix.ts', workingTreeBlobSha: SHA_A, headBlobSha: null }]),
      ),
    ).toBe('proposed');

    await seedOpenItem('WI-CASE-MISMATCH');
    expect(
      await closeAsCommitted(
        'WI-CASE-MISMATCH',
        evidenceWith([{ path: 'src/fix.ts', workingTreeBlobSha: SHA_B, headBlobSha: SHA_A }]),
      ),
    ).toBe('proposed');

    await seedOpenItem('WI-CASE-EMPTY');
    expect(await closeAsCommitted('WI-CASE-EMPTY', evidenceWith([]))).toBe('proposed');
  });

  it('keeps committed for a filesDeleted path absent from both the working tree and HEAD', async () => {
    await seedOpenItem('WI-CASE-DELETION');
    const observed = await closeAsCommitted(
      'WI-CASE-DELETION',
      evidenceWith(
        [{ path: 'src/deleted.ts', workingTreeBlobSha: null, headBlobSha: null, deletion: true }],
        [],
        ['src/deleted.ts'],
      ),
    );
    expect(observed).toBe('committed');

    const [p] = await sql<{ deletion_ok: boolean; deletion_missing_sha: boolean }[]>`
      SELECT
        harness_shared.completion_content_identity_proven(
          ${sql.json([{ path: 'src/deleted.ts', deletion: true, workingTreeBlobSha: null, headBlobSha: null }])}
        ) AS deletion_ok,
        harness_shared.completion_content_identity_proven(
          ${sql.json([{ path: 'src/deleted.ts', deletion: true, workingTreeBlobSha: SHA_A, headBlobSha: null }])}
        ) AS deletion_missing_sha`;
    expect(p).toEqual({ deletion_ok: true, deletion_missing_sha: false });
  });

  it('downgrades a deletion claim when the path is still present in the working tree or in HEAD', async () => {
    await seedOpenItem('WI-CASE-DELETION-WORKTREE');
    expect(
      await closeAsCommitted(
        'WI-CASE-DELETION-WORKTREE',
        evidenceWith(
          [{ path: 'src/deleted.ts', workingTreeBlobSha: SHA_A, headBlobSha: null, deletion: true }],
          [],
          ['src/deleted.ts'],
        ),
      ),
    ).toBe('proposed');

    await seedOpenItem('WI-CASE-DELETION-COMMIT');
    expect(
      await closeAsCommitted(
        'WI-CASE-DELETION-COMMIT',
        evidenceWith(
          [{ path: 'src/deleted.ts', workingTreeBlobSha: null, headBlobSha: SHA_A, deletion: true }],
          [],
          ['src/deleted.ts'],
        ),
      ),
    ).toBe('proposed');
  });

  /**
   * EI-21937921955988010 (migration 1044) — a completion may span SEVERAL repositories
   * and cite artifacts that belong to NONE. `verifiedHow: 'live-drove-ui'` requires
   * citing screenshots under ~/.papercusp/evidence/, which have no blob identity to
   * prove; counting them unproven made every UI-verified suite-app close ineligible for
   * 'committed' (measured on WI-1409555).
   *
   * The controls are the point of this test: explicit artifacts qualify when they are the
   * complete identity, but they never excuse a genuine repo-backed mismatch.
   */
  it('excludes out-of-repo artifacts from the floor, but never lets them stand alone or excuse drift', async () => {
    // Mixed close: a papercusp path, a SECOND checkout's path carrying its own root, and
    // a screenshot artifact. Every repo-backed path proves out, so this qualifies.
    await seedOpenItem('WI-CASE-MULTIREPO');
    expect(
      await closeAsCommitted(
        'WI-CASE-MULTIREPO',
        evidenceWith([
          { path: 'infra/phone-app/deploy.sh', workingTreeBlobSha: SHA_A, headBlobSha: SHA_A },
          {
            path: 'apps/sidecar/src/api.ts',
            workingTreeBlobSha: SHA_B,
            headBlobSha: SHA_B,
            repositoryRoot: '/suite/phone-app',
          },
          outOfRepoArtifact('/home/u/.papercusp/evidence/WI-CASE-MULTIREPO/phone-dialer.png'),
        ]),
      ),
    ).toBe('committed');

    // An artifact-only completion has no repository settlement to await, but its
    // explicit server classification is sufficient for the identity floor.
    await seedOpenItem('WI-CASE-ARTIFACT-ONLY');
    expect(
      await closeAsCommitted(
        'WI-CASE-ARTIFACT-ONLY',
        evidenceWith(
          [outOfRepoArtifact('/home/u/.papercusp/evidence/WI-CASE-ARTIFACT-ONLY/ui.png')],
          ['/home/u/.papercusp/evidence/WI-CASE-ARTIFACT-ONLY/ui.png'],
        ),
      ),
    ).toBe('committed');

    // CONTROL: an artifact citation never excuses a genuine mismatch beside it.
    await seedOpenItem('WI-CASE-ARTIFACT-PLUS-DRIFT');
    expect(
      await closeAsCommitted(
        'WI-CASE-ARTIFACT-PLUS-DRIFT',
        evidenceWith([
          { path: 'src/fix.ts', workingTreeBlobSha: SHA_B, headBlobSha: SHA_A },
          outOfRepoArtifact('/home/u/.papercusp/evidence/WI-CASE-ARTIFACT-PLUS-DRIFT/ui.png'),
        ]),
      ),
    ).toBe('proposed');
  });

  it('keeps a mixed filesDeleted + outOfRepoArtifact completion committed', async () => {
    await seedOpenItem('WI-CASE-DELETION-ARTIFACT');
    expect(
      await closeAsCommitted(
        'WI-CASE-DELETION-ARTIFACT',
        evidenceWith(
          [
            { path: 'src/deleted.ts', workingTreeBlobSha: null, headBlobSha: null, deletion: true },
            outOfRepoArtifact('/home/u/.papercusp/evidence/WI-CASE-DELETION-ARTIFACT/ui.png'),
          ],
          [],
          ['src/deleted.ts'],
        ),
      ),
    ).toBe('committed');
  });

  it('keeps committed when every declared path proves blob equality', async () => {
    await seedOpenItem('WI-CASE-PROVEN');
    expect(
      await closeAsCommitted(
        'WI-CASE-PROVEN',
        evidenceWith(
          [
            { path: 'src/fix.ts', workingTreeBlobSha: SHA_A, headBlobSha: SHA_A },
            { path: 'src/other.ts', workingTreeBlobSha: SHA_B, headBlobSha: SHA_B },
          ],
          ['src/fix.ts', 'src/other.ts'],
        ),
      ),
    ).toBe('committed');
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
    const rows = await sql.unsafe<{ authority: string }[]>(
      `SELECT authority FROM harness_shared.work_items WHERE feature_id = 'WI-CASE-LEGACY'`,
    );
    expect(rows[0].authority).toBe('committed');

    // But a RE-ASSERTED payload (the writer touched the evidence again) is held
    // to the floor even though authority itself did not transition.
    await sql.unsafe(
      `UPDATE harness_shared.work_items
          SET payload = jsonb_build_object('_completionEvidence', $1)
        WHERE feature_id = 'WI-CASE-LEGACY'`,
      [sql.json(evidenceWith(undefined) as Parameters<typeof sql.json>[0])],
    );
    const after = await sql.unsafe<{ authority: string }[]>(
      `SELECT authority FROM harness_shared.work_items WHERE feature_id = 'WI-CASE-LEGACY'`,
    );
    expect(after[0].authority).toBe('proposed');
  });

  it('polices direct INSERTs claiming committed too', async () => {
    await sql.unsafe(
      `INSERT INTO harness_shared.work_items (feature_id, status, authority, payload)
       VALUES ('WI-CASE-INSERT', 'done', 'committed', jsonb_build_object('_completionEvidence', $1))`,
      [sql.json(evidenceWith(undefined) as Parameters<typeof sql.json>[0])],
    );
    const rows = await sql.unsafe<{ authority: string }[]>(
      `SELECT authority FROM harness_shared.work_items WHERE feature_id = 'WI-CASE-INSERT'`,
    );
    expect(rows[0].authority).toBe('proposed');
  });

  it('re-applies idempotently', async () => {
    await applyMigrationFile(migration972Sql);
    await applyMigrationFile(migration1044Sql);
    // The floor must survive its own re-application unchanged and enabled.
    const rows = await sql<{ tgenabled: string }[]>`
      SELECT tgenabled FROM pg_trigger
       WHERE tgrelid = 'harness_shared.work_items'::regclass
        AND tgname = 'completion_authority_floor_trg' AND NOT tgisinternal`;
    expect(rows[0]?.tgenabled).toBe('O');

    // Re-applying both migrations must preserve the final deletion/artifact
    // semantics, not merely leave an enabled trigger behind.
    await seedOpenItem('WI-CASE-REAPPLY-DELETION');
    expect(
      await closeAsCommitted(
        'WI-CASE-REAPPLY-DELETION',
        evidenceWith(
          [
            { path: 'src/deleted.ts', workingTreeBlobSha: null, headBlobSha: null, deletion: true },
            outOfRepoArtifact('/home/u/.papercusp/evidence/WI-CASE-REAPPLY-DELETION/ui.png'),
          ],
          [],
          ['src/deleted.ts'],
        ),
      ),
    ).toBe('committed');

    await seedOpenItem('WI-CASE-REAPPLY-DELETION-DRIFT');
    expect(
      await closeAsCommitted(
        'WI-CASE-REAPPLY-DELETION-DRIFT',
        evidenceWith(
          [{ path: 'src/deleted.ts', workingTreeBlobSha: SHA_A, headBlobSha: null, deletion: true }],
          [],
          ['src/deleted.ts'],
        ),
      ),
    ).toBe('proposed');
  });
});
