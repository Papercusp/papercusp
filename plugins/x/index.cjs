'use strict';

// P-023: the existing host owns credentials, retries, leases and the per-pass page budget.
const manifest = require('./papercusp.json');
const API = 'https://api.x.com/2';
const WEEK = 7 * 24 * 60 * 60 * 1000;
const FIELDS = 'id,text,author_id,created_at,conversation_id,in_reply_to_user_id,referenced_tweets,note_tweet';
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validId = (v) => typeof v === 'string' && /^[0-9]{1,19}$/.test(v);
const instant = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const token = (v) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 8192 && !/[\x00-\x20]/.test(v));
const fault = (kind, message, extra) => Object.assign(new Error(`x:${message}`), { kind }, extra || {});
const larger = (a, b) => a === null || BigInt(b) > BigInt(a) ? b : a;

function configOf(raw) {
  if (!object(raw) || !validId(raw.userId) || typeof raw.username !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(raw.username)) {
    throw fault('transient', 'invalid_account_config');
  }
  return { userId: raw.userId, username: raw.username.toLowerCase() };
}
function fresh(c, since = { mentions: null, replies: null }, checkedAt = null) {
  return { v: 1, config: c, phase: 'mentions', token: null, since,
    high: { ...since }, checkedAt, seenTokens: [], emitted: [], windowStart: null, windowEnd: null };
}
function decode(raw, c) {
  if (raw === null || raw === undefined) return fresh(c);
  let s;
  try { s = JSON.parse(raw); } catch { throw fault('cursor-expired', 'cursor_unreadable'); }
  const ids = (v) => object(v) && ['mentions', 'replies'].every((k) => v[k] === null || validId(v[k]));
  if (!object(s) || s.v !== 1 || !object(s.config) || !['mentions', 'replies', 'ready'].includes(s.phase)
    || !token(s.token) || !ids(s.since) || !ids(s.high)
    || !(s.checkedAt === null || instant(s.checkedAt)) || !(s.windowStart === null || instant(s.windowStart))
    || !(s.windowEnd === null || instant(s.windowEnd)) || !Array.isArray(s.seenTokens)
    || s.seenTokens.length > 50 || !s.seenTokens.every((v) => v !== null && token(v))
    || !Array.isArray(s.emitted) || !s.emitted.every(validId)) throw fault('cursor-expired', 'cursor_unrecognised');
  if (JSON.stringify(c) !== JSON.stringify(s.config)) return fresh(c);
  return s.phase === 'ready' ? fresh(c, s.since, s.checkedAt) : s;
}

async function api(host, source, path, method = 'GET', body, paginated = false) {
  const response = await host.fetch({ source, request: { url: `${API}${path}`, method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) } });
  let value;
  try { value = JSON.parse(response.body); } catch { value = null; }
  if (response.status === 429) {
    const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const retry = Number(headers['retry-after']);
    const reset = Number(headers['x-rate-limit-reset']);
    const seconds = retry > 0 && Number.isFinite(retry) ? Math.ceil(retry)
      : Number.isFinite(reset) && reset * 1000 > Date.now() ? Math.ceil(reset - Date.now() / 1000) : undefined;
    throw fault('rate-limited', 'rate_limited', seconds === undefined ? {} : { retryAfterSeconds: seconds });
  }
  if (response.status === 401 || response.status === 403) throw fault('auth', 'grant_refused');
  if (response.status === 400 && paginated && method === 'GET') throw fault('cursor-expired', 'pagination_rejected');
  if (response.status < 200 || response.status >= 300 || !object(value)
    || (Array.isArray(value.errors) && value.errors.length)) {
    // Never echo provider error bodies: they can contain credentials or submitted post text.
    throw fault('transient', method === 'POST' ? 'write_unconfirmed_do_not_retry' : 'request_failed');
  }
  return value;
}

function recordOf(row, stream, c, users) {
  if (!object(row) || !validId(row.id) || !instant(row.created_at) || typeof row.text !== 'string') throw fault('transient', 'malformed_post');
  const parent = Array.isArray(row.referenced_tweets) ? row.referenced_tweets.find((r) => r.type === 'replied_to')?.id : undefined;
  // Replies addressed to this account belong to the reply search, avoiding duplicate deliveries
  // between the overlapping mentions and search endpoints. Other replies can still mention us.
  const ownReply = row.in_reply_to_user_id === c.userId && validId(parent);
  if ((stream === 'mentions' && ownReply) || (stream === 'replies' && !ownReply)) return null;
  const kind = stream === 'replies' ? 'reply' : 'mention';
  const payload = { id: row.id, platform: 'x-twitter', kind, text: typeof row.note_tweet?.text === 'string' ? row.note_tweet.text : row.text,
    occurredAt: row.created_at, url: `https://x.com/i/web/status/${row.id}`, subjectId: parent || row.id };
  if (validId(row.author_id)) payload.author = users.get(row.author_id) || row.author_id;
  if (validId(parent)) { payload.replyToId = parent; payload.inReplyToUrl = `https://x.com/i/web/status/${parent}`; }
  if (validId(row.conversation_id)) payload.threadId = row.conversation_id;
  return { datatype: 'social-post', nativeId: row.id, event: kind, payload, occurredAt: row.created_at, version: row.id };
}

async function syncPage(request, host) {
  const c = configOf(request.config);
  const s = decode(request.cursor, c);
  const oldestReachableAt = new Date(Date.now() - WEEK + 60000).toISOString();
  if (s.windowStart === null) {
    s.windowStart = oldestReachableAt;
    s.windowEnd = new Date(Date.now() - 30000).toISOString();
  }
  const stream = s.phase;
  const query = new URLSearchParams({ max_results: '10', 'tweet.fields': FIELDS, expansions: 'author_id', 'user.fields': 'username', end_time: s.windowEnd });
  if (s.since[stream]) query.set('since_id', s.since[stream]);
  else query.set('start_time', s.windowStart);
  if (s.token) query.set(stream === 'mentions' ? 'pagination_token' : 'next_token', s.token);
  if (stream === 'replies') { query.set('query', `to:${c.username} is:reply`); query.set('sort_order', 'recency'); }
  const body = await api(host, request.source, `${stream === 'mentions' ? `/users/${c.userId}/mentions` : '/tweets/search/recent'}?${query}`, 'GET', undefined, s.token !== null);
  if (!(body.data === undefined || Array.isArray(body.data)) || !object(body.meta)
    || (body.data === undefined && body.meta.result_count !== 0)) throw fault('transient', 'malformed_collection');
  const next = body.meta.next_token ?? null;
  if (!token(next) || (next !== null && (next === s.token || s.seenTokens.includes(next)))) throw fault('cursor-expired', 'pagination_made_no_progress');
  const users = new Map((Array.isArray(body.includes?.users) ? body.includes.users : []).filter((u) => validId(u.id) && typeof u.username === 'string').map((u) => [u.id, u.username]));
  const records = [];
  const emitted = new Set(s.emitted);
  for (const row of body.data || []) {
    const record = recordOf(row, stream, c, users);
    // Compare snowflakes as integers: Number loses precision for current post ids.
    if (!validId(row.id)) throw fault('transient', 'malformed_post');
    s.high[stream] = larger(s.high[stream], row.id);
    if (!record || (s.since[stream] && BigInt(row.id) <= BigInt(s.since[stream])) || emitted.has(row.id)) continue;
    records.push(record); emitted.add(row.id);
  }
  s.emitted = [...emitted];
  s.token = next;
  if (next) s.seenTokens = [...s.seenTokens, next].slice(-50);
  else { s.phase = stream === 'mentions' ? 'replies' : 'ready'; s.seenTokens = []; }
  const previous = s.checkedAt;
  if (s.phase === 'ready') { s.since = { ...s.high }; s.checkedAt = s.windowEnd; s.emitted = []; }
  let from = previous;
  if (!from && request.catchUpFrom) {
    try {
      const old = JSON.parse(request.catchUpFrom);
      if (instant(old.checkedAt)) from = old.checkedAt;
      else if (instant(old.windowStart)) from = old.windowStart;
    } catch { /* Unknown rejected position supplies no evidence of loss. */ }
  }
  return { records, nextCursor: JSON.stringify(s), hasMore: s.phase !== 'ready',
    catchUp: request.catchUpFrom ? { path: 'backfill', reason: 'cursor-expired' }
      : { path: request.cursor ? 'cursor-replay' : 'cold-start' },
    ...(from && Date.parse(from) < Date.parse(oldestReachableAt) ? { lossRisk: {
      kind: 'retention-window-exceeded', oldestReachableAt,
      detail: 'The saved completed read predates the seven-day recent-reply search window; replies in that gap cannot be recovered by this endpoint.' } } : {}) };
}

async function invoke(request, host) {
  const c = configOf(request.config);
  const a = request.args || {};
  if (!manifest.provider.capabilities.includes(request.capability)) throw fault('transient', 'capability_unsupported');
  if (request.capability === 'social.delete') {
    if (!validId(a.externalId)) throw fault('transient', 'invalid_post_id');
    const body = await api(host, request.source, `/tweets/${a.externalId}`, 'DELETE');
    if (typeof body.data?.deleted !== 'boolean') throw fault('transient', 'delete_unconfirmed');
    return { deleted: body.data.deleted };
  }
  if (typeof a.text !== 'string' || !a.text.trim()) throw fault('transient', 'empty_message');
  if ((Array.isArray(a.media) && a.media.length) || a.imageUrl || a.videoUrl) throw fault('transient', 'media_upload_unsupported');
  const body = { text: a.text };
  if (request.capability === 'social.post') {
    if (a.destination !== c.userId) throw fault('transient', 'destination_mismatch');
  } else {
    const t = a.target;
    if (t?.platform && t.platform !== 'x-twitter') throw fault('transient', 'wrong_platform_target');
    if (t && 'externalId' in t && (!object(t.payload) || typeof t.externalId !== 'string')) throw fault('transient', 'invalid_stored_target');
    const target = t && 'externalId' in t ? t.externalId : t?.objectId || a.ref?.externalId;
    if (!validId(target)) throw fault('transient', 'invalid_reply_id');
    body.reply = { in_reply_to_tweet_id: target };
  }
  const result = await api(host, request.source, '/tweets', 'POST', body);
  if (!validId(result.data?.id)) throw fault('transient', 'write_unconfirmed_no_server_id');
  return { externalId: result.data.id, url: `https://x.com/i/web/status/${result.data.id}` };
}

module.exports = { name: manifest.name, version: manifest.version, papercusp: manifest.papercusp, capabilities: [],
  providerAdapter: { describe: () => manifest.provider, syncPage, invoke } };
