/**
 * withWorkspaceLegacy — unit tests for the WI-4995(a) PgBouncer-routing
 * decision, with fully mocked `./connection` + `./workspace-context` (no DB
 * needed). Proves the actual code-path branch: which underlying primitive
 * gets called for each (slug, pgbouncerEnabled) combination. See
 * legacy-shim-workspace.integration.test.ts for the real-Postgres proof that
 * the resulting search_path + app.workspace_id resolve correctly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const h = vi.hoisted(() => ({
  pgbouncerEnabled: vi.fn(() => false),
  getHarnessPgBegin: vi.fn(),
  getOrgPgBegin: vi.fn(),
  withHarnessSchema: vi.fn(),
}));

vi.mock('./connection', () => ({
  pgbouncerEnabled: h.pgbouncerEnabled,
  getHarnessPg: () => ({ sql: { begin: h.getHarnessPgBegin } }),
  getOrgPg: () => ({ sql: { begin: h.getOrgPgBegin } }),
}));

vi.mock('./workspace-context', () => ({
  withHarnessSchema: h.withHarnessSchema,
}));

import { withWorkspaceLegacy } from './legacy-shim';

// A fake tx: callable as a tagged-template ( txSql`...` compiles to txSql(strings, ...vals) ),
// matching workspace-context.test.ts's fake.
function fakeTxSql(): Sql {
  return (async () => []) as unknown as Sql;
}

describe('withWorkspaceLegacy — PgBouncer routing decision (WI-4995a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.pgbouncerEnabled.mockReturnValue(false);
  });

  it('routes through withHarnessSchema (the harnessQuery chokepoint) when slug is given AND pgbouncerEnabled()', async () => {
    h.pgbouncerEnabled.mockReturnValue(true);
    h.withHarnessSchema.mockImplementation(async (_slug: string, fn: (tx: Sql) => Promise<unknown>) => fn(fakeTxSql()));

    const out = await withWorkspaceLegacy('myharness', 'ws-1', async () => 'ok');

    expect(out).toBe('ok');
    expect(h.withHarnessSchema).toHaveBeenCalledTimes(1);
    expect(h.withHarnessSchema.mock.calls[0]![0]).toBe('myharness');
    expect(h.getHarnessPgBegin).not.toHaveBeenCalled();
    expect(h.getOrgPgBegin).not.toHaveBeenCalled();
  });

  it('uses the direct getHarnessPg(slug) connection when pgbouncer is disabled (byte-identical to before the fix)', async () => {
    h.pgbouncerEnabled.mockReturnValue(false);
    h.getHarnessPgBegin.mockImplementation(async (cb: (tx: Sql) => Promise<unknown>) => cb(fakeTxSql()));

    const out = await withWorkspaceLegacy('myharness', 'ws-1', async () => 'ok');

    expect(out).toBe('ok');
    expect(h.getHarnessPgBegin).toHaveBeenCalledTimes(1);
    expect(h.withHarnessSchema).not.toHaveBeenCalled();
  });

  it('uses the direct getOrgPg() admin connection when slug is undefined, regardless of pgbouncerEnabled() (WI-4995c: no harnessQuery equivalent for cross-harness admin)', async () => {
    h.pgbouncerEnabled.mockReturnValue(true);
    h.getOrgPgBegin.mockImplementation(async (cb: (tx: Sql) => Promise<unknown>) => cb(fakeTxSql()));

    const out = await withWorkspaceLegacy(undefined, 'ws-1', async () => 'ok');

    expect(out).toBe('ok');
    expect(h.getOrgPgBegin).toHaveBeenCalledTimes(1);
    expect(h.withHarnessSchema).not.toHaveBeenCalled();
    expect(h.getHarnessPgBegin).not.toHaveBeenCalled();
  });
});
