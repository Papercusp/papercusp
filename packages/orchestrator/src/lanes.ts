/**
 * Parallel-lane / competition-mode lane manager.
 *
 * Bash run.sh tracks lanes via OS PIDs in `<stateDir>/lanes.json`. The TS
 * port runs all lanes in-process via Promises — each "lane" is a
 * `Promise<void>` representing an in-flight worker invocation. We persist
 * a minimal lanes.json so the harness UI's status panels (which the bash
 * tooling already reads) keep working.
 *
 * Two modes:
 *   - **lane**: up to N workers run on different features in parallel.
 *     Each worker uses its own branch/worktree (Stage 3 subsystem). The
 *     orchestrator waits for an open lane before dispatching the next
 *     NEXT_WORKER.
 *   - **competition**: N workers run on the SAME feature in sibling
 *     worktrees. After all finish, validator picks a winner via
 *     COMPETITION_WINNER lane-N in its output. Winner branch is merged;
 *     loser worktrees are dropped.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configGet } from './config';
import type { HarnessConfig } from './types';

export interface LaneRecord {
  /** Internal monotonic id (replaces bash's OS PID; PIDs aren't meaningful in-process). */
  id: number;
  feature_id: string;
  started_at: number;
  /** Set when the lane finishes. UI reads this to show lane completion. */
  finished_at?: number;
}

export interface LanePool {
  /** Wait for an open slot under `max`; returns when count < max. */
  acquire(featureId: string): Promise<number>;
  /** Mark a lane finished. Called when the worker promise resolves. */
  release(id: number): void;
  /** Block until every active lane has resolved. Used before validator runs. */
  waitAll(): Promise<void>;
  /** Block until no lanes match `featureId`. Used to drain a single
   *  feature's competitors before its validator runs (other features'
   *  competitions keep running in the background). */
  waitForFeature(featureId: string): Promise<void>;
  /** How many lanes are currently in flight. */
  count(): number;
  /** How many lanes are tagged with `featureId`. */
  countForFeature(featureId: string): number;
}

let _idCounter = 0;

function nextId(): number {
  _idCounter += 1;
  return _idCounter;
}

/** Read the configured concurrency cap (default 1). */
export function parallelMaxWorkers(cfg: HarnessConfig): number {
  const v = configGet<unknown>(cfg, 'parallelWorkers.max', 1);
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/** Read the parallelism mode (default 'lane'). */
export function parallelMode(cfg: HarnessConfig): 'lane' | 'competition' | 'adaptive' {
  const v = configGet<string>(cfg, 'parallelWorkers.mode', 'lane');
  if (v === 'competition') return 'competition';
  if (v === 'adaptive') return 'adaptive';
  return 'lane';
}

/**
 * Adaptive-mode tier configuration.
 *
 * In adaptive mode the orchestrator LLM picks how many workers to
 * dispatch per feature from a bounded vocabulary. Tiers and labels are
 * configured globally in harness_shared.orchestrator_settings (DB-backed,
 * editable via the /settings/orchestrator UI). The orchestrator main-loop
 * fetches them at startup and seeds the prompt with both the rubric
 * and the current free-slot budget.
 *
 * Defaults match the static hybrid mode's intuition: {1, 2, 4} =
 * trivial / normal / hard. Returning an immutable shape (cloned arrays)
 * so callers can't mutate cached config.
 */
export interface AdaptiveTiers {
  tiers: number[];
  labels: string[];
  rubric: string;
}

export const DEFAULT_ADAPTIVE_TIERS: AdaptiveTiers = {
  tiers: [1, 2, 4],
  labels: ['trivial', 'normal', 'hard'],
  rubric: '',
};

export function parallelAdaptiveTiers(cfg: HarnessConfig): AdaptiveTiers {
  const raw = configGet<unknown>(cfg, 'parallelWorkers.adaptive', undefined);
  if (!raw || typeof raw !== 'object') {
    return {
      tiers: [...DEFAULT_ADAPTIVE_TIERS.tiers],
      labels: [...DEFAULT_ADAPTIVE_TIERS.labels],
      rubric: DEFAULT_ADAPTIVE_TIERS.rubric,
    };
  }
  const obj = raw as Record<string, unknown>;
  const tiersIn = Array.isArray(obj.tiers) ? obj.tiers : DEFAULT_ADAPTIVE_TIERS.tiers;
  const labelsIn = Array.isArray(obj.labels) ? obj.labels : DEFAULT_ADAPTIVE_TIERS.labels;
  const tiers = tiersIn
    .map((n) => (typeof n === 'number' ? n : parseInt(String(n), 10)))
    .filter((n): n is number => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n));
  const labels = labelsIn.map((s) => String(s ?? ''));
  // Defensive: if tier/label lengths mismatched, fall back to defaults
  // rather than mid-render misalignment. Caller (settings PUT) validates
  // on write, so this branch is for malformed external state.
  if (tiers.length < 2 || tiers.length !== labels.length) {
    return {
      tiers: [...DEFAULT_ADAPTIVE_TIERS.tiers],
      labels: [...DEFAULT_ADAPTIVE_TIERS.labels],
      rubric: typeof obj.rubric === 'string' ? obj.rubric : '',
    };
  }
  return {
    tiers,
    labels,
    rubric: typeof obj.rubric === 'string' ? obj.rubric : '',
  };
}

/** Whether adaptive parallelism is active for the current config. */
export function isAdaptiveMode(cfg: HarnessConfig): boolean {
  return (
    parallelMode(cfg) === 'adaptive' &&
    parallelMaxWorkers(cfg) > 1 &&
    configGet<boolean>(cfg, 'branchIsolation.enabled', false) === true &&
    configGet<boolean>(cfg, 'branchIsolation.useWorktrees', false) === true
  );
}

/**
 * How many workers compete on EACH feature in competition mode.
 *
 * Pre-2026-05-07: competition always used `max` (i.e. all available
 * concurrency on a single feature, validator picks winner). That works
 * but doesn't let a user run multiple smaller competitions in parallel.
 *
 * Post-2026-05-07: `parallelWorkers.workersPerFeature` lets users tune
 * the per-feature competition size separately. Example: max=10,
 * workersPerFeature=2 → up to 5 simultaneous 2-way competitions
 * (5 features × 2 workers each = 10 lanes).
 *
 * Default for back-compat: when unset and mode=='competition', return
 * `max` (preserves the legacy "all-on-one" behavior). When unset and
 * mode=='lane', return 1 (one worker per feature, the lane-mode
 * semantics).
 */
export function parallelWorkersPerFeature(cfg: HarnessConfig): number {
  const v = configGet<unknown>(cfg, 'parallelWorkers.workersPerFeature', undefined);
  if (v !== undefined && v !== null) {
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  // Back-compat default per mode.
  return parallelMode(cfg) === 'competition' ? parallelMaxWorkers(cfg) : 1;
}

/**
 * `parallelWorkers.workingStateCheck` — the L1 typecheck command the
 * worker chunk loop runs after each chunk's edits. Defaults to
 * `pnpm typecheck` because that's what the papercup-shaped repo
 * targets. Other repos (Python, Rust, Go) override this in their
 * harness's config.json. Empty string disables the gate (workers
 * commit without a check; not recommended).
 */
export function workingStateCheckCommand(cfg: HarnessConfig): string {
  const v = configGet<string>(cfg, 'parallelWorkers.workingStateCheck', 'pnpm typecheck');
  return typeof v === 'string' ? v : 'pnpm typecheck';
}

/**
 * `parallelWorkers.replanStrikes` — how many times the worker chunk
 * loop will replan a single chunk after the L1 typecheck rejects it
 * before escalating to the debugger. Defaults to 3 — three rounds is
 * usually enough for the LLM to converge on a working bundle, and
 * past that escalation gets a smarter look at the failure.
 */
export function replanStrikes(cfg: HarnessConfig): number {
  const v = configGet<unknown>(cfg, 'parallelWorkers.replanStrikes', 3);
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 3;
}

/**
 * `parallelWorkers.escalateToRole` — which agent role takes over when
 * a chunk hits replanStrikes. Defaults to 'debugger'. Other reasonable
 * values: 'scoper' (if you suspect the feature is misscoped),
 * 'architect' (if structural rework is needed). The role just has to
 * exist in the harness's prompt set; misspelled roles fall back to
 * marking the feature `failing` for user visibility.
 */
export function escalateToRole(cfg: HarnessConfig): string {
  const v = configGet<string>(cfg, 'parallelWorkers.escalateToRole', 'debugger');
  return typeof v === 'string' && v.length > 0 ? v : 'debugger';
}

/**
 * Whether competition mode is active for the current config. Requires
 * branchIsolation + worktrees in addition to mode==competition (matches
 * bash gate).
 */
export function isCompetitionMode(cfg: HarnessConfig): boolean {
  return (
    parallelMode(cfg) === 'competition' &&
    parallelMaxWorkers(cfg) > 1 &&
    configGet<boolean>(cfg, 'branchIsolation.enabled', false) === true &&
    configGet<boolean>(cfg, 'branchIsolation.useWorktrees', false) === true
  );
}

/**
 * Whether parallel-lane mode is active. Distinct from competition: same
 * feature → competition; different features → lane.
 */
export function isLaneMode(cfg: HarnessConfig): boolean {
  return (
    parallelMaxWorkers(cfg) > 1 &&
    parallelMode(cfg) === 'lane' &&
    configGet<boolean>(cfg, 'branchIsolation.enabled', false) === true
  );
}

/**
 * Create an in-process lane pool. The pool persists snapshots to
 * `<stateDir>/lanes.json` so the harness UI's lane indicator keeps
 * working without depending on the bash schema.
 */
export function createLanePool(stateDir: string, max: number): LanePool {
  const lanes = new Map<number, LaneRecord & { settled: () => void }>();
  const lanesPath = join(stateDir, 'lanes.json');

  const persist = (): void => {
    const records = [...lanes.values()].map((l) => {
      // Don't persist the resolver function — only the on-disk shape.
      const { settled, ...rest } = l;
      void settled;
      return rest;
    });
    try {
      writeFileSync(lanesPath, JSON.stringify({ lanes: records }, null, 2));
    } catch {
      // Best-effort persistence; never crash the loop.
    }
  };

  return {
    async acquire(featureId: string): Promise<number> {
      // If we're at cap, wait for a lane to release.
      while (lanes.size >= max) {
        await new Promise<void>((resolve) => {
          const tick = (): void => {
            if (lanes.size < max) resolve();
            else setTimeout(tick, 50);
          };
          tick();
        });
      }
      const id = nextId();
      const record: LaneRecord & { settled: () => void } = {
        id,
        feature_id: featureId,
        started_at: Math.floor(Date.now() / 1000),
        settled: () => {},
      };
      lanes.set(id, record);
      persist();
      return id;
    },

    release(id: number): void {
      const lane = lanes.get(id);
      if (!lane) return;
      lane.finished_at = Math.floor(Date.now() / 1000);
      lanes.delete(id);
      persist();
    },

    async waitAll(): Promise<void> {
      // Active lanes have outstanding work; wait until count drops to 0.
      while (lanes.size > 0) {
        await new Promise((r) => setTimeout(r, 100));
      }
    },

    async waitForFeature(featureId: string): Promise<void> {
      const isMatch = (l: LaneRecord): boolean => l.feature_id === featureId;
      while ([...lanes.values()].some(isMatch)) {
        await new Promise((r) => setTimeout(r, 100));
      }
    },

    count(): number {
      return lanes.size;
    },

    countForFeature(featureId: string): number {
      let n = 0;
      for (const l of lanes.values()) if (l.feature_id === featureId) n += 1;
      return n;
    },
  };
}

// ─── Competition manifest ────────────────────────────────────────

export interface CompetitionLane {
  lane: number;
  worktree: string;
  branch: string;
}

export interface CompetitionManifest {
  parentFeatureId: string;
  lanes: CompetitionLane[];
  n: number;
}

/** Path for `<stateDir>/competition-<fid>.json`. */
export function competitionManifestPath(stateDir: string, featureId: string): string {
  return join(stateDir, `competition-${featureId}.json`);
}

/** Build the manifest object for N competition lanes. Pure function. */
export function buildCompetitionManifest(
  stateDir: string,
  featureId: string,
  n: number,
): CompetitionManifest {
  const lanes: CompetitionLane[] = [];
  for (let i = 1; i <= n; i++) {
    lanes.push({
      lane: i,
      worktree: join(stateDir, 'worktrees', `${featureId}-lane-${i}`),
      branch: `harness/${featureId}-lane-${i}`,
    });
  }
  return { parentFeatureId: featureId, lanes, n };
}

/** Persist the manifest to disk for the validator to consume. */
export function writeCompetitionManifest(
  stateDir: string,
  featureId: string,
  n: number,
): CompetitionManifest {
  const manifest = buildCompetitionManifest(stateDir, featureId, n);
  writeFileSync(
    competitionManifestPath(stateDir, featureId),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

/** Read an existing manifest. Returns null when absent or malformed. */
export function readCompetitionManifest(
  stateDir: string,
  featureId: string,
): CompetitionManifest | null {
  const path = competitionManifestPath(stateDir, featureId);
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    if (
      obj &&
      typeof obj === 'object' &&
      typeof obj.parentFeatureId === 'string' &&
      Array.isArray(obj.lanes) &&
      typeof obj.n === 'number'
    ) {
      return obj as CompetitionManifest;
    }
  } catch {
    // ignore
  }
  return null;
}

// ─── Validator output parsing ────────────────────────────────────

export type CompetitionVerdict =
  | { kind: 'winner'; lane: number }
  | { kind: 'none' }
  | { kind: 'absent' };

/**
 * Parse the validator's output for `COMPETITION_WINNER lane-N` or
 * `COMPETITION_WINNER none`. Returns `{kind:'absent'}` when no winner
 * line is present.
 */
export function parseCompetitionVerdict(validatorOutput: string): CompetitionVerdict {
  const noneMatch = /COMPETITION_WINNER\s+none/i.exec(validatorOutput);
  if (noneMatch) return { kind: 'none' };
  const laneMatch = /COMPETITION_WINNER\s+lane-(\d+)/i.exec(validatorOutput);
  if (laneMatch) return { kind: 'winner', lane: parseInt(laneMatch[1], 10) };
  return { kind: 'absent' };
}
