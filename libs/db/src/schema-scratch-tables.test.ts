import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs helper shared with pull-schema.mjs (a script, not TS)
import { stripScratchTableDeclarations } from './schema-scratch-tables.mjs';

// EI-18785808338338490: migration-internal scratch tables (leading underscore)
// must never reach the application's ORM schema.
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

  it('removes a leading-underscore table and reports it by name', () => {
    const { schema, stripped } = stripScratchTableDeclarations(realTable + scratchTable);
    expect(stripped).toEqual(['_pot_members_686_orphans']);
    expect(schema).not.toContain('_pot_members_686_orphans');
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

  it('removes every scratch table when several are present', () => {
    const second = scratchTable.replace(/_pot_members_686_orphans/g, '_other_999_orphans');
    const { stripped } = stripScratchTableDeclarations(scratchTable + realTable + second);
    expect(stripped).toEqual(['_pot_members_686_orphans', '_other_999_orphans']);
  });

  it('leaves an UNBALANCED block alone rather than corrupting the file', () => {
    const truncated = 'export const brokenInHarnessShared = harnessShared.table("_broken", {\n\tid: text(),\n';
    const { schema, stripped } = stripScratchTableDeclarations(truncated);
    expect(stripped).toEqual([]);
    expect(schema).toBe(truncated);
  });

  // The regression that motivated this: the committed schema must stay clean.
  it('the committed generated.ts carries no migration scratch tables', () => {
    const generated = join(__dirname, 'schema', 'generated.ts');
    if (!existsSync(generated)) return; // generated artifact may be absent in a fresh checkout
    const src = readFileSync(generated, 'utf8');
    const { stripped } = stripScratchTableDeclarations(src);
    expect(stripped).toEqual([]);
  });
});
