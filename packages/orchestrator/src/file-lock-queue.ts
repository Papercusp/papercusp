/**
 * FileLockQueue — exclusive, deadlock-free file-path locks for the
 * worker chunk loop.
 *
 * Why this exists: the chunk-locking model wants a worker to atomically
 * acquire a set of file paths, do its edits, commit, and release.
 * Multiple workers run concurrently and may want overlapping path sets.
 * We need a primitive that:
 *
 *   1. Acquires a whole set atomically (no partial holds).
 *   2. Never deadlocks, no matter how many workers contend.
 *   3. Is FIFO-fair per-path so hot files don't starve.
 *   4. Supports mid-chunk extension (atomic if all new paths are free,
 *      otherwise the caller must release-all and re-acquire).
 *
 * Deadlock-freedom comes from the canonical-ordering rule: every set is
 * sorted alphabetically before the actual hold is taken, and a waiter
 * only ever waits inside `acquire` (never holding any locks while
 * waiting for a *new* one). The extend operation is best-effort: it
 * succeeds only when every new path is free at the moment of the
 * request; otherwise the caller releases everything and re-acquires the
 * full union.
 *
 * In-process only. The orchestrator runs in a single Node process; if
 * we ever need cross-process locking, the API surface stays the same
 * but the implementation switches to filesystem-backed advisory locks.
 *
 * Glob expansion is the caller's responsibility — pass in resolved
 * file paths, not patterns. Globs would either need to be expanded at
 * acquire time (slow + filesystem-dependent) or treated as opaque
 * strings (then `src/foo.ts` and `src/**` wouldn't conflict, defeating
 * the purpose). Forcing the caller to expand keeps the data model
 * simple.
 */

export interface LockHandle {
  /** Stable identifier used in diagnostics + reaping. Caller-supplied
   *  but typically `<feature-id>-<chunk-id>` or `<worker-pid>`. */
  readonly owner: string;
  /** Sorted, deduplicated list of paths currently held. Mutates on
   *  successful `extend`. */
  paths: readonly string[];
  /** Internal release callback — sets a flag so we no-op subsequent
   *  release() calls. */
  released: boolean;
}

interface Waiter {
  owner: string;
  /** Sorted list of paths the waiter wants to acquire atomically. */
  paths: readonly string[];
  /** Resolves with the LockHandle once all paths are taken. */
  resolve: (handle: LockHandle) => void;
  /** Resolves with an error if the queue is destroyed before grant. */
  reject: (err: Error) => void;
  /** Order-of-arrival sequence number, used for FIFO scheduling. */
  seq: number;
}

export class FileLockQueue {
  /** path → ownerId currently holding it. */
  private heldBy = new Map<string, string>();

  /** Ordered queue of pending waiters. We don't keep per-path queues
   *  because each waiter wants a *set* atomically — a per-path queue
   *  would break the all-or-nothing semantics. We process the queue
   *  on every release and grant any waiter whose entire set is free. */
  private waiters: Waiter[] = [];

  /** Monotonic sequence used both for FIFO and for diagnostics. */
  private nextSeq = 1;

  /** Set on destroy() so subsequent acquires reject immediately and
   *  pending waiters get drained. */
  private destroyed = false;

  /**
   * Acquire all paths atomically. Resolves once every path is held by
   * `owner`. If any path is held by someone else, the request joins
   * the FIFO and resolves later (after some release frees the
   * contended paths).
   *
   * Paths are normalized: whitespace-trimmed, deduplicated, sorted. The
   * sort is the deadlock-freedom rule.
   */
  async acquire(owner: string, paths: readonly string[]): Promise<LockHandle> {
    if (this.destroyed) throw new Error('FileLockQueue destroyed');
    const sorted = canonicalize(paths);
    if (sorted.length === 0) {
      // Empty acquire is legal (no-op handle); makes calling code
      // simpler when the chunk happens to declare zero files.
      return makeHandle(owner, sorted);
    }

    // Fast path: all free, no waiters ahead of us. Take immediately.
    if (this.waiters.length === 0 && this.allFree(sorted)) {
      this.takeAll(owner, sorted);
      return makeHandle(owner, sorted);
    }

    // Queued path. We push the waiter, then drain — drainWaiters may
    // immediately grant us if our path-set doesn't conflict with the
    // head waiter's reservation. (Without this, a non-conflicting
    // waiter would sit queued forever even though it could proceed.)
    return new Promise<LockHandle>((resolve, reject) => {
      const waiter: Waiter = {
        owner,
        paths: sorted,
        resolve: (h) => resolve(h),
        reject,
        seq: this.nextSeq++,
      };
      this.waiters.push(waiter);
      this.drainWaiters();
    });
  }

  /**
   * Try to add additional paths to an existing handle without
   * releasing what's already held. Succeeds only if every new path is
   * currently free AND no FIFO-earlier waiter wants any of them. On
   * success the handle's `paths` is updated to include them and
   * `release` will release all of them.
   *
   * On failure the caller should `release(handle)` and re-acquire the
   * full union via `acquire`. That's the deadlock-free fallback.
   */
  tryExtend(handle: LockHandle, additional: readonly string[]): boolean {
    if (this.destroyed) return false;
    if (handle.released) {
      throw new Error(`tryExtend: handle for ${handle.owner} already released`);
    }
    const want = canonicalize(additional).filter((p) => !handle.paths.includes(p));
    if (want.length === 0) return true;

    // Refuse if any older waiter is queued for any of these paths;
    // otherwise an extender perpetually starves a fair waiter.
    const hasEarlierWaiterWanting = this.waiters.some((w) =>
      w.paths.some((p) => want.includes(p)),
    );
    if (hasEarlierWaiterWanting) return false;

    if (!this.allFree(want)) return false;

    this.takeAll(handle.owner, want);
    (handle as { paths: readonly string[] }).paths = canonicalize([
      ...handle.paths,
      ...want,
    ]);
    return true;
  }

  /**
   * Release every path the handle holds. Idempotent — calling release
   * on an already-released handle is a no-op (so callers can `release`
   * unconditionally in `finally` blocks).
   */
  release(handle: LockHandle): void {
    if (handle.released) return;
    handle.released = true;
    for (const p of handle.paths) {
      const cur = this.heldBy.get(p);
      if (cur === handle.owner) this.heldBy.delete(p);
      // If cur is some other owner, that's a bug somewhere upstream;
      // we do nothing rather than throw — release should be safe to
      // call from cleanup paths.
    }
    this.drainWaiters();
  }

  /**
   * For tests + diagnostics. Returns a snapshot of held paths.
   */
  snapshot(): { held: Record<string, string>; queueLength: number } {
    const held: Record<string, string> = {};
    for (const [p, o] of this.heldBy) held[p] = o;
    return { held, queueLength: this.waiters.length };
  }

  /**
   * Force-release everything held by `owner`. Used by the reaper when
   * a worker process dies without cleanly releasing.
   */
  reap(owner: string): number {
    let n = 0;
    for (const [p, o] of [...this.heldBy]) {
      if (o === owner) {
        this.heldBy.delete(p);
        n++;
      }
    }
    if (n > 0) this.drainWaiters();
    return n;
  }

  /**
   * Reject all pending waiters and refuse new acquires. Held locks are
   * untouched (the caller can still `release` outstanding handles).
   */
  destroy(): void {
    this.destroyed = true;
    const err = new Error('FileLockQueue destroyed');
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) w.reject(err);
  }

  // ─── Internals ────────────────────────────────────────────────────

  private allFree(paths: readonly string[]): boolean {
    for (const p of paths) if (this.heldBy.has(p)) return false;
    return true;
  }

  private takeAll(owner: string, paths: readonly string[]): void {
    for (const p of paths) this.heldBy.set(p, owner);
  }

  /**
   * Walk the FIFO and grant any waiter whose full path-set is free.
   * Strictly-FIFO would only grant waiter[0] when its set frees, but
   * that's pessimistic — if waiter[0] needs `a, b` and `a` is held,
   * waiter[1] who needs `c, d` (entirely free) shouldn't have to wait.
   *
   * The fairness compromise: we never *skip past* waiter[0] for a
   * waiter that conflicts with what waiter[0] wants. So waiter[0]
   * gets first dibs on every path it touches, but unrelated waiters
   * can proceed.
   */
  private drainWaiters(): void {
    if (this.waiters.length === 0) return;
    // Reserved set = paths the head waiter wants but can't yet take.
    // Any later waiter touching one of these must wait for the head.
    const head = this.waiters[0];
    const headBlocked = !this.allFree(head.paths);
    const reserved = new Set<string>(headBlocked ? head.paths : []);

    const next: Waiter[] = [];
    for (const w of this.waiters) {
      const conflictsWithReserved = w.paths.some((p) => reserved.has(p));
      const allMine = this.allFree(w.paths);
      if (allMine && !conflictsWithReserved) {
        this.takeAll(w.owner, w.paths);
        w.resolve(makeHandle(w.owner, w.paths));
      } else {
        next.push(w);
      }
    }
    this.waiters = next;
  }
}

function canonicalize(paths: readonly string[]): readonly string[] {
  const trimmed = paths.map((p) => p.trim()).filter((p) => p.length > 0);
  const dedup = Array.from(new Set(trimmed));
  dedup.sort();
  return dedup;
}

function makeHandle(owner: string, paths: readonly string[]): LockHandle {
  return { owner, paths, released: false };
}
