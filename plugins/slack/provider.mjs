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
 * app posts, and joins and other system posts (any `subtype`), are never recorded, so the app never
 * reacts to its own replies. The one exception is the source's declared drill identity
 * ({@link drillBotAllowed}), recorded as a plain channel message. Edits and deletions of a recorded
 * message are not new posts: {@link changeRecords} turns them into new versions of that message.
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
      // Provider-neutral thread of the message (the host's chat units group by it): the thread's
      // root ts for a reply, and for a root once Slack reports it has replies; null otherwise.
      threadKey: threadTs || null,
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

/**
 * The record that removes a message: same native id, `deleted`, no text. A redelivery, or the
 * tombstone Slack leaves for a deleted message that has replies, dedupes onto it.
 */
function deletedRecord({ channelId, ts, threadTs, sender, occurredAt, id, slack = {} }) {
  return {
    ...messageRecord({ event: 'deleted', version: `deleted:${channelId}:${ts}`, channelId, ts, threadTs, sender, message: '', occurredAt, id, slack }),
    deleted: true,
  };
}

/**
 * An edit or a deletion of a message (`message_changed` / `message_deleted`) as records of that
 * message, or null when the event is neither. Only messages this provider records change: a bot or
 * app post (other than the declared drill identity) and a group DM stay unrecorded. An edit keeps
 * the message's own post time, so the host files it where the original went, and says when it was
 * edited; a change that alters neither text nor thread (a link unfurl, a reply count) records nothing.
 */
function changeRecords(event, payload, sourceConfig) {
  const subtype = text(event?.subtype);
  if (event?.type !== 'message' || (subtype !== 'message_changed' && subtype !== 'message_deleted')) return null;
  const channelId = text(event.channel);
  const channelType = text(event.channel_type);
  const team = teamOf(event, payload);
  const slack = {
    eventType: 'message',
    subtype,
    ...(channelType ? { channelType } : {}),
    ...(team ? { teamId: team } : {}),
  };
  const previous = record(event.previous_message);
  // Whether a message as Slack describes it is one this provider records.
  const recorded = (message) => !message
    || chatEventKind({ ...message, type: 'message', subtype: undefined, channel: channelId, channel_type: channelType }, sourceConfig) !== null;
  const id = text(payload.event_id);

  if (subtype === 'message_deleted') {
    const ts = slackTs(event.deleted_ts);
    if (!channelId || !ts || !recorded(previous)) return [];
    return [deletedRecord({
      channelId, ts, threadTs: slackTs(previous?.thread_ts), sender: text(previous?.user),
      occurredAt: slackTime(event.event_ts) ?? slackTime(event.ts), id, slack,
    })];
  }

  const message = record(event.message);
  const ts = slackTs(message?.ts);
  if (!channelId || !message || !ts) return [];
  const threadTs = slackTs(message.thread_ts);
  // A deleted message that has replies stays in its thread as a tombstone.
  if (text(message.subtype) === 'tombstone') {
    return [deletedRecord({
      channelId, ts, threadTs, sender: text(previous?.user),
      occurredAt: slackTime(event.event_ts) ?? slackTime(event.ts), id, slack,
    })];
  }
  const body = text(message.text);
  const sender = text(message.user);
  if (!body || !sender || !recorded(message)) return [];
  const editedTs = slackTs(record(message.edited)?.ts);
  if (!editedTs && previous && text(previous.text) === body && slackTs(previous.thread_ts) === threadTs) return [];
  const editedAt = editedTs ? slackTime(editedTs) : undefined;
  return [messageRecord({
    event: 'edited',
    // One version per edit, and per thread change (a root that gains replies joins its thread).
    version: `edited:${channelId}:${ts}:${editedTs || ts}:${threadTs}`,
    channelId, ts, threadTs, sender, message: body, occurredAt: slackTime(ts), id,
    extra: editedAt ? { editedAt } : {},
    slack: { ...slack, ...(editedTs ? { editedTs } : {}) },
  })];
}

async function normalizeEvent(payload, sourceConfig, fetchSlack) {
  const event = record(payload.event);
  const changed = changeRecords(event, payload, sourceConfig);
  if (changed) return { records: changed };
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

/**
 * How far back the rescan of an already-backfilled channel reads: a week of
 * posts. Each sync round rescans one such channel in turn, so a message posted in the last week and
 * deleted while the daemon was offline is tombstoned within one sweep of the channels.
 */
export const SLACK_RESCAN_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * How often each already-backfilled channel's WHOLE history is re-read. The
 * week-long rescan cannot see a message older than its window, or a reply in a thread whose root is
 * older, that was deleted while the daemon was offline. A due round re-reads the next known channel
 * from its start instead of its last week, so every known channel is re-walked about once a period:
 * re-walks start period / channels apart, counted from the end of the previous one, so the week-long
 * rescans still run between them. A re-walk reads like a backfill (one history page a sync page,
 * every thread's replies), so it reports windows down to the channel's start. The lag is bounded by
 * the period plus the re-walk itself; the week-long rescan's own lag is one round per known channel.
 */
export const SLACK_DEEP_RESCAN_PERIOD_SECONDS = 30 * 24 * 60 * 60;

/** The millisecond the host stores as a Slack ts's post time: slackTime's own arithmetic. */
function msOfTs(ts) {
  return new Date(Number(ts) * 1_000).getTime();
}

/** A Slack ts for a millisecond instant. */
function tsOfMs(ms) {
  return `${Math.floor(ms / 1_000)}.${String(ms % 1_000).padStart(3, '0')}000`;
}

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

/** The replies of one thread posted before `latest` (no bound when empty), every page, without its opening message. */
async function threadReplies(fetchSlack, channelId, threadTs, latest = '') {
  const out = [];
  let cursor = '';
  do {
    const body = await slackGet(fetchSlack, 'conversations.replies', {
      channel: channelId, ts: threadTs, limit: String(SLACK_HISTORY_PAGE), cursor, latest,
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
  const subtype = text(message?.subtype);
  // A deleted message that still has replies reads back as a tombstone: the message is gone.
  if (channelId && ts && subtype === 'tombstone') {
    return {
      ...messageRecord({
        event: 'deleted', version: `deleted:${channelId}:${ts}`, channelId, ts, threadTs: slackTs(message.thread_ts),
        sender: '', message: '', slack: { eventType: 'conversations.history', subtype },
      }),
      deleted: true,
    };
  }
  if (!channelId || !ts || !body.trim()) return null;
  if (subtype && !HISTORY_SUBTYPES.has(subtype)) return null;
  const edited = slackTs(record(message.edited)?.ts);
  const editedAt = edited ? slackTime(edited) : undefined;
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
    extra: editedAt ? { editedAt } : {},
    slack: {
      eventType: 'conversations.history',
      ...(subtype ? { subtype } : {}),
      ...(edited ? { editedTs: edited } : {}),
    },
  });
}

/**
 * The sync cursor: channels still to backfill (the first one in progress at `page`), every member
 * channel already queued, and the already-backfilled channel to rescan from `oldest` after them
 * (`rotate` is the last one picked). A rescan with no `oldest` re-reads the whole channel: `deep` is
 * the last channel re-read so, `deepAt` the millisecond that re-walk ended. A channel read in progress keeps its fixed `latest` bound and
 * the oldest message of its previous page (`upper`).
 */
function syncState(raw) {
  let parsed = null;
  try {
    parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const state = record(parsed) ?? {};
  return {
    queue: strings(state.queue),
    seen: strings(state.seen),
    page: text(state.page),
    rescan: text(state.rescan),
    oldest: slackTs(state.oldest),
    latest: slackTs(state.latest),
    upper: slackTs(state.upper),
    rotate: text(state.rotate),
    deep: text(state.deep),
    deepAt: /^\d+$/.test(text(state.deepAt)) ? text(state.deepAt) : '',
  };
}

const CURSOR_FIELDS = ['page', 'rescan', 'oldest', 'latest', 'upper', 'rotate', 'deep', 'deepAt'];

function cursorOf(state) {
  const out = { queue: state.queue, seen: state.seen };
  for (const field of CURSOR_FIELDS) if (state[field]) out[field] = state[field];
  return JSON.stringify(out);
}

/** A sync page ending in `state`: more pages follow while a backfill or a rescan is left. */
function pageOf(records, state, extra = {}) {
  return { records, ...extra, nextCursor: cursorOf(state), hasMore: state.queue.length > 0 || Boolean(state.rescan) };
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
  // One already-backfilled channel per round re-reads its recent window, in turn, so a delete made
  // while the daemon was offline is found. When a whole-history re-walk is due,
  // the next channel of that separate rotation is re-read from its start instead;
  // the re-walk clock starts on the first membership page.
  const known = current.filter((id) => seen.has(id));
  const now = Date.now();
  const after = (id) => known[(known.indexOf(id) + 1) % known.length];
  const due = known.length > 0 && Boolean(state.deepAt)
    && now - Number(state.deepAt) >= (SLACK_DEEP_RESCAN_PERIOD_SECONDS * 1_000) / known.length;
  const deep = due ? after(state.deep) : '';
  const rescan = deep || (known.length ? after(state.rotate) : '');
  return pageOf([], {
    queue,
    seen: current,
    rescan,
    oldest: rescan && !deep ? tsOfMs(now - SLACK_RESCAN_WINDOW_SECONDS * 1_000) : '',
    rotate: deep ? state.rotate : rescan || state.rotate,
    deep: deep || state.deep,
    deepAt: state.deepAt || String(now),
  }, { membership: { members: [], containers } });
}

/**
 * History page: one conversations.history page of the channel being read (the first queued
 * channel's whole history, else the rescan channel's window from `oldest`), every thread's replies
 * included. Each page also reports what it read completely: the channel's
 * messages outside threads between its oldest message and the previous page's (down to `oldest`, or
 * the channel's start, on the last page), and each thread whose replies it re-read. Every page of
 * one read stops at the same `latest`, so a message posted meanwhile is neither read nor counted as
 * missing. The bounds leave out the millisecond at each edge: the host stores post times to the
 * millisecond, and Slack's ts is finer.
 */
async function historyPage(fetchSlack, state) {
  const backfill = state.queue.length > 0;
  const channelId = backfill ? state.queue[0] : state.rescan;
  const oldest = backfill ? '' : state.oldest;
  const latest = state.latest || tsOfMs(Date.now());
  const read = { page: '', latest: '', upper: '' };
  // A rescan with no lower bound is a whole-history re-walk: its end restarts the re-walk clock.
  const rewalked = !backfill && !oldest ? { deepAt: String(Date.now()) } : {};
  const finished = backfill ? { ...state, ...read, queue: state.queue.slice(1) } : { ...state, ...read, rescan: '', oldest: '', ...rewalked };
  let body;
  try {
    body = await slackGet(fetchSlack, 'conversations.history', {
      channel: channelId, limit: String(SLACK_HISTORY_PAGE), cursor: state.page, oldest, latest,
    });
  } catch (error) {
    // The bot left the channel, or it was deleted or archived, after the membership page queued
    // it: there is no history to read, so move on instead of failing every later pass.
    if (GONE_CHANNEL.test(String(error?.message))) return pageOf([], finished);
    throw error;
  }
  const records = [];
  const live = [];
  const threads = [];
  let pageOldest = '';
  const to = new Date(msOfTs(latest) - 1).toISOString();
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const own = historyRecord(channelId, message);
    if (own) records.push(own);
    const ts = slackTs(message?.ts);
    if (!ts) continue;
    if (!pageOldest || Number(ts) < Number(pageOldest)) pageOldest = ts;
    // Every message Slack still returns is live, records or not; a tombstone is a deleted root.
    const ids = text(message.subtype) === 'tombstone' ? [] : [`${channelId}:${ts}`];
    live.push(...ids);
    if (slackTs(message.thread_ts) !== ts) continue;
    // A thread's root: re-read every reply, even when reply_count says none is left.
    for (const reply of await threadReplies(fetchSlack, channelId, ts, latest)) {
      const row = historyRecord(channelId, reply);
      if (row) records.push(row);
      const replyTs = slackTs(reply?.ts);
      if (replyTs && text(reply.subtype) !== 'tombstone') ids.push(`${channelId}:${replyTs}`);
    }
    threads.push({ datatype: 'chat-message', containerRef: channelId, threadRef: ts, to, nativeIds: ids });
  }
  const page = text(body.response_metadata?.next_cursor);
  // The channel's window: below the previous page's oldest message (the first page: `latest`),
  // down to this page's oldest message while more pages follow. A page with more to come and no
  // message to bound it by reports no channel window.
  const upperMs = msOfTs(state.upper || latest) - 1;
  const lowerMs = page ? (pageOldest ? msOfTs(pageOldest) + 1 : undefined) : oldest ? msOfTs(oldest) + 1 : null;
  const coverage = [...threads];
  if (lowerMs !== undefined && (lowerMs === null || lowerMs <= upperMs)) {
    coverage.unshift({
      datatype: 'chat-message',
      containerRef: channelId,
      ...(lowerMs === null ? {} : { from: new Date(lowerMs).toISOString() }),
      to: new Date(upperMs).toISOString(),
      nativeIds: live,
    });
  }
  const next = page ? { ...state, page, latest, upper: pageOldest || state.upper } : finished;
  return pageOf(records, next, coverage.length ? { coverage } : {});
}

/**
 * `provider.syncPage`. A personal source is one Socket Mode connection: its messages arrive through
 * ingress.normalize, so there is nothing to crawl. An organization source starts each round with a
 * membership page, then backfills every newly seen channel one history page at a time and rescans
 * the last week of one channel backfilled before, in turn, or when due re-reads one such channel's
 * whole history (SLACK_DEEP_RESCAN_PERIOD_SECONDS); the socket delivers new messages. Each
 * history page reports the windows it read completely, so the host tombstones what Slack no longer
 * returns. A rate limit throws the
 * SDK's rate-limited error (slackBody), so the host waits out Slack's Retry-After.
 */
export async function syncPage(request, fetchSlack) {
  if (request?.scope !== 'organization') return { records: [], nextCursor: null, hasMore: false };
  if (typeof fetchSlack !== 'function') throw new Error('slack_sync_fetch_unavailable');
  const state = syncState(request.cursor);
  return state.queue.length || state.rescan ? historyPage(fetchSlack, state) : membershipPage(fetchSlack, state);
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
