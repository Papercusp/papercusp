'use strict';

// P-027: only Graph mapping lives here. Credentials, cursor commits and retries belong to the host.
const manifest = require('./papercusp.json');
const API = 'https://graph.facebook.com/v23.0';
const POST_FIELDS = 'id,message,story,created_time,updated_time,permalink_url,from,attachments,is_published';
const COMMENT_FIELDS = 'id,created_time,message,from,parent,can_comment,permalink_url,like_count';
const WRITE_FIELDS = 'id,permalink_url,created_time';

function fault(kind, message, extra) {
  return Object.assign(new Error(`facebook_pages:${message}`), { kind }, extra || {});
}
const str = (v) => typeof v === 'string' ? v : '';
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const instant = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
function id(v) {
  if (!/^[0-9]+(?:_[0-9]+)*$/.test(str(v))) throw fault('transient', 'invalid_object_id');
  return v;
}
function configOf(raw) {
  const c = raw || {};
  const pageId = id(c.pageId);
  if (pageId.includes('_')) throw fault('transient', 'invalid_page_id');
  const bound = (key, max) => {
    const value = c[key] === undefined ? max : c[key];
    if (!Number.isInteger(value) || value < 1 || value > max) throw fault('transient', `invalid_${key}`);
    return value;
  };
  return { pageId, watchWindow: bound('watchWindow', 25), maxPostPages: bound('maxPostPages', 20), maxCommentPages: bound('maxCommentPages', 10) };
}
function urlFor(path, params) {
  const url = new URL(`${API}/${path}`);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
  return url.href;
}

/** Never follow a vendor URL with credentials, a different resource, or a different host. */
function nextAfter(body, currentUrl) {
  if (body.paging?.next === undefined || body.paging.next === null || body.paging.next === '') return null;
  let next;
  try { next = new URL(body.paging.next); } catch { throw fault('transient', 'invalid_paging_url'); }
  const current = new URL(currentUrl);
  if (next.origin !== current.origin || next.pathname !== current.pathname || next.username || next.password || next.hash) {
    throw fault('transient', 'paging_outside_resource');
  }
  // Graph often includes access_token in `next`. Rebuild the request from the opaque cursor;
  // no token or vendor URL is retained in the source cursor or sent back to the host.
  const after = next.searchParams.get('after');
  if (!after || after.length > 8192 || after === current.searchParams.get('after')) throw fault('cursor-expired', 'paging_made_no_progress');
  return after;
}

function holdSeconds(headers) {
  const retry = Number(headers['retry-after']);
  if (Number.isFinite(retry) && retry > 0) return Math.ceil(retry);
  let usage;
  try { usage = JSON.parse(headers['x-business-use-case-usage'] || '{}'); } catch { return undefined; }
  const holds = Object.values(usage).flat().map((row) => row && row.estimated_time_to_regain_access)
    .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
  return holds.length ? Math.ceil(Math.max(...holds) * 60) : undefined;
}

async function graph(host, source, url, method = 'GET', params) {
  const response = await host.fetch({ source, request: {
    url, method,
    ...(params ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() } : {}),
  } });
  let body;
  try { body = JSON.parse(response.body); } catch { body = null; }
  const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const code = body?.error?.code;
  if (response.status === 429 || code === 4 || code === 17 || code === 32 || code === 613 || code === 80001) {
    const retryAfterSeconds = holdSeconds(headers);
    throw fault('rate-limited', 'graph_throttled', retryAfterSeconds === undefined ? {} : { retryAfterSeconds });
  }
  if (response.status === 401 || response.status === 403 || code === 190 || code === 10 || code === 200) throw fault('auth', 'graph_grant_refused');
  if (response.status < 200 || response.status >= 300 || body?.error || body === null) {
    // API errors may echo submitted text or credentials. Report only the classification.
    throw fault('transient', method === 'POST' ? 'write_unconfirmed_do_not_retry' : 'graph_request_failed');
  }
  return body;
}

function postRecord(post) {
  if (!object(post) || !str(post.id) || !instant(post.created_time)) throw fault('transient', 'malformed_post');
  const occurredAt = instant(post.updated_time) ? post.updated_time : post.created_time;
  const text = str(post.message) || str(post.story);
  const payload = { id: post.id, text, url: str(post.permalink_url) || `https://www.facebook.com/${post.id}`, occurredAt, createdAt: post.created_time };
  if (str(post.from?.name) || str(post.from?.id)) payload.author = str(post.from?.name) || str(post.from?.id);
  if (Array.isArray(post.attachments?.data) && post.attachments.data.length) payload.media = post.attachments.data;
  if (post.updated_time && post.updated_time !== post.created_time) payload.editedAt = post.updated_time;
  if (post.is_published === false) payload.isPublished = false;
  if (!text) payload.textAbsent = true;
  return { datatype: 'social-post', nativeId: post.id, event: 'post', payload, occurredAt, version: `${post.id}@${occurredAt}` };
}
function commentRecord(comment, postId) {
  if (!object(comment) || !str(comment.id) || !instant(comment.created_time)) throw fault('transient', 'malformed_comment');
  const occurredAt = comment.created_time;
  const payload = { id: comment.id, text: str(comment.message), occurredAt, postId, replyToId: str(comment.parent?.id) || postId };
  if (str(comment.permalink_url)) payload.url = comment.permalink_url;
  if (str(comment.from?.name) || str(comment.from?.id)) payload.author = str(comment.from?.name) || str(comment.from?.id);
  if (typeof comment.can_comment === 'boolean') payload.canComment = comment.can_comment;
  if (!payload.text) payload.textAbsent = true;
  return { datatype: 'social-post', nativeId: comment.id, event: str(comment.parent?.id) ? 'reply' : 'comment', payload, occurredAt, version: `${comment.id}@${occurredAt}` };
}

function fresh(c, since = {}) {
  return { v: 1, config: c, phase: 'posts', after: null, page: 0, posts: [], post: 0, since, seen: {}, emitted: [] };
}
function watermarkValid(w) {
  return object(w) && instant(w.at) && Array.isArray(w.ids) && w.ids.every((s) => typeof s === 'string');
}
function decode(raw, c) {
  if (raw === null || raw === undefined) return fresh(c);
  let state;
  try { state = JSON.parse(raw); } catch { throw fault('cursor-expired', 'cursor_unreadable'); }
  if (!object(state) || state.v !== 1 || !['posts', 'comments', 'ready'].includes(state.phase)
    || !(state.after === null || (typeof state.after === 'string' && state.after.length <= 8192))
    || !Number.isInteger(state.page) || state.page < 0 || !Number.isInteger(state.post) || state.post < 0
    || !Array.isArray(state.posts) || state.posts.length > 25 || !state.posts.every((s) => /^[0-9]+(?:_[0-9]+)*$/.test(s))
    || state.post > state.posts.length || !object(state.since) || !object(state.seen)
    || ![...Object.values(state.since), ...Object.values(state.seen)].every(watermarkValid)
    || !Array.isArray(state.emitted) || !state.emitted.every((s) => typeof s === 'string')
    || !object(state.config)) throw fault('cursor-expired', 'cursor_unrecognised');
  if (JSON.stringify(state.config) !== JSON.stringify(c)) return fresh(c);
  if (state.phase === 'ready') return fresh(c, state.since);
  return state;
}
function isNew(watermark, record) {
  if (!watermark) return true;
  const diff = Date.parse(record.occurredAt) - Date.parse(watermark.at);
  return diff > 0 || (diff === 0 && !watermark.ids.includes(record.nativeId));
}
function advance(watermark, record) {
  if (!watermark || Date.parse(record.occurredAt) > Date.parse(watermark.at)) return { at: record.occurredAt, ids: [record.nativeId] };
  if (Date.parse(record.occurredAt) === Date.parse(watermark.at) && !watermark.ids.includes(record.nativeId)) return { at: watermark.at, ids: [...watermark.ids, record.nativeId] };
  return watermark;
}

async function syncPage(request, host) {
  const c = configOf(request.config);
  const state = decode(request.cursor, c);
  let rows;
  let stream;
  if (state.phase === 'posts') {
    const url = urlFor(`${c.pageId}/published_posts`, { fields: POST_FIELDS, limit: 100, ...(state.after ? { after: state.after } : {}) });
    const body = await graph(host, request.source, url);
    if (!Array.isArray(body.data)) throw fault('transient', 'malformed_post_collection');
    rows = body.data.map(postRecord);
    stream = 'posts';
    for (const record of rows) {
      if (state.posts.length < c.watchWindow && !state.posts.includes(record.nativeId)) state.posts.push(id(record.nativeId));
    }
    state.after = nextAfter(body, url);
    state.page += 1;
    if (!state.after || state.page >= c.maxPostPages) {
      state.phase = state.posts.length ? 'comments' : 'ready';
      state.after = null;
      state.page = 0;
    }
  } else {
    const postId = state.posts[state.post];
    if (!postId) throw fault('cursor-expired', 'cursor_post_missing');
    const url = urlFor(`${postId}/comments`, { fields: COMMENT_FIELDS, filter: 'stream', limit: 100, ...(state.after ? { after: state.after } : {}) });
    const body = await graph(host, request.source, url);
    if (!Array.isArray(body.data)) throw fault('transient', 'malformed_comment_collection');
    rows = body.data.map((row) => commentRecord(row, postId));
    stream = `comments:${postId}`;
    state.after = nextAfter(body, url);
    state.page += 1;
    if (!state.after || state.page >= c.maxCommentPages) {
      state.post += 1;
      state.page = 0;
      state.after = null;
      if (state.post >= state.posts.length) state.phase = 'ready';
    }
  }
  const records = [];
  const emitted = new Set(state.emitted);
  // published_posts is ranked: never end a page scan because a row is below the watermark.
  for (const record of rows) {
    state.seen[stream] = advance(state.seen[stream] || state.since[stream], record);
    if (!isNew(state.since[stream], record) || emitted.has(record.version)) continue;
    records.push(record);
    emitted.add(record.version);
  }
  state.emitted = [...emitted];
  if (state.phase === 'ready') {
    state.since = { ...state.since, ...state.seen };
    const active = new Set(['posts', ...state.posts.map((s) => `comments:${s}`)]);
    state.since = Object.fromEntries(Object.entries(state.since).filter(([key]) => active.has(key)));
    state.seen = {};
    state.emitted = [];
  }
  return { records, nextCursor: JSON.stringify(state), hasMore: state.phase !== 'ready' };
}

async function invoke(request, host) {
  if (!manifest.provider.capabilities.includes(request.capability)) throw fault('transient', 'capability_unsupported');
  const c = configOf(request.config);
  const args = request.args || {};
  if (request.capability === 'social.delete') {
    const body = await graph(host, request.source, urlFor(id(args.externalId)), 'DELETE');
    if (typeof body === 'boolean') return { deleted: body };
    if (typeof body.success !== 'boolean') throw fault('transient', 'delete_unconfirmed');
    return { deleted: body.success };
  }
  if (!str(args.text).trim()) throw fault('transient', 'empty_message');
  let path;
  if (request.capability === 'social.post') {
    if (args.destination !== c.pageId) throw fault('transient', 'destination_mismatch');
    path = `${c.pageId}/feed`;
  } else {
    const t = args.target;
    if (t?.platform && t.platform !== 'facebook-pages') throw fault('transient', 'wrong_platform_target');
    if (t && 'externalId' in t && (!object(t.payload) || typeof t.externalId !== 'string')) throw fault('transient', 'invalid_stored_target');
    if (t?.payload?.canComment === false || t?.canComment === false) throw fault('auth', 'cannot_comment');
    const target = t && 'externalId' in t ? t.externalId : str(t?.objectId) || str(args.ref?.externalId);
    path = `${id(target)}/comments`;
  }
  const body = await graph(host, request.source, urlFor(path), 'POST', { message: args.text, fields: WRITE_FIELDS });
  if (!str(body.id).trim()) throw fault('transient', 'write_unconfirmed_no_server_id');
  return { externalId: body.id, url: str(body.permalink_url) || `https://www.facebook.com/${body.id}` };
}

module.exports = {
  name: manifest.name, version: manifest.version, papercusp: manifest.papercusp, capabilities: [],
  providerAdapter: { describe: () => manifest.provider, syncPage, invoke },
};
