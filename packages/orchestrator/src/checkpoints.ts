/**
 * Pre-loop checkpoint gate. Mirrors the bash:
 *
 *   for cp in "$STATE_DIR"/checkpoint-*.md; do
 *     if [ -e "${cp}.granted" ]; then
 *       rm -f "$cp" "${cp}.granted"
 *     else
 *       exit 8
 *     fi
 *   done
 *
 * If a granted checkpoint exists, both files are removed (the loop proceeds).
 * If any ungranted checkpoint exists, the loop refuses to start.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type CheckpointAction =
  | { kind: 'no-checkpoints' }
  | { kind: 'granted-cleared'; cleared: string[] }
  | { kind: 'pending'; pending: string[] };

export function checkpointGate(stateDir: string): CheckpointAction {
  const files = listCheckpointFiles(stateDir);
  if (files.length === 0) return { kind: 'no-checkpoints' };

  const cleared: string[] = [];
  const pending: string[] = [];

  for (const cpName of files) {
    const cpPath = join(stateDir, cpName);
    const grantedPath = `${cpPath}.granted`;
    if (existsSync(grantedPath)) {
      try { unlinkSync(cpPath); } catch { /* ignore */ }
      try { unlinkSync(grantedPath); } catch { /* ignore */ }
      cleared.push(cpName);
    } else {
      pending.push(cpName);
    }
  }

  if (pending.length > 0) {
    return { kind: 'pending', pending };
  }
  return { kind: 'granted-cleared', cleared };
}

function listCheckpointFiles(stateDir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return [];
  }
  return entries.filter(
    (name) => name.startsWith('checkpoint-') && name.endsWith('.md'),
  );
}

function existsSync(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
