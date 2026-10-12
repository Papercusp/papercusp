import { afterEach, describe, expect, it, vi } from 'vitest';

// Construct real lazy postgres-js clients, but intercept the identity probe so
// this routing test never opens a socket. Serializer repairs still run normally.
vi.mock('postgres', async (importOriginal) => {
  const { default: postgres } = await importOriginal<typeof import('postgres')>();
  return { default: vi.fn((...args: Parameters<typeof postgres>) => {
    const sql = postgres(...args);
    sql.unsafe = vi.fn().mockResolvedValue([]);
    return sql;
  }) };
});

import { createDedicatedOrgPg, _resetUrlCacheForTests } from './connection';

afterEach(() => { vi.unstubAllEnvs(); _resetUrlCacheForTests(); });

describe('dedicated org client session affinity', () => {
  it('keeps ordinary clients pooled but session-affine clients direct with session GUCs', async () => {
    vi.stubEnv('PAPERCUSP_FORBID_REAL_PG', '0');
    vi.stubEnv('PAPERCUSP_FORBID_LIVE_PG', '0');
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgres://fixture:fixture@localhost:5432/fixture');
    vi.stubEnv('PAPERCUSP_PGBOUNCER', '1');
    vi.stubEnv('PAPERCUSP_PGBOUNCER_PORT', '6432');
    _resetUrlCacheForTests();
    const pooled = createDedicatedOrgPg('pooled-control', { max: 1 });
    const direct = createDedicatedOrgPg('session-proof', { max: 1, sessionAffinity: true });
    try {
      expect(new URL(pooled.url).port).toBe('6432');
      expect(new URL(direct.url).port).toBe('5432');
      expect(pooled.sql.options.connection).not.toHaveProperty('idle_in_transaction_session_timeout');
      expect(direct.sql.options.connection).toHaveProperty('idle_in_transaction_session_timeout');
      expect(direct.sql.options.max).toBe(1);
    } finally {
      await Promise.all([pooled.sql.end({ timeout: 1 }), direct.sql.end({ timeout: 1 })]);
    }
  });
});
