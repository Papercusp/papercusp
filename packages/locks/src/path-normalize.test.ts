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

  it('rejects an absolute path even when it is not the first element', () => {
    // The raw-validate loop runs over EVERY path before any canonicalization,
    // so a malformed entry anywhere in the set fails the whole call.
    expect(() => normalizePaths(['ok/path.ts', '/etc/passwd'])).toThrow(/absolute/);
  });
});

// ── Security invariants the validate→canonicalize ordering depends on ────────
// These pin the two properties the module header + source comments rely on for
// traversal safety. They are correct today; the point is to fail loudly if a
// future "optimization" (e.g. swapping in path.normalize, or reordering the
// validate/canonicalize steps) silently re-opens an escape.
describe('canonicalizePath — traversal-safety invariants', () => {
  it('PRESERVES .. segments (never resolves or drops them)', () => {
    // If canon resolved '..' the way path.normalize does, 'a/../b' would become
    // 'b' and a raw 'a/../../etc' could collapse to an escaping key. canon must
    // leave '..' intact so the raw-path validatePath check is what rejects it.
    expect(canonicalizePath('a/../b')).toBe('a/../b');
    expect(canonicalizePath('../etc/passwd')).toBe('../etc/passwd');
    expect(canonicalizePath('a/../../etc')).toBe('a/../../etc');
  });

  it('would strip a leading slash on its OWN — proving validate must run first', () => {
    // canonicalizePath drops the empty leading segment, turning an absolute path
    // into a relative-looking one. This is exactly why normalizePaths validates
    // the RAW path before canonicalizing (source comment): canon alone is unsafe.
    expect(canonicalizePath('/etc/passwd')).toBe('etc/passwd');
    // …but the full pipeline rejects it, because validatePath sees the raw '/'.
    expect(() => normalizePaths(['/etc/passwd'])).toThrow(/absolute/);
  });
});

describe('validatePath — adversarial edges', () => {
  it('rejects a backslash-based traversal (caught as backslash, never accepted)', () => {
    // A Windows-style '..\\..\\etc' doesn't match the POSIX '/../' traversal
    // pattern, so the backslash rule is what stops it. Pin that it is rejected.
    expect(() => validatePath('..\\..\\etc\\passwd')).toThrow(InvalidPathError);
  });

  it('rejects a bare ".." regardless of canonicalization', () => {
    expect(() => validatePath('..')).toThrow(/traversal/);
  });
});
