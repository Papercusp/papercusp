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

/** callback_id of the app's "Report a bug" message shortcut (manifest features.shortcuts). */
export const SLACK_REPORT_SHORTCUT_CALLBACK_ID = 'report_bug';

/** callback_id of the form that shortcut opens; its submission is the `report` record. */
export const SLACK_REPORT_FORM_CALLBACK_ID = 'report_bug_form';

/** Longest note the report form accepts. */
export const SLACK_REPORT_NOTE_MAX_LENGTH = 2_000;

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

function slackTs(value) {
  const raw = text(value).trim();
  return SLACK_TS.test(raw) ? raw : '';
}

/** A reaction's emoji name without colons or a skin-tone suffix ("bug", "+1"). */
export function emojiName(value) {
  return text(value).split('::')[0].trim().replace(/^:+|:+$/g, '').toLowerCase();
}

/**
 * One message read through host.fetch: conversations.replies finds a top-level post and a reply
 * alike. Throws when Slack does not return it (missing scope, the bot is not in the channel, the
 * message was deleted), so a gesture about it fails loudly on the source instead of filing nothing.
 */
export async function fetchMessage(fetchSlack, channelId, ts) {
  if (typeof fetchSlack !== 'function') throw new Error('slack_message_fetch_unavailable');
  const params = new URLSearchParams({ channel: channelId, ts, latest: ts, oldest: ts, inclusive: 'true', limit: '10' });
  const body = slackBody(
    await fetchSlack({ url: `${SLACK_API_ORIGIN}/api/conversations.replies?${params}`, method: 'GET', headers: { accept: 'application/json' } }),
    'conversations_replies',
  );
  const message = (Array.isArray(body.messages) ? body.messages : []).find((item) => text(item?.ts) === ts);
  if (!message || !text(message.text)) throw new Error(`slack_message_unavailable:${channelId}:${ts}`);
  return { text: text(message.text), user: text(message.user), threadTs: slackTs(message.thread_ts) };
}

function teamOf(event, payload) {
  return text(event?.team) || text(payload?.team_id) || text(record(payload?.team)?.id);
}

/**
 * The chat-message record for one message. A gesture about a message (a reaction, a report) is a
 * record OF that message, so its channel, id, author and text are the reported message's own, and
 * `ticket:file` quotes that message; the person who acted rides in `gesture`.
 */
function messageRecord({ event, version, channelId, ts, threadTs, sender, message, occurredAt, id, extra = {}, slack = {} }) {
  return {
    datatype: 'chat-message',
    // The message itself: a mention, the channel post Slack also delivers for it, and a gesture
    // about it are the same message, so they share one record.
    nativeId: `${channelId}:${ts}`,
    event,
    // One delivery per (event, message, actor): Slack's redelivery dedupes, while each workflow
    // still sees every distinct event about the message once.
    version,
    ...(occurredAt ? { occurredAt } : {}),
    payload: {
      id: id || `${channelId}:${ts}`,
      channelId,
      threadId: threadTs || ts,
      sender,
      text: message,
      mentions: mentionsOf(message),
      ...(occurredAt ? { occurredAt } : {}),
      ...extra,
      extensions: {
        slack: { ts, ...(threadTs && threadTs !== ts ? { threadTs } : {}), ...slack },
      },
    },
  };
}

/** The Block Kit modal the "Report a bug" shortcut opens; private_metadata names the message. */
export function reportFormView({ channelId, ts }) {
  return {
    type: 'modal',
    callback_id: SLACK_REPORT_FORM_CALLBACK_ID,
    private_metadata: JSON.stringify({ channelId, ts }),
    title: { type: 'plain_text', text: 'Report a bug' },
    submit: { type: 'plain_text', text: 'Report' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'note',
        optional: true,
        label: { type: 'plain_text', text: 'Anything to add?' },
        element: { type: 'plain_text_input', action_id: 'note', multiline: true, max_length: SLACK_REPORT_NOTE_MAX_LENGTH },
      },
    ],
  };
}

/** Open the report form for a shortcut click (views.open). Slack's trigger_id lives 3 seconds. */
export async function openReportForm(fetchSlack, { triggerId, channelId, ts }) {
  if (typeof fetchSlack !== 'function') throw new Error('slack_report_form_fetch_unavailable');
  slackBody(
    await fetchSlack({
      url: `${SLACK_API_ORIGIN}/api/views.open`,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ trigger_id: triggerId, view: reportFormView({ channelId, ts }) }),
    }),
    'views_open',
  );
}

async function normalizeEvent(payload, sourceConfig, fetchSlack) {
  const event = record(payload.event);
  if (event?.type === 'reaction_added') {
    const item = record(event.item);
    const channelId = text(item?.channel);
    const ts = slackTs(item?.ts);
    const by = text(event.user);
    const reaction = emojiName(event.reaction);
    if (!item || item.type !== 'message' || !channelId || !ts || !by || !reaction) return { records: [] };
    // The app's own reactions and reactions in direct messages are not gestures.
    if (by === text(record(sourceConfig)?.botUserId) || channelId.startsWith('D')) return { records: [] };
    const message = await fetchMessage(fetchSlack, channelId, ts);
    const occurredAt = slackTime(event.event_ts);
    return {
      records: [messageRecord({
        event: 'reaction', version: `reaction:${reaction}:${by}:${channelId}:${ts}`, channelId, ts, threadTs: message.threadTs,
        sender: message.user, message: message.text, occurredAt,
        extra: { gesture: { kind: 'reaction', by, reaction } },
        slack: { eventType: 'reaction_added', ...(teamOf(event, payload) ? { teamId: teamOf(event, payload) } : {}) },
      })],
    };
  }
  const kind = chatEventKind(event, sourceConfig);
  if (!kind) return { records: [] };
  const channelId = text(event.channel);
  const ts = text(event.ts);
  const message = text(event.text);
  const sender = text(event.user);
  if (!channelId || !SLACK_TS.test(ts) || !message || !sender) return { records: [] };
  const threadTs = slackTs(event.thread_ts);
  // A mention inside a thread is usually ABOUT the thread's opening message ("@Papercusp bug"):
  // carry that message as the target so a workflow can act on it without another read.
  const target = kind === 'mention' && threadTs && threadTs !== ts
    ? await fetchMessage(fetchSlack, channelId, threadTs).then((root) => ({ channelId, ts: threadTs, sender: root.user, text: root.text }))
    : null;
  const team = teamOf(event, payload);
  return {
    records: [messageRecord({
      event: kind, version: `${kind}:${channelId}:${ts}`, channelId, ts, threadTs, sender, message,
      occurredAt: slackTime(event.event_ts) ?? slackTime(ts), id: text(payload.event_id),
      extra: target ? { target } : {},
      slack: {
        eventType: text(event.type),
        ...(text(event.channel_type) ? { channelType: text(event.channel_type) } : {}),
        ...(team ? { teamId: team } : {}),
      },
    })],
  };
}

async function normalizeInteractive(payload, fetchSlack) {
  const by = text(record(payload.user)?.id);
  if (payload.type === 'message_action' && text(payload.callback_id) === SLACK_REPORT_SHORTCUT_CALLBACK_ID) {
    const channelId = text(record(payload.channel)?.id);
    const ts = slackTs(record(payload.message)?.ts);
    const triggerId = text(payload.trigger_id);
    if (!channelId || !ts || !triggerId || !by) return { records: [] };
    // The click itself is not a report: the form's submission is.
    await openReportForm(fetchSlack, { triggerId, channelId, ts });
    return { records: [] };
  }
  if (payload.type === 'view_submission') {
    const view = record(payload.view);
    if (!view || text(view.callback_id) !== SLACK_REPORT_FORM_CALLBACK_ID) return { records: [] };
    let meta = null;
    try { meta = record(JSON.parse(text(view.private_metadata))); } catch { meta = null; }
    const channelId = text(meta?.channelId);
    const ts = slackTs(meta?.ts);
    const viewId = text(view.id);
    if (!channelId || !ts || !viewId || !by) return { records: [] };
    const note = text(record(record(record(record(view.state)?.values)?.note)?.note)?.value).trim()
      .slice(0, SLACK_REPORT_NOTE_MAX_LENGTH);
    const message = await fetchMessage(fetchSlack, channelId, ts);
    return {
      records: [messageRecord({
        event: 'report', version: `report:${viewId}`, channelId, ts, threadTs: message.threadTs,
        sender: message.user, message: message.text, occurredAt: new Date().toISOString(),
        extra: { gesture: { kind: 'report', by, ...(note ? { note } : {}) } },
        slack: { eventType: 'view_submission', ...(teamOf(null, payload) ? { teamId: teamOf(null, payload) } : {}) },
      })],
    };
  }
  return { records: [] };
}

/**
 * `ingress.normalize`: one Socket Mode envelope → chat-message records (ProviderIngressNormalizeResult).
 * A hello, a disconnect notice, or an event this provider ignores returns no records. Events: a
 * channel post (`message`), a mention, a direct message (`dm`), the /papercusp command, a reaction
 * on a message (`reaction`), and a message reported through the "Report a bug" shortcut's form
 * (`report`). `fetchSlack` is the call's host.fetch; reactions and reports read the message they
 * are about through it, and the shortcut opens its form through it.
 */
export async function normalizeEnvelope(envelope, sourceConfig = {}, fetchSlack) {
  const env = record(envelope);
  if (!env) return { records: [] };
  const payload = record(env.payload) ?? {};

  if (env.type === 'events_api') return normalizeEvent(payload, sourceConfig, fetchSlack);
  if (env.type === 'interactive') return normalizeInteractive(payload, fetchSlack);

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
  if (capability === 'ingress.normalize') return normalizeEnvelope(args.envelope, record(args.sourceConfig) ?? {}, fetchSlack);
  if (capability === 'chat.channels') return listChannels(fetchSlack, args);
  if (capability === 'chat.reply') return replyInThread(fetchSlack, args);
  throw new Error(`provider_capability_unsupported:slack:${String(capability)}`);
}
