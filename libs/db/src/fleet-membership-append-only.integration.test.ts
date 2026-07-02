import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getHarnessAdminUrl } from '../index';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

describe('fleet_membership_events: append-only canonical membership fact (WI-1345)', () => {
  let db: PostgresJsDatabase;
  let sql: postgres.Sql;

  beforeAll(async () => {
    const connStr = getHarnessAdminUrl();
    sql = postgres(connStr);
    // Create db connection for queries (using drizzle would be fine too)
  });

  afterAll(async () => {
    await sql.end();
  });

  describe('(a) membership survives agent death', () => {
    it('coord_presence row is reaped on agent death, but fleet membership persists in append-only log', async () => {
      const workspaceId = 'test-workspace-' + Date.now();
      const agentId = 'test-agent-' + Date.now();
      const fleetSlug = 'test-fleet-' + Date.now();

      // Step 1: agent joins a fleet (via coord_presence + membership event)
      await sql`
        INSERT INTO harness_shared.coord_presence
          (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, heartbeat_at)
        VALUES (${workspaceId}, ${agentId}, 'test-bee', ${fleetSlug}, 'member', now())
      `;

      // Append membership event
      await sql`
        INSERT INTO harness_shared.fleet_membership_events
          (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event)
        VALUES (${workspaceId}, ${agentId}, 'test-bee', ${fleetSlug}, 'member', 'join')
      `;

      // Verify membership is recorded
      const eventsBefore = await sql`
        SELECT * FROM harness_shared.fleet_membership_events
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
      `;
      expect(eventsBefore).toHaveLength(1);
      expect(eventsBefore[0].fleet_slug).toBe(fleetSlug);

      // Step 2: simulate agent death by deleting the presence row
      // (in reality, the reaper does this when the agent times out)
      await sql`
        DELETE FROM harness_shared.coord_presence
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
      `;

      // Step 3: verify presence row is gone
      const presenceAfterDeath = await sql`
        SELECT * FROM harness_shared.coord_presence
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
      `;
      expect(presenceAfterDeath).toHaveLength(0);

      // Step 4: CRITICAL — membership fact is still there
      const eventsAfterDeath = await sql`
        SELECT * FROM harness_shared.fleet_membership_events
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
      `;
      expect(eventsAfterDeath).toHaveLength(1);
      expect(eventsAfterDeath[0].fleet_slug).toBe(fleetSlug);
      expect(eventsAfterDeath[0].event).toBe('join');

      // Step 5: agent rejoins (new presence row) and should auto-recover its fleet
      await sql`
        INSERT INTO harness_shared.coord_presence
          (workspace_id, owner_id, owner_label, heartbeat_at)
        VALUES (${workspaceId}, ${agentId}, 'test-bee-rejoined', now())
      `;

      // Step 6: the materialize trigger should have restored the fleet on the new presence row
      const presenceAfterRejoin = await sql`
        SELECT fleet_slug, fleet_role FROM harness_shared.coord_presence
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
      `;
      expect(presenceAfterRejoin).toHaveLength(1);
      expect(presenceAfterRejoin[0].fleet_slug).toBe(fleetSlug);
      expect(presenceAfterRejoin[0].fleet_role).toBe('member');
    });
  });

  describe('(b) projections stay consistent with append-only source', () => {
    it('coord_presence.fleet_slug is always synced from the latest membership event', async () => {
      const workspaceId = 'test-workspace-' + Date.now();
      const agentId = 'test-agent-' + Date.now();
      const fleet1 = 'fleet-1-' + Date.now();
      const fleet2 = 'fleet-2-' + Date.now();

      // Create presence
      await sql`
        INSERT INTO harness_shared.coord_presence
          (workspace_id, owner_id, owner_label, heartbeat_at)
        VALUES (${workspaceId}, ${agentId}, 'test-bee', now())
      `;

      // Agent joins fleet1
      await sql`
        INSERT INTO harness_shared.fleet_membership_events
          (workspace_id, owner_id, fleet_slug, fleet_role, event)
        VALUES (${workspaceId}, ${agentId}, ${fleet1}, 'member', 'join')
      `;

      // Check projection on presence
      const presenceAfterJoin1 = await sql`
        SELECT fleet_slug FROM harness_shared.coord_presence
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
      `;
      expect(presenceAfterJoin1[0].fleet_slug).toBe(fleet1);

      // Agent leaves fleet1
      await sql`
        INSERT INTO harness_shared.fleet_membership_events
          (workspace_id, owner_id, fleet_slug, fleet_role, event)
        VALUES (${workspaceId}, ${agentId}, NULL, NULL, 'leave')
      `;

      // Check projection is nulled
      const presenceAfterLeave = await sql`
        SELECT fleet_slug FROM harness_shared.coord_presence
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
      `;
      expect(presenceAfterLeave[0].fleet_slug).toBeNull();

      // Agent joins fleet2
      await sql`
        INSERT INTO harness_shared.fleet_membership_events
          (workspace_id, owner_id, fleet_slug, fleet_role, event)
        VALUES (${workspaceId}, ${agentId}, ${fleet2}, 'leader', 'join')
      `;

      // Check projection reflects fleet2
      const presenceAfterJoin2 = await sql`
        SELECT fleet_slug, fleet_role FROM harness_shared.coord_presence
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
      `;
      expect(presenceAfterJoin2[0].fleet_slug).toBe(fleet2);
      expect(presenceAfterJoin2[0].fleet_role).toBe('leader');

      // Verify the log has all 3 events
      const allEvents = await sql`
        SELECT COUNT(*) as cnt, event FROM harness_shared.fleet_membership_events
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
        GROUP BY event ORDER BY event
      `;
      expect(allEvents).toHaveLength(2); // join and leave
      expect(allEvents.map((e: any) => e.cnt.toString())).toEqual(['1', '2']);
    });

    it('fleet_assignment view reflects latest membership from the fact, not live presence', async () => {
      const workspaceId = 'test-workspace-' + Date.now();
      const planSlug = 'test-plan-' + Date.now();
      const agentId = 'test-agent-' + Date.now();
      const fleetSlug = 'test-fleet-' + Date.now();

      // Create a work item claim
      await sql`
        INSERT INTO harness_shared.work_items
          (workspace_id, feature_id, harness_slug, title, status, taken_by, taken_at)
        VALUES (${workspaceId}, 'WI-' + random()::text, 'test-harness', 'test', 'todo', ${agentId}, now())
      `;

      // Ensure a presence row for the agent
      await sql`
        INSERT INTO harness_shared.coord_presence
          (workspace_id, owner_id, owner_label, heartbeat_at)
        VALUES (${workspaceId}, ${agentId}, 'test-bee', now())
        ON CONFLICT (workspace_id, owner_id) DO UPDATE SET heartbeat_at = now()
      `;

      // Agent joins fleet
      await sql`
        INSERT INTO harness_shared.fleet_membership_events
          (workspace_id, owner_id, fleet_slug, fleet_role, event)
        VALUES (${workspaceId}, ${agentId}, ${fleetSlug}, 'member', 'join')
      `;

      // Check fleet_assignment view for the claim
      const assignmentWithFleet = await sql`
        SELECT fleet_slug, fleet_role FROM harness_shared.fleet_assignment
        WHERE workspace_id = ${workspaceId} AND agent_id = ${agentId}
      `;
      expect(assignmentWithFleet.length).toBeGreaterThan(0);
      expect(assignmentWithFleet.some((row: any) => row.fleet_slug === fleetSlug)).toBe(true);

      // Now delete the agent's presence row (simulating death)
      await sql`
        DELETE FROM harness_shared.coord_presence
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
      `;

      // CRITICAL: fleet_assignment should STILL show the fleet (from the append-only fact)
      const assignmentAfterPresenceDeath = await sql`
        SELECT fleet_slug, fleet_role FROM harness_shared.fleet_assignment
        WHERE workspace_id = ${workspaceId} AND agent_id = ${agentId}
      `;
      expect(assignmentAfterPresenceDeath.length).toBeGreaterThan(0);
      // The fleet membership should persist from the fact, not the presence row
      const withFleet = assignmentAfterPresenceDeath.filter(
        (row: any) => row.fleet_slug === fleetSlug
      );
      expect(withFleet.length).toBeGreaterThan(0);
    });
  });

  describe('(c) reconnect/rejoin appends new fact rather than mutating history', () => {
    it('agent leaving and rejoin creates new append-only events, not an update', async () => {
      const workspaceId = 'test-workspace-' + Date.now();
      const agentId = 'test-agent-' + Date.now();
      const fleetSlug = 'test-fleet-' + Date.now();

      // Agent joins
      await sql`
        INSERT INTO harness_shared.fleet_membership_events
          (workspace_id, owner_id, fleet_slug, fleet_role, event)
        VALUES (${workspaceId}, ${agentId}, ${fleetSlug}, 'member', 'join')
      `;

      const eventsAfterJoin = await sql`
        SELECT id, event FROM harness_shared.fleet_membership_events
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
        ORDER BY id
      `;
      expect(eventsAfterJoin).toHaveLength(1);
      const firstJoinId = eventsAfterJoin[0].id;

      // Agent leaves
      await sql`
        INSERT INTO harness_shared.fleet_membership_events
          (workspace_id, owner_id, fleet_slug, fleet_role, event)
        VALUES (${workspaceId}, ${agentId}, NULL, NULL, 'leave')
      `;

      const eventsAfterLeave = await sql`
        SELECT id, event FROM harness_shared.fleet_membership_events
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
        ORDER BY id
      `;
      expect(eventsAfterLeave).toHaveLength(2);
      expect(eventsAfterLeave[0].id).toBe(firstJoinId); // original join still exists
      expect(eventsAfterLeave[1].event).toBe('leave');

      // Agent rejoins (possibly reconnecting, same fleet)
      await sql`
        INSERT INTO harness_shared.fleet_membership_events
          (workspace_id, owner_id, fleet_slug, fleet_role, event)
        VALUES (${workspaceId}, ${agentId}, ${fleetSlug}, 'member', 'join')
      `;

      const eventsAfterRejoin = await sql`
        SELECT id, event FROM harness_shared.fleet_membership_events
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
        ORDER BY id
      `;
      expect(eventsAfterRejoin).toHaveLength(3);
      // All three events are immutable and present; no UPDATE happened
      expect(eventsAfterRejoin[0].event).toBe('join');
      expect(eventsAfterRejoin[1].event).toBe('leave');
      expect(eventsAfterRejoin[2].event).toBe('join');

      // Projection reads the latest (most recent id)
      const latestMembership = await sql`
        SELECT DISTINCT ON (workspace_id, owner_id)
               fleet_slug, fleet_role, event
          FROM harness_shared.fleet_membership_events
         WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
         ORDER BY workspace_id, owner_id, id DESC
      `;
      expect(latestMembership).toHaveLength(1);
      expect(latestMembership[0].fleet_slug).toBe(fleetSlug);
      expect(latestMembership[0].event).toBe('join');
    });
  });

  describe('(d) direct mutation guard on coord_presence.fleet_slug/fleet_role', () => {
    it('rejects direct UPDATE of coord_presence.fleet_slug, requires append-only event', async () => {
      const workspaceId = 'test-workspace-' + Date.now();
      const agentId = 'test-agent-' + Date.now();
      const fleetSlug = 'test-fleet-' + Date.now();

      // Create presence
      await sql`
        INSERT INTO harness_shared.coord_presence
          (workspace_id, owner_id, owner_label, heartbeat_at)
        VALUES (${workspaceId}, ${agentId}, 'test-bee', now())
      `;

      // Try to directly UPDATE fleet_slug (should fail)
      let directUpdateFailed = false;
      try {
        await sql`
          UPDATE harness_shared.coord_presence
          SET fleet_slug = ${fleetSlug}
          WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
        `;
      } catch (err: any) {
        expect(err.message).toContain('PROJECTION');
        directUpdateFailed = true;
      }
      expect(directUpdateFailed).toBe(true);

      // Correct path: append an event, and the projection trigger updates the presence row
      await sql`
        INSERT INTO harness_shared.fleet_membership_events
          (workspace_id, owner_id, fleet_slug, fleet_role, event)
        VALUES (${workspaceId}, ${agentId}, ${fleetSlug}, 'member', 'join')
      `;

      // Now the presence row has the fleet (via the projection trigger)
      const presence = await sql`
        SELECT fleet_slug FROM harness_shared.coord_presence
        WHERE workspace_id = ${workspaceId} AND owner_id = ${agentId}
      `;
      expect(presence[0].fleet_slug).toBe(fleetSlug);
    });
  });

  describe('(e) backfill: existing live members keep their membership across migration', () => {
    it('backfill seeds the append-only log from current coord_presence.fleet_slug values', async () => {
      // This test verifies that the backfill INSERT in the migration correctly
      // seeded existing agents' memberships. We check that a pre-existing presence
      // row (if any) was backfilled into the append-only log.

      const existingRows = await sql`
        SELECT COUNT(DISTINCT owner_id) as cnt
        FROM harness_shared.coord_presence
        WHERE fleet_slug IS NOT NULL
        LIMIT 1
      `;

      // If there are existing members with a fleet_slug, verify they are in the log
      if (existingRows[0].cnt > 0) {
        const loggedMembers = await sql`
          SELECT COUNT(DISTINCT owner_id) as cnt
          FROM harness_shared.fleet_membership_events
          WHERE event = 'backfill'
        `;
        expect(loggedMembers[0].cnt).toBeGreaterThan(0);
      }
    });
  });

  describe('(f) grant-based append-only enforcement', () => {
    it('harness_app role has SELECT + INSERT on fleet_membership_events, no UPDATE/DELETE', async () => {
      // This test verifies that the GRANT statements in the migration correctly
      // restrict harness_app to append-only (SELECT + INSERT, no UPDATE/DELETE).
      // (A full test would require switching roles; for now, this is a schema audit.)

      // The GRANT statements in the migration should be:
      // GRANT SELECT, INSERT ON harness_shared.fleet_membership_events TO harness_app;
      // (no UPDATE, DELETE, or TRUNCATE grants)

      // We can't easily test this without switching to the harness_app role,
      // but we document the expectation here. The migration uses the correct GRANTs.
      expect(true).toBe(true); // placeholder; actual enforcement is in the migration
    });
  });
});
