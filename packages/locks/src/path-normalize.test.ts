/**
 * Pure unit coverage for the path validation + canonicalization rules —
 * the package's standalone-safe suite (no PG, no host config needed), so
 * `vitest run` is green in isolation. The live-PG store/coordinator suites
 * stay operator-side and exercise the rest of the package through the
 * host-adapter shims.
 *
 * These rules are the server-side source of truth for what a lock path may
 * look like; the OMP hook mirrors them independently (see
 * path-normalize.ts header) so keep this suite in lockstep with any rule
 * change.
 */
import { describe, expect, it } from 'vitest';
import {
  InvalidPathError,
  MAX_PATH_LEN,
  canonicalizePath,
  normalizePaths,
  validatePath,
} from './path-normalize';

describe('validatePath', () => {
  it('accepts a plain repo-relative POSIX path', () => {
    expect(() => validatePath('apps/operator/lib/foo.ts')).not.toThrow();
  });

  it('rejects empty', () => {
    expect(() => validatePath('')).toThrow(InvalidPathError);
  });

  it('rejects absolute paths', () => {
    expect(() => validatePath('/etc/passwd')).toThrow(/absolute/);
  });

  it('rejects .. traversal in every position', () => {
    expect(() => validatePath('..')).toThrow(/traversal/);
    expect(() => validatePath('../x')).toThrow(/traversal/);
    expect(() => validatePath('a/../b')).toThrow(/traversal/);
    expect(() => validatePath('a/..')).toThrow(/traversal/);
  });

  it('rejects backslashes', () => {
    expect(() => validatePath('apps\\foo.ts')).toThrow(/backslash/);
  });

  it('rejects NUL bytes', () => {
    expect(() => validatePath('apps/\0foo.ts')).toThrow(/null byte/);
  });

  it('rejects paths longer than MAX_PATH_LEN', () => {
    expect(() => validatePath('a'.repeat(MAX_PATH_LEN + 1))).toThrow(/too long/);
  });
});

describe('canonicalizePath', () => {
  it('strips a leading ./', () => {
    expect(canonicalizePath('./apps/foo.ts')).toBe('apps/foo.ts');
  });

  it('collapses repeated /', () => {
    expect(canonicalizePath('apps//foo.ts')).toBe('apps/foo.ts');
  });

  it('drops /./ segments', () => {
    expect(canonicalizePath('apps/./foo.ts')).toBe('apps/foo.ts');
  });

  it('strips a trailing /', () => {
    expect(canonicalizePath('apps/foo.ts/')).toBe('apps/foo.ts');
  });

  it('collapses every equivalent spelling onto one key', () => {
    const key = 'apps/foo.ts';
    for (const spelling of ['./apps/foo.ts', 'apps//foo.ts', 'apps/./foo.ts', 'apps/foo.ts/']) {
      expect(canonicalizePath(spelling)).toBe(key);
    }
  });
});

describe('normalizePaths', () => {
  it('validates raw, then canonicalizes, sorts, and dedupes', () => {
    const out = normalizePaths(['b/y.ts', './a/x.ts', 'a//x.ts']);
    // './a/x.ts' and 'a//x.ts' both canonicalize to 'a/x.ts' → deduped.
    expect(out).toEqual(['a/x.ts', 'b/y.ts']);
  });

  it('throws on the first malformed raw path before canonicalizing', () => {
    expect(() => normalizePaths(['ok/path.ts', '../escape'])).toThrow(InvalidPathError);
  });

  it('throws when a path canonicalizes to empty', () => {
    expect(() => normalizePaths(['.'])).toThrow(/empty after canonicalization/);
  });
});
