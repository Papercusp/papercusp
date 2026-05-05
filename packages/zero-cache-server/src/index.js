/**
 * Spawn @rocicorp/zero's zero-cache against a Papercusp-managed PG.
 *
 * Mirrors the production deploy (docker-compose.papercup.prod.yml's
 * zero-cache service) — same env shape, just running locally for
 * desktop builds. After embedded-postgres-server is ready and has
 * created the `zero_harness` publication, the desktop's Tauri main
 * spawns this process; it talks PG logical replication to embedded-pg
 * and exposes a WebSocket server for browser clients.
 *
 * Returned handle exposes the WS port + a stop() method. The Tauri
 * sidecar's HarnessZeroProvider connects to ws://127.0.0.1:<port>/.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_APP_ID = 'papercusp';
const DEFAULT_PUBLICATIONS = 'zero_harness';

/**
 * @param {object} opts
 * @param {string} opts.upstreamDb       Postgres URL the zero-cache subscribes to.
 *                                       Should be a `harness_zero` role with REPLICATION attr.
 * @param {string} [opts.queryUrl]       Named-query resolver URL (operator's /api/zero-harness-query).
 * @param {string} [opts.replicaDir]     Where to keep replica.db. Default: ~/.papercusp/zero-replica
 * @param {number} [opts.port]           WS listening port. Default: 14848.
 * @param {number} [opts.changeStreamerPort] Required because default is port+1; lets us avoid collisions.
 *                                       Default: port - 1 (so we control the pair).
 * @param {string} [opts.appId]          ZERO_APP_ID — namespace for replica + metadata. Default 'papercusp'.
 * @param {string} [opts.publications]   Publication name(s). Default 'zero_harness'.
 * @param {string} [opts.adminPassword]  ZERO_ADMIN_PASSWORD. Default 'papercusp-local'.
 * @param {boolean} [opts.debug]
 * @param {(m: string) => void} [opts.onLog]
 */
export async function startZeroCacheServer(opts) {
  if (!opts?.upstreamDb) throw new Error('startZeroCacheServer: upstreamDb is required');

  const port = opts.port ?? 14848;
  const changeStreamerPort = opts.changeStreamerPort ?? (port - 1);
  const replicaDir = opts.replicaDir ?? join(homedir(), '.papercusp', 'zero-replica');
  const replicaFile = join(replicaDir, 'replica.db');
  const appId = opts.appId ?? DEFAULT_APP_ID;
  const publications = opts.publications ?? DEFAULT_PUBLICATIONS;
  const adminPassword = opts.adminPassword ?? 'papercusp-local';
  const debug = !!opts.debug;
  const log = opts.onLog ?? ((m) => debug && console.log(`[zero-cache-server] ${m}`));

  await mkdir(replicaDir, { recursive: true });

  // Locate the zero-cache binary inside our own node_modules.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'node_modules', '.bin', 'zero-cache'),
    join(here, '..', '..', 'node_modules', '.bin', 'zero-cache'),
    join(here, '..', '..', '..', 'node_modules', '.bin', 'zero-cache'),
  ];
  const zeroCacheBin = candidates.find((p) => existsSync(p));
  if (!zeroCacheBin) {
    throw new Error(
      `zero-cache binary not found. Looked in:\n  ${candidates.join('\n  ')}\n` +
      'Make sure @rocicorp/zero is installed in this package or hoisted to a parent node_modules.',
    );
  }

  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? 'production',
    ZERO_APP_ID: appId,
    ZERO_UPSTREAM_DB: opts.upstreamDb,
    ZERO_CHANGE_DB: opts.upstreamDb,           // same DB; zero supports a separate change-DB but localhost doesn't need it
    ZERO_REPLICA_FILE: replicaFile,
    ZERO_APP_PUBLICATIONS: publications,
    ZERO_ADMIN_PASSWORD: adminPassword,
    ZERO_PORT: String(port),
    ZERO_CHANGE_STREAMER_PORT: String(changeStreamerPort),
    // Suppress connection-pool warnings on localhost.
    ZERO_NUM_SYNC_WORKERS: process.env.ZERO_NUM_SYNC_WORKERS ?? '2',
  };
  if (opts.queryUrl) env.ZERO_QUERY_URL = opts.queryUrl;

  log(`spawning ${zeroCacheBin} (port=${port}, change-streamer-port=${changeStreamerPort})`);

  const child = spawn(zeroCacheBin, [], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  return {
    port,
    changeStreamerPort,
    replicaFile,
    pid: child.pid,
    async stop() {
      log('stopping');
      try {
        child.kill('SIGTERM');
        await new Promise((resolve) => {
          const t = setTimeout(() => { child.kill('SIGKILL'); resolve(undefined); }, 5000);
          child.on('exit', () => { clearTimeout(t); resolve(undefined); });
        });
      } catch (e) {
        log(`stop error: ${e?.message ?? e}`);
      }
    },
  };
}
