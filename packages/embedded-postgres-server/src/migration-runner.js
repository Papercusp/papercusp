/**
 * Idempotent migration runner.
 *
 * Tracks applied SQL files in `harness_shared.schema_migrations` (filename
 * is the natural key). On every boot:
 *   1. Ensure schema_migrations exists.
 *   2. Read the SQL dir, filter to *.sql sorted by filename.
 *   3. For each file not already in schema_migrations, apply it inside a
 *      transaction and INSERT a row.
 *
 * This fixes the long-standing bug where pglite-server only applied SQL on
 * "first boot" (when harness_shared didn't exist), causing migrations
 * authored after the DB was first booted to silently never run. Found in
 * the wild on 2026-05-05 — the symptom was provisioning failing with
 * `column "kind" of relation "token_index" does not exist` because
 * 009-workspace-scoping.sql had never been applied.
 *
 * Per-harness templates ({{SCHEMA}}-substituted) are NOT tracked here —
 * those are scaffolded on demand by scaffold-harness-schema.sh and don't
 * have a single file path.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SCHEMA_MIGRATIONS_DDL = `
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE IF NOT EXISTS harness_shared.schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sha256 TEXT NOT NULL
  );
`;

async function sha256(text) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}

/**
 * @param {object} args
 * @param {object} args.client    postgres-js client (sql tag) OR object with `.unsafe(text)` method.
 * @param {string} args.sqlDir    Directory of *.sql files.
 * @param {(s: string) => void} [args.log]
 * @param {(file: string) => boolean} [args.skipFile]   Optional filter; defaults to skipping the per-harness template.
 */
// Files that the migration runner must NOT auto-apply on boot. These
// are one-shot manual data backfills that depend on `psql -v` variable
// substitution (`:key` expansion) — sending them raw to postgres-js
// produces "syntax error at or near :".
const MANUAL_ONLY = new Set([
  '040-plugin-configs-backfill.sql', // requires PAPERCUSP_DB_ENCRYPTION_KEY via psql -v key=...
  '__seed_restored__.marker',         // sentinel inserted by seed-restore path; not a real migration file
]);

export async function applyPendingMigrations({ client, sqlDir, log = () => {}, skipFile }) {
  const skip = skipFile ?? ((f) => f.includes('per-harness-template') || MANUAL_ONLY.has(f));

  // Ensure tracker exists.
  await client.unsafe(SCHEMA_MIGRATIONS_DDL);

  // Read files.
  const allFiles = (await readdir(sqlDir))
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !skip(f))
    .sort();

  // Read applied set.
  const appliedRows = await client.unsafe(
    `SELECT filename FROM harness_shared.schema_migrations`,
  );
  const applied = new Set((appliedRows ?? []).map((r) => r.filename));

  let appliedCount = 0;
  for (const f of allFiles) {
    if (applied.has(f)) continue;
    const ddlRaw = await readFile(join(sqlDir, f), 'utf8');
    // Strip psql metacommands (\set, \if, \else, \endif, \echo, etc.) —
    // they're psql-client-side directives that postgres-js sends raw to
    // the server, which throws "syntax error at or near \\". Hash the
    // RAW contents (so files don't re-apply just because we change the
    // stripper), but execute the cleaned version.
    const ddl = ddlRaw
      .split('\n')
      .filter((line) => !/^\s*\\[a-z]/i.test(line))
      .join('\n');
    const hash = await sha256(ddlRaw);
    log(`apply ${f}`);
    // Apply + record in one transaction so a partial apply doesn't leave
    // schema_migrations claiming success.
    try {
      await client.unsafe(`BEGIN;\n${ddl};\nINSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ('${f.replace(/'/g, "''")}', '${hash}');\nCOMMIT;`);
      appliedCount++;
    } catch (err) {
      // 42P01 = undefined_table. On the Tauri desktop this runner executes
      // during embedded-PG boot — BEFORE the operator sidecar's ensure-schema
      // runs — so an ALTER that targets a `harness_shared.*` table created by
      // ensure-schema (not by any migration) hits a not-yet-existing table and
      // would otherwise throw uncaught and abort the entire PG boot (observed:
      // adaptive_telemetry, harness_experts). Those ALTERs are redundant —
      // ensure-schema's CREATE already includes the columns — so warn + skip,
      // leaving the file UN-marked so it retries on a later boot once the table
      // exists. Re-throw every other error so genuine migration breakage stays
      // loud (the original 2026-05-05 token_index bug must still fail visibly).
      if (err && err.code === '42P01') {
        log(`skip ${f}: ${err.message} — target table is created by ensure-schema, not a migration; will retry next boot`);
        continue;
      }
      throw err;
    }
  }

  return { appliedCount, totalKnown: allFiles.length };
}
