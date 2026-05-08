import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  readMissionState,
  setEscalationPg,
  setCostWarnFiredPg,
  readCostWarnFiredPg,
  setReadyForProdPg,
  persistLanesPg,
} from './mission-state-pg';

function makeMockPg(initialRow: Record<string, unknown> | null = null): {
  pg: (template: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
  queries: string[];
  values: unknown[][];
  row: Record<string, unknown> | null;
} {
  const queries: string[] = [];
  const values: unknown[][] = [];
  let row = initialRow;
  return {
    get row() { return row; },
    pg: async (template, ...vals) => {
      const sql = template.join('?');
      queries.push(sql);
      values.push(vals);
      // Mock UPSERT: write the row in-memory so subsequent SELECTs see it
      if (/INSERT INTO harness_shared\.harness_mission_state/.test(sql)) {
        const newRow = { ...(row ?? {}) };
        // Find which column is being upserted by sniffing the column list
        const colMatch = sql.match(/\(\s*workspace_id, harness_slug([^)]+)\)/);
        if (colMatch) {
          const cols = colMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
          // vals = [workspaceId, slug, ...col-values..., updated_at]
          // The cols here exclude workspace_id, harness_slug
          for (let i = 0; i < cols.length; i++) {
            newRow[cols[i]] = vals[2 + i];
          }
        }
        row = newRow;
        return [];
      }
      // Mock SELECTs
      if (/SELECT cost_warn_fired/.test(sql)) {
        if (!row) return [];
        return [{ cost_warn_fired: row.cost_warn_fired === true }];
      }
      if (/SELECT escalation_md, cost_warn_fired/.test(sql)) {
        if (!row) return [];
        return [{
          escalation_md: row.escalation_md ?? null,
          cost_warn_fired: row.cost_warn_fired === true,
          ready_for_prod_at: row.ready_for_prod_at ?? null,
          lanes: row.lanes ?? [],
        }];
      }
      return [];
    },
    queries,
    values,
    row,
  };
}

const ctxOf = (mock: ReturnType<typeof makeMockPg>) => ({
  pg: mock.pg,
  workspaceId: 'default',
  harnessSlug: 'sheets',
});

describe('mission-state-pg', () => {
  test('readMissionState — returns empty defaults when no row', async () => {
    const mock = makeMockPg(null);
    const state = await readMissionState(ctxOf(mock));
    assert.equal(state.escalationMd, null);
    assert.equal(state.costWarnFired, false);
    assert.equal(state.readyForProdAt, null);
    assert.deepEqual(state.lanes, []);
  });

  test('setEscalationPg — issues UPSERT with escalation_md', async () => {
    const mock = makeMockPg();
    await setEscalationPg(ctxOf(mock), '# rejected\n');
    assert.equal(mock.queries.length, 1);
    assert.match(mock.queries[0], /INSERT INTO harness_shared\.harness_mission_state/);
    assert.match(mock.queries[0], /escalation_md/);
    assert.equal(mock.values[0][2], '# rejected\n');
  });

  test('setCostWarnFiredPg — issues UPSERT with cost_warn_fired set to true literal', async () => {
    const mock = makeMockPg();
    await setCostWarnFiredPg(ctxOf(mock));
    // The boolean `true` is a SQL literal in the query, not an interpolated
    // parameter — vals are just (workspace, slug, updated_at). We assert
    // the right columns appear in the SQL and the timestamp parameter is
    // a number.
    assert.match(mock.queries[0], /cost_warn_fired = true/);
    assert.equal(mock.values[0][0], 'default');
    assert.equal(mock.values[0][1], 'sheets');
    assert.equal(typeof mock.values[0][2], 'number');
  });

  test('readCostWarnFiredPg — returns boolean from row when present', async () => {
    const empty = makeMockPg();
    assert.equal(await readCostWarnFiredPg(ctxOf(empty)), false);
    const populated = makeMockPg({ cost_warn_fired: true });
    assert.equal(await readCostWarnFiredPg(ctxOf(populated)), true);
  });

  test('setReadyForProdPg — issues UPSERT with current epoch ms', async () => {
    const mock = makeMockPg();
    const before = Date.now();
    await setReadyForProdPg(ctxOf(mock));
    const after = Date.now();
    assert.match(mock.queries[0], /ready_for_prod_at/);
    const writtenTs = mock.values[0][2] as number;
    assert.ok(writtenTs >= before && writtenTs <= after, `${writtenTs} should be in [${before}, ${after}]`);
  });

  test('persistLanesPg — issues UPSERT with stringified JSON lanes array', async () => {
    const mock = makeMockPg();
    await persistLanesPg(ctxOf(mock), [
      { id: 1, feature_id: 'F-001', started_at: 1000 },
      { id: 2, feature_id: 'F-002', started_at: 2000 },
    ]);
    assert.match(mock.queries[0], /lanes/);
    const written = mock.values[0][2] as string;
    const parsed = JSON.parse(written) as Array<{ id: number; feature_id: string }>;
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].feature_id, 'F-001');
  });

  test('readMissionState — returns row data when present', async () => {
    const mock = makeMockPg({
      escalation_md: '# escalated',
      cost_warn_fired: true,
      ready_for_prod_at: 1234567890000,
      lanes: [{ id: 1, feature_id: 'F-001', started_at: 100 }],
    });
    const state = await readMissionState(ctxOf(mock));
    assert.equal(state.escalationMd, '# escalated');
    assert.equal(state.costWarnFired, true);
    assert.equal(state.readyForProdAt, 1234567890000);
    assert.equal(state.lanes.length, 1);
  });
});
