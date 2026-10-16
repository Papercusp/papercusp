'use strict';
const manifest = require('./papercusp.json');
const API = 'https://www.googleapis.com/youtube/v3';
const fault = (kind, message, extra) => Object.assign(new Error(`youtube:${message}`), { kind }, extra || {}, extra ? { data: extra } : {});
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v) => typeof v === 'string' ? v : '';
const instant = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
function configOf(raw) {
  const c = raw || {}; if (!/^[A-Za-z0-9_-]+$/.test(string(c.channelId))) throw fault('transient', 'invalid_channel_id');
  const bounded = (key) => { const n = c[key] ?? 20; if (!Number.isInteger(n) || n < 1 || n > 1000) throw fault('transient', `invalid_${key}`); return n; };
  return { channelId: c.channelId, maxPages: bounded('maxPages'), maxReplyPages: bounded('maxReplyPages') };
}
function urlFor(path, params) { const u = new URL(`${API}/${path}`); for (const [k, v] of Object.entries(params || {})) if (v !== null) u.searchParams.set(k, String(v)); return u.href; }
async function http(host, source, url, body) {
  let response;
  try { response = await host.fetch({ source, request: { url, method: body ? 'POST' : 'GET', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) } }); }
  catch (error) { if (body) throw fault('transient', 'reply_ambiguous_do_not_retry', { retrySafe: false }); throw error; }
  let data; try { data = JSON.parse(response.body); } catch { data = null; }
  const reason = string(data?.error?.errors?.[0]?.reason);
  if (response.status === 429 || ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)) {
    const retry = Number(response.headers?.['retry-after']);
    throw fault('rate-limited', reason || 'throttled', Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: Math.ceil(retry) } : {});
  }
  if (response.status === 401 || (response.status === 403 && ['insufficientPermissions', 'forbidden'].includes(reason))) throw fault('auth', 'grant_refused');
  if (response.status < 200 || response.status >= 300 || !data || data.error) throw fault('transient', body && response.status >= 500 ? 'reply_ambiguous_do_not_retry' : 'request_refused', { status: response.status, reason, ...(body ? { retrySafe: false } : {}) });
  return data;
}
function nextToken(body, current) {
  const next = body.nextPageToken;
  if (next === undefined || next === null || next === '') return null;
  if (typeof next !== 'string' || next.length > 8192 || next === current) throw fault('cursor-expired', 'paging_made_no_progress');
  return next;
}
function fresh(config, since = {}) { return { v: 1, config, phase: 'activities', after: null, page: 0, since, seen: {}, emitted: [], queue: [], replyAfter: null, replyPage: 0 }; }
function decode(raw, config) {
  if (raw == null) return fresh(config);
  let s; try { s = JSON.parse(raw); } catch { throw fault('cursor-expired', 'cursor_unreadable'); }
  const token = (v) => v === null || (typeof v === 'string' && v.length <= 8192);
  const watermarks = (v) => object(v) && Object.values(v).every((w) => object(w) && instant(w.at) && Array.isArray(w.ids) && w.ids.every((id) => typeof id === 'string'));
  if (!object(s) || s.v !== 1 || !object(s.config) || !['activities', 'threads', 'replies', 'ready'].includes(s.phase) || !token(s.after) || !token(s.replyAfter) || !Number.isInteger(s.page) || s.page < 0 || s.page > 1000 || !Number.isInteger(s.replyPage) || s.replyPage < 0 || s.replyPage > 1000 || !watermarks(s.since) || !watermarks(s.seen) || !Array.isArray(s.emitted) || !s.emitted.every((x) => typeof x === 'string') || !Array.isArray(s.queue) || s.queue.length > 100 || !s.queue.every((q) => object(q) && string(q.parentId) && string(q.threadId) && typeof q.videoId === 'string')) throw fault('cursor-expired', 'cursor_unrecognised');
  if (JSON.stringify(s.config) !== JSON.stringify(config)) return fresh(config);
  return s.phase === 'ready' ? fresh(config, s.since) : s;
}
function advance(w, row) {
  if (!w || Date.parse(row.occurredAt) > Date.parse(w.at)) return { at: row.occurredAt, ids: [row.nativeId] };
  return Date.parse(row.occurredAt) === Date.parse(w.at) && !w.ids.includes(row.nativeId) ? { at: w.at, ids: [...w.ids, row.nativeId] } : w;
}
function comment(row, context, channelId) {
  const s = row?.snippet; const at = s?.updatedAt || s?.publishedAt;
  if (!object(s) || !string(row.id) || !instant(at) || !instant(s.publishedAt)) throw fault('transient', 'malformed_comment');
  const parentId = string(s.parentId); const event = parentId ? 'reply' : 'comment';
  const text = string(s.textOriginal) || string(s.textDisplay);
  const payload = { id: row.id, text, platform: 'youtube', kind: event, channelId: string(s.channelId) || channelId,
    threadId: context.threadId, subjectId: context.videoId || context.threadId, subjectOwnerId: channelId,
    occurredAt: at, publishedAt: s.publishedAt, author: string(s.authorDisplayName), authorChannelId: string(s.authorChannelId?.value) };
  if (parentId) payload.replyToId = parentId;
  if (context.videoId) { payload.videoId = context.videoId; payload.url = `https://www.youtube.com/watch?v=${encodeURIComponent(context.videoId)}&lc=${encodeURIComponent(row.id)}`; }
  if (typeof context.canReply === 'boolean') payload.canReply = context.canReply;
  if (typeof context.isPublic === 'boolean') payload.visibility = context.isPublic ? 'public' : 'direct';
  if (at !== s.publishedAt) payload.editedAt = at;
  if (!text) payload.textAbsent = true;
  return { datatype: 'social-post', nativeId: row.id, event, payload, occurredAt: at, version: `${row.id}@${at}` };
}
function activity(row, channelId) {
  const s = row?.snippet;
  if (!object(s) || !string(row.id) || !instant(s.publishedAt)) throw fault('transient', 'malformed_activity');
  const event = /^[a-z][a-z0-9-]*$/.test(string(s.type)) ? s.type : 'activity';
  const videoId = string(row.contentDetails?.upload?.videoId);
  const payload = { id: row.id, text: string(s.description) || string(s.title), platform: 'youtube', kind: 'post', activityType: event,
    subjectId: videoId || row.id, subjectOwnerId: channelId, channelId, occurredAt: s.publishedAt, author: string(s.channelTitle) };
  if (videoId) { payload.videoId = videoId; payload.url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`; }
  if (!payload.text) payload.textAbsent = true;
  return { datatype: 'social-post', nativeId: row.id, event, payload, occurredAt: s.publishedAt, version: `${row.id}@${s.publishedAt}` };
}
async function syncPage(request, host) {
  const c = configOf(request.config); const s = decode(request.cursor, c); const records = []; const emitted = new Set(s.emitted);
  const admit = (r, stream) => {
    const w = s.since[stream]; s.seen[stream] = advance(s.seen[stream] || w, r);
    if ((!w || Date.parse(r.occurredAt) > Date.parse(w.at) || (Date.parse(r.occurredAt) === Date.parse(w.at) && !w.ids.includes(r.nativeId))) && !emitted.has(r.version)) { records.push(r); emitted.add(r.version); }
  };
  const read = async (path, params) => { const body = await http(host, request.source, urlFor(path, params)); if (!Array.isArray(body.items)) throw fault('transient', 'malformed_collection'); return body; };
  if (s.phase === 'activities') {
    const floor = s.since.activities ? new Date(Date.parse(s.since.activities.at) - 1).toISOString() : null;
    const body = await read('activities', { part: 'snippet,contentDetails', channelId: c.channelId, maxResults: 50, publishedAfter: floor, pageToken: s.after });
    const next = nextToken(body, s.after); if (next && s.page + 1 >= c.maxPages) throw fault('transient', 'activity_page_bound_exceeded');
    for (const row of body.items) admit(activity(row, c.channelId), 'activities');
    s.after = next; s.page += 1; if (!next) { s.phase = 'threads'; s.page = 0; }
  } else if (s.phase === 'threads') {
    // This endpoint has no publishedAfter. Never send a fabricated filter or
    // stop on an old publication: an older comment can have a newer edit.
    const body = await read('commentThreads', { part: 'snippet', allThreadsRelatedToChannelId: c.channelId, maxResults: 100, order: 'time', textFormat: 'plainText', pageToken: s.after });
    const next = nextToken(body, s.after); if (next && s.page + 1 >= c.maxPages) throw fault('transient', 'thread_page_bound_exceeded');
    for (const thread of body.items) {
      const t = thread?.snippet; if (!object(t) || !string(thread.id) || !Number.isInteger(t.totalReplyCount) || t.totalReplyCount < 0) throw fault('transient', 'malformed_thread');
      const context = { threadId: thread.id, videoId: string(t.videoId), parentId: string(t.topLevelComment?.id), canReply: t.canReply, isPublic: t.isPublic };
      if (!context.parentId) throw fault('transient', 'thread_parent_missing');
      admit(comment(t.topLevelComment, context, c.channelId), 'comments');
      if (t.totalReplyCount > 0) s.queue.push(context);
    }
    s.after = next; s.page += 1; s.phase = s.queue.length ? 'replies' : next ? 'threads' : 'ready';
  } else {
    const context = s.queue[0]; if (!context) throw fault('cursor-expired', 'reply_parent_missing');
    const body = await read('comments', { part: 'snippet', parentId: context.parentId, maxResults: 100, textFormat: 'plainText', pageToken: s.replyAfter });
    const next = nextToken(body, s.replyAfter); if (next && s.replyPage + 1 >= c.maxReplyPages) throw fault('transient', 'reply_page_bound_exceeded');
    for (const row of body.items) {
      if (row?.snippet?.parentId !== context.parentId) throw fault('transient', 'reply_parent_mismatch');
      admit(comment(row, context, c.channelId), 'comments');
    }
    s.replyAfter = next; s.replyPage += 1;
    if (!next) { s.queue.shift(); s.replyPage = 0; if (!s.queue.length) s.phase = s.after ? 'threads' : 'ready'; }
  }
  s.emitted = [...emitted];
  if (s.phase === 'ready') { s.since = { ...s.since, ...s.seen }; s.seen = {}; s.emitted = []; }
  return { records, nextCursor: JSON.stringify(s), hasMore: s.phase !== 'ready', catchUp: Object.keys(s.since).length ? { path: 'backfill', reason: 'no-replay-supported' } : { path: 'cold-start' } };
}
async function invoke(request, host) {
  if (request.capability !== 'social.reply') throw fault('transient', 'capability_unsupported');
  configOf(request.config); const a = request.args || {}; let t = a.target || {};
  if (t.platform && t.platform !== 'youtube') throw fault('transient', 'wrong_platform_target');
  if ('externalId' in t) {
    if (!object(t.payload) || typeof t.externalId !== 'string') throw fault('transient', 'invalid_stored_target');
    // YouTube is two-level: replying to a reply addresses its top-level parent.
    // Neither a video id nor a thread id is a comments.insert parent selector.
    t = { parentCommentId: string(t.payload.replyToId) || t.externalId, videoId: string(t.payload.videoId), canReply: t.payload.canReply };
  }
  if (!string(t.parentCommentId) || t.canReply === false) throw fault('auth', 'reply_not_permitted');
  if (typeof a.text !== 'string' || !a.text.trim()) throw fault('transient', 'text_required');
  if (a.visibility !== undefined && a.visibility !== 'public') throw fault('transient', 'visibility_unsupported');
  const body = await http(host, request.source, urlFor('comments', { part: 'snippet' }), { snippet: { parentId: t.parentCommentId, textOriginal: a.text } });
  if (!string(body.id)) throw fault('transient', 'reply_ambiguous_no_id_do_not_retry', { retrySafe: false });
  return { externalId: body.id, ...(string(t.videoId) ? { url: `https://www.youtube.com/watch?v=${encodeURIComponent(t.videoId)}&lc=${encodeURIComponent(body.id)}` } : {}) };
}
module.exports = { name: manifest.name, version: manifest.version, papercusp: manifest.papercusp, capabilities: [], providerAdapter: { describe: () => manifest.provider, syncPage, invoke } };
