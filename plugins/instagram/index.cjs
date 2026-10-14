'use strict';

const manifest = require('./papercusp.json');
const API = 'https://graph.facebook.com/v26.0';
const COMMENT_FIELDS = 'id,timestamp,text,username,like_count,hidden,parent_id,replies{id,timestamp,text,username,parent_id}';

function fault(kind, message, extra) { return Object.assign(new Error(`instagram:${message}`), { kind }, extra || {}); }
const str = (v) => typeof v === 'string' ? v : '';
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const instant = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
function configOf(raw) {
  const c = raw || {};
  const igUserId = str(c.igUserId);
  if (!/^\d+$/.test(igUserId)) throw fault('transient', 'invalid_ig_user_id');
  const bound = (key, max, fallback) => {
    const value = c[key] === undefined ? fallback : c[key];
    if (!Number.isInteger(value) || value < 1 || value > max) throw fault('transient', `invalid_${key}`);
    return value;
  };
  return { igUserId, watchWindow: bound('watchWindow', 25, 25), maxMediaPages: bound('maxMediaPages', 20, 20) };
}
function urlFor(path, params) {
  const url = new URL(`${API}/${path}`);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
  return url.href;
}
function nextAfter(body, currentUrl) {
  const raw = body?.paging?.next;
  if (!raw) return null;
  let next; try { next = new URL(raw); } catch { throw fault('transient', 'invalid_paging_url'); }
  const current = new URL(currentUrl);
  if (next.origin !== current.origin || next.pathname !== current.pathname || next.username || next.password || next.hash) throw fault('transient', 'paging_outside_resource');
  const after = next.searchParams.get('after');
  if (!after || after.length > 8192 || after === current.searchParams.get('after')) throw fault('cursor-expired', 'paging_made_no_progress');
  return after;
}
async function graph(host, source, url, method = 'GET', params) {
  const response = await host.fetch({ source, request: { url, method, ...(params ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() } : {}) } });
  let body; try { body = JSON.parse(response.body); } catch { body = null; }
  const code = body?.error?.code;
  if (response.status === 429 || code === 4 || code === 17 || code === 80002) {
    const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    let retryAfterSeconds = Number(headers['retry-after']);
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
      retryAfterSeconds = undefined;
      let usage; try { usage = JSON.parse(headers['x-business-use-case-usage'] || '{}'); } catch { usage = {}; }
      const holds = Object.values(usage).flat().filter((row) => row?.type === 'instagram')
        .map((row) => row.estimated_time_to_regain_access).filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
      if (holds.length) retryAfterSeconds = Math.ceil(Math.max(...holds) * 60);
    }
    throw fault('rate-limited', 'graph_throttled', retryAfterSeconds === undefined ? {} : { retryAfterSeconds: Math.ceil(retryAfterSeconds) });
  }
  if (response.status === 401 || response.status === 403 || code === 10 || code === 190 || code === 200) throw fault('auth', 'graph_grant_refused');
  if (response.status < 200 || response.status >= 300 || body?.error || body === null) {
    // Only this explicit type/field refusal permits the alternate media probe.
    // Missing objects, insufficient grants and transient failures stay failures.
    const unsupportedCommentField = method === 'GET' && code === 100
      && /^Tried accessing nonexisting field \(media\) on node type \([A-Za-z_]+\)/.test(str(body?.error?.message));
    throw fault('transient', method === 'POST' ? 'write_unconfirmed_do_not_retry' : 'graph_request_failed',
      unsupportedCommentField ? { unsupportedCommentField: true } : {});
  }
  return body;
}
function commentRecord(comment, mediaId) {
  if (!object(comment) || !str(comment.id) || !instant(comment.timestamp)) throw fault('transient', 'malformed_comment');
  const reply = str(comment.parent_id);
  const payload = {
    id: comment.id, text: str(comment.text), occurredAt: comment.timestamp,
    platform: 'instagram', kind: reply ? 'reply' : 'comment', subjectId: mediaId,
    mediaId, replyToId: reply || mediaId,
  };
  if (str(comment.username)) payload.author = comment.username;
  if (typeof comment.like_count === 'number' && Number.isFinite(comment.like_count)) payload.likeCount = comment.like_count;
  if (typeof comment.hidden === 'boolean') payload.hidden = comment.hidden;
  if (!payload.text) payload.textAbsent = true;
  return { datatype: 'social-post', nativeId: comment.id, event: reply ? 'reply' : 'comment', payload, occurredAt: comment.timestamp, version: `${comment.id}@${comment.timestamp}` };
}
function flattenComments(rows, mediaId) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    out.push(commentRecord(row, mediaId));
    if (row.replies?.paging?.next) throw fault('transient', 'expanded_reply_window_incomplete');
    if (Array.isArray(row.replies?.data)) out.push(...flattenComments(row.replies.data.map((reply) => ({ ...reply, parent_id: str(reply.parent_id) || row.id })), mediaId));
  }
  return out;
}
function fresh(config, since = {}) { return { v: 1, config, phase: 'media', mediaAfter: null, mediaPage: 0, mediaIds: [], mediaIndex: 0, since, seen: {} }; }
function watermarkValid(w) { return object(w) && instant(w.at) && Array.isArray(w.ids) && w.ids.every((id) => typeof id === 'string'); }
function decode(raw, config) {
  if (raw == null) return fresh(config);
  let state; try { state = JSON.parse(raw); } catch { throw fault('cursor-expired', 'cursor_unreadable'); }
  if (!object(state) || state.v !== 1 || !object(state.config) || !['media', 'comments', 'ready'].includes(state.phase)
    || !Array.isArray(state.mediaIds) || state.mediaIds.length > 25 || !state.mediaIds.every((id) => /^[A-Za-z0-9_-]+$/.test(id))
    || !Number.isInteger(state.mediaIndex) || state.mediaIndex < 0 || state.mediaIndex > state.mediaIds.length
    || !Number.isInteger(state.mediaPage) || state.mediaPage < 0 || state.mediaPage > 20
    || !(state.mediaAfter === null || (typeof state.mediaAfter === 'string' && state.mediaAfter.length <= 8192))
    || !object(state.since) || !object(state.seen) || ![...Object.values(state.since), ...Object.values(state.seen)].every(watermarkValid)) throw fault('cursor-expired', 'cursor_unrecognised');
  if (JSON.stringify(state.config) !== JSON.stringify(config)) return fresh(config);
  if (state.phase === 'ready') return fresh(config, state.since);
  return state;
}
function isNew(w, r) { return !w || Date.parse(r.occurredAt) > Date.parse(w.at) || (Date.parse(r.occurredAt) === Date.parse(w.at) && !w.ids.includes(r.nativeId)); }
function advance(w, r) {
  if (!w || Date.parse(r.occurredAt) > Date.parse(w.at)) return { at: r.occurredAt, ids: [r.nativeId] };
  if (Date.parse(r.occurredAt) === Date.parse(w.at) && !w.ids.includes(r.nativeId)) return { at: w.at, ids: [...w.ids, r.nativeId] };
  return w;
}
async function syncPage(request, host) {
  const config = configOf(request.config); const state = decode(request.cursor, config);
  if (state.phase === 'media') {
    const mediaUrl = urlFor(`${config.igUserId}/media`, { fields: 'id', limit: config.watchWindow, ...(state.mediaAfter ? { after: state.mediaAfter } : {}) });
    const body = await graph(host, request.source, mediaUrl);
    if (!Array.isArray(body.data)) throw fault('transient', 'malformed_media_collection');
    for (const row of body.data) {
      if (!/^[A-Za-z0-9_-]+$/.test(str(row?.id))) throw fault('transient', 'malformed_media');
      if (!state.mediaIds.includes(row.id) && state.mediaIds.length < config.watchWindow) state.mediaIds.push(row.id);
    }
    state.mediaAfter = nextAfter(body, mediaUrl); state.mediaPage += 1;
    if (!state.mediaAfter || state.mediaPage >= config.maxMediaPages || state.mediaIds.length >= config.watchWindow) {
      state.phase = state.mediaIds.length ? 'comments' : 'ready'; state.mediaAfter = null;
    }
    return { records: [], nextCursor: JSON.stringify(state), hasMore: state.phase !== 'ready' };
  }
  const mediaId = state.mediaIds[state.mediaIndex];
  const commentUrl = urlFor(`${mediaId}/comments`, { fields: COMMENT_FIELDS, limit: 50 });
  const body = await graph(host, request.source, commentUrl);
  if (!Array.isArray(body.data) || body.data.length > 50) throw fault('transient', 'malformed_comment_window');
  const previous = state.since[mediaId];
  // A full cold page has the same missing-history risk as a warm page that
  // no longer reaches its watermark. Do not commit either as complete history.
  if (body.data.length === 50 && (!previous || body.data.every((row) => instant(row.timestamp) && Date.parse(row.timestamp) > Date.parse(previous.at)))) {
    throw fault('transient', 'capped_window_overflow', { lossRisk: { kind: 'capped-window-overflow', mediaId } });
  }
  const records = [];
  const pageIds = new Set();
  for (const record of flattenComments(body.data, mediaId)) {
    if (pageIds.has(record.nativeId)) continue;
    pageIds.add(record.nativeId);
    const stream = record.event === 'reply' ? `replies:${mediaId}:${record.payload.replyToId}` : mediaId;
    const watermark = state.since[stream];
    state.seen[stream] = advance(state.seen[stream] || watermark, record);
    if (isNew(watermark, record)) records.push(record);
  }
  state.mediaIndex += 1;
  if (state.mediaIndex >= state.mediaIds.length) {
    state.phase = 'ready'; state.since = { ...state.since, ...state.seen }; state.seen = {};
    state.since = Object.fromEntries(Object.entries(state.since).filter(([id]) => state.mediaIds.some((media) => id === media || id.startsWith(`replies:${media}:`))));
  }
  return { records, nextCursor: JSON.stringify(state), hasMore: state.phase !== 'ready' };
}
function mediaFrom(args) {
  if (!Array.isArray(args.media) || args.media.length === 0) throw fault('transient', 'media_required_instagram_is_media_primary');
  if (args.media.length !== 1) throw fault('transient', 'carousel_unsupported');
  const media = args.media[0];
  if (!object(media) || !['image', 'video'].includes(media.type)) throw fault('transient', 'invalid_media_type');
  let url; try { url = new URL(media.url); } catch { throw fault('transient', 'invalid_media_url'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw fault('transient', 'invalid_media_url');
  return media;
}
function targetId(raw) { if (!/^[A-Za-z0-9_-]+$/.test(str(raw))) throw fault('transient', 'invalid_object_id'); return raw; }
async function statusOf(host, source, containerId) {
  const probe = await graph(host, source, urlFor(containerId, { fields: 'status_code' }));
  if (!['FINISHED', 'IN_PROGRESS', 'ERROR', 'EXPIRED', 'PUBLISHED'].includes(probe?.status_code)) throw fault('transient', 'unrecognised_container_status');
  return probe.status_code;
}
async function invoke(request, host) {
  const config = configOf(request.config); const args = request.args || {};
  if (request.capability === 'social.reply') {
    if (args.target?.platform && args.target.platform !== 'instagram') throw fault('transient', 'wrong_platform_target');
    if (args.target?.hidden === true) throw fault('transient', 'hidden_comment');
    const target = targetId(str(args.target?.topLevelCommentId) || str(args.target?.objectId) || str(args.target?.externalId) || str(args.ref?.externalId));
    if (!target || !str(args.text).trim()) throw fault('transient', 'invalid_reply');
    const body = await graph(host, request.source, urlFor(`${target}/replies`), 'POST', { message: args.text });
    if (!str(body.id)) throw fault('transient', 'write_unconfirmed_no_server_id');
    return { externalId: body.id };
  }
  if (request.capability === 'social.post') {
    if (args.destination !== config.igUserId) throw fault('transient', 'destination_mismatch');
    const media = mediaFrom(args);
    const create = await graph(host, request.source, urlFor(`${config.igUserId}/media`), 'POST', { ...(media.type === 'video' ? { video_url: media.url, media_type: 'VIDEO' } : { image_url: media.url }), ...(str(args.text).trim() ? { caption: args.text } : {}) });
    if (!str(create.id)) throw fault('transient', 'write_unconfirmed_no_container_id');
    let status;
    for (let minute = 0; minute <= 5; minute += 1) {
      status = await statusOf(host, request.source, targetId(create.id));
      if (status === 'FINISHED') break;
      if (status !== 'IN_PROGRESS' || minute === 5) throw fault('transient', `container_${status.toLowerCase()}`, { containerId: create.id, retrySafe: status === 'IN_PROGRESS' ? null : false });
      // Lifecycle observation, not a retry of container creation or publication.
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
    try {
      const published = await graph(host, request.source, urlFor(`${config.igUserId}/media_publish`), 'POST', { creation_id: create.id });
      if (!str(published.id)) throw fault('transient', 'write_unconfirmed_no_media_id');
      return { externalId: published.id, ...(str(published.permalink) ? { url: published.permalink } : {}) };
    } catch {
      let observedStatus = null; try { observedStatus = await statusOf(host, request.source, create.id); } catch {}
      throw fault('transient', 'publish_ambiguous_do_not_retry', { containerId: create.id, observedStatus, retrySafe: observedStatus === 'FINISHED' ? true : observedStatus === 'PUBLISHED' || observedStatus === 'ERROR' || observedStatus === 'EXPIRED' ? false : null });
    }
  }
  if (request.capability === 'social.delete') {
    const externalId = targetId(str(args.externalId));
    let comment;
    try {
      comment = await graph(host, request.source, urlFor(externalId, { fields: 'id,media' }));
    } catch (error) {
      if (error.unsupportedCommentField !== true) throw error;
    }
    if (comment && (comment.id !== externalId || !str(comment.media?.id))) throw fault('transient', 'delete_requires_comment_object');
    const mediaId = comment ? targetId(comment.media.id) : externalId;
    const media = await graph(host, request.source, urlFor(mediaId, { fields: 'id,media_type,owner' }));
    if (media?.id !== mediaId || !['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM'].includes(media.media_type)
      || str(media.owner?.id) !== config.igUserId) throw fault('transient', 'delete_media_not_owned');
    const body = await graph(host, request.source, urlFor(externalId), 'DELETE');
    if (typeof body === 'boolean') return { deleted: body };
    if (typeof body?.success !== 'boolean') throw fault('transient', 'delete_unconfirmed');
    return { deleted: body.success };
  }
  throw fault('transient', 'capability_unsupported');
}

module.exports = { name: manifest.name, version: manifest.version, papercusp: manifest.papercusp, capabilities: [], providerAdapter: { describe: () => manifest.provider, syncPage, invoke } };
