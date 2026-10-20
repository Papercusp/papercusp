'use strict';
const { createHash } = require('node:crypto');
const manifest = require('./papercusp.json');
const API = 'https://discord.com/api/v10';
const SNOWFLAKE = /^\d{17,20}$/;
const fault = (kind, message, extra) => Object.assign(new Error(`discord:${message}`), { kind }, extra || {}, extra ? { data: extra } : {});
const ambiguous = () => fault('transient', 'send_ambiguous_do_not_retry', { retrySafe: false });
const header = (response, name) => Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
const configOf = (config) => (config && typeof config === 'object' && !Array.isArray(config) ? config : {});
function snowflake(value, what) {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) throw fault('transient', `invalid_${what}`);
  return value;
}
/** Only a plain https discord.gg/<code> or discord.com/invite/<code> link; never another host. */
function inviteOf(value) {
  if (value === undefined || value === null || value === '') return null;
  let url;
  try { url = new URL(value); } catch { throw fault('transient', 'invalid_invite_url'); }
  const path = url.hostname === 'discord.gg' ? /^\/[A-Za-z0-9-]{2,32}$/ : url.hostname === 'discord.com' ? /^\/invite\/[A-Za-z0-9-]{2,32}$/ : null;
  if (url.protocol !== 'https:' || !path || !path.test(url.pathname) || url.username || url.password || url.port || url.search || url.hash) {
    throw fault('transient', 'invalid_invite_url');
  }
  return url.href;
}
function rateLimited(response) {
  let retry = Number(header(response, 'retry-after'));
  if (!(retry > 0)) { try { retry = Number(JSON.parse(response.body).retry_after); } catch { retry = NaN; } }
  return fault('rate-limited', 'throttled', Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: Math.ceil(retry) } : {});
}
async function syncPage(request) {
  if (request.cursor !== null && request.cursor !== undefined) throw fault('cursor-expired', 'cursor_unrecognised');
  return { records: [], nextCursor: null, hasMore: false, catchUp: { path: 'cold-start' } };
}
async function send(request, host) {
  const c = configOf(request.config);
  const channelId = snowflake(c.channelId, 'channel_id');
  const a = request.args || {};
  if (typeof a.text !== 'string' || !a.text.trim() || [...a.text].length > 2000) throw fault('transient', 'invalid_text');
  if (typeof a.idempotencyKey !== 'string' || !a.idempotencyKey.trim() || a.idempotencyKey.length > 200) throw fault('transient', 'invalid_idempotency_key');
  // Discord nonces are at most 25 characters. With enforce_nonce a repeat of the same key within
  // Discord's window returns the first message instead of posting a second one.
  const nonce = createHash('sha256').update(JSON.stringify([request.source, channelId, a.idempotencyKey])).digest('hex').slice(0, 25);
  // Notifications never ping: @everyone, roles and users in the text stay plain text.
  const body = { content: a.text, nonce, enforce_nonce: true, allowed_mentions: { parse: [] } };
  let response;
  try {
    response = await host.fetch({ source: request.source, request: { url: `${API}/channels/${channelId}/messages`, method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } });
  } catch { throw ambiguous(); }
  if ([401, 403].includes(response.status)) throw fault('auth', 'token_or_permission_refused');
  if (response.status === 429) throw rateLimited(response);
  if (response.status === 404) throw fault('transient', 'channel_not_found', { retrySafe: false });
  if (response.status >= 500) throw ambiguous();
  if (response.status !== 200) throw fault('transient', 'request_refused', { status: response.status, retrySafe: false });
  let data;
  try { data = JSON.parse(response.body); } catch { throw ambiguous(); }
  if (typeof data?.id !== 'string' || !SNOWFLAKE.test(data.id) || data.channel_id !== channelId) throw ambiguous();
  const guildId = typeof c.guildId === 'string' && SNOWFLAKE.test(c.guildId) ? c.guildId : null;
  return { externalId: data.id, channelId, ...(guildId ? { url: `https://discord.com/channels/${guildId}/${channelId}/${data.id}` } : {}) };
}
async function presence(request, host) {
  const c = configOf(request.config);
  const guildId = snowflake(c.guildId, 'guild_id');
  const configured = inviteOf(c.inviteUrl);
  let response;
  try {
    response = await host.fetch({ source: request.source, request: { url: `${API}/guilds/${guildId}/widget.json`, method: 'GET', headers: { accept: 'application/json' } } });
  } catch { throw fault('transient', 'widget_unreachable'); }
  if (response.status === 429) throw rateLimited(response);
  // A server whose widget is turned off answers 403 (Widget Disabled); that is a state, not a fault.
  if (response.status === 403 || response.status === 404) return { guildId, widget: 'disabled', presenceCount: null, name: null, inviteUrl: configured };
  if (response.status !== 200) throw fault('transient', 'widget_unavailable', { status: response.status });
  let data;
  try { data = JSON.parse(response.body); } catch { throw fault('transient', 'widget_malformed'); }
  const presenceCount = Number.isSafeInteger(data?.presence_count) && data.presence_count >= 0 ? data.presence_count : null;
  const name = typeof data?.name === 'string' && data.name.length <= 100 ? data.name : null;
  let inviteUrl = configured;
  if (!inviteUrl && typeof data?.instant_invite === 'string') { try { inviteUrl = inviteOf(data.instant_invite); } catch { inviteUrl = null; } }
  return { guildId, widget: 'enabled', presenceCount, name, inviteUrl };
}
async function invoke(request, host) {
  if (request.capability === 'notify.send') return send(request, host);
  if (request.capability === 'community.presence') return presence(request, host);
  throw fault('transient', 'capability_unsupported');
}
module.exports = { name: manifest.name, version: manifest.version, papercusp: manifest.papercusp, capabilities: [], providerAdapter: { describe: () => manifest.provider, syncPage, invoke } };
