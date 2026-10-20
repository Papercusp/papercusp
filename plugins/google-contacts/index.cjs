'use strict';
/**
 * Google Contacts provider (plan provider-adapters-to-packages-2026-10-11, P-004 / D-036).
 *
 * Replaces the app-code contacts poll (connector-sync-action.ts + personal-vault/live-sink.ts
 * syncGoogleContacts) and the contacts-access check that lived in external-triggers/google-workspace.ts.
 * It shares the one Google grant with the gmail and gcal packages through credentialGroup `google`,
 * so a single consent provisions the gmail, gcal and contacts sources.
 *
 * Mapping: a People API person -> `contact` record, event `contact-changed`, nativeId = the
 * person's resourceName, version = the person's etag (an unchanged contact replays as a duplicate
 * and is deduped by the host; an edited one is a new delivery).
 *
 * Cursor: `{ v: 1, pageToken }`. Each `syncPage` reads ONE people.connections page. A pass walks
 * every page; when Google returns no nextPageToken the pass ends with a null cursor, so the next
 * pass re-reads the list from the start (the host dedupes unchanged contacts on their etag).
 *
 * The only network path is `host.fetch`, which carries the source account's token. Nothing here
 * sees a credential, imports host code, or writes a table.
 */
const manifest = require('./papercusp.json');

const DESCRIPTOR = manifest.provider;
const CONNECTIONS = 'https://people.googleapis.com/v1/people/me/connections';
const DATATYPE = 'contact';
const EVENT = 'contact-changed';
const PAGE_SIZE = 1000;
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,metadata';
const DEFAULT_RETRY_AFTER_SECONDS = 60;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function syncError(kind, message, extra) {
  return Object.assign(new Error(message), { kind }, extra || {});
}

function bodyText(response) {
  return response.bodyEncoding === 'base64' ? Buffer.from(response.body || '', 'base64').toString('utf8') : response.body || '';
}

/**
 * One People API call. 429 and quota 403s are `rate-limited`, other 401/403s are `auth`, an
 * invalid page token (400 or 410) is `cursor-expired`, everything else unexpected is `transient`.
 */
async function call(host, source, op, url) {
  const response = await host.fetch({ source, request: { url, method: 'GET', headers: { accept: 'application/json' } } });
  const status = Number(response.status);
  const raw = bodyText(response);
  let json = null;
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
  }
  if (status >= 200 && status < 300) {
    if (raw && json === null) throw syncError('transient', `google_contacts_${op}_body_not_json`, { status, op });
    return json || {};
  }
  const error = json && json.error && typeof json.error === 'object' ? json.error : {};
  const message = typeof error.message === 'string' ? error.message : '';
  const detail = `google_contacts_${op}_http_${status}${message ? `: ${message.slice(0, 300)}` : ''}`;
  if (status === 429 || (status === 403 && /quota|rate ?limit|too many/i.test(message))) {
    const headers = {};
    for (const [name, value] of Object.entries(response.headers || {})) headers[name.toLowerCase()] = value;
    const retryAfter = Number(headers['retry-after']);
    throw syncError('rate-limited', detail, {
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : DEFAULT_RETRY_AFTER_SECONDS,
      status,
      op,
    });
  }
  if (status === 401 || status === 403) throw syncError('auth', detail, { status, op });
  if (status === 410 || (status === 400 && /page ?token/i.test(message))) throw syncError('cursor-expired', detail, { status, op });
  throw syncError('transient', detail, { status, op });
}

function values(list, field) {
  return (Array.isArray(list) ? list : [])
    .map((entry) => (entry && typeof entry === 'object' ? nonEmpty(entry[field]) : null))
    .filter(Boolean);
}

/** A People API person -> the canonical `contact` payload. Null when it has no stable id. */
function normalizeContact(person) {
  if (!person || typeof person !== 'object') return null;
  const resourceName = nonEmpty(person.resourceName);
  if (!resourceName) return null;
  const emails = values(person.emailAddresses, 'value');
  const phones = values(person.phoneNumbers, 'value');
  const organizations = values(person.organizations, 'name');
  const displayName = values(person.names, 'displayName')[0] || null;
  // `id` is the canonical `contact` datatype's one required field; the person's resourceName is
  // its only stable identifier. `resourceName` stays alongside it for the Google-native reader.
  return {
    id: resourceName,
    source: 'google-contacts',
    resourceName,
    ...(displayName ? { displayName } : {}),
    emails,
    phones,
    organizations,
    extensions: { google: { etag: nonEmpty(person.etag) } },
  };
}

function contactRecord(person) {
  const payload = normalizeContact(person);
  if (!payload) return null;
  const etag = payload.extensions.google.etag;
  const deleted = Boolean(person.metadata && person.metadata.deleted === true);
  return {
    datatype: DATATYPE,
    nativeId: payload.resourceName,
    event: EVENT,
    payload,
    ...(etag ? { version: etag } : {}),
    ...(deleted ? { deleted: true } : {}),
  };
}

function decodeCursor(raw) {
  if (raw === null || raw === undefined || raw === '') return { v: 1, pageToken: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw syncError('cursor-expired', 'google_contacts_cursor_unreadable');
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) throw syncError('cursor-expired', 'google_contacts_cursor_unrecognised');
  return { v: 1, pageToken: nonEmpty(parsed.pageToken) };
}

function connectionsUrl(pageToken, pageSize) {
  const url = new URL(CONNECTIONS);
  url.searchParams.set('personFields', PERSON_FIELDS);
  url.searchParams.set('pageSize', String(pageSize));
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return url.toString();
}

async function syncPage(request, host) {
  const cursor = decodeCursor(request.cursor);
  const body = await call(host, request.source, 'connections_list', connectionsUrl(cursor.pageToken, PAGE_SIZE));
  const records = (Array.isArray(body.connections) ? body.connections : []).map(contactRecord).filter(Boolean);
  const nextPageToken = nonEmpty(body.nextPageToken);
  return {
    records,
    nextCursor: nextPageToken ? JSON.stringify({ v: 1, pageToken: nextPageToken }) : null,
    hasMore: Boolean(nextPageToken),
  };
}

/**
 * contacts.read: the contacts-access check. A one-contact connections read proves the grant
 * actually carries contacts.readonly. Do not replace it with GET people/me: that profile-only
 * resource rejects a valid contacts.readonly token with 403.
 */
async function contactsRead(host, source, args) {
  const pageSize = Number.isInteger(args.pageSize) && args.pageSize > 0 && args.pageSize <= PAGE_SIZE ? args.pageSize : 1;
  const body = await call(host, source, 'connections_read', connectionsUrl(nonEmpty(args.pageToken), pageSize));
  return {
    contacts: (Array.isArray(body.connections) ? body.connections : []).map(normalizeContact).filter(Boolean),
    nextPageToken: nonEmpty(body.nextPageToken),
  };
}

async function invoke(request, host) {
  if (!DESCRIPTOR.capabilities.includes(request.capability)) {
    throw new Error(`provider_capability_unsupported:${request.capability}`);
  }
  const args = request.args && typeof request.args === 'object' ? request.args : {};
  if (request.capability === 'contacts.read') return contactsRead(host, request.source, args);
  throw new Error(`provider_capability_unsupported:${request.capability}`);
}

module.exports = {
  name: manifest.name,
  version: manifest.version,
  papercusp: manifest.papercusp,
  capabilities: manifest.capabilities,
  providerAdapter: {
    describe: () => DESCRIPTOR,
    syncPage,
    invoke,
  },
  // Exposed for the provider's own tests only; the host uses providerAdapter.
  _internal: { normalizeContact, contactRecord, decodeCursor },
};
