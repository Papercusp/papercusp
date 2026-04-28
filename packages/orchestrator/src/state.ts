/**
 * Feature state reader/writer. Maps to bash run.sh's `features_json`,
 * `features_exist`, `feature_attempts`, `feature_set_status`.
 *
 * `.harness/features.json` can be either:
 *   { "features": [{...}, ...] }   — object form (current)
 *   [{...}, ...]                    — bare array (legacy)
 *
 * We always normalize to FeatureRecord[] internally.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { FeatureRecord, FeaturesJson } from './types';

/** Read and normalize features.json. Returns [] if absent or malformed. */
export function readFeatures(stateDir: string): FeatureRecord[] {
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

/** Whether features.json exists AND has at least one feature record. */
export function featuresExist(stateDir: string): boolean {
  return readFeatures(stateDir).length > 0;
}

/** Number of times a feature has been worked on (zero if not found). */
export function featureAttempts(stateDir: string, featureId: string): number {
  const f = readFeatures(stateDir).find((x) => x.id === featureId);
  return f?.attempts ?? 0;
}

/**
 * Update a feature's status. Preserves all other fields. Mirrors bash
 * `feature_set_status <fid> <status>` plus the python-inline mutations
 * (architect's reset-to-todo with attempts=0).
 */
export function setFeatureStatus(
  stateDir: string,
  featureId: string,
  status: FeatureRecord['status'],
  options: { bumpAttempts?: boolean; resetAttempts?: boolean } = {},
): FeatureRecord[] {
  const path = `${stateDir}/features.json`;
  const features = readFeatures(stateDir);
  const idx = features.findIndex((f) => f.id === featureId);
  if (idx < 0) return features; // bash silently no-ops too
  const next = { ...features[idx], status };
  if (options.resetAttempts) {
    next.attempts = 0;
  } else if (options.bumpAttempts) {
    next.attempts = (next.attempts ?? 0) + 1;
  }
  features[idx] = next;
  // Preserve original on-disk shape: if it was object-form, keep it that way.
  let writeShape: FeaturesJson = features;
  try {
    const original = JSON.parse(readFileSync(path, 'utf8')) as FeaturesJson;
    if (!Array.isArray(original) && original && typeof original === 'object') {
      writeShape = { ...original, features };
    }
  } catch {
    // fall through to array form
  }
  writeFileSync(path, JSON.stringify(writeShape, null, 2) + '\n');
  return features;
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
