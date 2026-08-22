/**
 * Lazily-materialized namespaces for the introspected schema.
 *
 * WHY THIS EXISTS (plan `harden-shared-hive-to-256-peers-2026-06-29`, D-022,
 * P-012). `./generated.ts` is a 9589-line drizzle-kit `pull` artifact that
 * instantiates every table in the database at module-evaluation time. Measured
 * in isolation — its own process, `node --import tsx`, RSS after three forced
 * GCs — importing it costs **~95MB** (103MB baseline -> 198MB). For comparison,
 * on the same instrument `drizzle-orm/pg-core` costs +10MB, the `postgres`
 * driver +7MB and `drizzle-orm/postgres-js` +14MB. The generated schema is not
 * a rounding error next to the ORM; it IS the cost.
 *
 * `./index.ts` used to publish it with `export * as generated from './generated'`.
 * ESM `export *` forces evaluation of the target module, so all ~922 files that
 * import the `@papercusp/db-org` barrel paid that ~95MB at load — including the
 * many that never open a Postgres connection at all. The case that made this
 * load-bearing: the hyperbee perf rig's `peer-child.ts` reaches db-org through
 * ~30 distinct import chains via `boot.ts` (`load-revoked-pubkeys`,
 * `p2p/scope-roster`, `p2p/fleet-directory`, `p2p/receipts`, and ~24
 * `projections/register-all` modules), every one of them for a *function* such
 * as `getOrgPg`, and the child never queries Postgres. It paid ~95MB/peer for a
 * schema it never reads, which is what put a 256-peer mesh out of reach of
 * `decideMeshCapacity()` on this host.
 *
 * Re-exporting these Proxies instead defers that cost to the first PROPERTY
 * ACCESS. A consumer that writes `generated.projectsInHarness_shared` gets
 * identical behaviour and pays exactly what it paid before; a consumer that
 * merely has db-org somewhere in its import graph pays nothing.
 *
 * WHY `createRequire` RATHER THAN `await import()`. The published shape has to
 * stay a plain namespace object, because consumers use it synchronously in
 * expression position (`db.select().from(generated.x)`). An async import cannot
 * be hidden behind that without making all ~80 call sites async. tsx registers a
 * CJS hook alongside its ESM loader, so `require()` resolves this TypeScript
 * source directly (verified: 471 exports). This mirrors the deferred-require
 * idiom already in `../connection.ts` (see its `nodeRequire` helper) — and for
 * the same reason: calling `createRequire` at module scope once blanked the
 * entire desktop app, so it must not run until something actually needs it.
 * Deferring to first access is strictly safer than today's eager evaluation: a
 * browser bundle never touches `generated.*`, so the require never fires.
 */
import { createRequire } from 'node:module';

type GeneratedSchema = typeof import('./generated');
type GeneratedRelations = typeof import('./generated-relations');

let _nodeRequire: ReturnType<typeof createRequire> | undefined;

/**
 * Build a Proxy that behaves like a module namespace object but does not
 * evaluate the underlying module until a property is actually touched.
 *
 * Every trap routes through `load()` EXCEPT the ones that can be answered
 * without the module. `get` deliberately answers two well-known probes up
 * front — `Symbol.toStringTag` and `then` — because both are read by code that
 * is merely *inspecting* the value rather than using it: `then` in particular is
 * probed by the runtime whenever an object is awaited or resolved through a
 * promise, and letting that fall through to `load()` would make an incidental
 * `await` of a namespace pull in the whole 95MB schema.
 */
function lazyNamespace<T extends object>(id: string, label: string): T {
  let mod: T | undefined;
  const load = (): T => {
    if (mod === undefined) {
      _nodeRequire ??= createRequire(import.meta.url);
      mod = _nodeRequire(id) as T;
      if (mod === null || typeof mod !== 'object') {
        throw new Error(
          `@papercusp/db-org: lazy namespace '${label}' resolved to ${typeof mod}, expected a module object`,
        );
      }
    }
    return mod;
  };

  return new Proxy(Object.create(null) as T, {
    get(_target, prop) {
      if (prop === Symbol.toStringTag) return 'Module';
      // Not a thenable — see the docstring. Answering this without loading keeps
      // an incidental `await` from materialising the schema.
      if (prop === 'then') return undefined;
      return (load() as Record<PropertyKey, unknown>)[prop];
    },
    has(_target, prop) {
      return prop in (load() as object);
    },
    ownKeys() {
      return Reflect.ownKeys(load() as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const desc = Reflect.getOwnPropertyDescriptor(load() as object, prop);
      // A Proxy may not report a non-configurable descriptor for a property that
      // does not exist on its (empty) target, so re-mark as configurable. The
      // values themselves stay read-only via the `set`/`defineProperty` traps.
      return desc === undefined ? undefined : { ...desc, configurable: true };
    },
    set() {
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  });
}

/**
 * The canonical Drizzle definition of every introspected table, kept in sync by
 * `scripts/pull-schema.mjs`. Materialises on first property access.
 *
 *   import { generated } from '@papercusp/db-org';
 *   await db.select().from(generated.projectsInHarness_shared);
 */
export const generated: GeneratedSchema = lazyNamespace<GeneratedSchema>('./generated', 'generated');

/**
 * The FK graph for drizzle's `db.query.*` builders. Materialises on first
 * property access.
 */
export const generatedRelations: GeneratedRelations = lazyNamespace<GeneratedRelations>(
  './generated-relations',
  'generatedRelations',
);
