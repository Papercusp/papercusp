import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fetchFeatureHistory } from './feature-history';

/**
 * Mock pg tagged-template that returns canned rows by query shape.
 * Each call resolves with the row array set by `mock.next(rows)` —
 * if no rows are queued for a particular call, returns []. Order:
 *   1st call → notes
 *   2nd call → debug
 *   3rd call → audit
 */
function mockPg(notes: unknown[] = [], debug: unknown[] = [], audit: unknown[] = []) {
  const queue = [notes, debug, audit];
  const calls: string[] = [];
  const fn = ((tpl: TemplateStringsArray, ..._values: unknown[]) => {
    calls.push(tpl.join('?'));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as Parameters<typeof fetchFeatureHistory>[0]['pg'];
  return { pg: fn, calls };
}

test('fetchFeatureHistory — empty without pg returns ""', async () => {
  const out = await fetchFeatureHistory({ harnessSlug: 'sheets', featureId: 'F-001' });
  assert.equal(out, '');
});

test('fetchFeatureHistory — empty without workspaceId returns ""', async () => {
  const { pg } = mockPg();
  const out = await fetchFeatureHistory({ pg, harnessSlug: 'sheets', featureId: 'F-001' });
  assert.equal(out, '');
});

test('fetchFeatureHistory — only notes present renders notes section', async () => {
  const { pg } = mockPg(
    [{ content: 'Use bcrypt cost=12.', updated_at: 1700000000000 }],
    [],
    [],
  );
  const out = await fetchFeatureHistory({
    pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-AUTH-001',
  });
  assert.match(out, /## This feature's history \(F-AUTH-001\)/);
  assert.match(out, /### Notes/);
  assert.match(out, /Use bcrypt cost=12\./);
  assert.equal(out.includes('### Debugger findings'), false);
  assert.equal(out.includes('### Recent activity'), false);
});

test('fetchFeatureHistory — all three sections render in order', async () => {
  const { pg } = mockPg(
    [{ content: 'note body', updated_at: 1 }],
    [{ content: 'debugger output', mtime_ms: 2 }],
    [
      { ts: 1700000000000, field: 'status', old_value: '"todo"', new_value: '"in_progress"', actor: 'worker' },
      { ts: 1700000060000, field: 'attempts', old_value: '1', new_value: '2', actor: 'orchestrator' },
    ],
  );
  const out = await fetchFeatureHistory({
    pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-001',
  });
  const notesIdx = out.indexOf('### Notes');
  const debugIdx = out.indexOf('### Debugger findings');
  const auditIdx = out.indexOf('### Recent activity');
  assert.ok(notesIdx >= 0 && debugIdx > notesIdx && auditIdx > debugIdx, 'sections in order');
  assert.match(out, /`status` todo → in_progress/);
  assert.match(out, /`attempts` 1 → 2/);
  assert.match(out, /\(worker\)/);
});

test('fetchFeatureHistory — caps notes content', async () => {
  const big = 'x'.repeat(10_000);
  const { pg } = mockPg([{ content: big, updated_at: 1 }], [], []);
  const out = await fetchFeatureHistory({
    pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-001',
    notesMaxChars: 100,
  });
  assert.ok(out.includes('truncated'), 'truncation marker present');
  // Check the rendered notes body is shorter than the original.
  assert.ok(out.length < 10_000);
});

test('fetchFeatureHistory — empty audit + empty notes + empty debug returns ""', async () => {
  const { pg } = mockPg([], [], []);
  const out = await fetchFeatureHistory({
    pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-001',
  });
  assert.equal(out, '');
});

test('fetchFeatureHistory — pg query errors surface as empty section, not throw', async () => {
  const failingPg = ((_tpl: TemplateStringsArray, ..._v: unknown[]) =>
    Promise.reject(new Error('pg blew up'))) as unknown as Parameters<typeof fetchFeatureHistory>[0]['pg'];
  const out = await fetchFeatureHistory({
    pg: failingPg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-001',
  });
  assert.equal(out, '');
});

test('fetchFeatureHistory — audit row count cap honored', async () => {
  const auditRows = Array.from({ length: 50 }, (_, i) => ({
    ts: 1700000000000 + i * 1000,
    field: 'status',
    old_value: '"a"',
    new_value: '"b"',
    actor: 'worker',
  }));
  const { pg } = mockPg([], [], auditRows.slice(0, 5));
  const out = await fetchFeatureHistory({
    pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-001',
    auditRows: 5,
  });
  // 5 bullets in the audit section
  const matches = out.match(/^- \d{4}-\d{2}-\d{2}T/gm) ?? [];
  assert.equal(matches.length, 5);
});

test('fetchFeatureHistory — section header includes feature id verbatim', async () => {
  const { pg } = mockPg([{ content: 'x', updated_at: 1 }], [], []);
  const out = await fetchFeatureHistory({
    pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-VERY-SPECIFIC-007',
  });
  assert.match(out, /## This feature's history \(F-VERY-SPECIFIC-007\)/);
});

/**
 * Related-features mock — needs SIX pg calls in order:
 *   1. notes
 *   2. debug
 *   3. audit
 *   4. fetchRelatedFeatures source lookup (tags + see_also)
 *   5. fetchRelatedFeatures related rows
 *   (.unsafe() for messages — separate mock attribute)
 * (Promise.all runs the parallel set, but the related fetch internally
 * awaits two queries sequentially.)
 */
function mockPgWithRelated(
  notes: unknown[],
  debug: unknown[],
  audit: unknown[],
  src: unknown[],
  related: unknown[],
  messages: unknown[] = [],
) {
  const queue: unknown[][] = [notes, debug, audit, src, related];
  const fn = ((_tpl: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.resolve(queue.shift() ?? [])) as unknown as Parameters<typeof fetchFeatureHistory>[0]['pg'] & {
      unsafe?: (q: string, p?: unknown[]) => Promise<unknown[]>;
    };
  // Attach unsafe for the feature-messages branch.
  (fn as unknown as { unsafe: (q: string, p?: unknown[]) => Promise<unknown[]> }).unsafe = (
    _q: string, _p?: unknown[],
  ) => Promise.resolve(messages);
  return fn;
}

test('fetchFeatureHistory — Related features section renders when src has tags', async () => {
  const pg = mockPgWithRelated(
    [],
    [],
    [],
    [{ tags: ['auth', 'security'], see_also: [] }],
    [
      { feature_id: 'F-AUTH-002', title: 'login flow', status: 'passed', tags: ['auth'], relation_kind: 'tag' },
      { feature_id: 'F-PROF-001', title: 'profile page', status: 'todo', tags: ['security'], relation_kind: 'tag' },
    ],
  );
  const out = await fetchFeatureHistory({
    pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-AUTH-001',
  });
  assert.match(out, /### Related features/);
  assert.match(out, /F-AUTH-002.*login flow.*\(tag\)/);
  assert.match(out, /F-PROF-001.*profile page.*\(tag\)/);
});

test('fetchFeatureHistory — empty src tags+see_also skips related', async () => {
  const pg = mockPgWithRelated(
    [{ content: 'note', updated_at: 1 }],
    [],
    [],
    [{ tags: [], see_also: [] }],
    [],
  );
  const out = await fetchFeatureHistory({
    pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-X',
  });
  assert.equal(out.includes('### Related features'), false);
});

test('fetchFeatureHistory — see_also relation rendered with tag', async () => {
  const pg = mockPgWithRelated(
    [], [], [],
    [{ tags: [], see_also: ['F-CHILD'] }],
    [{ feature_id: 'F-CHILD', title: 'sub feature', status: 'passed', tags: [], relation_kind: 'see_also' }],
  );
  const out = await fetchFeatureHistory({
    pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-PARENT',
  });
  assert.match(out, /F-CHILD.*\(see-also\)/);
});

test('fetchFeatureHistory — Messages from other features section renders', async () => {
  const pg = mockPgWithRelated(
    [], [], [],
    [{ tags: [], see_also: [] }],
    [],
    [
      {
        id: 'msg-1',
        created_at: new Date('2026-05-09T01:00:00Z'),
        from_slug: 'sheets',
        from_feature_id: 'F-PROFILE-002',
        kind: 'feature-note',
        subject: 'Need getUserById',
        body: 'Please expose a getUserById helper that returns the user by id.',
      },
    ],
  );
  const out = await fetchFeatureHistory({
    pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-AUTH-005',
  });
  assert.match(out, /### Messages from other features/);
  assert.match(out, /from `sheets\/F-PROFILE-002`/);
  assert.match(out, /\[feature-note\]/);
  assert.match(out, /Need getUserById/);
});

test('fetchFeatureHistory — empty messages skip section', async () => {
  const pg = mockPgWithRelated(
    [{ content: 'note', updated_at: 1 }], [], [], [{ tags: [], see_also: [] }], [], []
  );
  const out = await fetchFeatureHistory({
    pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-X',
  });
  assert.equal(out.includes('### Messages from other features'), false);
});

test('fetchFeatureHistory — message body capped at 400 chars', async () => {
  const huge = 'X'.repeat(2000);
  const pg = mockPgWithRelated(
    [], [], [], [{ tags: [], see_also: [] }], [],
    [{
      id: 'msg-big',
      created_at: '2026-05-09T01:00:00.000Z',
      from_slug: 'sheets',
      from_feature_id: null,
      kind: 'note',
      subject: 'long',
      body: huge,
    }],
  );
  const out = await fetchFeatureHistory({
    pg, workspaceId: 'default', harnessSlug: 'sheets', featureId: 'F-X',
  });
  // The message body line should not contain the full 2000-char body.
  // We check the message section is bounded.
  const start = out.indexOf('### Messages from other features');
  assert.ok(start >= 0);
  const messagesSection = out.slice(start);
  assert.ok(messagesSection.length < 600, `messages section too long: ${messagesSection.length} chars`);
});
