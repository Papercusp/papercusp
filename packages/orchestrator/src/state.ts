/**
 * Feature state reader/writer. Maps to bash run.sh's `features_json`,
 * `features_exist`, `feature_attempts`, `feature_set_status`.
 *
 * Storage backends (chosen by the StateContext shape):
 *   - PG (canonical, production): `harness_features` table in the
 *     per-harness schema. Pass `{ pg, workspaceId, harnessSlug? }`.
 *   - In-memory (tests, CLI standalone without PG): process-local Map
 *     keyed by stateDir. See `state-memory.ts`.
 *
 * Filesystem (`.papercusp/features.json`) is NO LONGER supported. PG is
 * the single source of truth in production. Tests use the in-memory
 * backend via `seedMemoryStore`/`_resetMemoryStateForTests` (the
 * test-context-builder wires this automatically).
 *
 * Callers always provide a `StateContext`. `stateCtx(invokeCtx)`
 * derives the right backend from an `InvokeContext`-shaped object —
 * PG when both `pg` and `workspaceId` are set, memory otherwise.
 */
import { basename } from 'node:path';
import {
  readFeaturesPg,
  featuresExistPg,
  featureAttemptsPg,
  setFeatureStatusPg,
  type PgStateContext,
} from './state-pg';
import {
  readFeaturesMem,
  featuresExistMem,
  featureAttemptsMem,
  setFeatureStatusMem,
  type MemoryStateContext,
} from './state-memory';
import type { FeatureRecord } from './types';

/**
 * The runtime state backend. PG in production, memory in tests / CLI
 * standalone. Always non-optional — every caller must provide one.
 */
export type StateContext = PgStateContext | MemoryStateContext;

function isPg(ctx: StateContext): ctx is PgStateContext {
  return (ctx as PgStateContext).pg !== undefined;
}

/**
 * Derive the right state backend from an `InvokeContext`-shaped object.
 * When PG (`pg` + `workspaceId`) is wired, returns a PG context.
 * Otherwise returns an in-memory context keyed by `stateDir`.
 */
export function stateCtx(ctx: {
  pg?: PgStateContext['pg'];
  workspaceId?: string;
  harnessSlug?: string;
  projectDir?: string;
  stateDir: string;
}): StateContext {
  if (ctx.pg && ctx.workspaceId) {
    // harnessSlug is optional; threaded so setFeatureStatusPg can apply
    // the design-phase gate (PAPERCUSP_DESIGN_GATE=1). Falls back to
    // basename(projectDir) when not explicitly set — matches the existing
    // harnessSlug() helper's default-derivation, but without the
    // synchronous registry round-trip.
    const slug =
      ctx.harnessSlug ??
      (ctx.projectDir ? ctx.projectDir.split(/[/\\]/).filter(Boolean).pop() : undefined);
    return { pg: ctx.pg, workspaceId: ctx.workspaceId, harnessSlug: slug };
  }
  return { kind: 'memory', stateDir: ctx.stateDir };
}

/** Read and normalize features. */
export async function readFeatures(
  _stateDir: string,
  ctx: StateContext,
): Promise<FeatureRecord[]> {
  if (isPg(ctx)) return readFeaturesPg(ctx);
  return readFeaturesMem(ctx);
}

/** Whether features exist AND there is at least one feature record. */
export async function featuresExist(
  _stateDir: string,
  ctx: StateContext,
): Promise<boolean> {
  if (isPg(ctx)) return featuresExistPg(ctx);
  return featuresExistMem(ctx);
}

/** Number of times a feature has been worked on (zero if not found). */
export async function featureAttempts(
  _stateDir: string,
  featureId: string,
  ctx: StateContext,
): Promise<number> {
  if (isPg(ctx)) return featureAttemptsPg(ctx, featureId);
  return featureAttemptsMem(ctx, featureId);
}

/**
 * Update a feature's status. Preserves all other fields. Mirrors bash
 * `feature_set_status <fid> <status>` plus the python-inline mutations
 * (architect's reset-to-todo with attempts=0).
 */
export async function setFeatureStatus(
  _stateDir: string,
  featureId: string,
  status: FeatureRecord['status'],
  options: { bumpAttempts?: boolean; resetAttempts?: boolean; ctx: StateContext },
): Promise<FeatureRecord[]> {
  if (isPg(options.ctx)) {
    return setFeatureStatusPg(options.ctx, featureId, status, options);
  }
  return setFeatureStatusMem(options.ctx, featureId, status, options);
}

/**
 * Compute the harness slug. Resolution order:
 *   1. HARNESS_SLUG / PAPERCUSP_HARNESS_SLUG env (caller-set; fastest)
 *   2. Operator registry reverse lookup (canonical — handles
 *      basename(projectDir) ≠ registered slug, e.g. sheets-clone → sheets)
 *   3. basename(projectDir) — registry's default-derivation fallback
 *
 * Memoized per projectDir; callers bear no perf cost across multiple
 * invocations.
 *
 * Bash equivalent:
 *   harness_slug() { basename "$PROJECT_DIR"; }
 */
const _slugCache = new Map<string, string>();
export function harnessSlug(projectDir: string): string {
  const fromEnv = process.env.HARNESS_SLUG ?? process.env.PAPERCUSP_HARNESS_SLUG;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const cached = _slugCache.get(projectDir);
  if (cached) return cached;
  const fromRegistry = lookupSlugFromRegistry(projectDir);
  if (fromRegistry) {
    _slugCache.set(projectDir, fromRegistry);
    return fromRegistry;
  }
  const fromBasename = basename(projectDir);
  _slugCache.set(projectDir, fromBasename);
  return fromBasename;
}

function lookupSlugFromRegistry(projectDir: string): string | null {
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('curl', [
      '-sf', '--max-time', '3', `${operatorBase}/api/harness/projects`,
    ], { encoding: 'utf8', timeout: 4000 });
    const data = JSON.parse(out) as { projects?: Array<{ slug?: string; path?: string }> };
    const norm = projectDir.replace(/\/+$/, '');
    const hit = data.projects?.find((p) => (p.path ?? '').replace(/\/+$/, '') === norm)?.slug;
    return hit && hit.length > 0 ? hit : null;
  } catch {
    return null;
  }
}

/** Pass-rate as a fraction (0..1). 0 if no features. */
export function passedFraction(features: FeatureRecord[]): number {
  if (features.length === 0) return 0;
  const passed = features.filter((f) => f.status === 'passed').length;
  return passed / features.length;
}
