// Slack chat provider logic for Papercusp.
//
// Pure functions behind the sandboxed daemon (daemon.mjs). Nothing here sees a credential: the host
// opens the Socket Mode connection with the stored app-level token and hands each envelope to
// `ingress.normalize`, and every Slack Web API call goes out through the host's `host.fetch`, which
// injects the stored bot token for slack.com (setup.credentials[].hosts) and enforces egress.

export const SLACK_API_ORIGIN = 'https://slack.com';

/** Longest reply text accepted, as in the in-app path. */
export const SLACK_REPLY_MAX_LENGTH = 4_000;

/** Pages of conversations.list read for one channel picker; 10 × 200 channels. */
export const SLACK_CHANNEL_PAGE_LIMIT = 10;

const SLACK_TS = /^\d+(?:\.\d+)?$/;

function text(value) {
  return typeof value === 'string' ? value : '';
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** ISO time of a Slack `ts` ("1712345678.000200"), or undefined. */
export function slackTime(value) {
  const raw = text(value);
  if (!SLACK_TS.test(raw)) return undefined;
  return new Date(Number(raw) * 1_000).toISOString();
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [];
}

/**
 * Whether a bot-authored post is the source's declared drill (test-bot) identity.
 * `sourceConfig.testBotAllowance` must name botId, appId, userId and channelId, and the post must
 * match all four exactly, be a plain channel message in one of `sourceConfig.channels`, and not
 * come from this app's own bot. Any other bot or app post stays unrecorded, so the app never
 * reacts to its own replies and a declared drill identity grants no other bot, channel or DM.
 */
export function drillBotAllowed(event, sourceConfig = {}) {
  const config = record(sourceConfig) ?? {};
  const allowance = record(config.testBotAllowance);
  if (!event || !allowance) return false;
  const botId = text(allowance.botId);
  const appId = text(allowance.appId);
  const userId = text(allowance.userId);
  const channelId = text(allowance.channelId);
  const channel = text(event.channel);
  return event.type === 'message'
    && !event.subtype
    && !!botId && !!appId && !!userId && !!channelId
    && event.bot_id === botId && event.app_id === appId && text(event.user) === userId
    && event.bot_id !== config.botId && text(event.user) !== text(config.botUserId)
    && channel === channelId && strings(config.channels).includes(channel)
    && event.channel_type !== 'im' && event.channel_type !== 'mpim' && !channel.startsWith('D');
}

function mentionsOf(message) {
  return [...message.matchAll(/<@([A-Z0-9]+)>/g)].map((match) => match[1]);
}

/**
 * Which chat event a Slack Events API event is, or null when it is not one this provider records.
 * `app_mention` is a mention; a direct message is a dm; any other channel post is a message. Bot and
 * app posts, and edits/joins/deletions (any `subtype`), are never recorded, so the app never reacts
 * to its own replies. The one exception is the source's declared drill identity
 * ({@link drillBotAllowed}), recorded as a plain channel message.
 */
export function chatEventKind(event, sourceConfig = {}) {
  if (!event || event.subtype) return null;
  if (event.bot_id || event.app_id) return drillBotAllowed(event, sourceConfig) ? 'message' : null;
  if (event.type === 'app_mention') return 'mention';
  if (event.type !== 'message') return null;
  const channelId = text(event.channel);
  if (event.channel_type === 'im' || channelId.startsWith('D')) return 'dm';
  if (event.channel_type === 'mpim') return null;
  return 'message';
}

/**
 * `ingress.normalize`: one Socket Mode envelope → chat-message records (ProviderIngressNormalizeResult).
 * A hello, a disconnect notice, or an event this provider ignores returns no records.
 */
export function normalizeEnvelope(envelope, sourceConfig = {}) {
  const env = record(envelope);
  if (!env) return { records: [] };
  const payload = record(env.payload) ?? {};

  if (env.type === 'events_api') {
    const event = record(payload.event);
    const kind = chatEventKind(event, sourceConfig);
    if (!kind) return { records: [] };
    const channelId = text(event.channel);
    const ts = text(event.ts);
    const message = text(event.text);
    const sender = text(event.user);
    if (!channelId || !SLACK_TS.test(ts) || !message || !sender) return { records: [] };
    const threadTs = text(event.thread_ts);
    const occurredAt = slackTime(event.event_ts) ?? slackTime(ts);
    return {
      records: [
        {
          datatype: 'chat-message',
          // The message itself: a mention and the channel post Slack also delivers for it are the
          // same message, so they share one record.
          nativeId: `${channelId}:${ts}`,
          event: kind,
          // One delivery per (event kind, message): Slack's redelivery of the same event dedupes,
          // while the mention and the plain post each still reach their own workflows once.
          version: `${kind}:${channelId}:${ts}`,
          ...(occurredAt ? { occurredAt } : {}),
          payload: {
            id: text(payload.event_id) || `${channelId}:${ts}`,
            channelId,
            threadId: threadTs || ts,
            sender,
            text: message,
            mentions: mentionsOf(message),
            ...(occurredAt ? { occurredAt } : {}),
            extensions: {
              slack: {
                ts,
                ...(threadTs && threadTs !== ts ? { threadTs } : {}),
                eventType: text(event.type),
                ...(text(event.channel_type) ? { channelType: text(event.channel_type) } : {}),
                ...(text(event.team) || text(payload.team_id) ? { teamId: text(event.team) || text(payload.team_id) } : {}),
              },
            },
          },
        },
      ],
    };
  }

  if (env.type === 'slash_commands') {
    const triggerId = text(payload.trigger_id) || text(env.envelope_id);
    const sender = text(payload.user_id);
    const message = [text(payload.command), text(payload.text)].filter(Boolean).join(' ');
    if (!triggerId || !sender || !message) return { records: [] };
    const channelId = text(payload.channel_id);
    return {
      records: [
        {
          datatype: 'chat-message',
          nativeId: `command:${triggerId}`,
          event: 'slash-command',
          version: `slash-command:${triggerId}`,
          payload: {
            id: triggerId,
            ...(channelId ? { channelId } : {}),
            sender,
            text: message,
            mentions: mentionsOf(message),
            extensions: {
              slack: {
                command: text(payload.command),
                ...(text(payload.team_id) ? { teamId: text(payload.team_id) } : {}),
              },
            },
          },
        },
      ],
    };
  }

  return { records: [] };
}

/** A Slack Web API JSON body, or a thrown provider error that names Slack's own error code. */
export function slackBody(response, method) {
  if (!response || typeof response.status !== 'number') throw new Error(`slack_${method}_no_response`);
  if (response.status === 429) {
    const retry = Number(response.headers?.['retry-after']);
    const err = new Error(`rate-limited: slack ${method}`);
    err.data = { kind: 'rate-limited', ...(Number.isFinite(retry) ? { retryAfterSeconds: retry } : {}) };
    throw err;
  }
  let body;
  try {
    body = JSON.parse(response.bodyEncoding === 'base64' ? Buffer.from(response.body, 'base64').toString('utf8') : response.body);
  } catch {
    throw new Error(`slack_${method}_http_${response.status}`);
  }
  if (!body || body.ok !== true) {
    const code = text(body?.error) || `http_${response.status}`;
    const err = new Error(`slack_${method}_${code}`);
    if (/invalid_auth|not_authed|token_revoked|account_inactive|missing_scope/.test(code)) err.data = { kind: 'auth' };
    throw err;
  }
  return body;
}

/**
 * `chat.channels`: the channels the bot can read, as option-picker entries ({ options[] }).
 * Archived channels are left out. `args.types` narrows to public or private channels.
 */
export async function listChannels(fetchSlack, args = {}) {
  const types = args.types === 'public' ? 'public_channel' : args.types === 'private' ? 'private_channel' : 'public_channel,private_channel';
  const options = [];
  let cursor = '';
  for (let page = 0; page < SLACK_CHANNEL_PAGE_LIMIT; page += 1) {
    const params = new URLSearchParams({ types, exclude_archived: 'true', limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const body = slackBody(
      await fetchSlack({ url: `${SLACK_API_ORIGIN}/api/conversations.list?${params}`, method: 'GET', headers: { accept: 'application/json' } }),
      'conversations_list',
    );
    for (const channel of Array.isArray(body.channels) ? body.channels : []) {
      const id = text(channel?.id);
      const name = text(channel?.name);
      if (!id || !name) continue;
      const purpose = text(channel?.purpose?.value) || text(channel?.topic?.value);
      options.push({
        value: id,
        label: `#${name}`,
        ...(purpose ? { description: purpose.slice(0, 200) } : channel?.is_private ? { description: 'Private channel' } : {}),
      });
    }
    cursor = text(body.response_metadata?.next_cursor);
    if (!cursor) break;
  }
  options.sort((a, b) => a.label.localeCompare(b.label));
  return { options };
}

/**
 * `chat.reply`: post `text` in the thread `{ channelId, threadId }`. A top-level message's own ts is
 * its thread id, so replying to it starts the thread. Returns { channelId, threadId, messageTs }.
 */
export async function replyInThread(fetchSlack, args = {}) {
  const channelId = text(args.channelId).trim();
  const threadId = text(args.threadId).trim();
  const message = text(args.text).trim();
  if (!channelId || channelId.length > 80) throw new Error('slack_reply_channel_invalid');
  if (!SLACK_TS.test(threadId)) throw new Error('slack_reply_thread_invalid');
  if (!message || message.length > SLACK_REPLY_MAX_LENGTH) throw new Error('slack_reply_text_invalid');
  const body = slackBody(
    await fetchSlack({
      url: `${SLACK_API_ORIGIN}/api/chat.postMessage`,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: channelId, thread_ts: threadId, text: message }),
    }),
    'chat_post_message',
  );
  const messageTs = text(body.ts);
  if (!messageTs) throw new Error('slack_reply_message_ts_missing');
  return { channelId: text(body.channel) || channelId, threadId, messageTs };
}

/** Dispatch one `provider.invoke` request. `fetchSlack(request)` is the call's host.fetch. */
export async function invokeCapability(request, fetchSlack) {
  const capability = request?.capability;
  const args = record(request?.args) ?? {};
  if (capability === 'ingress.normalize') return normalizeEnvelope(args.envelope, record(args.sourceConfig) ?? {});
  if (capability === 'chat.channels') return listChannels(fetchSlack, args);
  if (capability === 'chat.reply') return replyInThread(fetchSlack, args);
  throw new Error(`provider_capability_unsupported:slack:${String(capability)}`);
}
