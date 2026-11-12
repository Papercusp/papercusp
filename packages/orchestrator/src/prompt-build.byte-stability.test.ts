/**
 * prompt-build.byte-stability.test.ts — WI-175: bee preamble byte-stability
 * measurement across distinct bee spawns.
 *
 * The bee preamble (sections 1-5 of buildPromptParts) is cacheable and MUST be
 * byte-identical across all spawns of the same role in the same harness, regardless
 * of volatile content (runId, extras, plan context, feature history, etc.). This test:
 *
 * 1. BYTE-STABILITY: calls buildPromptParts multiple times with DIFFERENT volatile
 *    inputs and verifies the preambles are identical (hash-checked).
 * 2. NO PER-BEE LEAKAGE: inspects the preamble for any spawn ID, timestamp, or other
 *    per-bee-specific data that would break caching (should be zero occurrences).
 * 3. CACHE-HIT CEILING: measures the theoretical maximum cache-hit percentage when
 *    all bees of the same role call buildPromptParts with the same preamble.
 *
 * The measurements are the basis for the cache-hit ceiling analysis in P-009.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import type { BuildPromptInput, PromptParts } from './prompt-build';
import { buildPromptParts, WAIT_LOOP_NOTE } from './prompt-build';

/** Hash a string for quick byte-comparison. */
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Detect any per-bee-specific data in a string (spawn IDs, UUIDs, timestamps, etc.). */
function findPotentialLeakage(preamble: string): string[] {
  const findings: string[] = [];

  // UUIDs (e.g., spawn IDs from coord)
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const uuids = preamble.match(uuidPattern);
  if (uuids && uuids.length > 0) {
    findings.push(`Found ${uuids.length} UUIDs in preamble: ${uuids.slice(0, 3).join(', ')}`);
  }

  // ISO 8601 timestamps (e.g., 2026-06-16T...)
  const isoPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g;
  const timestamps = preamble.match(isoPattern);
  if (timestamps && timestamps.length > 0) {
    findings.push(`Found ${timestamps.length} ISO timestamps in preamble: ${timestamps.slice(0, 3).join(', ')}`);
  }

  // Unix timestamps (large numbers that look like epoch ms)
  const epochPattern = /\b\d{13}\b/g; // 13-digit unix ms timestamps
  const epochs = preamble.match(epochPattern);
  if (epochs && epochs.length > 0) {
    findings.push(`Found ${epochs.length} potential epoch-ms timestamps: ${epochs.slice(0, 3).join(', ')}`);
  }

  // Run IDs (typically RUN-<hex> or run-NN format)
  const runPattern = /run[_-]?id[:\s]([a-z0-9\-]+)/gi;
  const runs = preamble.match(runPattern);
  if (runs && runs.length > 0) {
    findings.push(`Found ${runs.length} run ID references: ${runs.slice(0, 3).join(', ')}`);
  }

  return findings;
}

/** Build a deterministic minimal test input for a given role. */
function makeInput(role: string, volatile: { runId: string; extras: string[] }): BuildPromptInput {
  return {
    role,
    promptFile: '/nonexistent/role.md', // fileContents() returns '' for nonexistent files
    projectDir: '/project',
    harnessDir: '/hive',
    stateDir: '/state',
    runId: volatile.runId,
    extras: volatile.extras,
    // BuildPromptInput declares these required-but-emptiable: '' / null IS the "absent"
    // value production passes (see prompt-build.ts — "May be empty", "Empty string
    // disables"). Passing `undefined` made this fixture exercise a shape production never
    // produces; these are the real generic-role values.
    promptOverride: '',
    cwdOverride: '',
    featureId: null,
    featureOrigin: undefined,
    coordOwnerId: undefined,
    acceptanceKind: 'tests',
    substrateContext: 'Substrate context for testing.',
    brief: 'Queen brief for testing.',
    planContext: 'Plan context for testing.',
    featureHistory: 'Feature history for testing.',
    lexicon: undefined,
    identity: '## Test Identity\nTest bee identity',
    sharedGuides: ['## Shared Guide\nTest guide'],
  };
}

describe('bee preamble byte-stability (WI-175)', () => {
  it('renders the same bounded wait policy across distinct wake contexts', () => {
    const a = buildPromptParts(makeInput('test-worker', { runId: 'warm', extras: ['first wait'] }));
    const b = buildPromptParts(makeInput('test-worker', { runId: 'cold', extras: ['equivalent rearm'] }));
    expect(a.preamble).toContain(WAIT_LOOP_NOTE);
    expect(b.preamble).toContain(WAIT_LOOP_NOTE);
    expect(a.preamble).toBe(b.preamble);
    expect(WAIT_LOOP_NOTE).toContain('stop automatic polling/rearm');
    expect(WAIT_LOOP_NOTE).toContain('never grants takeover authority');
  });
  it('preamble is BYTE-IDENTICAL across multiple spawns with different volatile inputs', () => {
    const role = 'test-worker';

    // Build the same prompt multiple times with DIFFERENT volatile content.
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const input = makeInput(role, {
        runId: `run-${i}`, // <- different runId each time
        extras: [
          `Extra context ${i}`,
          `Timestamp: ${Date.now() + i * 1000}`, // <- different timestamps
        ],
      });
      const { preamble } = buildPromptParts(input);
      hashes.push(sha256(preamble));
    }

    // All preambles must hash to the same value (byte-identical).
    const first = hashes[0];
    for (const h of hashes.slice(1)) {
      expect(
        h,
        'Preamble must be identical across spawns (cache assumption P-009). ' +
          'If this fails, volatile content leaked into the preamble.',
      ).toBe(first);
    }
  });

  it('preamble contains NO per-bee-specific data (no UUIDs, timestamps, run IDs)', () => {
    const input = makeInput('test-worker', {
      runId: 'run-123-abc',
      extras: ['Volatile extra 1', 'Volatile extra 2'],
    });
    const { preamble } = buildPromptParts(input);

    const leakage = findPotentialLeakage(preamble);
    expect(
      leakage,
      `Preamble must not contain per-bee-specific data. Found:\n${leakage.join('\n')}. ` +
        'This breaks the cache assumption — volatile data contaminated the preamble.',
    ).toEqual([]);
  });

  it('preamble is stable even when volatile section changes dramatically', () => {
    const role = 'test-worker';

    // First spawn: minimal volatile
    const input1 = makeInput(role, {
      runId: 'run-minimal',
      extras: ['minimal'],
    });
    const { preamble: preamble1 } = buildPromptParts(input1);

    // Second spawn: maximum volatile
    const input2 = makeInput(role, {
      runId: 'run-maximal-with-many-details-that-could-bleed',
      extras: Array.from({ length: 20 }, (_, i) => `Extra detail ${i}: very long content that should not affect preamble`),
    });
    const { preamble: preamble2 } = buildPromptParts(input2);

    expect(
      sha256(preamble1),
      'Preamble must be stable even with dramatically different volatile sections.',
    ).toBe(sha256(preamble2));
  });

  it('volatile section is different (as expected) across spawns', () => {
    const role = 'test-worker';

    const input1 = makeInput(role, {
      runId: 'run-1',
      extras: ['extra-1'],
    });
    const { volatile: volatile1 } = buildPromptParts(input1);

    const input2 = makeInput(role, {
      runId: 'run-2',
      extras: ['extra-2'],
    });
    const { volatile: volatile2 } = buildPromptParts(input2);

    expect(
      volatile1,
      'Volatile sections MUST differ when inputs differ. ' +
        'If this fails, volatile content was not properly segregated.',
    ).not.toBe(volatile2);

    // Both volatiles should contain their respective runIds (to verify segregation).
    expect(volatile1).toContain('run-1');
    expect(volatile2).toContain('run-2');
  });

  it('preamble structure follows P-009: sections 1-5 are cacheable', () => {
    const input = makeInput('test-worker', {
      runId: 'run-test',
      extras: ['extras'],
    });
    const result = buildPromptParts(input);

    // The preamble should contain the identity and shared guides (cacheable sections).
    expect(result.preamble).toContain('Test Identity');
    expect(result.preamble).toContain('Shared Guide');

    // The volatile should contain the runId (section 7: runtime context).
    expect(result.volatile).toContain('run-test');
    expect(result.volatile).toContain('extras');
  });

  describe('cache-hit ceiling measurement (P-009)', () => {
    it('estimates the per-bee cache-hit percentage when preamble is shared', () => {
      const role = 'test-worker';
      const numSpawns = 10;

      // Simulate multiple bee spawns of the same role.
      const samples: { preamble: string; volatile: string; preambleSize: number; volatileSize: number }[] = [];

      for (let i = 0; i < numSpawns; i++) {
        const input = makeInput(role, {
          runId: `run-${i}`,
          extras: [`Worker ${i} context`],
        });
        const { preamble, volatile } = buildPromptParts(input);
        samples.push({
          preamble,
          volatile,
          preambleSize: Buffer.byteLength(preamble, 'utf8'),
          volatileSize: Buffer.byteLength(volatile, 'utf8'),
        });
      }

      // All preambles must be identical (byte-for-byte).
      const firstHash = sha256(samples[0].preamble);
      for (const s of samples) {
        expect(
          sha256(s.preamble),
          'All preambles must be identical for cache-hit ceiling calculation.',
        ).toBe(firstHash);
      }

      // Calculate the theoretical cache-hit ceiling: preamble bytes / total bytes.
      const preambleBytes = samples[0].preambleSize;
      const avgVolatileBytes = samples.reduce((sum, s) => sum + s.volatileSize, 0) / numSpawns;
      const totalBytes = preambleBytes + avgVolatileBytes;
      const cacheHitCeiling = (preambleBytes / totalBytes) * 100;

      // The preamble should be a significant fraction of the total (not nil).
      // This is a SANITY check, not a real-world ceiling: makeInput uses an
      // intentionally TINY synthetic volatile (~one-line substrate/brief/plan/history),
      // so as the static shared base legitimately grows (friction, yield, account,
      // deploy, testing, reuse-first, observation-rubric, …) this ratio climbs toward
      // 100% even though the LIVE ceiling is far lower (the real volatile tail — Queen
      // brief, substrate view, feature history — is KBs). The true cache guards are the
      // byte-identical-preamble + no-leakage tests above; here we only catch a
      // degenerate collapse of the volatile into the preamble — asserted DIRECTLY as
      // "every spawn keeps a non-empty per-spawn volatile", not as a ratio ceiling
      // (a <99% bound re-reds every time the shared base legitimately grows; it
      // crossed 99.02% on 2026-07-12 from static-section growth alone).
      expect(cacheHitCeiling).toBeGreaterThan(10); // At least 10% preamble
      for (const s of samples) {
        expect(s.volatileSize).toBeGreaterThan(0); // volatile never collapses into the preamble
      }

      // Log the measurement for manual review (visible in test output).
      console.log(`[WI-175 measurement] cache-hit ceiling: ${cacheHitCeiling.toFixed(1)}%`);
      console.log(`  preamble: ${preambleBytes} bytes (cacheable across all spawns)`);
      console.log(`  volatile (avg): ${avgVolatileBytes.toFixed(0)} bytes (per-spawn unique)`);
      console.log(`  total: ${totalBytes.toFixed(0)} bytes`);
    });
  });
});
