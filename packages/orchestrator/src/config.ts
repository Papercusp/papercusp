/**
 * `.harness/config.json` reader. Replaces bash's
 *
 *     config_get 'product.enabled' 'false'
 *
 * with
 *
 *     configGet(cfg, 'product.enabled', false)
 *
 * Same dotted-path semantics, same default-on-missing behavior, same
 * coercion-light approach (caller decides string vs number vs bool).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig } from './types.js';

/** Read .harness/config.json from a project state dir. Returns {} if absent. */
export function readConfig(stateDir: string): HarnessConfig {
  const path = join(stateDir, 'config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HarnessConfig;
  } catch {
    return {};
  }
}

/**
 * Look up a dotted-path value in a config object, returning `defaultValue`
 * if any segment is missing. Mirrors bash run.sh's `config_get`.
 *
 *   configGet(cfg, 'phases.staging.port', 3055)
 *   configGet(cfg, 'reviewer.replanOnAccept', false)
 */
export function configGet<T = unknown>(
  cfg: HarnessConfig,
  path: string,
  defaultValue: T,
): T {
  const segments = path.split('.');
  let cur: unknown = cfg;
  for (const seg of segments) {
    if (typeof cur !== 'object' || cur === null) return defaultValue;
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return defaultValue;
  }
  return (cur as T) ?? defaultValue;
}

/**
 * Resolve the harness phase + port + dbPath from config.
 * Defaults to `phase: "staging"`, port/dbPath empty when absent.
 */
export function resolvePhase(cfg: HarnessConfig): {
  phase: string;
  port: string;
  dbPath: string;
} {
  const phase = (cfg.phase as string) ?? 'staging';
  const phases = cfg.phases ?? {};
  const p = phases[phase] ?? {};
  return {
    phase,
    port: p.port != null ? String(p.port) : '',
    dbPath: p.dbPath != null ? String(p.dbPath) : '',
  };
}
