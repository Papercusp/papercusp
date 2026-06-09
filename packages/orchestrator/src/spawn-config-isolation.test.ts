/**
 * spawn-config-isolation.test.ts — the LAUNCH-side per-spawn CLAUDE_CONFIG_DIR
 * isolation that is the EI-153 fix for orchestrator-spawned bees
 * (coordination-test-suite-2026-06-08 P-005, C5/C1).
 *
 * Two same-cwd claude spawns must each get their OWN config dir so their
 * conversation transcripts (`$CLAUDE_CONFIG_DIR/projects/**`) never bleed into
 * each other — and the dir must carry ONLY a credentials SYMLINK (no
 * settings.json ⇒ no enabled plugins leaked from the engineer's ~/.claude, and a
 * symlink ⇒ an OAuth refresh writes through, no credential divergence).
 *
 * The complementary RESUME-side isolation is asserted in operator-core's
 * wake-resume-isolation.test.ts. The interactive-SU launch path is the known
 * accepted gap EI-155 (it does NOT yet get this per-session dir).
 *
 * Run: npx vitest run libs/papercusp/packages/orchestrator/src/spawn-config-isolation.test.ts
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeSpawnClaudeConfig } from './spawn-mcp';

const ROOT = join(tmpdir(), `papercusp-spawn-cfg-iso-${process.pid}`);

/** A fake spawn HOME with a `.claude/.credentials.json`, like a logged-in box. */
function fakeHome(name: string): string {
  const home = join(ROOT, name);
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), '{"token":"fake"}');
  return home;
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});
afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('writeSpawnClaudeConfig — per-spawn isolation (EI-153 launch leg)', () => {
  it('two tracked spawns get DISTINCT persistent config dirs (transcript isolation)', () => {
    const home = fakeHome('home');
    const dirA = join(ROOT, 'session-claude', 'spawn-A');
    const dirB = join(ROOT, 'session-claude', 'spawn-B');

    const a = writeSpawnClaudeConfig(home, { persistentDir: dirA });
    const b = writeSpawnClaudeConfig(home, { persistentDir: dirB });

    expect(a.configDir).toBe(dirA);
    expect(b.configDir).toBe(dirB);
    expect(a.configDir).not.toBe(b.configDir);
    // Both real, isolated dirs — A's claude transcript pool can never be B's.
    expect(existsSync(a.configDir)).toBe(true);
    expect(existsSync(b.configDir)).toBe(true);
    a.cleanup();
    b.cleanup();
    // Persistent dirs survive cleanup (the resume leg reads them).
    expect(existsSync(a.configDir)).toBe(true);
  });

  it('credentials are SYMLINKED (not copied) → token refresh writes through, no divergence', () => {
    const home = fakeHome('home');
    const dir = join(ROOT, 'session-claude', 'spawn-link');
    const h = writeSpawnClaudeConfig(home, { persistentDir: dir });

    const link = join(h.configDir, '.credentials.json');
    expect(existsSync(link)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(home, '.claude', '.credentials.json'));
  });

  it('the isolated dir carries NO settings.json / plugins (no enabled-plugin leak)', () => {
    const home = fakeHome('home');
    // Even if the real home has settings + plugins, the spawn dir must not inherit them.
    writeFileSync(join(home, '.claude', 'settings.json'), '{"enabledPlugins":["x"]}');
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });

    const dir = join(ROOT, 'session-claude', 'spawn-clean');
    const h = writeSpawnClaudeConfig(home, { persistentDir: dir });

    expect(existsSync(join(h.configDir, 'settings.json'))).toBe(false);
    expect(existsSync(join(h.configDir, 'plugins'))).toBe(false);
  });

  it('ephemeral spawns (no persistentDir) also get DISTINCT dirs', () => {
    const home = fakeHome('home');
    const a = writeSpawnClaudeConfig(home);
    const b = writeSpawnClaudeConfig(home);
    expect(a.configDir).not.toBe(b.configDir);
    expect(existsSync(join(a.configDir, '.credentials.json'))).toBe(true);
    a.cleanup();
    b.cleanup();
  });

  it('a home with NO credentials runs unauthenticated (no throw, no symlink)', () => {
    const home = join(ROOT, 'no-creds');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const dir = join(ROOT, 'session-claude', 'spawn-nocreds');
    const h = writeSpawnClaudeConfig(home, { persistentDir: dir });
    expect(existsSync(h.configDir)).toBe(true);
    expect(existsSync(join(h.configDir, '.credentials.json'))).toBe(false);
  });
});
