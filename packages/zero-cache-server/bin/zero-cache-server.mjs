#!/usr/bin/env node
/**
 * Standalone bin: spawn @rocicorp/zero's zero-cache against a Papercusp
 * embedded-postgres. Mirrors zero-cache's own env shape so the production
 * docker container and this local sidecar use the same contract.
 *
 * Env (required):
 *   PAPERCUSP_ZERO_UPSTREAM_DB    postgres URL with REPLICATION grant
 *
 * Env (optional):
 *   PAPERCUSP_ZERO_PORT           default 14848
 *   PAPERCUSP_ZERO_CHANGE_STREAMER_PORT  default PORT-1
 *   PAPERCUSP_ZERO_REPLICA_DIR    default ~/.papercusp/zero-replica
 *   PAPERCUSP_ZERO_QUERY_URL      operator's /api/zero-harness-query URL (named-query resolver)
 *   PAPERCUSP_ZERO_APP_ID         default 'papercusp'
 *   PAPERCUSP_ZERO_PUBLICATIONS   default 'zero_harness'
 *   PAPERCUSP_ZERO_DEBUG          '1' for verbose logs
 */

import { startZeroCacheServer } from '../src/index.js';

const upstreamDb = process.env.PAPERCUSP_ZERO_UPSTREAM_DB;
if (!upstreamDb) {
  console.error('PAPERCUSP_ZERO_UPSTREAM_DB is required');
  process.exit(2);
}

const handle = await startZeroCacheServer({
  upstreamDb,
  port: process.env.PAPERCUSP_ZERO_PORT ? Number(process.env.PAPERCUSP_ZERO_PORT) : undefined,
  changeStreamerPort: process.env.PAPERCUSP_ZERO_CHANGE_STREAMER_PORT
    ? Number(process.env.PAPERCUSP_ZERO_CHANGE_STREAMER_PORT) : undefined,
  replicaDir: process.env.PAPERCUSP_ZERO_REPLICA_DIR,
  queryUrl: process.env.PAPERCUSP_ZERO_QUERY_URL,
  appId: process.env.PAPERCUSP_ZERO_APP_ID,
  publications: process.env.PAPERCUSP_ZERO_PUBLICATIONS,
  adminPassword: process.env.ZERO_ADMIN_PASSWORD,
  debug: process.env.PAPERCUSP_ZERO_DEBUG === '1',
});

console.log(`[zero-cache-server] ready ws://127.0.0.1:${handle.port} (change-streamer ${handle.changeStreamerPort}, replica ${handle.replicaFile})`);

const shutdown = async (sig) => {
  console.log(`[zero-cache-server] ${sig} — shutting down`);
  await handle.stop();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
