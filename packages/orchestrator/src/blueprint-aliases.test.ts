/**
 * blueprint-aliases.test.ts — canonicalBlueprintId, the 2026-06-18 rename safety-net for
 * OLD blueprint ids encountered at runtime (stale blueprint.yaml `extends:`, the PG cache,
 * federated refs). Pins the two transition aliases AND the load-bearing reuse invariant the
 * module doc calls out: there is deliberately NO `coding → coding-factory` alias, because
 * `coding` was REUSED to name the hive blueprint — so a bare `coding` must resolve to ITSELF
 * (the new coding/hive), never the old strict spine. A regression that adds a coding alias,
 * or drops hive→coding / generic-hive→work, silently mis-resolves blueprint dirs + personas.
 *
 * Borrowable/submodule unit test (orchestrator, node env) — tab-neutral, genuine.
 * Run: cd libs/papercusp/packages/orchestrator && npx vitest run src/blueprint-aliases.test.ts
 */
import { describe, expect, it } from 'vitest';
import { canonicalBlueprintId, BLUEPRINT_ID_ALIASES } from './blueprint-aliases';

describe('canonicalBlueprintId', () => {
  it('maps the renamed legacy ids', () => {
    expect(canonicalBlueprintId('hive')).toBe('coding');
    expect(canonicalBlueprintId('generic-hive')).toBe('work');
  });

  it('is identity for ids that were not aliased', () => {
    expect(canonicalBlueprintId('research')).toBe('research');
    expect(canonicalBlueprintId('coding-factory')).toBe('coding-factory');
    expect(canonicalBlueprintId('migration')).toBe('migration');
  });

  it('CRITICAL: `coding` resolves to itself, NOT coding-factory (the id was reused for the hive)', () => {
    expect(canonicalBlueprintId('coding')).toBe('coding');
    expect(BLUEPRINT_ID_ALIASES).not.toHaveProperty('coding');
  });

  it('only the two documented aliases exist', () => {
    expect(BLUEPRINT_ID_ALIASES).toEqual({ hive: 'coding', 'generic-hive': 'work' });
  });
});
