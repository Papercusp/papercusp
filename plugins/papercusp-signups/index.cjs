// Generated from adapter.ts by @papercusp/plugin-sdk/scripts/build-provider-daemons.mjs. Do not edit.
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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

// libs/papercusp/plugins/papercusp-signups/adapter.ts
var adapter_exports = {};
__export(adapter_exports, {
  providerAdapter: () => providerAdapter
});
module.exports = __toCommonJS(adapter_exports);

// packages/plugin-sdk/src/provider.ts
var PROVIDER_SYNC_ERROR_KINDS = ["cursor-expired", "rate-limited", "auth", "transient"];

// packages/plugin-sdk/src/provider-faults.ts
var KINDS = PROVIDER_SYNC_ERROR_KINDS;
function providerSyncFault(prefix, kind, message, extra) {
  if (!KINDS.includes(kind)) {
    throw new TypeError(`providerSyncFault: kind must be one of ${KINDS.join(", ")}, got ${JSON.stringify(kind)}`);
  }
  const fault = new Error(prefix ? `${prefix}:${message}` : message);
  if (extra) {
    for (const [field, value] of Object.entries(extra)) {
      if (field === "kind" || field === "message" || field === "stack" || value === void 0) continue;
      fault[field] = value;
    }
  }
  fault.kind = kind;
  if ("retryAfterSeconds" in fault) {
    const seconds = fault.retryAfterSeconds;
    if (kind !== "rate-limited" || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
      delete fault.retryAfterSeconds;
    }
  }
  return fault;
}
function providerHeaderValue(headers, name) {
  if (!headers) return void 0;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value == null ? void 0 : String(value);
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value == null) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return first == null ? void 0 : String(first);
  }
  return void 0;
}
var DELTA_SECONDS = /^\d+(?:\.\d+)?$/;
function retryAfterSecondsOf(headers, nowMs = Date.now()) {
  const raw = providerHeaderValue(headers, "retry-after")?.trim();
  if (!raw) return void 0;
  if (DELTA_SECONDS.test(raw)) return Math.ceil(Number(raw));
  if (!/[a-z]/i.test(raw)) return void 0;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return void 0;
  return Math.max(0, Math.ceil((at - nowMs) / 1e3));
}
function rateLimitedFault(prefix, message, headers, extra, nowMs) {
  const fromHeader = retryAfterSecondsOf(headers, nowMs);
  const fields = { ...extra };
  if (fields.retryAfterSeconds === void 0 && fromHeader !== void 0) fields.retryAfterSeconds = fromHeader;
  return providerSyncFault(prefix, "rate-limited", message, fields);
}

// libs/papercusp/plugins/papercusp-signups/papercusp.json
var papercusp_default = {
  distribution: "cupboard",
  kind: "plugin",
  name: "papercusp-signups",
  version: "0.1.0",
  papercusp: "^0.1.0",
  description: "Read captured papercusp.com access requests from Cloudflare KV through the host connector driver. Produces source-cited person records; signup is neither verified identity nor communication consent. Fixture verified only.",
  author: "Papercusp",
  license: "MIT",
  main: "./index.cjs",
  runtime: { kind: "daemon", daemonCommand: ["node", "daemon.cjs"] },
  capabilities: [],
  tools: [],
  provider: {
    id: "papercusp-signups",
    contractVersion: 1,
    displayName: "Papercusp captured signups",
    datatypes: ["person"],
    capabilities: [],
    egressHosts: ["api.cloudflare.com"],
    setup: { credentials: [{
      key: "kv_read_token",
      label: "Cloudflare KV read token",
      hosts: ["api.cloudflare.com"],
      help: "Use a token restricted to read the signup KV namespace in the selected Cloudflare account. The host stores it and injects the bearer; the adapter never receives it. Selecting a record destination is separate from connecting.",
      helpUrl: "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/"
    }] },
    configSchema: {
      type: "object",
      required: ["accountId", "namespaceId"],
      properties: {
        accountId: { type: "string", pattern: "^[a-f0-9]{32}$" },
        namespaceId: { type: "string", pattern: "^[a-f0-9]{32}$" },
        harnessSlug: { type: "string", minLength: 1 }
      },
      additionalProperties: false
    }
  }
};

// libs/papercusp/plugins/papercusp-signups/adapter.ts
var PREFIX = "papercusp_signups";
var ID = "papercusp-signups";
var HEX_ID = /^[a-f0-9]{32}$/;
var KEY = /^signup:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):[a-f0-9]{8}$/;
var PAGE_SIZE = 20;
var fail = (message) => {
  throw providerSyncFault(PREFIX, "transient", message);
};
var object = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("object_required");
  return raw;
};
var text = (raw) => typeof raw === "string" ? raw.trim() : "";
function configuration(request) {
  const accountId = text(request.config?.accountId);
  const namespaceId = text(request.config?.namespaceId);
  if (!HEX_ID.test(accountId) || !HEX_ID.test(namespaceId)) return fail("account_and_namespace_required");
  return { accountId, namespaceId };
}
function cursor(raw, scope) {
  if (raw === null) return null;
  let parsed;
  try {
    parsed = object(JSON.parse(raw));
  } catch {
    throw providerSyncFault(PREFIX, "cursor-expired", "invalid_cursor");
  }
  if (parsed.v !== 1 || !text(parsed.token) || text(parsed.token).length > 4096) {
    throw providerSyncFault(PREFIX, "cursor-expired", "invalid_cursor");
  }
  if (parsed.accountId !== scope.accountId || parsed.namespaceId !== scope.namespaceId) return fail("cursor_scope_mismatch");
  return parsed.token;
}
function body(response) {
  return response.bodyEncoding === "base64" ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
}
async function read(host, source, url) {
  const response = await host.fetch({ source, request: { url, method: "GET" } });
  if (response.status === 429) throw rateLimitedFault(PREFIX, "rate_limited", response.headers);
  if (response.status === 401 || response.status === 403) throw providerSyncFault(PREFIX, "auth", "kv_access_denied");
  if (response.status < 200 || response.status >= 300) return fail(`kv_http_${response.status}`);
  return response;
}
function json(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return fail("invalid_json");
  }
}
function attribution(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const source = raw;
  const out = {};
  for (const key of ["distinct_id", "session_id"]) {
    if (text(source[key])) out[key] = text(source[key]).slice(0, 100);
  }
  for (const key of ["first_touch", "last_touch"]) {
    const value = source[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const touch = value;
    const kept = {};
    for (const field of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "landing_path"]) {
      if (text(touch[field])) kept[field] = text(touch[field]).slice(0, 200);
    }
    if (touch.organic === true) kept.organic = true;
    if (typeof touch.ts === "number" && Number.isFinite(touch.ts) && touch.ts > 0 && touch.ts < 41024448e5) kept.ts = touch.ts;
    if (Object.keys(kept).length) out[key] = kept;
  }
  return Object.keys(out).length ? out : void 0;
}
function person(key, raw, scope) {
  const match = KEY.exec(key);
  const value = object(raw);
  const timestamp = text(value.ts);
  if (!match || timestamp !== match[1] || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    return fail("signup_capture_identity_invalid");
  }
  const email = text(value.email).toLowerCase();
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return fail("signup_email_invalid");
  const reportedAttribution = attribution(value.attribution);
  return {
    datatype: "person",
    nativeId: key,
    event: "person.updated",
    occurredAt: timestamp,
    payload: {
      provider: ID,
      externalId: key,
      observedAt: timestamp,
      emails: [email],
      extensions: { [ID]: {
        signupEventId: key,
        capturedAt: timestamp,
        evidenceRef: `cloudflare-kv:${scope.accountId}:${scope.namespaceId}:${key}`,
        emailVerified: false,
        communicationConsent: false,
        selfReported: {
          useCase: text(value.what).slice(0, 500),
          ...reportedAttribution ? { attribution: reportedAttribution } : {}
        }
      } }
    }
  };
}
var providerAdapter = {
  describe: () => papercusp_default.provider,
  async syncPage(request, host) {
    const scope = configuration(request);
    const token = cursor(request.cursor, scope);
    const base = `https://api.cloudflare.com/client/v4/accounts/${scope.accountId}/storage/kv/namespaces/${scope.namespaceId}`;
    const url = new URL(`${base}/keys`);
    url.searchParams.set("prefix", "signup:");
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (token) url.searchParams.set("cursor", token);
    const list = object(json(body(await read(host, request.source, url.href))));
    if (list.success !== true || !Array.isArray(list.result) || list.result.length > PAGE_SIZE) return fail("kv_key_page_invalid");
    const info = object(list.result_info);
    if (typeof info.cursor !== "string" || info.cursor.length > 4096) return fail("kv_page_cursor_invalid");
    const next = info.cursor || null;
    if (next && next === token) return fail("kv_cursor_not_advancing");
    const keys = list.result.map((row) => text(object(row).name));
    if (keys.some((key) => !KEY.test(key)) || new Set(keys).size !== keys.length) return fail("kv_signup_keys_invalid");
    const records = [];
    for (const key of keys) {
      const response = await read(host, request.source, `${base}/values/${encodeURIComponent(key)}`);
      records.push(person(key, json(body(response)), scope));
    }
    return { records, nextCursor: next ? JSON.stringify({ v: 1, ...scope, token: next }) : null, hasMore: next !== null };
  },
  async invoke() {
    return fail("no_invokable_capabilities");
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  providerAdapter
});
