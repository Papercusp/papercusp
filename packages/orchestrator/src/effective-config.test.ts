import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deepMergeConfig,
  blueprintKnobsToConfigOverlay,
  readEffectiveConfig,
  readInstanceConfig,
  loadHarnessBlueprintId,
  loadHarnessBlueprintPromptContext,
} from './effective-config';

describe('deepMergeConfig', () => {
  it('override wins for scalars', () => {
    expect(deepMergeConfig({ a: 1, b: 2 }, { b: 9 })).toEqual({ a: 1, b: 9 });
  });

  it('merges nested plain objects recursively', () => {
    expect(
      deepMergeConfig(
        { parallelWorkers: { max: 4, useChunkLoop: true } },
        { parallelWorkers: { max: 8 } },
      ),
    ).toEqual({ parallelWorkers: { max: 8, useChunkLoop: true } });
  });

  it('arrays in override REPLACE (not merge)', () => {
    expect(deepMergeConfig({ a: [1, 2, 3] }, { a: [9] })).toEqual({ a: [9] });
  });

  it('undefined in override never clobbers a base value', () => {
    expect(deepMergeConfig({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });

  it('does not mutate the base', () => {
    const base = { parallelWorkers: { max: 4 } };
    deepMergeConfig(base, { parallelWorkers: { max: 8 } });
    expect(base.parallelWorkers.max).toBe(4);
  });
});

describe('blueprintKnobsToConfigOverlay', () => {
  it('null/undefined knobs → empty overlay', () => {
    expect(blueprintKnobsToConfigOverlay(null)).toEqual({});
    expect(blueprintKnobsToConfigOverlay(undefined)).toEqual({});
  });

  it('picks ONLY the residual-migration keys (ignores already-migrated knobs)', () => {
    const knobs = {
      // residual (migrated by P-006) — should appear:
      snapshotRetention: 99,
      parallelWorkers: { max: 7 },
      promptOverrides: { worker: 'be careful' },
      aiBackend: { default: { model: 'claude-opus-4-8' } },
      scoper: { outputMode: 'plan' },
      // already-migrated / non-residual — should NOT appear in the overlay:
      maxCostUsd: 5,
      debuggerThreshold: 3,
      requiresRepo: true,
      harnessKind: 'coding',
    } as never;
    expect(blueprintKnobsToConfigOverlay(knobs)).toEqual({
      snapshotRetention: 99,
      parallelWorkers: { max: 7 },
      promptOverrides: { worker: 'be careful' },
      aiBackend: { default: { model: 'claude-opus-4-8' } },
      scoper: { outputMode: 'plan' },
    });
  });
});

describe('readEffectiveConfig (blueprint ⊕ env instance — config.json deprecated to zero)', () => {
  let dir: string;
  let stateDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eff-cfg-'));
    stateDir = dir; // stateDir IS the .papercusp dir; blueprint.yaml lives here
    delete process.env.HARNESS_CONFIG_JSON;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HARNESS_CONFIG_JSON;
  });

  const writeBlueprint = (yaml: string) => writeFileSync(join(stateDir, 'blueprint.yaml'), yaml, 'utf8');
  const setInstance = (cfg: unknown) => { process.env.HARNESS_CONFIG_JSON = JSON.stringify(cfg); };

  it('no blueprint + no instance env → empty', () => {
    expect(readEffectiveConfig(stateDir)).toEqual({});
  });

  it('an on-disk config.json is IGNORED (deprecated to zero — never read)', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ maxCostUsd: 12, phase: 'production' }), 'utf8');
    // No env, no blueprint → empty. The file is deliberately not consulted.
    expect(readEffectiveConfig(stateDir)).toEqual({});
  });

  it('blueprint knobs fill where the instance is silent; instance overrides on conflict', () => {
    setInstance({ parallelWorkers: { max: 8 } }); // instance override of max only
    writeBlueprint(
      [
        'id: test-eff',
        'version: 0.1.0',
        'workItem: { kind: feature, idPrefix: F }',
        'spine:',
        '  decider: director',
        '  edges: { DONE: { to: done } }',
        '  default: { to: idle }',
        'knobs:',
        '  snapshotRetention: 99',
        '  parallelWorkers: { max: 4, useChunkLoop: false }',
        '  promptOverrides: { worker: "be careful" }',
      ].join('\n'),
    );
    const eff = readEffectiveConfig(stateDir);
    expect(eff.snapshotRetention).toBe(99);                                // blueprint-only → filled
    expect(eff.parallelWorkers).toEqual({ max: 8, useChunkLoop: false });  // instance max wins
    expect((eff as { promptOverrides?: Record<string, string> }).promptOverrides).toEqual({ worker: 'be careful' });
  });

  it('an empty-knobs blueprint → the instance verbatim', () => {
    setInstance({ maxCostUsd: 12 });
    writeBlueprint(
      [
        'id: test-empty',
        'version: 0.1.0',
        'workItem: { kind: feature, idPrefix: F }',
        'spine:',
        '  decider: director',
        '  edges: { DONE: { to: done } }',
        '  default: { to: idle }',
      ].join('\n'),
    );
    expect(readEffectiveConfig(stateDir)).toEqual({ maxCostUsd: 12 });
  });
});

describe('loadHarnessBlueprintId (domain-generic-agent-personas P-013 — coding-vs-generic signal)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bp-id-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads the blueprint id from <stateDir>/blueprint.yaml', () => {
    writeFileSync(
      join(dir, 'blueprint.yaml'),
      [
        'id: coding',
        'version: 0.1.0',
        'workItem: { kind: feature, idPrefix: F }',
        'spine: { decider: director, edges: { DONE: { to: done } }, default: { to: idle } }',
      ].join('\n'),
      'utf8',
    );
    expect(loadHarnessBlueprintId(dir)).toBe('coding');
  });

  it('returns the loader-resolved leaf-first chain for a harness-local child', () => {
    writeFileSync(
      join(dir, 'blueprint.yaml'),
      [
        'id: papercusp',
        'extends: papercusp-engineer',
        'kind: pot',
        'version: 0.1.0',
        'workItem: { kind: feature, idPrefix: WI }',
        'roles: [{ id: su }]',
        'spine: { decider: su, edges: { DONE: { to: done } }, default: { to: idle } }',
      ].join('\n'),
      'utf8',
    );
    expect(loadHarnessBlueprintPromptContext(dir)).toEqual({
      blueprintId: 'papercusp',
      extendsChain: ['papercusp', 'papercusp-engineer', 'identity-root'],
    });
  });

  it('undefined when no blueprint.yaml (non-blueprint harness ⇒ neutral preamble only)', () => {
    expect(loadHarnessBlueprintId(dir)).toBeUndefined();
  });

  it('undefined on an unreadable/invalid blueprint.yaml (fail-safe)', () => {
    writeFileSync(join(dir, 'blueprint.yaml'), 'id: : : not valid yaml {[', 'utf8');
    expect(loadHarnessBlueprintId(dir)).toBeUndefined();
    expect(loadHarnessBlueprintPromptContext(dir)).toBeUndefined();
  });
});

describe('readInstanceConfig — env-transport ONLY (config.json deprecated to zero)', () => {
  beforeEach(() => { delete process.env.HARNESS_CONFIG_JSON; });
  afterEach(() => { delete process.env.HARNESS_CONFIG_JSON; });

  it('reads HARNESS_CONFIG_JSON env when set', () => {
    process.env.HARNESS_CONFIG_JSON = JSON.stringify({ phase: 'production', maxCostUsd: 5 });
    expect(readInstanceConfig()).toEqual({ phase: 'production', maxCostUsd: 5 });
  });

  it('returns {} when the env is absent (config.json is NOT consulted)', () => {
    expect(readInstanceConfig()).toEqual({});
  });

  it('a malformed env value → {} (blueprint defaults apply; never strands a run)', () => {
    process.env.HARNESS_CONFIG_JSON = '{ not valid json';
    expect(readInstanceConfig()).toEqual({});
  });

  it('readEffectiveConfig uses the env instance layer under blueprint knobs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inst-cfg-'));
    try {
      process.env.HARNESS_CONFIG_JSON = JSON.stringify({ parallelWorkers: { max: 9 } });
      writeFileSync(
        join(dir, 'blueprint.yaml'),
        [
          'id: t',
          'version: 0.1.0',
          'workItem: { kind: feature, idPrefix: F }',
          'spine: { decider: director, edges: { DONE: { to: done } }, default: { to: idle } }',
          'knobs: { parallelWorkers: { max: 2, useChunkLoop: true } }',
        ].join('\n'),
        'utf8',
      );
      // env instance (max:9) wins over blueprint knob (max:2); blueprint useChunkLoop fills.
      expect(readEffectiveConfig(dir).parallelWorkers).toEqual({ max: 9, useChunkLoop: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
