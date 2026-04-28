#!/usr/bin/env node
import { startPgliteServer } from '../src/index.js';

const debug = process.env.PGLITE_DEBUG === '1';
const dataDir = process.env.PGLITE_DATA_DIR;
const socketDir = process.env.PGLITE_SOCKET_DIR;
const port = process.env.PGLITE_PORT ? Number(process.env.PGLITE_PORT) : undefined;
// If set, point at a directory of .sql files; first boot will apply them
// before the socket starts accepting client connections.
const dbSqlDir = process.env.PGLITE_DB_SQL_DIR;

const handle = await startPgliteServer({ dataDir, socketDir, port, debug, dbSqlDir });

console.log(`[pglite-server] ready on unix socket: ${handle.socketPath}`);
console.log(`[pglite-server] connect via: postgresql://harness_app@localhost/papercusp?host=${handle.socketDir}`);

const shutdown = async (sig) => {
  console.log(`[pglite-server] ${sig} — shutting down`);
  await handle.stop();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
