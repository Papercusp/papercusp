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
const idOf = (value) => (typeof value === 'string' && SNOWFLAKE.test(value) ? value : null);
/** Message types a person writes: DEFAULT and REPLY. Joins, pins, boosts and the like are not chat. */
const WRITTEN_TYPES = new Set([0, 19]);
/**
 * ingress.normalize: one Gateway DISPATCH envelope (the host passes only op 0) to chat-message
 * records. Only MESSAGE_CREATE from a person counts: bot and webhook posts (this bot's own replies
 * included) never become records, so the bot never answers itself. With `guildId` configured, other
 * servers' messages are dropped; direct messages are kept. A message whose text is empty (the
 * Message Content intent is off, or only attachments) carries nothing to answer and is dropped.
 */
function normalize(request) {
  const args = request.args || {};
  const envelope = args.envelope;
  if (!envelope || envelope.op !== 0 || envelope.t !== 'MESSAGE_CREATE' || !envelope.d || typeof envelope.d !== 'object') return { records: [] };
  const d = envelope.d;
  const c = configOf(args.sourceConfig);
  const author = d.author && typeof d.author === 'object' ? d.author : {};
  const messageId = idOf(d.id);
  const channelId = idOf(d.channel_id);
  const sender = idOf(author.id);
  if (!messageId || !channelId || !sender || author.bot || author.system || d.webhook_id || !WRITTEN_TYPES.has(d.type)) return { records: [] };
  const guildId = idOf(d.guild_id);
  const onlyGuild = idOf(c.guildId);
  if (guildId && onlyGuild && guildId !== onlyGuild) return { records: [] };
  const text = typeof d.content === 'string' ? d.content : '';
  if (!text.trim()) return { records: [] };
  const mentions = (Array.isArray(d.mentions) ? d.mentions : []).map((user) => idOf(user && user.id)).filter(Boolean);
  const botUserId = idOf(c.botUserId);
  const kind = !guildId ? 'dm' : botUserId && mentions.includes(botUserId) ? 'mention' : 'message';
  const replyTo = idOf(d.message_reference && d.message_reference.message_id);
  const occurredAt = typeof d.timestamp === 'string' && !Number.isNaN(Date.parse(d.timestamp)) ? new Date(d.timestamp).toISOString() : null;
  const authorName = typeof author.username === 'string' ? author.username.slice(0, 100) : null;
  return {
    records: [{
      datatype: 'chat-message',
      nativeId: `${channelId}:${messageId}`,
      event: kind,
      version: `${kind}:${channelId}:${messageId}`,
      ...(occurredAt ? { occurredAt } : {}),
      payload: {
        id: `${channelId}:${messageId}`,
        channelId,
        // A reply posted through chat.reply references this message, so the message is its own thread.
        threadId: messageId,
        threadKey: replyTo,
        sender,
        text,
        mentions,
        ...(occurredAt ? { occurredAt } : {}),
        extensions: { discord: { messageId, guildId, ...(authorName ? { authorName } : {}), ...(replyTo ? { replyTo } : {}) } },
      },
    }],
  };
}
/**
 * chat.reply: post `text` as a Discord reply to message `threadId` in `channelId`. Coordinates come
 * from the stored record (the host resolves them), never from the caller. Mentions never ping, and
 * the replied-to author is not pinged either. Returns { channelId, threadId, messageTs }, where
 * messageTs is the new message's id.
 */
async function reply(request, host) {
  const a = request.args || {};
  const channelId = snowflake(a.channelId, 'channel_id');
  const threadId = snowflake(a.threadId, 'thread_id');
  if (typeof a.text !== 'string' || !a.text.trim() || [...a.text].length > 2000) throw fault('transient', 'invalid_text');
  // The same reply to the same message repeats the nonce, so a re-dispatch inside Discord's window
  // returns the first message instead of posting a duplicate.
  const nonce = createHash('sha256').update(JSON.stringify([request.source, channelId, threadId, a.text])).digest('hex').slice(0, 25);
  const body = {
    content: a.text, nonce, enforce_nonce: true,
    message_reference: { message_id: threadId, fail_if_not_exists: false },
    allowed_mentions: { parse: [], replied_user: false },
  };
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
  return { channelId, threadId, messageTs: data.id };
}
async function invoke(request, host) {
  if (request.capability === 'notify.send') return send(request, host);
  if (request.capability === 'community.presence') return presence(request, host);
  if (request.capability === 'ingress.normalize') return normalize(request);
  if (request.capability === 'chat.reply') return reply(request, host);
  throw fault('transient', 'capability_unsupported');
}
module.exports = { name: manifest.name, version: manifest.version, papercusp: manifest.papercusp, capabilities: [], providerAdapter: { describe: () => manifest.provider, syncPage, invoke } };
