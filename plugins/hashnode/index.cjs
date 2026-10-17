'use strict';
const manifest = require('./papercusp.json');
const fault = (kind, message, extra) => Object.assign(new Error(`hashnode:${message}`), { kind }, extra || {}, extra ? { data: extra } : {});
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
  if (!/^[a-fA-F0-9]{24}$/.test(request.config?.publicationId || '')) throw fault('transient', 'invalid_publication_id');
  if (typeof a.title !== 'string' || !a.title.trim() || [...a.title].length > 128) throw fault('transient', 'invalid_title');
  if (typeof a.markdown !== 'string' || !a.markdown.trim() || Buffer.byteLength(a.markdown) > 80000) throw fault('transient', 'invalid_markdown');
  if (a.published !== undefined && typeof a.published !== 'boolean') throw fault('transient', 'invalid_published');
  if (a.tags !== undefined && (!Array.isArray(a.tags) || a.tags.length > 15 || a.tags.some((tag) => typeof tag !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag)) || new Set(a.tags).size !== a.tags.length)) throw fault('transient', 'invalid_tags');
  const published = a.published === true; const field = published ? 'publishPost' : 'createDraft';
  const input = { publicationId: request.config.publicationId, title: a.title.trim(), contentMarkdown: a.markdown,
    originalArticleURL: canonical(a.canonicalUrl), ...(a.tags ? { tags: a.tags.map((slug) => ({ slug })) } : {}) };
  const body = JSON.stringify({ query: `mutation CrossPost($input: ${published ? 'PublishPostInput' : 'CreateDraftInput'}!) { ${field}(input: $input) { ${published ? 'post { id url }' : 'draft { id }'} } }`, variables: { input } });
  if (Buffer.byteLength(body) > 100000) throw fault('transient', 'request_too_large');
  let response;
  try { response = await host.fetch({ source: request.source, request: { url: 'https://gql.hashnode.com/', method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hashnode-client': 'papercusp-provider' }, body } }); }
  catch { throw ambiguous(); }
  if ([401, 403].includes(response.status)) throw fault('auth', 'token_role_or_pro_plan_required');
  if (response.status === 429) {
    const retry = Number(Object.entries(response.headers || {}).find(([name]) => name.toLowerCase() === 'retry-after')?.[1]);
    throw fault('rate-limited', 'throttled', Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: Math.ceil(retry) } : {});
  }
  if (response.status >= 500 || response.status === 409) throw ambiguous();
  if (response.status !== 200) throw fault('transient', 'request_refused', { status: response.status, retrySafe: false });
  let data;
  try { data = JSON.parse(response.body); } catch { throw ambiguous(); }
  if (data?.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length)) {
    // Partial mutation data may mean the write happened. Never retry that response.
    if (data.data?.[field]) throw ambiguous();
    const codes = Array.isArray(data.errors) ? data.errors.map((error) => error?.extensions?.code) : [];
    if (codes.length && codes.every((code) => ['UNAUTHENTICATED', 'FORBIDDEN'].includes(code))) throw fault('auth', 'token_role_or_pro_plan_required');
    if (codes.length && codes.every((code) => ['BAD_USER_INPUT', 'GRAPHQL_VALIDATION_FAILED'].includes(code))) throw fault('transient', 'input_refused', { retrySafe: false });
    throw ambiguous();
  }
  const result = data?.data?.[field]?.[published ? 'post' : 'draft'];
  if (typeof result?.id !== 'string' || !result.id.trim()) throw ambiguous();
  let url;
  if (published) {
    try { url = new URL(result.url); } catch { throw ambiguous(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw ambiguous();
  }
  return { externalId: result.id, published, canonicalUrl: input.originalArticleURL, ...(url ? { url: url.href } : {}) };
}
module.exports = { name: manifest.name, version: manifest.version, papercusp: manifest.papercusp, capabilities: [], providerAdapter: { describe: () => manifest.provider, syncPage, invoke } };
