/**
 * Repair drizzle-kit's rendering of an empty PostgreSQL text-array default.
 *
 * PostgreSQL represents `DEFAULT '{}'` as an empty array, but drizzle-kit can
 * render that catalog value as `.array().default([""])`, which is an array
 * containing one empty string. Keep this transform separate from the CLI so
 * it can be regression-tested without connecting to the live database.
 *
 * @param {string} schema drizzle-kit's generated schema source
 * @returns {{ schema: string, fixed: number }} the repaired source and the
 *   number of broken defaults replaced
 */
export function repairEmptyArrayDefaults(schema) {
  const broken = /\.array\(\)\.default\(\[""\]\)/g;
  const fixed = schema.match(broken)?.length ?? 0;
  return {
    schema: schema.replace(broken, '.array().default([])'),
    fixed,
  };
}

/**
 * Repair drizzle-kit's rendering of a NON-empty text-array literal default.
 *
 * For `DEFAULT ARRAY['explicit'::text]` drizzle-kit treats the catalog value as
 * if it were the quoted `'{...}'` form and strips two characters from each end,
 * emitting `.array().default(["RAY['explicit'::tex"])` — a one-element array
 * holding a garbled string, so the TS schema states a default the database does
 * not have (migration 1638 `coord_entity_subscriptions.reasons`; the older
 * `capabilities` default ARRAY['*'::text] had the same rendering).
 *
 * The two clipped characters are `AR` at the front and the cast's last letter
 * plus `]` at the back. Only the `::text` cast is restored, because that is the
 * one case where the clipped letter is known (`::tex` → `::text`); the literal is
 * re-emitted verbatim as sql`ARRAY[...]` so element quoting and casts keep the
 * database's exact semantics. Anything else is left alone for the committed-file
 * guard in schema-defaults.test.ts to flag.
 *
 * @param {string} schema drizzle-kit's generated schema source
 * @returns {{ schema: string, fixed: number }} the repaired source and the
 *   number of defaults rewritten
 */
export function repairClippedArrayLiteralDefaults(schema) {
  const broken = /\.array\(\)\.default\(\["RAY\[([^"`$\\]*::tex)"\]\)/g;
  let fixed = 0;
  const repaired = schema.replace(broken, (_match, inner) => {
    fixed += 1;
    return `.array().default(sql\`ARRAY[${inner}t]\`)`;
  });
  return { schema: repaired, fixed };
}

/**
 * Drizzle folds the owned plan_runs sequence into bigserial and omits its
 * declaration. Restore the catalog options and the mirror's number-valued ID.
 * @param {string} schema
 * @param {{startWith:string, increment:string, minValue:string, maxValue:string, cache:string, cycle:boolean} | undefined} sequence
 * @returns {string}
 */
export function repairPlanRunsOwnedSequence(schema, sequence) {
  if (!sequence || schema.includes('harnessShared.sequence("plan_runs_id_seq"')) return schema;

  const serialColumn = /^(export const planRunsInHarnessShared = harnessShared\.table\("plan_runs", \{\n(?:[\t ].*\n)*?)\tid: bigserial\(\{ mode: "bigint" \}\)(?=\.(?:primaryKey|notNull)\(\))/m;
  return schema.replace(serialColumn, (_match, table) => {
    const { startWith, increment, minValue, maxValue, cache, cycle } = sequence;
    const declaration = 'export const planRunsIdSeqInHarnessShared = harnessShared.sequence("plan_runs_id_seq", {  ' +
      `startWith: ${JSON.stringify(startWith)}, increment: ${JSON.stringify(increment)}, ` +
      `minValue: ${JSON.stringify(minValue)}, maxValue: ${JSON.stringify(maxValue)}, ` +
      `cache: ${JSON.stringify(cache)}, cycle: ${cycle} })`;
    return `${declaration}\n\n${table}` +
      '\t// You can use { mode: "bigint" } if numbers are exceeding js number limitations\n' +
      '\tid: bigint({ mode: "number" }).default(sql`nextval(\'harness_shared.plan_runs_id_seq\'::regclass)`)';
  });
}

// A default whose content opens with a bare identifier call, optionally inside
// parentheses: `gen_random_uuid()`, `(gen_random_uuid())`, `now()`. A JS member
// call such as `Date.now()` does not match, because of the dot.
const RAW_SQL_CALL = /^\(*[A-Za-z_][A-Za-z0-9_]*\(/;

/**
 * Wrap SQL function-call defaults that drizzle-kit emitted as raw JS.
 *
 * For a text column with `DEFAULT gen_random_uuid()::text`, drizzle-kit drops
 * the cast and emits `.default((gen_random_uuid()))`. That is a call to an
 * undefined JS function, so importing generated.ts throws
 * `ReferenceError: gen_random_uuid is not defined` and every consumer of the
 * schema fails to load (WI-6554700010011854, migration 1498). The older
 * quoted-default repair in pull-schema.mjs only wraps content containing `\'`,
 * so a call with no string literal slipped through.
 *
 * Walks each `.default(` to its balanced close, skipping backtick regions so
 * an existing sql`...` is never rewrapped.
 *
 * @param {string} schema drizzle-kit's generated schema source
 * @returns {{ schema: string, fixed: number }} the repaired source and the
 *   number of defaults wrapped in sql``
 */
export function repairRawSqlCallDefaults(schema) {
  const marker = '.default(';
  const out = [];
  let fixed = 0;
  let i = 0;
  while (i < schema.length) {
    const idx = schema.indexOf(marker, i);
    if (idx === -1) {
      out.push(schema.slice(i));
      break;
    }
    out.push(schema.slice(i, idx));
    const start = idx + marker.length;
    let depth = 1;
    let j = start;
    while (j < schema.length && depth > 0) {
      const ch = schema[j];
      if (ch === '`') {
        const close = schema.indexOf('`', j + 1);
        if (close === -1) {
          j = schema.length;
          break;
        }
        j = close + 1;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      j++;
    }
    if (depth !== 0) {
      // Unbalanced tail: leave it untouched rather than guess.
      out.push(schema.slice(idx));
      break;
    }
    const inner = schema.slice(start, j - 1);
    if (!inner.includes('`') && RAW_SQL_CALL.test(inner.trim())) {
      out.push(`${marker}sql\`${inner.replace(/\\'/g, "'")}\`)`);
      fixed++;
    } else {
      out.push(schema.slice(idx, j));
    }
    i = j;
  }
  return { schema: out.join(''), fixed };
}
