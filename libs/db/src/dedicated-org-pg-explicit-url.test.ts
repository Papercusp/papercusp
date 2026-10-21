// WI-6554700010018666: createDedicatedOrgPg({ url }) must use the explicit target and
// never consult adminUrl(). A DSN-free process otherwise resolves via the discovery
// file, which on a shared box can belong to a different cluster entirely.
//
// A unit test may not open a real pool: buildClient refuses it (EI-19311807188719573)
// and its refusal names the endpoint it was asked to open. That endpoint is the
// observation, so no connection is ever attempted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDedicatedOrgPg } from './connection';

const ENV_URL = 'postgresql://env_user:env_pw@127.0.0.1:2/env_db';

describe('createDedicatedOrgPg explicit url (WI-6554700010018666)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('targets the explicit url even when the env names another database', () => {
    vi.stubEnv('PAPERCUSP_PGBOUNCER', '0');
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', ENV_URL);
    const explicit = 'postgresql://explicit_user:explicit_pw@127.0.0.1:1/explicit_db';
    expect(() => createDedicatedOrgPg('explicit-url-test', { max: 1, url: explicit })).toThrow(
      /org-admin-explicit-url-test.*127\.0\.0\.1:1\/explicit_db/,
    );
  });

  it('treats a blank url as absent and resolves through adminUrl()', () => {
    vi.stubEnv('PAPERCUSP_PGBOUNCER', '0');
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', ENV_URL);
    expect(() => createDedicatedOrgPg('explicit-url-blank-test', { max: 1, url: '  ' })).toThrow(
      /org-admin-explicit-url-blank-test.*127\.0\.0\.1:2\/env_db/,
    );
  });
});
