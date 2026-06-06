/**
 * The blueprint build/run **environment spec** (cloud-deployment-layer P-007) —
 * "what to stand up on a frame". Covers the schema (defaults + full spec +
 * services), that BlueprintSchema accepts it, and that the built-in `coding`
 * blueprint carries it.
 */
import { describe, it, expect } from 'vitest';
import { EnvironmentSpecSchema, EnvServiceSchema, BlueprintSchema } from './schema.js';
import { loadBuiltinBlueprint } from './loader.js';

describe('EnvironmentSpecSchema', () => {
  it('an empty spec fills every field with its empty default', () => {
    expect(EnvironmentSpecSchema.parse({})).toEqual({
      setup: [],
      install: [],
      build: [],
      test: [],
      run: [],
      services: [],
      ports: [],
      env: {},
    });
  });

  it('parses a full build/run spec', () => {
    const spec = EnvironmentSpecSchema.parse({
      setup: ['nvm install 22'],
      install: ['npm ci'],
      build: ['npm run build'],
      test: ['npm run test:affected'],
      run: ['npm run dev'],
      services: [{ name: 'pg', command: 'pg_ctl start', port: 5432, healthcheck: 'pg_isready' }],
      ports: [3055, 3070],
      env: { NODE_ENV: 'production' },
    });
    expect(spec.install).toEqual(['npm ci']);
    expect(spec.services[0]).toEqual({ name: 'pg', command: 'pg_ctl start', port: 5432, healthcheck: 'pg_isready' });
    expect(spec.ports).toEqual([3055, 3070]);
    expect(spec.env).toEqual({ NODE_ENV: 'production' });
  });

  it('EnvServiceSchema requires name + command; port/healthcheck optional', () => {
    expect(EnvServiceSchema.parse({ name: 'redis', command: 'redis-server' })).toEqual({
      name: 'redis',
      command: 'redis-server',
    });
    expect(() => EnvServiceSchema.parse({ name: 'x' })).toThrow();
    expect(() => EnvServiceSchema.parse({ command: 'y' })).toThrow();
  });

  it('rejects a non-positive port', () => {
    expect(() => EnvironmentSpecSchema.parse({ ports: [0] })).toThrow();
    expect(() => EnvironmentSpecSchema.parse({ ports: [-1] })).toThrow();
  });
});

describe('BlueprintSchema with environment', () => {
  const minimal = {
    id: 'env-bp',
    workItem: { kind: 'feature', idPrefix: 'F' },
    spine: { decider: 'director', edges: { DONE: { to: 'done' } }, default: { to: 'idle' } },
  };

  it('accepts a blueprint declaring an environment spec', () => {
    const bp = BlueprintSchema.parse({ ...minimal, environment: { install: ['npm ci'], ports: [3000] } });
    expect(bp.environment?.install).toEqual(['npm ci']);
    expect(bp.environment?.ports).toEqual([3000]);
    // unspecified sub-fields still fill their empty defaults
    expect(bp.environment?.services).toEqual([]);
  });

  it('environment is optional (absent ⇒ undefined)', () => {
    const bp = BlueprintSchema.parse(minimal);
    expect(bp.environment).toBeUndefined();
  });
});

describe('coding blueprint', () => {
  it('carries a first-class (empty-by-default) environment spec', () => {
    const { blueprint, validation } = loadBuiltinBlueprint('coding');
    expect(validation.errors).toEqual([]);
    expect(blueprint.environment).toBeDefined();
    expect(blueprint.environment).toEqual({
      setup: [],
      install: [],
      build: [],
      test: [],
      run: [],
      services: [],
      ports: [],
      env: {},
    });
  });
});
