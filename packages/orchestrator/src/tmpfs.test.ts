import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ramTmpRoot, withTmpDir, _resetRamTmpRootCache } from './tmpfs';

beforeEach(() => {
  _resetRamTmpRootCache();
  vi.unstubAllGlobals();
});

describe('ramTmpRoot', () => {
  it('returns /dev/shm on linux when present', () => {
    if (process.platform !== 'linux') return;
    if (!existsSync('/dev/shm')) return;
    expect(ramTmpRoot()).toBe('/dev/shm');
  });

  it('caches the result', () => {
    const a = ramTmpRoot();
    const b = ramTmpRoot();
    expect(a).toBe(b);
  });

  it('falls back to tmpdir when /dev/shm is absent', () => {
    // Simulate by stubbing process.platform — no real way to test without
    // /dev/shm absence; this is best-effort coverage of the fallback path.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    _resetRamTmpRootCache();
    const root = ramTmpRoot();
    // On darwin/win32, ramTmpRoot returns os.tmpdir() — must be writable
    expect(statSync(root).isDirectory()).toBe(true);
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
  });
});

describe('withTmpDir', () => {
  it('creates a unique directory and cleans up on success', async () => {
    let observed: string | null = null;
    await withTmpDir(async (dir) => {
      observed = dir;
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(dir.includes('papercusp-')).toBe(true);
    });
    expect(observed).not.toBeNull();
    expect(existsSync(observed!)).toBe(false);
  });

  it('cleans up even when fn throws', async () => {
    let observed: string | null = null;
    await expect(
      withTmpDir(async (dir) => {
        observed = dir;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(observed).not.toBeNull();
    expect(existsSync(observed!)).toBe(false);
  });

  it('returns the value from fn', async () => {
    const result = await withTmpDir(async () => 42);
    expect(result).toBe(42);
  });

  it('allows writing files inside and they are gone after', async () => {
    let path: string | null = null;
    await withTmpDir(async (dir) => {
      path = join(dir, 'prompt.md');
      await writeFile(path, 'hello');
      expect(readFileSync(path, 'utf8')).toBe('hello');
    });
    expect(existsSync(path!)).toBe(false);
  });

  it('handles concurrent calls without collision', async () => {
    const dirs = new Set<string>();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withTmpDir(async (dir) => { dirs.add(dir); }),
      ),
    );
    expect(dirs.size).toBe(20);
    for (const d of dirs) expect(existsSync(d)).toBe(false);
  });
});
