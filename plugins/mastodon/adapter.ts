import type { ProviderAdapter, ProviderDescriptor, ProviderHost, ProviderRecord, ProviderSyncRequest } from '../../../../packages/plugin-sdk/src/provider';
import { htmlToText } from '../../../../packages/operator-core/lib/html-to-text';
import manifest from './papercusp.json';

export const { name, version, papercusp } = manifest;
export const capabilities = [];
const descriptor = manifest.provider as ProviderDescriptor;
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\s/\\?#\u0000-\u001f]/.test(value);
function fault(kind: string, message: string, extra = {}) { return Object.assign(new Error(`mastodon:${message}`), { kind }, extra); }
function configOf(raw: Record<string, unknown> = {}) {
  const origin = text(raw.connectionOrigin); let url: URL;
  try { url = new URL(origin); } catch { throw fault('auth', 'connection_origin_missing'); }
  // The host owns origin validation, egress policy and token namespaces.
  if (url.protocol !== 'https:' || url.origin !== origin) throw fault('auth', 'connection_origin_invalid');
  if (!token(raw.connectionAccountId)) throw fault('auth', 'connection_account_missing');
  const bounded = (key: string, fallback: number, max: number) => {
    const n = raw[key] ?? fallback;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) throw fault('transient', `invalid_${key}`);
    return n;
  };
  return { origin, account: raw.connectionAccountId, pageSize: bounded('pageSize', 40, 40), maxPages: bounded('maxPages', 200, 1000) };
}
type Config = ReturnType<typeof configOf>;
type Stream = { since: string | null; position: string | null; newest: string | null; pages: number };
type Cursor = { v: 1; config: Config; phase: 0 | 1 | 2; timeline: Stream; mentions: Stream; emitted: string[] };
const stream = (since: string | null = null): Stream => ({ since, position: since, newest: since, pages: 0 });
function fresh(config: Config, since?: Cursor): Cursor {
  return { v: 1, config, phase: 0, timeline: stream(since?.timeline.newest), mentions: stream(since?.mentions.newest), emitted: [] };
}
function decode(raw: string | null, config: Config): Cursor {
  if (raw == null) return fresh(config);
  let c: unknown; try { c = JSON.parse(raw); } catch { throw fault('cursor-expired', 'cursor_unreadable'); }
  const validStream = (s: unknown) => object(s) && [s.since, s.position, s.newest].every((v) => v === null || token(v)) && Number.isInteger(s.pages) && Number(s.pages) >= 0 && Number(s.pages) <= 1000;
  if (!object(c) || c.v !== 1 || ![0, 1, 2].includes(c.phase as number) || !object(c.config) || !validStream(c.timeline) || !validStream(c.mentions) || !Array.isArray(c.emitted) || !c.emitted.every((v) => typeof v === 'string')) throw fault('cursor-expired', 'cursor_unrecognised');
  if (JSON.stringify(c.config) !== JSON.stringify(config)) return fresh(config);
  return c.phase === 2 ? fresh(config, c as Cursor) : c as Cursor;
}
function header(headers: Record<string, string>, key: string) { return Object.entries(headers).find(([name]) => name.toLowerCase() === key)?.[1]; }
async function call(host: ProviderHost, source: string, origin: string, path: string, method = 'GET', body?: string, headers?: Record<string, string>, absent = false) {
  const response = await host.fetch({ source, request: { url: new URL(path, origin).href, method, ...(body ? { body } : {}), ...(headers ? { headers } : {}) } });
  if (absent && response.status === 404) return null;
  if ([401, 403].includes(response.status)) throw fault('auth', 'grant_refused');
  if (response.status === 429) {
    const retry = Number(header(response.headers, 'retry-after'));
    const reset = Date.parse(header(response.headers, 'x-ratelimit-reset') ?? '');
    const seconds = Number.isFinite(retry) && retry > 0 ? retry : Math.ceil((reset - Date.now()) / 1000);
    throw fault('rate-limited', 'throttled', Number.isFinite(seconds) && seconds >= 0 ? { retryAfterSeconds: Math.ceil(seconds) } : {});
  }
  if (response.status < 200 || response.status >= 300) throw fault('transient', method === 'POST' ? 'write_unconfirmed_do_not_retry' : 'request_failed');
  let value: unknown; try { value = JSON.parse(response.body); } catch { throw fault('transient', 'response_unreadable'); }
  if (object(value) && value.error) throw fault('transient', 'request_failed');
  return value;
}
function record(value: unknown, mention: boolean, config: Config): ProviderRecord {
  if (!object(value) || !token(value.id) || !text(value.uri) || !date(value.created_at) || !object(value.account) || !token(value.account.id) || !text(value.account.acct) || typeof value.content !== 'string' || !['public', 'unlisted', 'private', 'direct'].includes(text(value.visibility)) || (value.edited_at != null && !date(value.edited_at)) || (value.in_reply_to_id != null && !token(value.in_reply_to_id))) throw fault('transient', 'malformed_status');
  const payload: Record<string, unknown> = { id: value.uri, text: htmlToText(value.content), platform: 'mastodon', statusId: value.id,
    instanceHost: config.origin.slice(8), visibility: value.visibility, author: value.account.acct, authorHandle: value.account.acct,
    occurredAt: value.created_at, uri: value.uri };
  if (text(value.url)) payload.url = value.url;
  if (value.edited_at) payload.editedAt = value.edited_at;
  if (value.in_reply_to_id) payload.replyToId = value.in_reply_to_id;
  return { datatype: 'social-post', nativeId: value.uri as string, event: mention ? 'mention' : value.in_reply_to_id ? 'reply' : 'post', payload,
    occurredAt: value.created_at, version: `${value.id}@${value.edited_at ?? value.created_at}` };
}
async function syncPage(request: ProviderSyncRequest, host: ProviderHost) {
  const config = configOf(request.config); const cursor = decode(request.cursor, config);
  const mentions = cursor.phase === 1; const state = mentions ? cursor.mentions : cursor.timeline;
  const path = mentions ? '/api/v1/notifications' : '/api/v1/timelines/home';
  const params = new URLSearchParams({ limit: String(config.pageSize) });
  if (mentions) params.append('types[]', 'mention');
  // Cold history walks backwards; incremental gaps walk FORWARD with min_id.
  // IDs stay opaque. Boundary selection uses the server's documented ordering.
  if (state.position) params.set(state.since ? 'min_id' : 'max_id', state.position);
  const body = await call(host, request.source, config.origin, `${path}?${params}`);
  if (!Array.isArray(body)) throw fault('transient', 'malformed_collection');
  const records: ProviderRecord[] = []; const seen = new Set(cursor.emitted);
  for (const item of body) {
    if (!object(item) || !token(item.id) || (mentions && item.type !== 'mention')) throw fault('transient', 'malformed_collection_item');
    const normalized = record(mentions ? item.status : item, mentions, config);
    const key = `${normalized.event}:${normalized.nativeId}:${normalized.version}`;
    if (!seen.has(key)) { seen.add(key); records.push(normalized); }
  }
  if (body.length) {
    const first = body[0].id as string; const last = body[body.length - 1].id as string;
    const position = state.since ? first : last;
    if (position === state.position) throw fault('cursor-expired', 'paging_made_no_progress');
    if (!state.newest || state.since) state.newest = first;
    state.position = position; state.pages++;
    if (state.pages >= config.maxPages) throw fault('transient', 'page_bound_exceeded');
  } else cursor.phase = mentions ? 2 : 1;
  cursor.emitted = cursor.phase === 2 ? [] : [...seen];
  return { records, nextCursor: JSON.stringify(cursor), hasMore: cursor.phase !== 2,
    catchUp: state.since ? { path: 'backfill' as const, reason: 'no-replay-supported' as const } : { path: 'cold-start' as const } };
}
function target(args: Record<string, unknown>, config: Config) {
  let value = args.target;
  if (object(value) && 'externalId' in value) {
    if (!object(value.payload) || typeof value.externalId !== 'string') throw fault('transient', 'invalid_stored_target');
    value = { platform: value.platform, inReplyToId: text(value.payload.statusId) || value.externalId, instanceHost: value.payload.instanceHost };
  }
  if (!object(value) || value.platform !== 'mastodon' || !token(value.inReplyToId)) throw fault('transient', 'invalid_target');
  const host = text(value.instanceHost);
  let origin: string; try { origin = new URL(host.includes('://') ? host : `https://${host}`).origin; } catch { throw fault('auth', 'instance_mismatch'); }
  if (origin !== config.origin) throw fault('auth', 'instance_mismatch');
  return value.inReplyToId;
}
const visibilities: Record<string, string> = { public: 'public', unlisted: 'unlisted', followers: 'private', direct: 'direct' };
export const providerAdapter: ProviderAdapter = {
  describe: () => descriptor,
  syncPage,
  async invoke(request, host) {
    if (!descriptor.capabilities.includes(request.capability)) throw fault('transient', 'capability_unsupported');
    const config = configOf(request.config); const args = request.args;
    if (request.capability === 'social.delete') {
      const id = target(args, config); const path = `/api/v1/statuses/${encodeURIComponent(id)}`;
      const existing = await call(host, request.source, config.origin, path, 'GET', undefined, undefined, true);
      if (existing === null) return { deleted: false };
      if (!object(existing) || existing.id !== id || !object(existing.account) || !token(existing.account.id)) throw fault('transient', 'malformed_owner');
      if (existing.account.id !== config.account) throw fault('auth', 'delete_not_owned');
      const removed = await call(host, request.source, config.origin, path, 'DELETE', undefined, undefined, true);
      return { deleted: removed !== null };
    }
    const params = new URLSearchParams();
    if (request.capability === 'social.reply') params.set('in_reply_to_id', target(args, config));
    else {
      const destination = text(args.destination);
      if (destination !== config.origin && destination !== config.origin.slice(8)) throw fault('auth', 'destination_mismatch');
    }
    const requestedVisibility = text(args.visibility) || 'public';
    if (!Object.hasOwn(visibilities, requestedVisibility)) throw fault('transient', 'invalid_visibility');
    const visibility = visibilities[requestedVisibility];
    if (!text(args.text).trim() || /[\r\n]/.test(text(args.idempotencyKey)) || !text(args.idempotencyKey) || text(args.idempotencyKey).length > 2048) throw fault('transient', 'invalid_text_or_idempotency_key');
    if (args.media !== undefined && (!Array.isArray(args.media) || args.media.length)) throw fault('transient', 'media_unsupported');
    params.set('status', text(args.text)); params.set('visibility', visibility);
    const created = await call(host, request.source, config.origin, '/api/v1/statuses', 'POST', params.toString(), { 'content-type': 'application/x-www-form-urlencoded', 'Idempotency-Key': text(args.idempotencyKey) });
    if (!object(created) || !token(created.id) || !text(created.uri)) throw fault('transient', 'write_unconfirmed_do_not_retry');
    return { externalId: created.uri, ...(text(created.url) ? { url: created.url } : {}) };
  },
};
