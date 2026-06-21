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
import { createRequire } from 'node:module';
import postgres, { Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as sharedSchema from './schema';
import { getResourceProfile } from '../../../../../packages/operator-core/lib/resource-profile';
// Pure helper (no host config needed — takes explicit args), so the generic lib
// directly. The configured binding above is used for the memoized profile.
import { boundedOrgPoolMax } from '@papercusp/resource-profile';

// This package is `"type": "module"`, so ESM has no ambient `require`.
// `createRequire` gives us a synchronous loader for the lazy node-builtin
// reads below (kept lazy so the module can be imported without touching
// the filesystem in a no-fs environment).
const nodeRequire = createRequire(import.meta.url);
import * as generatedSchema from './schema/generated';
import * as generatedRelations from './schema/generated-relations';

// The `./schema` barrel re-exports `generated` + `generatedRelations` as nested
// namespace objects (so callers can `import { generated } from '@papercusp/db-org'`).
// Those nested namespaces are NOT Tables/Relations — handing them inside a
// `drizzle({ schema })` map makes drizzle's relational-config extraction read
// `.constructor` off a non-table object and crash with
// "Cannot read properties of null (reading 'constructor')". Strip them so the
// schema drizzle sees is table/relation-only; direct importers still get the
// namespaces straight from the barrel.
const { generated: _omitGeneratedNs, generatedRelations: _omitGeneratedRelationsNs, ...sharedTables } = sharedSchema;
void _omitGeneratedNs;
void _omitGeneratedRelationsNs;

// Merged schema for the typed Drizzle instance (`.db`). Includes all
// 125 introspected tables + their relation graph + the hand-written
// per-harness factory helpers. Drizzle deduplicates identically-named
// table refs internally; the hand-written `auditLog`/`projects`/etc.
// shadow the same PG tables that `generated.audit_logInHarness_shared`
// covers, which is fine — both accessors point at the same rows.
const fullSchema = {
  ...sharedTables,
  ...generatedSchema,
  ...generatedRelations,
};

// Read env at connection time so test fixtures (which set
// HARNESS_DATABASE_URL after this module is imported) take effect.
//
// Resolution chain (added 2026-05-12 — superseded the bare native fallback):
//   1. Explicit env (HARNESS_DATABASE_URL / HARNESS_ADMIN_DATABASE_URL).
//      Set by Tauri main when spawning the desktop sidecar — that path
//      always wins.
//   2. Discovery file at $HOME/.papercusp/embedded-pg.json — written
//      by the desktop's Rust main on embedded-PG ready, deleted on
//      shutdown. Lets `apps/operator npm run dev` (no env set) share
//      the SAME embedded PG the desktop is running.
//   3. Native :5432 fallback — only when neither (1) nor (2) is
//      available. Same string as before so nothing breaks for users
//      who don't run the desktop.
//
// Cached per-process so we don't fs-stat every connection. Re-reading
// would also produce stale results when the desktop port changes
// across restarts — env-set callers (Tauri sidecar) get a fresh module
// load anyway.
let _resolvedAppUrl: string | null = null;
let _resolvedAppUrlSource: 'env' | 'discovery' | null = null;
let _resolvedAdminUrl: string | null = null;
let _resolvedAdminUrlSource: 'env' | 'discovery' | null = null;
function readDiscoveryFile(): { user?: string; password?: string; host?: string; port?: number } | null {
  if (process.env.PAPERCUSP_SKIP_PG_DISCOVERY === '1') return null;
  try {
    // Lazy require so this module can be imported in environments
    // without `node:fs` (browser, edge runtime). The drizzle/postgres
    // path is server-only in practice but be defensive.
    const fs = nodeRequire('node:fs') as typeof import('node:fs');
    const os = nodeRequire('node:os') as typeof import('node:os');
    const path = `${os.homedir()}/.papercusp/embedded-pg.json`;
    const raw = fs.readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { host?: string; port?: number; user?: string; password?: string };
    if (parsed?.port && parsed?.host) return parsed;
  } catch {
    // missing / unparseable — fall through to native fallback
  }
  return null;
}
function appUrl(): string {
  if (_resolvedAppUrl && _resolvedAppUrlSource === 'env') return _resolvedAppUrl;
  if (process.env.HARNESS_DATABASE_URL) {
    _resolvedAppUrl = process.env.HARNESS_DATABASE_URL;
    _resolvedAppUrlSource = 'env';
    return _resolvedAppUrl;
  }
  const disc = readDiscoveryFile();
  if (disc) {
    // Discovery file ships harness_admin creds; for the app role we
    // know the convention (harness_app/harness_app_pwd) since both
    // are auto-created by embedded-postgres-server with fixed pwds.
    const url = `postgresql://harness_app:harness_app_pwd@${disc.host}:${disc.port}/papercusp`;
    if (url !== _resolvedAppUrl) {
      _resolvedAppUrl = url;
      _resolvedAppUrlSource = 'discovery';
      // Discovery URL changed — invalidate cached pool so next
      // getOrgPgApp() call rebuilds. Mirror of the adminUrl()
      // invalidation block below (E2E round-13 bug #33 — app-side
      // half of the same pattern).
      if (_appOrgClient) {
        try { _appOrgClient.end({ timeout: 1 }).catch(() => {}); } catch {}
        _appOrgClient = null;
        _appOrgDrizzle = null;
        _appOrgDb = null;
      }
    }
    return _resolvedAppUrl;
  }
  // Never cache the native fallback.
  return 'postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp';
}
function adminUrl(): string {
  // Env is stable for process lifetime → safe to cache.
  if (_resolvedAdminUrl && _resolvedAdminUrlSource === 'env') return _resolvedAdminUrl;
  if (process.env.HARNESS_ADMIN_DATABASE_URL) {
    _resolvedAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
    _resolvedAdminUrlSource = 'env';
    return _resolvedAdminUrl;
  }
  // Discovery file can change (desktop restart / port shuffle) — re-read
  // every call. Never cache the native fallback (poisons pool when
  // operator boots before desktop writes the discovery file).
  const disc = readDiscoveryFile();
  // Embedded-pg always uses fixed passwords, so we don't strictly need the
  // password in the discovery file — fall back to the known default.
  // This handles desktops that wrote the discovery file before we added the
  // password field (release v0.0.1).
  if (disc?.host && disc?.port) {
    const user = disc.user || 'harness_admin';
    const pwd = disc.password || 'harness_admin_pwd';
    const url = `postgresql://${user}:${pwd}@${disc.host}:${disc.port}/papercusp`;
    if (url !== _resolvedAdminUrl) {
      _resolvedAdminUrl = url;
      _resolvedAdminUrlSource = 'discovery';
      // Discovery URL changed — invalidate cached pool so next call rebuilds.
      if (_adminClient) {
        try { _adminClient.end({ timeout: 1 }).catch(() => {}); } catch {}
        _adminClient = null;
        _adminDrizzle = null;
        _adminDb = null;
      }
    }
    return _resolvedAdminUrl;
  }
  return 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
}
/** Test-only — clears cached URLs so a test that mutates env between cases sees the change. */
export function _resetUrlCacheForTests(): void {
  _resolvedAppUrl = null;
  _resolvedAdminUrl = null;
}

/**
 * When `PAPERCUSP_PGBOUNCER=1`, route an org/harness pool URL through the local
 * PgBouncer (transaction pooling) on `PAPERCUSP_PGBOUNCER_PORT` (default 6432) —
 * C2 of backend-connection-scaling-2026-06-17. This is what lets thousands of
 * concurrent agent tool-calls multiplex onto a bounded set of PG backends.
 *
 * GATED default-off, and deliberately so: transaction pooling does NOT preserve a
 * connection's connect-time `search_path`, so enabling this is only correct once
 * C1-2 (per-transaction `SET LOCAL search_path`) lands. Until then the default
 * (direct) path is used. Listeners (sync-sse, *-bus) use `getHarnessAdminUrl()`
 * and are intentionally NOT rerouted — LISTEN is session-bound and must bypass a
 * transaction pooler (C2-2).
 */
export function maybePgbouncer(url: string): string {
  if (process.env.PAPERCUSP_PGBOUNCER !== '1') return url;
  const port = Number(process.env.PAPERCUSP_PGBOUNCER_PORT) || 6432;
  try {
    const u = new URL(url);
    u.host = `127.0.0.1:${port}`;
    return u.toString();
  } catch {
    return url; // unparseable — leave the direct URL untouched
  }
}

let _adminClient: Sql | null = null;
let _adminDrizzle: ReturnType<typeof drizzle> | null = null;
let _adminDb: ReturnType<typeof drizzle<typeof fullSchema>> | null = null;
type HarnessClient = {
  sql: Sql;
  drizzle: ReturnType<typeof drizzle>;
  db: ReturnType<typeof drizzle<typeof fullSchema>>;
  lastUsed: number;
};
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

/**
 * A short, stable `application_name` so every pooled connection is attributable
 * in `pg_stat_activity` (the connection-exhaustion incident on 2026-06-17 was
 * hard to diagnose precisely because the org/harness pools were anonymous — only
 * su-lock + migrations tagged themselves). Format `pcusp:<label>:p<pid>`, capped
 * at PG's 63-byte NAMEDATALEN-1 limit. C0-2 of backend-connection-scaling-2026-06-17.
 */
function pgAppName(label: string): string {
  const s = `pcusp:${label}:p${process.pid}`;
  return s.length > 63 ? s.slice(0, 63) : s;
}

/**
 * Size of each org pool (getOrgPg admin + getOrgPgApp app). C1-1 of
 * backend-connection-scaling-2026-06-17. An explicit `PAPERCUSP_DB_POOL_MAX`
 * wins; otherwise the resource-profile size, but BOUNDED so that
 * (2 org pools × expected operator processes) + fixed overhead cannot exceed the
 * host-tuned ceiling — the guard the P4-3 regression lacked (it sized each pool to
 * 52 with no awareness of the 2-pool × N-process multiplication or the DB ceiling).
 * Behind a transaction pooler (PAPERCUSP_PGBOUNCER=1) the app pool maps to local
 * pooler *client* slots, not PG backends, so it keeps the full resource-profile
 * size — that decoupling is the whole point of C2.
 */
function resolveOrgPoolMax(): number {
  const envOverride = Number(process.env.PAPERCUSP_DB_POOL_MAX);
  const profile = getResourceProfile();
  const desired =
    Number.isFinite(envOverride) && envOverride > 0
      ? Math.max(1, Math.floor(envOverride))
      : profile.pgPoolMax;
  return boundedOrgPoolMax({
    desired,
    maxConnections: profile.database.maxConnections,
    superuserReserved: profile.database.superuserReservedConnections,
    expectedProcesses: Math.max(1, Number(process.env.PAPERCUSP_EXPECTED_OPERATOR_PROCS) || 2),
    behindPooler: process.env.PAPERCUSP_PGBOUNCER === '1',
  });
}

function buildClient(
  connectionUrl: string,
  searchPath: string[],
  maxOverride?: number,
  label = 'pool',
): Sql {
  const sp = searchPath.map((s) => `"${s.replace(/"/g, '""')}"`).join(', ');
  // The desktop ships embedded-postgres-server (real PG over TCP); the URL
  // carries a normal host:port, so no host override is needed. The legacy
  // pglite unix-socket path was removed 2026-06-01.
  // EI-49: bound how long a pooled connection may sit idle INSIDE an open
  // transaction. A plans:* (or any) MCP WRITE whose transport drops mid-call
  // returns its connection to the pool still BEGIN-open, holding a
  // transaction-scoped advisory lock (pg_advisory_xact_lock; withPlanLock) that
  // only releases on COMMIT/ROLLBACK — wedging the plans subsystem fleet-wide
  // until that exact connection is reused or the process restarts (harness_admin
  // can't pg_terminate_backend a harness_app session, so the only operator-side
  // clear was a :3070 restart). Setting this GUC at connection startup makes
  // Postgres auto-terminate the stuck idle-in-transaction backend, releasing its
  // locks WITHOUT an operator restart. A healthy transaction is never idle
  // (between statements) this long — afterWrite already runs outside the tx
  // (EI-118), and statement execution is bounded by statement_timeout, not this.
  // Seconds; override via PAPERCUSP_DB_IDLE_IN_TX_TIMEOUT. Sent as the GUC's
  // default unit (ms). Falsy/0 → 60 (kept on; this is pure defense-in-depth).
  const idleInTxMs =
    Math.max(0, Number(process.env.PAPERCUSP_DB_IDLE_IN_TX_TIMEOUT) || 60) * 1000;
  return postgres(connectionUrl, {
    onnotice: () => {},
    connection: {
      search_path: sp,
      idle_in_transaction_session_timeout: String(idleInTxMs),
      application_name: pgAppName(label),
    },
    // Skip postgres-js's prepared-statement plan caching. ~80% of the
    // ~1.1s cold-reconnect cost we measured was prepared-statement
    // registration on a fresh connection. Disabling it makes cold
    // reconnects ~300ms instead of ~1100ms. Per-query cost goes up
    // slightly (no plan caching), but our queries are simple SELECTs
    // and the trade is overwhelmingly worth it for polling-heavy dev.
    // Production is unaffected because connections in prod live long
    // enough that the one-time prepare cost amortizes anyway.
    prepare: false,
    // Pool size: explicit override > env var > adaptive default from resource-profile.
    // Adaptive sizing derives from host resources (cores/memory/PG-type): laptop with
    // embedded PG gets a small pool (~4–7 conns), server with native PG gets a larger
    // pool (~52–64). Env override for backward compatibility; explicit maxOverride is
    // used if provided by the caller (currently unused, reserved for future direct-pool
    // configuration). P4-3 of operator-scalability-event-loop-2026-06-16.
    max: Math.max(1, maxOverride ?? resolveOrgPoolMax()),
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
  /**
   * @deprecated since Phase 1 of the Drizzle migration. Equivalent to
   * `.db` but only the 5 hand-written tables are in its schema config.
   * New code should use `.db` to access all 125 introspected tables.
   */
  drizzle: ReturnType<typeof drizzle>;
  /**
   * Drizzle instance bound to the full introspected schema (all 125
   * tables + relation graph). Use this for typed queries:
   *   const { db } = getOrgPg();
   *   await db.select().from(generated.projectsInHarness_shared);
   *   const rows = await db.query.projectsInHarness_shared.findMany();
   */
  db: ReturnType<typeof drizzle<typeof fullSchema>>;
  schema: typeof sharedSchema;
}

/**
 * Typed-result wrapper around a raw postgres-js template tag. Use when
 * you want to keep the raw SQL (search-path tricks, custom CTEs,
 * tsvector ops, NOTIFY) but get back a typed row array:
 *
 *   type Row = { id: string; ts: number };
 *   const rows = await typedSql<Row>(getOrgPg().sql)`
 *     SELECT id, ts FROM audit_log WHERE actor = ${actor}
 *   `;
 *
 * Returns plain arrays (drops postgres-js's Result metadata). Use the
 * raw `.sql\`...\`` template directly if you need that metadata.
 */
export function typedSql<R = Record<string, unknown>>(
  client: Sql,
): (strings: TemplateStringsArray, ...params: unknown[]) => Promise<R[]> {
  return async (strings, ...params) => {
    const rows = await (client as any)(strings, ...params);
    return rows as R[];
  };
}

/**
 * Admin (cross-harness) client. Use for views/aggregations/projects/messages.
 *
 * search_path includes `papercusp_shared` so the Papercup-specific tables
 * (messages, message_recipients, message_comments, directive_summaries) that
 * were extracted into their own schema in Stage 2 of the framework split
 * remain reachable from unqualified queries (e.g. legacy `INSERT INTO messages`).
 */
export function getOrgPg(): OrgPgHandle {
  // Call adminUrl() on every invocation so its discovery-file
  // change detection fires — it invalidates _adminClient internally
  // when the discovery URL has changed. Previously this was only
  // called once at first-client-build, so background workers that
  // booted before the desktop wrote a new embedded-pg.json caught
  // the old port forever (E2E round-13 bug #33).
  const url = maybePgbouncer(adminUrl());
  if (!_adminClient) {
    _adminClient = buildClient(url, ['harness_shared', 'papercusp_shared', 'public'], undefined, 'org-admin');
    _adminDrizzle = drizzle(_adminClient, { schema: sharedTables });
    _adminDb = drizzle(_adminClient, { schema: fullSchema });
  }
  return {
    sql: _adminClient,
    drizzle: _adminDrizzle!,
    db: _adminDb!,
    schema: sharedSchema,
  };
}

let _appOrgClient: Sql | null = null;
let _appOrgDrizzle: ReturnType<typeof drizzle> | null = null;
let _appOrgDb: ReturnType<typeof drizzle<typeof fullSchema>> | null = null;

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
  // Call appUrl() on every invocation — see comment in getOrgPg().
  const url = maybePgbouncer(appUrl());
  if (!_appOrgClient) {
    _appOrgClient = buildClient(url, ['harness_shared', 'papercusp_shared', 'public'], undefined, 'org-app');
    _appOrgDrizzle = drizzle(_appOrgClient, { schema: sharedTables });
    _appOrgDb = drizzle(_appOrgClient, { schema: fullSchema });
  }
  return {
    sql: _appOrgClient,
    drizzle: _appOrgDrizzle!,
    db: _appOrgDb!,
    schema: sharedSchema,
  };
}

/**
 * Per-harness client with search_path scoped to that harness's schema.
 * Unqualified `harness_features` resolves to harness_<slug>.harness_features.
 * Shared tables remain reachable as `projects`, `messages`, etc.
 *
 * `papercusp_shared` is included so org.ts message-bus queries running with a
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
  // PgBouncer-safety (backend-connection-scaling-2026-06-17 C2): the per-harness
  // pools rely on a CONNECT-TIME search_path (`harness_<slug>` first) so unqualified
  // `harness_features` etc. resolve to this harness's schema. Transaction pooling does
  // NOT preserve a connect-time search_path, and the ~18 legacy `getLegacyClient(slug)`
  // / direct `getHarnessPg(slug).sql` call sites issue multi-statement AUTOCOMMIT
  // queries that can't be transparently wrapped. So these pools INTENTIONALLY stay
  // DIRECT (bypass maybePgbouncer) even under PAPERCUSP_PGBOUNCER=1. This is cheap: the
  // harness pools are LRU-capped at HARNESS_POOL_CAP (8) × perHarnessMax (1) per process
  // — NOT the connection bloat (that's the org pools, ~48 each, which DO get pooled).
  // The pooler-safe alternative for new code is `harnessQuery(slug, fn)` (per-tx
  // SET LOCAL search_path on the pooled org-app pool); migrating the legacy sites onto
  // it is the follow-up that lets even these pools route through the pooler.
  const sql = buildClient(appUrl(), [schemaName, 'harness_shared', 'papercusp_shared', 'public'], perHarnessMax, `harness:${slug}`);
  const dz = drizzle(sql, { schema: sharedTables });
  const db = drizzle(sql, { schema: fullSchema });
  const handle: HarnessClient = { sql, drizzle: dz, db, lastUsed: Date.now() };
  _harnessClients.set(slug, handle);
  return handle;
}

/**
 * The worst-case number of PG connections THIS process can open across all its
 * pools. C0-4 of backend-connection-scaling-2026-06-17: the 2026-06-17 outage
 * was a pool-sizing change (each org pool sized to pgPoolMax=52 on a 100-slot DB)
 * shipping without the DB ceiling being raised to match. This makes that math
 * explicit so a boot-time guard can catch the next such regression loudly.
 *
 * `fixedOverhead` covers the admin-pg-cache (ADMIN_PG_CACHE_MAX=8, in
 * packages/operator-core) + the 5 long-lived LISTEN connections (sync-sse,
 * coord-inbox, pending-events, fleet-assignment, agent-activity) — both live in
 * other packages, so they're a documented constant here.
 */
export function processConnectionCeiling(): {
  poolMax: number;
  orgPools: number;
  harnessPools: number;
  fixedOverhead: number;
  total: number;
} {
  const poolMax = resolveOrgPoolMax();
  const orgPools = poolMax * 2; // getOrgPg (admin) + getOrgPgApp (app/RLS)
  const perHarnessMax = Math.max(1, Number(process.env.PAPERCUSP_HARNESS_DB_POOL_MAX) || 1);
  const harnessPools = HARNESS_POOL_CAP * perHarnessMax;
  const fixedOverhead = 8 /* admin-pg-cache */ + 5 /* LISTEN buses */;
  return { poolMax, orgPools, harnessPools, fixedOverhead, total: orgPools + harnessPools + fixedOverhead };
}

/**
 * Log this process's connection ceiling vs the LIVE `max_connections`, warning
 * loudly when the fleet-wide worst case would approach the ceiling. Best-effort
 * (queries PG; silent if unreachable). `expectedProcesses` defaults from
 * PAPERCUSP_EXPECTED_OPERATOR_PROCS (the dev box runs :3070 + :3170 → 2). C0-4.
 */
export async function logConnectionBudget(
  log: (m: string) => void = (m) => console.warn(m),
): Promise<void> {
  const { total, orgPools, harnessPools, fixedOverhead, poolMax } = processConnectionCeiling();
  let liveMax = 0;
  try {
    const rows = (await getOrgPg().sql`SELECT current_setting('max_connections')::int AS m`) as {
      m: number;
    }[];
    liveMax = rows[0]?.m ?? 0;
  } catch {
    // PG unreachable at boot — skip (the diagnostic is non-fatal).
  }
  const expectedProcs = Math.max(1, Number(process.env.PAPERCUSP_EXPECTED_OPERATOR_PROCS) || 2);
  const fleetWorst = total * expectedProcs;
  const head =
    `[pg-budget] pid ${process.pid}: <=${total} conns/process ` +
    `(org ${orgPools} @ poolMax ${poolMax} + harness ${harnessPools} + cache/listeners ${fixedOverhead}); ` +
    `~${fleetWorst} across ${expectedProcs} proc(s)`;
  if (liveMax > 0 && fleetWorst > liveMax * 0.9) {
    log(
      `${head} — DANGER vs live max_connections=${liveMax}. Run \`npx tsx scripts/pg-autotune.ts --apply\` ` +
        `(raise the ceiling to the host), lower PAPERCUSP_DB_POOL_MAX, or front PG with PgBouncer.`,
    );
  } else {
    log(`${head} vs live max_connections=${liveMax || '?'} — ok`);
  }
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
  _adminDb = null;
  if (_appOrgClient) {
    await _appOrgClient.end({ timeout: 1 }).catch(() => {});
  }
  _appOrgClient = null;
  _appOrgDrizzle = null;
  _appOrgDb = null;
  for (const h of _harnessClients.values()) {
    await h.sql.end({ timeout: 1 }).catch(() => {});
  }
  _harnessClients.clear();
}
