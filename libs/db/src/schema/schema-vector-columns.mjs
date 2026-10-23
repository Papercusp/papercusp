/** Preserve PG's width-free vector type without Drizzle's required-width
 * vector builder. Used by the canonical schema projector, never by runtime DDL. */
export function repairUnconstrainedVectorColumns(schema) {
  let fixed = 0;
  const repaired = schema.replace(
    /^(\s*(?:[\w$]+|"[^"\n]+"|'[^'\n]+')\s*:\s*)vector\(\s*((?:"[^"\n]*"|'[^'\n]*')?)\s*\)/gm,
    (_match, prefix, name) => { fixed++; return `${prefix}unboundedVectorCustom(${name})`; },
  );
  if (!fixed) return { schema, fixed };
  const pgCoreImport = /import\s*\{([^}]+)\}\s*from\s*(["'])drizzle-orm\/pg-core\2;?/;
  if (!pgCoreImport.test(repaired)) throw new Error('Unconstrained vector projection requires the pg-core import');
  schema = repaired.replace(pgCoreImport, (statement, names) => {
    const imported = /\bcustomType\b/.test(names) ? statement : statement.replace('{', '{ customType,');
    if (/\bconst unboundedVectorCustom\b/.test(repaired)) return imported;
    return `${imported}\n\nconst unboundedVectorCustom = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: value => JSON.stringify(value),
  fromDriver: value => JSON.parse(value),
});`;
  });
  return { schema, fixed };
}
