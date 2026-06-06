import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deepMergeConfig,
  blueprintKnobsToConfigOverlay,
  readEffectiveConfig,
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

describe('readEffectiveConfig (file path)', () => {
  let dir: string;
  let stateDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eff-cfg-'));
    stateDir = dir; // stateDir IS the .papercusp dir; config.json + blueprint.yaml live here
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeConfig = (cfg: unknown) => writeFileSync(join(stateDir, 'config.json'), JSON.stringify(cfg), 'utf8');
  const writeBlueprint = (yaml: string) => writeFileSync(join(stateDir, 'blueprint.yaml'), yaml, 'utf8');

  it('no blueprint.yaml → identity (returns config.json verbatim)', () => {
    writeConfig({ snapshotRetention: 10, parallelWorkers: { max: 3 } });
    expect(readEffectiveConfig(stateDir)).toEqual({ snapshotRetention: 10, parallelWorkers: { max: 3 } });
  });

  it('blueprint knobs fill where config is silent; config overrides on conflict', () => {
    writeConfig({ parallelWorkers: { max: 8 } }); // instance override of max only
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
    // snapshotRetention only in blueprint → filled:
    expect(eff.snapshotRetention).toBe(99);
    // parallelWorkers: config.max (8) wins, blueprint useChunkLoop fills:
    expect(eff.parallelWorkers).toEqual({ max: 8, useChunkLoop: false });
    // promptOverrides only in blueprint → filled:
    expect((eff as { promptOverrides?: Record<string, string> }).promptOverrides).toEqual({ worker: 'be careful' });
  });

  it('an empty-knobs blueprint → identity (zero behavior change)', () => {
    writeConfig({ maxCostUsd: 12 });
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
