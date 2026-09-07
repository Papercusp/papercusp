import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { layerContentHash, resolveBlueprint, resolveBlueprintSource } from './loader.js';

const identity = { id: 'author-test', slots: [{ slot: 'practice' }] };
const fixtureDirs: string[] = [];
afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function parents(documents: Record<string, Record<string, unknown>>) {
  const root = mkdtempSync(join(tmpdir(), 'identity-sources-'));
  fixtureDirs.push(root);
  for (const [id, document] of Object.entries(documents)) {
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, 'blueprint.yaml'), stringify(document));
  }
  return (id: string) => id in documents ? join(root, id, 'blueprint.yaml') : null;
}
const errorCodes = (raw: Record<string, unknown>) => resolveBlueprintSource(raw).validation.errors.map(e => e.code);

describe('blueprint source authoring', () => {
  it('validates an abstract identity without inventing a runnable configuration', () => {
    const result = resolveBlueprintSource(identity);
    expect(result.validation.ok).toBe(true);
    expect(result.source).toEqual({ kind: 'identity', document: identity });
    expect(result.source.document).toBe(identity);
    expect(result.merged).not.toHaveProperty('workItem');
    expect(result.merged).not.toHaveProperty('spine');
    expect(() => resolveBlueprint(identity)).toThrow();
  });

  it('preserves a runnable root as a blueprint when it inherits identity slots', () => {
    const resolve = parents({ practice: { ...identity, id: 'practice' } });
    const root = { id: 'runnable', extends: 'practice', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } };
    const result = resolveBlueprintSource(root, { resolve });
    expect(result.validation.ok).toBe(true);
    expect(result.source.kind).toBe('blueprint');
    expect(result.merged.slots).toEqual(identity.slots);
    expect(resolveBlueprint(root, { resolve }).sourceKind).toBe('blueprint');
  });

  it.each([
    [{ slots: [{ slot: 'unknown-slot' }] }, 'slot-unknown'],
    [{ slots: [{ slot: 'kernel' }] }, 'slot-reserved-layer'],
    [{ slots: [{ slot: 'practice' }, { slot: 'practice' }] }, 'slot-duplicate'],
    [{ slots: [{ slot: 'domain', cardinality: 'additive' }] }, 'slot-cardinality-mismatch'],
    [{ bundles: [{ kind: 'recipe', ref: 'one' }, { kind: 'recipe', ref: 'one' }] }, 'bundle-duplicate'],
    [{ grants: { requires: ['email.send'] } }, 'grant-class-ref-invalid'],
    [{ slots: [{ slot: 'autonomy' }], knobs: { maxCostUsd: 100 } }, 'authority-on-mode-axis'],
  ])('rejects invalid source declarations %j', (override, code) => {
    expect(errorCodes({ ...identity, ...override })).toContain(code);
  });

  it('rejects unknown contribution fields instead of stripping them', () => {
    expect(() => resolveBlueprintSource({ ...identity, permissions: ['*'] })).toThrow();
  });

  it('checks an ancestor declaration even when a later overlay repairs its value', () => {
    const resolve = parents({ parent: { id: 'parent', slots: [{ slot: 'domain', cardinality: 'additive' }] } });
    const result = resolveBlueprintSource({ id: 'child', extends: 'parent', slots: [{ slot: 'domain', cardinality: 'exclusive' }] }, { resolve });
    expect(result.validation.errors.some(e => e.code === 'slot-cardinality-mismatch' && e.message.includes('parent'))).toBe(true);
  });

  it('shares the exact bundle conflict guard for abstract source stacks', () => {
    const resolve = parents({
      a: { id: 'a', slots: [], bundles: [{ kind: 'recipe', ref: 'shared', version: '1.0.0' }] },
      b: { id: 'b', slots: [], bundles: [{ kind: 'recipe', ref: 'shared', version: '2.0.0' }] },
    });
    const result = resolveBlueprintSource({ ...identity, extends: ['a', 'b'] }, { resolve });
    expect(result.validation.errors.map(e => e.code)).toContain('bundle-version-conflict');
  });

  it('checks attestations on sources without requiring runnable fields', () => {
    const signed = { ...identity, attestation: { contentHash: layerContentHash(identity), signedBy: 'publisher' } };
    expect(resolveBlueprintSource(signed).validation.ok).toBe(true);
    expect(errorCodes({ ...signed, description: 'changed' })).toContain('attestation-hash-mismatch');
    const required = { lint: { requireAttestation: () => true } };
    expect(resolveBlueprintSource(identity, required).validation.errors.map(e => e.code)).toContain('attestation-missing');
  });

  it('retains exclusive slot conflicts and missing-parent errors', () => {
    const resolve = parents({ a: { id: 'a', slots: [{ slot: 'domain' }] }, b: { id: 'b', slots: [{ slot: 'domain' }] } });
    const result = resolveBlueprintSource({ ...identity, extends: ['a', 'b'] }, { resolve });
    expect(result.validation.errors.map(e => e.code)).toContain('slot-exclusive-conflict');
    expect(() => resolveBlueprintSource({ ...identity, extends: 'missing' }, { resolve })).toThrow(/cannot resolve/);
  });
});
