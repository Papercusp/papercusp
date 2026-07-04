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
 *     SCHEMA harness_shared, papercusp_shared) MUST run AFTER migrations
 *     so the schemas exist on a fresh initdb.
 */

import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { mkdir, rm, cp, stat, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyPendingMigrations } from './migration-runner.js';
export { applyPendingMigrations } from './migration-runner.js';

const DEFAULT_DB = 'papercusp';
const DEFAULT_OWNER = 'postgres';
const DEFAULT_OWNER_PWD = 'postgres';

/**
 * Resolve the effective pre-built-seed path from opts + env (pure — the caller
 * checks existence). opts.seedPath wins, then PAPERCUSP_PG_SEED_PATH env;
 * PAPERCUSP_PG_DISABLE_SEED (any truthy value) forces null (always initdb).
 * Returns null when no seed is configured.
 */
export function resolveSeedPath(opts = {}, env = process.env) {
  if (env.PAPERCUSP_PG_DISABLE_SEED) return null;
  return opts.seedPath ?? env.PAPERCUSP_PG_SEED_PATH ?? null;
}

/**
 * Extract a pre-built PGDATA seed into `dataDir`. `seedPath` may be a directory
 * (raw PGDATA — recursively copied) or a `.tar`/`.tar.gz` archive whose ROOT is
 * the PGDATA contents (extracted with the system `tar`, gzip auto-detected;
 * present on macOS/Linux/Win10+). Postgres requires the data dir be mode 0700,
 * so we chmod it after (no-op on Windows). Throws on any failure so the caller
 * can wipe + fall back to a clean initdb — never boot a half-extracted dir.
 */
export async function extractSeed(seedPath, dataDir) {
  const st = await stat(seedPath);
  await mkdir(dataDir, { recursive: true });
  if (st.isDirectory()) {
    // cp copies file modes; recursive handles the whole cluster tree.
    await cp(seedPath, dataDir, { recursive: true });
  } else {
    execFileSync('tar', ['-x', '-f', seedPath, '-C', dataDir], { stdio: 'ignore' });
  }
  if (process.platform !== 'win32') {
    await chmod(dataDir, 0o700).catch(() => {});
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.dataDir]      Postgres data dir. Default: ~/.papercusp/embedded-pg-data
 * @param {number} [opts.port]         TCP port. Default: 5532 (avoiding 5432 collision with system PG).
 * @param {string} [opts.dbName]       Database to create + connect to. Default: papercusp.
 * @param {boolean} [opts.debug]
 * @param {string} [opts.dbSqlDir]     Directory of *.sql migration files. If set, migrations apply on every boot.
 * @param {string} [opts.seedPath]     Path to a pre-built PGDATA seed — a directory OR a .tar/.tar.gz
 *        archive of a data dir already `initdb`'d + fully migrated at package time. On a FRESH data
 *        dir it is extracted INSTEAD of running initdb + the full migration replay (desktop first-boot
 *        fast path: ~11s → ~0.3s, measured). The idempotent runner still applies any migration DELTA
 *        afterwards, so a slightly-stale seed self-heals. Falls back to PAPERCUSP_PG_SEED_PATH env, or
 *        to a clean initdb if the seed is absent/unusable. Force-disable with PAPERCUSP_PG_DISABLE_SEED=1.
 * @param {Record<string,string>} [opts.extraPostgresSettings] Host-scaled server knobs
 *        (max_connections, shared_buffers, parallelism, …) the caller derived from
 *        resource-profile (`databaseTuningToSettings(getResourceProfile().database)`).
 *        Empty by default → stock PG defaults (backward compatible). Passing them is
 *        how the desktop's embedded PG autoadjusts to the machine instead of running
 *        on the laptop-sized stock `max_connections=100` / `shared_buffers=128MB`.
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
    // Postgres refuses to run as root; on root-only hosts (cloud frames) the
    // lib can create + setuid a dedicated postgres OS user instead. Opt-in —
    // found live 2026-06-06 bootstrapping a frame.
    createPostgresUser: opts.createPostgresUser ?? false,
    onLog: (m) => log(`pg: ${typeof m === 'string' ? m : (m?.message ?? '')}`),
    onError: (m) => log(`pg-err: ${typeof m === 'string' ? m : (m?.message ?? m?.toString?.() ?? '')}`),
    // wal_level=logical is REQUIRED for Zero / any pgoutput consumer.
    // The two replication-slot/sender knobs are sized generously enough
    // for one zero-cache + a few diagnostic slots without bumping into
    // the postmaster start-up failure that happens at slots=0/senders=0.
    //
    // Host-scaled tuning (max_connections / shared_buffers / parallelism /
    // work_mem …) is appended from opts.extraPostgresSettings — these come last
    // so a caller's explicit value wins (PG honors the last `-c` for a key).
    // Replication knobs above are intentionally NOT in the tuning set, so there
    // is never a conflict.
    postgresFlags: [
      '-c', 'wal_level=logical',
      '-c', 'max_wal_senders=10',
      '-c', 'max_replication_slots=10',
      ...Object.entries(opts.extraPostgresSettings ?? {}).flatMap(
        ([k, v]) => ['-c', `${k}=${v}`],
      ),
    ],
  });

  // Pre-built PGDATA seed (desktop first-boot fast path). On a FRESH data dir,
  // if a pre-migrated snapshot is available, extract it INSTEAD of running
  // initdb + replaying the full migration set — this turns a clean install's
  // ~11s "initdb + 375 migrations" first-boot into a ~0.3s directory extract
  // (measured 42x). The seed is a physical snapshot produced by THIS package's
  // own fresh-boot path at package time, so it is byte-compatible with THIS
  // platform's embedded-postgres binary (the seed is built per-platform during
  // that platform's packaging). After extraction we fall through to the normal
  // "reuse existing data dir" path and applyPendingMigrations() STILL runs — it
  // finds every shipped migration already recorded and applies only the DELTA
  // (usually none), so a seed a few migrations behind self-heals. If the seed is
  // absent, corrupt, or extraction fails, we wipe any partial dir and fall back
  // to a clean initdb — never boot a half-extracted cluster.
  const seedPath = resolveSeedPath(opts);
  if (!existsSync(join(dataDir, 'PG_VERSION')) && seedPath && existsSync(seedPath)) {
    try {
      log(`seeding data dir from pre-built snapshot ${seedPath}`);
      await extractSeed(seedPath, dataDir);
      if (!existsSync(join(dataDir, 'PG_VERSION'))) {
        throw new Error('seed extracted but PG_VERSION missing');
      }
      log('seed applied — skipping initdb + full migration replay');
    } catch (e) {
      log(`seed failed (${e?.message ?? e}) — falling back to clean initdb`);
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
      await mkdir(dataDir, { recursive: true });
    }
  }

  // initdb is idempotent: if the data dir is already initialized (including a
  // just-extracted seed), this is a no-op. Same for createDatabase below.
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
    // is a schema-only dump of harness_shared + papercusp_shared: it references
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

    // Seed-restore RETIRED (self-contained-migration-baseline-2026-06-02, D-004): the
    // single idempotent 000-baseline.sql (+ 107+) is now the fresh-boot path, so the
    // PAPERCUSP_PG_SEED_DUMP_PATH pg_restore branch + its migration pre-marking are gone.
    // A fresh initdb now builds the full schema by applying migrations directly (below).

    // Apply migrations FIRST. The publication-creation block below
    // references schemas (harness_shared, papercusp_shared) that don't
    // exist on a fresh initdb until 001-shared.sql runs — moving
    // migrations ahead of the publication step prevents the
    // "schema does not exist" failure on first boot.
    if (opts.dbSqlDir && existsSync(opts.dbSqlDir)) {
      // Migrations are the single source of truth (self-contained-migration-baseline-2026-06-02).
      // The runner creates schema_migrations itself and applies 000-baseline.sql (+ 107+)
      // idempotently — no seed pre-marking, and role grants now live in migration 109
      // (not a boot-time re-grant), so a fresh initdb builds the complete, grant-correct
      // schema by applying migrations directly.
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
            CREATE PUBLICATION zero_harness FOR TABLES IN SCHEMA harness_shared, papercusp_shared;
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

      // Per-harness template application RETIRED (harness-state-storage-
      // unification-2026-06-01, D-007). Per-harness schemas now contain only
      // auto-updatable views over slug-keyed harness_shared.*_consolidated
      // tables — created by the migrations above (which loop over existing
      // harness_* schemas) and by scaffoldHarnessSchema() for new harnesses.
      // No boot-time per-harness DDL template is applied.
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
