/**
 * Feature state reader/writer. Maps to bash run.sh's `features_json`,
 * `features_exist`, `feature_attempts`, `feature_set_status`.
 *
 * As of Phase 1 of the orchestrator → PG arc, every export is async and
 * accepts an optional `pg` + `workspaceId` pair (see `PgStateContext`).
 *   - When PG context is passed, queries hit `harness_features` directly.
 *     PG is canonical; the harness directory's features.json is no longer
 *     read or written by the orchestrator.
 *   - When PG context is omitted, reads/writes fall back to the legacy
 *     filesystem path (features.json in the state dir). Exists for
 *     standalone CLI mode and tests; will be removed once CLI mode
 *     bootstraps its own PG connection.
 *
 * `.harness/features.json` shape (legacy fallback):
 *   { "features": [{...}, ...] }   — object form (current)
 *   [{...}, ...]                    — bare array (legacy)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  readFeaturesPg,
  featuresExistPg,
  featureAttemptsPg,
  setFeatureStatusPg,
  type PgStateContext,
} from './state-pg';
import type { FeatureRecord, FeaturesJson } from './types';

/** Optional PG context. When undefined, falls back to filesystem. */
export type StateContext = PgStateContext | undefined;

/**
 * Derive the optional state context from an InvokeContext-shaped object.
 * Returns undefined when the orchestrator wasn't given a pg client (CLI
 * standalone mode, tests), in which case callers transparently fall back
 * to the filesystem path.
 */
export function stateCtx(ctx: {
  pg?: PgStateContext['pg'];
  workspaceId?: string;
}): StateContext {
  if (ctx.pg && ctx.workspaceId) return { pg: ctx.pg, workspaceId: ctx.workspaceId };
  return undefined;
}

/** Read and normalize features. Returns [] if absent or malformed. */
export async function readFeatures(
  stateDir: string,
  ctx?: StateContext,
): Promise<FeatureRecord[]> {
  if (ctx) return readFeaturesPg(ctx);
  return readFeaturesFs(stateDir);
}

/** Whether features exist AND there is at least one feature record. */
export async function featuresExist(
  stateDir: string,
  ctx?: StateContext,
): Promise<boolean> {
  if (ctx) return featuresExistPg(ctx);
  return readFeaturesFs(stateDir).length > 0;
}

/** Number of times a feature has been worked on (zero if not found). */
export async function featureAttempts(
  stateDir: string,
  featureId: string,
  ctx?: StateContext,
): Promise<number> {
  if (ctx) return featureAttemptsPg(ctx, featureId);
  const f = readFeaturesFs(stateDir).find((x) => x.id === featureId);
  return f?.attempts ?? 0;
}

/**
 * Update a feature's status. Preserves all other fields. Mirrors bash
 * `feature_set_status <fid> <status>` plus the python-inline mutations
 * (architect's reset-to-todo with attempts=0).
 */
export async function setFeatureStatus(
  stateDir: string,
  featureId: string,
  status: FeatureRecord['status'],
  options: { bumpAttempts?: boolean; resetAttempts?: boolean; ctx?: StateContext } = {},
): Promise<FeatureRecord[]> {
  if (options.ctx) return setFeatureStatusPg(options.ctx, featureId, status, options);
  return setFeatureStatusFs(stateDir, featureId, status, options);
}

/**
 * Compute the harness slug from the project directory name. Bash equivalent:
 *
 *   harness_slug() { basename "$PROJECT_DIR"; }
 */
export function harnessSlug(projectDir: string): string {
  return basename(projectDir);
}

/** Pass-rate as a fraction (0..1). 0 if no features. */
export function passedFraction(features: FeatureRecord[]): number {
  if (features.length === 0) return 0;
  const passed = features.filter((f) => f.status === 'passed').length;
  return passed / features.length;
}

// ── Legacy filesystem fallback (removed in a later phase) ─────────────

function readFeaturesFs(stateDir: string): FeatureRecord[] {
  const path = `${stateDir}/features.json`;
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as FeaturesJson;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object' && Array.isArray(raw.features)) {
      return raw.features;
    }
    return [];
  } catch {
    return [];
  }
}

function setFeatureStatusFs(
  stateDir: string,
  featureId: string,
  status: FeatureRecord['status'],
  options: { bumpAttempts?: boolean; resetAttempts?: boolean },
): FeatureRecord[] {
  const path = `${stateDir}/features.json`;
  const features = readFeaturesFs(stateDir);
  const idx = features.findIndex((f) => f.id === featureId);
  if (idx < 0) return features;
  const next = { ...features[idx], status };
  if (options.resetAttempts) next.attempts = 0;
  else if (options.bumpAttempts) next.attempts = (next.attempts ?? 0) + 1;
  features[idx] = next;
  let writeShape: FeaturesJson = features;
  try {
    const original = JSON.parse(readFileSync(path, 'utf8')) as FeaturesJson;
    if (!Array.isArray(original) && original && typeof original === 'object') {
      writeShape = { ...original, features };
    }
  } catch { /* fall through to array form */ }
  writeFileSync(path, JSON.stringify(writeShape, null, 2) + '\n');
  return features;
}
