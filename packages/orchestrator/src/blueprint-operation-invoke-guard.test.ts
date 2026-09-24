import { describe, expect, it, vi } from 'vitest';
import { assertNoUnboundAcceptedOperation } from './blueprint-operation-invoke-guard';

const base = { workspaceId: 'ws-a', harnessSlug: 'sales', featureId: 'WI-1' };

function pg(rows: Array<{ payload: unknown }>) {
  return vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => rows) as never;
}

describe('accepted operation autonomous invoke guard', () => {
  it('allows an ordinary work item and an absent item', async () => {
    await expect(assertNoUnboundAcceptedOperation({ ...base, pg: pg([{ payload: {} }]) })).resolves.toBeUndefined();
    await expect(assertNoUnboundAcceptedOperation({ ...base, pg: pg([]) })).resolves.toBeUndefined();
  });

  it('refuses any accepted operation marker before a legacy worker can spawn', async () => {
    for (const marker of [{ kind: 'blueprint-operation' }, null]) {
      await expect(assertNoUnboundAcceptedOperation({
        ...base, pg: pg([{ payload: { blueprintOperation: marker } }]),
      })).rejects.toThrow('requires an identity-bound worker launch');
    }
  });

  it('does not guess authorization when the canonical work-item read fails', async () => {
    const failed = vi.fn(async () => { throw new Error('database unavailable'); }) as never;
    await expect(assertNoUnboundAcceptedOperation({ ...base, pg: failed }))
      .rejects.toThrow('database unavailable');
  });
});
