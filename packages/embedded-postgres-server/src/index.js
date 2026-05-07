/**
 * Boot a real Postgres (PG 17 via embedded-postgres) configured for
 * logical replication so Zero / pgoutput consumers can subscribe.
 *
 * Mirrors @restart/pglite-server's handle shape so consumers can swap
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
 */

import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyPendingMigrations } from './migration-runner.js';

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

    // Zero replication publication. Scoped to schemas the harness owns.
    // FOR ALL TABLES had captured zero-cache's own bookkeeping schemas
    // (papercusp_0/cvr, papercusp_0/cdc, audit) which OOMed zero-cache
    // during initial replication on workspaces with accumulated history.
    // FOR TABLES IN SCHEMA auto-includes new tables added to listed
    // schemas, and per-harness schemas are added on-demand by the
    // bootstrap helper that scaffolds them.
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
      // schema_name comes from information_schema and is filtered to harness_*
      // pattern above; safe to interpolate but validate strictly anyway.
      if (!/^harness_[a-z0-9_]+$/i.test(schema_name)) continue;
      try {
        await sql.unsafe(`ALTER PUBLICATION zero_harness ADD TABLES IN SCHEMA ${schema_name}`);
      } catch {
        // Already in publication — ignore.
      }
    }

    // Apply migrations.
    if (opts.dbSqlDir && existsSync(opts.dbSqlDir)) {
      const result = await applyPendingMigrations({
        client: sql,
        sqlDir: opts.dbSqlDir,
        log,
      });
      log(`migrations: ${result.appliedCount} applied this boot (${result.totalKnown} total known)`);

      // Per-harness template: render against each known slug, idempotent.
      // Not tracked in schema_migrations because there's no single filename.
      const tmplPath = join(opts.dbSqlDir, PER_HARNESS_TEMPLATE);
      if (existsSync(tmplPath)) {
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
