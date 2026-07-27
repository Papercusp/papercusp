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
//
// LAZY CREATION (not just lazy USE): calling `createRequire(import.meta.url)` at
// MODULE SCOPE crashes any non-node consumer of this module. The operator SPA
// pulls connection.ts in via the route tree and externalizes `node:module` for the
// browser (→ `createRequire` is undefined), so an EAGER top-level call threw at
// module eval — "createRequire is not a function" — and blanked the ENTIRE desktop
// app on load. Defer the createRequire to first use so importing this module is
// browser-safe; the node-builtin reads below only ever run server-side. (Mirrors
// the same lazy pattern in resource-profile/src/index.ts.)
let _nodeRequire: ReturnType<typeof createRequire> | undefined;
const nodeRequire = (id: string): unknown =>
  (_nodeRequire ??= createRequire(import.meta.url))(id);
import * as generatedSchema from './schema/generated';
import * as generatedRelations from './schema/generated-relations';
// EI-9265 / EI-13076 / EI-18698602043482898: the bigint-as-number type shape
// and the raw Date/jsonb serializer restorers live in `./raw-serializers`
// (deliberately dependency-free of `drizzle-orm`) so test fixtures that must
// avoid pulling in `drizzle-orm/postgres-js` (see
// `packages/operator-core/test/_org-test-db.ts`'s docstring) can import them
// directly. Re-exported here for existing consumers of `./connection` /
// the package barrel.
import {
  PG_BIGINT_AS_NUMBER_TYPES,
  restoreRawDateSerializers,
  restoreRawJsonbSerializer,
} from './raw-serializers';
export { PG_BIGINT_AS_NUMBER_TYPES, restoreRawDateSerializers, restoreRawJsonbSerializer };

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
//   1. Explicit env (HARNESS_DATABASE_URL / HARNESS_ADMIN_DATABASE_URL,
//      then DATABASE_URL as an endpoint pin — admin DSN as-is, app role
//      re-keyed onto its host:port). Set by Tauri main when spawning the
//      desktop sidecar, and by every managed host's systemd unit — that
//      path always wins.
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
export type DiscoveryEndpoint = { user?: string; password?: string; host?: string; port?: number };

/** Is `pid` still running? Injected into _parseDiscoveryJson so tests stay pure. */
export function _defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM ⇒ the process exists, we just don't own it. Anything else ⇒ gone.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Parse the embedded-pg discovery file's JSON into a connection endpoint.
 *
 * The WRITER (apps/operator/bin/serve.ts) records `{ url, port, pid, startedAt }`
 * — it has never written a `host` key. This used to gate on `parsed.host && parsed.port`,
 * which made step 2 of the resolution chain above DEAD CODE: every env-less caller fell
 * silently through to the native fallback. That is not a harmless miss —
 *   • on a dev box that also runs the desktop it selects the WRONG DATABASE (native :5432
 *     instead of the desktop's embedded PG) with no error, and
 *   • on a packaged install, which has no :5432 at all, it is ECONNREFUSED.
 * The second is how it was caught: ~200 "unit" suites reddened on a packaged install
 * (they open a pool transitively via app code) while passing on every box with a stray
 * native :5432. So parse the `url` the writer actually emits — the same field
 * libs/host-platform/src/desktop.ts already reads — and keep the legacy `{host,port}`
 * shape working for any older file still on disk.
 *
 * Exported for tests: pure apart from the injected liveness probe, so the shape
 * contract is pinned directly.
 */
export function _parseDiscoveryJson(
  raw: string,
  isPidAlive: (pid: number) => boolean = _defaultIsPidAlive,
): DiscoveryEndpoint | null {
  let parsed: { url?: string; host?: string; port?: number; user?: string; password?: string; pid?: number };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // STALE-FILE GUARD. serve.ts writes this file but never unlinks it (there is no
  // unlink of EMBEDDED_PG_JSON anywhere in serve.ts, despite the chain comment above
  // claiming it is "deleted on shutdown"). Now that discovery actually resolves, a
  // leftover file from a stopped desktop would point every env-less caller at a DEAD
  // port — strictly worse than the native fallback it replaced. The file records the
  // writer's pid, so ignore it once that process is gone. Files with no pid (older
  // desktops) are trusted as before.
  if (typeof parsed?.pid === 'number' && !isPidAlive(parsed.pid)) return null;
  if (parsed?.url) {
    try {
      const u = new URL(parsed.url);
      const port = Number(u.port) || Number(parsed.port);
      if (u.hostname && port) {
        return {
          host: u.hostname,
          port,
          // Embedded-pg uses fixed passwords; callers default them when absent.
          user: u.username ? decodeURIComponent(u.username) : undefined,
          password: u.password ? decodeURIComponent(u.password) : undefined,
        };
      }
    } catch {
      // unparseable url — fall through to the legacy {host,port} shape
    }
  }
  if (parsed?.port && parsed?.host) return parsed;
  return null;
}

function readDiscoveryFile(): DiscoveryEndpoint | null {
  if (process.env.PAPERCUSP_SKIP_PG_DISCOVERY === '1') return null;
  try {
    // Lazy require so this module can be imported in environments
    // without `node:fs` (browser, edge runtime). The drizzle/postgres
    // path is server-only in practice but be defensive.
    const fs = nodeRequire('node:fs') as typeof import('node:fs');
    const os = nodeRequire('node:os') as typeof import('node:os');
    // EI-13917: honor PAPERCUSP_HOME (the established isolation escape hatch —
    // packages/operator-core/lib/papercusp-root.ts) before the box-wide
    // `~/.papercusp`, mirroring the matching writer-side fix in
    // apps/operator/bin/serve.ts. A caller that scoped its OWN PAPERCUSP_HOME
    // (an isolated gate/smoke-test instance) should discover ITS OWN
    // embedded-pg.json, never accidentally pick up the box-canonical one.
    const papercuspDir = process.env.PAPERCUSP_HOME || `${os.homedir()}/.papercusp`;
    const path = `${papercuspDir}/embedded-pg.json`;
    return _parseDiscoveryJson(fs.readFileSync(path, 'utf8'));
  } catch {
    // missing / unreadable — fall through to native fallback
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
  // DATABASE_URL pins the ENDPOINT (host:port/db) but carries admin creds; keep
  // the app role by re-keying it with the fixed harness_app convention creds.
  // WI-5244 class: every managed host (systemd units, deploy) sets DATABASE_URL
  // but not HARNESS_DATABASE_URL — without this rung they fell through to the
  // discovery file, which ANY local desktop/server install can rewrite; a
  // packaged Papercusp Server did exactly that (08:29Z 2026-07-17) and pointed
  // the shared bg-host's pools at its empty embedded PG (routines engine read
  // "0 active routines" → box-wide git-sync/kettle/scout stall).
  if (process.env.DATABASE_URL) {
    try {
      const u = new URL(process.env.DATABASE_URL);
      _resolvedAppUrl = `postgresql://harness_app:harness_app_pwd@${u.hostname}:${u.port || 5432}${u.pathname || '/papercusp'}`;
      _resolvedAppUrlSource = 'env';
      return _resolvedAppUrl;
    } catch {
      // unparseable DATABASE_URL — fall through to discovery
    }
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
  // EMBEDDED-PG PORT HONORING: the embedded PG the sidecar/desktop launches is advertised via
  // PAPERCUSP_PG_PORT (serve.mjs sets it after starting pg). The native fallback is reached BEFORE
  // the discovery file / HARNESS_DATABASE_URL is ready, so it MUST use that port — hardcoding 5432
  // made an EARLY getOrgPg caller (e.g. the home=<none> owner-bootstrap-admit) connect to a
  // nonexistent :5432 on a fresh VM → unhandled pool error → sidecar crash. Falls back to 5432
  // only when PAPERCUSP_PG_PORT is unset (a real native-PG-on-5432 host).
  return `postgresql://harness_app:harness_app_pwd@localhost:${Number(process.env.PAPERCUSP_PG_PORT) || 5432}/papercusp`;
}
function adminUrl(): string {
  // Env is stable for process lifetime → safe to cache.
  if (_resolvedAdminUrl && _resolvedAdminUrlSource === 'env') return _resolvedAdminUrl;
  if (process.env.HARNESS_ADMIN_DATABASE_URL) {
    _resolvedAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
    _resolvedAdminUrlSource = 'env';
    return _resolvedAdminUrl;
  }
  // DATABASE_URL is the admin DSN on every managed host (systemd units, deploy
  // env) — it must beat the discovery file, which any local desktop/server
  // install can rewrite (WI-5244 class; see appUrl above for the incident).
  if (process.env.DATABASE_URL) {
    _resolvedAdminUrl = process.env.DATABASE_URL;
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
      // Mirror the invalidation for the lossless-bigint pool (EI-18789855771421275)
      // — otherwise it keeps serving the stale target after a discovery-file change.
      if (_adminLosslessBigintClient) {
        try { _adminLosslessBigintClient.end({ timeout: 1 }).catch(() => {}); } catch {}
        _adminLosslessBigintClient = null;
      }
    }
    return _resolvedAdminUrl;
  }
  // EMBEDDED-PG PORT HONORING — see appUrl() native fallback above (same sidecar release fix):
  // honor PAPERCUSP_PG_PORT (the embedded PG's advertised port) so an early getOrgPg caller
  // before the discovery file/env is ready connects to the real embedded PG, not a nonexistent
  // :5432 (which crashed the sidecar on any host without a stray 5432 PG).
  return `postgresql://harness_admin:harness_admin_pwd@localhost:${Number(process.env.PAPERCUSP_PG_PORT) || 5432}/papercusp`;
}
/** Test-only — clears cached URLs so a test that mutates env between cases sees the change. */
export function _resetUrlCacheForTests(): void {
  _resolvedAppUrl = null;
  _resolvedAdminUrl = null;
}

/** Test-only — resolve the app/admin URLs through the live chain (env → discovery → fallback). */
export function _resolveUrlsForTests(): { app: string; admin: string } {
  return { app: appUrl(), admin: adminUrl() };
}

/**
 * The SINGLE predicate that decides whether org pools route through PgBouncer
 * (transaction pooling). EVERY PgBouncer-conditional site must consult this —
 * `maybePgbouncer` + `resolveOrgPoolMax` here, and `withWorkspace` + `harnessQuery`
 * in workspace-context.ts — so they can NEVER disagree. A split (URL routes through
 * the pooler but the per-tx `SET LOCAL search_path` doesn't fire) would silently
 * break search_path resolution under pooling.
 *
 * P-004 of backend-connection-scaling-2026-06-17 — DEFAULT-ON, not a dark flag
 * ("finished work must not ship dark"):
 *   - `PAPERCUSP_PGBOUNCER=1` → force ON  (explicit override)
 *   - `PAPERCUSP_PGBOUNCER=0` → force OFF (kill-switch — instant, fleet-wide revert)
 *   - unset → derive: ON for a SERVER-class host (the dev box + any dedicated /
 *     native-PG production server), OFF for laptop/workstation — which is every
 *     Tauri DESKTOP (embedded PG: no pooler runs there, so routing to :6432 would
 *     break it). hostClass is the robust discriminator: a real embedded desktop is
 *     laptop/workstation-class, never `server`.
 *
 * NB: we deliberately gate on physical-core-derived machine class, NOT
 * `getResourceProfile().hostClass` — `hostClass` is intentionally derived from
 * `ResourceSignals.cores` (`os.availableParallelism()`, cgroup-CPU-quota-aware:
 * see its doc comment — "how much work can I, THIS PROCESS, actually do at
 * once"), which is exactly right for agent/queue/pool-size caps but the WRONG
 * signal for "is the underlying Postgres a shared native instance worth
 * pooling" — that is a property of the MACHINE Postgres runs on, not of
 * whichever one CPU-quota-limited client process happens to be asking. This is
 * the identical confusion `deriveDatabaseTuning` was fixed for under WI-5456 (a
 * 16-core-quota bg-host on a 128-core box derived a fictional `max_connections`
 * from its own quota) — `physicalCores` (`os.cpus().length`, NOT quota-aware)
 * exists precisely so machine-property decisions can bypass a process's own
 * quota. bug-drain-200k (2026-07-21): confirmed live on THIS box —
 * `papercup-bg-host.service` carries `CPUQuota=1600%` (16 cores), so
 * `hostClass` read `'workstation'` for it despite the box being a genuine
 * 128-core / 512-max_connections server, and it opened dozens of DIRECT
 * connections instead of routing through :6432 — a real contributor to the
 * PG-connection-saturation regression (EI-18217560711347466). Also deliberately
 * NOT `embeddedPg` — `detectEmbeddedPg()` reports `embeddedPg=true` for ANY host
 * that sets an explicit DATABASE_URL, so it misfires on the dev box / a
 * dedicated server pointing at native PG via env (verified live: dev box
 * reports embeddedPg=true). That detection flaw is tracked separately;
 * physical-core class sidesteps it here, same as hostClass did.
 */
export function pgbouncerEnabled(): boolean {
  const flag = process.env.PAPERCUSP_PGBOUNCER;
  if (flag === '1') return true;
  if (flag === '0') return false;
  // An explicit PAPERCUSP_PG_PORT means THIS process owns its own dedicated,
  // isolated embedded Postgres (smoke-test witnesses, desktop sidecars,
  // Hetzner rig instances) — never the box's shared native PG. The real
  // dev/staging operators on a 'server'-class host NEVER set this (they attach
  // to the shared native PG via HARNESS_ADMIN_DATABASE_URL / DATABASE_URL /
  // the discovery file), so this is a safe, exclusive signal. Rerouting such a
  // process's org pool through the box-wide PgBouncer (which fronts the
  // SHARED native PG — see /etc/pgbouncer/pgbouncer.ini) would silently
  // connect it to a totally different, already-populated database instead of
  // its own freshly-booted empty one, defeating per-process isolation
  // entirely (WI-1666: a "fresh, isolated" hive-from-repo smoke witness read
  // pre-existing shared_repo_binding_cache rows because getOrgPg() routed
  // through :6432 → the box's real native PG, bypassing the witness's own
  // empty embedded PG bound to its explicit PAPERCUSP_PG_PORT). Confirmed live
  // on the shared dev box 2026-07-02: the witness's own embedded PG (port
  // 19532) had 0 matching rows; the box's native PG (port 5432, what :6432
  // pools to) had the exact "existing" rows the bug reported.
  if (process.env.PAPERCUSP_PG_PORT) return false;
  try {
    const { signals } = getResourceProfile();
    const machineCores = Math.floor(signals.physicalCores ?? signals.cores);
    return Number.isFinite(machineCores) && machineCores > 16;
  } catch {
    return false; // resource-profile unreadable → safe default (direct)
  }
}

/** The box's own native-PG default (NATIVE_FALLBACK in embedded-pg-discovery.ts) —
 *  the ONLY thing the local PgBouncer instance fronts. See {@link maybePgbouncer}. */
const NATIVE_PG_HOSTS = new Set(['localhost', '127.0.0.1']);
const NATIVE_PG_PORT = '5432';

/**
 * When {@link pgbouncerEnabled}, route an org pool URL through the local PgBouncer
 * (transaction pooling) on `PAPERCUSP_PGBOUNCER_PORT` (default 6432) — C2 of
 * backend-connection-scaling-2026-06-17. This is what lets thousands of concurrent
 * agent tool-calls multiplex onto a bounded set of PG backends.
 *
 * Correct under pooling because the connect-time `search_path` (NOT preserved by
 * transaction pooling) is re-applied per-transaction by withWorkspace/harnessQuery
 * (C1-2, landed). Listeners (sync-sse, *-bus) + the watchdog tick lock use
 * `getHarnessAdminUrl()` and are intentionally NOT rerouted — LISTEN and
 * session-level advisory locks are session-bound and MUST bypass a transaction
 * pooler (C2-2 / P-001). Per-harness `getHarnessPg` pools also stay DIRECT (D-005).
 *
 * EI-2437: only reroute when the incoming URL ALREADY targets the box's own
 * native-PG default (localhost/127.0.0.1:5432 — NATIVE_FALLBACK). The local
 * PgBouncer instance fronts THAT native instance and nothing else, so a URL that
 * already points somewhere else — a testcontainer's random ephemeral port
 * (integration tests env-routing `HARNESS_ADMIN_DATABASE_URL` at a throwaway DB),
 * a future remote/managed PG — is an EXPLICIT override the caller made on
 * purpose. Rerouting it anyway would silently connect through the pooler to the
 * SHARED native PG instead, which either 404s ("no such database: org_<rand>",
 * confusing because the DB genuinely exists — just not on :5432) or, worse,
 * silently reads/writes a totally different, already-populated database (the
 * same class of bug WI-1666 fixed one layer up in {@link pgbouncerEnabled} for
 * the `PAPERCUSP_PG_PORT`-isolated-process case). This closes the class fully:
 * WI-1666 stopped an isolated PROCESS from being rerouted; this stops an
 * isolated URL (set without the process-wide `PAPERCUSP_PG_PORT` signal, e.g. a
 * single test's env-routing block) from being rerouted too — no per-test
 * `PAPERCUSP_PGBOUNCER=0` opt-out needed anymore.
 */
export function maybePgbouncer(url: string): string {
  if (!pgbouncerEnabled()) return url;
  try {
    const u = new URL(url);
    const port = u.port || NATIVE_PG_PORT; // an omitted port means Postgres's own default (5432)
    if (!NATIVE_PG_HOSTS.has(u.hostname) || port !== NATIVE_PG_PORT) return url;
    const poolerPort = Number(process.env.PAPERCUSP_PGBOUNCER_PORT) || 6432;
    u.host = `127.0.0.1:${poolerPort}`;
    return u.toString();
  } catch {
    return url; // unparseable — leave the direct URL untouched
  }
}

let _adminClient: Sql | null = null;
let _adminDrizzle: ReturnType<typeof drizzle> | null = null;
let _adminDb: ReturnType<typeof drizzle<typeof fullSchema>> | null = null;
// EI-18789855771421275: a SEPARATE, small, dedicated pool for callers that must
// see exact bigint (int8) values — see getOrgPgLosslessBigint() below.
let _adminLosslessBigintClient: Sql | null = null;
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
 * Reusable startup-options fragment for hand-rolled LONG-LIVED `postgres(url, {...})`
 * pools/singletons OUTSIDE the canonical getOrgPg()/getHarnessPg()/getOrgPgApp()
 * clients — a dedicated LISTEN bus, a singleton background poller, a shared utility
 * pool, etc. (EI-18122461766429683: root-caused a server-wide PG connection
 * saturation crit — 87+ idle, permanently-unattributed `application_name:'postgres.js'`
 * connections had accumulated across the su-lock pools and ~9 operator-core singleton
 * pools/listeners that each hand-roll their own `postgres(...)` call instead of going
 * through `buildClient()`. Every one of those was missing BOTH fixes below.)
 *
 * 1. Tags the connection with a `pcusp:<label>:p<pid>` application_name (pgAppName)
 *    so it is attributable in `pg_stat_activity` / `dev:pg_health` — the ALTER-DATABASE
 *    default some pools relied on for this (e.g. su-lock's `papercusp_su` database)
 *    does NOT work: postgres-js always sends its own `application_name: 'postgres.js'`
 *    startup parameter, which overrides a database-level SET default.
 * 2. Applies the SAME dead-client zombie-detection GUCs `buildClient()` applies
 *    (WI-3816's `client_connection_check_interval` + tightened TCP keepalives): a
 *    long-lived pool's OWNING PROCESS can die (crash, restart, `dev:restart`, an
 *    abrupt kill without a clean `.end()`) without the TCP FIN reliably reaching
 *    Postgres, leaving its backend connection idle FOREVER — nothing server-side
 *    reaps it, since the client-side `idle_timeout` option only runs while the
 *    (now-dead) client process is alive to execute it. `client_connection_check_interval`
 *    makes the BACKEND itself detect the dead socket and abort, independent of the
 *    client's survival.
 *
 * Only startup params — safe to add unconditionally here because every caller of
 * this helper connects DIRECT (via `getHarnessAdminUrl()`/`adminUrl()`, never through
 * `maybePgbouncer()`), so there is no transaction-pooler in front to reject them (see
 * `buildConnectionOptions`'s `pooled` branch for the case where that DOES matter).
 *
 * Usage: `postgres(url, { ...longLivedPoolConnectionOptions('coord-inbox-bus'), max: 1 })`
 * — spread FIRST so a call site's own `onnotice`/`connection` overrides still win if it
 * has a reason to.
 */
export function longLivedPoolConnectionOptions(label: string): {
  onnotice: () => void;
  connection: Record<string, string>;
} {
  return {
    onnotice: () => {},
    connection: {
      application_name: pgAppName(label),
      client_connection_check_interval: '30000',
      tcp_keepalives_idle: '30',
      tcp_keepalives_interval: '10',
      tcp_keepalives_count: '3',
    },
  };
}

/**
 * Seconds a POOLED connection may sit idle before postgres-js closes it.
 *
 * ⚠ postgres-js defaults `idle_timeout` to **0 = never close**. That default is the
 * single root cause of the fleet-wide connection saturation this exists to bound:
 * `buildClient()` has always set 30s (so org pools self-drain — measured live at
 * max_idle 29s), but the ~13 hand-rolled `postgres(...)` pools that bypass
 * `buildClient` and only spread {@link longLivedPoolConnectionOptions} inherited the
 * 0 default and held their backends OPEN FOREVER. Live 2026-07-26: 294 idle vs 3
 * active connections, 343/512 of `max_connections`.
 *
 * Why an idle timeout is the DURABLE bound (and per-process `max` tuning is not):
 * the number of node processes on this box is unbounded and grows with the fleet, so
 * any cap derived from an expected process count (`PAPERCUSP_EXPECTED_OPERATOR_PROCS`)
 * drifts the moment the fleet scales. An idle timeout instead makes total backends
 * proportional to CONCURRENT ACTIVITY, which is genuinely bounded by real work.
 *
 * 🚫 NOT for LISTEN pools. A `LISTEN` connection is idle BY DESIGN — it holds a
 * subscription and does nothing between notifications — so applying this to one closes
 * the subscription and silently breaks notification delivery. Those pools must declare
 * `idle_timeout: 0` explicitly (see the `pool-idle-timeout-declared` guard test, which
 * fails the build if any pool site leaves the choice implicit).
 *
 * Shares `PAPERCUSP_DB_IDLE_TIMEOUT` with `buildClient` so the two can never drift.
 */
export function poolIdleTimeoutSec(): number {
  return Math.max(0, Number(process.env.PAPERCUSP_DB_IDLE_TIMEOUT) || 30);
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
  // WI-5456: `profile.database.maxConnections` is derived from `physicalCores` (the
  // real machine), NOT the cgroup-quota-scoped `cores` every other cap here uses —
  // see ResourceSignals.physicalCores. Before that fix, a CPU-quota-limited systemd
  // unit (e.g. papercup-bg-host.service's CPUQuota=1600% on a 128-core box) derived
  // maxConnections from its OWN ~16-core quota (clamp(16*4,100,1000)=100) instead of
  // the live server's real max_connections (512), which starved this budget math to
  // its poolMax=1 floor — collapsing the ENTIRE process's getOrgPg() traffic onto one
  // connection and turning any single ≥2-3s query into a critical routines-tick pool
  // shed (371 shed events observed, every 30-90s). Fixing the ceiling upstream (not
  // here) keeps this call a one-liner and fixes every other maxConnections consumer
  // (pg-autotune, embedded-pg boot flags) the same way.
  return boundedOrgPoolMax({
    desired,
    maxConnections: profile.database.maxConnections,
    superuserReserved: profile.database.superuserReservedConnections,
    expectedProcesses: Math.max(1, Number(process.env.PAPERCUSP_EXPECTED_OPERATOR_PROCS) || 2),
    behindPooler: pgbouncerEnabled(),
  });
}

// WI-832 — DI seam for a DEFAULT statement_timeout on the org pools. This low-level
// db lib must NOT read operator-core runtime config (layering); instead the boot path
// INJECTS a provider (mirrors how the locks host injects getTxnTimeouts). Default
// `() => 0` ⇒ NO statement_timeout GUC is emitted ⇒ byte-identical to today (the admin
// pool stays deliberately unbounded — migrations share it). When the operator wires a
// non-zero value (behind papercusp-txn-timeouts-config, owner-gated live flip), every
// NEW pooled connection gets that per-statement cap, bounding the whole interactive-
// write class at the source. The migration runner OPTS OUT per-txn (SET LOCAL
// statement_timeout = 0), so a non-zero default can never kill a long migration.
let _adminStatementTimeoutMsProvider: () => number = () => 0;
export function setAdminPoolStatementTimeoutProvider(fn: () => number): void {
  _adminStatementTimeoutMsProvider = typeof fn === 'function' ? fn : () => 0;
}
/** The currently-configured default statement_timeout (ms) for new org connections;
 *  0 / falsy / negative ⇒ unset (no GUC). Read at connection-construction time. */
function adminStatementTimeoutMs(): number {
  let v = 0;
  try {
    v = Math.trunc(_adminStatementTimeoutMsProvider() || 0);
  } catch {
    v = 0; // a throwing provider must never break connection construction.
  }
  return v > 0 ? v : 0;
}

/**
 * Pure builder for the postgres-js `connection` STARTUP-options block — extracted +
 * exported so the PgBouncer-safety invariant is unit-testable without a live DB.
 *
 * `idle_in_transaction_session_timeout` + `statement_timeout` are libpq STARTUP
 * parameters. A transaction pooler (PgBouncer) REJECTS unknown startup parameters
 * (`unsupported startup parameter: <name>`) unless they're in `ignore_startup_parameters`,
 * AND a connect-time GUC does not survive transaction pooling anyway (each transaction may
 * land on a different server backend). So when `pooled`, we OMIT both — under pooling the
 * real enforcement is per-TRANSACTION `SET LOCAL` (withWorkspace / harnessQuery /
 * in-workspace-txn re-apply statement_timeout + search_path per tx) and PgBouncer's own
 * `idle_transaction_timeout` covers the EI-49 idle-in-tx guard. A DIRECT connection keeps
 * both (no pooler to reject them; the GUCs persist on the long-lived session).
 * `search_path` + `application_name` are always sent: application_name is a standard
 * allowed startup param, and search_path is already in the pooler's
 * `ignore_startup_parameters` (re-applied per-tx under pooling).
 *
 * Fixes `unsupported startup parameter: statement_timeout` on pooled plans:* (org-pool)
 * writes — a fleet-wide intermittent failure once PgBouncer is in front of the org pools.
 */
export function buildConnectionOptions(opts: {
  searchPath: string;
  applicationName: string;
  idleInTxMs: number;
  stmtTimeoutMs: number;
  pooled: boolean;
  /** WI-3816: ms between the backend polling its socket for a dead/gone client
   *  (0 ⇒ the GUC's own off-default). Same PgBouncer-safety class as the two
   *  timeouts above — omitted when pooled. */
  clientConnCheckMs?: number;
}): Record<string, string> {
  const c: Record<string, string> = {
    search_path: opts.searchPath,
    application_name: opts.applicationName,
  };
  if (!opts.pooled) {
    c.idle_in_transaction_session_timeout = String(opts.idleInTxMs);
    if (opts.stmtTimeoutMs > 0) c.statement_timeout = String(opts.stmtTimeoutMs);
    // WI-3816: the 2026-07-10 ClientWrite-zombie incident — a backend whose query
    // completed but whose CLIENT is gone/not-reading survives pg_cancel_backend
    // and holds its pool slot until an operator manually pg_terminate_backend's
    // it (4h fleet-wide MCP-timeout outage, root cause of WI-3792's aftermath).
    // client_connection_check_interval makes the backend itself notice the dead
    // socket and abort — defaults to 0 (off) on every PG install, embedded or
    // native, so this must be set explicitly; no config-file edit needed since
    // it is a PGC_USERSET GUC (settable as a libpq startup param, same class as
    // the two timeouts above). Also tighten the OS-level TCP keepalive probe
    // (PG's own 2h default is far too slow to matter here) so a network-level
    // dead peer (not just an app-level unresponsive one) is caught quickly too.
    if (opts.clientConnCheckMs && opts.clientConnCheckMs > 0) {
      c.client_connection_check_interval = String(opts.clientConnCheckMs);
      c.tcp_keepalives_idle = '30';
      c.tcp_keepalives_interval = '10';
      c.tcp_keepalives_count = '3';
    }
  }
  return c;
}

function buildClient(
  connectionUrl: string,
  searchPath: string[],
  maxOverride?: number,
  label = 'pool',
  pooled = false,
  // EI-18789855771421275: override the bigint (oid 20) type parser. Defaults to
  // PG_BIGINT_AS_NUMBER_TYPES (every existing caller's byte-identical behavior);
  // pass `{}` for a client that must NOT silently round a bigint outside
  // Number's safe range — see getOrgPgLosslessBigint().
  typesOverride: Record<string, unknown> = PG_BIGINT_AS_NUMBER_TYPES,
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
  // WI-832: configured default per-statement cap (0 ⇒ unset; see the seam above).
  const stmtTimeoutMs = adminStatementTimeoutMs();
  // WI-3816: dead-client detection interval (seconds ⇒ ms; PG's own GUC unit is ms).
  // Default 30s: frequent enough to catch a ClientWrite zombie well before it can
  // exhaust a pool, cheap enough (one extra poll/30s per idle backend) to leave on
  // everywhere. 0 disables (kept as an escape hatch, not because 0 is ever a good
  // default). Override via PAPERCUSP_DB_CLIENT_CHECK_INTERVAL (seconds).
  const clientConnCheckMs =
    Math.max(0, Number(process.env.PAPERCUSP_DB_CLIENT_CHECK_INTERVAL) || 30) * 1000;
  // EI-2582: bound the connect attempt UNDER TEST so an unmocked PG access in a
  // unit test fails fast (~5s, with a clear connection error) instead of silently
  // hanging until the 60s vitest timeout — which reads as a "slow test", not the
  // real cause (a new PG-touching step added to a flow like harness:create without
  // a per-test `vi.doMock`). Unit tests must mock the db layer (or live in a
  // *.integration.test.ts against a real DB); a healthy integration DB connects in
  // well under 5s, so this never trips a real connection. Left UNSET outside tests
  // to preserve the embedded-pg boot-race tolerance — a background worker may
  // legitimately wait for embedded PG to finish coming up before its first connect.
  // Override (any env) via PAPERCUSP_DB_CONNECT_TIMEOUT (seconds; 0 disables).
  const connectTimeoutSec =
    Number(process.env.PAPERCUSP_DB_CONNECT_TIMEOUT) ||
    (process.env.VITEST ? 5 : 0);
  const client = postgres(connectionUrl, {
    onnotice: () => {},
    ...(connectTimeoutSec > 0 ? { connect_timeout: connectTimeoutSec } : {}),
    // PgBouncer-safe startup options. Under transaction pooling the statement_timeout +
    // idle_in_transaction_session_timeout GUCs are NOT sent at startup (the pooler rejects
    // them as "unsupported startup parameter", and a connect-time GUC doesn't survive a
    // transaction pool); they're enforced per-tx via SET LOCAL instead. WI-832's
    // statement_timeout therefore stays a per-tx cap under pooling. See buildConnectionOptions.
    connection: buildConnectionOptions({
      searchPath: sp,
      applicationName: pgAppName(label),
      idleInTxMs,
      stmtTimeoutMs,
      pooled,
      clientConnCheckMs,
    }),
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
    idle_timeout: poolIdleTimeoutSec(),
    // BIGINT → number. Our timestamps and attempt counts fit safely in Number's
    // 2^53 range; expected_cost_cents won't realistically exceed it. Override
    // case-by-case if a column ever needs full BIGINT precision. Shared
    // constant (EI-9265) so hand-rolled test/script clients can mirror this
    // exactly instead of silently drifting — see PG_BIGINT_AS_NUMBER_TYPES.
    // Callers needing exact bigint precision (no silent >2^53 rounding) pass
    // `typesOverride: {}` — see getOrgPgLosslessBigint (EI-18789855771421275).
    types: typesOverride,
  });
  // EI-13076: pre-arm the date-OID serializers as sticky accessors BEFORE any
  // drizzle() wrap can replace them with transparent passthroughs — see
  // restoreRawDateSerializers. Without this, a raw `sql` Date param on this
  // shared client throws (Buffer.byteLength(Date)) after the first drizzle
  // wrap — including runtime `drizzle(tx)` calls that share this options object.
  restoreRawDateSerializers(client);
  // EI-18698602043482898: same fix for the jsonb/json OIDs — see
  // restoreRawJsonbSerializer. Without this, whichever of `sql.json(v)` /
  // `${JSON.stringify(v)}::jsonb` doesn't match drizzle's mutated state
  // silently double-encodes (or throws).
  restoreRawJsonbSerializer(client);
  return client;
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
 * WI-5244 class (2): a discovery-file target is a SPOOFABLE trust point — ANY
 * local install can rewrite ~/.papercusp/embedded-pg.json (a packaged Papercusp
 * Server did exactly that on 2026-07-17 08:29Z and pointed the shared bg-host's
 * pools at its own empty, partial-schema `papercusp` DB; nothing alarmed, so the
 * drift surfaced ~40 minutes later as a confusing mid-gate `column … does not
 * exist` failure). Env-pinned URLs (DATABASE_URL / HARNESS_*_DATABASE_URL — i.e.
 * every managed host: systemd units, deploy) are inherently trusted and are NOT
 * re-validated here; this covers ONLY the specifically spoofable discovery-file
 * path, firing once per newly-built pool. Fire-and-forget + fail-soft by design:
 * a validation-query failure (including the DB being briefly unreachable) must
 * never affect the real pool or block/throw on the caller.
 */
function validateDiscoveryTargetOnce(sql: Sql, label: string): void {
  void sql<Array<{ t: string | null }>>`SELECT to_regclass('harness_shared.schema_migrations')::text AS t`
    .then((rows) => {
      if (!rows[0]?.t) {
        console.error(
          `[connection] WI-5244: the ${label} pool resolved via the discovery file ` +
            `(~/.papercusp/embedded-pg.json) but harness_shared.schema_migrations does not ` +
            `exist at that target — this looks like an IMPOSTOR/mismatched papercusp DB, ` +
            `not the real managed database. Check ~/.papercusp/embedded-pg.json for a recent ` +
            `rewrite by another local install (see WI-5244).`,
        );
      }
    })
    .catch(() => {
      // fail-soft — never let a validation-query error affect the real pool
    });
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
    // pooled = pgbouncerEnabled(): the url above is maybePgbouncer(adminUrl()), which only
    // reroutes to the pooler when enabled — so the connection is pooled iff that's true.
    _adminClient = buildClient(url, ['harness_shared', 'papercusp_shared', 'public'], undefined, 'org-admin', pgbouncerEnabled());
    _adminDrizzle = drizzle(_adminClient, { schema: sharedTables });
    _adminDb = drizzle(_adminClient, { schema: fullSchema });
    // WI-5244(2): only the discovery-file source is spoofable — env-pinned managed
    // hosts are already trusted, so skip the check there (cheap, but not free).
    if (_resolvedAdminUrlSource === 'discovery') validateDiscoveryTargetOnce(_adminClient, 'admin');
  }
  return {
    sql: _adminClient,
    drizzle: _adminDrizzle!,
    db: _adminDb!,
    schema: sharedSchema,
  };
}

/**
 * Admin client WITHOUT the bigint→number override (EI-18789855771421275).
 *
 * `getOrgPg()` deliberately converts int8/bigserial (oid 20) to a JS `number`
 * for convenience (EI-9265) — correct for the columns callers actually rely on
 * (which fit safely under 2^53), but WRONG for arbitrary agent-supplied SQL: a
 * `pg_stat_statements.queryid`, a snowflake work-item id, or any other genuine
 * 64-bit value beyond `Number.MAX_SAFE_INTEGER` gets silently ROUNDED — and the
 * rounded value is a syntactically valid bigint that just matches ZERO rows,
 * which reads as a legitimate empty result, not an error (see the EI for the
 * full incident: an agent nearly recorded a false "already fixed, zero calls"
 * verdict because of this).
 *
 * Use for ANY surface that runs ad-hoc/agent-authored SQL and returns bigint
 * columns verbatim (currently: `pgReadQuery` / `dev:pg_query`) — NOT for
 * application code with known-safe numeric columns, which should keep using
 * `getOrgPg()`/`getOrgPgApp()` so existing `typeof x === 'number'` assumptions
 * (WI-3880) keep holding. Deliberately a SEPARATE, small (`max: 2`), dedicated
 * pool rather than mutating the shared admin client's parser: postgres-js's
 * `options.parsers` map is one shared object across every concurrent query on
 * that client, so a per-call override would race every OTHER concurrent
 * `getOrgPg()` caller on this heavily-parallel box.
 *
 * With no override, postgres-js's OWN default oid-20 parser applies — an int8
 * column comes back as an exact-precision JS STRING (the same reason
 * node-postgres does this by default too). Reflected in `processConnectionCeiling`'s
 * `fixedOverhead` (+2) so the connection-budget guard stays honest about this pool.
 */
export function getOrgPgLosslessBigint(): { sql: Sql } {
  const url = maybePgbouncer(adminUrl());
  if (!_adminLosslessBigintClient) {
    _adminLosslessBigintClient = buildClient(
      url,
      ['harness_shared', 'papercusp_shared', 'public'],
      2,
      'org-admin-lossless-bigint',
      pgbouncerEnabled(),
      {}, // no bigint override — postgres-js's own default (exact string) applies
    );
  }
  return { sql: _adminLosslessBigintClient };
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
    // pooled = pgbouncerEnabled() (url = maybePgbouncer(appUrl())) — see getOrgPg().
    _appOrgClient = buildClient(url, ['harness_shared', 'papercusp_shared', 'public'], undefined, 'org-app', pgbouncerEnabled());
    _appOrgDrizzle = drizzle(_appOrgClient, { schema: sharedTables });
    _appOrgDb = drizzle(_appOrgClient, { schema: fullSchema });
    // WI-5244(2) — see the matching check in getOrgPg() above.
    if (_resolvedAppUrlSource === 'discovery') validateDiscoveryTargetOnce(_appOrgClient, 'app');
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
 * other packages, so they're a documented constant here — + the small (max 2)
 * dedicated `getOrgPgLosslessBigint()` pool (EI-18789855771421275).
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
  const fixedOverhead = 8 /* admin-pg-cache */ + 5 /* LISTEN buses */ + 2 /* org-admin-lossless-bigint pool */;
  return { poolMax, orgPools, harnessPools, fixedOverhead, total: orgPools + harnessPools + fixedOverhead };
}

/**
 * Pure verdict for {@link logConnectionBudget} (EI-3379 — unit-testable, no DB). The
 * worst-case PG-BACKEND pressure this process group contributes vs the live
 * max_connections.
 *
 * Under a transaction pooler the org pools are pgbouncer CLIENT slots, NOT PG backends
 * — pgbouncer bounds real backends at default_pool_size regardless of process count —
 * so they do NOT multiply the per-process backend ceiling. Only the DIRECT pools open
 * backends that scale with process count: per-harness `getHarnessPg` (stays direct,
 * D-005), the LISTEN buses, the admin cache, the watchdog tick-lock (the fixedOverhead).
 * Counting the pooled org pools as direct is what made the budget log cry false DANGER
 * on every correctly-pooled multi-worker boot (a 15-worker cluster reported ~1104 vs a
 * live, pgbouncer-bounded 199/512).
 */
export function connectionBudgetStatus(opts: {
  orgPools: number;
  harnessPools: number;
  fixedOverhead: number;
  pooled: boolean;
  expectedProcesses: number;
  liveMax: number;
}): { directPerProc: number; fleetWorst: number; danger: boolean } {
  const directPerProc = (opts.pooled ? 0 : opts.orgPools) + opts.harnessPools + opts.fixedOverhead;
  const procs = Math.max(1, Math.floor(opts.expectedProcesses) || 1);
  const fleetWorst = directPerProc * procs;
  const danger = opts.liveMax > 0 && fleetWorst > opts.liveMax * 0.9;
  return { directPerProc, fleetWorst, danger };
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
  const { orgPools, harnessPools, fixedOverhead, poolMax } = processConnectionCeiling();
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
  const pooled = pgbouncerEnabled();
  const { directPerProc, fleetWorst, danger } = connectionBudgetStatus({
    orgPools,
    harnessPools,
    fixedOverhead,
    pooled,
    expectedProcesses: expectedProcs,
    liveMax,
  });
  // EI-3379: when pooled, org pools are pgbouncer client slots (real backends bounded by
  // default_pool_size, not by process count), so they're excluded from the per-process
  // backend tally and flagged as such — the warning now reflects DIRECT backend pressure.
  const orgNote = pooled
    ? `org ${orgPools} @ poolMax ${poolMax} POOLED (pgbouncer client slots; backends bounded by default_pool_size)`
    : `org ${orgPools} @ poolMax ${poolMax}`;
  const head =
    `[pg-budget] pid ${process.pid}: <=${directPerProc} direct conns/process ` +
    `(${orgNote} + harness ${harnessPools} + cache/listeners ${fixedOverhead}); ` +
    `~${fleetWorst} direct across ${expectedProcs} proc(s)`;
  if (danger) {
    const remedy = pooled
      ? `Run \`npx tsx scripts/pg-autotune.ts --apply\` (raise the ceiling to the host) or lower ` +
        `PAPERCUSP_HARNESS_POOL_CAP / PAPERCUSP_EXPECTED_OPERATOR_PROCS — org pools are already pooled, ` +
        `so the DIRECT pools (harness + LISTEN + admin) are the pressure.`
      : `Run \`npx tsx scripts/pg-autotune.ts --apply\` (raise the ceiling to the host), lower ` +
        `PAPERCUSP_DB_POOL_MAX, or front PG with PgBouncer.`;
    log(`${head} — DANGER vs live max_connections=${liveMax}. ${remedy}`);
  } else {
    log(`${head} vs live max_connections=${liveMax || '?'} — ok`);
  }
}

/**
 * Test-only: close all open pools so a different DATABASE_URL can be used.
 *
 * EI-14436: this MUST also clear the resolved-URL cache (`_resolvedAdminUrl` /
 * `_resolvedAppUrl`), not just the client pools. `adminUrl()`/`appUrl()` cache
 * an 'env'-sourced URL as stable "for process lifetime" and short-circuit
 * BEFORE re-reading `process.env` on every subsequent call — so a test that
 * mutates `HARNESS_ADMIN_DATABASE_URL`/`HARNESS_DATABASE_URL`/`DATABASE_URL`
 * AFTER an earlier (unrelated) call in the same worker process already resolved
 * + cached the admin/app URL from a DIFFERENT env value (e.g. a shell-inherited
 * `DATABASE_URL` pointing at the real native/dev database) would find this
 * function a no-op for its purpose: it nulls the pools, but the next
 * getOrgPg()/getOrgPgApp() call rebuilds them against the SAME STALE cached
 * URL, silently reconnecting to the wrong database. Observed live: every
 * summarizeOpenPlacements() assertion in placement-watchdog.integration.test.ts
 * queried the real dev DB's 200+ unrelated harness rows instead of the
 * test's own throwaway container, reading back an empty result deterministically
 * (100% reproduction in isolation, not a race) because the test's own env-var
 * reassignment in beforeAll never took effect. A handful of call sites already
 * worked around this by calling the separate `_resetUrlCacheForTests()` before
 * `_resetForTests()` (see sync/pot-git/serve-wiring.integration.test.ts) — fold
 * that into the one test-reset entrypoint so every caller gets it for free
 * instead of relying on each test file to know this footgun exists.
 */
export async function _resetForTests() {
  _resetUrlCacheForTests();
  if (_adminClient) {
    await _adminClient.end({ timeout: 1 }).catch(() => {});
  }
  _adminClient = null;
  _adminDrizzle = null;
  _adminDb = null;
  if (_adminLosslessBigintClient) {
    await _adminLosslessBigintClient.end({ timeout: 1 }).catch(() => {});
  }
  _adminLosslessBigintClient = null;
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
