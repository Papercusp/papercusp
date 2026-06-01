/**
 * Refcounted shared LISTEN connection per workspace.
 *
 * One LISTEN subscription per workspace channel `ch_coord_<wsId>`,
 * shared across every waiter on that workspace. Each subscriber gets
 * every payload and filters by its own ticket_id — the listener is a
 * bare wake-bus, not a router.
 *
 * postgres-js's `sql.listen()` handles reconnects automatically; on
 * resume it re-sends LISTEN. Audit 4 #3 wanted explicit re-issue; the
 * library does it for us. The 30s ceiling on each await iteration in
 * acquire.ts is the second-layer safety net for any silent drop the
 * library misses.
 *
 * Listener-pool cap (reviewer #3): MAX_ACTIVE_WORKSPACES = 20.
 * 21st workspace's subscribeWorkspace throws TooManyActiveWorkspacesError
 * so the caller can return a clean `too_many_active_workspaces` rather
 * than hanging on a full connection pool.
 *
 * This module also owns the BACKGROUND EXPIRY JANITOR (file-locking #4):
 * the 30s timer that periodically calls runBackgroundJanitorOnce(). It
 * lives here — alongside the listener subscriptions — because this is
 * the locks subsystem's home for long-lived background state; the sweep
 * WORK itself stays in su-lock-store.ts (storage layer). inWorkspaceTxn
 * arms the timer on the first mutating op.
 */

import { getListenerPool, runBackgroundJanitorOnce } from './su-lock-store';

const MAX_ACTIVE_WORKSPACES = 20;

type Listener = (ticketId: string, kind: string) => void;

interface WorkspaceState {
  unlisten: () => Promise<void>;
  listeners: Set<Listener>;
}

const STATE = new Map<string, WorkspaceState>();

export class TooManyActiveWorkspacesError extends Error {
  constructor() {
    super('too_many_active_workspaces');
    this.name = 'TooManyActiveWorkspacesError';
  }
}

/**
 * Subscribe to grant notifications on a workspace. The callback fires
 * for EVERY payload on the channel — the caller filters by its own
 * ticket_id. Returns an unsubscribe fn the caller MUST invoke when the
 * wait completes.
 */
export async function subscribeWorkspace(
  coordinationDomain: string,
  listener: Listener,
): Promise<() => Promise<void>> {
  let state = STATE.get(coordinationDomain);

  if (!state) {
    if (STATE.size >= MAX_ACTIVE_WORKSPACES) {
      throw new TooManyActiveWorkspacesError();
    }
    const sql = getListenerPool();
    const channel = `ch_coord_${coordinationDomain}`;
    const listeners = new Set<Listener>();

    const req = sql.listen(channel, (payload) => {
      // Payload format: "<ticket_id>" or "<ticket_id>:<kind>".
      // grant_cascade.sql sends just ticket_id; ":kind" is reserved.
      const colon = payload.indexOf(':');
      const tid = colon >= 0 ? payload.slice(0, colon) : payload;
      const kind = colon >= 0 ? payload.slice(colon + 1) : 'granted';
      // Iterate defensively: one subscriber's callback throwing must
      // not prevent siblings from waking. Subscribers should never
      // throw (the wake-resolver is trivial code) but defense-in-depth
      // is cheap.
      for (const cb of listeners) {
        try {
          cb(tid, kind);
        } catch {
          /* swallow — listener bus must stay alive */
        }
      }
    });
    const result = await req;

    state = { unlisten: result.unlisten, listeners };
    STATE.set(coordinationDomain, state);
  }

  state.listeners.add(listener);

  return async () => {
    const cur = STATE.get(coordinationDomain);
    if (!cur) return;
    cur.listeners.delete(listener);
    if (cur.listeners.size === 0) {
      STATE.delete(coordinationDomain);
      try {
        await cur.unlisten();
      } catch {
        // Best-effort — pool may already be torn down.
      }
    }
  };
}

// ───────── Background expiry janitor (file-locking #4) ─────────

/** Period of the background expiry sweep. */
const BACKGROUND_JANITOR_INTERVAL_MS = 30_000;

let janitorTimer: ReturnType<typeof setInterval> | null = null;
let janitorPassInFlight = false;

/**
 * Arm the 30s background janitor. Idempotent — a second call while the
 * timer is already armed is a no-op. Armed by inWorkspaceTxn on the
 * first mutating locks:* op in a non-test process; tests skip the timer
 * and call runBackgroundJanitorOnce() directly so no wall-clock tick
 * races their fixtures.
 *
 * The interval is unref'd — it never keeps the process alive on its
 * own — and a pass never overlaps itself (janitorPassInFlight guard:
 * if a sweep is still running when the next tick fires, that tick is
 * skipped rather than stacked).
 */
export function startBackgroundJanitor(): void {
  if (janitorTimer) return;
  janitorTimer = setInterval(() => {
    if (janitorPassInFlight) return;
    janitorPassInFlight = true;
    void runBackgroundJanitorOnce()
      .catch((err) =>
        console.error('[su-locks] background janitor pass failed', err),
      )
      .finally(() => {
        janitorPassInFlight = false;
      });
  }, BACKGROUND_JANITOR_INTERVAL_MS);
  janitorTimer.unref?.();
}

/** Stop the background janitor. Idempotent. */
export function stopBackgroundJanitor(): void {
  if (janitorTimer) {
    clearInterval(janitorTimer);
    janitorTimer = null;
  }
}

/** Test-only — drop all subscriptions and stop the background janitor. */
export async function _resetListenersForTests(): Promise<void> {
  stopBackgroundJanitor();
  const states = Array.from(STATE.values());
  STATE.clear();
  await Promise.allSettled(states.map((s) => s.unlisten()));
}

export function _activeWorkspaceCount(): number {
  return STATE.size;
}
