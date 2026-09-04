/**
 * su-lock-store.test.ts — migration-source resolution for lazy lock bootstrap.
 *
 * Run: cd libs/papercusp/packages/locks && npx vitest run src/su-lock-store.test.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLocksSqlDir, tryAcquire } from './su-lock-store';

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

describe('git-sync registry prose migration', () => {
  it('keeps the bare resource description aligned with the workspace barrier', () => {
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'sql', '028-git-sync-registry-prose.sql'),
      'utf8',
    );

    expect(migration).toContain("UPDATE agent_resource_registry");
    expect(migration).toContain("WHERE resource = 'git-sync'");
    expect(migration).toContain('workspace-wide git-sync restart barrier shared by every automated git-sync fire');
    expect(migration).toContain('shared(git-sync)');
    expect(migration).toContain('exclusive(git-sync:<slug>)');
    expect(migration).toContain('dev:restart');
    expect(migration).toContain('updated_ts = clock_timestamp()');
    expect(migration).not.toContain('papercup-only legacy back-off');
  });
});

describe('tryAcquire', () => {
  it('marks a short upsert result as an explicit retryable race, even with no busy snapshot', async () => {
    const tx = ((strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      if (text.includes('WITH wanted')) {
        // Simulate a competing row winning one path after the pre-check. The
        // competing row is then gone before readBusySnapshot, so the snapshot
        // is intentionally empty.
        return [{ path: 'first.ts', lock_id: '00000000-0000-0000-0000-000000000001' }];
      }
      return [];
    }) as unknown as Parameters<typeof tryAcquire>[0];

    const result = await tryAcquire(tx, {
      coordinationDomain: 'test-domain',
      owner: 'requester',
      ownerLabel: 'Requester',
      paths: ['first.ts', 'second.ts'],
      intent: 'race regression',
      ttlSec: 60,
    });

    expect(result).toEqual({
      ok: false,
      busy: [],
      reason: 'upsert_race',
      retryable: true,
    });
  });
});
