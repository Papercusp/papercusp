/**
 * su-lock-store.test.ts — migration-source resolution for lazy lock bootstrap.
 *
 * Run: cd libs/papercusp/packages/locks && npx vitest run src/su-lock-store.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLocksSqlDir } from './su-lock-store';

const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'locks-sql-dir-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveLocksSqlDir', () => {
  it('falls back from a removed release dist-host to canonical lock sources', () => {
    const root = fixtureRoot();
    const moduleDir = join(root, 'apps', 'operator', 'dist-host');
    const sourceDir = join(root, 'libs', 'papercusp', 'packages', 'locks', 'src', 'sql');
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });

    expect(resolveLocksSqlDir(moduleDir)).toBe(sourceDir);
  });

  it('prefers the adjacent bundled SQL directory when both layouts exist', () => {
    const root = fixtureRoot();
    const moduleDir = join(root, 'apps', 'operator', 'dist-host');
    const bundledDir = join(moduleDir, 'sql');
    const sourceDir = join(root, 'libs', 'papercusp', 'packages', 'locks', 'src', 'sql');
    mkdirSync(bundledDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });

    expect(resolveLocksSqlDir(moduleDir)).toBe(bundledDir);
  });

  it('keeps the adjacent path as the loud failure target when no layout exists', () => {
    const root = fixtureRoot();
    const moduleDir = join(root, 'apps', 'operator', 'dist-host');
    mkdirSync(moduleDir, { recursive: true });

    expect(resolveLocksSqlDir(moduleDir)).toBe(join(moduleDir, 'sql'));
  });
});
