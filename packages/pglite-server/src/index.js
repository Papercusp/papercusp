import { PGlite } from '@electric-sql/pglite';
// Forked socket server with per-handler batch stickiness — see
// packages/pglite-server/src/socket-server.js for the rationale. The
// upstream package interleaves messages from concurrent socket clients
// onto a shared pglite backend, which corrupts the unnamed prepared
// statement state under concurrent parameterized queries.
import { PGLiteSocketServer } from './socket-server.js';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Boot an embedded Postgres-wire-compatible server backed by pglite.
 *
 * The server listens on a unix domain socket at:
 *   <socketDir>/.s.PGSQL.<port>
 *
 * which is the layout postgres-js + libpq expect. Clients connect with:
 *   postgresql://user:pass@localhost/<dbname>?host=<socketDir>
 *
 * Auth is unenforced (pglite is single-user). We still pre-create the
 * harness_app + harness_admin roles so the framework's GRANT statements
 * apply cleanly.
 */
export async function startPgliteServer(opts) {
  const dataDir = opts?.dataDir ?? join(homedir(), '.papercusp', 'pglite-data');
  const socketDir = opts?.socketDir ?? join(homedir(), '.papercusp', 'pglite-socket');
  const port = opts?.port ?? 5432;
  const debug = !!opts?.debug;

  await mkdir(dataDir, { recursive: true });
  await mkdir(socketDir, { recursive: true });
  const socketPath = join(socketDir, `.s.PGSQL.${port}`);

  if (debug) console.log(`[pglite-server] dataDir=${dataDir}`);
  if (debug) console.log(`[pglite-server] socket=${socketPath}`);

  const db = await PGlite.create({ dataDir });

  // Roles created with LOGIN + a default password matching what
  // libs/db/src/connection.ts expects in its non-pglite default URL
  // (`harness_<role>_pwd`). Without LOGIN, pglite-socket rejects every
  // connection with "password authentication failed for user X" —
  // pglite-socket runs the postgres wire protocol, which respects the
  // role's rolcanlogin attribute even though pglite itself is
  // single-user.
  await db.exec(`
    DO $pg$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
        CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
      ELSE
        ALTER ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
        CREATE ROLE harness_admin LOGIN PASSWORD 'harness_admin_pwd';
      ELSE
        ALTER ROLE harness_admin LOGIN PASSWORD 'harness_admin_pwd';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
        CREATE ROLE harness_zero LOGIN PASSWORD 'harness_zero_pwd';
      ELSE
        ALTER ROLE harness_zero LOGIN PASSWORD 'harness_zero_pwd';
      END IF;
    END $pg$;
  `);

  // First-boot DDL bootstrap. If a `dbSqlDir` is supplied and the
  // `harness_shared` schema doesn't yet exist, apply every .sql file
  // (sorted by filename) except the {{SCHEMA}}-templated per-harness one,
  // which gets rendered later by the scaffold-schema flow.
  if (opts?.dbSqlDir && existsSync(opts.dbSqlDir)) {
    const exists = await db.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'harness_shared'`,
    );
    if ((exists.rows ?? []).length === 0) {
      if (debug) console.log(`[pglite-server] first-boot DDL bootstrap from ${opts.dbSqlDir}`);
      const files = (await readdir(opts.dbSqlDir))
        .filter((f) => f.endsWith('.sql'))
        .filter((f) => !f.includes('per-harness-template'))
        .sort();
      for (const f of files) {
        if (debug) console.log(`[pglite-server]   apply ${f}`);
        const ddl = await readFile(join(opts.dbSqlDir, f), 'utf8');
        await db.exec(ddl);
      }

      // Per-harness schema stubs.
      //
      // @restart/zero-harness declares per-harness tables for a fixed list
      // of HARNESS_SLUGS (sheets, org, org_business, …) and zeroPostgresJS's
      // strict schema validation requires every declared table to exist
      // before any query executes. The CLI's `papercusp scaffold-schema`
      // creates these on demand for harnesses the user actually runs, but
      // for desktop/pglite mode we want every Zero-declared schema to
      // exist up front (otherwise /api/zero-harness/rest-query 500s with
      // 'Table "harness_<slug>.harness_features" is defined in your zero
      // schema but does not exist in the database').
      //
      // Render 002-per-harness-template.sql against each known slug.
      // Empty schemas; populated lazily as the user's projects produce
      // features/issues/etc.
      const tmplPath = join(opts.dbSqlDir, '002-per-harness-template.sql');
      if (existsSync(tmplPath)) {
        const HARNESS_SLUGS = opts?.harnessSlugs ?? [
          'sheets', 'org', 'org_business', 'org_coordination', 'org_management',
          'org_marketing', 'org_rd', 'org_technology', 'restart',
        ];
        const tmpl = await readFile(tmplPath, 'utf8');
        for (const slug of HARNESS_SLUGS) {
          const ddl = tmpl.replaceAll('{{SCHEMA}}', `harness_${slug}`);
          if (debug) console.log(`[pglite-server]   apply per-harness-template (slug=${slug})`);
          await db.exec(ddl);
        }
      }
    } else if (debug) {
      console.log(`[pglite-server] harness_shared exists — skipping DDL bootstrap`);
    }
  }

  // pglite-socket's published default is maxConnections=1 (despite the TS
  // doc claiming 100). postgres-js opens a connection pool (max 8 by
  // default), so we need to allow many concurrent client sockets even
  // though pglite serializes the actual queries internally.
  const maxConnections = opts?.maxConnections ?? 32;
  const server = new PGLiteSocketServer({ db, path: socketPath, debug, maxConnections });
  await server.start();

  return {
    db,
    server,
    socketPath,
    socketDir,
    port,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}
