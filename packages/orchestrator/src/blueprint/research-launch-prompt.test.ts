/**
 * identities-v1 P-014 clause 4 / D-048 — the LAUNCH layer of the research identity.
 *
 * Clause 4 is "launch". D-048 measured it UNBUILT: nothing drives the launch
 * renderer for ANY real identity. `role-prompt-from-slug.test.ts` is synthetic
 * end-to-end (slug 'demo', role 'worker', a temp prompt file), and clause 8's
 * `research-identity-lexicon-render.test.ts` does NOT discharge this one — it
 * calls `buildPrompt` DIRECTLY with a temp promptFile, bypassing the three
 * things a launch actually does: blueprint-id lookup, prompt-file resolution
 * through the real library, and lexicon LOADING.
 *
 * WHICH renderer (D-048 §1, the D-042 layer question): TWO functions are named
 * `assembleRolePrompt`. The LAUNCH seam is the orchestrator's — the one imported
 * as `@papercusp/orchestrator/role-prompt` by `capability/launch-agent.ts` and
 * `fleet_registry/launch-on-plan.ts`. operator-core's `prompt-assembly.ts` one is
 * the CHAT surface. `agent-chats/index.ts` imports BOTH under disambiguating
 * aliases, which is the repo's own statement that they are distinct seams.
 *
 * The subject here is REAL, not a fixture: the project dir's
 * `.papercusp/blueprint.yaml` IS the shipped `blueprints/research/blueprint.yaml`,
 * and `harnessRoot()` supplies the real prompt library, so `promptFile` resolves
 * to the shipped `base/prompts/researcher.md`. No fixture prompt file is written —
 * `opts.projectDir` bypasses the registry lookup, which is what makes a
 * real-subject launch testable at all.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessPath } from '@papercusp/harness/paths';
import { assembleRolePrompt } from '../role-prompt-from-slug.js';

const HARNESS_DIR = harnessPath();
const RESEARCH_YAML = join(HARNESS_DIR, 'blueprints', 'research', 'blueprint.yaml');
const STEWARD_YAML = join(HARNESS_DIR, 'blueprints', 'research-steward', 'blueprint.yaml');
/**
 * The control blueprint. NOT `research-steward`: measured 2026-09-16, the steward
 * blueprint THROWS in `loadBlueprintFromFile` (it is abstract — no `workItem`), both
 * copied and in-place, and `loadHarnessLexicon` SWALLOWS that throw and returns
 * undefined. A steward-based control therefore renders no block for the instrument's
 * reason and can never distinguish anything. `work` is the only other blueprint
 * declaring a top-level `lexicon` and it loads cleanly (keys: workUnit, reviewGate).
 */
const CONTROL_YAML = join(HARNESS_DIR, 'blueprints', 'work', 'blueprint.yaml');
const REAL_RESEARCHER_PROMPT = join(HARNESS_DIR, 'blueprints', 'base', 'prompts', 'researcher.md');

/** The block `buildPrompt` emits when — and only when — a non-empty lexicon reaches it. */
const VOCAB_HEADING = "## This hive's vocabulary";

/**
 * Materialize a harness install whose canonical `.papercusp/blueprint.yaml` is a
 * VERBATIM copy of a shipped blueprint file. This mirrors what `harness:create`
 * writes, which is the reason a copy (rather than an `extends:` stub) is the
 * faithful subject.
 */
function installFrom(sourceYaml: string): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'p014-clause4-'));
  const stateDir = join(projectDir, '.papercusp');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'blueprint.yaml'), readFileSync(sourceYaml, 'utf8'));
  return projectDir;
}

test('P-014 clause 4: launching a researcher on the REAL research identity resolves the shipped prompt library', () => {
  assert.ok(existsSync(RESEARCH_YAML), `real research blueprint missing at ${RESEARCH_YAML}`);
  assert.ok(existsSync(REAL_RESEARCHER_PROMPT), `real researcher prompt missing at ${REAL_RESEARCHER_PROMPT}`);

  const projectDir = installFrom(RESEARCH_YAML);
  try {
    const { text, meta } = assembleRolePrompt({
      slug: 'p014-clause4-research',
      projectDir,
      role: 'researcher',
      mode: 'autonomous',
    });

    // The launch resolved through the harness's OWN blueprint, not the bare [base] chain.
    assert.equal(meta.blueprintId, 'research');

    // It read the SHIPPED prompt library, not a fixture — this is what makes the
    // subject real, and what clause 8's direct buildPrompt call never exercises.
    assert.equal(meta.harnessDir, HARNESS_DIR);
    assert.equal(meta.promptFile, REAL_RESEARCHER_PROMPT);

    // POSITIVE CONTROL. Every assertion about an ABSENT block below is worthless
    // if the prompt did not actually render, so prove it did: the real
    // researcher.md body and the runtime-context bullet must both be present.
    // Without this, a silently-empty prompt would satisfy the absence assertion.
    const realPromptBody = readFileSync(REAL_RESEARCHER_PROMPT, 'utf8').trim();
    const controlLine = realPromptBody.split('\n').find((l) => l.trim().length > 20);
    assert.ok(controlLine, 'could not derive a control line from the real researcher prompt');
    assert.ok(
      text.includes(controlLine.trim()),
      'the real researcher.md body did not reach the rendered prompt — the absence assertions below cannot be trusted',
    );
    assert.ok(text.includes('MODE=autonomous'), 'runtime-context bullet missing — prompt did not render');
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('P-014 clause 4 / D-048 §4: a launched research wearer gets NO vocabulary block — the lexicon is sited on an abstract SIBLING', () => {
  // D-048 §4 PREDICTED this and recorded it as a prediction, not a finding.
  // This test is its falsifier. `research/blueprint.yaml` declares no `lexicon`;
  // the one clause 8 verified lives on `research-steward`, and D-041 established
  // the two are SIBLINGS (both `extends: base`). Install/launch follows `extends`,
  // so a steward declaration never reaches a research install.
  const projectDir = installFrom(RESEARCH_YAML);
  try {
    const { text } = assembleRolePrompt({
      slug: 'p014-clause4-research-lexicon',
      projectDir,
      role: 'researcher',
      mode: 'autonomous',
    });
    assert.ok(
      !text.includes(VOCAB_HEADING),
      'REFUTES D-048 §4: a vocabulary block DID reach a launched research wearer. Correct the decision — do not silently replace it.',
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('P-014 clause 4 CONTROL: the launch path DOES render a vocabulary block when the installed blueprint declares one', () => {
  // The decisive control. Without it, "no block" is ambiguous between
  //   (a) the research identity declares no lexicon   [the D-048 §4 finding], and
  //   (b) the LAUNCH path never renders a lexicon at all [a different, larger defect].
  // Installing a LOADABLE lexicon-declaring blueprint through the identical seam
  // separates them. See CONTROL_YAML on why this is not research-steward.
  assert.ok(existsSync(CONTROL_YAML), `control blueprint missing at ${CONTROL_YAML}`);
  const projectDir = installFrom(CONTROL_YAML);
  try {
    const { text } = assembleRolePrompt({
      slug: 'p014-clause4-lexicon-control',
      projectDir,
      role: 'worker',
      mode: 'autonomous',
    });
    assert.ok(
      text.includes(VOCAB_HEADING),
      'CONTROL FAILED: even a lexicon-declaring blueprint rendered no vocabulary block, so the sibling test proves nothing about WHERE the lexicon is sited',
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
