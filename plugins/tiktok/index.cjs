'use strict';
const manifest = require('./papercusp.json');
const ENDPOINT = 'https://open.tiktokapis.com/v2/video/list/?fields=id,create_time,title,video_description,share_url,cover_image_url,embed_link,duration,comment_count';
const fault = (kind, message, extra) => Object.assign(new Error(`tiktok:${message}`), { kind }, extra || {});
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v) => typeof v === 'string' ? v : '';
const seconds = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000;
const watermark = (v) => v === null || (object(v) && seconds(v.seconds) && Array.isArray(v.ids) && v.ids.every((id) => typeof id === 'string'));
function configOf(raw) {
  const c = raw || {}; if (!string(c.openId).trim()) throw fault('transient', 'open_id_required');
  const bounded = (key, fallback, max) => { const n = c[key] ?? fallback; if (!Number.isInteger(n) || n < 1 || n > max) throw fault('transient', `invalid_${key}`); return n; };
  return { openId: c.openId, maxCount: bounded('maxCount', 20, 20), maxPages: bounded('maxPages', 20, 100) };
}
function fresh(config, since = null) { return { v: 1, config, ready: false, after: null, page: 0, since, newest: since, emitted: [] }; }
function decode(raw, config) {
  if (raw == null) return fresh(config);
  let s; try { s = JSON.parse(raw); } catch { throw fault('cursor-expired', 'cursor_unreadable'); }
  if (!object(s) || s.v !== 1 || !object(s.config) || typeof s.ready !== 'boolean' || !(s.after === null || (Number.isSafeInteger(s.after) && s.after >= 0)) || !Number.isInteger(s.page) || s.page < 0 || s.page > 100 || !watermark(s.since) || !watermark(s.newest) || !Array.isArray(s.emitted) || !s.emitted.every((x) => typeof x === 'string')) throw fault('cursor-expired', 'cursor_unrecognised');
  if (JSON.stringify(s.config) !== JSON.stringify(config)) return fresh(config);
  return s.ready ? fresh(config, s.newest) : s;
}
function advance(w, at, id) {
  if (!w || at > w.seconds) return { seconds: at, ids: [id] };
  return at === w.seconds && !w.ids.includes(id) ? { seconds: at, ids: [...w.ids, id] } : w;
}
function normalize(video, owner) {
  if (!object(video) || !string(video.id) || !seconds(video.create_time)) throw fault('transient', 'malformed_video');
  const occurredAt = new Date(video.create_time * 1000).toISOString();
  const text = string(video.video_description).trim() || string(video.title).trim();
  const media = { type: 'video' };
  if (string(video.cover_image_url)) { media.coverImageUrl = video.cover_image_url; media.coverImageUrlExpires = true; }
  if (string(video.embed_link)) media.embedLink = video.embed_link;
  if (typeof video.duration === 'number' && Number.isFinite(video.duration)) media.durationSeconds = video.duration;
  const payload = { id: video.id, text, platform: 'tiktok', kind: 'post', subjectId: video.id, subjectOwnerId: owner, occurredAt, url: string(video.share_url) || `https://www.tiktok.com/@_/video/${encodeURIComponent(video.id)}`, media: [media] };
  if (!text) payload.textAbsent = true;
  if (typeof video.comment_count === 'number' && Number.isFinite(video.comment_count)) payload.commentCount = video.comment_count;
  return { datatype: 'social-post', nativeId: video.id, event: 'post', payload, occurredAt, version: `${video.id}@${video.create_time}` };
}
async function syncPage(request, host) {
  const c = configOf(request.config); const s = decode(request.cursor, c);
  const response = await host.fetch({ source: request.source, request: { url: ENDPOINT, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max_count: c.maxCount, ...(s.after === null ? {} : { cursor: s.after }) }) } });
  let body; try { body = JSON.parse(response.body); } catch { throw fault('transient', 'malformed_response'); }
  const code = body?.error?.code;
  if ([401, 403].includes(response.status) || ['access_token_invalid', 'scope_not_authorized'].includes(code)) throw fault('auth', 'grant_refused');
  if (response.status === 429 || code === 'rate_limit_exceeded') {
    const retry = Number(response.headers?.['retry-after']);
    throw fault('rate-limited', 'throttled', Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: Math.ceil(retry) } : {});
  }
  if (response.status < 200 || response.status >= 300 || code !== 'ok') throw fault('transient', 'video_list_failed');
  const data = body.data;
  if (!object(data) || !Array.isArray(data.videos) || typeof data.has_more !== 'boolean') throw fault('transient', 'malformed_collection');
  const records = []; const emitted = new Set(s.emitted); let crossed = false;
  for (const video of data.videos) {
    const r = normalize(video, c.openId); const at = video.create_time;
    // Only a STRICTLY older item closes this descending scan: other videos
    // in the boundary second may still be on the following page.
    if (s.since && at < s.since.seconds) { crossed = true; break; }
    s.newest = advance(s.newest, at, r.nativeId);
    if ((!s.since || at > s.since.seconds || !s.since.ids.includes(r.nativeId)) && !emitted.has(r.version)) { records.push(r); emitted.add(r.version); }
  }
  s.page += 1; s.ready = crossed || !data.has_more;
  if (!s.ready) {
    // Vendor cursor is milliseconds and pages BACKWARDS, only within a pass.
    if (!Number.isSafeInteger(data.cursor) || data.cursor < 0 || (s.after !== null && data.cursor >= s.after)) throw fault('cursor-expired', 'paging_made_no_progress');
    if (s.page >= c.maxPages) throw fault('transient', 'page_bound_exceeded');
    s.after = data.cursor; s.emitted = [...emitted];
  } else { s.after = null; s.emitted = []; }
  return { records, nextCursor: JSON.stringify(s), hasMore: !s.ready, catchUp: s.since ? { path: 'backfill', reason: 'no-replay-supported' } : { path: 'cold-start' } };
}
async function invoke() { throw fault('transient', 'capability_unsupported'); }
module.exports = { name: manifest.name, version: manifest.version, papercusp: manifest.papercusp, capabilities: [], providerAdapter: { describe: () => manifest.provider, syncPage, invoke } };
