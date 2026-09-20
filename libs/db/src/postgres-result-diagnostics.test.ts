/**
 * WI-10000316: terminal postgres.js results remain attributable without
 * retaining SQL parameters, row contents, or unbounded history.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import {
  pgResultDiagnosticSnapshot,
  recordPgResult,
  capturePgDiagnosticContext,
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

  it('captures correlation at debug/query-build time without changing the maintained result callback', () => {
    const correlation = {
      processInstanceId: '11111111-1111-4111-8111-111111111111',
      buildSha: null,
      rowId: '7',
      attemptId: '22222222-2222-4222-8222-222222222222',
      hopId: 1,
      stage: 'epoch-query',
      boundary: 'await' as const,
    };
    setPgDiagnosticContextResolver(() => correlation);
    const source = fs.readFileSync(path.join(PG_ROOT, 'src/connection.js'), 'utf8');
    const build = functionSource(source, 'build');
    expect(build).toContain('q.resultDiagnostic = q.resultDiagnostic ||');
    // The maintained patch owns queryId assignment and invokes debug only after
    // the descriptor exists; connection.ts folds that identity into the local
    // bounded correlation map.
    expect(source).toContain('options.debug(id, string, parameters, types, q.resultDiagnostic.queryId)');
    expect(build).toContain('q.resultDiagnostic.context');
    expect(source).toContain('options.onresult({');
    expect(correlation.stage).toBe('epoch-query');
  });
});
