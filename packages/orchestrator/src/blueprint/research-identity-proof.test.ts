/**
 * identities-v1 P-042 / D-031 — local non-engineering identity proof.
 *
 * This is deliberately a real acceptance slice over the existing research
 * blueprint, not a second orchestration path: the same loader, compiler,
 * sealed stack renderer, and acknowledged activation state machine used by
 * coding are exercised with research's task vocabulary and repo-less shape.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { harnessPath } from '@papercusp/harness/paths';
import { builtinBlueprintPath, loadBuiltinBlueprint, resolveBuiltinExtends, resolveLayers } from './loader.js';
import { deriveNext, type ParsedDecisionLike } from './derive-next.js';
import {
  compileAgentSpecification,
  compileStackSpecification,
  specificationPrompt,
} from './composition-compiler.js';
import {
  acknowledgeStackMutationActivation,
  applyStackMutation,
  bindingRefs,
  emptyStackBinding,
} from './stack-mutation.js';
import type { StackDocument } from './render-stack.js';

const HARNESS_DIR = harnessPath();
const RESEARCH_TASK = 'R-LOCAL-001';
const decision = (verb: string, arg: string | null = null): ParsedDecisionLike => ({ verb, arg, n: null });

test('P-042 research identity uses the common engine with non-engineering vocabulary and a real task outcome', () => {
  const loaded = loadBuiltinBlueprint('research');
  assert.equal(loaded.validation.ok, true, JSON.stringify(loaded.validation.errors));
  assert.equal(loaded.blueprint.workItem.kind, 'task');
  assert.equal(loaded.blueprint.knobs.requiresRepo, false);
  assert.ok(loaded.blueprint.roles.some((role) => role.id === 'researcher'));
  assert.ok(Object.hasOwn(loaded.blueprint.spine.edges ?? {}, 'NEXT_RESEARCHER'));
  assert.ok(!Object.hasOwn(loaded.blueprint.spine.edges ?? {}, 'NEXT_WORKER'));

  const next = deriveNext(loaded.blueprint.spine, decision('NEXT_RESEARCHER', RESEARCH_TASK), RESEARCH_TASK);
  assert.deepEqual(next, {
    kind: 'dispatch',
    role: 'researcher',
    feature: RESEARCH_TASK,
    extras: [`FEATURE_ID=${RESEARCH_TASK}`],
  });
  assert.deepEqual(deriveNext(loaded.blueprint.spine, decision('DONE'), RESEARCH_TASK), {
    kind: 'terminal',
    outcome: 'done',
  });

  const dependencies = loaded.blueprint.dependencies?.tools ?? [];
  assert.ok(dependencies.includes('work_items:list'), 'research keeps work-item output as its deliverable');
  assert.ok(dependencies.includes('plans:items'), 'research keeps plan/control visibility');
});

test('P-042 compiles addressed research guidance through the immutable artifact and keeps the prompt bounded', () => {
  const loaded = loadBuiltinBlueprint('research');
  const specification = compileAgentSpecification({
    source: loaded,
    harnessDir: HARNESS_DIR,
    role: 'researcher',
    addressedDocuments: {
      revision: 'guide-v1',
      parts: [
        {
          partKey: 'local-question',
          targetSection: 'Task brief',
          body: 'Answer the local question with sourced findings and explicit uncertainty.',
        },
      ],
    },
    settings: [
      {
        ref: 'activation.delivery',
        revision: 'state-1',
        value: { delivery: 'soft', carry: 'warm', privateMemory: 'preserve' },
      },
    ],
  });

  const prompt = specificationPrompt(specification);
  assert.ok(prompt.includes('# Researcher'));
  assert.ok(prompt.includes('Task brief'));
  assert.ok(prompt.includes('sourced findings'));
  assert.ok(prompt.includes('FEATURE_ID'));
  assert.ok(!prompt.includes('NEXT_WORKER'));
  assert.ok(!/skip (?:the )?work-items|bypass (?:the )?file locks|ignore any claim conflict/i.test(prompt));
  assert.ok(prompt.length < 256 * 1024, `prompt is unexpectedly large: ${prompt.length}`);
  assert.ok(specification.inputs.some((input) => input.kind === 'addressed-document'));
  assert.ok(specification.inputs.some((input) => input.kind === 'setting' && input.ref === 'activation.delivery'));
});

test('P-042 activation proof preserves actor/session idempotency and explicit carry boundaries', () => {
  const loaded = loadBuiltinBlueprint('research');
  const identityPath = builtinBlueprintPath('research-steward');
  const identityRaw = parseYaml(readFileSync(identityPath, 'utf8')) as Record<string, unknown>;
  const identityResolved = resolveLayers(identityRaw, resolveBuiltinExtends, identityPath).merged as Record<string, unknown>;
  assert.equal(identityResolved.id, 'research-steward');
  assert.deepEqual(identityResolved.slots, [{ slot: 'domain' }]);
  const identityText = readFileSync(join(dirname(identityPath), 'prompts/domain.md'), 'utf8');
  assert.ok(!/\b(?:git|worker|deploy|merge)\b/i.test(identityText), 'the authored identity stays non-engineering');
  const identity: StackDocument = {
    id: 'research-steward',
    layer: 'domain',
    slot: 'domain',
    text: identityText,
  };
  const kernel: StackDocument = {
    id: 'research-kernel',
    layer: 'kernel',
    text: '# Core controls\n\nWork-items, claims, and locks remain enforced by the runtime.',
  };
  const specification = compileStackSpecification({
    source: loaded,
    harnessDir: HARNESS_DIR,
    stackDocuments: [identity, kernel],
    settings: [{ ref: 'actor', revision: '1', value: { actorId: 'researcher-a', sessionId: 'session-a' } }],
  });
  const revision = {
    specificationRevision: specification.specificationRevision,
    stateRevision: 'state-1',
  };
  const applied = applyStackMutation({
    binding: emptyStackBinding(),
    op: 'attach',
    layer: { slot: 'domain', id: identity.id },
    documents: () => [identity, kernel],
    activation: {
      ...revision,
      idempotencyKey: `session-activation:session-a:${revision.specificationRevision}:state-1`,
      context: { delivery: 'fresh-context', carry: 'cold', privateMemory: 'reset' },
    },
  });

  assert.deepEqual(bindingRefs(applied.binding), ['domain:research-steward']);
  assert.equal(applied.activation?.status, 'prepared');
  assert.equal(applied.activation?.context.delivery, 'fresh-context');
  assert.equal(applied.activation?.context.carry, 'cold');
  assert.equal(applied.activation?.context.privateMemory, 'reset');
  assert.equal(applied.activation?.idempotencyKey.startsWith('session-activation:session-a:'), true);
  // Domain changes deliberately relaunch with carry: the old context receives
  // only a control notice, never the new identity text, before the host
  // acknowledges the prepared revision and starts the fresh context.
  assert.ok(applied.injection?.includes('relaunch-with-carry'));
  assert.ok(!applied.injection?.includes(identity.text));

  const acknowledged = acknowledgeStackMutationActivation(applied.activation!, revision);
  assert.equal(acknowledged.status, 'applied');
  assert.equal(acknowledged.prepared, null);
  assert.deepEqual(acknowledged.applied, revision);
});
