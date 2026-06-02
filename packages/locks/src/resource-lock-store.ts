/**
 * Named resource locks — storage layer (plan named-resource-locks-drain).
 *
 * A *named resource* (registered in agent_resource_registry) supports MANY
 * concurrent `shared` holders + at most ONE `exclusive` holder, gated by a
 * writer-priority drain: a pending exclusive refuses NEW shared acquires
 * but lets existing ones finish, then is granted once they drain to zero.
 *
 * This is a SEPARATE table from agent_file_locks (D-001/D-009): shared mode
 * breaks the file-lock (domain,path) PK, and that table is the safety-
 * critical hot path. We reuse the same papercusp_su db, the same
 * ch_coord_<domain> NOTIFY channel, and the same inWorkspaceTxn advisory
 * lock; the drain cascade (resource_grant_cascade) mirrors grant_cascade.
 *
 * Like su-lock-store, these helpers take a `tx: Sql` and run inside the
 * caller's inWorkspaceTxn — they never touch the pool directly. Read-only
 * helpers (status / queue / registry reads) take a plain Sql (the pool).
 */

import type { Sql } from 'postgres';

export type ResourceMode = 'shared' | 'exclusive';
export type ResourceLockStatus = 'held' | 'draining';
export type ResourceEnforcement = 'advisory' | 'checked' | 'enforced';

export interface ResourceHolder {
  owner: string;
  owner_label: string | null;
  mode: ResourceMode;
  status: ResourceLockStatus;
  lock_id: string;
  reason: string;
  acquired_ts: Date;
  expires_ts: Date;
}

export interface ResourceRegistryRow {
  resource: string;
  description: string;
  rule_text: string;
  enforcement: ResourceEnforcement;
  match_patterns: string[];
}

export interface ResourceAcquireParams {
  coordinationDomain: string;
  resource: string;
  mode: ResourceMode;
  owner: string;
  ownerLabel: string | null;
  reason: string;
  ttlSec: number;
}

export type ResourceAcquireResult =
  | {
      ok: true;
      lock_id: string;
      mode: ResourceMode;
      /** 'held' = granted now; 'draining' = exclusive accepted, waiting on
       *  shared holders to drain before it is effective. */
      status: ResourceLockStatus;
      expires_ts: Date;
      /** Live shared holders at acquire time (the set an exclusive must
       *  wait to drain; empty for a granted exclusive / a shared acquire). */
      shared_holders: ResourceHolder[];
    }
  | {
      ok: false;
      reason:
        | 'unknown_resource' // not in the registry (D-010)
        | 'exclusive_pending' // shared blocked by a held/draining exclusive (writer-priority)
        | 'holds_shared' // exclusive blocked by the caller's own shared lease (no upgrade, D-004)
        | 'held_exclusive'; // exclusive held by another owner (or caller already holds exclusive)
      holders: ResourceHolder[];
    };

async function readLiveHolders(
  tx: Sql,
  coordinationDomain: string,
  resource: string,
): Promise<ResourceHolder[]> {
  return tx<ResourceHolder[]>`
    SELECT owner, owner_label, mode, status, lock_id::text AS lock_id, reason, acquired_ts, expires_ts
      FROM agent_resource_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND resource = ${resource}
       AND expires_ts > clock_timestamp()
     ORDER BY acquired_ts ASC
  `;
}

/**
 * Delete this workspace's expired resource-lock rows. Mirrors
 * sweepWorkspaceExpired for the file locks — drain-to-zero relies on
 * expired shared holders being removed so resource_grant_cascade can fire.
 * Returns true if anything was swept (so the caller can run the cascade).
 */
export async function sweepResourceExpired(
  tx: Sql,
  coordinationDomain: string,
): Promise<boolean> {
  const rows = await tx<Array<{ resource: string }>>`
    DELETE FROM agent_resource_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND expires_ts <= clock_timestamp()
    RETURNING resource
  `;
  return rows.length > 0;
}

/**
 * Acquire a named resource in `shared` or `exclusive` mode. Inside the
 * caller's inWorkspaceTxn.
 *
 *  - shared: granted unless another owner holds/pends an exclusive
 *    (writer-priority → exclusive_pending).
 *  - exclusive: rejected if the caller holds a shared lease (no upgrade,
 *    D-004 → holds_shared) or another owner holds exclusive
 *    (held_exclusive); else inserted as 'held' when no shared holders
 *    remain, or 'draining' while they finish.
 */
export async function tryAcquireResource(
  tx: Sql,
  params: ResourceAcquireParams,
): Promise<ResourceAcquireResult> {
  const { coordinationDomain: cd, resource, mode, owner, ownerLabel, reason, ttlSec } = params;
  await tx`SET LOCAL statement_timeout = '500ms'`;

  // D-010: registered names only.
  const reg = await tx<Array<{ resource: string }>>`
    SELECT resource FROM agent_resource_registry WHERE resource = ${resource} LIMIT 1
  `;
  if (reg.length === 0) {
    return { ok: false, reason: 'unknown_resource', holders: [] };
  }

  // Clean expired holders first so conflict + drain checks see live state.
  const swept = await sweepResourceExpired(tx, cd);
  if (swept) await tx`SELECT resource_grant_cascade(${cd}, clock_timestamp())`;

  const holders = await readLiveHolders(tx, cd, resource);
  const ttlText = `${ttlSec} seconds`;

  if (mode === 'shared') {
    // Writer-priority: a pending/held exclusive by ANOTHER owner refuses
    // new shared acquisitions (the "don't start new things" rule).
    const excl = holders.find((h) => h.mode === 'exclusive');
    if (excl && excl.owner !== owner) {
      return { ok: false, reason: 'exclusive_pending', holders };
    }
    const rows = await tx<Array<{ lock_id: string; expires_ts: Date }>>`
      INSERT INTO agent_resource_locks
        (coordination_domain, resource, owner, owner_label, mode, status, reason, expires_ts)
      VALUES
        (${cd}, ${resource}, ${owner}, ${ownerLabel}, 'shared', 'held', ${reason},
         clock_timestamp() + ${ttlText}::interval)
      ON CONFLICT (coordination_domain, resource, owner) DO UPDATE
        SET owner_label = EXCLUDED.owner_label,
            reason      = EXCLUDED.reason,
            mode        = 'shared',
            status      = 'held',
            acquired_ts = clock_timestamp(),
            expires_ts  = EXCLUDED.expires_ts
        WHERE agent_resource_locks.mode = 'shared'
      RETURNING lock_id::text AS lock_id, expires_ts
    `;
    if (rows.length === 0) {
      // The only way ON CONFLICT updates nothing: the caller already holds
      // an EXCLUSIVE row here, so the WHERE mode='shared' guard refused to
      // downgrade it. Resolve by releasing the exclusive first.
      return { ok: false, reason: 'held_exclusive', holders };
    }
    return {
      ok: true,
      mode: 'shared',
      status: 'held',
      lock_id: rows[0].lock_id,
      expires_ts: rows[0].expires_ts,
      shared_holders: holders.filter((h) => h.mode === 'shared'),
    };
  }

  // mode === 'exclusive'
  // D-004: no in-place upgrade. A caller holding shared must release first.
  if (holders.some((h) => h.owner === owner && h.mode === 'shared')) {
    return { ok: false, reason: 'holds_shared', holders };
  }
  // Another owner's exclusive (held or draining) blocks.
  if (holders.some((h) => h.mode === 'exclusive' && h.owner !== owner)) {
    return { ok: false, reason: 'held_exclusive', holders };
  }

  const sharedHolders = holders.filter((h) => h.mode === 'shared');
  const status: ResourceLockStatus = sharedHolders.length === 0 ? 'held' : 'draining';
  const rows = await tx<Array<{ lock_id: string; expires_ts: Date; status: ResourceLockStatus }>>`
    INSERT INTO agent_resource_locks
      (coordination_domain, resource, owner, owner_label, mode, status, reason, expires_ts)
    VALUES
      (${cd}, ${resource}, ${owner}, ${ownerLabel}, 'exclusive', ${status}, ${reason},
       clock_timestamp() + ${ttlText}::interval)
    ON CONFLICT (coordination_domain, resource, owner) DO UPDATE
      SET owner_label = EXCLUDED.owner_label,
          reason      = EXCLUDED.reason,
          mode        = 'exclusive',
          status      = ${status},
          acquired_ts = clock_timestamp(),
          expires_ts  = EXCLUDED.expires_ts
    RETURNING lock_id::text AS lock_id, expires_ts, status
  `;
  return {
    ok: true,
    mode: 'exclusive',
    status: rows[0].status,
    lock_id: rows[0].lock_id,
    expires_ts: rows[0].expires_ts,
    shared_holders: sharedHolders,
  };
}

export interface ResourceReleaseParams {
  coordinationDomain: string;
  owner: string;
  lockId?: string;
  resource?: string;
}

/**
 * Release the caller's hold(s). After deleting, run the drain cascade —
 * releasing the last shared holder is exactly what completes a pending
 * exclusive's drain. Returns the modes released so the tool layer can
 * decide whether to broadcast "resource back up" (on an exclusive release).
 */
export async function tryReleaseResource(
  tx: Sql,
  params: ResourceReleaseParams,
): Promise<{ released: number; releasedModes: ResourceMode[] }> {
  const { coordinationDomain: cd, owner, lockId, resource } = params;
  await tx`SET LOCAL statement_timeout = '5s'`;
  await sweepResourceExpired(tx, cd);

  let deleted: Array<{ mode: ResourceMode }>;
  if (lockId) {
    deleted = await tx<Array<{ mode: ResourceMode }>>`
      DELETE FROM agent_resource_locks
       WHERE coordination_domain = ${cd} AND lock_id = ${lockId}::uuid AND owner = ${owner}
      RETURNING mode
    `;
  } else if (resource) {
    deleted = await tx<Array<{ mode: ResourceMode }>>`
      DELETE FROM agent_resource_locks
       WHERE coordination_domain = ${cd} AND resource = ${resource} AND owner = ${owner}
      RETURNING mode
    `;
  } else {
    throw new Error('tryReleaseResource requires lockId or resource');
  }

  await tx`SELECT resource_grant_cascade(${cd}, clock_timestamp())`;
  return { released: deleted.length, releasedModes: deleted.map((d) => d.mode) };
}

/**
 * Extend a held resource lease's TTL. Owner-checked like tryHeartbeat.
 */
export async function tryHeartbeatResource(
  tx: Sql,
  coordinationDomain: string,
  owner: string,
  lockId: string,
  ttlSec: number,
): Promise<{ expires_ts: Date | null; extended: boolean }> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  const swept = await sweepResourceExpired(tx, coordinationDomain);
  if (swept) await tx`SELECT resource_grant_cascade(${coordinationDomain}, clock_timestamp())`;

  const ttlText = `${ttlSec} seconds`;
  const rows = await tx<Array<{ expires_ts: Date }>>`
    UPDATE agent_resource_locks
       SET expires_ts = clock_timestamp() + ${ttlText}::interval
     WHERE coordination_domain = ${coordinationDomain}
       AND lock_id = ${lockId}::uuid
       AND owner = ${owner}
       AND expires_ts > clock_timestamp()
    RETURNING expires_ts
  `;
  if (rows.length === 0) return { expires_ts: null, extended: false };
  return { expires_ts: rows[0].expires_ts, extended: true };
}

export interface ResourceLockStatusResult {
  status: ResourceLockStatus | 'missing';
  mode?: ResourceMode;
  resource?: string;
  expires_ts?: Date;
}

/**
 * Read one lock's current state by id — the exclusive waiter loop polls
 * this to detect draining → held. 'missing' = released or expired.
 */
export async function readResourceLockStatus(
  sql: Sql,
  lockId: string,
): Promise<ResourceLockStatusResult> {
  const rows = await sql<
    Array<{ status: ResourceLockStatus; mode: ResourceMode; resource: string; expires_ts: Date }>
  >`
    SELECT status, mode, resource, expires_ts
      FROM agent_resource_locks
     WHERE lock_id = ${lockId}::uuid
       AND expires_ts > clock_timestamp()
     LIMIT 1
  `;
  if (rows.length === 0) return { status: 'missing' };
  return {
    status: rows[0].status,
    mode: rows[0].mode,
    resource: rows[0].resource,
    expires_ts: rows[0].expires_ts,
  };
}

export interface ResourceQueueResult {
  holders: ResourceHolder[];
  /** True when any live exclusive on the queried set is still draining. */
  draining: boolean;
}

/**
 * List the live holders for a workspace (optionally one resource), plus a
 * draining flag — the data behind locks:queue for named resources.
 */
export async function readResourceQueue(
  sql: Sql,
  params: { coordinationDomain: string; resource?: string },
): Promise<ResourceQueueResult> {
  const { coordinationDomain: cd, resource } = params;
  const holders = resource
    ? await sql<ResourceHolder[]>`
        SELECT owner, owner_label, mode, status, lock_id::text AS lock_id, reason, acquired_ts, expires_ts
          FROM agent_resource_locks
         WHERE coordination_domain = ${cd}
           AND resource = ${resource}
           AND expires_ts > clock_timestamp()
         ORDER BY acquired_ts ASC
      `
    : await sql<ResourceHolder[]>`
        SELECT owner, owner_label, mode, status, lock_id::text AS lock_id, reason, acquired_ts, expires_ts
          FROM agent_resource_locks
         WHERE coordination_domain = ${cd}
           AND expires_ts > clock_timestamp()
         ORDER BY acquired_ts ASC
      `;
  const draining = holders.some((h) => h.mode === 'exclusive' && h.status === 'draining');
  return { holders, draining };
}

// ───────── Registry (D-010) ─────────

function mapRegistry(r: {
  resource: string;
  description: string;
  rule_text: string;
  enforcement: ResourceEnforcement;
  match_patterns: string[] | null;
}): ResourceRegistryRow {
  return {
    resource: r.resource,
    description: r.description,
    rule_text: r.rule_text,
    enforcement: r.enforcement,
    match_patterns: r.match_patterns ?? [],
  };
}

export async function listResources(sql: Sql): Promise<ResourceRegistryRow[]> {
  const rows = await sql<
    Array<{
      resource: string;
      description: string;
      rule_text: string;
      enforcement: ResourceEnforcement;
      match_patterns: string[] | null;
    }>
  >`
    SELECT resource, description, rule_text, enforcement, match_patterns
      FROM agent_resource_registry
     ORDER BY resource ASC
  `;
  return rows.map(mapRegistry);
}

export async function getResource(
  sql: Sql,
  resource: string,
): Promise<ResourceRegistryRow | null> {
  const rows = await sql<
    Array<{
      resource: string;
      description: string;
      rule_text: string;
      enforcement: ResourceEnforcement;
      match_patterns: string[] | null;
    }>
  >`
    SELECT resource, description, rule_text, enforcement, match_patterns
      FROM agent_resource_registry
     WHERE resource = ${resource}
     LIMIT 1
  `;
  return rows[0] ? mapRegistry(rows[0]) : null;
}

export interface UpsertResourceInput {
  resource: string;
  description?: string;
  rule_text?: string;
  enforcement?: ResourceEnforcement;
  match_patterns?: string[];
}

export async function upsertResource(
  tx: Sql,
  row: UpsertResourceInput,
): Promise<ResourceRegistryRow> {
  const rows = await tx<
    Array<{
      resource: string;
      description: string;
      rule_text: string;
      enforcement: ResourceEnforcement;
      match_patterns: string[] | null;
    }>
  >`
    INSERT INTO agent_resource_registry
      (resource, description, rule_text, enforcement, match_patterns, updated_ts)
    VALUES
      (${row.resource}, ${row.description ?? ''}, ${row.rule_text ?? ''},
       ${row.enforcement ?? 'advisory'}, ${row.match_patterns ?? []}, clock_timestamp())
    ON CONFLICT (resource) DO UPDATE
      SET description    = EXCLUDED.description,
          rule_text      = EXCLUDED.rule_text,
          enforcement    = EXCLUDED.enforcement,
          match_patterns = EXCLUDED.match_patterns,
          updated_ts     = clock_timestamp()
    RETURNING resource, description, rule_text, enforcement, match_patterns
  `;
  return mapRegistry(rows[0]);
}
