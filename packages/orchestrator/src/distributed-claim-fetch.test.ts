import { describe, expect, it, vi } from 'vitest';
import { fetchDistributedClaim } from './distributed-claim-fetch';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fetchDistributedClaim', () => {
  it('POSTs to the claim-feature endpoint with the right payload', async () => {
    const fetchFn = vi.fn(async () =>
      jsonRes({ strategy: 'distributed', reason: 'attempted', claimed: true }),
    );
    await fetchDistributedClaim({
      operatorBase: 'http://localhost:3070',
      harnessSlug: 'sheets',
      featureId: 'F-1',
      githubUserId: 42,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchFn.mock.calls[0];
    expect(String(url)).toBe('http://localhost:3070/api/harness/sheets/claim-feature');
    const init = opts as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toContain('"feature_id":"F-1"');
    expect(init.body).toContain('"github_user_id":42');
  });

  it('returns claimed:true when the endpoint returns 200 with claimed:true', async () => {
    const fetchFn = vi.fn(async () =>
      jsonRes({ strategy: 'distributed', reason: 'attempted', claimed: true, my_pubkey: 'abc' }),
    );
    const r = await fetchDistributedClaim({
      operatorBase: 'http://localhost:3070',
      harnessSlug: 's',
      featureId: 'F-1',
      githubUserId: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.claimed).toBe(true);
    expect(r.reason).toBe('attempted');
    expect(r.my_pubkey).toBe('abc');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns claimed:false when a human flipped the feature to working', async () => {
    const fetchFn = vi.fn(async () =>
      jsonRes({ strategy: 'distributed', reason: 'manually-active', claimed: false }),
    );
    const r = await fetchDistributedClaim({
      operatorBase: 'http://localhost:3070',
      harnessSlug: 's',
      featureId: 'F-1',
      githubUserId: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('manually-active');
  });

  it('returns claimed:true with reason single-writer-fallback when substrate is off', async () => {
    const fetchFn = vi.fn(async () =>
      jsonRes({ strategy: 'single-writer', claimed: true, reason: 'single-writer-fallback' }),
    );
    const r = await fetchDistributedClaim({
      operatorBase: 'http://localhost:3070',
      harnessSlug: 's',
      featureId: 'F-1',
      githubUserId: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.claimed).toBe(true);
    expect(r.reason).toBe('single-writer-fallback');
    expect(r.strategy).toBe('single-writer');
  });

  it('returns reason=fetch-failed + claimed:true on non-2xx (legacy fallback)', async () => {
    const fetchFn = vi.fn(async () => new Response('boom', { status: 500 }));
    const r = await fetchDistributedClaim({
      operatorBase: 'http://localhost:3070',
      harnessSlug: 's',
      featureId: 'F-1',
      githubUserId: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.reason).toBe('fetch-failed');
    expect(r.claimed).toBe(true);
    expect(r.error).toContain('HTTP 500');
  });

  it('returns reason=fetch-failed + claimed:true on network throw', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('econnrefused');
    });
    const r = await fetchDistributedClaim({
      operatorBase: 'http://localhost:3070',
      harnessSlug: 's',
      featureId: 'F-1',
      githubUserId: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.reason).toBe('fetch-failed');
    expect(r.claimed).toBe(true);
    expect(r.error).toContain('econnrefused');
  });

  it('reports latencyMs', async () => {
    const fetchFn = vi.fn(
      async () => new Promise<Response>((res) => setTimeout(() => res(jsonRes({ claimed: true })), 5)),
    );
    const r = await fetchDistributedClaim({
      operatorBase: 'http://localhost:3070',
      harnessSlug: 's',
      featureId: 'F-1',
      githubUserId: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.latencyMs).toBeGreaterThanOrEqual(5);
  });

  it('defaults claimed to true when the response body omits the field', async () => {
    const fetchFn = vi.fn(async () => jsonRes({ strategy: 'single-writer' }));
    const r = await fetchDistributedClaim({
      operatorBase: 'http://localhost:3070',
      harnessSlug: 's',
      featureId: 'F-1',
      githubUserId: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.claimed).toBe(true);
  });
});
