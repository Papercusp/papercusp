/** P019 / D047: mapping only. The host owns credentials, polling, permissions,
 * cursor commit, durable delivery and relationship resolution. */
import type { HostFetchResponse, ProviderAdapter, ProviderDescriptor, ProviderHost, ProviderRecord, ProviderSyncRequest } from '@papercusp/plugin-sdk/provider';
import { providerSyncFault, rateLimitedFault } from '@papercusp/plugin-sdk/provider-faults';
import manifest from './papercusp.json';

const PREFIX = 'papercusp_signups';
const ID = 'papercusp-signups';
const HEX_ID = /^[a-f0-9]{32}$/;
const KEY = /^signup:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):[a-f0-9]{8}$/;
const PAGE_SIZE = 20;
const fail = (message: string): never => { throw providerSyncFault(PREFIX, 'transient', message); };
const object = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('object_required');
  return raw as Record<string, unknown>;
};
const text = (raw: unknown) => typeof raw === 'string' ? raw.trim() : '';

function configuration(request: ProviderSyncRequest) {
  const accountId = text(request.config?.accountId);
  const namespaceId = text(request.config?.namespaceId);
  if (!HEX_ID.test(accountId) || !HEX_ID.test(namespaceId)) return fail('account_and_namespace_required');
  return { accountId, namespaceId };
}

function cursor(raw: string | null, scope: { accountId: string; namespaceId: string }): string | null {
  if (raw === null) return null;
  let parsed: Record<string, unknown>;
  try { parsed = object(JSON.parse(raw)); }
  catch { throw providerSyncFault(PREFIX, 'cursor-expired', 'invalid_cursor'); }
  if (parsed.v !== 1 || !text(parsed.token) || text(parsed.token).length > 4096) {
    throw providerSyncFault(PREFIX, 'cursor-expired', 'invalid_cursor');
  }
  if (parsed.accountId !== scope.accountId || parsed.namespaceId !== scope.namespaceId) return fail('cursor_scope_mismatch');
  return parsed.token as string;
}

function body(response: HostFetchResponse): string {
  return response.bodyEncoding === 'base64' ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
}

async function read(host: ProviderHost, source: string, url: string): Promise<HostFetchResponse> {
  const response = await host.fetch({ source, request: { url, method: 'GET' } });
  if (response.status === 429) throw rateLimitedFault(PREFIX, 'rate_limited', response.headers);
  if (response.status === 401 || response.status === 403) throw providerSyncFault(PREFIX, 'auth', 'kv_access_denied');
  // Response text may contain an email or credential. Never put it in errors.
  if (response.status < 200 || response.status >= 300) return fail(`kv_http_${response.status}`);
  return response;
}

function json(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { return fail('invalid_json'); }
}

/** Attribution remains bounded, self-reported data, never an identity key. */
function attribution(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['distinct_id', 'session_id']) {
    if (text(source[key])) out[key] = text(source[key]).slice(0, 100);
  }
  for (const key of ['first_touch', 'last_touch']) {
    const value = source[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const touch = value as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const field of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'landing_path']) {
      if (text(touch[field])) kept[field] = text(touch[field]).slice(0, 200);
    }
    if (touch.organic === true) kept.organic = true;
    if (typeof touch.ts === 'number' && Number.isFinite(touch.ts) && touch.ts > 0 && touch.ts < 4102444800000) kept.ts = touch.ts;
    if (Object.keys(kept).length) out[key] = kept;
  }
  return Object.keys(out).length ? out : undefined;
}

function person(key: string, raw: unknown, scope: { accountId: string; namespaceId: string }): ProviderRecord {
  const match = KEY.exec(key);
  const value = object(raw);
  const timestamp = text(value.ts);
  if (!match || timestamp !== match[1] || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    return fail('signup_capture_identity_invalid');
  }
  const email = text(value.email).toLowerCase();
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return fail('signup_email_invalid');
  const reportedAttribution = attribution(value.attribution);
  return {
    datatype: 'person', nativeId: key, event: 'person.updated', occurredAt: timestamp,
    payload: {
      provider: ID,
      externalId: key,
      observedAt: timestamp,
      emails: [email],
      extensions: { [ID]: {
        signupEventId: key,
        capturedAt: timestamp,
        evidenceRef: `cloudflare-kv:${scope.accountId}:${scope.namespaceId}:${key}`,
        emailVerified: false,
        communicationConsent: false,
        selfReported: {
          useCase: text(value.what).slice(0, 500),
          ...(reportedAttribution ? { attribution: reportedAttribution } : {}),
        },
      } },
    },
  };
}

export const providerAdapter: ProviderAdapter = {
  describe: () => manifest.provider as ProviderDescriptor,
  async syncPage(request, host) {
    const scope = configuration(request);
    const token = cursor(request.cursor, scope);
    const base = `https://api.cloudflare.com/client/v4/accounts/${scope.accountId}/storage/kv/namespaces/${scope.namespaceId}`;
    const url = new URL(`${base}/keys`);
    url.searchParams.set('prefix', 'signup:');
    url.searchParams.set('limit', String(PAGE_SIZE));
    if (token) url.searchParams.set('cursor', token);
    const list = object(json(body(await read(host, request.source, url.href))));
    if (list.success !== true || !Array.isArray(list.result) || list.result.length > PAGE_SIZE) return fail('kv_key_page_invalid');
    const info = object(list.result_info);
    if (typeof info.cursor !== 'string' || info.cursor.length > 4096) return fail('kv_page_cursor_invalid');
    const next = info.cursor || null;
    if (next && next === token) return fail('kv_cursor_not_advancing');
    const keys = list.result.map((row) => text(object(row).name));
    if (keys.some((key) => !KEY.test(key)) || new Set(keys).size !== keys.length) return fail('kv_signup_keys_invalid');
    const records: ProviderRecord[] = [];
    // No cursor is exposed before the complete bounded page succeeds.
    for (const key of keys) {
      const response = await read(host, request.source, `${base}/values/${encodeURIComponent(key)}`);
      records.push(person(key, json(body(response)), scope));
    }
    return { records, nextCursor: next ? JSON.stringify({ v: 1, ...scope, token: next }) : null, hasMore: next !== null };
  },
  async invoke() { return fail('no_invokable_capabilities'); },
};
