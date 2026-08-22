import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Plain .mjs helper shared with pull-schema.mjs (a script, not TS). This used to
// carry a `@ts-expect-error`; the package's tsconfig (EI-19302566985147894) sets
// allowJs, so the module now RESOLVES and its shape is inferred — leaving the
// directive in place would be an unused-directive error in its own right.
import { stripScratchTableDeclarations } from './schema-scratch-tables.mjs';
import {
  annotateCircularForeignKeyExtraConfigs,
  promoteGeneratedSchemaArtifacts,
  repairCompositeForeignKeyArtifacts,
} from './schema-generated-artifacts.mjs';

// EI-18785808338338490: migration-internal scratch/backup tables (leading
// underscore or `bak_`) must never reach the application's ORM schema.
describe('stripScratchTableDeclarations', () => {
  const realTable = `export const potMembersInHarnessShared = harnessShared.table("pot_members", {
\tworkspaceId: text("workspace_id").notNull(),
\trevokedPubkeys: text("revoked_pubkeys").array().default([""]).notNull(),
});
`;
  const scratchTable = `export const potMembers686OrphansInHarnessShared = harnessShared.table("_pot_members_686_orphans", {
\tworkspaceId: text("workspace_id").notNull(),
\trevokedPubkeys: text("revoked_pubkeys").default([""]).notNull(),
});
`;
  const backupTable = `export const workItemTwinsBackupInHarnessShared = harnessShared.table("bak_20260813_work_item_physical_twins", {
\tworkspaceId: text("workspace_id").notNull(),
\tworkingUsers: bigint("working_users", { mode: "number" }).default([]).notNull(),
});
`;

  it('removes a leading-underscore table and reports it by name', () => {
    const { schema, stripped } = stripScratchTableDeclarations(realTable + scratchTable);
    expect(stripped).toEqual(['_pot_members_686_orphans']);
    expect(schema).not.toContain('_pot_members_686_orphans');
  });

  it('removes a bak_ migration backup and reports it by name', () => {
    const { schema, stripped } = stripScratchTableDeclarations(realTable + backupTable);
    expect(stripped).toEqual(['bak_20260813_work_item_physical_twins']);
    expect(schema).toBe(realTable);
  });

  it('leaves the real table byte-identical — including a LIKE-clone twin', () => {
    // The clone's columns are identical to the real table's, so a name-blind
    // implementation would take both. That is the whole trap this guards.
    const { schema } = stripScratchTableDeclarations(realTable + scratchTable);
    expect(schema).toBe(realTable);
  });

  it('is a no-op on a schema with no scratch tables', () => {
    const { schema, stripped } = stripScratchTableDeclarations(realTable);
    expect(stripped).toEqual([]);
    expect(schema).toBe(realTable);
  });

  it('survives nested parens, arrays and sql`` template literals in the block', () => {
    // A `)` inside a template literal must not close the balanced walk, and a
    // trailing `(table) => [...]` argument is part of the same statement.
    const gnarly = `export const scratchInHarnessShared = harnessShared.table("_scratch", {
\tid: text().primaryKey().notNull(),
\tmadeAt: bigint("made_at", { mode: "number" }).default(sql\`((EXTRACT(epoch FROM now()) * 1000))::bigint\`),
}, (table) => [
\tpgPolicy("p", { as: "permissive", for: "all", to: ["public"], using: sql\`(workspace_id = current_setting('app.workspace_id'::text, true))\` }),
\tprimaryKey({ columns: [table.id], name: "scratch_pkey"}),
]);
`;
    const { schema, stripped } = stripScratchTableDeclarations(gnarly + realTable);
    expect(stripped).toEqual(['_scratch']);
    expect(schema).toBe(realTable);
  });

  it('removes every migration-internal table when conventions are mixed', () => {
    const second = scratchTable.replace(/_pot_members_686_orphans/g, '_other_999_orphans');
    const { stripped } = stripScratchTableDeclarations(scratchTable + realTable + backupTable + second);
    expect(stripped).toEqual([
      '_pot_members_686_orphans',
      'bak_20260813_work_item_physical_twins',
      '_other_999_orphans',
    ]);
  });

  it('leaves an UNBALANCED block alone rather than corrupting the file', () => {
    const truncated = 'export const brokenInHarnessShared = harnessShared.table("_broken", {\n\tid: text(),\n';
    const { schema, stripped } = stripScratchTableDeclarations(truncated);
    expect(stripped).toEqual([]);
    expect(schema).toBe(truncated);
  });

  // The regression that motivated this: both drizzle-kit's source artifact and
  // the promoted application schema must stay clean. The package typechecks
  // both, even though runtime imports generated.ts.
  it('the committed schema artifacts carry no migration scratch or backup tables', () => {
    for (const artifact of ['schema.ts', 'generated.ts']) {
      const path = join(__dirname, 'schema', artifact);
      if (!existsSync(path)) continue; // generated artifacts may be absent in a fresh checkout
      const src = readFileSync(path, 'utf8');
      const { stripped } = stripScratchTableDeclarations(src);
      expect(stripped, artifact).toEqual([]);
    }
  });
});

describe('generated schema artifact fixes', () => {
  const importLine =
    'import { text, foreignKey } from "drizzle-orm/pg-core"\n';
  const table = (name: string, foreignName?: string) =>
    `export const ${name} = harnessShared.table("${name}", {\n` +
    `\tid: text("id").notNull(),\n` +
    `}, (table) => [\n` +
    (foreignName
      ? `\tforeignKey({ columns: [table.id], foreignColumns: [${foreignName}.id] }),\n`
      : '') +
    `]);\n`;

  it('types every table in a mutual composite-FK cycle and is idempotent', () => {
    const source = importLine + table('alpha', 'beta') + table('beta', 'alpha');
    const first = annotateCircularForeignKeyExtraConfigs(source);
    expect(first.circularTables).toEqual(['alpha', 'beta']);
    expect(first.schema.match(/: PgTableExtraConfigValue\[\] => \[/g)).toHaveLength(2);
    expect(first.schema.match(/type PgTableExtraConfigValue/g)).toHaveLength(1);

    const second = annotateCircularForeignKeyExtraConfigs(first.schema);
    expect(second).toEqual(first);
  });

  it('leaves an acyclic foreign key byte-identical', () => {
    const source = importLine + table('child', 'parent') + table('parent');
    expect(annotateCircularForeignKeyExtraConfigs(source)).toEqual({
      schema: source,
      circularTables: [],
    });
  });

  it('repairs composite FK order and full relation fields from PG metadata', () => {
    const schema = `export const datatypeRegistryInHarnessShared = harnessShared.table("datatype_registry", {
\tid: text().notNull(),
\tworkspaceId: text("workspace_id").notNull(),
}, (table) => [
\tprimaryKey({ columns: [table.id, table.workspaceId], name: "datatype_registry_pkey"}),
]);

export const triggerDeliveriesInHarnessShared = harnessShared.table("trigger_deliveries", {
\tworkspaceId: text("workspace_id").notNull(),
\tdatatypeId: text("datatype_id").notNull(),
}, (table) => [
\tforeignKey({
\t\t\tcolumns: [table.workspaceId, table.datatypeId],
\t\t\tforeignColumns: [datatypeRegistryInHarnessShared.id, datatypeRegistryInHarnessShared.workspaceId],
\t\t\tname: "trigger_deliveries_datatype_fk"
\t\t}),
]);
`;
    const relations = `export const triggerDeliveriesInHarnessSharedRelations = relations(triggerDeliveriesInHarnessShared, ({one}) => ({
\tdatatypeRegistryInHarnessShared: one(datatypeRegistryInHarnessShared, {
\t\tfields: [triggerDeliveriesInHarnessShared.workspaceId],
\t\treferences: [datatypeRegistryInHarnessShared.id]
\t}),
}));
`;
    const foreignKeys = [
      {
        constraintName: 'trigger_deliveries_datatype_fk',
        schemaName: 'harness_shared',
        tableName: 'trigger_deliveries',
        foreignSchemaName: 'harness_shared',
        foreignTableName: 'datatype_registry',
        columns: ['workspace_id', 'datatype_id'],
        foreignColumns: ['workspace_id', 'id'],
      },
    ];

    const repaired = repairCompositeForeignKeyArtifacts({ schema, relations, foreignKeys });
    expect(repaired.unresolved).toEqual([]);
    expect(repaired.schemaChanged).toBe(1);
    expect(repaired.relationsChanged).toBe(1);
    expect(repaired.schema).toContain(
      'foreignColumns: [datatypeRegistryInHarnessShared.workspaceId, datatypeRegistryInHarnessShared.id]',
    );
    expect(repaired.relations).toContain(
      'fields: [triggerDeliveriesInHarnessShared.workspaceId, triggerDeliveriesInHarnessShared.datatypeId]',
    );
    expect(repaired.relations).toContain(
      'references: [datatypeRegistryInHarnessShared.workspaceId, datatypeRegistryInHarnessShared.id]',
    );

    const second = repairCompositeForeignKeyArtifacts({
      schema: repaired.schema,
      relations: repaired.relations,
      foreignKeys,
    });
    expect(second).toEqual({
      schema: repaired.schema,
      relations: repaired.relations,
      schemaChanged: 0,
      relationsChanged: 0,
      unresolved: [],
    });
  });

  it('promotes both generated artifacts and removes their ignored intermediates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-schema-promote-'));
    try {
      const schemaPath = join(dir, 'schema.ts');
      const relationsPath = join(dir, 'relations.ts');
      writeFileSync(schemaPath, 'schema-body');
      writeFileSync(relationsPath, 'relations-body');

      const promoted = promoteGeneratedSchemaArtifacts({
        schemaPath,
        relationsPath,
        schemaDir: dir,
      });

      expect(readFileSync(promoted.generatedSchemaPath, 'utf8')).toBe('schema-body');
      expect(readFileSync(promoted.generatedRelationsPath!, 'utf8')).toBe('relations-body');
      expect(existsSync(schemaPath)).toBe(false);
      expect(existsSync(relationsPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
