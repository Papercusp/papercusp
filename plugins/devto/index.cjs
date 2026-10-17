'use strict';
const manifest = require('./papercusp.json');
const fault = (kind, message, extra) => Object.assign(new Error(`devto:${message}`), { kind }, extra || {}, extra ? { data: extra } : {});
const ambiguous = () => fault('transient', 'post_ambiguous_do_not_retry', { retrySafe: false });
function canonical(value) {
  let url;
  try { url = new URL(value); } catch { throw fault('transient', 'invalid_canonical_url'); }
  if (typeof value !== 'string' || url.protocol !== 'https:' || url.hostname !== 'papercusp.com' || url.port || url.username || url.password || url.hash) throw fault('transient', 'invalid_canonical_url');
  return url.href;
}
async function syncPage(request) {
  if (request.cursor !== null && request.cursor !== undefined) throw fault('cursor-expired', 'cursor_unrecognised');
  return { records: [], nextCursor: null, hasMore: false, catchUp: { path: 'cold-start' } };
}
async function invoke(request, host) {
  if (request.capability !== 'blog.post') throw fault('transient', 'capability_unsupported');
  const a = request.args || {};
  if (typeof a.title !== 'string' || !a.title.trim() || [...a.title].length > 128) throw fault('transient', 'invalid_title');
  if (typeof a.markdown !== 'string' || !a.markdown.trim() || Buffer.byteLength(a.markdown) > 80000) throw fault('transient', 'invalid_markdown');
  // Forem front matter can override published/canonical_url; do not let content change intent.
  if (/^\s*---[ \t]*\r?\n/.test(a.markdown)) throw fault('transient', 'front_matter_unsupported');
  if (a.published !== undefined && typeof a.published !== 'boolean') throw fault('transient', 'invalid_published');
  if (a.tags !== undefined && (!Array.isArray(a.tags) || a.tags.length > 4 || a.tags.some((tag) => typeof tag !== 'string' || !/^[a-z0-9]{1,30}$/.test(tag)) || new Set(a.tags).size !== a.tags.length)) throw fault('transient', 'invalid_tags');
  const article = { title: a.title.trim(), body_markdown: a.markdown, published: a.published === true, canonical_url: canonical(a.canonicalUrl), ...(a.tags ? { tags: a.tags } : {}) };
  let response;
  try { response = await host.fetch({ source: request.source, request: { url: 'https://dev.to/api/articles', method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/vnd.forem.api-v1+json' }, body: JSON.stringify({ article }) } }); }
  catch { throw ambiguous(); }
  if ([401, 403].includes(response.status)) throw fault('auth', 'key_or_permission_refused');
  if (response.status === 429) {
    const retry = Number(Object.entries(response.headers || {}).find(([name]) => name.toLowerCase() === 'retry-after')?.[1]);
    throw fault('rate-limited', 'throttled', Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: Math.ceil(retry) } : {});
  }
  if (response.status >= 500 || response.status === 409) throw ambiguous();
  if (response.status !== 201) throw fault('transient', 'request_refused', { status: response.status, retrySafe: false });
  let data;
  try { data = JSON.parse(response.body); } catch { throw ambiguous(); }
  if (!Number.isSafeInteger(data?.id) || data.id < 1) throw ambiguous();
  let url;
  if (data.url !== undefined) {
    try { url = new URL(data.url); } catch { throw ambiguous(); }
    if (url.protocol !== 'https:' || url.hostname !== 'dev.to' || url.username || url.password || url.port) throw ambiguous();
  }
  return { externalId: String(data.id), published: article.published, canonicalUrl: article.canonical_url, ...(url ? { url: url.href } : {}) };
}
module.exports = { name: manifest.name, version: manifest.version, papercusp: manifest.papercusp, capabilities: [], providerAdapter: { describe: () => manifest.provider, syncPage, invoke } };
