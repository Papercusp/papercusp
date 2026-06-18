/**
 * Unit tests for the pure connection-routing helper `maybePgbouncer` — C2 of
 * backend-connection-scaling-2026-06-17. No Postgres needed: importing
 * ./connection does not open a connection (all pools are lazy).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { maybePgbouncer } from './connection';

const DIRECT = 'postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp';

const saved = {
  on: process.env.PAPERCUSP_PGBOUNCER,
  port: process.env.PAPERCUSP_PGBOUNCER_PORT,
};
afterEach(() => {
  if (saved.on === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
  else process.env.PAPERCUSP_PGBOUNCER = saved.on;
  if (saved.port === undefined) delete process.env.PAPERCUSP_PGBOUNCER_PORT;
  else process.env.PAPERCUSP_PGBOUNCER_PORT = saved.port;
});

describe('maybePgbouncer', () => {
  it('returns the URL untouched when PAPERCUSP_PGBOUNCER is unset (default)', () => {
    delete process.env.PAPERCUSP_PGBOUNCER;
    expect(maybePgbouncer(DIRECT)).toBe(DIRECT);
  });

  it('routes to 127.0.0.1:6432 when enabled, preserving credentials + database', () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    delete process.env.PAPERCUSP_PGBOUNCER_PORT;
    const out = maybePgbouncer(DIRECT);
    expect(out).toBe('postgresql://harness_app:harness_app_pwd@127.0.0.1:6432/papercusp');
  });

  it('honors PAPERCUSP_PGBOUNCER_PORT', () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    process.env.PAPERCUSP_PGBOUNCER_PORT = '7000';
    expect(maybePgbouncer(DIRECT)).toContain('@127.0.0.1:7000/');
  });

  it('only rewrites for the exact flag value "1"', () => {
    process.env.PAPERCUSP_PGBOUNCER = 'true';
    expect(maybePgbouncer(DIRECT)).toBe(DIRECT);
  });

  it('leaves an unparseable URL untouched (never throws)', () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    expect(maybePgbouncer('not a url')).toBe('not a url');
  });
});
