/**
 * Postgres connection layer for the harness store.
 *
 * Backing DB: `papercusp` on the same Postgres instance Paperclip uses.
 * Schemas: `harness_shared` (cross-cutting) + `harness_<slug>` (per-harness).
 *
 * Two client surfaces:
 *   - getOrgPg()              → admin client (search_path = harness_shared, public);
 *                               use for cross-harness reads/writes (UNION views,
 *                               projects, messages).
 *   - getHarnessPg(slug)      → per-harness client (search_path = harness_<slug>,
 *                               harness_shared, public); unqualified
 *                               `harness_features` resolves to that harness's table.
 *
 * Both expose:
 *   - `.sql`        — the postgres-js template tag (raw SQL, async)
 *   - `.drizzle`    — Drizzle ORM instance bound to the same client
 *
 * Connection URL:
 *   $HARNESS_DATABASE_URL  (defaults to harness_app role on localhost)
 */
import postgres, { Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as sharedSchema from './schema';

// Read env at connection time so test fixtures (which set
// HARNESS_DATABASE_URL after this module is imported) take effect.
function appUrl(): string {
  return process.env.HARNESS_DATABASE_URL
    ?? 'postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp';
}
function adminUrl(): string {
  return process.env.HARNESS_ADMIN_DATABASE_URL
    ?? 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
}

let _adminClient: Sql | null = null;
let _adminDrizzle: ReturnType<typeof drizzle> | null = null;
type HarnessClient = { sql: Sql; drizzle: ReturnType<typeof drizzle>; lastUsed: number };
const _harnessClients = new Map<string, HarnessClient>();

// LRU cap on per-harness pools. Workspaces touch many slugs over time and
// each pool keeps a long-lived idle conn — without a cap we'd blow past
// Postgres's max_connections=100 (audit found 83 idle conns from a single
// session). When the cap is exceeded, the LRU entry is `.end()`-ed and
// dropped so its socket goes back to Postgres immediately.
const HARNESS_POOL_CAP = Math.max(
  1,
  Number(process.env.PAPERCUSP_HARNESS_POOL_CAP) || 8,
);

function evictHarnessPoolsIfFull(): void {
  while (_harnessClients.size >= HARNESS_POOL_CAP) {
    let oldestSlug: string | null = null;
    let oldestTs = Infinity;
    for (const [slug, h] of _harnessClients) {
      if (h.lastUsed < oldestTs) { oldestTs = h.lastUsed; oldestSlug = slug; }
    }
    if (!oldestSlug) return;
    const evict = _harnessClients.get(oldestSlug);
    _harnessClients.delete(oldestSlug);
    if (evict) {
      // Fire-and-forget; .end() drains in-flight queries with a short timeout.
      evict.sql.end({ timeout: 2 }).catch(() => {});
    }
  }
}

function buildClient(connectionUrl: string, searchPath: string[], maxOverride?: number): Sql {
  const sp = searchPath.map((s) => `"${s.replace(/"/g, '""')}"`).join(', ');
  // Desktop pglite mode: PAPERCUSP_PGLITE_SOCKET_DIR points at a unix
  // socket dir. We override `host` in the options so postgres-js connects
  // through the socket regardless of what the URL says. The URL still
  // needs a parseable host (use `localhost`) — postgres-js's URL parser
  // doesn't decode percent-encoded socket paths, and the canonical
  // empty-host form (`postgres://user@/db?host=/sock`) is rejected by
  // Node's `new URL()` which is called on the connection string at
  // module load time elsewhere in the operator chain.
  const pgliteSocket = process.env.PAPERCUSP_PGLITE_SOCKET_DIR;
  return postgres(connectionUrl, {
    onnotice: () => {},
    connection: {
      search_path: sp,
    },
    ...(pgliteSocket ? { host: pgliteSocket } : {}),
    // Pool size honors PAPERCUSP_DB_POOL_MAX env. Default 4 — earlier
    // default of 8 multiplied with ~20 registered harnesses pushed us
    // past Postgres's max_connections=100 in dev. Desktop builds set it
    // to 1 because pglite-socket serializes queries internally.
    // Per-harness pools pass maxOverride=1: with ~20 harnesses, even max=4
    // each saturates max_connections=100 once each pool warms up.
    max: maxOverride ?? Math.max(1, Number(process.env.PAPERCUSP_DB_POOL_MAX) || 4),
    // Close idle connections aggressively. Default 5s is short enough
    // that pools touched by polling endpoints (status, plan-review,
    // log/stream) actually go idle between bursts and release. The
    // earlier 30s default never triggered because polling intervals
    // were shorter than the timeout.
    idle_timeout: Math.max(0, Number(process.env.PAPERCUSP_DB_IDLE_TIMEOUT) || 5),
    // Hard cap on connection age. Even if a pool is hot, recycle the
    // socket every ~10 min so a long-lived dev session doesn't pin
    // stale conns indefinitely.
    max_lifetime: Math.max(60, Number(process.env.PAPERCUSP_DB_MAX_LIFETIME) || 600),
    // BIGINT → number. Our timestamps and attempt counts fit safely in Number's
    // 2^53 range; expected_cost_cents won't realistically exceed it. Override
    // case-by-case if a column ever needs full BIGINT precision.
    types: {
      bigint: {
        to: 20, from: [20],
        serialize: (x: any) => String(x),
        parse: (x: string) => Number(x),
      } as any,
    },
  });
}

export interface OrgPgHandle {
  sql: Sql;
  drizzle: ReturnType<typeof drizzle>;
  schema: typeof sharedSchema;
}

/**
 * Admin (cross-harness) client. Use for views/aggregations/projects/messages.
 *
 * search_path includes `papercup_shared` so the Papercup-specific tables
 * (messages, message_recipients, message_comments, directive_summaries) that
 * were extracted into their own schema in Stage 2 of the framework split
 * remain reachable from unqualified queries (e.g. legacy `INSERT INTO messages`).
 */
export function getOrgPg(): OrgPgHandle {
  if (!_adminClient) {
    _adminClient = buildClient(adminUrl(), ['harness_shared', 'papercup_shared', 'public']);
    _adminDrizzle = drizzle(_adminClient, { schema: sharedSchema });
  }
  return { sql: _adminClient, drizzle: _adminDrizzle!, schema: sharedSchema };
}

let _appOrgClient: Sql | null = null;
let _appOrgDrizzle: ReturnType<typeof drizzle> | null = null;

/**
 * App-role org client. Same search_path as `getOrgPg()` but uses the
 * `harness_app` role, which is SUBJECT to RLS policies on
 * `harness_shared.*`. Required for the workspace-scoping contract:
 * `withWorkspace()` opens a transaction on this client and issues
 * `SET LOCAL app.workspace_id` so RLS predicates can filter by it.
 *
 * Use `getOrgPg()` only for migrations and tooling that intentionally
 * spans workspaces (the harness_admin role bypasses RLS).
 */
export function getOrgPgApp(): OrgPgHandle {
  if (!_appOrgClient) {
    _appOrgClient = buildClient(appUrl(), ['harness_shared', 'papercup_shared', 'public']);
    _appOrgDrizzle = drizzle(_appOrgClient, { schema: sharedSchema });
  }
  return { sql: _appOrgClient, drizzle: _appOrgDrizzle!, schema: sharedSchema };
}

/**
 * Per-harness client with search_path scoped to that harness's schema.
 * Unqualified `harness_features` resolves to harness_<slug>.harness_features.
 * Shared tables remain reachable as `projects`, `messages`, etc.
 *
 * `papercup_shared` is included so org.ts message-bus queries running with a
 * per-harness client (e.g. department harnesses) still resolve unqualified
 * `messages`, `message_recipients`, etc.
 */
export function getHarnessPg(slug: string) {
  const cached = _harnessClients.get(slug);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached;
  }
  evictHarnessPoolsIfFull();
  const schemaName = sharedSchema.slugToSchemaName(slug);
  const perHarnessMax = Math.max(1, Number(process.env.PAPERCUSP_HARNESS_DB_POOL_MAX) || 1);
  const sql = buildClient(appUrl(), [schemaName, 'harness_shared', 'papercup_shared', 'public'], perHarnessMax);
  const dz = drizzle(sql, { schema: sharedSchema });
  const handle: HarnessClient = { sql, drizzle: dz, lastUsed: Date.now() };
  _harnessClients.set(slug, handle);
  return handle;
}

/**
 * Test-only: close all open pools so a different DATABASE_URL can be used.
 */
export async function _resetForTests() {
  if (_adminClient) {
    await _adminClient.end({ timeout: 1 }).catch(() => {});
  }
  _adminClient = null;
  _adminDrizzle = null;
  for (const h of _harnessClients.values()) {
    await h.sql.end({ timeout: 1 }).catch(() => {});
  }
  _harnessClients.clear();
}
