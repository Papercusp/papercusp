/**
 * WI-10000316: terminal postgres.js results remain attributable without
 * retaining SQL parameters, row contents, or unbounded history.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import postgres from 'postgres';
import {
  pgResultDiagnosticSnapshot,
  recordPgResult,
  capturePgDiagnosticContext,
  createPgDiagnosticHooks,
  resetPgDiagnosticContextResolver,
  resetAcquireRegistryForTest,
  setPgDiagnosticContextResolver,
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
const BUILD_ROOTS = ['src', 'cjs/src', 'cf/src'].filter((rel) =>
  fs.existsSync(path.join(PG_ROOT, rel, 'connection.js')),
);

function functionSource(source: string, name: string): string {
  const match = source.match(
    new RegExp(`^ {2}function ${name}\\([^)]*\\) \\{[\\s\\S]+?^ {2}\\}`, 'm'),
  );
  expect(match, `postgres source must declare ${name}`).toBeTruthy();
  return match![0];
}

function instantiateReporter(
  declaration: string,
  onresult: (value: Record<string, unknown>) => void,
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
  });
}

beforeEach(() => {
  resetPgDiagnosticContextResolver();
  resetAcquireRegistryForTest();
});

describe('postgres.js terminal result diagnostics patch', () => {
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
    }
    expect(patch).toContain('node_modules/postgres/types/index.d.ts');
    expect(patch).toContain('PAPERCUSP PATCH (WI-10000316)');
    expect(patch).toContain('interface QueryResultDiagnostic');
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
    report({ code: '42P01' });
    expect(seen[0]).toMatchObject({ status: 'error', errorCode: '42P01', queryId: 23 });

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
