/**
 * intention-locks — Gray multi-granularity matrix + protocol (D-005,
 * locks-correctness-hardening-2026-06-04). Pure unit tests.
 */

import { describe, it, expect } from 'vitest';
import {
  MODE_COMPATIBLE,
  compatible,
  intentionFor,
  normalizeNode,
  ancestorsOf,
  lockSetFor,
  findConflicts,
  ROOT_NODE,
  type GranularMode,
  type HeldNodeLock,
} from './intention-locks';

const ALL: GranularMode[] = ['IS', 'IX', 'S', 'SIX', 'X'];

describe('compatibility matrix', () => {
  it('is symmetric', () => {
    for (const a of ALL) for (const b of ALL) {
      expect(MODE_COMPATIBLE[a][b]).toBe(MODE_COMPATIBLE[b][a]);
    }
  });

  it('matches Gray 1976', () => {
    // X conflicts with everything; IS conflicts only with X.
    for (const m of ALL) expect(compatible('X', m)).toBe(false);
    expect(compatible('IS', 'IS')).toBe(true);
    expect(compatible('IS', 'IX')).toBe(true);
    expect(compatible('IS', 'S')).toBe(true);
    expect(compatible('IS', 'SIX')).toBe(true);
    expect(compatible('IS', 'X')).toBe(false);
    // IX coexists with IS/IX but not S/SIX/X.
    expect(compatible('IX', 'IX')).toBe(true);
    expect(compatible('IX', 'S')).toBe(false);
    // S coexists with IS/S only.
    expect(compatible('S', 'S')).toBe(true);
    expect(compatible('S', 'IX')).toBe(false);
    // SIX coexists with IS only; SIX/SIX conflicts (two would-be writers).
    expect(compatible('SIX', 'IS')).toBe(true);
    expect(compatible('SIX', 'SIX')).toBe(false);
  });
});

describe('intention + ancestry derivation', () => {
  it('intentionFor maps read→IS, write→IX', () => {
    expect(intentionFor('S')).toBe('IS');
    expect(intentionFor('IS')).toBe('IS');
    expect(intentionFor('X')).toBe('IX');
    expect(intentionFor('IX')).toBe('IX');
    expect(intentionFor('SIX')).toBe('IX');
  });

  it('normalizeNode collapses root/empty/dot/trailing-slash', () => {
    expect(normalizeNode('')).toBe(ROOT_NODE);
    expect(normalizeNode('.')).toBe(ROOT_NODE);
    expect(normalizeNode('/')).toBe(ROOT_NODE);
    expect(normalizeNode('a/b/')).toBe('a/b');
  });

  it('ancestorsOf yields root-first ancestors excluding the node', () => {
    expect(ancestorsOf('apps/operator/foo.ts')).toEqual(['', 'apps', 'apps/operator']);
    expect(ancestorsOf('apps')).toEqual(['']);
    expect(ancestorsOf('')).toEqual([]);
  });

  it('lockSetFor: a file write = X leaf + IX ancestors (incl. harness root)', () => {
    expect(lockSetFor('a/b/c.ts', 'X')).toEqual([
      { node: '', mode: 'IX' },
      { node: 'a', mode: 'IX' },
      { node: 'a/b', mode: 'IX' },
      { node: 'a/b/c.ts', mode: 'X' },
    ]);
  });

  it('lockSetFor: a subtree read = S leaf + IS ancestors; root = just the node', () => {
    expect(lockSetFor('a/b', 'S')).toEqual([
      { node: '', mode: 'IS' },
      { node: 'a', mode: 'IS' },
      { node: 'a/b', mode: 'S' },
    ]);
    expect(lockSetFor('', 'X')).toEqual([{ node: '', mode: 'X' }]);
  });
});

describe('conflict detection (multi-granularity)', () => {
  const heldFromRequest = (path: string, mode: GranularMode, owner: string): HeldNodeLock[] =>
    lockSetFor(path, mode).map((l) => ({ ...l, owner }));

  it('a harness-exclusive (X on root) conflicts with a descendant file lock', () => {
    const fileLock = heldFromRequest('apps/operator/foo.ts', 'X', 'A'); // IX on root
    const harnessX = lockSetFor('', 'X'); // X on root
    const conflicts = findConflicts(fileLock, harnessX, 'B');
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0].node).toBe(ROOT_NODE);
    expect(conflicts[0].held_mode).toBe('IX');
    expect(conflicts[0].requested_mode).toBe('X');
  });

  it('two file writes in the SAME harness on DIFFERENT files do not conflict', () => {
    const held = heldFromRequest('a/b/one.ts', 'X', 'A'); // IX root/a/a-b, X leaf
    const req = lockSetFor('a/b/two.ts', 'X'); // IX root/a/a-b, X different leaf
    expect(findConflicts(held, req, 'B')).toEqual([]); // IX/IX compatible at shared ancestors
  });

  it('two writers on the SAME file conflict (X vs X)', () => {
    const held = heldFromRequest('a/b/c.ts', 'X', 'A');
    const req = lockSetFor('a/b/c.ts', 'X');
    const conflicts = findConflicts(held, req, 'B');
    expect(conflicts.some((c) => c.node === 'a/b/c.ts' && c.held_mode === 'X')).toBe(true);
  });

  it('a subtree read (S) conflicts with a file write under it', () => {
    const dirRead = heldFromRequest('a/b', 'S', 'A'); // S on a/b
    const fileWrite = lockSetFor('a/b/c.ts', 'X'); // IX on a/b (ancestor)
    const conflicts = findConflicts(dirRead, fileWrite, 'B');
    expect(conflicts.some((c) => c.node === 'a/b' && c.held_mode === 'S' && c.requested_mode === 'IX')).toBe(true);
  });

  it('two subtree readers (S) coexist', () => {
    const held = heldFromRequest('a/b', 'S', 'A');
    const req = lockSetFor('a/b', 'S');
    expect(findConflicts(held, req, 'B')).toEqual([]);
  });

  it('the SAME owner never conflicts with itself (escalation IX→X)', () => {
    const ownIx = heldFromRequest('a/b/c.ts', 'X', 'A'); // A holds IX on root + X leaf
    const ownHarnessX = lockSetFor('', 'X'); // A escalating to harness-X
    expect(findConflicts(ownIx, ownHarnessX, 'A')).toEqual([]); // self-compatible
    // …but another owner attempting the same escalation conflicts.
    expect(findConflicts(ownIx, ownHarnessX, 'B').length).toBeGreaterThan(0);
  });
});
