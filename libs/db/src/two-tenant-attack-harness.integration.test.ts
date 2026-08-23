/**
 * Reusable hostile-tenant fixture proof. These tests validate the harness
 * itself; later hosted-RLS suites import the same helper instead of rebuilding
 * one-off, weaker fixtures around each table family.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  capturePostgresError,
  createTwoTenantAttackHarness,
  type AttackResourceRow,
  type TwoTenantAttackHarness,
} from './test-utils/two-tenant-attack-harness';

let harness: TwoTenantAttackHarness;

beforeAll(async () => {
  harness = await createTwoTenantAttackHarness();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
});

function organizations(rows: AttackResourceRow[]): string[] {
  return [...new Set(rows.map((row) => row.organization_id))];
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('two-tenant Postgres attack harness', () => {
  it('pins overlapping names and ids while direct enumeration and guessed ids stay tenant-local', async () => {
    expect(harness.fixture.alpha.workspaceId).toBe(harness.fixture.beta.workspaceId);
    expect(harness.fixture.alpha.resources[0]).toEqual(harness.fixture.beta.resources[0]);

    const alphaRows = await harness.asTenant('alpha', (tx) => harness.listResources(tx));
    const betaRows = await harness.asTenant('beta', (tx) => harness.listResources(tx));
    const alphaGuess = await harness.asTenant('alpha', (tx) => harness.findResourcesById(tx, 'resource-beta-only'));

    expect(alphaRows).toHaveLength(2);
    expect(betaRows).toHaveLength(2);
    expect(organizations(alphaRows)).toEqual(['organization-alpha']);
    expect(organizations(betaRows)).toEqual(['organization-beta']);
    expect(alphaGuess).toEqual([]);
  });

  it('makes foreign-key guesses and globally missing ids indistinguishable', async () => {
    const attempt = (resourceId: string) =>
      harness.asTenant('alpha', (tx, tenant) =>
        harness.insertLink(tx, {
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          id: `link-${resourceId}`,
          resourceId,
        }),
      );

    const foreignExisting = await capturePostgresError(attempt('resource-beta-only'));
    const globallyMissing = await capturePostgresError(attempt('resource-missing'));

    expect(foreignExisting).toEqual({ code: '23503', constraint: 'attack_links_resource_fk' });
    expect(globallyMissing).toEqual(foreignExisting);

    const foreignRow = await capturePostgresError(
      harness.asTenant('alpha', (tx) =>
        harness.insertLink(tx, {
          organizationId: harness.fixture.beta.organizationId,
          workspaceId: harness.fixture.beta.workspaceId,
          id: 'foreign-row',
          resourceId: harness.fixture.beta.resources[0].id,
        }),
      ),
    );
    expect(foreignRow.code).toBe('42501');
  });

  it('uses a non-owner, non-BYPASSRLS runtime role and closes owner/escalation bypasses', async () => {
    const facts = await harness.runtimeRoleFacts();
    expect(facts).toEqual({
      current_user: harness.runtimeRole,
      rolsuper: false,
      rolbypassrls: false,
      rolinherit: false,
      table_owner: harness.tableOwnerRole,
      row_security_forced: true,
    });

    const escalation = await capturePostgresError(harness.asTenant('alpha', (tx) => harness.attemptTableOwnerRole(tx)));
    expect(escalation.code).toBe('42501');

    const ownerWithoutContext = await harness.asTableOwner((tx) => harness.listResources(tx));
    expect(ownerWithoutContext).toEqual([]);
  });

  it('fails closed with no context and does not leak SET LOCAL scope across reused transactions', async () => {
    const alphaRows = await harness.asTenant('alpha', (tx) => harness.listResources(tx));
    const afterAlpha = await harness.withoutTenantContext((tx) => harness.listResources(tx));
    const betaRows = await harness.asTenant('beta', (tx) => harness.listResources(tx));
    const afterBeta = await harness.withoutTenantContext((tx) => harness.listResources(tx));

    expect(organizations(alphaRows)).toEqual(['organization-alpha']);
    expect(afterAlpha).toEqual([]);
    expect(organizations(betaRows)).toEqual(['organization-beta']);
    expect(afterBeta).toEqual([]);
  });

  it('observes role changes and revocation inside an already-open tenant transaction', async () => {
    const entered = deferred();
    const roleChanged = deferred();
    const roleObserved = deferred();
    const revoked = deferred();

    const reads = harness.asTenant('alpha', async (tx) => {
      expect(await harness.readMembership(tx)).toMatchObject({ role: 'member', status: 'active' });
      entered.resolve();
      await roleChanged.promise;
      expect(await harness.readMembership(tx)).toMatchObject({ role: 'admin', status: 'active' });
      expect(await harness.listResources(tx)).toHaveLength(2);
      roleObserved.resolve();
      await revoked.promise;
      return {
        membership: await harness.readMembership(tx),
        resources: await harness.listResources(tx),
      };
    });

    await entered.promise;
    await harness.setMembership('alpha', { role: 'admin' });
    roleChanged.resolve();
    await roleObserved.promise;
    await harness.setMembership('alpha', { status: 'revoked' });
    revoked.resolve();

    await expect(reads).resolves.toEqual({
      membership: {
        organization_id: 'organization-alpha',
        user_id: 'user-alpha',
        role: 'admin',
        status: 'revoked',
      },
      resources: [],
    });
  });

  it('keeps both tenants isolated during concurrent membership-role updates', async () => {
    const batches = await Promise.all(
      Array.from({ length: 16 }, async (_, index) => {
        const role = index % 2 === 0 ? 'admin' : 'member';
        const [alphaRows, betaRows] = await Promise.all([
          harness
            .setMembership('alpha', { role })
            .then(() => harness.asTenant('alpha', (tx) => harness.listResources(tx))),
          harness
            .setMembership('beta', { role })
            .then(() => harness.asTenant('beta', (tx) => harness.listResources(tx))),
        ]);
        return { alphaRows, betaRows };
      }),
    );

    for (const { alphaRows, betaRows } of batches) {
      expect(organizations(alphaRows)).toEqual(['organization-alpha']);
      expect(organizations(betaRows)).toEqual(['organization-beta']);
    }
  });
});
