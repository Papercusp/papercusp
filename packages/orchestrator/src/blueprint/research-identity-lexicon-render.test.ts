/**
 * identities-v1 P-014 clause 8 / D-037 — the RENDERED layer of the research
 * identity's vocabulary.
 *
 * P-042's sibling proof (research-identity-proof.test.ts) is STRUCTURAL: it
 * asserts the research blueprint's shape, spine and compiled artifact. D-037
 * ruled that extending those structural assertions does NOT discharge clause 8,
 * because a profession whose prompt still reads in coding nouns is a renamed
 * harness, not an identity — and nothing structural can see the rendered prose.
 *
 * The generic MECHANISM is already covered at prompt-build.test.ts (a lexicon
 * emits the block; absent/empty emits none) and is deliberately NOT rebuilt
 * here. The join this file adds is the one nothing tested: the RESEARCH IDENTITY
 * itself declaring a lexicon, at the field the runtime actually reads, and a
 * research wearer rendering those nouns.
 *
 * Why the assertions below are shaped against MEASURED nouns rather than a
 * hand-picked list: D-037 forbids inventing vocabulary. Each key is a noun that
 * was counted in the shared personas this identity inherits, so the test fails
 * if the personas start using an engineering noun the identity does not remap,
 * OR if the identity drops a remapping the personas still need.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { harnessPath } from '@papercusp/harness/paths';
import { buildPrompt } from '../prompt-build.js';

const HARNESS_DIR = harnessPath();
const IDENTITY_YAML = join(HARNESS_DIR, 'blueprints', 'research-steward', 'blueprint.yaml');

/**
 * The engineering nouns MEASURED (case-sensitive, word-boundary) in the shared
 * personas a research wearer renders, with the file each was counted in. A
 * case-INSENSITIVE census is not good enough to build this list from: it reports
 * "PR" inside "produce", which is exactly the false positive D-037 exists to stop.
 */
const MEASURED_PERSONA_NOUNS: ReadonlyArray<{ noun: string; personaFile: string }> = [
  { noun: 'test', personaFile: 'agent-base-preamble.md' },
  { noun: 'feature', personaFile: 'agent-base-preamble.md' },
  { noun: 'bug', personaFile: 'agent-base-preamble.md' },
  { noun: 'ship', personaFile: 'agent-base-preamble.md' },
  { noun: 'deploy', personaFile: 'agent-base-preamble.md' },
  { noun: 'code', personaFile: 'worker.base.md' },
  { noun: 'repo', personaFile: 'researcher.md' },
];

function personaText(file: string): string {
  return readFileSync(join(HARNESS_DIR, 'blueprints', 'base', 'prompts', file), 'utf8');
}

/** A minimal on-disk harness/state/project triple — buildPrompt reads real paths. */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'research-lexicon-'));
  const harnessDir = join(root, 'harness');
  const stateDir = join(root, 'state');
  const projectDir = join(root, 'project');
  for (const dir of [harnessDir, stateDir, projectDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(harnessDir, 'researcher.md'), '# RESEARCHER');
  return {
    root,
    base: {
      role: 'researcher' as const,
      promptFile: join(harnessDir, 'researcher.md'),
      promptOverride: '',
      stateDir,
      harnessDir,
      projectDir,
      cwdOverride: '',
      featureId: null,
      runId: 'r-lexicon-1',
      extras: [] as string[],
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('P-014 clause 8 — the research IDENTITY declares a lexicon at the field the runtime reads', () => {
  const doc = parseYaml(readFileSync(IDENTITY_YAML, 'utf8')) as Record<string, unknown>;

  // TOP-LEVEL, not nested. This placement is load-bearing, not cosmetic:
  // loadHarnessLexicon (effective-config.ts) reads `blueprint.lexicon` off the
  // materialized blueprint.yaml, merge-rules merges `lexicon` as a top-level key,
  // and composition-compiler exposes that same object as `configuration.lexicon`
  // (its `configuration` IS the loaded blueprint). One field, three names — so a
  // lexicon nested anywhere else would compile and simply never reach a prompt.
  const lexicon = doc.lexicon as Record<string, string> | undefined;
  assert.ok(lexicon, `${IDENTITY_YAML} declares no top-level lexicon — clause 8 is unrendered`);
  assert.ok(Object.keys(lexicon).length > 0, 'an empty lexicon renders no block at all');

  // It is the IDENTITY layer that carries the profession's nouns (P-025), so this
  // file must remain an abstract layer rather than becoming a second runnable hive.
  assert.equal(doc.id, 'research-steward');
  assert.equal(doc.extends, 'identity-root');
});

test('P-014 clause 8 — a research wearer RENDERS the profession nouns, not the coding ones', () => {
  const doc = parseYaml(readFileSync(IDENTITY_YAML, 'utf8')) as { lexicon: Record<string, string> };
  const fx = makeFixture();
  try {
    const rendered = buildPrompt({ ...fx.base, lexicon: doc.lexicon });

    assert.match(rendered, /## This hive's vocabulary/);

    // Every declared pair reaches the prose in the renderer's own phrasing.
    for (const [concept, word] of Object.entries(doc.lexicon)) {
      assert.match(
        rendered,
        new RegExp(`a "${concept}" is called a "${word}"`),
        `lexicon pair ${concept} -> ${word} is declared but never rendered`,
      );
    }

    // The substantive claim: each engineering noun the inherited personas actually
    // use is remapped to something OTHER than itself. A pair that renames a noun to
    // itself would satisfy the block above while changing nothing a wearer reads.
    for (const { noun } of MEASURED_PERSONA_NOUNS) {
      const mapped = doc.lexicon[noun];
      assert.ok(mapped, `persona noun "${noun}" is rendered to a research wearer but never remapped`);
      assert.notEqual(mapped, noun, `"${noun}" is mapped to itself — that renames nothing`);
      assert.match(rendered, new RegExp(`a "${noun}" is called a "${mapped}"`));
    }
  } finally {
    fx.cleanup();
  }
});

test('P-014 clause 8 — the remapped nouns are the ones the inherited personas really use', () => {
  // Guards the lexicon against drifting into decoration. If a persona stops using
  // a noun, this fails and the entry should go; if a persona gains an engineering
  // noun, the previous test fails until it is remapped. Word-boundary and
  // CASE-SENSITIVE on purpose: a case-insensitive census matches "PR" in "produce".
  for (const { noun, personaFile } of MEASURED_PERSONA_NOUNS) {
    const text = personaText(personaFile);
    assert.match(
      text,
      new RegExp(`\\b${noun}`),
      `${personaFile} no longer uses "${noun}" — the lexicon entry is now decoration`,
    );
  }

  // The nouns deliberately ABSENT from these personas stay absent from the lexicon:
  // remapping a noun nobody renders is invented vocabulary (D-037).
  const doc = parseYaml(readFileSync(IDENTITY_YAML, 'utf8')) as { lexicon: Record<string, string> };
  const personaCorpus = [...new Set(MEASURED_PERSONA_NOUNS.map((n) => n.personaFile))]
    .map(personaText)
    .join('\n');
  for (const absent of ['PR', 'pull request', 'commit', 'branch', 'merge']) {
    if (new RegExp(`\\b${absent}\\b`).test(personaCorpus)) continue;
    assert.ok(
      !Object.hasOwn(doc.lexicon, absent),
      `lexicon remaps "${absent}", which these personas never render`,
    );
  }
});
