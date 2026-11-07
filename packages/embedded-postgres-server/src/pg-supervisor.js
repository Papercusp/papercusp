// Postmaster supervision for an embedded-postgres instance (WI-10003688).
//
// embedded-postgres spawns the postmaster as a child and then forgets about it: when
// that child exits on its own (disk full, OOM kill, a crash in WAL recovery) nothing
// restarts it, and the operator keeps running against a dead database until a human
// restarts the whole host. Measured on the Mac rig VM 2026-09-28: the data volume
// filled at 13:34Z, the postmaster died on ENOSPC, and DBOS queue errors ran for over
// an hour with every P2P flow on that host dead.
//
// The supervisor watches the child after a successful start and restarts it with a
// capped backoff whose last step repeats indefinitely. A disk-full death cannot
// recover until space is freed; when it is, the next attempt must succeed without an
// operator restart.

import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { errorMonitor } from 'node:events';

const startupOperation = new AsyncLocalStorage();
const clientSocketChannel = channel('net.client.socket');
const MAX_STARTUP_SOCKETS = 8;
const MAX_STARTUP_SOCKET_EVENTS = 32;

/**
 * @typedef {{
 *   phase: 'postmaster' | 'bootstrap-query',
 *   elapsedMs: number,
 *   sockets: Array<{ id: number, connecting: boolean, destroyed: boolean,
 *     bytesRead: number, bytesWritten: number, remoteAddress?: string, remotePort?: number }>,
 *   events: Array<{ socket: number, event: string, atMs: number,
 *     code?: string, address?: string, port?: number, family?: string | number }>,
 * }} PostgresStartupDiagnostics
 */

/**
 * Restart delays (ms) for a postmaster that exited on its own. The last step repeats.
 */
export const PG_RESTART_BACKOFF_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000, 60_000]);

/** How many recent postgres log lines are kept to classify a death. */
export const PG_DEATH_LOG_WINDOW = 50;

/**
 * Classify why the postmaster died from its most recent log lines.
 * @param {readonly string[]} recentLines
 * @returns {'disk-full' | 'unknown'}
 */
export function classifyPostgresDeath(recentLines) {
  return recentLines.some((l) => /No space left on device|ENOSPC/i.test(l)) ? 'disk-full' : 'unknown';
}

/**
 * A bounded ring of the most recent postgres log LINES. embedded-postgres hands its
 * onLog callback raw stderr chunks, which can hold several lines or a partial one.
 * @param {number} [size]
 */
export function createPostgresLogWindow(size = PG_DEATH_LOG_WINDOW) {
  /** @type {string[]} */
  const lines = [];
  return {
    /** @param {string} chunk */
    push(chunk) {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        lines.push(line);
        if (lines.length > size) lines.shift();
      }
    },
    /** @returns {readonly string[]} */
    lines: () => lines.slice(),
  };
}

/**
 * Add actionable context when embedded-postgres fails before the postmaster is ready.
 * Its start promise can reject with a non-Error value, including undefined, so the
 * captured postmaster output is part of the only useful diagnostic in that case.
 * @param {{ cause: unknown, port: number, dataDir: string, recentLines: readonly string[], diagnostics?: PostgresStartupDiagnostics }} opts
 * @returns {Error}
 */
export function createPostgresStartupError({ cause, port, dataDir, recentLines, diagnostics }) {
  let causeDescription;
  if (cause instanceof Error) {
    causeDescription = cause.message
      ? `${cause.name || 'Error'}: ${cause.message}`
      : `${cause.name || 'Error'} without a message`;
  } else if (cause === undefined) {
    causeDescription = 'embedded-postgres start promise rejected without an error value';
  } else if (cause === null) {
    causeDescription = 'embedded-postgres start promise rejected with null';
  } else if (typeof cause === 'string') {
    causeDescription = `embedded-postgres start promise rejected with ${JSON.stringify(cause)}`;
  } else {
    let rendered;
    try {
      rendered = JSON.stringify(cause);
    } catch {
      rendered = undefined;
    }
    causeDescription = rendered
      ? `embedded-postgres start promise rejected with ${rendered}`
      : 'embedded-postgres start promise rejected with a non-Error value';
  }

  const lines = recentLines.slice(-PG_DEATH_LOG_WINDOW);
  const logContext = lines.length > 0
    ? `\nRecent PostgreSQL startup output (last ${lines.length} lines):\n${lines.join('\n')}`
    : '\nNo PostgreSQL startup output was captured.';
  const phase = diagnostics?.phase === 'bootstrap-query' ? 'failed during bootstrap-query' : 'failed to start';
  const socketContext = diagnostics
    ? `\nPostgreSQL startup phases: ${JSON.stringify(diagnostics)}`
    : '';
  return Object.assign(new Error(
    `PostgreSQL ${phase} on localhost:${port} using data directory ${JSON.stringify(dataDir)}: ${causeDescription}${socketContext}${logContext}`,
    { cause },
  ), { postgresStartup: diagnostics });
}

/**
 * Observe connection phases without replacing the transport or consuming socket data.
 * Async context keeps concurrent bootstraps and unrelated clients out of the trace.
 * Listeners and the channel subscription live only as long as this operation.
 * @template T
 * @param {{
 *   start: () => Promise<T>,
 *   port: number,
 *   dataDir: string,
 *   recentLines: () => readonly string[],
 *   phase?: 'postmaster' | 'bootstrap-query',
 * }} opts
 * @returns {Promise<T>}
 */
export async function startPostgresWithDiagnostics({ start, port, dataDir, recentLines, phase = 'postmaster' }) {
  const operation = Symbol('postgres-startup');
  const startedAt = Date.now();
  /** @type {PostgresStartupDiagnostics['events']} */
  const events = [];
  /** @type {Map<import('node:net').Socket, number>} */
  const sockets = new Map();
  /** @type {Array<() => void>} */
  const cleanup = [];
  let active = true;
  /** @param {unknown} message */
  const observeSocket = (message) => {
    if (!active || startupOperation.getStore() !== operation || sockets.size >= MAX_STARTUP_SOCKETS) return;
    const socket = /** @type {{ socket: import('node:net').Socket }} */ (message).socket;
    if (!socket || sockets.has(socket)) return;
    const id = sockets.size + 1;
    sockets.set(socket, id);
    /** @param {string} event @param {Partial<PostgresStartupDiagnostics['events'][number]>} [detail] */
    const record = (event, detail = {}) => {
      if (active && events.length < MAX_STARTUP_SOCKET_EVENTS) {
        events.push({ socket: id, event, atMs: Date.now() - startedAt, ...detail });
      }
    };
    /** @param {string | symbol} event @param {(...args: any[]) => void} listener */
    const listen = (event, listener) => {
      socket.on(event, listener);
      cleanup.push(() => socket.removeListener(event, listener));
    };
    record('created');
    listen('lookup', (error, address, family) => record('lookup', { code: error?.code, address, family }));
    listen('connectionAttempt', (address, port, family) => record('connectionAttempt', { address, port, family }));
    listen('connectionAttemptFailed', (address, port, family, error) => record('connectionAttemptFailed', { address, port, family, code: error?.code }));
    listen('connectionAttemptTimeout', (address, port, family) => record('connectionAttemptTimeout', { address, port, family }));
    listen('connect', () => record('connect'));
    // errorMonitor observes failures without turning an unhandled socket error into a handled one.
    listen(errorMonitor, (error) => record('error', { code: error?.code }));
    listen('timeout', () => record('timeout'));
    listen('close', () => record('close'));
  };
  clientSocketChannel.subscribe(observeSocket);
  try {
    return await startupOperation.run(operation, start);
  } catch (cause) {
    throw createPostgresStartupError({
      cause,
      port,
      dataDir,
      recentLines: recentLines(),
      diagnostics: {
        phase,
        elapsedMs: Date.now() - startedAt,
        events,
        sockets: [...sockets].map(([socket, id]) => ({
          id, connecting: socket.connecting, destroyed: socket.destroyed,
          bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten,
          remoteAddress: socket.remoteAddress, remotePort: socket.remotePort,
        })),
      },
    });
  } finally {
    active = false;
    clientSocketChannel.unsubscribe(observeSocket);
    for (const remove of cleanup) remove();
  }
}

/**
 * True when a child process has already exited, so waiting for its 'exit' event
 * would hang forever (node emits 'exit' once and never replays it).
 * @param {{ exitCode?: number | null, signalCode?: string | null } | undefined | null} child
 */
export function childHasExited(child) {
  return !!child && (child.exitCode != null || child.signalCode != null);
}

/**
 * @typedef {{
 *   code: number | null,
 *   signal: string | null,
 *   cause: 'disk-full' | 'unknown',
 *   freeBytes: number | null,
 *   nextAttemptInMs: number,
 *   attempt: number,
 * }} PostgresExitEvent
 */

/**
 * @typedef {{
 *   state: 'running' | 'restarting' | 'stopped',
 *   restarts: number,
 *   pendingAttempt: number,
 *   lastExit: null | { at: string, code: number | null, signal: string | null, cause: string, freeBytes: number | null },
 * }} PostgresSupervisorHealth
 */

/**
 * Watch an embedded-postgres instance after a successful start and restart it with
 * capped backoff whenever the postmaster exits without a stop() request.
 *
 * @param {{
 *   pg: { process?: any, start(): Promise<void> },
 *   dataDir: string,
 *   log: (m: string) => void,
 *   recentLines: () => readonly string[],
 *   backoffMs?: readonly number[],
 *   freeBytes?: (dir: string) => Promise<number | null>,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (t: unknown) => void,
 *   onExit?: (e: PostgresExitEvent) => void,
 *   onRestarted?: (e: { attempt: number }) => void,
 * }} deps
 * @returns {{ health(): PostgresSupervisorHealth, stop(): Promise<void> }}
 */
export function superviseEmbeddedPostgres(deps) {
  const backoff = deps.backoffMs?.length ? deps.backoffMs : PG_RESTART_BACKOFF_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(/** @type {any} */ (t)));
  const freeBytes = deps.freeBytes ?? defaultFreeBytes;
  /** @type {'running' | 'restarting' | 'stopped'} */
  let state = 'running';
  let attempt = 0;
  let restarts = 0;
  /** @type {unknown} */
  let timer = null;
  /** @type {Promise<void> | null} */
  let inflight = null;
  /** @type {PostgresSupervisorHealth['lastExit']} */
  let lastExit = null;

  const watch = () => {
    const child = deps.pg.process;
    if (!child) return;
    if (childHasExited(child)) {
      void onDeath(child.exitCode ?? null, child.signalCode ?? null);
      return;
    }
    child.once('exit', (/** @type {number | null} */ code, /** @type {string | null} */ signal) => {
      if (state === 'stopped' || deps.pg.process !== child) return;
      void onDeath(code, signal ?? null);
    });
  };

  /** @param {'disk-full' | 'unknown'} cause */
  const freeFor = async (cause) =>
    cause === 'disk-full' ? await freeBytes(deps.dataDir).catch(() => null) : null;

  /**
   * @param {number | null} code
   * @param {string | null} signal
   */
  const onDeath = async (code, signal) => {
    if (state === 'stopped') return;
    state = 'restarting';
    const cause = classifyPostgresDeath(deps.recentLines());
    const free = await freeFor(cause);
    lastExit = { at: new Date().toISOString(), code, signal, cause, freeBytes: free };
    schedule(code, signal, cause, free);
  };

  /**
   * @param {number | null} code
   * @param {string | null} signal
   * @param {'disk-full' | 'unknown'} cause
   * @param {number | null} free
   */
  const schedule = (code, signal, cause, free) => {
    if (state === 'stopped') return;
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    attempt += 1;
    deps.log(
      `postgres exited unexpectedly (code=${code} signal=${signal} cause=${cause}` +
        (cause === 'disk-full' ? ` freeBytes=${free ?? 'unknown'} dataDir=${deps.dataDir}` : '') +
        `); restart attempt ${attempt} in ${delay}ms`,
    );
    deps.onExit?.({ code, signal, cause, freeBytes: free, nextAttemptInMs: delay, attempt });
    timer = setTimer(() => {
      timer = null;
      inflight = tryRestart().finally(() => {
        inflight = null;
      });
    }, delay);
  };

  const tryRestart = async () => {
    if (state === 'stopped') return;
    try {
      await deps.pg.start();
    } catch (e) {
      if (state === 'stopped') return;
      const cause = classifyPostgresDeath(deps.recentLines());
      const free = await freeFor(cause);
      const msg = /** @type {any} */ (e)?.message || 'postmaster exited before ready';
      deps.log(`postgres restart attempt ${attempt} failed: ${msg}`);
      schedule(null, null, cause, free);
      return;
    }
    // stop() arrived while this attempt was starting: the caller's stop path awaits
    // `inflight` and then stops whatever this attempt left running.
    if (state === 'stopped') return;
    restarts += 1;
    deps.log(`postgres restarted after ${attempt} attempt(s)`);
    deps.onRestarted?.({ attempt });
    attempt = 0;
    state = 'running';
    watch();
  };

  watch();
  return {
    health: () => ({ state, restarts, pendingAttempt: state === 'restarting' ? attempt : 0, lastExit }),
    async stop() {
      state = 'stopped';
      if (timer) clearTimer(timer);
      timer = null;
      if (inflight) await inflight.catch(() => {});
    },
  };
}

/** @param {string} dir */
async function defaultFreeBytes(dir) {
  const { statfs } = await import('node:fs/promises');
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}
