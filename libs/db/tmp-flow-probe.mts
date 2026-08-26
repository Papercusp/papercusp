import { createFreshTestDb } from '@papercusp/test-config/pg';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const mig = readFileSync('sql/972-completion-authority-content-identity-floor.sql.DRAFT', 'utf8');
const serverSql = mig.split('\n').filter((l) => !l.trim().startsWith('\\')).join('\n');

const db = await createFreshTestDb({ prefix: 'flow' });
const notices: string[] = [];
const sql = postgres(db.url, { max: 1, onnotice: (n: any) => notices.push(n?.message ?? String(n)) });

await sql.unsafe('CREATE SCHEMA harness_shared');
await sql.unsafe(`CREATE TABLE harness_shared.work_items (
  workspace_id text NOT NULL DEFAULT 'papercusp-workspace',
  harness_slug text NOT NULL DEFAULT 'papercusp',
  feature_id   text,
  item_kind    text NOT NULL DEFAULT 'feature',
  status       text,
  taken_by     text,
  authority    text,
  payload      jsonb,
  updated_ts   bigint)`);

await sql.unsafe(serverSql).simple();
console.log('installed:', JSON.stringify(await sql`
  SELECT tgname, tgenabled FROM pg_trigger
   WHERE tgrelid='harness_shared.work_items'::regclass AND NOT tgisinternal`));

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
await sql.unsafe(
  `INSERT INTO harness_shared.work_items (feature_id, status, authority, payload)
   VALUES ($1, 'wip', NULL, $2::jsonb)`,
  ['WI-X', '{}'],
);
console.log('after seed:', JSON.stringify(await sql`SELECT feature_id, authority FROM harness_shared.work_items`));

await sql.unsafe(
  `UPDATE harness_shared.work_items
      SET status='done', authority='committed',
          payload = COALESCE(payload,'{}'::jsonb) || jsonb_build_object('_completionEvidence', $2::jsonb)
    WHERE feature_id=$1`,
  ['WI-X', JSON.stringify({
    summary: 'v', filesChanged: ['src/fix.ts'],
    treeStamp: { repositoryRoot: '/repo', headSha: SHA_A },
  })],
);
console.log('notices after update:', JSON.stringify(notices));
console.log('after close:', JSON.stringify(await sql`SELECT feature_id, status, authority, payload FROM harness_shared.work_items`));

await sql.end({ timeout: 5 });
await db.drop();
