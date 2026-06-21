/**
 * Unit tests for the connection-routing helpers `pgbouncerEnabled` (P-004) +
 * `maybePgbouncer` (C2) — backend-connection-scaling-2026-06-17. No Postgres
 * needed: importing ./connection does not open a connection (all pools are lazy).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// pgbouncerEnabled() consults getResourceProfile().hostClass for the default
// (unset-env) case. Mock it so the default is deterministic regardless of the
// test host's core count. Same module specifier connection.ts imports.
const mockProfile = vi.hoisted(() => ({ hostClass: 'server' as 'server' | 'workstation' | 'laptop' }));
vi.mock('../../../../../packages/operator-core/lib/resource-profile', () => ({
  getResourceProfile: () => ({ hostClass: mockProfile.hostClass }),
}));

import { maybePgbouncer, pgbouncerEnabled } from './connection';

const DIRECT = 'postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp';
const POOLED = 'postgresql://harness_app:harness_app_pwd@127.0.0.1:6432/papercusp';

const saved = {
  on: process.env.PAPERCUSP_PGBOUNCER,
  port: process.env.PAPERCUSP_PGBOUNCER_PORT,
};
afterEach(() => {
  if (saved.on === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
  else process.env.PAPERCUSP_PGBOUNCER = saved.on;
  if (saved.port === undefined) delete process.env.PAPERCUSP_PGBOUNCER_PORT;
  else process.env.PAPERCUSP_PGBOUNCER_PORT = saved.port;
  mockProfile.hostClass = 'server';
});

describe('pgbouncerEnabled — P-004 default-on for server-class native PG', () => {
  it('defaults ON when env is unset and the host is server-class', () => {
    delete process.env.PAPERCUSP_PGBOUNCER;
    mockProfile.hostClass = 'server';
    expect(pgbouncerEnabled()).toBe(true);
  });

  it('defaults OFF when env is unset and the host is laptop/workstation (the Tauri desktop)', () => {
    delete process.env.PAPERCUSP_PGBOUNCER;
    mockProfile.hostClass = 'laptop';
    expect(pgbouncerEnabled()).toBe(false);
    mockProfile.hostClass = 'workstation';
    expect(pgbouncerEnabled()).toBe(false);
  });

  it('PAPERCUSP_PGBOUNCER=1 forces ON even on a laptop', () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    mockProfile.hostClass = 'laptop';
    expect(pgbouncerEnabled()).toBe(true);
  });

  it('PAPERCUSP_PGBOUNCER=0 is the kill-switch — forces OFF even on a server', () => {
    process.env.PAPERCUSP_PGBOUNCER = '0';
    mockProfile.hostClass = 'server';
    expect(pgbouncerEnabled()).toBe(false);
  });

  it('an unrecognized flag value falls through to the host-class default', () => {
    process.env.PAPERCUSP_PGBOUNCER = 'true';
    mockProfile.hostClass = 'server';
    expect(pgbouncerEnabled()).toBe(true); // server → default on
    mockProfile.hostClass = 'laptop';
    expect(pgbouncerEnabled()).toBe(false); // laptop → default off
  });
});

describe('maybePgbouncer', () => {
  it('returns the URL untouched when pooling is disabled (laptop default, env unset)', () => {
    delete process.env.PAPERCUSP_PGBOUNCER;
    mockProfile.hostClass = 'laptop';
    expect(maybePgbouncer(DIRECT)).toBe(DIRECT);
  });

  it('routes through the pooler by DEFAULT on a server-class host (P-004), env unset', () => {
    delete process.env.PAPERCUSP_PGBOUNCER;
    mockProfile.hostClass = 'server';
    expect(maybePgbouncer(DIRECT)).toBe(POOLED);
  });

  it('routes to 127.0.0.1:6432 when forced on, preserving credentials + database', () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    delete process.env.PAPERCUSP_PGBOUNCER_PORT;
    expect(maybePgbouncer(DIRECT)).toBe(POOLED);
  });

  it('honors PAPERCUSP_PGBOUNCER_PORT', () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    process.env.PAPERCUSP_PGBOUNCER_PORT = '7000';
    expect(maybePgbouncer(DIRECT)).toContain('@127.0.0.1:7000/');
  });

  it('kill-switch PAPERCUSP_PGBOUNCER=0 keeps the URL direct even on a server', () => {
    process.env.PAPERCUSP_PGBOUNCER = '0';
    mockProfile.hostClass = 'server';
    expect(maybePgbouncer(DIRECT)).toBe(DIRECT);
  });

  it('leaves an unparseable URL untouched (never throws)', () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    expect(maybePgbouncer('not a url')).toBe('not a url');
  });
});
