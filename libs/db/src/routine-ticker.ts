/**
 * Routine ticker — substrate service that fires due cron routines.
 *
 * Runs as a long-lived async loop (or invoked periodically by an external
 * scheduler). On each tick:
 *   1. Queries listDueCronRoutines()
 *   2. For each due routine, calls fireRoutine() which inserts a
 *      pending_event AND advances next_fire_at
 *   3. Sleeps tickIntervalMs (default 30s)
 *
 * Webhook + API routines don't go through here — they insert events
 * directly when their handlers fire. Only cron is time-driven.
 *
 * Cron parsing is injected via the `nextFireAt` callback so callers can
 * choose their own cron-parser library (cron-parser, croner, etc.).
 */

import type { Sql } from 'postgres';
import { listDueCronRoutines, fireRoutine, type RoutineRow } from './routines-runtime';

export interface RoutineTickerOptions {
  /** Sleep between ticks. Default 30 seconds. */
  tickIntervalMs?: number;
  /** Compute next-fire timestamp from a cron expression. */
  computeNextFireAt: (cronExpr: string, from: Date) => Date | null;
  /** Called when a routine fires. Useful for logging/metrics. */
  onFire?: (routine: RoutineRow, eventId: string) => void;
  /** Called when a routine is skipped due to concurrency policy. */
  onSkip?: (routine: RoutineRow) => void;
  /** Called on errors per-routine; returns true to stop the loop, false to continue. */
  onError?: (err: Error, routine?: RoutineRow) => boolean;
}

export interface RoutineTickerHandle {
  /** Stop the loop after the current tick completes. */
  stop(): void;
  /** Promise that resolves when the loop stops. */
  done: Promise<void>;
}

/**
 * Start the routine ticker. Returns a handle the caller can stop.
 *
 * The loop is fault-tolerant: errors firing one routine don't stop others.
 * Errors listing routines (e.g. DB disconnect) by default stop the loop.
 */
export function startRoutineTicker(sql: Sql, opts: RoutineTickerOptions): RoutineTickerHandle {
  const interval = opts.tickIntervalMs ?? 30_000;
  let stopped = false;
  let stopResolve: (() => void) | null = null;

  const done = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });

  (async () => {
    while (!stopped) {
      try {
        const due = await listDueCronRoutines(sql);
        for (const routine of due) {
          if (stopped) break;
          try {
            const result = await fireRoutine(sql, routine, opts.computeNextFireAt);
            if (result === null) {
              opts.onSkip?.(routine);
            } else {
              opts.onFire?.(routine, result.eventId);
            }
          } catch (e) {
            const stop = opts.onError?.(e as Error, routine) ?? false;
            if (stop) { stopped = true; break; }
          }
        }
      } catch (e) {
        const stop = opts.onError?.(e as Error) ?? true;  // top-level errors halt by default
        if (stop) break;
      }

      // Sleep until next tick, with early-wake support.
      if (stopped) break;
      await new Promise((r) => setTimeout(r, interval));
    }
    // Re-assert the union type: under strict CFA the executor-closure
    // assignment to `stopResolve` isn't modeled, so TS narrows it to `null`
    // here (→ "never has no call signatures"). The cast restores callability.
    (stopResolve as (() => void) | null)?.();
  })();

  return {
    stop() { stopped = true; },
    done,
  };
}
