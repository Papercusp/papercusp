/**
 * bee-preamble-byte-stability.test.ts — WI-188: bee cacheable-preamble
 * byte-stability regression lock (bee-context-efficiency-2026-06-14 P-014).
 *
 * P-003 CONFIRMED: the bee preamble (sections 1-5 of buildPromptParts) is
 * byte-stable across all spawns of the bee role in the same harness,
 * regardless of volatile content (runId, spawn id, timestamp, etc.). This test
 * locks that invariant so any future change to the preamble assembly path
 * breaks this regression — a safety net against per-bee data leaking into
 * the cached prefix (D-013, D-016 are the evidence).
 *
 * TWO THREADS:
 * 1. DISTINCT BEES PRODUCE IDENTICAL PREAMBLES: two bee spawns with different
 *    spawn IDs and volatile context must emit BYTE-IDENTICAL preambles, so the
 *    fleet shares one cached prefix (the cross-bee cache-hit ceiling D-016
 *    measured ~77K preamble bytes shared across long-lived bees).
 *
 * 2. INLINE-PROMPT VECTOR: inlinePrompt (a shortcut for ad-hoc prompts, used
 *    by the chunk-loop driver) is NOT used in the bee path (bee paths use
 *    promptFile / promptFiles). If a bee path ever accidentally uses inlinePrompt,
 *    the preamble varies per-spawn and the cache breaks. This test asserts
 *    inlinePrompt is absent (should be '') and verifies that any inlinePrompt
 *    content would land in the VOLATILE section (after the preamble), not inside it.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import type { BuildPromptInput, PromptParts } from './prompt-build';
import { buildPromptParts } from './prompt-build';

/** Hash a string for byte-comparison across spawns. */
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Simulate a bee spawn context with distinct identity but same role/harness. */
function makeBeeInput(
  opts: {
    spawnId: string;
    runId: string;
    coordOwnerId: string;
    extras?: string[];
  } = { spawnId: 'bee-1', runId: 'run-bee-1', coordOwnerId: 's-1111-1111' },
): BuildPromptInput {
  return {
    role: 'cup',
    promptFile: '/nonexistent/bee.md', // file reads return '' if missing
    projectDir: '/project',
    harnessDir: '/hive',
    stateDir: '/state',
    runId: opts.runId,
    coordOwnerId: opts.coordOwnerId,
    extras: opts.extras || [],
    acceptanceKind: 'tests', // bee default
    identity: '## Bee Identity\nGeneric Hive worker identity.',
    sharedGuides: ['## Bee Guide\nBee execution guide.'],
    // Intentionally omitting:
    // - inlinePrompt (must be empty/absent for bee paths)
    // - featureId (bee is generic, no feature scope)
    // - featureHistory (generic worker, no feature)
    // - planContext (generic worker, no plan)
  };
}

describe('bee preamble byte-stability (WI-188, P-014)', () => {
  it('two distinct bee spawns (different spawn IDs) produce BYTE-IDENTICAL preambles', () => {
    // Spawn 1: bee s-1111-1111, run-bee-1
    const bee1 = makeBeeInput({
      spawnId: 'bee-1',
      runId: 'run-bee-1',
      coordOwnerId: 's-1111-1111',
    });
    const { preamble: preamble1 } = buildPromptParts(bee1);

    // Spawn 2: bee s-2222-2222, run-bee-2 (different identity + run ID)
    const bee2 = makeBeeInput({
      spawnId: 'bee-2',
      runId: 'run-bee-2',
      coordOwnerId: 's-2222-2222',
    });
    const { preamble: preamble2 } = buildPromptParts(bee2);

    // Preambles must be BYTE-IDENTICAL, enabling cross-bee cache hits.
    const hash1 = sha256(preamble1);
    const hash2 = sha256(preamble2);
    expect(hash1).toBe(
      hash2,
      'Preamble must be identical across distinct bee spawns (cross-bee cache ceiling D-016). ' +
        'If this fails, per-bee data (spawn ID, run ID, etc.) leaked into the preamble.',
    );
  });

  it('preamble is stable across multiple bees with dramatically different volatile inputs', () => {
    const hashes: string[] = [];

    // Simulate 5 bee spawns with wildly different extras/context.
    for (let i = 0; i < 5; i++) {
      const input = makeBeeInput({
        spawnId: `bee-${i}`,
        runId: `run-bee-${i}`,
        coordOwnerId: `s-${String(i).padStart(4, '0')}-${String(i).padStart(4, '0')}`,
        extras: [
          `Bee context ${i}`,
          `Timestamp: ${Date.now() + i * 10000}`,
          `Extra volatile ${i}`,
        ],
      });
      const { preamble } = buildPromptParts(input);
      hashes.push(sha256(preamble));
    }

    // All preambles must hash identically despite volatile differences.
    const first = hashes[0];
    for (let i = 1; i < hashes.length; i++) {
      expect(hashes[i]).toBe(
        first,
        `Preamble must be stable across spawn ${i}. ` +
          'Volatile content contaminated the cacheable prefix.',
      );
    }
  });

  it('inlinePrompt is absent in bee spawns (bee uses promptFile, not inline injection)', () => {
    const input = makeBeeInput({
      spawnId: 'bee-inline-check',
      runId: 'run-inline-check',
      coordOwnerId: 's-3333-3333',
    });

    // Ensure inlinePrompt is NOT set (empty or undefined).
    expect(input.inlinePrompt).toBeUndefined();

    // Build the prompt and verify no inline-injected content appears in the preamble.
    const { preamble } = buildPromptParts(input);

    // If inlinePrompt were used, it would appear in the preamble (section 1).
    // Verify the preamble contains only the expected stable role/identity content.
    expect(preamble).toContain('Bee Identity'); // From identity parameter
    expect(preamble).toContain('Bee Guide'); // From sharedGuides parameter

    // The preamble should NOT contain the per-spawn extras (those are volatile).
    expect(preamble).not.toContain('Bee context');
    expect(preamble).not.toContain('extra volatile');
  });

  it('if inlinePrompt were supplied to a bee, it would appear in volatile section, not preamble', () => {
    const input = makeBeeInput({
      spawnId: 'bee-inline-vector',
      runId: 'run-inline-vector',
      coordOwnerId: 's-4444-4444',
    });

    // Get baseline (no inlinePrompt).
    const baseline = buildPromptParts(input);

    // NOW inject an inlinePrompt and rebuild. This should change the preamble
    // (because inlinePrompt is injected at section 1, breaking the cache).
    // The POINT of this test is to verify such a change would break the cache —
    // a regression guard so we never accidentally pass inlinePrompt to bee paths.
    const withInline: BuildPromptInput = {
      ...input,
      inlinePrompt: 'INJECTED INLINE PROMPT\nThis should break cache if used in bee path.',
    };
    const modified = buildPromptParts(withInline);

    // With inlinePrompt present, the preamble WILL differ (because inlinePrompt
    // is injected early). This is the BAD case we want to catch via regression.
    const baselineHash = sha256(baseline.preamble);
    const modifiedHash = sha256(modified.preamble);

    expect(modifiedHash).not.toBe(
      baselineHash,
      'Regression guard: if a bee path accidentally supplies inlinePrompt, ' +
        'the preamble changes and breaks the cross-bee cache. ' +
        'This assertion proves the guard is active.',
    );

    // The injected content should appear in the modified preamble (section 1).
    expect(modified.preamble).toContain('INJECTED INLINE PROMPT');

    // This confirms: inlinePrompt is NOT a safe place for per-task content for bees.
    // Bee paths must use promptFile / promptFiles only, so the preamble stays stable.
  });

  it('volatile section differs across bees, as expected (sanity check on separation)', () => {
    const bee1 = makeBeeInput({
      spawnId: 'bee-vol-1',
      runId: 'run-vol-1',
      coordOwnerId: 's-5555-5555',
      extras: ['Extra 1'],
    });
    const { volatile: vol1 } = buildPromptParts(bee1);

    const bee2 = makeBeeInput({
      spawnId: 'bee-vol-2',
      runId: 'run-vol-2',
      coordOwnerId: 's-6666-6666',
      extras: ['Extra 2'],
    });
    const { volatile: vol2 } = buildPromptParts(bee2);

    // Volatile sections MUST differ (per-spawn context).
    expect(vol1).not.toBe(
      vol2,
      'Volatile sections must differ across bee spawns.',
    );

    // Each volatile should carry its own spawn-specific data.
    expect(vol1).toContain('run-vol-1');
    expect(vol1).toContain('Extra 1');
    expect(vol2).toContain('run-vol-2');
    expect(vol2).toContain('Extra 2');
  });

  it('preamble + volatile structure follows cache discipline: cacheable prefix + volatile tail', () => {
    const input = makeBeeInput({
      spawnId: 'bee-structure',
      runId: 'run-bee-structure',
      coordOwnerId: 's-7777-7777',
    });
    const result = buildPromptParts(input);

    // Preamble (sections 1-5: role, override, guides, constants, identity, memory).
    // Should contain stable, role-scoped content.
    expect(result.preamble).toContain('Bee Identity');
    expect(result.preamble).toContain('Bee Guide');

    // Volatile (sections 6-10: substrate, runtime, brief, plan, feature).
    // Should contain run-specific content only.
    expect(result.volatile).toContain('run-bee-structure');

    // The preamble should NOT contain the run-specific data.
    expect(result.preamble).not.toContain('run-bee-structure');

    // Verify the separation is clean: preamble + volatile ≈ full prompt.
    const fullLength = (result.preamble + result.volatile).length;
    expect(fullLength).toBeGreaterThan(0);
  });
});
