import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { recordRunOutputPg, readRunOutputPg } from './run-output-pg';
import type { OrchestratorPg } from './invoke';

interface MockState {
  rows: Array<Record<string, unknown>>;
  queries: string[];
  values: unknown[][];
}

function makeMockPg(initialRows: Array<Record<string, unknown>> = []): {
  // See run-chunks-pg.test.ts: OrchestratorPg is generic, so a concrete mock is declared as
  // the seam type and cast once at the return.
  pg: OrchestratorPg;
  state: MockState;
} {
  const state: MockState = { rows: [...initialRows], queries: [], values: [] };
  const pg = async (template: TemplateStringsArray, ...vals: unknown[]) => {
    const sql = template.join('?');
    state.queries.push(sql);
    state.values.push(vals);
    if (/INSERT INTO harness_shared\.harness_run_output/.test(sql)) {
      const [
        workspace_id, harness_slug, run_id, role,
        prompt_body, jsonl_body, out_body, err_body,
        exit_code, duration_ms, started_at, ended_at,
      ] = vals;
      const existing = state.rows.find((r) => r.run_id === run_id);
      const row = {
        workspace_id, harness_slug, run_id, role,
        prompt_body, jsonl_body, out_body, err_body,
        exit_code, duration_ms, started_at, ended_at,
      };
      if (existing) Object.assign(existing, row); else state.rows.push(row);
      return [];
    }
    if (/SELECT run_id, role.*FROM harness_shared\.harness_run_output/s.test(sql)) {
      const runId = vals[2];
      const r = state.rows.find((x) => x.run_id === runId);
      return r ? [r] : [];
    }
    return [];
  };
  return { pg: pg as unknown as OrchestratorPg, state };
}

const ctx = (mock: ReturnType<typeof makeMockPg>) => ({
  pg: mock.pg,
  workspaceId: 'default',
  harnessSlug: 'sheets',
});

describe('run-output-pg', () => {
  test('recordRunOutputPg — INSERTs all body fields + metadata', async () => {
    const mock = makeMockPg();
    await recordRunOutputPg(ctx(mock), {
      runId: 'r1',
      role: 'worker',
      promptBody: '',
      jsonlBody: '{"type":"result"}',
      outBody: 'final text',
      errBody: 'warn: foo',
      exitCode: 0,
      durationMs: 5000,
      startedAt: 1000,
      endedAt: 6000,
    });
    assert.equal(mock.state.rows.length, 1);
    const r = mock.state.rows[0];
    assert.equal(r.run_id, 'r1');
    assert.equal(r.role, 'worker');
    assert.equal(r.jsonl_body, '{"type":"result"}');
    assert.equal(r.out_body, 'final text');
    assert.equal(r.err_body, 'warn: foo');
    assert.equal(r.exit_code, 0);
    assert.equal(r.duration_ms, 5000);
  });

  test('readRunOutputPg — round-trips a recorded row', async () => {
    const mock = makeMockPg();
    await recordRunOutputPg(ctx(mock), {
      runId: 'r2',
      role: 'validator',
      promptBody: '',
      jsonlBody: 'jsonl',
      outBody: 'out',
      errBody: 'err',
      exitCode: 1,
      durationMs: 2000,
      startedAt: 100,
      endedAt: 2100,
    });
    const row = await readRunOutputPg(ctx(mock), 'r2');
    assert.ok(row);
    assert.equal(row!.role, 'validator');
    assert.equal(row!.exitCode, 1);
    assert.equal(row!.durationMs, 2000);
  });

  test('readRunOutputPg — returns null when absent', async () => {
    const mock = makeMockPg();
    const row = await readRunOutputPg(ctx(mock), 'nonexistent');
    assert.equal(row, null);
  });

  test('recordRunOutputPg — clamps oversized body to 10MB with truncation marker', async () => {
    const mock = makeMockPg();
    const huge = 'a'.repeat(15 * 1024 * 1024);
    await recordRunOutputPg(ctx(mock), {
      runId: 'big',
      role: null,
      promptBody: '',
      jsonlBody: huge,
      outBody: '',
      errBody: '',
      exitCode: 0,
      durationMs: 0,
      startedAt: 0,
      endedAt: 0,
    });
    const written = mock.state.rows[0].jsonl_body as string;
    // Clamped at 10MB + a truncation suffix
    assert.ok(written.length < huge.length);
    assert.ok(written.length >= 10 * 1024 * 1024);
    assert.match(written, /\[truncated/);
  });

  test('recordRunOutputPg — preserves prompt body (Phase 5 ephemeral file is gone after run)', async () => {
    const mock = makeMockPg();
    const promptText = 'Role: scoper\n\nMission: build X\n\n[memory excerpt]';
    await recordRunOutputPg(ctx(mock), {
      runId: 'r-prompt', role: 'scoper', promptBody: promptText,
      jsonlBody: '', outBody: '', errBody: '',
      exitCode: 0, durationMs: 100, startedAt: 1, endedAt: 101,
    });
    assert.equal(mock.state.rows[0].prompt_body, promptText);
    const round = await readRunOutputPg(ctx(mock), 'r-prompt');
    assert.equal(round!.promptBody, promptText);
  });

  test('recordRunOutputPg — second call with same run_id updates the row', async () => {
    const mock = makeMockPg();
    await recordRunOutputPg(ctx(mock), {
      runId: 'r3', role: 'a', promptBody: '',
      jsonlBody: 'first', outBody: '', errBody: '',
      exitCode: 0, durationMs: 0, startedAt: 0, endedAt: 0,
    });
    await recordRunOutputPg(ctx(mock), {
      runId: 'r3', role: 'b', promptBody: '',
      jsonlBody: 'second', outBody: '', errBody: '',
      exitCode: 1, durationMs: 100, startedAt: 0, endedAt: 100,
    });
    assert.equal(mock.state.rows.length, 1);
    assert.equal(mock.state.rows[0].role, 'b');
    assert.equal(mock.state.rows[0].jsonl_body, 'second');
  });
});
