/**
 * Cost-cap enforcement. Mirrors bash check_cost_cap:
 *
 *   - Sum total_cost_usd across all *.jsonl in <logDir>
 *   - If config.maxCostUsd is set and total >= cap → exit 6
 *   - Soft warn at maxCostUsdWarnThreshold (default 0.8) — fires once
 *     per mission (sentinel file <stateDir>/.cost-warn-fired)
 *   - Optional auto-pause via SIGSTOP when warn threshold hit
 *     (config.maxCostUsdAutoPause)
 *
 * The summed value is exposed so callers can log + decide. The
 * over-cap and auto-pause behaviors are returned as a typed result;
 * the main loop converts them to terminal exits.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configGet } from './config';
import type { HarnessConfig } from './types';

export interface CostCapResult {
  /** Summed total_cost_usd across all .jsonl files in the log dir. */
  total: number;
  /** Cap from config.json, or null when not configured. */
  cap: number | null;
  /** True if total >= cap (caller must exit 6). */
  overCap: boolean;
  /** True if the soft warn fired this iteration. */
  warned: boolean;
  /** Whether config.maxCostUsdAutoPause asked for SIGSTOP. */
  shouldPause: boolean;
}

/**
 * Sum total_cost_usd across all *.jsonl files. Each file's "result" event
 * carries the cumulative cost for that invocation; we take the LAST
 * "result" event per file (matches bash) and sum.
 */
export function sumJsonlCost(logDir: string): number {
  if (!existsSync(logDir)) return 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(logDir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    let body: string;
    try {
      body = readFileSync(join(logDir, name), 'utf8');
    } catch {
      continue;
    }
    const lines = body.split(/\r?\n/);
    let lastResultCost = 0;
    let foundResult = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && obj.type === 'result') {
          const c = obj.total_cost_usd;
          if (typeof c === 'number' && Number.isFinite(c)) {
            lastResultCost = c;
            foundResult = true;
          }
        }
      } catch {
        // skip malformed lines
      }
    }
    if (foundResult) total += lastResultCost;
  }
  return total;
}

/** Inspect cost; return what the loop should do about it. Pure function. */
export function evaluateCostCap(
  cfg: HarnessConfig,
  logDir: string,
  stateDir: string,
): CostCapResult {
  const cap = parseCap(cfg);
  const total = sumJsonlCost(logDir);

  if (cap === null) {
    return { total, cap: null, overCap: false, warned: false, shouldPause: false };
  }

  if (total >= cap) {
    return { total, cap, overCap: true, warned: false, shouldPause: false };
  }

  // Soft warn — fires once per mission.
  const sentinelPath = join(stateDir, '.cost-warn-fired');
  const sentinelExists = existsSync(sentinelPath);
  const warnFraction = Number(configGet<unknown>(cfg, 'maxCostUsdWarnThreshold', 0.8));
  const warnThreshold = cap * (Number.isFinite(warnFraction) ? warnFraction : 0.8);
  const atWarn = total >= warnThreshold && !sentinelExists;

  if (atWarn) {
    writeFileSync(sentinelPath, '');
  }
  const shouldPause =
    atWarn && configGet<boolean>(cfg, 'maxCostUsdAutoPause', false) === true;

  return { total, cap, overCap: false, warned: atWarn, shouldPause };
}

function parseCap(cfg: HarnessConfig): number | null {
  const v = configGet<unknown>(cfg, 'maxCostUsd', null);
  if (typeof v === 'number' && v > 0 && Number.isFinite(v)) return v;
  return null;
}
