/**
 * hive-coordination-model-2026-06-08 P-001 — the Hive blueprint's BOTH
 * decider "flag states" (the default `operator` + the swap-in `queen`
 * alternative) must each RESOLVE a non-empty persona that ENCOMPASSES the full
 * Queen role (D-007).
 *
 * Why this test: P-001 rewrote both hive personas to the two-plane coordination
 * model. This guards that rewrite two ways:
 *   1. both deciders are still declared live (the "both flag states" the plan
 *      asks to verify still assemble), and
 *   2. each decider's prompt file resolves via the REAL resolution path
 *      (`resolvePromptFile` with `blueprintId: 'coding'` — the same call
 *      `invoke.ts` makes) and carries every load-bearing role clause. A future
 *      edit that drops a clause, or removes a decider's prompt file so the role
 *      no longer assembles, fails here.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harnessRoot } from '@papercusp/harness/paths';
import { loadBuiltinBlueprint } from './blueprint/loader.js';
import { resolvePromptFiles } from './prompt-resolve.js';

/**
 * The load-bearing role clauses every hive decider persona must carry (D-007).
 * Case-insensitive substring needles — phrased to match BOTH operator.md and
 * queen.md without pinning exact wording, so a reword is fine but a DROPPED
 * facet is caught.
 */
const ROLE_CLAUSES: ReadonlyArray<readonly [label: string, needle: string]> = [
  ['two-plane invariant (never on the peer path)', 'agent-to-agent path'],
  ["steer, don't dispatch", "steer, don't dispatch"],
  ['steer on summaries', 'summaries'],
  ['co-location lever', 'co-locat'],
  ['account pool + auto-scale', 'account pool'],
  ['idea-queue triage', 'improvements:digest'],
  ['cross-Hive sovereignty', 'cross-hive sovereignty'],
  ['nested-Hive roll-up', 'roll-up'],
  ['trust the claim layer', 'claim layer'],
  ['declares its next wake', 'pot:declare-wake'],
  ['parallelize plan implementations via briefs', 'agent briefs'],
];

test('hive blueprint declares operator + mug as the two live deciders (both flag states)', () => {
  const { blueprint } = loadBuiltinBlueprint('coding');
  const deciders = [
    blueprint.spine.decider,
    ...(blueprint.spine.deciderAlternatives ?? []),
  ];
  assert.deepEqual([...deciders].sort(), ['mug', 'operator']);
});

// SAME complete mug persona.
for (const role of ['operator', 'mug'] as const) {
  test(`hive decider "${role}" assembles a complete Queen persona (D-007 full role)`, () => {
    // Post queen-split (P-007/P-008): the persona is COMPOSED from the shared base
    // prefix (queen.base.md) + the blueprint delta (coding/queen.md), exactly as the
    // live spawn assembles it via resolvePromptFiles. Check clauses across the union.
    const files = resolvePromptFiles(
      { harnessDir: harnessRoot(), phase: '', dept: '', blueprintId: 'coding' },
      role,
    );
    assert.ok(files.length > 0, `no prompt file resolved for hive role "${role}"`);
    const text = files.map((f) => readFileSync(f, 'utf8')).join('\n\n').toLowerCase();
    assert.ok(
      text.trim().length > 500,
      `persona for "${role}" is suspiciously short (${text.trim().length} chars)`,
    );
    for (const [label, needle] of ROLE_CLAUSES) {
      assert.ok(
        text.includes(needle.toLowerCase()),
        `hive "${role}" persona is missing the "${label}" clause (needle: ${JSON.stringify(needle)})`,
      );
    }
  });
}
