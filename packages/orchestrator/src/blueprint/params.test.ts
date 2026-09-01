/**
 * params.ts — the schema-driven per-harness config layer (P-007). Proves the
 * read/write/validate keyed by a blueprint's declared `params`:
 *   - dot-path get/set (incl. delete-prune on reset),
 *   - per-type validation + coercion (number range / boolean / enum / string),
 *   - the UI-facing param views (override vs default; secrets excluded),
 *   - patch validation (unknown-key + secret rejection) + apply (default → drop),
 *   - an integration check against the REAL coding blueprint params (config.json keys).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ParamSpec, BlueprintParams } from './schema.js';
import {
  getParamPath,
  setParamPath,
  validateParamValue,
  resolveParamViews,
  validateParamPatch,
  applyParamPatch,
} from './params.js';
import { loadBuiltinBlueprint } from './loader.js';

const num = (extra: Partial<ParamSpec> = {}): ParamSpec => ({ label: 'N', type: 'number', description: '', secret: false, ...extra });
const bool = (extra: Partial<ParamSpec> = {}): ParamSpec => ({ label: 'B', type: 'boolean', description: '', secret: false, ...extra });
const str = (extra: Partial<ParamSpec> = {}): ParamSpec => ({ label: 'S', type: 'string', description: '', secret: false, ...extra });

test('getParamPath reads a nested dot-path; missing segment → undefined', () => {
  const cfg = { parallelWorkers: { max: 4 }, debugger: { threshold: 5 } };
  assert.equal(getParamPath(cfg, 'parallelWorkers.max'), 4);
  assert.equal(getParamPath(cfg, 'debugger.threshold'), 5);
  assert.equal(getParamPath(cfg, 'parallelWorkers.missing'), undefined);
  assert.equal(getParamPath(cfg, 'nope.nope'), undefined);
  assert.equal(getParamPath(undefined, 'a.b'), undefined);
});

test('setParamPath sets a deep path (creating intermediates) without mutating the input', () => {
  const cfg = { a: { keep: 1 } };
  const out = setParamPath(cfg, 'a.b.c', 9);
  assert.deepEqual(out, { a: { keep: 1, b: { c: 9 } } });
  assert.deepEqual(cfg, { a: { keep: 1 } }, 'input not mutated');
});

test('setParamPath with undefined DELETES the leaf and prunes now-empty parents', () => {
  const cfg = { parallelWorkers: { useChunkLoop: true } };
  const out = setParamPath(cfg, 'parallelWorkers.useChunkLoop', undefined);
  assert.deepEqual(out, {}, 'empty parent pruned');
  // a parent that still has other keys is NOT pruned
  const cfg2 = { parallelWorkers: { max: 4, useChunkLoop: true } };
  const out2 = setParamPath(cfg2, 'parallelWorkers.useChunkLoop', undefined);
  assert.deepEqual(out2, { parallelWorkers: { max: 4 } });
});

test('validateParamValue: number range, coercion, and rejection', () => {
  const spec = num({ min: 1, max: 64 });
  assert.deepEqual(validateParamValue(spec, 4), { ok: true, value: 4 });
  assert.deepEqual(validateParamValue(spec, '8'), { ok: true, value: 8 }, 'numeric string coerced');
  assert.equal(validateParamValue(spec, 0).ok, false, 'below min rejected');
  assert.equal(validateParamValue(spec, 100).ok, false, 'above max rejected');
  assert.equal(validateParamValue(spec, 'abc').ok, false, 'non-number rejected');
});

test('validateParamValue: boolean coercion + enum membership + string', () => {
  assert.deepEqual(validateParamValue(bool(), true), { ok: true, value: true });
  assert.deepEqual(validateParamValue(bool(), 'false'), { ok: true, value: false });
  assert.equal(validateParamValue(bool(), 'maybe').ok, false);

  const en: ParamSpec = { label: 'E', type: 'enum', description: '', secret: false, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] };
  assert.deepEqual(validateParamValue(en, 'a'), { ok: true, value: 'a' });
  assert.equal(validateParamValue(en, 'z').ok, false, 'out-of-set rejected');

  assert.deepEqual(validateParamValue(str(), 'pnpm typecheck'), { ok: true, value: 'pnpm typecheck' });
  assert.equal(validateParamValue(str(), 7).ok, false);
});

test('resolveParamViews: override value vs default; secrets carry no value', () => {
  const params: BlueprintParams = {
    'parallelWorkers.max': num({ default: 1 }),
    'debugger.threshold': num({ default: 3 }),
    'aiBackend.default.agentCmd': str({ secret: true }),
  };
  const views = resolveParamViews(params, { parallelWorkers: { max: 8 } });
  const byKey = Object.fromEntries(views.map((v) => [v.key, v]));
  assert.equal(byKey['parallelWorkers.max'].value, 8);
  assert.equal(byKey['parallelWorkers.max'].overridden, true);
  assert.equal(byKey['debugger.threshold'].value, 3, 'falls back to default');
  assert.equal(byKey['debugger.threshold'].overridden, false);
  assert.equal(byKey['aiBackend.default.agentCmd'].value, undefined, 'secret carries no value');
});

test('validateParamPatch: rejects unknown keys + secret params; coerces valid', () => {
  const params: BlueprintParams = {
    'parallelWorkers.max': num({ min: 1, max: 64 }),
    'parallelWorkers.useChunkLoop': bool(),
    'aiBackend.default.agentCmd': str({ secret: true }),
  };
  const res = validateParamPatch(params, {
    'parallelWorkers.max': '12', // valid → coerced to 12
    'parallelWorkers.useChunkLoop': false,
    'aiBackend.default.agentCmd': 'omp -p', // secret → rejected
    'evil.injection': 'rm -rf', // unknown → rejected
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.unknownKeys, ['evil.injection']);
  assert.ok(res.errors.some((e) => e.key === 'aiBackend.default.agentCmd'));
  assert.equal(res.patch['parallelWorkers.max'], 12, 'numeric string coerced');
  assert.equal(res.patch['parallelWorkers.useChunkLoop'], false);
  assert.ok(!('evil.injection' in res.patch) && !('aiBackend.default.agentCmd' in res.patch));
});

test('applyParamPatch: writes overrides; a value equal to the default is dropped', () => {
  const params: BlueprintParams = {
    'parallelWorkers.max': num({ default: 1 }),
    'debugger.threshold': num({ default: 3 }),
  };
  // start from a config that overrides max; set threshold to its default → dropped
  const cfg = { parallelWorkers: { max: 8 }, debugger: { threshold: 5 } };
  const out = applyParamPatch(cfg, params, { 'parallelWorkers.max': 16, 'debugger.threshold': 3 });
  assert.equal(getParamPath(out, 'parallelWorkers.max'), 16, 'non-default override written');
  assert.equal(getParamPath(out, 'debugger.threshold'), undefined, 'default value dropped (override removed)');
});

test('integration: the real coding blueprint params resolve over a config.json (P-006 ⨯ P-007)', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('coding-factory');
  // Stale chunk-loop keys remain readable in old config files but are no longer
  // declared, rendered, or patchable through the blueprint parameter surface.
  const cfg = {
    parallelWorkers: { max: 4, useChunkLoop: true, workingStateCheck: 'pnpm typecheck' },
    debugger: { threshold: 5 },
  };
  const views = resolveParamViews(bp.params, cfg);
  const byKey = Object.fromEntries(views.map((v) => [v.key, v]));
  // base universal + coding-specific params all present + reading the right config paths
  assert.equal(byKey['parallelWorkers.max'].value, 4);
  assert.equal(byKey['debugger.threshold'].value, 5);
  assert.equal(byKey['parallelWorkers.useChunkLoop'], undefined);
  assert.equal(byKey['parallelWorkers.workingStateCheck'], undefined);
  // a patch validates + applies against the real declared params
  const res = validateParamPatch(bp.params, { 'parallelWorkers.max': '6', 'debugger.threshold': 2 });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const next = applyParamPatch(cfg, bp.params, res.patch);
  assert.equal(getParamPath(next, 'parallelWorkers.max'), 6);
  assert.equal(getParamPath(next, 'debugger.threshold'), 2);
});
