import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { recordDispatchPg } from './dispatches-pg';

describe('dispatches-pg', () => {
  test('recordDispatchPg — issues INSERT with stringified body', async () => {
    const queries: string[] = [];
    const values: unknown[][] = [];
    const pg = async (template: TemplateStringsArray, ...vals: unknown[]) => {
      queries.push(template.join('?'));
      values.push(vals);
      return [];
    };
    await recordDispatchPg(
      { pg, workspaceId: 'default' },
      'parent',
      'child',
      'orchestrator',
      { ok: true, deploymentId: 'abc' },
    );
    assert.equal(queries.length, 1);
    assert.match(queries[0], /INSERT INTO harness_shared\.harness_dispatches/);
    // workspace_id, parent_slug, child_slug, child_role, dispatch_at, body
    assert.equal(values[0][0], 'default');
    assert.equal(values[0][1], 'parent');
    assert.equal(values[0][2], 'child');
    assert.equal(values[0][3], 'orchestrator');
    assert.equal(typeof values[0][4], 'number');
    assert.equal(values[0][5], JSON.stringify({ ok: true, deploymentId: 'abc' }));
  });

  test('recordDispatchPg — accepts string body unchanged', async () => {
    const values: unknown[][] = [];
    const pg = async (template: TemplateStringsArray, ...vals: unknown[]) => {
      values.push(vals);
      return [];
    };
    await recordDispatchPg(
      { pg, workspaceId: 'default' },
      'parent',
      'child',
      null,
      '{"raw":"json"}',
    );
    assert.equal(values[0][5], '{"raw":"json"}');
  });

  test('recordDispatchPg — null body when undefined or null', async () => {
    const values: unknown[][] = [];
    const pg = async (template: TemplateStringsArray, ...vals: unknown[]) => {
      values.push(vals);
      return [];
    };
    await recordDispatchPg({ pg, workspaceId: 'default' }, 'p', 'c', null, undefined);
    await recordDispatchPg({ pg, workspaceId: 'default' }, 'p', 'c', null, null);
    assert.equal(values[0][5], null);
    assert.equal(values[1][5], null);
  });
});
