/**
 * WI-10000316: terminal postgres.js results remain attributable without
 * retaining SQL parameters, row contents, or unbounded history.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import {
  pgResultDiagnosticSnapshot,
  recordPgResult,
  recordPgDiagnosticResponse,
  capturePgDiagnosticContext,
  createPgDiagnosticHooks,
  resetPgDiagnosticContextResolver,
  resetAcquireRegistryForTest,
  setPgDiagnosticContextResolver,
  pgQueryFamily,
  pgQueryFamilyMemoStats,
  resetPgQueryFamilyMemoForTest,
  PG_QUERY_FAMILY_MEMO_MAX_TEXT,
} from './acquire-registry';

const require_ = createRequire(import.meta.url);

function resolvePostgresRoot(): string {
  let dir = path.dirname(require_.resolve('postgres'));
  for (let hops = 0; hops < 8; hops++) {
    const manifest = path.join(dir, 'package.json');
    if (
      fs.existsSync(manifest) &&
      JSON.parse(fs.readFileSync(manifest, 'utf8')).name === 'postgres'
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate postgres package root');
}

const PG_ROOT = resolvePostgresRoot();
const PATCH_PATH = path.resolve(PG_ROOT, '../../patches/postgres+3.4.9.patch');
const ACQUIRE_REGISTRY_SOURCE = fs.readFileSync(
  process.env.P003_ACQUIRE_REGISTRY_SRC ?? new URL('./acquire-registry.ts', import.meta.url),
  'utf8',
);
const BUILD_ROOTS = ['src', 'cjs/src', 'cf/src'].filter((rel) =>
  fs.existsSync(path.join(PG_ROOT, rel, 'connection.js')),
);

/** Execute current registry source in an isolated in-memory module. No DB or filesystem writes. */
function registryFromSource(source = ACQUIRE_REGISTRY_SOURCE): typeof import('./acquire-registry') {
  const javascript = stripTypeScriptTypes(source)
    .replace(/^import .*;\s*$/gm, '')
    .replace(/^export /gm, '');
  const pinned = new Map<string, unknown>();
  return new Function('pinModuleState', 'randomUUID', 'readBuildStamp', 'AsyncLocalStorage', javascript + `
    return { createPgDiagnosticHooks, pgResultDiagnosticSnapshot, beginAcquire,
      recordPgResult, setPgDiagnosticContextResolver, capturePgDiagnosticContext,
      pgQueryFamily, pgQueryFamilyMemoStats, recordPgDiagnosticResponse };
  `)(
    (key: string, init: () => unknown) => {
      if (!pinned.has(key)) pinned.set(key, init());
      return pinned.get(key);
    }, randomUUID, () => null, AsyncLocalStorage,
  );
}

const completedInput = {
  connectionId: 1, queryId: 1, backendPid: null,
  query: "select id from private_table where token = 'never-retain-secret'",
  rowCount: 1, wireBytes: 10, elapsedMs: 75, status: 'error' as const, errorCode: '42P01',
};
const registryControls = [
  {
    name: 'R1 process and physical-pool isolation',
    from: 'poolInstanceId: randomUUID()', to: 'poolInstanceId: null',
    verify(source: string) {
      const a = registryFromSource(source), b = registryFromSource(source);
      a.createPgDiagnosticHooks('org-app').onresult(completedInput);
      a.createPgDiagnosticHooks('org-app').onresult(completedInput);
      b.createPgDiagnosticHooks('org-app').onresult(completedInput);
      const [first, second] = a.pgResultDiagnosticSnapshot('org-app').results;
      expect(first.source.processInstanceId).toBe(second.source.processInstanceId);
      expect(first.source.processInstanceId).not.toBe(b.pgResultDiagnosticSnapshot('org-app').results[0].source.processInstanceId);
      expect(first.source.poolInstanceId, 'physical pools must stay distinct').not.toBe(second.source.poolInstanceId);
    },
  },
  {
    name: 'R3 unknown correlation and elapsed metadata',
    from: "return correlation ? { state: 'linked', correlation } : { state: 'unknown' };",
    to: "return correlation ? { state: 'linked', correlation } : { state: 'unobserved' };",
    verify(source: string) {
      const registry = registryFromSource(source);
      const acquired = registry.beginAcquire('org-app');
      acquired.acquired();
      expect(registry.pgResultDiagnosticSnapshot('org-app').results).toEqual([]);
      acquired.release();
      registry.recordPgResult('org-app', { ...completedInput, context: { state: 'unknown' } });
      expect(registry.pgResultDiagnosticSnapshot('org-app').results[0]).toMatchObject({
        correlationState: 'unknown', elapsedMs: 75, status: 'error', errorCode: '42p01',
      });
    },
  },
  {
    name: 'R4 SQL privacy',
    from: 'const queryFamily = pgQueryFamily(input.query);', to: 'const queryFamily = input.query;',
    verify(source: string) {
      const registry = registryFromSource(source);
      registry.recordPgResult('org-app', completedInput);
      const result = registry.pgResultDiagnosticSnapshot('org-app');
      expect(result.results[0].queryFamily).toBe('select:private_table');
      expect(JSON.stringify(result)).not.toContain('never-retain-secret');
    },
  },
  {
    name: 'R5 bounded eviction and immutable identity',
    from: 'results.splice(0, results.length - PG_RESULT_DIAGNOSTIC_LIMIT);', to: 'void 0;',
    verify(source: string) {
      const registry = registryFromSource(source);
      for (let queryId = 1; queryId <= 40; queryId++) registry.createPgDiagnosticHooks('org-app').onresult({ ...completedInput, queryId });
      const snapshot = registry.pgResultDiagnosticSnapshot('org-app', 4);
      expect(snapshot).toMatchObject({ capacity: 32, totalRecorded: 40, dropped: 8 });
      expect(snapshot.results.map(row => row.queryId)).toEqual([37, 38, 39, 40]);
      snapshot.results[0].source = { ...snapshot.results[0].source, processInstanceId: 'changed' };
      expect(registry.pgResultDiagnosticSnapshot('org-app', 4).results[0].source.processInstanceId).not.toBe('changed');
    },
  },
  {
    // WI-10002541: the family classifier runs once per distinct SQL text on
    // the per-result hot path, not once per result.
    name: 'R6 query-family memo classifies each distinct text once',
    from: 'const hit = families.get(text);', to: 'const hit = undefined;',
    verify(source: string) {
      const registry = registryFromSource(source);
      const hooks = registry.createPgDiagnosticHooks('org-app');
      // Fresh string instances, as postgres-js builds them per call.
      for (let queryId = 1; queryId <= 50; queryId++) {
        hooks.onresult({ ...completedInput, queryId, query: (' ' + completedInput.query).slice(1) });
      }
      expect(registry.pgQueryFamilyMemoStats()).toMatchObject({ misses: 1, hits: 49, size: 1 });
      expect(registry.pgResultDiagnosticSnapshot('org-app', 1).results[0].queryFamily).toBe('select:private_table');
    },
  },
];

describe('P-003 calibrated in-memory registry counterexamples', () => {
  it.each(registryControls)('$name passes actual source and rejects the targeted mutant', ({ from, to, verify }) => {
    if (process.env.P003_CALIBRATED_RED_CONTROL === '1') {
      // Copy-out probes supply the already-mutated source. Require it to parse,
      // then let the independent behavior assertion produce the red result.
      expect(() => registryFromSource(ACQUIRE_REGISTRY_SOURCE)).not.toThrow();
      verify(ACQUIRE_REGISTRY_SOURCE);
      return;
    }
    expect(ACQUIRE_REGISTRY_SOURCE.split(from), 'mutation site must be unique').toHaveLength(2);
    expect(() => verify(ACQUIRE_REGISTRY_SOURCE)).not.toThrow();
    const mutant = ACQUIRE_REGISTRY_SOURCE.replace(from, to);
    // Parsing/module construction is calibrated separately: only an assertion
    // failure counts as a killed mutant, never a syntax/import failure.
    expect(() => registryFromSource(mutant)).not.toThrow();
    expect(() => verify(mutant)).toThrowError(expect.objectContaining({ name: 'AssertionError' }));
  });
});

function functionSource(source: string, name: string): string {
  const match = source.match(
    new RegExp(`^ {2}(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]+?^ {2}\\}`, 'm'),
  );
  expect(match, `postgres source must declare ${name}`).toBeTruthy();
  return match![0];
}

function instantiateReporter(
  declaration: string,
  onresult: (value: Record<string, unknown>) => void,
  overrides: Record<string, unknown> = {},
) {
  const factory = new Function(
    'state',
    `
      const options = { onresult: state.onresult };
      const query = state.query;
      const backend = state.backend;
      const result = state.result;
      const results = state.results;
      const id = state.id;
      const performance = state.performance;
      ${declaration}
      return reportQueryResult;
    `,
  ) as (state: Record<string, unknown>) => (error: unknown) => void;

  return factory({
    onresult,
    query: {
      resultDiagnostic: {
        queryId: 23,
        query:
          "SELECT payload FROM harness_shared.substrate_outbox WHERE secret = 'never-retain'",
        startedAt: 100,
        rowCount: 400,
        wireBytes: 2_000_000,
      },
    },
    backend: { pid: 8123 },
    result: { command: 'SELECT' },
    results: null,
    id: 7,
    performance: { now: () => 175 },
    ...overrides,
  });
}

beforeEach(() => {
  resetPgDiagnosticContextResolver();
  resetAcquireRegistryForTest();
});

describe('P011 exact decoded-object weak diagnostic guards', () => {
  it.each(BUILD_ROOTS)('observes the exact fulfilled single/multi-result object, never an error partial (%s)', (runtime) => {
    const connection = fs.readFileSync(path.join(PG_ROOT, runtime, 'connection.js'), 'utf8');
    const declaration = functionSource(connection, 'reportQueryResult');
    const single = Object.assign([{ secret: 'do-not-render-row' }], { command: 'SELECT' });
    const multi = [single, Object.assign([{ id: 2 }], { command: 'SELECT' })];
    for (const results of [null, multi]) {
      const fulfilled = results ?? single;
      let observed: unknown;
      const report = instantiateReporter(declaration, (value) => {
        observed = value.result;
        recordPgResult('org-app', value as never);
      }, { result: single, results });
      report(null);
      expect(observed).toBe(fulfilled);
      const snapshot = pgResultDiagnosticSnapshot('org-app', 1, { includeObjectRefs: true });
      expect(snapshot.results[0].objectRefs?.decodedResult?.deref()).toBe(fulfilled);
      expect(JSON.stringify(pgResultDiagnosticSnapshot('org-app'))).not.toContain('do-not-render-row');
      expect(pgResultDiagnosticSnapshot('org-app').results.at(-1)).not.toHaveProperty('objectRefs');
      report({ code: '42P01' });
      expect(observed).toBeUndefined();
      expect(pgResultDiagnosticSnapshot('org-app', 1, { includeObjectRefs: true }).results[0]).not.toHaveProperty('objectRefs');
    }
  });

  it('joins responses only by exact request/process/build identity and keeps pool/query identity', () => {
    const identity = {
      processInstanceId: randomUUID(), buildSha: 'a'.repeat(40), rowId: null,
      attemptId: randomUUID(), hopId: null, stage: null, boundary: null,
      requestId: randomUUID(), operation: 'workItems.byHarness',
    };
    const raw = [{ id: 1 }];
    const mapped = [{ id: 1 }];
    const envelope = { rows: mapped };
    const sources = [
      { ...identity, poolInstanceId: randomUUID() },
      { ...identity, poolInstanceId: randomUUID(), processInstanceId: randomUUID() },
      { ...identity, poolInstanceId: randomUUID(), buildSha: 'b'.repeat(40) },
    ];
    for (let n = 0; n < sources.length; n++) {
      recordPgResult('org-app', { ...completedInput, status: 'ok', queryId: n + 1, result: raw,
        context: { state: 'linked', correlation: identity } }, sources[n]);
    }
    recordPgResult('org-app', { ...completedInput, status: 'ok', queryId: 4, result: raw,
      context: { state: 'linked', correlation: { ...identity, requestId: randomUUID() } } }, sources[0]);
    recordPgDiagnosticResponse(identity, 'resolvedRows', mapped);
    recordPgDiagnosticResponse(identity, 'responseValue', envelope);
    const snapshot = pgResultDiagnosticSnapshot('org-app', 32, { includeObjectRefs: true });
    expect(snapshot.results[0].objectRefs?.resolvedRows?.deref()).toBe(mapped);
    expect(snapshot.results[0].objectRefs?.responseValue?.deref()).toBe(envelope);
    expect(snapshot.results[0].objectRefs?.decodedResult?.deref()).toBe(raw);
    expect(raw).not.toBe(mapped);
    expect(snapshot.results.map(r => [r.source.poolInstanceId, r.queryId])).toEqual([
      [sources[0].poolInstanceId, 1], [sources[1].poolInstanceId, 2],
      [sources[2].poolInstanceId, 3], [sources[0].poolInstanceId, 4],
    ]);
    for (const row of snapshot.results.slice(1)) {
      expect(row.objectRefs).not.toHaveProperty('resolvedRows');
      expect(row.objectRefs).not.toHaveProperty('responseValue');
    }
    delete snapshot.results[0].objectRefs!.decodedResult;
    expect(pgResultDiagnosticSnapshot('org-app', 32, { includeObjectRefs: true }).results[0].objectRefs?.decodedResult?.deref()).toBe(raw);
  });

  it('uses the captured request build when the pool source build was unmeasured', () => {
    const context = { processInstanceId: randomUUID(), buildSha: 'a'.repeat(40), rowId: null,
      attemptId: randomUUID(), hopId: null, stage: null, boundary: null,
      requestId: randomUUID(), operation: 'workItems.byHarness' };
    const source = { processInstanceId: context.processInstanceId, buildSha: null, poolInstanceId: randomUUID() };
    const decoded = [{ id: 'raw-private' }], mapped = [{ id: 'mapped-private' }], envelope = { rows: mapped };
    recordPgResult('org-app', { ...completedInput, status: 'ok', result: decoded,
      context: { state: 'linked', correlation: context } }, source);
    recordPgDiagnosticResponse(context, 'resolvedRows', mapped);
    recordPgDiagnosticResponse(context, 'responseValue', envelope);
    const row = pgResultDiagnosticSnapshot('org-app', 32, { includeObjectRefs: true }).results[0];
    expect(row.source).toEqual(source);
    expect(row.correlation?.buildSha).toBe(context.buildSha);
    expect(row.objectRefs?.decodedResult?.deref()).toBe(decoded);
    expect(row.objectRefs?.resolvedRows?.deref()).toBe(mapped);
    expect(row.objectRefs?.responseValue?.deref()).toBe(envelope);
    const publicSnapshot = JSON.stringify(pgResultDiagnosticSnapshot('org-app'));
    for (const payload of ['raw-private', 'mapped-private']) expect(publicSnapshot).not.toContain(payload);
  });

  it.each(['captured-build', 'captured-process', 'pool-build', 'pool-process', 'request'])(
    'rejects a %s mismatch even when response objects are observed', mismatch => {
      const context = { processInstanceId: randomUUID(), buildSha: 'a'.repeat(40), rowId: null,
        attemptId: randomUUID(), hopId: null, stage: null, boundary: null,
        requestId: randomUUID(), operation: 'workItems.byHarness' };
      const captured = { ...context };
      const source = { processInstanceId: context.processInstanceId, buildSha: null as string | null,
        poolInstanceId: randomUUID() };
      if (mismatch === 'captured-build') captured.buildSha = 'b'.repeat(40);
      if (mismatch === 'captured-process') captured.processInstanceId = randomUUID();
      if (mismatch === 'pool-build') source.buildSha = 'b'.repeat(40);
      if (mismatch === 'pool-process') source.processInstanceId = randomUUID();
      if (mismatch === 'request') captured.requestId = randomUUID();
      recordPgResult('org-app', { ...completedInput, status: 'ok', result: [],
        context: { state: 'linked', correlation: captured } }, source);
      recordPgDiagnosticResponse(context, 'resolvedRows', []);
      recordPgDiagnosticResponse(context, 'responseValue', { rows: [] });
      const row = pgResultDiagnosticSnapshot('org-app', 32, { includeObjectRefs: true }).results[0];
      expect(row.objectRefs).not.toHaveProperty('resolvedRows');
      expect(row.objectRefs).not.toHaveProperty('responseValue');
    });

  it('bounds weak records and never invents an evicted or unobserved request link', () => {
    const hooks = createPgDiagnosticHooks('org-app');
    for (let queryId = 1; queryId <= 40; queryId++) hooks.onresult({ ...completedInput, status: 'ok', queryId, result: [] });
    const snapshot = pgResultDiagnosticSnapshot('org-app', 32, { includeObjectRefs: true });
    expect(snapshot).toMatchObject({ capacity: 32, totalRecorded: 40, dropped: 8 });
    expect(snapshot.results.map(row => row.queryId)).toEqual(Array.from({ length: 32 }, (_, n) => n + 9));
    recordPgDiagnosticResponse({ processInstanceId: randomUUID(), buildSha: null, rowId: null,
      attemptId: randomUUID(), hopId: null, stage: null, boundary: null, requestId: randomUUID() }, 'resolvedRows', []);
    expect(pgResultDiagnosticSnapshot('org-app', 32, { includeObjectRefs: true }).results.every(r => !r.objectRefs?.resolvedRows)).toBe(true);
  });

  it('allows decoded and response objects to be collected while the diagnostic record remains', () => {
    // Isolated canonical lifetime guard: no GC, DB, inspector or profiler in the serving process.
    const javascript = stripTypeScriptTypes(ACQUIRE_REGISTRY_SOURCE)
      .replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
    const program = `
      const { randomUUID } = require('node:crypto');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const pinned = new Map();
      const registry = new Function('pinModuleState', 'randomUUID', 'readBuildStamp', 'AsyncLocalStorage',
        ${JSON.stringify(javascript)} + '\\nreturn { createPgDiagnosticHooks, pgResultDiagnosticSnapshot, recordPgDiagnosticResponse, pgDiagnosticIdentity, setPgDiagnosticContextResolver };'
      )((key, init) => { if (!pinned.has(key)) pinned.set(key, init()); return pinned.get(key); }, randomUUID, () => null, AsyncLocalStorage);
      const context = { ...registry.pgDiagnosticIdentity(), rowId: null,
        attemptId: randomUUID(), hopId: null, stage: null, boundary: null, requestId: randomUUID() };
      registry.setPgDiagnosticContextResolver(() => context);
      const held = [{ id: 'held' }];
      function record() {
        const hooks = registry.createPgDiagnosticHooks('org-app');
        const identity = hooks.onquerycontext();
        const result = [{ id: 'released' }];
        hooks.onresult({ connectionId: 1, queryId: 1, backendPid: null, query: 'select 1',
          rowCount: 1, wireBytes: 1, status: 'ok', result, context: identity });
        registry.recordPgDiagnosticResponse(context, 'resolvedRows', [{ id: 'mapped' }]);
        registry.recordPgDiagnosticResponse(context, 'responseValue', { rows: result });
        hooks.onresult({ connectionId: 1, queryId: 2, backendPid: null, query: 'select 1',
          rowCount: 1, wireBytes: 1, status: 'ok', result: held, context: identity });
        return registry.pgResultDiagnosticSnapshot('org-app', 32, { includeObjectRefs: true });
      }
      const snapshot = record();
      (async () => {
        for (let n = 0; n < 20; n++) { await new Promise(setImmediate); global.gc(); }
        const refs = snapshot.results[0].objectRefs;
        if (!refs.resolvedRows || !refs.responseValue) throw new Error('missing observed response references');
        for (const ref of Object.values(refs)) if (ref.deref() !== undefined) throw new Error('diagnostic retained a released object');
        if (snapshot.results[1].objectRefs.decodedResult.deref() !== held) throw new Error('lost the positive retained control');
        if (registry.pgResultDiagnosticSnapshot('org-app').results.length !== 2) throw new Error('lost diagnostic metadata');
        console.log('weak-lifetime-pass');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const child = spawnSync(process.execPath, ['--expose-gc', '-e', program], { encoding: 'utf8', timeout: 15_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('weak-lifetime-pass');
  });
});

describe('postgres.js terminal result diagnostics patch', () => {
  it.each(BUILD_ROOTS)('starts pre-build timing at execution, preserving lazy gaps and concurrent identities (%s)', async (runtime) => {
    const source = fs.readFileSync(path.join(PG_ROOT, runtime, 'query.js'), 'utf8');
    const method = source.match(/^  async handle\(\) \{[\s\S]*?^  \}/m);
    expect(method).not.toBeNull();
    let now = 10;
    const Query = new Function('performance', `return class Query {
      constructor(handler) { this.executed = false; this.handler = handler; }
      ${method![0]}
    };` )({ now: () => now }) as new (handler: (q: { diagnosticHandleStartedAt?: number }) => void) => {
      diagnosticHandleStartedAt?: number; handle(): Promise<void>;
    };
    const seen: Array<number | undefined> = [];
    const first = new Query(q => seen.push(q.diagnosticHandleStartedAt));
    const second = new Query(q => seen.push(q.diagnosticHandleStartedAt));
    expect(first.diagnosticHandleStartedAt).toBeUndefined();
    now = 100; await first.handle();
    now = 240; await second.handle();
    now = 500; await first.handle();
    expect(seen).toEqual([100, 240]);
    expect(first.diagnosticHandleStartedAt).toBe(100);
    expect(second.diagnosticHandleStartedAt).toBe(240);
  });

  it.each(BUILD_ROOTS)('separates pre-build wait from execution and preserves both across retry (%s)', (runtime) => {
    const source = fs.readFileSync(path.join(PG_ROOT, runtime, 'connection.js'), 'utf8');
    const seen: Record<string, unknown>[] = [];
    const harness = new Function('onresult', `
      const options = { onresult, prepare: true };
      const id = 1, backend = { pid: 2 }, result = { command: 'SELECT' }, results = null;
      const statements = {}, statementId = 'test';
      let statementCount = 0, queryDiagnosticId = 0, query, now = 100;
      const performance = { now: () => now };
      const stringify = q => q.strings[0], handleValue = () => {};
      const execute = q => build(q);
      ${functionSource(source, 'build')}
      ${functionSource(source, 'retry')}
      ${functionSource(source, 'reportQueryResult')}
      return { build, retry, clock(value) { now = value; },
        report(q) { query = q; reportQueryResult(null); } };
    `)((value: Record<string, unknown>) => seen.push(value));
    const query = { strings: ['select 1'], args: [], options: {}, tagged: true,
      diagnosticHandleStartedAt: 25, resultDiagnostic: undefined as unknown };
    harness.build(query);
    const descriptor = query.resultDiagnostic;
    harness.clock(160); harness.retry(query, { code: '26000' });
    expect(query.resultDiagnostic).toBe(descriptor);
    harness.clock(200); harness.report(query);
    expect(seen[0]).toMatchObject({ preBuildMs: 75, elapsedMs: 100 });
    const legacy = { strings: ['select 2'], args: [], options: {}, tagged: true };
    harness.build(legacy); harness.clock(210); harness.report(legacy);
    expect(seen[1]).toMatchObject({ preBuildMs: null, elapsedMs: 10 });
  });

  it('keeps distinct pool identities in the production factory (copy-out mutation seam)', () => {
    // Execute the actual factory, including a relocated copy during mutation
    // probes. The independent oracle compares emitted identities, not source
    // spellings. Dependencies only collect output and supply process identity.
    const declaration = ACQUIRE_REGISTRY_SOURCE.match(
      /^export function createPgDiagnosticHooks\(pool: string\) \{[\s\S]+?^\}/m,
    );
    expect(declaration, 'production factory must be found').not.toBeNull();
    const emitted: Array<{ pool: string; source: { processInstanceId: string; poolInstanceId: string } }> = [];
    const factory = new Function('pgDiagnosticIdentity', 'randomUUID', 'capturePgDiagnosticContext', 'recordPgResult',
      declaration![0]
        .replace('export ', '')
        .replace(/pool: string/g, 'pool')
        .replace(/: PgDiagnosticSource/g, '')
        .replace(/: PgResultDiagnosticInput/g, '')
        .replace(': PgDiagnosticSource', '') + '\nreturn createPgDiagnosticHooks;',
    )(
      () => ({ processInstanceId: '11111111-1111-4111-8111-111111111111', buildSha: null }),
      randomUUID,
      () => ({ state: 'unobserved' }),
      (pool: string, _value: unknown, source: typeof emitted[number]['source']) => emitted.push({ pool, source }),
    ) as typeof createPgDiagnosticHooks;
    const input = { connectionId: 1, queryId: 1, backendPid: null, query: 'select 1', rowCount: 1, wireBytes: 1, status: 'ok' as const };
    factory('org-app').onresult(input);
    factory('org-app').onresult(input);
    expect(emitted).toHaveLength(2);
    expect(emitted[0].source.processInstanceId).toBe(emitted[1].source.processInstanceId);
    expect(emitted[0].source.poolInstanceId).not.toBe(emitted[1].source.poolInstanceId);
  });

  it('covers every shipped runtime build and the option/type entry points', () => {
    expect(BUILD_ROOTS).toEqual(expect.arrayContaining(['src', 'cjs/src']));
    for (const rel of BUILD_ROOTS) {
      const connection = fs.readFileSync(path.join(PG_ROOT, rel, 'connection.js'), 'utf8');
      const index = fs.readFileSync(path.join(PG_ROOT, rel, 'index.js'), 'utf8');
      expect(connection).toContain('q.resultDiagnostic = q.resultDiagnostic ||');
      expect(connection).toContain('q.resultDiagnostic.queryId');
      expect(connection).toContain('query.resultDiagnostic.wireBytes += x.length');
      expect(connection).toContain('reportQueryResult(query.retried)');
      expect(connection).toContain('reportQueryResult(errorResponse)');
      expect(connection).toContain('reportQueryResult(null)');
      expect(index).toContain('onresult        : o.onresult');
    }

    const types = fs.readFileSync(path.join(PG_ROOT, 'types/index.d.ts'), 'utf8');
    expect(types).toContain('interface QueryResultDiagnostic');
    expect(types).toContain('queryId: number');

    const hostConnection = fs.readFileSync(new URL('./connection.ts', import.meta.url), 'utf8');
    expect(hostConnection).toContain('...createPgDiagnosticHooks(label)');
  });

  it('persists every runtime and type edit in the patch-package artifact', () => {
    const patch = fs.readFileSync(PATCH_PATH, 'utf8');
    for (const rel of BUILD_ROOTS) {
      expect(patch).toContain(`node_modules/postgres/${rel}/connection.js`);
      expect(patch).toContain(`node_modules/postgres/${rel}/index.js`);
      expect(patch).toContain(`node_modules/postgres/${rel}/query.js`);
    }
    expect(patch).toContain('node_modules/postgres/types/index.d.ts');
    expect(patch).toContain('PAPERCUSP PATCH (WI-10000316)');
    expect(patch).toContain('interface QueryResultDiagnostic');
  });

  it('matches installed dependency bytes to each maintained patch postimage', () => {
    const patch = fs.readFileSync(PATCH_PATH, 'utf8');
    for (const block of patch.split(/(?=^diff --git )/m).filter(block => block.startsWith('diff --git '))) {
      const target = block.match(/^\+\+\+ b\/node_modules\/postgres\/(.+)$/m)?.[1];
      const hash = block.match(/^index [a-f0-9]+\.\.([a-f0-9]+)/m)?.[1];
      expect(target).toBeDefined(); expect(hash).toBeDefined();
      const bytes = fs.readFileSync(path.join(PG_ROOT, target!));
      const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      expect(actual.startsWith(hash!), target).toBe(true);
    }
  });

  it('correlates a large terminal result with its originating query family', () => {
    const connection = fs.readFileSync(path.join(PG_ROOT, 'src/connection.js'), 'utf8');
    const report = instantiateReporter(
      functionSource(connection, 'reportQueryResult'),
      (value) => recordPgResult('org-app', value as never),
    );

    report(null);
    expect(pgResultDiagnosticSnapshot('org-app').results).toEqual([
      expect.objectContaining({
        connectionId: 7,
        queryId: 23,
        backendPid: 8123,
        queryFamily: 'select:harness_shared.substrate_outbox',
        command: 'select',
        rowCount: 400,
        wireBytes: 2_000_000,
        elapsedMs: 75,
        status: 'ok',
      }),
    ]);
    expect(JSON.stringify(pgResultDiagnosticSnapshot('org-app'))).not.toContain('never-retain');
  });

  it('emits final errors and swallows diagnostic callback failures', () => {
    const connection = fs.readFileSync(path.join(PG_ROOT, 'src/connection.js'), 'utf8');
    const seen: Record<string, unknown>[] = [];
    const report = instantiateReporter(
      functionSource(connection, 'reportQueryResult'),
      (value) => seen.push(value),
    );
    report({ code: '42P01', name: 'PostgresError', routine: 'ExecSimpleQuery', message: 'do-not-retain-error-message' });
    expect(seen[0]).toMatchObject({
      status: 'error', errorCode: '42P01', errorClass: 'PostgresError', serverRoutine: 'ExecSimpleQuery', queryId: 23,
    });
    expect(JSON.stringify(seen)).not.toContain('do-not-retain-error-message');

    const throwing = instantiateReporter(
      functionSource(connection, 'reportQueryResult'),
      () => {
        throw new Error('diagnostic sink failed');
      },
    );
    expect(() => throwing(null)).not.toThrow();
  });

  it('preserves the original diagnostic descriptor across prepared retry', () => {
    for (const rel of BUILD_ROOTS) {
      const source = fs.readFileSync(path.join(PG_ROOT, rel, 'connection.js'), 'utf8');
      const build = functionSource(source, 'build');
      const retry = functionSource(source, 'retry');
      expect(build).toContain('q.resultDiagnostic = q.resultDiagnostic ||');
      expect(retry).not.toContain('resultDiagnostic');
    }
  });

  it.each(['esm', 'cjs'])('captures tagged/unsafe/file queries before queuing without executing them (%s)', async (runtime) => {
    const factory: typeof postgres = runtime === 'esm' ? postgres : require_('postgres');
    const socket = vi.fn(() => { throw new Error('must not connect'); });
    const context = { state: 'unobserved' };
    const observer = vi.fn(() => context);
    const sql = factory({ onquerycontext: observer, socket, fetch_types: false });
    // Merely constructing queries never reads the file, creates a socket or
    // changes the lazy Query identity. Do not await or cancel these Queries.
    const queries = [sql`select 1`, sql.unsafe('select 2'), sql.file('/not-read.sql')];
    sql('identifier');
    expect(observer).toHaveBeenCalledTimes(3);
    for (const query of queries) {
      expect((query as unknown as { diagnosticContext: unknown }).diagnosticContext).toBe(context);
      expect(query.simple()).toBe(query);
      expect((query as unknown as { executed: boolean }).executed).toBe(false);
    }
    await sql.end();
    expect(socket).not.toHaveBeenCalled();

    const broken = factory({ onquerycontext() { throw new Error('observer'); }, socket });
    const query = broken`select 1`;
    expect((query as unknown as { diagnosticContext: unknown }).diagnosticContext).toBeNull();
    expect(query.simple()).toBe(query);
    await broken.end();
    expect(socket).not.toHaveBeenCalled();
  });

  it.each(BUILD_ROOTS)('records pool, query-origin and end-caller diagnostics when end timeout rejects a queued query (%s)', async (runtime) => {
    const index = fs.readFileSync(path.join(PG_ROOT, runtime, 'index.js'), 'utf8');
    const hooks = createPgDiagnosticHooks('end-timeout-fixture');
    const query = {
      strings: ['select 2'],
      diagnosticContext: hooks.onquerycontext(),
      diagnosticHandleStartedAt: performance.now(),
      origin: `Error\\n    at queued query (${import.meta.url}:1:1)`,
      rejection: null as unknown,
      reject(error: unknown) { this.rejection = error; },
    };
    const queries = [query];
    const connections = [{
      end: () => new Promise<void>(() => {}),
      terminate: () => undefined,
    }];
    class PendingQuery {}
    Object.setPrototypeOf(query, PendingQuery.prototype);
    const end = new Function(
      'connections', 'queries', 'Errors', 'options', 'Query',
      `
        let ending = false;
        const listen = { sql: null }, subscribe = { sql: null };
        ${functionSource(index, 'end')}
        ${functionSource(index, 'destroy')}
        return end;
      `,
    )(
      connections,
      queries,
      { connection(code: string) { return Object.assign(new Error(code), { code }); } },
      hooks,
      PendingQuery,
    ) as (options: { timeout: number }) => Promise<void>;

    await end({ timeout: 0.01 });

    expect(query.rejection).toMatchObject({ code: 'CONNECTION_DESTROYED' });
    const snapshot = pgResultDiagnosticSnapshot('end-timeout-fixture');
    expect(snapshot.failures).toHaveLength(1);
    expect(snapshot.failures[0]).toMatchObject({
      pool: 'end-timeout-fixture',
      queryFamily: 'other',
      status: 'error',
      errorCode: 'connection_destroyed',
      queryOrigin: expect.stringContaining('postgres-result-diagnostics.test.ts'),
      endCaller: expect.stringContaining('postgres-result-diagnostics.test.ts'),
    });
    expect(JSON.stringify(snapshot)).not.toContain('select 2');
  });

  it.each(BUILD_ROOTS)('runs the real build/retry/reporter functions with creation-time context (%s; hermetic, not wire proof)', async (runtime) => {
    const first = {
      processInstanceId: '11111111-1111-4111-8111-111111111111',
      buildSha: null,
      rowId: '7',
      attemptId: '22222222-2222-4222-8222-222222222222',
      hopId: 1,
      stage: 'epoch-query',
      boundary: 'await' as const,
    };
    const hooks = createPgDiagnosticHooks('org-app');
    const sql = postgres({ ...hooks, fetch_types: false });
    setPgDiagnosticContextResolver(() => first);
    const original = sql`select 1`;
    const captured = capturePgDiagnosticContext();
    // Queue/service/retry context has moved to a different attempt.
    setPgDiagnosticContextResolver(() => ({ ...first, rowId: '8', attemptId: '33333333-3333-4333-8333-333333333333' }));
    const source = fs.readFileSync(path.join(PG_ROOT, runtime, 'connection.js'), 'utf8');
    const harness = new Function('options', `
      const id = 7, backend = { pid: 8123 }, result = { command: 'SELECT' }, results = null;
      const statements = {}, statementId = 'test';
      let statementCount = 0, queryDiagnosticId = 0, query, now = 100;
      const performance = { now: () => now };
      const stringify = q => q.strings[0], handleValue = () => {};
      const execute = q => build(q);
      ${functionSource(source, 'build')}
      ${functionSource(source, 'retry')}
      ${functionSource(source, 'reportQueryResult')}
      return { build, retry, report(q, error) { query = q; now = 175; reportQueryResult(error); } };
    `)({ ...hooks, prepare: true }) as {
      build(q: unknown): void;
      retry(q: unknown, error: unknown): void;
      report(q: unknown, error: unknown): void;
    };
    harness.build(original);
    const descriptor = (original as unknown as { resultDiagnostic: unknown }).resultDiagnostic;
    harness.retry(original, { code: '26000' });
    expect((original as unknown as { resultDiagnostic: unknown }).resultDiagnostic).toBe(descriptor);
    expect(descriptor).toMatchObject({ context: captured, queryId: 1, startedAt: 100 });
    harness.report(original, { code: '42P01' });
    expect(pgResultDiagnosticSnapshot('org-app').results[0]).toMatchObject({
      correlationState: 'linked', correlation: first, queryId: 1,
      elapsedMs: 75, status: 'error', errorCode: '42p01',
    });
    expect(capturePgDiagnosticContext().correlation?.rowId).toBe('8');
    await sql.end();
  });
});

describe('pgQueryFamily memo (WI-10002541)', () => {
  const fresh = (q: string) => (' ' + q).slice(1);

  it('classifies each distinct text once across many results on the result path', () => {
    const hooks = createPgDiagnosticHooks('org-app');
    const texts = [
      'SELECT id FROM harness_shared.work_items WHERE workspace_id = $1',
      'INSERT INTO harness_shared.work_items (a, b) VALUES ($1, $2)',
      "UPDATE harness_shared.shared_session_presence SET state = 'live' WHERE owner_id = $1",
    ];
    for (let queryId = 1; queryId <= 300; queryId++) {
      hooks.onresult({ ...completedInput, queryId, query: fresh(texts[queryId % 3]) });
    }
    expect(pgQueryFamilyMemoStats()).toMatchObject({ misses: 3, hits: 297, size: 3, evictions: 0 });
    // Oldest first: queryIds 298, 299, 300 -> texts[1], texts[2], texts[0].
    expect(pgResultDiagnosticSnapshot('org-app', 3).results.map((r) => r.queryFamily)).toEqual([
      'insert:harness_shared.work_items',
      'update:harness_shared.shared_session_presence',
      'select:harness_shared.work_items',
    ]);
  });

  it.each([
    ['SELECT 1', 'select'],
    ['/* select from decoy */ DELETE FROM public.t WHERE a = $1', 'delete:public.t'],
    ["select x from real_table where note = 'from fake_table'", 'select:real_table'],
    ['-- insert decoy\nupdate "T" set a = 1', 'update:t'],
    ['DO $body$ BEGIN PERFORM 1 FROM decoy; END $body$', 'other'],
    ['COPY harness_shared.x FROM STDIN', 'copy:harness_shared.x'],
    ['vacuum analyze', 'other'],
  ])('a remembered family equals the classified one: %s', (sql, expected) => {
    const first = pgQueryFamily(sql);
    const second = pgQueryFamily(fresh(sql));
    expect(first).toBe(expected);
    expect(second).toBe(expected);
    expect(pgQueryFamilyMemoStats()).toMatchObject({ misses: 1, hits: 1 });
  });

  it('is a bounded LRU: the least recently used text is evicted, not a hot one', () => {
    resetPgQueryFamilyMemoForTest({ max: 3 });
    pgQueryFamily('select 1 from a');
    pgQueryFamily('select 1 from b');
    pgQueryFamily('select 1 from c');
    pgQueryFamily('select 1 from a'); // refresh a: b is now the oldest
    pgQueryFamily('select 1 from d');
    expect(pgQueryFamilyMemoStats()).toMatchObject({ size: 3, evictions: 1, misses: 4, hits: 1 });
    pgQueryFamily('select 1 from a');
    expect(pgQueryFamilyMemoStats().hits).toBe(2);
    pgQueryFamily('select 1 from b');
    expect(pgQueryFamilyMemoStats()).toMatchObject({ misses: 5, evictions: 2 });
  });

  it('never remembers an over-long text, but still classifies it', () => {
    const huge = `select * from big_table where id in (${'1,'.repeat(PG_QUERY_FAMILY_MEMO_MAX_TEXT)}1)`;
    expect(pgQueryFamily(huge)).toBe('select:big_table');
    expect(pgQueryFamily(huge)).toBe('select:big_table');
    expect(pgQueryFamilyMemoStats()).toMatchObject({ size: 0, misses: 2, hits: 0 });
  });

  it('exposes counters only, never query text', () => {
    pgQueryFamily(completedInput.query);
    expect(JSON.stringify(pgQueryFamilyMemoStats())).not.toContain('never-retain-secret');
  });
});

describe('failure-only PostgreSQL result diagnostics', () => {
  it('retains failed query phase and safe request context after success churn', () => {
    const correlation = {
      processInstanceId: '11111111-1111-4111-8111-111111111111',
      buildSha: null,
      rowId: null,
      attemptId: '22222222-2222-4222-8222-222222222222',
      hopId: null,
      stage: null,
      boundary: null,
      requestId: '33333333-3333-4333-8333-333333333333',
      operation: 'activity.report',
    };
    const failures = [
      { query: 'BEGIN', command: null, phase: 'transaction-start' },
      { query: "SELECT set_config('app.workspace_id', $1, true)", command: 'SELECT', phase: 'transaction-setup' },
      { query: "INSERT INTO harness_shared.agent_activity (summary) VALUES ('do-not-retain-activity')", command: 'INSERT', phase: 'statement', context: { state: 'linked', correlation } },
      { query: 'COMMIT', command: null, phase: 'transaction-commit' },
      { query: 'ROLLBACK', command: null, phase: 'transaction-rollback' },
    ] as const;
    failures.forEach((failure, index) => {
      recordPgResult('failure-fixture', {
        ...completedInput,
        queryId: index + 1,
        query: failure.query,
        command: failure.command,
        status: 'error',
        errorCode: 'XX000',
        ...('context' in failure ? { context: failure.context } : {}),
      });
    });
    for (let queryId = 1; queryId <= 40; queryId += 1) {
      recordPgResult('failure-fixture', {
        ...completedInput,
        queryId: queryId + 100,
        query: 'SELECT id FROM harness_shared.queue WHERE id = $1',
        command: 'SELECT',
        status: 'ok',
      });
    }

    const snapshot = pgResultDiagnosticSnapshot('failure-fixture', 16);
    expect(snapshot).toMatchObject({ failureCapacity: 16, totalFailures: 5, droppedFailures: 0 });
    expect(snapshot.failures.map((row) => row.failurePhase)).toEqual(
      failures.map((failure) => failure.phase),
    );
    expect(snapshot.failures[2]).toMatchObject({
      queryFamily: 'insert:harness_shared.agent_activity',
      errorCode: 'xx000',
      correlationState: 'linked',
      correlation: { requestId: correlation.requestId, operation: 'activity.report' },
    });
    expect(snapshot.results.map((row) => row.queryId)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 125),
    );
    expect(snapshot.results.every((row) => !('failurePhase' in row))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('do-not-retain-activity');
  });

  it('retains only identifier-shaped PostgreSQL error class and routine labels', () => {
    const registry = registryFromSource();
    registry.recordPgResult('failure-label-fixture', {
      ...completedInput,
      status: 'error',
      errorClass: 'PostgresError',
      serverRoutine: 'AfterTriggerEndSubXact',
    });
    registry.recordPgResult('failure-label-fixture', {
      ...completedInput,
      queryId: 2,
      status: 'error',
      errorClass: 'PostgresError secret=do-not-retain',
      serverRoutine: 'AfterTriggerEndSubXact detail',
    });

    const snapshot = registry.pgResultDiagnosticSnapshot('failure-label-fixture');
    expect(snapshot.failures[0]).toMatchObject({
      errorClass: 'PostgresError',
      serverRoutine: 'AfterTriggerEndSubXact',
    });
    expect(snapshot.failures[1]).toMatchObject({ errorClass: null, serverRoutine: null });
    expect(JSON.stringify(snapshot)).not.toContain('do-not-retain');
  });

  it('bounds failure retention independently and reports evictions', () => {
    for (let queryId = 1; queryId <= 20; queryId += 1) {
      recordPgResult('failure-cap-fixture', {
        ...completedInput,
        queryId,
        query: 'SELECT id FROM harness_shared.queue WHERE id = $1',
        command: 'SELECT',
        status: 'error',
        errorCode: 'XX000',
      });
    }

    const snapshot = pgResultDiagnosticSnapshot('failure-cap-fixture', 32);
    expect(snapshot).toMatchObject({ failureCapacity: 16, totalFailures: 20, droppedFailures: 4 });
    expect(snapshot.failures.map((row) => row.queryId)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 5),
    );
  });
});
