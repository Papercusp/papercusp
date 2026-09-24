import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { builtinBlueprintPath, resolveBuiltinExtends, resolveBlueprintSource } from './loader.js';
import { compileStackSpecification, specificationPrompt } from './composition-compiler.js';
import type { StackDocument } from './render-stack.js';

test('neutral blueprint operation worker identity composes as a bounded domain layer', () => {
  const sourcePath = builtinBlueprintPath('blueprint-operation-worker');
  const source = parseYaml(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>;
  const resolved = resolveBlueprintSource(source, {
    resolve: resolveBuiltinExtends,
    sourcePath,
  });
  assert.equal(resolved.validation.ok, true, JSON.stringify(resolved.validation.errors));
  assert.deepEqual(source.slots, [{ slot: 'domain' }]);
  assert.deepEqual(source.grants, {});
  assert.equal(Object.hasOwn(source, 'workItem'), false);
  assert.equal(Object.hasOwn(source, 'spine'), false);

  const text = readFileSync(join(dirname(sourcePath), 'prompts/domain.md'), 'utf8');
  const identity: StackDocument = {
    id: 'blueprint-operation-worker', layer: 'domain', slot: 'domain', text,
  };
  const kernel: StackDocument = {
    id: 'operation-kernel', layer: 'kernel',
    text: '# Runtime controls\nOnly current host grants can authorize a tool.',
  };
  const specification = compileStackSpecification({
    source,
    sourcePath,
    resolve: resolveBuiltinExtends,
    stackDocuments: [identity, kernel],
  });
  const prompt = specificationPrompt(specification);
  assert.ok(prompt.includes('one accepted blueprint operation'));
  assert.ok(prompt.includes('Only current host grants can authorize a tool.'));
  assert.ok(prompt.indexOf('Only current host grants can authorize a tool.') >
    prompt.indexOf('one accepted blueprint operation'));
  assert.ok(!prompt.includes('PAPERCUSP-SU:'));
});
