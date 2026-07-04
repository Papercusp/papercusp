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
 * @param {boolean} [args.continueOnError]   Default false (fail-loud — embedded-pg
 *   boot + the fresh-migrate gate rely on a broken migration HALTING). Pass true
 *   on the shared native-:5432 operator boot (handoff-coordination-dx-followups A1):
 *   a migration that fails to apply is logged + collected in the returned `failed`
 *   array and the boot CONTINUES (the bad file stays unrecorded → retried next
 *   boot), so one peer's broken migration can't wedge the dev-api for the fleet.
 */
// Files that the migration runner must NOT auto-apply on boot. These
// are one-shot manual data backfills that depend on `psql -v` variable
// substitution (`:key` expansion) — sending them raw to postgres-js
// produces "syntax error at or near :".
const MANUAL_ONLY = new Set([
  '040-plugin-configs-backfill.sql', // requires PAPERCUSP_DB_ENCRYPTION_KEY via psql -v key=...
  '__seed_restored__.marker',         // sentinel inserted by seed-restore path; not a real migration file
]);

export async function applyPendingMigrations({ client, sqlDir, log = () => {}, skipFile, continueOnError = false }) {
  const skip = skipFile ?? ((f) => f.includes('per-harness-template') || MANUAL_ONLY.has(f));
  const failed = [];

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

  // First-boot fast path (desktop first-launch perf). A fresh install applies the
  // full migration set (~370 files); each file COMMITs in its own txn → one WAL fsync
  // per file, and those ~370 serial fsyncs dominate the desktop's ~10s first-boot wait
  // (measured: cold 13s vs warm 3s — the ~10s delta is initdb + this apply). For a large
  // batch (a fresh initdb) drop synchronous_commit so those commits don't each fsync,
  // then restore it + CHECKPOINT after the loop so the applied schema is durable before
  // the operator touches the DB. SAFE: `client` is a dedicated, short-lived boot-setup
  // connection (embedded-postgres-server postgres({ max: 1 })), and a crash mid-apply
  // leaves an INCOMPLETE data dir that first-boot discards + re-initdb's — nothing durable
  // is lost. Normal update boots (a handful of new files) keep synchronous_commit=on.
  const pendingCount = allFiles.reduce((n, f) => (applied.has(f) ? n : n + 1), 0);
  const bulkApply = pendingCount >= 20;
  if (bulkApply) await client.unsafe('SET synchronous_commit = off').catch(() => {});

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
    //
    // CONTRACT — the runner provides the transaction: migration files MUST
    // NOT contain their own top-level BEGIN;/COMMIT;. An inner COMMIT ends
    // this wrapper transaction early, so the <ddl> + ledger-INSERT pair stops
    // being atomic and a mid-file failure leaves schema_migrations lying
    // (plpgsql `BEGIN…END` inside $$ bodies is fine). Enforced for new files
    // by `npm run lint:migrations` (audit P-074, EI-170); files 116–200
    // predate this contract and are grandfathered as applied history.
    //
    // WI-832: `SET LOCAL statement_timeout = 0` is the MIGRATION OPT-OUT for the
    // org-pool default statement_timeout (a DDL migration legitimately runs longer
    // than any interactive cap). SET LOCAL is txn-scoped, so it reverts at COMMIT.
    // This is the single chokepoint every migration path funnels through (embedded-pg
    // boot, native boot-migrate, db:migrate), so the opt-out holds regardless of
    // which client/pool applies the file — even once a non-zero default is live.
    // ONLY statement_timeout: lock_timeout stays as the deliberate fail-fast guard.
    try {
      await client.unsafe(`BEGIN;\nSET LOCAL statement_timeout = 0;\n${ddl};\nINSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ('${f.replace(/'/g, "''")}', '${hash}');\nCOMMIT;`);
      appliedCount++;
    } catch (err) {
      // The failed `BEGIN…COMMIT` left the connection in an aborted
      // transaction; reset it so error reporting isn't masked by
      // "current transaction is aborted, commands ignored until end of block".
      await client.unsafe('ROLLBACK').catch(() => {});
      // No skip-on-42P01 anymore. That tolerance existed only because the OLD
      // incremental migrations ALTERed `harness_shared.*` tables that ensure-schema
      // (not a migration) created lazily at runtime — so an ALTER could hit a
      // not-yet-existing table at boot. The schema is now a single self-contained
      // 000-baseline.sql (self-contained-migration-baseline-2026-06-02): it creates
      // every table before touching it, so empty→head applies with ZERO skips and
      // any 42P01 (or any other error) is a genuine break that MUST fail loudly —
      // UNLESS continueOnError (the shared native-box boot), where we log + skip
      // the bad file (left unrecorded → retried next boot) instead of wedging boot.
      if (continueOnError) {
        log(`FAILED ${f}: ${err?.message ?? err}`);
        failed.push({ file: f, error: String(err?.message ?? err) });
        continue;
      }
      throw err;
    }
  }

  // Restore durable commits and flush everything the bulk apply wrote, so the schema
  // is fsync'd before boot proceeds (closes the crash-window that async commit opens).
  if (bulkApply) {
    await client.unsafe('SET synchronous_commit = on').catch(() => {});
    await client.unsafe('CHECKPOINT').catch(() => {});
  }

  return { appliedCount, totalKnown: allFiles.length, failed };
}
