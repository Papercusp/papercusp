'use strict';
const manifest = require('./papercusp.json');
const URL_POSTS = 'https://api.linkedin.com/rest/posts';
const HEADERS = { 'content-type': 'application/json', 'LinkedIn-Version': '202608', 'X-Restli-Protocol-Version': '2.0.0' };
const fault = (kind, message, extra) => Object.assign(new Error(`linkedin:${message}`), { kind }, extra || {}, extra ? { data: extra } : {});
function member(config) {
  const id = config?.memberId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw fault('transient', 'invalid_member_id');
  return id;
}
async function syncPage(request) {
  member(request.config);
  if (request.cursor !== null && request.cursor !== undefined) throw fault('cursor-expired', 'cursor_unrecognised');
  // r_member_social is restricted to approved developers. An ordinary Share
  // on LinkedIn grant cannot read posts; do not invent a polling endpoint.
  return { records: [], nextCursor: null, hasMore: false, catchUp: { path: 'cold-start' } };
}
function header(headers, key) {
  const entry = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === key);
  return entry?.[1];
}
function postUrn(value) {
  if (typeof value !== 'string' || !/^urn:li:(?:share|ugcPost):[0-9]+$/.test(value)) throw fault('transient', 'invalid_post_urn');
  return value;
}
async function invoke(request, host) {
  if (!manifest.provider.capabilities.includes(request.capability)) throw fault('transient', 'capability_unsupported');
  const id = member(request.config); const a = request.args || {};
  let url = URL_POSTS; let body;
  const deleting = request.capability === 'social.delete';
  if (deleting) url += `/${encodeURIComponent(postUrn(a.externalId))}`;
  else {
    if (a.destination !== id && a.destination !== `urn:li:person:${id}`) throw fault('auth', 'personal_destination_required');
    if (typeof a.text !== 'string' || !a.text.trim() || [...a.text].length > 3000) throw fault('transient', 'invalid_text');
    if (a.media !== undefined && (!Array.isArray(a.media) || a.media.length)) throw fault('transient', 'media_unsupported');
    const requestedVisibility = a.visibility ?? 'public';
    const visibility = requestedVisibility === 'public' ? 'PUBLIC' : requestedVisibility === 'followers' ? 'CONNECTIONS' : null;
    if (!visibility) throw fault('transient', 'invalid_visibility');
    body = JSON.stringify({ author: `urn:li:person:${id}`, commentary: a.text.trim(), visibility,
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false });
  }
  let response;
  try {
    response = await host.fetch({ source: request.source, request: { url, method: deleting ? 'DELETE' : 'POST', headers: HEADERS, ...(body ? { body } : {}) } });
  } catch {
    throw fault('transient', deleting ? 'delete_unconfirmed' : 'post_ambiguous_do_not_retry', { retrySafe: deleting });
  }
  if ([401, 403].includes(response.status)) throw fault('auth', 'grant_refused');
  if (response.status === 429) {
    const retry = Number(header(response.headers, 'retry-after'));
    throw fault('rate-limited', 'throttled', Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: Math.ceil(retry) } : {});
  }
  if (deleting && response.status === 404) return { deleted: false };
  if (response.status < 200 || response.status >= 300) {
    const ambiguous = !deleting && (response.status >= 500 || response.status === 409);
    throw fault('transient', ambiguous ? 'post_ambiguous_do_not_retry' : 'request_refused', { retrySafe: deleting, status: response.status });
  }
  if (deleting) return { deleted: true };
  const externalId = header(response.headers, 'x-restli-id');
  if (typeof externalId !== 'string' || !/^urn:li:(?:share|ugcPost):[0-9]+$/.test(externalId)) throw fault('transient', 'post_ambiguous_no_id_do_not_retry', { retrySafe: false });
  return { externalId, url: `https://www.linkedin.com/feed/update/${encodeURIComponent(externalId)}/` };
}
module.exports = { name: manifest.name, version: manifest.version, papercusp: manifest.papercusp, capabilities: [], providerAdapter: { describe: () => manifest.provider, syncPage, invoke } };
