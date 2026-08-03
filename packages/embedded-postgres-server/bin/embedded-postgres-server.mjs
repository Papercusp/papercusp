#!/usr/bin/env node
/**
 * Standalone bin: boot embedded-postgres + apply migrations + idle until
 * SIGINT/SIGTERM. Mirrors pglite-server's bin so the desktop sidecar can
 * swap one for the other by changing the binary path.
 *
 * Env vars:
 *   PAPERCUSP_PG_DATA_DIR        — Postgres data dir (default: ~/.papercusp/embedded-pg-data)
 *   PAPERCUSP_PG_PORT            — TCP port (default: 5532)
 *   PAPERCUSP_PG_DB_NAME         — DB name (default: papercusp)
 *   PAPERCUSP_PG_SQL_DIR         — Path to *.sql migration directory (optional)
 *   PAPERCUSP_PG_CREATE_USER     — '1' to create/setuid a postgres OS user (root-only hosts, e.g. cloud frames)
 *   PAPERCUSP_PG_DEBUG           — '1' for verbose logging
 */

import { startEmbeddedPostgresServer } from '../src/index.js';

const debug = process.env.PAPERCUSP_PG_DEBUG === '1';
const dataDir = process.env.PAPERCUSP_PG_DATA_DIR;
const port = process.env.PAPERCUSP_PG_PORT ? Number(process.env.PAPERCUSP_PG_PORT) : undefined;
const dbName = process.env.PAPERCUSP_PG_DB_NAME;
const dbSqlDir = process.env.PAPERCUSP_PG_SQL_DIR;

// PAPERCUSP_PG_SEED_DUMP_PATH / PAPERCUSP_PG_RESTORE_BIN were read here and passed
// through as seedDumpPath/pgRestoreBin — but startEmbeddedPostgresServer() has not
// accepted either since the seed-restore path was retired
// (self-contained-migration-baseline-2026-06-02 D-004; tombstone at src/index.js:499).
// They were silently dropped on arrival, so documenting them as working env vars was
// actively misleading. Removed with the build-side bake (EI-19455334533123459).
const handle = await startEmbeddedPostgresServer({
  dataDir,
  port,
  dbName,
  dbSqlDir,
  createPostgresUser: process.env.PAPERCUSP_PG_CREATE_USER === '1',
  debug,
});

console.log(`[embedded-postgres-server] ready on localhost:${handle.port} db=${handle.dbName}`);
console.log(`[embedded-postgres-server] admin:  ${handle.urls.admin}`);
console.log(`[embedded-postgres-server] app:    ${handle.urls.app}`);
console.log(`[embedded-postgres-server] zero:   ${handle.urls.zero}`);

const shutdown = async (sig) => {
  console.log(`[embedded-postgres-server] ${sig} — shutting down`);
  await handle.stop();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
