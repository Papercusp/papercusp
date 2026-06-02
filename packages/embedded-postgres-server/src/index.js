/**
 * Boot a real Postgres (PG 18 via embedded-postgres) configured for
 * logical replication so Zero / pgoutput consumers can subscribe.
 *
 * Mirrors @papercusp/pglite-server's handle shape so consumers can swap
 * the two via env var. Notable differences:
 *   - Listens on TCP localhost:<port> (real PG can't expose a unix
 *     socket trivially across platforms; TCP is the cross-platform
 *     contract).
 *   - Spawns a real `postgres` child process.
 *   - Applies SQL migrations idempotently via a schema_migrations
 *     tracker (fixes the pglite-server first-boot-only bug).
 *
 * Roles: harness_app, harness_admin, harness_zero are pre-created with
 * the same passwords libs/db/src/connection.ts expects. The framework's
 * GRANT statements run during 001-shared.sql apply.
 *
 * Logical replication: the postmaster starts with
 *   wal_level=logical max_wal_senders=10 max_replication_slots=10
 * so zero-cache (or any pgoutput consumer) can CREATE_REPLICATION_SLOT.
 *
 * Discovery contract (added 2026-05-12):
 *   The desktop's Rust main writes the chosen port to
 *   ~/.papercusp/embedded-pg.json on PG ready (deletes on shutdown), so
 *   external processes (`apps/operator npm run dev`) can find the same
 *   PG. Operator code resolves via apps/operator/lib/embedded-pg-discovery.ts
 *   `getHarnessAdminUrl()`. Don't add new code that hardcodes
 *   `localhost:5432` or `:16534` — both are stale.
 *
 * Migration runner notes:
 *   - Strips lines starting with `\` before sending SQL to PG (psql
 *     metacommands like `\set ON_ERROR_STOP on` aren't valid SQL).
 *   - File `040-plugin-configs-backfill.sql` is in MANUAL_ONLY skip
 *     list — it requires `psql -v key=...` variable substitution.
 *   - Publication block (CREATE PUBLICATION zero_harness FOR TABLES IN
 *     SCHEMA harness_shared, papercup_shared) MUST run AFTER migrations
 *     so the schemas exist on a fresh initdb.
 */

import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyPendingMigrations } from './migration-runner.js';
export { applyPendingMigrations } from './migration-runner.js';

const DEFAULT_DB = 'papercusp';
const DEFAULT_OWNER = 'postgres';
const DEFAULT_OWNER_PWD = 'postgres';

const PER_HARNESS_TEMPLATE = '002-per-harness-template.sql';

/**
 * Read the slug list from harness_shared.harness_registry. Returns an
 * empty array on first boot (registry table doesn't exist or is empty)
 * — the caller treats that as "no schemas to provision yet."
 *
 * Slugs in the registry use hyphens; PG schema names use underscores.
 * Returned slugs are already underscore-form (matches the existing
 * `harness_<slug>` schema naming convention).
 */
async function readRegisteredSlugs(sql, log) {
  try {
    const rows = await sql`
      SELECT (jsonb_array_elements(payload->'projects'))->>'slug' AS slug
        FROM harness_shared.harness_registry
    `;
    const slugs = rows
      .map((r) => r.slug)
      .filter((s) => typeof s === 'string' && s.length > 0)
      .map((s) => s.replace(/-/g, '_'));
    return Array.from(new Set(slugs));
  } catch (e) {
    log(`registry read failed (${e?.message ?? e}); no schemas pre-provisioned this boot`);
    return [];
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.dataDir]      Postgres data dir. Default: ~/.papercusp/embedded-pg-data
 * @param {number} [opts.port]         TCP port. Default: 5532 (avoiding 5432 collision with system PG).
 * @param {string} [opts.dbName]       Database to create + connect to. Default: papercusp.
 * @param {boolean} [opts.debug]
 * @param {string} [opts.dbSqlDir]     Directory of *.sql migration files. If set, migrations apply on every boot.
 * @param {string[]} [opts.harnessSlugs] Override the slug list. Default: read from `harness_shared.harness_registry`. Pass an explicit list only for tests / first-boot fixtures.
 * @param {(m: string) => void} [opts.onLog]
 */
export async function startEmbeddedPostgresServer(opts = {}) {
  const dataDir = opts.dataDir ?? join(homedir(), '.papercusp', 'embedded-pg-data');
  const port = opts.port ?? 5532;
  const dbName = opts.dbName ?? DEFAULT_DB;
  const debug = !!opts.debug;
  const log = opts.onLog ?? ((m) => debug && console.log(`[embedded-pg-server] ${m}`));

  await mkdir(dataDir, { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: DEFAULT_OWNER,
    password: DEFAULT_OWNER_PWD,
    port,
    persistent: true,
    onLog: (m) => log(`pg: ${typeof m === 'string' ? m : (m?.message ?? '')}`),
    onError: (m) => log(`pg-err: ${typeof m === 'string' ? m : (m?.message ?? m?.toString?.() ?? '')}`),
    // wal_level=logical is REQUIRED for Zero / any pgoutput consumer.
    // The two replication-slot/sender knobs are sized generously enough
    // for one zero-cache + a few diagnostic slots without bumping into
    // the postmaster start-up failure that happens at slots=0/senders=0.
    postgresFlags: [
      '-c', 'wal_level=logical',
      '-c', 'max_wal_senders=10',
      '-c', 'max_replication_slots=10',
    ],
  });

  // initdb is idempotent: if the data dir is already initialized, this
  // is a no-op. Same for createDatabase below.
  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    log(`initialising data dir at ${dataDir}`);
    await pg.initialise();
  } else {
    log(`reusing existing data dir at ${dataDir}`);
  }

  log(`starting postgres on localhost:${port}`);
  await pg.start();

  // Create the target database if missing. embedded-postgres always
  // creates `postgres` as superuser; we add `papercusp` separately so
  // it has the same name across web + desktop deployments.
  const sysSql = postgres({
    host: 'localhost',
    port,
    user: DEFAULT_OWNER,
    password: DEFAULT_OWNER_PWD,
    database: 'postgres',
    max: 1,
  });
  try {
    const exists = await sysSql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (exists.length === 0) {
      log(`creating database ${dbName}`);
      await sysSql.unsafe(`CREATE DATABASE ${dbName}`);
    }
  } finally {
    await sysSql.end({ timeout: 2 }).catch(() => {});
  }

  // Connect to the target DB to set up framework roles + apply migrations.
  const sql = postgres({
    host: 'localhost',
    port,
    user: DEFAULT_OWNER,
    password: DEFAULT_OWNER_PWD,
    database: dbName,
    max: 1,
  });

  try {
    // Framework roles. Same passwords libs/db/src/connection.ts defaults to.
    // harness_zero needs CREATE on the database — zero-cache creates a
    // _zero_metadata_<app>_<shard>/cdc schema for change-streamer state on
    // first boot. Without the grant, change-streamer crashes with
    // "permission denied for database papercusp".
    await sql.unsafe(`
      DO $pg$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
          CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
          CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
          CREATE ROLE harness_zero LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd';
        ELSE
          ALTER ROLE harness_zero SUPERUSER;
        END IF;
      END $pg$;
    `);

    // Extensions the baseline schema depends on, created BEFORE migrations.
    // The squashed 000-baseline.sql (self-contained-migration-baseline-2026-06-02)
    // is a schema-only dump of harness_shared + papercup_shared: it references
    // gen_random_uuid()/digest() (pgcrypto), trigram ops (pg_trgm), and vector(N)
    // columns (vector) but does NOT itself CREATE EXTENSION. Previously these came
    // from migrations 027/039/059/060, now archived. pgcrypto + pg_trgm are trusted
    // and always succeed; vector needs the compiled .so — tolerated-if-missing
    // (mirrors the old 060), in which case mem0 degrades to its in-memory fallback.
    await sql.unsafe(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      DO LANGUAGE plpgsql $body$ BEGIN
        CREATE EXTENSION IF NOT EXISTS vector;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pgvector not available on this server (%); embedding features degrade to in-memory.', SQLERRM;
      END $body$;
    `);

    // Optional seed-dump restore (Part 2 — build-time data sync to
    // Mac/Windows). When PAPERCUSP_PG_SEED_DUMP_PATH points at a
    // pg_dump custom-format file AND the DB has no schema_migrations
    // history yet (fresh initdb), pg_restore the dump BEFORE migrations
    // apply. Migration runner then sees all rows in schema_migrations
    // and treats them as already-applied — clean idempotent path.
    let seedJustRestored = false;
    const seedPath = opts.seedDumpPath ?? process.env.PAPERCUSP_PG_SEED_DUMP_PATH;
    if (seedPath && existsSync(seedPath)) {
      // Check freshness: does schema_migrations exist with any rows?
      let isFreshInstall = true;
      try {
        const rows = await sql.unsafe(
          `SELECT count(*)::int AS n FROM harness_shared.schema_migrations`,
        );
        if (rows?.[0]?.n > 0) isFreshInstall = false;
      } catch {
        // table doesn't exist yet — that's the fresh-install signal we want
      }
      if (isFreshInstall) {
        const pgRestoreBin = opts.pgRestoreBin
          ?? process.env.PAPERCUSP_PG_RESTORE_BIN
          ?? 'pg_restore';
        log(`seed restore: ${seedPath} (fresh install detected)`);
        const { spawn } = await import('node:child_process');
        await new Promise((resolve) => {
          const child = spawn(pgRestoreBin, [
            '--dbname', `postgresql://harness_admin:harness_admin_pwd@127.0.0.1:${port}/${dbName}`,
            '--no-owner', '--no-acl',
            '--no-publications', '--no-subscriptions',
            seedPath,
          ], { stdio: ['ignore', 'pipe', 'pipe'] });
          let stderr = '';
          child.stderr.on('data', (d) => { stderr += d.toString(); });
          child.on('exit', (code) => {
            // pg_restore returns 1 when it encounters non-fatal warnings or
            // a small number of object-already-exists errors but otherwise
            // restored the dump. Treat 0 AND 1 as "restored enough" — the
            // alternative (running migrations on partially-restored data)
            // is strictly worse because the dump's schema may diverge from
            // the migration sequence.
            if (code === 0 || code === 1) {
              log(`seed restore: complete (exit=${code})${code === 1 ? `; non-fatal stderr: ${stderr.split('\n').slice(0, 3).join(' | ')}` : ''}`);
              seedJustRestored = true;
            } else {
              log(`seed restore: pg_restore exit=${code}; first stderr lines: ${stderr.split('\n').slice(0, 5).join(' | ')}`);
            }
            resolve();
          });
        });
      } else {
        log(`seed restore: skipping (DB already has schema_migrations rows)`);
      }
    }

    // Apply migrations FIRST. The publication-creation block below
    // references schemas (harness_shared, papercup_shared) that don't
    // exist on a fresh initdb until 001-shared.sql runs — moving
    // migrations ahead of the publication step prevents the
    // "schema does not exist" failure on first boot.
    if (opts.dbSqlDir && existsSync(opts.dbSqlDir)) {
      // Seed-installed databases keep a sentinel row in schema_migrations
      // so on every subsequent boot we can pre-mark any new on-disk
      // migration files as "covered by seed". Without this, rebuilding
      // the sidecar with new migration files between desktop launches
      // causes the runner to try applying them against an already-final
      // schema (e.g. ALTER TABLE against a relation that's now a view).
      const SEED_SENTINEL = '__seed_restored__.marker';
      let seedSentinelExists = false;
      try {
        await sql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS harness_shared;
          CREATE TABLE IF NOT EXISTS harness_shared.schema_migrations (
            filename TEXT PRIMARY KEY,
            sha256 TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
        `);
        const rows = await sql.unsafe(
          `SELECT 1 FROM harness_shared.schema_migrations WHERE filename = '${SEED_SENTINEL}' LIMIT 1`,
        );
        seedSentinelExists = (rows?.length ?? 0) > 0;
      } catch {
        // table didn't exist; will be created below
      }

      const shouldPreMark = seedJustRestored || seedSentinelExists;
      console.log(`[embedded-pg-server] pre-mark check: seedJustRestored=${seedJustRestored} seedSentinelExists=${seedSentinelExists} → shouldPreMark=${shouldPreMark}`);
      if (shouldPreMark) {
        try {
          // Seed-restored tables may be missing the PRIMARY KEY on filename
          // (pg_dump --no-owner drops constraints in some configs). Add it
          // if missing so ON CONFLICT works below.
          try {
            const constraints = await sql.unsafe(
              `SELECT 1 FROM pg_constraint WHERE conrelid = 'harness_shared.schema_migrations'::regclass AND contype IN ('p','u') LIMIT 1`,
            );
            if (!constraints?.length) {
              await sql.unsafe(
                `ALTER TABLE harness_shared.schema_migrations ADD CONSTRAINT schema_migrations_filename_key UNIQUE (filename)`,
              );
              console.log(`[embedded-pg-server] pre-mark: added missing UNIQUE constraint on filename`);
            }
          } catch (e) {
            console.log(`[embedded-pg-server] pre-mark: constraint check skipped (${e?.message ?? e})`);
          }
          const { readdirSync, readFileSync: rfs } = await import('node:fs');
          const { createHash } = await import('node:crypto');
          const { join: pjoin } = await import('node:path');
          const files = readdirSync(opts.dbSqlDir).filter((f) => f.endsWith('.sql')).sort();
          for (const f of files) {
            const body = rfs(pjoin(opts.dbSqlDir, f), 'utf8');
            const hash = createHash('sha256').update(body).digest('hex');
            await sql.unsafe(
              `INSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ('${f.replace(/'/g, "''")}', '${hash}') ON CONFLICT (filename) DO NOTHING`,
            );
          }
          // Record the seed-applied sentinel so future boots also pre-mark.
          await sql.unsafe(
            `INSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ('${SEED_SENTINEL}', 'seed') ON CONFLICT (filename) DO NOTHING`,
          );
          console.log(`[embedded-pg-server] pre-mark: inserted ${files.length} migration markers + sentinel`);
        } catch (e) {
          console.log(`[embedded-pg-server] pre-mark FAILED: ${e?.message ?? e}`);
        }

        // pg_restore --no-owner reset object ownership to the restoring
        // role (harness_admin). Re-grant the standard role permissions
        // that the migrations would have established.
        try {
          await sql.unsafe(`
            DO $perm$
            DECLARE
              s text;
            BEGIN
              FOR s IN
                SELECT nspname FROM pg_namespace
                WHERE nspname NOT LIKE 'pg_%'
                  AND nspname NOT IN ('information_schema','public')
              LOOP
                EXECUTE format('GRANT USAGE ON SCHEMA %I TO harness_app, harness_zero', s);
                EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO harness_app', s);
                EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO harness_zero', s);
                EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO harness_app', s);
                EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO harness_app', s);
                EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO harness_zero', s);
                EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO harness_app', s);
              END LOOP;
            END;
            $perm$;
          `);
          log(`seed restore: re-granted harness role permissions on all schemas`);
        } catch (e) {
          log(`seed restore: permission re-grant failed: ${e?.message ?? e}`);
        }
      }

      const result = await applyPendingMigrations({
        client: sql,
        sqlDir: opts.dbSqlDir,
        log,
      });
      log(`migrations: ${result.appliedCount} applied this boot (${result.totalKnown} total known)`);

      // Zero replication publication. Scoped to schemas the harness owns.
      // FOR ALL TABLES had captured zero-cache's own bookkeeping schemas
      // (papercusp_0/cvr, papercusp_0/cdc, audit) which OOMed zero-cache
      // during initial replication on workspaces with accumulated history.
      // FOR TABLES IN SCHEMA auto-includes new tables added to listed
      // schemas, and per-harness schemas are added on-demand by the
      // bootstrap helper that scaffolds them. Runs AFTER migrations so
      // the schemas it references actually exist on a fresh initdb.
      await sql.unsafe(`
        DO $pg$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'zero_harness') THEN
            CREATE PUBLICATION zero_harness FOR TABLES IN SCHEMA harness_shared, papercup_shared;
          END IF;
        END $pg$;
      `);
      // Add per-harness schemas to the publication. Idempotent — duplicates
      // raise a notice we ignore.
      const perHarnessSchemas = await sql.unsafe(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'harness\\_%' ESCAPE '\\'
          AND schema_name <> 'harness_shared'
      `);
      for (const { schema_name } of perHarnessSchemas) {
        if (!/^harness_[a-z0-9_]+$/i.test(schema_name)) continue;
        try {
          await sql.unsafe(`ALTER PUBLICATION zero_harness ADD TABLES IN SCHEMA ${schema_name}`);
        } catch {
          // Already in publication — ignore.
        }
      }

      // Per-harness template: render against each known slug, idempotent.
      // Not tracked in schema_migrations because there's no single filename.
      //
      // Skip when we just restored from a seed dump: the seed already
      // has the post-migration state of every per-harness schema
      // (including the view-replacement from migration 032). Re-running
      // the template would try ALTER COLUMN against views and crash.
      const tmplPath = join(opts.dbSqlDir, PER_HARNESS_TEMPLATE);
      if (seedJustRestored || seedSentinelExists) {
        // Skip on every boot of a seed-installed DB, not just the one
        // that did the restore. Per-harness schemas already have the
        // post-migration view-replacements baked in from the seed —
        // re-running the template would attempt ALTER TABLE against
        // relations that are now views.
        console.log(`[embedded-pg-server] per-harness template: skipped (DB was seed-installed; schemas already match)`);
      } else if (existsSync(tmplPath)) {
        const { readFile } = await import('node:fs/promises');
        const tmpl = await readFile(tmplPath, 'utf8');
        // Slug list comes from harness_shared.harness_registry by default
        // — what's actually registered, not a hardcoded list. Callers can
        // override via opts.harnessSlugs for tests / first-boot fixtures.
        const slugs = opts.harnessSlugs ?? await readRegisteredSlugs(sql, log);
        for (const slug of slugs) {
          const schemaName = `harness_${slug}`;
          const ddl = tmpl.replaceAll('{{SCHEMA}}', schemaName);
          await sql.unsafe(ddl);
          if (/^harness_[a-z0-9_]+$/i.test(schemaName)) {
            try {
              await sql.unsafe(`ALTER PUBLICATION zero_harness ADD TABLES IN SCHEMA ${schemaName}`);
            } catch {
              // Already in publication.
            }
          }
        }
        log(`per-harness template applied across ${slugs.length} slugs (from registry)`);
      }
    } else if (opts.dbSqlDir) {
      log(`dbSqlDir=${opts.dbSqlDir} does not exist — skipping migrations`);
    }
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }

  return {
    /** TCP port the postmaster is listening on. */
    port,
    /** Database name created/used. */
    dbName,
    /** Owner credentials. */
    user: DEFAULT_OWNER,
    password: DEFAULT_OWNER_PWD,
    /** Connection URLs for common roles (matches connection.ts expectations). */
    urls: {
      admin: `postgresql://harness_admin:harness_admin_pwd@localhost:${port}/${dbName}`,
      app:   `postgresql://harness_app:harness_app_pwd@localhost:${port}/${dbName}`,
      zero:  `postgresql://harness_zero:harness_zero_pwd@localhost:${port}/${dbName}`,
    },
    async stop() {
      log('stopping postgres');
      await pg.stop().catch((e) => log(`stop error: ${e?.message ?? e}`));
    },
  };
}
