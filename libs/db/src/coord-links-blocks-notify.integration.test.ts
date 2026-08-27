/**
 * coord-links-blocks-notify.integration.test.ts — migration 366 attaches a SCOPED
 * change-notify trigger to harness_shared.coord_links so that adding/removing a
 * rel='blocks' edge (the post-mig-155 source of truth for feature→feature blocking)
 * emits `sync_invalidate` name='harness_shared.coord_links.blocks.changed' carrying the
 * affected item refs, while non-'blocks' edges (tagged/relates/...) emit nothing.
 *
 * caching-layer-tag-eca-2026-06-22 P-013 (+ the readiness slice of D-008/D-009/P-014).
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/coord-links-blocks-notify.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, '..', 'sql');
const RUNNER = join(here, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');

const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION NOSUPERUSER BYPASSRLS PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

/** Build the full schema (incl. migration 366) into the fresh DB via the real runner. */
async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (o: { client: Sql; sqlDir: string }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    if (appliedCount !== totalKnown) {
      throw new Error(`coord-links-blocks provision: applied ${appliedCount}/${totalKnown} (expected zero skips)`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql; // writes
let listener: Sql; // dedicated LISTEN connection

interface Notif {
  name: string;
  args: { op: string; blocked_ref?: string; blocker_ref?: string; workspace_id?: string | null };
}
const received: Notif[] = [];
const BLOCKS = 'harness_shared.coord_links.blocks.changed';
const blocksNotifs = (): Notif[] => received.filter((n) => n.name === BLOCKS);
const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function insertEdge(rel: string, srcRef: string, dstRef: string): Promise<void> {
  await sql.unsafe(
    `INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
       VALUES ('test-ws','feature',$1,'feature',$2,$3)`,
    [srcRef, dstRef, rel],
  );
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'coordlinksblocks', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  // Set the workspace GUCs (session-level): app.workspace_id for the federation/stamp
  // sibling triggers, papercusp.workspace_id for the GENERIC emit_change_notify payload
  // (that fn reads current_setting('papercusp.workspace_id', true) — see 000-baseline).
  await sql.unsafe(`SELECT set_config('app.workspace_id', 'test-ws', false)`);
  await sql.unsafe(`SELECT set_config('papercusp.workspace_id', 'test-ws', false)`);
  listener = postgres(db.url, { max: 1, onnotice: () => {} });
  await listener.listen('sync_invalidate', (payload: string) => {
    try {
      received.push(JSON.parse(payload) as Notif);
    } catch {
      /* ignore non-JSON */
    }
  });
}, 180_000);

afterAll(async () => {
  await listener?.end({ timeout: 5 }).catch(() => {});
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

// CURRENT contract (migrations 383 + 396 superseded 366):
//   • mig 383 DROPPED the bespoke mig-366 blocks trigger — readiness is a maintained
//     sidecar (work_item_blocked, mig 379) fed by work_item_deps triggers, so the
//     scoped 'coord_links.blocks.changed' event has ZERO consumers and must stay dead.
//   • mig 396 attached the GENERIC emit_change_notify to coord_links (caching-layer
//     P-013 audit-blocker), so every edge write emits
//     'harness_shared.coord_links.changed' with { op, workspace_id, id } (mig 368 PK).
// This suite guards BOTH halves: the generic event fires, the retired bespoke one never.
const GENERIC = 'harness_shared.coord_links.changed';
const genericNotifs = (): Notif[] => received.filter((n) => n.name === GENERIC);

describe('coord_links change-notify — generic trigger (mig 396) + retired blocks trigger stays dead (mig 383)', () => {
  it('emits the generic coord_links.changed on a blocks-edge INSERT; never the retired blocks.changed', async () => {
    received.length = 0;
    await insertEdge('blocks', 'WI-BLOCKER', 'WI-BLOCKED');
    await settle();
    const n = genericNotifs();
    expect(n).toHaveLength(1);
    expect(n[0]!.args.op).toBe('INSERT');
    expect(n[0]!.args.workspace_id).toBe('test-ws'); // correct GUC (app.workspace_id)
    expect(blocksNotifs()).toHaveLength(0); // mig 383's drop holds
  });

  it('emits the generic event for a non-blocks (tagged) edge too — mig 396 is table-wide', async () => {
    received.length = 0;
    await insertEdge('tagged', 'WI-X', 'topic:foo');
    await settle();
    expect(genericNotifs()).toHaveLength(1);
    expect(blocksNotifs()).toHaveLength(0);
  });

  it('emits the generic event on a blocks-edge DELETE; still no bespoke blocks.changed', async () => {
    await insertEdge('blocks', 'WI-B2', 'WI-D2');
    await settle();
    received.length = 0;
    await sql.unsafe(`DELETE FROM harness_shared.coord_links WHERE rel='blocks' AND src_ref='WI-B2' AND dst_ref='WI-D2'`);
    await settle();
    const n = genericNotifs();
    expect(n).toHaveLength(1);
    expect(n[0]!.args.op).toBe('DELETE');
    expect(blocksNotifs()).toHaveLength(0);
  });
});
