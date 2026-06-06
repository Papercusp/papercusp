/**
 * The EFFECTIVE harness config — blueprint knobs (shape defaults) overlaid UNDER
 * the per-install `.papercusp/config.json` (instance overrides win).
 *
 * `cloud-deployment-layer-2026-06-06` P-006: completes the config.json →
 * blueprint-knobs migration for the residual fields (`promptOverrides`,
 * `aiBackend`, `parallelWorkers`, `scoper`, `snapshotRetention`). Those fields now
 * have a declared home in the blueprint (KnobsSchema), while config.json keeps its
 * instance-override precedence — the same precedence the already-migrated fields
 * (maxCostUsd, debuggerThreshold, dispatch.concurrency) use.
 *
 * IMPORTANT — zero behavior change for existing harnesses: the overlay carries
 * ONLY the residual-knob keys, and a blueprint that declares none of them
 * produces an EMPTY overlay, so `readEffectiveConfig(dir) === readConfig(dir)`.
 * The already-migrated knobs keep their own ad-hoc resolution (resolveDispatchPolicy
 * / the debuggerThreshold fallback) and are deliberately NOT in this overlay, so
 * this change can't double-apply or disturb them.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig } from './types';
import { readConfig } from './config';
import { loadBlueprintFromFile, type Blueprint } from './blueprint';

/**
 * The residual config fields this overlay migrates (cloud-deployment P-006). NOT
 * the already-migrated knobs (maxCostUsd/logRetention/branchIsolation/worktrees/
 * reviewer/product/models/debuggerThreshold) — those resolve elsewhere and must
 * not be double-applied here.
 */
const RESIDUAL_KNOB_KEYS = [
  'promptOverrides',
  'aiBackend',
  'parallelWorkers',
  'scoper',
  'snapshotRetention',
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `override` onto `base`: nested plain objects merge recursively;
 * arrays + scalars + null in `override` REPLACE the base value; `undefined` in
 * `override` is ignored (never clobbers a base default). `override` wins.
 */
export function deepMergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, ov] of Object.entries(override)) {
    if (ov === undefined) continue;
    const bv = out[k];
    out[k] = isPlainObject(bv) && isPlainObject(ov) ? deepMergeConfig(bv, ov) : ov;
  }
  return out;
}

/** Project a blueprint's knobs into a config-shaped overlay (residual keys only). */
export function blueprintKnobsToConfigOverlay(
  knobs: Blueprint['knobs'] | null | undefined,
): Partial<HarnessConfig> {
  if (!knobs) return {};
  const overlay: Record<string, unknown> = {};
  for (const k of RESIDUAL_KNOB_KEYS) {
    const v = (knobs as Record<string, unknown>)[k];
    if (v !== undefined) overlay[k] = v;
  }
  return overlay as Partial<HarnessConfig>;
}

/**
 * Load the effective blueprint's knobs from `<stateDir>/blueprint.yaml`
 * (best-effort; `null` when there's no blueprint file or it fails to load/parse —
 * a non-blueprint harness then behaves exactly as before the migration). Mirrors
 * operator-core's `harnessBlueprintKnobs`.
 */
export function loadHarnessKnobs(stateDir: string): Blueprint['knobs'] | null {
  try {
    const f = join(stateDir, 'blueprint.yaml');
    if (!existsSync(f)) return null;
    return loadBlueprintFromFile(f).blueprint.knobs;
  } catch {
    return null; // fail-safe: a bad blueprint never strands a run on config alone
  }
}

/**
 * `readConfig` + the residual-knob overlay (config.json wins). Drop-in replacement
 * for `readConfig` at the orchestrator's run-config load boundary, so every
 * `configGet(cfg, 'parallelWorkers.*' | 'aiBackend.*' | 'promptOverrides.*' |
 * 'scoper.*' | 'snapshotRetention')` read resolves blueprint-then-config without
 * touching the read sites.
 */
export function readEffectiveConfig(stateDir: string): HarnessConfig {
  const cfg = readConfig(stateDir);
  const overlay = blueprintKnobsToConfigOverlay(loadHarnessKnobs(stateDir));
  if (Object.keys(overlay).length === 0) return cfg;
  return deepMergeConfig(overlay as Record<string, unknown>, cfg as Record<string, unknown>) as HarnessConfig;
}
