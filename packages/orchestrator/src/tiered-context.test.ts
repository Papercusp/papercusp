/**
 * Unit coverage for the substrate-context assembler (tiered-context.ts) — the
 * markdown block prepended to every role's prompt by buildPrompt.
 *
 * `fetch` is the only external dependency; we stub `globalThis.fetch` with a
 * URL-substring router (same approach as state.test.ts) so the assembler runs
 * fully in-process.
 *
 * (The bounded supervisor-inbox section this file used to cover — including
 * the G3/P-009 wrapUntrusted() security-wrap tests for parent inbox messages
 * — was removed along with the retired work-item mail surface's inbox route;
 * see retire-work-item-mail-surface-2026-07-26.)
 *
 * Package convention: `test()` + node:assert/strict (see cost-cap.test.ts).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fetchSubstrateContext } from './tiered-context.js';

const BASE = 'http://op.test';

/**
 * Stub globalThis.fetch with a router (url → JSON body, or null/undefined for a
 * 404, or a thrown error to exercise the catch path). Restores in finally.
 */
async function withFetch(
  router: (url: string) => unknown,
  fn: () => Promise<void>,
): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const body = router(url); // may throw → simulates a network error
    if (body === null || body === undefined) {
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

const status = (over: Partial<{ passed: number; todo: number; in_progress: number; failed: number; total: number }> = {}) => ({
  feature_counts: { passed: over.passed ?? 0, todo: over.todo ?? 0, in_progress: over.in_progress ?? 0, failed: over.failed ?? 0 },
  feature_total: over.total ?? 0,
  recent_features: [],
});

// ── Static structure (best-effort: every fetch 404s) ─────────────────────────

test('always emits the static preamble + self block + capabilities, even when every fetch 404s', async () => {
  await withFetch(() => null, async () => {
    const out = await fetchSubstrateContext({ selfSlug: 'shop', parentSlug: null, operatorBase: BASE });
    assert.match(out, /## About Papercusp/);
    assert.match(out, /## Your harness/);
    assert.match(out, /slug: `shop`/);
    assert.match(out, /## Available read capabilities/);
    assert.ok(out.includes(`${BASE}/api/harness/projects`));
    assert.ok(out.includes(`${BASE}/api/harness/<slug>/supervisor-notes`));
    assert.ok(!out.includes('/inbox'), 'no reference to the retired inbox route');
    assert.ok(!out.includes('/outbox'), 'no reference to the retired outbox route');
    // parentSlug=null + no projects ⇒ no neighbor section.
    assert.ok(!out.includes('parent:'), 'no parent line when parentSlug is null');
    assert.ok(!out.includes('## Neighbor harnesses'), 'no neighbor section with no relations');
  });
});

test('never throws when fetch itself errors — degrades to the static sections', async () => {
  await withFetch(() => { throw new Error('network down'); }, async () => {
    const out = await fetchSubstrateContext({ selfSlug: 'shop', parentSlug: 'hive', operatorBase: BASE });
    assert.match(out, /## About Papercusp/);
    assert.match(out, /slug: `shop`/);
    assert.match(out, /parent: `hive`/);
  });
});

// ── Tier 2: neighbor view ────────────────────────────────────────────────────

test('builds the neighbor section with parent, children aggregate, and siblings', async () => {
  const projects = [
    { slug: 'shop', parent_slug: 'hive' },
    { slug: 'shop-api', parent_slug: 'shop' },   // child of self
    { slug: 'web', parent_slug: 'hive' },        // sibling (shares parent 'hive')
    { slug: 'hive', parent_slug: null },
  ];
  const router = (url: string) => {
    if (url.includes('/api/harness/projects')) return { projects };
    if (url.includes('/status')) return status({ passed: 2, todo: 1, total: 3 });
    return null;
  };
  await withFetch(router, async () => {
    const out = await fetchSubstrateContext({ selfSlug: 'shop', parentSlug: 'hive', operatorBase: BASE });
    assert.match(out, /## Neighbor harnesses/);
    assert.match(out, /### Parent: hive/);
    assert.match(out, /### Children \(1\)/);
    assert.ok(out.includes('shop-api'), 'child slug listed');
    assert.match(out, /### Siblings \(1/);
    assert.ok(out.includes('web'), 'sibling slug listed');
    assert.ok(out.includes('2 passed'), 'feature counts summarized');
  });
});
