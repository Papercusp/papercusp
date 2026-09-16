/**
 * identities-v1 P-014 clause 5 — "scoped toolset negative-verified".
 *
 * WHY THIS FILE EXISTS, given research-identity-proof.test.ts already inspects
 * dependencies.tools: that test asserts only `dependencies.includes('…')`, which
 * is MONOTONE — adding tools can never break it. It would pass unchanged if the
 * research identity were granted every engineering tool in the catalog. Clause 5
 * asks for the NEGATIVE, and a positive membership check cannot express it.
 *
 * The assertions below are therefore chosen to FAIL ON OVER-GRANTING:
 *   1. exact set equality on the runnable wearer's toolset (not `includes`);
 *   2. absence of engineering authority, measured against the real `coding`
 *      blueprint rather than an invented list (D-037 forbids inventing one),
 *      and CALIBRATED so the absence check cannot pass vacuously;
 *   3. the abstract identity layer contributes no tools of its own.
 *
 * (2) and (3) together bound the composition: the layer contributes the empty
 * set and the wearer contributes exactly three, so no composed research wearer
 * can hold engineering authority without failing one of these tests.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { builtinBlueprintPath, loadBuiltinBlueprint } from './loader.js';

/**
 * The research profession's ENTIRE agent-tool surface, per
 * blueprints/research/blueprint.yaml: "findings ride the work-item".
 * Kept as a literal so that widening the blueprint must be a deliberate edit
 * HERE too — that is the point of the test, not an inconvenience.
 */
const RESEARCH_SCOPED_TOOLSET = ['features:get', 'plans:items', 'work_items:list'];

/**
 * High-authority engineering tools that must never reach a research steward.
 * Each is asserted to be genuinely present in the `coding` blueprint below, so
 * a rename in the catalog turns this into a failure rather than a silent pass.
 */
const ENGINEERING_AUTHORITY_SAMPLE = [
  'deploy:harness',
  'fleet:drain',
  'harness:create',
  'scheduler:set_claim_spec',
];

const toolsOf = (name: string): string[] => {
  const loaded = loadBuiltinBlueprint(name);
  assert.equal(loaded.validation.ok, true, JSON.stringify(loaded.validation.errors));
  return loaded.blueprint.dependencies?.tools ?? [];
};

test('P-014 clause 5 — the research wearer holds EXACTLY its declared toolset, so over-granting fails', () => {
  const tools = toolsOf('research');

  // Set equality, deliberately not `includes`: this is the assertion that a
  // monotone membership check cannot make. One extra tool fails it.
  assert.deepEqual(
    [...tools].sort(),
    [...RESEARCH_SCOPED_TOOLSET].sort(),
    'the research identity gained or lost a tool; clause 5 requires the scope to be exact',
  );

  // The scope is a toolset AND a plugin surface; an empty plugin list is part
  // of the claim, not an incidental detail.
  const loaded = loadBuiltinBlueprint('research');
  assert.deepEqual(loaded.blueprint.dependencies?.plugins ?? [], [], 'research grants no plugin surface');
});

test('P-014 clause 5 — engineering authority is ABSENT from research, measured against the coding blueprint', () => {
  const research = toolsOf('research');
  const coding = toolsOf('coding');

  const engineeringOnly = coding.filter((tool) => !research.includes(tool));

  // CALIBRATION — without this the absence assertion below is vacuous: if the
  // contrast set were empty, "research holds none of it" would pass while
  // proving nothing. Same discipline as a mutation probe's positive control.
  assert.ok(
    engineeringOnly.length > 0,
    'contrast set is empty — the absence check below would pass vacuously',
  );

  for (const tool of ENGINEERING_AUTHORITY_SAMPLE) {
    assert.ok(
      coding.includes(tool),
      `${tool} is no longer declared by the coding blueprint; re-measure the contrast set instead of deleting this case`,
    );
    assert.ok(
      engineeringOnly.includes(tool),
      `${tool} must be engineering-only for this test to mean anything`,
    );
  }

  const leaked = engineeringOnly.filter((tool) => research.includes(tool));
  assert.deepEqual(leaked, [], 'engineering authority leaked into the research identity');
});

test('P-014 clause 5 — the abstract identity layer smuggles no tools of its own', () => {
  const raw = parseYaml(
    readFileSync(builtinBlueprintPath('research-steward'), 'utf8'),
  ) as { dependencies?: { tools?: string[]; plugins?: string[] } };

  // research-steward is a LAYER (slots: domain), never runnable alone. Authority
  // belongs to the runnable wearer; a layer that declared tools would widen every
  // blueprint it composes into, invisibly to the wearer's own scope test above.
  assert.deepEqual(raw.dependencies?.tools ?? [], [], 'an abstract identity layer must declare no tools');
  assert.deepEqual(raw.dependencies?.plugins ?? [], [], 'an abstract identity layer must declare no plugins');
});
