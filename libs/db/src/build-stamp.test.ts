/**
 * EI-19484133375867605 — a corrected error MESSAGE cannot reach long-lived hosts, so
 * agents keep re-filing an already-fixed bug. `[connect-phase-deadline]` was fixed at
 * 10479ae8 and re-filed as a live defect four times afterwards, the last 8h after the
 * fix deployed, because the observed string IS the evidence and the observed string is
 * exactly what changed. Stamping the emitting build into the tag gives a pasted
 * diagnostic its own provenance.
 *
 * Two properties are load-bearing and each is asserted in BOTH directions, because a
 * one-directional assertion here is worthless:
 *
 *  - The real diagnostics are actually WIRED to the seam. A test that only asserted
 *    the bare `[connect-phase-deadline]` tag would pass just as happily if the seam
 *    were never called at all, so every wiring test asserts the stamped form AND the
 *    unstamped one for the same error class. The pair is what proves the message
 *    changes with registration rather than being a constant that happens to match.
 *  - Unregistered renders the tag EXACTLY as it read before this change. That is the
 *    compatibility contract every existing log grep and assertion depends on, and it
 *    is also the honest reading: a host that cannot prove its build must not claim one.
 *
 * Pure string construction — both error classes are constructible with no I/O.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  setBuildStampResolver,
  resetBuildStampResolver,
  readBuildStamp,
  stampedTag,
} from './build-stamp';
import { ConnectPhaseDeadlineError } from './connect-retry';
import { DbCallDeadlineError } from './connection';

// The state is process-pinned, so a leaked registration would silently stamp every
// later test's diagnostics in this worker.
afterEach(() => {
  resetBuildStampResolver();
});

describe('build-stamp seam', () => {
  it('renders the bare tag when no host has registered a resolver', () => {
    expect(stampedTag('connect-phase-deadline')).toBe('[connect-phase-deadline]');
    expect(readBuildStamp()).toBeNull();
  });

  it('renders the stamp INSIDE the brackets so the tag stays one greppable token', () => {
    setBuildStampResolver(() => '10479ae8');
    expect(stampedTag('connect-phase-deadline')).toBe('[connect-phase-deadline @ 10479ae8]');
  });

  it('last registration wins, and null clears back to the bare tag', () => {
    setBuildStampResolver(() => 'aaaaaaa');
    setBuildStampResolver(() => 'bbbbbbb');
    expect(stampedTag('t')).toBe('[t @ bbbbbbb]');
    setBuildStampResolver(null);
    expect(stampedTag('t')).toBe('[t]');
  });

  it('trims a padded stamp', () => {
    setBuildStampResolver(() => '  10479ae8\n');
    expect(readBuildStamp()).toBe('10479ae8');
  });

  // A stamp is only worth having if it cannot lie or crash. Each of these is a host
  // that failed to determine its build; every one must degrade to the pre-change tag
  // rather than throwing on a path that is ALREADY failing, or printing a half-value
  // that reads like a real build id.
  it.each([
    ['a resolver that throws', () => { throw new Error('boom'); }],
    ['a host that cannot prove its build (null)', () => null],
    ['an empty string', () => ''],
    ['whitespace only', () => '   '],
    ['a non-string (bundled artifact returning a number)', () => 42 as unknown as string],
    ['undefined', () => undefined as unknown as string],
  ])('degrades to the bare tag for %s', (_label, resolver) => {
    setBuildStampResolver(resolver as () => string | null);
    expect(readBuildStamp()).toBeNull();
    expect(stampedTag('connect-phase-deadline')).toBe('[connect-phase-deadline]');
  });
});

describe('the diagnostics agents actually paste are wired to the seam', () => {
  it('ConnectPhaseDeadlineError carries the stamp — and drops it when unregistered', () => {
    setBuildStampResolver(() => '10479ae8');
    const stamped = new ConnectPhaseDeadlineError(5_000, 'org-app');
    expect(stamped.message).toContain('[connect-phase-deadline @ 10479ae8]');
    expect(stamped.message.startsWith('[connect-phase-deadline @ 10479ae8]')).toBe(true);

    // Calibration: the SAME construction with no resolver must produce the original
    // string. Without this half, the assertion above could not distinguish a wired
    // message from an unwired constant.
    resetBuildStampResolver();
    const bare = new ConnectPhaseDeadlineError(5_000, 'org-app');
    expect(bare.message.startsWith('[connect-phase-deadline]')).toBe(true);
    expect(bare.message).not.toContain('[connect-phase-deadline @');
  });

  it('DbCallDeadlineError carries the stamp — and drops it when unregistered', () => {
    setBuildStampResolver(() => '10479ae8');
    const stamped = new DbCallDeadlineError('some-call', 5_000, 5_100, 'org-app');
    expect(stamped.message.startsWith('[db-call-deadline @ 10479ae8]')).toBe(true);

    resetBuildStampResolver();
    const bare = new DbCallDeadlineError('some-call', 5_000, 5_100, 'org-app');
    expect(bare.message.startsWith('[db-call-deadline]')).toBe(true);
  });

  it('a throwing resolver never fails the diagnostic it is only annotating', () => {
    setBuildStampResolver(() => {
      throw new Error('build resolution exploded');
    });
    expect(() => new ConnectPhaseDeadlineError(5_000, 'org-app')).not.toThrow();
    expect(new ConnectPhaseDeadlineError(5_000).message).toContain('[connect-phase-deadline]');
  });
});
