'use strict';

const manifest = require('./papercusp.json');
const API = 'https://oauth.reddit.com';
const STREAMS = ['comments', 'mentions', 'submitted'];
const str = (v) => typeof v === 'string' ? v : '';
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fullname = (v) => /^t[134]_[a-z0-9]+$/i.test(str(v));
function fault(kind, message, data) { return Object.assign(new Error(`reddit:${message}`), { kind }, data || {}, data ? { data } : {}); }
function configOf(raw) {
  const c = raw || {}; const accountLabel = str(c.accountLabel);
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(accountLabel)) throw fault('auth', 'connected_username_missing');
  const bounded = (key, max, fallback) => { const n = c[key] === undefined ? fallback : c[key]; if (!Number.isInteger(n) || n < 1 || n > max) throw fault('transient', `invalid_${key}`); return n; };
  return { accountLabel, pageSize: bounded('pageSize', 100, 50), maxPages: bounded('maxPages', 1000, 200) };
}
function urlFor(path, params) {
  const url = new URL(path, API); url.searchParams.set('raw_json', '1');
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  return url.href;
}
async function request(host, source, path, params, form) {
  let response;
  try { response = await host.fetch({ source, request: { url: urlFor(path, params), method: form ? 'POST' : 'GET',
    ...(form ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() } : {}) } }); }
  catch (error) { if (form) throw fault('transient', 'write_unconfirmed_do_not_retry', { retrySafe: false }); throw error; }
  let body; try { body = JSON.parse(response.body); } catch { body = null; }
  const errors = body?.json?.errors;
  if (response.status === 401 || response.status === 403) throw fault('auth', 'grant_refused');
  if (response.status === 429 || (Array.isArray(errors) && errors.some((e) => e?.[0] === 'RATELIMIT'))) {
    const delay = Number(response.headers?.['retry-after'] ?? response.headers?.['x-ratelimit-reset']);
    throw fault('rate-limited', 'throttled', Number.isFinite(delay) && delay > 0 ? { retryAfterSeconds: Math.ceil(delay) } : {});
  }
  if (response.status < 200 || response.status >= 300 || body?.error || (Array.isArray(errors) && errors.length) || (!form && !body)) {
    throw fault('transient', form ? 'write_unconfirmed_do_not_retry' : 'request_failed', form ? { retrySafe: false } : {});
  }
  return body;
}
function listing(body) {
  if (body?.kind !== 'Listing' || !Array.isArray(body?.data?.children)) throw fault('transient', 'malformed_listing');
  return body.data.children;
}
function version(row) {
  const edit = row.edited;
  if (edit !== undefined && edit !== false && edit !== true && !(typeof edit === 'number' && Number.isFinite(edit) && edit > 0)) throw fault('transient', 'malformed_edit');
  return `${row.name}@${edit === true ? 'e-legacy' : typeof edit === 'number' ? `e${edit}` : `c${row.created_utc}`}`;
}
function canonicalUrl(value) {
  if (!str(value)) return undefined;
  try { const url = new URL(value, 'https://www.reddit.com'); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
function record(child, stream) {
  const row = child?.data;
  if (!object(row) || !fullname(row.name)) throw fault('transient', 'malformed_thing');
  // The inbox also contains private messages. Never turn a t4 message into a content reply.
  if (stream !== 'submitted' && child.kind === 't4' && row.was_comment !== true) return null;
  const kind = stream === 'submitted' ? 't3' : 't1';
  if (child.kind !== kind || !row.name.startsWith(`${kind}_`) || !Number.isFinite(row.created_utc) || row.created_utc < 0) throw fault('transient', 'malformed_content');
  const occurredAt = new Date(row.created_utc * 1000).toISOString();
  const event = stream === 'submitted' ? 'post' : stream === 'mentions' ? 'mention' : 'reply';
  const text = str(stream === 'submitted' ? row.selftext : row.body) || (stream === 'submitted' ? str(row.title) : '');
  const linkId = str(row.link_id) || str(row.context).match(/\/comments\/([a-z0-9]+)\//i)?.[1];
  const payload = { id: row.name, fullname: row.name, parentFullname: row.name, text, platform: 'reddit', kind: event,
    subreddit: str(row.subreddit), author: str(row.author) || '[deleted]', occurredAt,
    subjectId: kind === 't3' ? row.name : linkId ? linkId.startsWith('t3_') ? linkId : `t3_${linkId}` : row.name };
  if (str(row.title)) payload.title = row.title;
  if (str(row.parent_id)) payload.replyToId = row.parent_id;
  if (str(row.link_id)) payload.linkFullname = row.link_id;
  const url = canonicalUrl(row.permalink || row.context); if (url) payload.url = url;
  if (!text) payload.textAbsent = true;
  return { datatype: 'social-post', nativeId: row.name, event, payload, occurredAt, version: version(row) };
}
function fresh(config, since = {}) { return { v: 1, config, phase: 0, after: null, page: 0, since, newest: null, emitted: [], anchors: [] }; }
function decode(raw, config) {
  if (raw == null) return fresh(config);
  let s; try { s = JSON.parse(raw); } catch { throw fault('cursor-expired', 'cursor_unreadable'); }
  const marker = (v) => v === null || (object(v) && fullname(v.name) && typeof v.version === 'string');
  if (!object(s) || s.v !== 1 || !object(s.config) || !Number.isInteger(s.phase) || s.phase < 0 || s.phase > 3 || !Number.isInteger(s.page) || s.page < 0 || s.page > 1000 || !(s.after === null || fullname(s.after)) || !object(s.since) || !Object.entries(s.since).every(([k, v]) => STREAMS.includes(k) && marker(v)) || !marker(s.newest) || !Array.isArray(s.emitted) || !s.emitted.every((v) => typeof v === 'string') || !Array.isArray(s.anchors) || !s.anchors.every(fullname)) throw fault('cursor-expired', 'cursor_unrecognised');
  if (JSON.stringify(s.config) !== JSON.stringify(config)) return fresh(config);
  return s.phase === 3 ? fresh(config, s.since) : s;
}
async function syncPage(input, host) {
  const config = configOf(input.config); const state = decode(input.cursor, config); const stream = STREAMS[state.phase];
  const prior = state.since[stream];
  const path = stream === 'submitted' ? `/user/${encodeURIComponent(config.accountLabel)}/submitted` : `/message/${stream}`;
  const rows = listing(await request(host, input.source, path, { limit: config.pageSize, ...(state.after ? { after: state.after } : {}) }));
  const records = []; const emitted = new Set(state.emitted); let found = false;
  for (const child of rows) {
    const row = child?.data; const normalized = record(child, stream);
    if (!state.newest) state.newest = { name: row.name, version: normalized?.version ?? version(row) };
    if (prior?.name === row.name) {
      found = true;
      if (normalized && prior.version !== normalized.version) records.push(normalized);
      break;
    }
    if (normalized) { const key = `${normalized.event}:${normalized.version}`; if (!emitted.has(key)) { records.push(normalized); emitted.add(key); } }
  }
  state.page += 1;
  const next = !found && rows.length >= config.pageSize ? rows.at(-1)?.data?.name : null;
  if (next && (next === state.after || state.anchors.includes(next))) throw fault('cursor-expired', 'paging_made_no_progress');
  if (next && state.page >= config.maxPages) throw fault('transient', 'page_bound_exceeded');
  const catchUp = !prior ? { path: 'cold-start' } : { path: 'backfill', reason: !next && !found ? 'cursor-expired' : 'no-replay-supported' };
  if (next) { state.after = next; state.anchors.push(next); }
  else {
    if (state.newest) state.since[stream] = state.newest;
    state.phase += 1; state.after = null; state.page = 0; state.newest = null; state.anchors = [];
  }
  state.emitted = state.phase === 3 ? [] : [...emitted];
  return { records, nextCursor: JSON.stringify(state), hasMore: state.phase < 3, catchUp };
}
function targetOf(target) {
  if (target?.platform !== 'reddit') throw fault('transient', 'invalid_content_target');
  let fullname = target.parentFullname;
  if ('externalId' in target) {
    if (!object(target.payload) || typeof target.externalId !== 'string') throw fault('transient', 'invalid_stored_target');
    fullname = str(target.payload.parentFullname) || str(target.payload.fullname) || target.externalId;
  }
  if (!/^t[13]_[a-z0-9]+$/i.test(str(fullname))) throw fault('transient', 'invalid_content_target');
  return fullname;
}
async function invoke(input, host) {
  if (!manifest.provider.capabilities.includes(input.capability)) throw fault('transient', 'capability_unsupported');
  const config = configOf(input.config); const args = input.args || {};
  if (input.capability === 'social.delete') {
    const id = targetOf(args.target);
    const before = listing(await request(host, input.source, '/api/info', { id })).find((c) => c?.data?.name === id)?.data;
    if (!before || before.author === '[deleted]' || before.removed === true) return { deleted: false, detail: 'nothing was there to delete' };
    if (str(before.author).toLowerCase() !== config.accountLabel.toLowerCase()) throw fault('auth', 'delete_not_owned');
    await request(host, input.source, '/api/del', null, { id });
    const after = listing(await request(host, input.source, '/api/info', { id })).find((c) => c?.data?.name === id)?.data;
    return !after || after.author === '[deleted]' || after.removed === true
      ? { deleted: true } : { deleted: false, detail: 'delete was issued but its effect is not yet confirmed' };
  }
  if (!str(args.text).trim() || (args.media !== undefined && (!Array.isArray(args.media) || args.media.length))) throw fault('transient', 'text_required_media_unsupported');
  if (args.visibility !== undefined && args.visibility !== 'public') throw fault('transient', 'visibility_unsupported');
  let path; let form;
  if (input.capability === 'social.reply') { path = '/api/comment'; form = { api_type: 'json', thing_id: targetOf(args.target), text: args.text }; }
  else {
    const destination = str(args.destination).replace(/^reddit:/, ''); const split = destination.indexOf('#');
    const sr = destination.slice(0, split).replace(/^\/?r\//, ''); const title = destination.slice(split + 1).trim();
    if (split < 1 || !/^[A-Za-z0-9_]{2,21}$/.test(sr) || !title || [...title].length > 300) throw fault('transient', 'destination_needs_subreddit_and_title');
    path = '/api/submit'; form = { api_type: 'json', sr, kind: 'self', title, text: args.text, resubmit: 'false' };
  }
  const body = await request(host, input.source, path, null, form);
  const created = input.capability === 'social.reply' ? body?.json?.data?.things?.[0]?.data : body?.json?.data;
  const id = str(created?.name);
  if (!/^t[13]_[a-z0-9]+$/i.test(id)) throw fault('transient', 'write_unconfirmed_do_not_retry', { retrySafe: false });
  const url = canonicalUrl(created.permalink || created.url);
  return { externalId: id, ref: `reddit:${id}`, ...(url ? { url } : {}) };
}
exports.providerAdapter = { describe: () => manifest.provider, syncPage, invoke };
