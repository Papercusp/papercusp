import { describe, expect, it } from 'vitest';
import { findMissingPgPolicies, repairPgPolicyPredicates } from './schema-policies.mjs';

const source = [
  'import { sql, text } from "drizzle-orm";',
  'import { harnessShared } from "./schemas";',
  '',
  'export const datatypeRegistry = harnessShared.table("datatype_registry", {',
  '  id: text(),',
  '}, (table) => [',
  '  pgPolicy("datatype_registry_workspace_isolation", { as: "permissive", for: "all", to: ["public"] }),',
  '  pgPolicy("datatype_registry_approved_global_read", { as: "permissive", for: "select", to: ["public"], using: sql`wrong` }),',
  ']);',
  '',
].join('\n');

const authoritativePolicies = [
  {
    schemaName: 'harness_shared',
    tableName: 'datatype_registry',
    policyName: 'datatype_registry_workspace_isolation',
    qual: "(workspace_id = current_setting('app.workspace_id'::text, true))",
    with_check: "(workspace_id = current_setting('app.workspace_id'::text, true))",
  },
  {
    schemaName: 'harness_shared',
    tableName: 'datatype_registry',
    policyName: 'datatype_registry_approved_global_read',
    qual: "(review_status = 'approved'::text)",
    with_check: null,
  },
];

describe('findMissingPgPolicies', () => {
  it('refuses a migration-only catalog that lacks runtime tenant policies', () => {
    expect(findMissingPgPolicies({ source, policies: [] })).toEqual([
      'harness_shared.datatype_registry.datatype_registry_approved_global_read',
      'harness_shared.datatype_registry.datatype_registry_workspace_isolation',
    ]);
  });

  it('accepts a complete catalog and additive policies absent from the old mirror', () => {
    expect(findMissingPgPolicies({ source, policies: [
      ...authoritativePolicies,
      { schemaname: 'harness_shared', tablename: 'datatype_registry', policyname: 'new_policy' },
    ] })).toEqual([]);
  });

  it('uses the schema, table and policy identity rather than a policy-name count', () => {
    const wrongTables = authoritativePolicies.map((policy) => ({
      ...policy, tableName: 'another_table',
    }));
    expect(findMissingPgPolicies({ source, policies: wrongTables })).toHaveLength(2);
    const wrongSchemas = authoritativePolicies.map((policy) => ({
      ...policy, schemaName: 'another_schema',
    }));
    expect(findMissingPgPolicies({ source, policies: wrongSchemas })).toHaveLength(2);
  });

  it('allows only explicitly named removals and still detects other missing policies', () => {
    expect(findMissingPgPolicies({ source, policies: [], allowedRemovals: [
      'harness_shared.datatype_registry.datatype_registry_approved_global_read',
    ] })).toEqual(['harness_shared.datatype_registry.datatype_registry_workspace_isolation']);
    expect(findMissingPgPolicies({ source, policies: [], allowedRemovals: ['*'] })).toHaveLength(2);
  });

  it('checks the last table and accepts catalog column names without mixing tables', () => {
    const twoTables = source + source
      .replaceAll('datatypeRegistry', 'otherRegistry')
      .replaceAll('datatype_registry', 'other_registry');
    const policies = authoritativePolicies.map((policy) => ({
      schemaname: policy.schemaName, tablename: policy.tableName, policyname: policy.policyName,
    }));
    expect(findMissingPgPolicies({ source: twoTables, policies })).toEqual([
      'harness_shared.other_registry.other_registry_approved_global_read',
      'harness_shared.other_registry.other_registry_workspace_isolation',
    ]);
  });
});

describe('repairPgPolicyPredicates', () => {
  it('matches policy predicates by qualified identity, not introspection order', () => {
    const result = repairPgPolicyPredicates({ source, policies: authoritativePolicies });

    expect(result.unresolved).toEqual([]);
    expect(result.repaired).toBe(2);
    expect(result.source).toContain(
      "using: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`, withCheck: sql`(workspace_id = current_setting('app.workspace_id'::text, true))`",
    );
    expect(result.source).toContain("using: sql`(review_status = 'approved'::text)`");
  });

  it('is idempotent and removes stale predicates when the catalog has NULL', () => {
    const first = repairPgPolicyPredicates({ source, policies: authoritativePolicies });
    const second = repairPgPolicyPredicates({ source: first.source, policies: authoritativePolicies });

    expect(second).toEqual({
      source: first.source,
      changed: false,
      repaired: 0,
      unresolved: [],
    });
    expect(first.source.match(/withCheck:/g)).toHaveLength(1);
    expect(first.source).not.toContain('using: sql`wrong`');
  });

  it('fails closed when the generated and authoritative policy sets differ', () => {
    const result = repairPgPolicyPredicates({
      source,
      policies: [...authoritativePolicies, {
        schemaName: 'harness_shared',
        tableName: 'datatype_registry',
        policyName: 'missing_from_generated',
        qual: '(true)',
        with_check: null,
      }],
    });

    expect(result.changed).toBe(false);
    expect(result.repaired).toBe(0);
    expect(result.unresolved).toContain(
      'harness_shared.datatype_registry.missing_from_generated: authoritative policy has no generated call',
    );
  });
});
