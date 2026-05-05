#!/usr/bin/env node
/**
 * Standalone bin: boot embedded-postgres + apply migrations + idle until
 * SIGINT/SIGTERM. Mirrors pglite-server's bin so the desktop sidecar can
 * swap one for the other by changing the binary path.
 *
 * Env vars:
 *   PAPERCUSP_PG_DATA_DIR   — Postgres data dir (default: ~/.papercusp/embedded-pg-data)
 *   PAPERCUSP_PG_PORT       — TCP port (default: 5532)
 *   PAPERCUSP_PG_DB_NAME    — DB name (default: papercusp)
 *   PAPERCUSP_PG_SQL_DIR    — Path to *.sql migration directory (optional)
 *   PAPERCUSP_PG_DEBUG      — '1' for verbose logging
 */

import { startEmbeddedPostgresServer } from '../src/index.js';

const debug = process.env.PAPERCUSP_PG_DEBUG === '1';
const dataDir = process.env.PAPERCUSP_PG_DATA_DIR;
const port = process.env.PAPERCUSP_PG_PORT ? Number(process.env.PAPERCUSP_PG_PORT) : undefined;
const dbName = process.env.PAPERCUSP_PG_DB_NAME;
const dbSqlDir = process.env.PAPERCUSP_PG_SQL_DIR;

const handle = await startEmbeddedPostgresServer({
  dataDir,
  port,
  dbName,
  dbSqlDir,
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
