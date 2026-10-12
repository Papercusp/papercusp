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
    // The channel is the message's readership container (descriptor membership.containers): on an
    // organization source only that channel's members can read it. A direct message's channel is
    // never in a membership snapshot, so nobody reads it there.
    aclRef: channelId,
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

/** conversations.history / conversations.replies page size; Slack recommends 200. */
export const SLACK_HISTORY_PAGE = 200;

/**
 * Message subtypes whose text someone wrote: a reply also posted to the channel, an integration's
 * post, a shared file's message, a /me message. Joins, leaves, topic changes and the like carry no
 * content worth keeping.
 */
const HISTORY_SUBTYPES = new Set(['thread_broadcast', 'bot_message', 'file_share', 'me_message']);

/** A channel the membership page queued that has no readable history any more. */
const GONE_CHANNEL = /^slack_conversations_history_(not_in_channel|channel_not_found|is_archived)$/;

/** One Slack Web API GET through host.fetch; empty params are left out. */
async function slackGet(fetchSlack, method, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  return slackBody(
    await fetchSlack({ url: `${SLACK_API_ORIGIN}/api/${method}?${query}`, method: 'GET', headers: { accept: 'application/json' } }),
    method.replace(/\./g, '_'),
  );
}

/** Every channel the bot is a member of, archived ones left out: { id, name }[]. */
async function listMemberChannels(fetchSlack) {
  const out = [];
  let cursor = '';
  do {
    const body = await slackGet(fetchSlack, 'conversations.list', {
      types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200', cursor,
    });
    for (const channel of Array.isArray(body.channels) ? body.channels : []) {
      const id = text(channel?.id);
      if (id && channel.is_member === true && !channel.is_archived) out.push({ id, name: text(channel.name) });
    }
    cursor = text(body.response_metadata?.next_cursor);
  } while (cursor);
  return out;
}

/** The user ids of everyone in a channel (conversations.members, every page). */
async function listChannelMembers(fetchSlack, channelId) {
  const out = [];
  let cursor = '';
  do {
    const body = await slackGet(fetchSlack, 'conversations.members', { channel: channelId, limit: '1000', cursor });
    for (const member of strings(body.members)) out.push(member);
    cursor = text(body.response_metadata?.next_cursor);
  } while (cursor);
  return out;
}

/** The replies of one thread, every page, without its opening message. */
async function threadReplies(fetchSlack, channelId, threadTs) {
  const out = [];
  let cursor = '';
  do {
    const body = await slackGet(fetchSlack, 'conversations.replies', {
      channel: channelId, ts: threadTs, limit: String(SLACK_HISTORY_PAGE), cursor,
    });
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      if (slackTs(message?.ts) !== threadTs) out.push(message);
    }
    cursor = text(body.response_metadata?.next_cursor);
  } while (cursor);
  return out;
}

/**
 * The chat-message record for one message read from channel history, or null for a message with no
 * text or a system subtype. It is the same message (nativeId, aclRef) the socket delivers, under its
 * own `history` event, so a workflow bound to new messages never fires on a backfilled one.
 */
export function historyRecord(channelId, message) {
  const ts = slackTs(message?.ts);
  const body = text(message?.text);
  if (!channelId || !ts || !body.trim()) return null;
  const subtype = text(message.subtype);
  if (subtype && !HISTORY_SUBTYPES.has(subtype)) return null;
  const edited = slackTs(record(message.edited)?.ts);
  return messageRecord({
    event: 'history',
    // An edit is a new version of the message, so the document follows it.
    version: `history:${channelId}:${ts}:${edited || ts}`,
    channelId,
    ts,
    threadTs: slackTs(message.thread_ts),
    sender: text(message.user) || text(message.bot_id),
    message: body,
    occurredAt: slackTime(ts),
    slack: {
      eventType: 'conversations.history',
      ...(subtype ? { subtype } : {}),
      ...(edited ? { editedTs: edited } : {}),
    },
  });
}

/** The sync cursor: channels still to backfill (the first one in progress at `page`), and every member channel already queued. */
function syncState(raw) {
  let parsed = null;
  try {
    parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const state = record(parsed) ?? {};
  return { queue: strings(state.queue), seen: strings(state.seen), page: text(state.page) };
}

function cursorOf({ queue, seen, page }) {
  return JSON.stringify({ queue, seen, ...(page ? { page } : {}) });
}

/**
 * Membership page: every channel the bot is in, each with its complete members, as containers.
 * Every record names its channel, so the source-wide list stays empty. Channels not seen before
 * are queued for backfill.
 */
async function membershipPage(fetchSlack, state) {
  const channels = await listMemberChannels(fetchSlack);
  const containers = [];
  for (const channel of channels) {
    const members = await listChannelMembers(fetchSlack, channel.id);
    containers.push({
      ref: channel.id,
      ...(channel.name ? { title: `#${channel.name}` } : {}),
      members: members.map((providerUserId) => ({ providerUserId })),
    });
  }
  const seen = new Set(state.seen);
  const current = channels.map((channel) => channel.id);
  const queue = current.filter((id) => !seen.has(id));
  return {
    records: [],
    membership: { members: [], containers },
    nextCursor: cursorOf({ queue, seen: current }),
    hasMore: queue.length > 0,
  };
}

/** History page: one conversations.history page of the first queued channel, thread replies included. */
async function historyPage(fetchSlack, state) {
  const [channelId, ...rest] = state.queue;
  let body;
  try {
    body = await slackGet(fetchSlack, 'conversations.history', {
      channel: channelId, limit: String(SLACK_HISTORY_PAGE), cursor: state.page,
    });
  } catch (error) {
    // The bot left the channel, or it was deleted or archived, after the membership page queued
    // it: there is no history to read, so move on instead of failing every later pass.
    if (GONE_CHANNEL.test(String(error?.message))) {
      return { records: [], nextCursor: cursorOf({ queue: rest, seen: state.seen }), hasMore: rest.length > 0 };
    }
    throw error;
  }
  const records = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const own = historyRecord(channelId, message);
    if (own) records.push(own);
    const ts = slackTs(message?.ts);
    if (ts && slackTs(message.thread_ts) === ts && Number(message.reply_count) > 0) {
      for (const reply of await threadReplies(fetchSlack, channelId, ts)) {
        const row = historyRecord(channelId, reply);
        if (row) records.push(row);
      }
    }
  }
  const page = text(body.response_metadata?.next_cursor);
  const queue = page ? state.queue : rest;
  return { records, nextCursor: cursorOf({ queue, seen: state.seen, page }), hasMore: queue.length > 0 };
}

/**
 * `provider.syncPage`. A personal source is one Socket Mode connection: its messages arrive through
 * ingress.normalize, so there is nothing to crawl. An organization source starts each round with a
 * membership page, then backfills every newly seen channel one history page at a time; after that,
 * each pass refreshes membership and the socket delivers new messages. A rate limit throws the
 * SDK's rate-limited error (slackBody), so the host waits out Slack's Retry-After.
 */
export async function syncPage(request, fetchSlack) {
  if (request?.scope !== 'organization') return { records: [], nextCursor: null, hasMore: false };
  if (typeof fetchSlack !== 'function') throw new Error('slack_sync_fetch_unavailable');
  const state = syncState(request.cursor);
  return state.queue.length ? historyPage(fetchSlack, state) : membershipPage(fetchSlack, state);
}

/** Most hits assistant.search.context returns: Slack's own maximum. */
export const SLACK_SEARCH_MAX_LIMIT = 20;

/** Live search covers every conversation the searching person can see. */
export const SLACK_SEARCH_CHANNEL_TYPES = ['public_channel', 'private_channel', 'mpim', 'im'];

/**
 * `search.live`: Slack's Real-time Search (assistant.search.context), storing nothing. The host
 * makes this call on behalf of the person searching and injects THEIR user token (the per-person
 * `user_token` credential), so Slack itself decides what they can see. Hits come best first.
 */
export async function searchLive(fetchSlack, args = {}) {
  const query = text(args.query).trim();
  if (!query) throw new Error('slack_search_query_invalid');
  const wanted = Math.floor(Number(args.limit));
  const limit = Number.isFinite(wanted) && wanted > 0 ? Math.min(SLACK_SEARCH_MAX_LIMIT, wanted) : SLACK_SEARCH_MAX_LIMIT;
  const body = slackBody(
    await fetchSlack({
      url: `${SLACK_API_ORIGIN}/api/assistant.search.context`,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ query, channel_types: SLACK_SEARCH_CHANNEL_TYPES, content_types: ['messages'], limit, sort: 'score' }),
    }),
    'assistant_search_context',
  );
  const messages = record(body.results)?.messages;
  const hits = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const channelId = text(message?.channel_id);
    const ts = slackTs(message?.message_ts);
    const content = text(message?.content).trim();
    if (!channelId || !ts || !content) continue;
    const channelName = text(message.channel_name);
    const author = text(message.author_user_id);
    hits.push({
      externalId: `${channelId}:${ts}`,
      title: channelName ? `#${channelName}` : `channel ${channelId}`,
      text: content,
      occurredAt: slackTime(ts) ?? null,
      participants: author ? [author] : [],
      permalink: text(message.permalink) || null,
    });
  }
  return { hits };
}

/** Dispatch one `provider.invoke` request. `fetchSlack(request)` is the call's host.fetch. */
export async function invokeCapability(request, fetchSlack) {
  const capability = request?.capability;
  const args = record(request?.args) ?? {};
  if (capability === 'ingress.normalize') return normalizeEnvelope(args.envelope, record(args.sourceConfig) ?? {}, fetchSlack);
  if (capability === 'chat.channels') return listChannels(fetchSlack, args);
  if (capability === 'chat.reply') return replyInThread(fetchSlack, args);
  if (capability === 'search.live') return searchLive(fetchSlack, args);
  throw new Error(`provider_capability_unsupported:slack:${String(capability)}`);
}
