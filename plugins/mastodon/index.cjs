var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target2, all) => {
  for (var name2 in all)
    __defProp(target2, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// libs/papercusp/plugins/mastodon/adapter.ts
var adapter_exports = {};
__export(adapter_exports, {
  capabilities: () => capabilities,
  name: () => name,
  papercusp: () => papercusp,
  providerAdapter: () => providerAdapter,
  version: () => version
});
module.exports = __toCommonJS(adapter_exports);

// packages/operator-core/lib/html-to-text.ts
var NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " "
};
var MAX_CODE_POINT = 1114111;
function decodeHtmlEntities(input) {
  return input.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (match, dec, hex, name2) => {
    if (dec !== void 0) return fromCodePoint(Number.parseInt(dec, 10), match);
    if (hex !== void 0) return fromCodePoint(Number.parseInt(hex, 16), match);
    return NAMED_ENTITIES[String(name2).toLowerCase()] ?? match;
  });
}
function fromCodePoint(codePoint, fallback) {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > MAX_CODE_POINT) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}
function htmlToText(html) {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table|ul|ol|blockquote)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeHtmlEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// libs/papercusp/plugins/mastodon/papercusp.json
var papercusp_default = {
  kind: "plugin",
  name: "mastodon",
  version: "0.1.0",
  papercusp: "^0.1.0",
  description: "Mastodon home timeline and mention reads with instance-bound status publishing.",
  author: "Papercusp",
  license: "MIT",
  main: "./index.cjs",
  runtime: { kind: "daemon", daemonCommand: ["node", "daemon.cjs"] },
  capabilities: [],
  tools: [],
  provider: {
    id: "mastodon",
    contractVersion: 1,
    displayName: "Mastodon",
    datatypes: ["social-post"],
    capabilities: ["social.post", "social.reply", "social.delete"],
    egressHosts: [],
    oauth: {
      instance: true,
      authorizeUrl: "/oauth/authorize",
      tokenUrl: "/oauth/token",
      clientRegistrationRef: "mastodon",
      refreshPolicy: "reauthorize",
      scopes: ["read:accounts", "read:statuses", "read:notifications", "write:statuses"],
      identity: { url: "/api/v1/accounts/verify_credentials", idField: "id", displayNameField: "acct" }
    },
    defaultDestinations: { "social-post": ["document", "event"] },
    setup: { appRegistration: {
      createUrl: "/settings/applications/new",
      docsUrl: "https://docs.joinmastodon.org/client/token/",
      copyHint: "On your Mastodon instance, open Preferences \u2192 Development, create an application with these scopes and the callback shown here, then save its client credentials for that instance."
    } },
    configSchema: {
      type: "object",
      required: ["connectionOrigin", "connectionAccountId"],
      properties: {
        connectionOrigin: { type: "string", title: "Connected instance", readOnly: true },
        connectionAccountId: { type: "string", title: "Connected account", readOnly: true },
        pageSize: { type: "integer", minimum: 1, maximum: 40, default: 40 },
        maxPages: { type: "integer", minimum: 1, maximum: 1e3, default: 200 }
      },
      additionalProperties: false
    }
  }
};

// libs/papercusp/plugins/mastodon/adapter.ts
var { name, version, papercusp } = papercusp_default;
var capabilities = [];
var descriptor = papercusp_default.provider;
var text = (value) => typeof value === "string" ? value : "";
var object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
var token = (value) => typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\s/\\?#\u0000-\u001f]/.test(value);
function fault(kind, message, extra = {}) {
  return Object.assign(new Error(`mastodon:${message}`), { kind }, extra);
}
function configOf(raw = {}) {
  const origin = text(raw.connectionOrigin);
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw fault("auth", "connection_origin_missing");
  }
  if (url.protocol !== "https:" || url.origin !== origin) throw fault("auth", "connection_origin_invalid");
  if (!token(raw.connectionAccountId)) throw fault("auth", "connection_account_missing");
  const bounded = (key, fallback, max) => {
    const n = raw[key] ?? fallback;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max) throw fault("transient", `invalid_${key}`);
    return n;
  };
  return { origin, account: raw.connectionAccountId, pageSize: bounded("pageSize", 40, 40), maxPages: bounded("maxPages", 200, 1e3) };
}
var stream = (since = null) => ({ since, position: since, newest: since, pages: 0 });
function fresh(config, since) {
  return { v: 1, config, phase: 0, timeline: stream(since?.timeline.newest), mentions: stream(since?.mentions.newest), emitted: [] };
}
function decode(raw, config) {
  if (raw == null) return fresh(config);
  let c;
  try {
    c = JSON.parse(raw);
  } catch {
    throw fault("cursor-expired", "cursor_unreadable");
  }
  const validStream = (s) => object(s) && [s.since, s.position, s.newest].every((v) => v === null || token(v)) && Number.isInteger(s.pages) && Number(s.pages) >= 0 && Number(s.pages) <= 1e3;
  if (!object(c) || c.v !== 1 || ![0, 1, 2].includes(c.phase) || !object(c.config) || !validStream(c.timeline) || !validStream(c.mentions) || !Array.isArray(c.emitted) || !c.emitted.every((v) => typeof v === "string")) throw fault("cursor-expired", "cursor_unrecognised");
  if (JSON.stringify(c.config) !== JSON.stringify(config)) return fresh(config);
  return c.phase === 2 ? fresh(config, c) : c;
}
function header(headers, key) {
  return Object.entries(headers).find(([name2]) => name2.toLowerCase() === key)?.[1];
}
async function call(host, source, origin, path, method = "GET", body, headers, absent = false) {
  const response = await host.fetch({ source, request: { url: new URL(path, origin).href, method, ...body ? { body } : {}, ...headers ? { headers } : {} } });
  if (absent && response.status === 404) return null;
  if ([401, 403].includes(response.status)) throw fault("auth", "grant_refused");
  if (response.status === 429) {
    const retry = Number(header(response.headers, "retry-after"));
    const reset = Date.parse(header(response.headers, "x-ratelimit-reset") ?? "");
    const seconds = Number.isFinite(retry) && retry > 0 ? retry : Math.ceil((reset - Date.now()) / 1e3);
    throw fault("rate-limited", "throttled", Number.isFinite(seconds) && seconds >= 0 ? { retryAfterSeconds: Math.ceil(seconds) } : {});
  }
  if (response.status < 200 || response.status >= 300) throw fault("transient", method === "POST" ? "write_unconfirmed_do_not_retry" : "request_failed");
  let value;
  try {
    value = JSON.parse(response.body);
  } catch {
    throw fault("transient", "response_unreadable");
  }
  if (object(value) && value.error) throw fault("transient", "request_failed");
  return value;
}
function record(value, mention, config) {
  if (!object(value) || !token(value.id) || !text(value.uri) || !date(value.created_at) || !object(value.account) || !token(value.account.id) || !text(value.account.acct) || typeof value.content !== "string" || !["public", "unlisted", "private", "direct"].includes(text(value.visibility)) || value.edited_at != null && !date(value.edited_at) || value.in_reply_to_id != null && !token(value.in_reply_to_id)) throw fault("transient", "malformed_status");
  const payload = {
    id: value.uri,
    text: htmlToText(value.content),
    platform: "mastodon",
    statusId: value.id,
    instanceHost: config.origin.slice(8),
    visibility: value.visibility,
    author: value.account.acct,
    authorHandle: value.account.acct,
    occurredAt: value.created_at,
    uri: value.uri
  };
  if (text(value.url)) payload.url = value.url;
  if (value.edited_at) payload.editedAt = value.edited_at;
  if (value.in_reply_to_id) payload.replyToId = value.in_reply_to_id;
  return {
    datatype: "social-post",
    nativeId: value.uri,
    event: mention ? "mention" : value.in_reply_to_id ? "reply" : "post",
    payload,
    occurredAt: value.created_at,
    version: `${value.id}@${value.edited_at ?? value.created_at}`
  };
}
async function syncPage(request, host) {
  const config = configOf(request.config);
  const cursor = decode(request.cursor, config);
  const mentions = cursor.phase === 1;
  const state = mentions ? cursor.mentions : cursor.timeline;
  const path = mentions ? "/api/v1/notifications" : "/api/v1/timelines/home";
  const params = new URLSearchParams({ limit: String(config.pageSize) });
  if (mentions) params.append("types[]", "mention");
  if (state.position) params.set(state.since ? "min_id" : "max_id", state.position);
  const body = await call(host, request.source, config.origin, `${path}?${params}`);
  if (!Array.isArray(body)) throw fault("transient", "malformed_collection");
  const records = [];
  const seen = new Set(cursor.emitted);
  for (const item of body) {
    if (!object(item) || !token(item.id) || mentions && item.type !== "mention") throw fault("transient", "malformed_collection_item");
    const normalized = record(mentions ? item.status : item, mentions, config);
    const key = `${normalized.event}:${normalized.nativeId}:${normalized.version}`;
    if (!seen.has(key)) {
      seen.add(key);
      records.push(normalized);
    }
  }
  if (body.length) {
    const first = body[0].id;
    const last = body[body.length - 1].id;
    const position = state.since ? first : last;
    if (position === state.position) throw fault("cursor-expired", "paging_made_no_progress");
    if (!state.newest || state.since) state.newest = first;
    state.position = position;
    state.pages++;
    if (state.pages >= config.maxPages) throw fault("transient", "page_bound_exceeded");
  } else cursor.phase = mentions ? 2 : 1;
  cursor.emitted = cursor.phase === 2 ? [] : [...seen];
  return {
    records,
    nextCursor: JSON.stringify(cursor),
    hasMore: cursor.phase !== 2,
    catchUp: state.since ? { path: "backfill", reason: "no-replay-supported" } : { path: "cold-start" }
  };
}
function target(args, config) {
  let value = args.target;
  if (object(value) && "externalId" in value) {
    if (!object(value.payload) || typeof value.externalId !== "string") throw fault("transient", "invalid_stored_target");
    value = { platform: value.platform, inReplyToId: text(value.payload.statusId) || value.externalId, instanceHost: value.payload.instanceHost };
  }
  if (!object(value) || value.platform !== "mastodon" || !token(value.inReplyToId)) throw fault("transient", "invalid_target");
  const host = text(value.instanceHost);
  let origin;
  try {
    origin = new URL(host.includes("://") ? host : `https://${host}`).origin;
  } catch {
    throw fault("auth", "instance_mismatch");
  }
  if (origin !== config.origin) throw fault("auth", "instance_mismatch");
  return value.inReplyToId;
}
var visibilities = { public: "public", unlisted: "unlisted", followers: "private", direct: "direct" };
var providerAdapter = {
  describe: () => descriptor,
  syncPage,
  async invoke(request, host) {
    if (!descriptor.capabilities.includes(request.capability)) throw fault("transient", "capability_unsupported");
    const config = configOf(request.config);
    const args = request.args;
    if (request.capability === "social.delete") {
      const id = target(args, config);
      const path = `/api/v1/statuses/${encodeURIComponent(id)}`;
      const existing = await call(host, request.source, config.origin, path, "GET", void 0, void 0, true);
      if (existing === null) return { deleted: false };
      if (!object(existing) || existing.id !== id || !object(existing.account) || !token(existing.account.id)) throw fault("transient", "malformed_owner");
      if (existing.account.id !== config.account) throw fault("auth", "delete_not_owned");
      const removed = await call(host, request.source, config.origin, path, "DELETE", void 0, void 0, true);
      return { deleted: removed !== null };
    }
    const params = new URLSearchParams();
    if (request.capability === "social.reply") params.set("in_reply_to_id", target(args, config));
    else {
      const destination = text(args.destination);
      if (destination !== config.origin && destination !== config.origin.slice(8)) throw fault("auth", "destination_mismatch");
    }
    const requestedVisibility = text(args.visibility) || "public";
    if (!Object.hasOwn(visibilities, requestedVisibility)) throw fault("transient", "invalid_visibility");
    const visibility = visibilities[requestedVisibility];
    if (!text(args.text).trim() || /[\r\n]/.test(text(args.idempotencyKey)) || !text(args.idempotencyKey) || text(args.idempotencyKey).length > 2048) throw fault("transient", "invalid_text_or_idempotency_key");
    if (args.media !== void 0 && (!Array.isArray(args.media) || args.media.length)) throw fault("transient", "media_unsupported");
    params.set("status", text(args.text));
    params.set("visibility", visibility);
    const created = await call(host, request.source, config.origin, "/api/v1/statuses", "POST", params.toString(), { "content-type": "application/x-www-form-urlencoded", "Idempotency-Key": text(args.idempotencyKey) });
    if (!object(created) || !token(created.id) || !text(created.uri)) throw fault("transient", "write_unconfirmed_do_not_retry");
    return { externalId: created.uri, ...text(created.url) ? { url: created.url } : {} };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  capabilities,
  name,
  papercusp,
  providerAdapter,
  version
});
