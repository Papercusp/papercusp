import { describe, test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { bootstrapOrchestratorPg } from './pg-bootstrap';

const ORIGINAL_ENV = process.env.PAPERCUSP_USE_PG_STATE;
const ORIGINAL_DSN = process.env.PAPERCUSP_DATABASE_URL;

beforeEach(() => {
  delete process.env.PAPERCUSP_USE_PG_STATE;
  delete process.env.PAPERCUSP_DATABASE_URL;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAPERCUSP_USE_PG_STATE;
  else process.env.PAPERCUSP_USE_PG_STATE = ORIGINAL_ENV;
  if (ORIGINAL_DSN === undefined) delete process.env.PAPERCUSP_DATABASE_URL;
  else process.env.PAPERCUSP_DATABASE_URL = ORIGINAL_DSN;
});

describe('bootstrapOrchestratorPg', () => {
  test('opted-out — env var unset returns null pg + opted-out reason + logs warning', async () => {
    const log: string[] = [];
    const r = await bootstrapOrchestratorPg((m) => log.push(m));
    assert.equal(r.pg, null);
    assert.equal(r.cleanup, null);
    assert.equal(r.reason, 'opted-out');
    // Was previously silent; now logs a loud warning because the
    // in-memory fallback is test-only and silently breaks pre-loop.
    assert.ok(
      log.some((l) => /PAPERCUSP_USE_PG_STATE/.test(l)),
      'opted-out path should warn about empty in-memory state',
    );
  });

  test('opted-out — env var === "0" returns null pg', async () => {
    process.env.PAPERCUSP_USE_PG_STATE = '0';
    const r = await bootstrapOrchestratorPg(() => {});
    assert.equal(r.pg, null);
    assert.equal(r.reason, 'opted-out');
  });

  test('connection-failed — opt-in but unreachable DSN logs + returns null', async () => {
    process.env.PAPERCUSP_USE_PG_STATE = '1';
    // Use a port nothing is listening on; postgres-js's connect_timeout: 5
    // will fail this within seconds, not minutes.
    process.env.PAPERCUSP_DATABASE_URL =
      'postgresql://nope:nope@127.0.0.1:1/nope_db';
    const log: string[] = [];
    const r = await bootstrapOrchestratorPg((m) => log.push(m));
    assert.equal(r.pg, null);
    assert.equal(r.cleanup, null);
    assert.match(r.reason, /failed/);
    assert.ok(log.some((l) => l.startsWith('PG bootstrap:')));
    assert.ok(log.some((l) => l.includes('falling back to FS')));
  }, 15_000);
});
