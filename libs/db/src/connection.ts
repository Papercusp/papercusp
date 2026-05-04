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
const _harnessClients = new Map<string, { sql: Sql; drizzle: ReturnType<typeof drizzle> }>();

function buildClient(connectionUrl: string, searchPath: string[]): Sql {
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
    // Pool size honors PAPERCUSP_DB_POOL_MAX env. Default 2 — operators
    // with ~20 registered harnesses each open a per-harness pool, so
    // 20 × 2 = 40 idle connections leaves 60+ slots for other clients
    // (snapshot pg_dump, marketplace-api, zero-cache, etc.) under
    // Postgres's max_connections=100. Earlier defaults of 4 and 8 saturated
    // the slot table and produced "remaining connection slots are reserved
    // for roles with the SUPERUSER attribute" failures from the snapshot
    // and marketplace endpoints. Desktop builds set it to 1 because
    // pglite-socket serializes queries internally.
    max: Math.max(1, Number(process.env.PAPERCUSP_DB_POOL_MAX) || 2),
    // Auto-close connections that sit idle for >30s. Prevents per-harness
    // pools from accumulating idle conns indefinitely (Next.js dev mode
    // module re-instantiation otherwise leaks the prior pool's sockets).
    // Override via PAPERCUSP_DB_IDLE_TIMEOUT (seconds; 0 disables).
    idle_timeout: Math.max(0, Number(process.env.PAPERCUSP_DB_IDLE_TIMEOUT) || 30),
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
  if (cached) return cached;
  const schemaName = sharedSchema.slugToSchemaName(slug);
  const sql = buildClient(appUrl(), [schemaName, 'harness_shared', 'papercup_shared', 'public']);
  const dz = drizzle(sql, { schema: sharedSchema });
  const handle = { sql, drizzle: dz };
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
