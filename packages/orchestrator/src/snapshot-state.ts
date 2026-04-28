/**
 * Per-iteration state snapshot. Mirrors bash snapshot_state:
 *
 *   - Copies features.json + validation-contract.md + supervisor-notes.md
 *     + config.json into <stateDir>/snapshots/<ts>-iter-<NNN>/
 *   - Prunes oldest snapshot dirs beyond config.snapshotRetention
 *     (default 50). Logs/, hooks/, escalation.md are NOT snapshotted.
 *
 * Used for rollback via the harness UI's snapshot list.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configGet } from './config';
import type { HarnessConfig } from './types';

export interface SnapshotResult {
  /** Path to the new snapshot dir (or null if the source state didn't exist). */
  path: string | null;
  /** Number of older snapshots pruned. */
  pruned: number;
}

export function snapshotState(
  stateDir: string,
  iterationNumber: number,
  cfg: HarnessConfig,
): SnapshotResult {
  const ts = Math.floor(Date.now() / 1000);
  const iterStr = String(iterationNumber).padStart(3, '0');
  const snapshotsRoot = join(stateDir, 'snapshots');
  const snapDir = join(snapshotsRoot, `${ts}-iter-${iterStr}`);
  mkdirSync(snapDir, { recursive: true });

  let copiedAny = false;
  for (const name of [
    'features.json',
    'validation-contract.md',
    'supervisor-notes.md',
    'config.json',
  ]) {
    const src = join(stateDir, name);
    if (!existsSync(src)) continue;
    try {
      copyFileSync(src, join(snapDir, name));
      copiedAny = true;
    } catch {
      // ignore — best effort
    }
  }

  const snapPath = copiedAny ? snapDir : null;

  // Prune.
  const retentionRaw = configGet<unknown>(cfg, 'snapshotRetention', 50);
  const retention =
    typeof retentionRaw === 'number' && retentionRaw > 0
      ? Math.floor(retentionRaw)
      : 50;
  let dirs: string[];
  try {
    dirs = readdirSync(snapshotsRoot).filter((n) => /^\d+-iter-\d+$/.test(n));
  } catch {
    return { path: snapPath, pruned: 0 };
  }
  dirs.sort(); // ts-prefixed name sort = oldest first
  if (dirs.length <= retention) {
    return { path: snapPath, pruned: 0 };
  }
  const dropCount = dirs.length - retention;
  for (const d of dirs.slice(0, dropCount)) {
    const full = join(snapshotsRoot, d);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
  return { path: snapPath, pruned: dropCount };
}
