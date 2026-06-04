/**
 * Shared instantiation primitive — resolve+validate (with the composed resolver)
 * + the thin-child shape + canonical YAML, mirroring harness:create.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import {
  makeChildBlueprint,
  serializeBlueprint,
  resolveAndValidateBlueprint,
} from './instantiate.js';
import { makeComposedResolveExtends } from './resolve-extends-composed.js';

test('makeChildBlueprint — the thin { id, extends } harness:create writes', () => {
  assert.deepEqual(makeChildBlueprint('myproj', 'coding'), { id: 'myproj', extends: 'coding' });
});

test('serializeBlueprint round-trips the thin child through YAML', () => {
  const child = makeChildBlueprint('myproj', 'coding');
  const yaml = serializeBlueprint(child);
  assert.deepEqual(parseYaml(yaml), { id: 'myproj', extends: 'coding' });
});

test('resolveAndValidateBlueprint — a thin child extending built-in `coding` resolves + validates ok', () => {
  const child = makeChildBlueprint('myproj', 'coding');
  const res = resolveAndValidateBlueprint(child, makeComposedResolveExtends());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.blueprint?.id, 'myproj');
  // inherited shape proves the merge ran:
  assert.equal(res.blueprint?.knobs.harnessKind, 'coding');
  assert.equal(res.blueprint?.planner.kind, 'features-import');
});

test('resolveAndValidateBlueprint — extends an unknown blueprint → parseError, not throw', () => {
  const child = makeChildBlueprint('myproj', 'no-such-blueprint');
  const res = resolveAndValidateBlueprint(child, makeComposedResolveExtends());
  assert.equal(res.ok, false);
  assert.match(res.parseError ?? '', /extends resolution failed/);
});

test('resolveAndValidateBlueprint — a structurally invalid blueprint → parseError', () => {
  // No workItem/spine and no extends → schema parse fails.
  const res = resolveAndValidateBlueprint({ id: 'bare' }, makeComposedResolveExtends());
  assert.equal(res.ok, false);
  assert.match(res.parseError ?? '', /schema validation failed/);
});
