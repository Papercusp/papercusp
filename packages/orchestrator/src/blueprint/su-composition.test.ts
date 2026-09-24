import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { builtinBlueprintPath, resolveBlueprintSource, resolveBuiltinExtends } from './loader.js';

const here = dirname(fileURLToPath(import.meta.url));

test('P-003 named SU composition and planner specialist reuse the identity graph without granting an assignment', () => {
  const suPath = builtinBlueprintPath('su');
  const suRaw = parseYaml(readFileSync(suPath, 'utf8')) as Record<string, unknown>;
  const su = resolveBlueprintSource(suRaw, { sourcePath: suPath });
  assert.equal(su.validation.ok, true, JSON.stringify(su.validation.errors));
  assert.equal(su.source.kind, 'identity');
  assert.deepEqual(su.layers.filter((layer) => layer.slots.length).map((layer) => [layer.id, layer.slots]), [
    ['papercusp-engineer', ['domain']],
    ['su-collaborator', ['collaboration-stance']],
    ['su.practice', ['practice']],
  ]);
  assert.ok(!('workItem' in suRaw) && !('spine' in suRaw) && !('fleet' in suRaw),
    'the identity package does not author a workflow or fleet assignment');
  assert.deepEqual((suRaw.contributions as Array<{ id: string; producerRef: string }>).map((item) => [item.id, item.producerRef]), [
    ['current-mode-state', 'modes/store:agent_modes'],
    ['current-assignment', 'coord:presence'],
  ]);
  const selected = resolveBlueprintSource({
    id: 'selected-su-planner', extends: ['su', 'su.specialist-planner'], slots: [],
  }, { resolve: resolveBuiltinExtends });
  assert.equal(selected.validation.ok, true, JSON.stringify(selected.validation.errors));
  assert.deepEqual(selected.layers.filter((layer) => layer.slots.includes('practice')).map((layer) => layer.id),
    ['su.practice', 'su.specialist-planner']);
  assert.ok(selected.layers.some((layer) => layer.id === 'papercusp-engineer'));
  assert.ok(selected.layers.some((layer) => layer.id === 'su-collaborator'));
  const plannerPrompt = readFileSync(join(dirname(builtinBlueprintPath('su.specialist-planner')), 'prompts', 'practice.md'), 'utf8');
  const currentRoleAddendum = readFileSync(join(here, '../../../../../..', 'apps/operator/prompts/su-role-planner.addendum.md'), 'utf8');
  assert.equal(plannerPrompt, currentRoleAddendum,
    'P-009 can retire the role addendum after its identity consumer is live; this parity guard prevents interim drift');
});
