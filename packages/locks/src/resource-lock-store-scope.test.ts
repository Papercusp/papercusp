import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  releaseOwnerResourcesScoped,
  tryAcquireResource,
  tryReleaseResource,
} from './resource-lock-store';

/**
 * EI-27114494366587753: under `scope: 'resource'` the caller's inWorkspaceTxn
 * holds only the shared workspace gate plus THIS resource's key, so a peer may
 * be mutating another resource's rows concurrently. Every statement must
 * therefore name the resource; a domain-wide sweep or cascade here would race
 * those peers. This pins the statement shape, the cheap and exact proxy for
 * "touches only this resource's rows".
 */

interface Call { query: string; values: unknown[] }

function fakeTx(route: (query: string) => unknown[] = () => []) {
  const calls: Call[] = [];
  const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('$').replace(/\s+/g, ' ').trim();
    calls.push({ query, values });
    return route(query);
  });
  return { tx: tx as unknown as Sql, calls };
}

/** A statement that writes or cascades across the domain without naming a resource. */
function domainWide(call: Call): boolean {
  const q = call.query;
  if (/resource_grant_cascade\(\$, clock_timestamp\(\)\)/.test(q)) return true;
  if (/DELETE FROM agent_resource_(locks|exclusive_queue)/.test(q) && !/resource =/.test(q) && !/owner =/.test(q)) {
    return true;
  }
  return false;
}

const DOMAIN = 'cd';

describe('resource-scoped lock-store operations', () => {
  it('exclusive acquire under resource scope sweeps and cascades only its own resource', async () => {
    const { tx, calls } = fakeTx((q) => {
      if (q.includes('FROM agent_resource_registry')) return [{ max_holders: null }];
      if (q.startsWith('INSERT INTO agent_resource_locks')) {
        return [{ lock_id: 'l-1', expires_ts: new Date(0), status: 'held' }];
      }
      if (q.startsWith('UPDATE agent_resource_locks')) return [{ fence_seq: 7 }];
      return [];
    });

    const result = await tryAcquireResource(tx, {
      coordinationDomain: DOMAIN,
      resource: 'git-sync:alpha',
      mode: 'exclusive',
      owner: 'fire-1',
      ownerLabel: null,
      reason: 'test',
      ttlSec: 60,
      scope: 'resource',
    });

    expect(result).toMatchObject({ ok: true, fence_seq: 7 });
    expect(calls.some((c) => c.query.includes('resource_sweep_expired_scoped'))).toBe(true);
    const cascade = calls.find((c) => c.query.includes('resource_grant_cascade'));
    expect(cascade?.values).toEqual([DOMAIN, 'git-sync:alpha']);
    expect(calls.filter(domainWide)).toEqual([]);
  });

  it('the default domain scope keeps the domain-wide sweep and cascade', async () => {
    const { tx, calls } = fakeTx((q) => (q.includes('FROM agent_resource_registry') ? [] : []));
    await tryAcquireResource(tx, {
      coordinationDomain: DOMAIN,
      resource: 'unregistered',
      mode: 'exclusive',
      owner: 'fire-1',
      ownerLabel: null,
      reason: 'test',
      ttlSec: 60,
    });
    // Unknown resource returns before sweeping; register it to reach the sweep.
    const registered = fakeTx((q) => (q.includes('FROM agent_resource_registry') ? [{ max_holders: null }] : []));
    await tryAcquireResource(registered.tx, {
      coordinationDomain: DOMAIN,
      resource: 'git-sync:alpha',
      mode: 'exclusive',
      owner: 'fire-1',
      ownerLabel: null,
      reason: 'test',
      ttlSec: 60,
    });
    expect(calls.some((c) => c.query.includes('resource_sweep_expired_scoped'))).toBe(false);
    expect(registered.calls.some(domainWide)).toBe(true);
  });

  it('release by lockId under resource scope is confined to that resource', async () => {
    const { tx, calls } = fakeTx((q) =>
      q.startsWith('DELETE FROM agent_resource_locks') && q.includes('lock_id')
        ? [{ mode: 'exclusive', resource: 'git-sync:alpha' }]
        : [],
    );
    const result = await tryReleaseResource(tx, {
      coordinationDomain: DOMAIN,
      owner: 'fire-1',
      lockId: '00000000-0000-0000-0000-000000000001',
      resource: 'git-sync:alpha',
      scope: 'resource',
    });
    expect(result.released).toBe(1);
    const del = calls.find((c) => c.query.startsWith('DELETE FROM agent_resource_locks') && c.query.includes('lock_id'));
    expect(del?.query).toContain('resource =');
    expect(del?.values).toContain('git-sync:alpha');
    expect(calls.filter(domainWide)).toEqual([]);
  });

  it('release under resource scope refuses a missing resource name', async () => {
    const { tx } = fakeTx();
    await expect(
      tryReleaseResource(tx, { coordinationDomain: DOMAIN, owner: 'fire-1', lockId: 'x', scope: 'resource' }),
    ).rejects.toThrow(/requires the resource name/);
  });

  it('scoped owner release deletes only the named resources and cascades each one', async () => {
    const { tx, calls } = fakeTx((q) =>
      q.startsWith('DELETE FROM agent_resource_locks')
        ? [{ mode: 'exclusive', resource: 'git-sync:alpha' }, { mode: 'exclusive', resource: 'extra' }]
        : [],
    );
    const result = await releaseOwnerResourcesScoped(tx, DOMAIN, 'fire-1', ['git-sync:alpha', 'extra', 'extra']);
    expect(result.released).toBe(2);
    const deletes = calls.filter((c) => c.query.startsWith('DELETE FROM'));
    expect(deletes.length).toBeGreaterThanOrEqual(3);
    for (const d of deletes.slice(0, 3)) {
      expect(d.query).toContain('ANY(');
      expect(d.values).toContainEqual(['extra', 'git-sync:alpha']);
    }
    const cascades = calls.filter((c) => c.query.includes('resource_grant_cascade'));
    expect(cascades.map((c) => c.values[1])).toEqual(['extra', 'git-sync:alpha']);
    expect(calls.filter(domainWide)).toEqual([]);
  });

  it('reports an exclusive release even when the cascade immediately grants a successor', async () => {
    const successor = {
      resource: 'git-sync:alpha',
      owner: 'fire-2',
      owner_label: 'fire-2',
      mode: 'exclusive',
      status: 'held',
      lock_id: 'successor-lock',
      reason: 'test successor',
      acquired_ts: new Date(0),
      expires_ts: new Date(60_000),
      fence_seq: 2,
    };
    const { tx } = fakeTx((query) => {
      if (query.startsWith('DELETE FROM agent_resource_locks')) {
        return [{ mode: 'exclusive', resource: 'git-sync:alpha' }];
      }
      if (query.startsWith('SELECT resource, owner, owner_label, mode, status, lock_id::text')) {
        return [successor];
      }
      return [];
    });

    const result = await releaseOwnerResourcesScoped(tx, DOMAIN, 'fire-1', ['git-sync:alpha']);

    expect(result).toMatchObject({
      released: 1,
      releasedExclusiveResources: ['git-sync:alpha'],
      exclusiveResources: [],
      waiters: {},
    });
  });

  it('keeps exact release history separate from availability for a single-lock release', async () => {
    const successor = {
      resource: 'git-sync:alpha',
      owner: 'fire-2',
      owner_label: 'fire-2',
      mode: 'exclusive',
      status: 'held',
      lock_id: 'successor-lock',
      reason: 'test successor',
      acquired_ts: new Date(0),
      expires_ts: new Date(60_000),
      fence_seq: 2,
    };
    const { tx } = fakeTx((query) => {
      if (query.startsWith('DELETE FROM agent_resource_locks')) {
        return [{ mode: 'exclusive', resource: 'git-sync:alpha' }];
      }
      if (query.startsWith('SELECT resource, owner, owner_label, mode, status, lock_id::text')) {
        return [successor];
      }
      return [];
    });

    const result = await tryReleaseResource(tx, {
      coordinationDomain: DOMAIN,
      owner: 'fire-1',
      resource: 'git-sync:alpha',
    });

    expect(result).toMatchObject({
      released: 1,
      releasedExclusiveResources: ['git-sync:alpha'],
      exclusiveResources: [],
      waiters: {},
    });
  });

  it('scoped owner release with no names touches nothing', async () => {
    const { tx, calls } = fakeTx();
    expect(await releaseOwnerResourcesScoped(tx, DOMAIN, 'fire-1', [])).toEqual({
      released: 0,
      releasedExclusiveResources: [],
      exclusiveResources: [],
      waiters: {},
    });
    expect(calls).toEqual([]);
  });
});
