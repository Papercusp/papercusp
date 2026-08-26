import { createFreshTestDb } from '@papercusp/test-config/pg';
import postgres from 'postgres';

const db = await createFreshTestDb({ prefix: 'micro' });
const sql = postgres(db.url, { max: 1, onnotice: () => {} });

await sql.unsafe('CREATE TABLE public.p(k int primary key, v jsonb)');
await sql.unsafe("INSERT INTO public.p VALUES (1,'{}'::jsonb)");

// A: param with explicit ::jsonb cast inside jsonb_build_object
await sql.unsafe(
  "UPDATE public.p SET v = COALESCE(v,'{}'::jsonb) || jsonb_build_object('_ce', $1::jsonb) WHERE k=1",
  [JSON.stringify({ a: 1 })],
);
console.log('A:', JSON.stringify(await sql`SELECT v, jsonb_typeof(v) AS t FROM public.p`));

// C: fully literal
await sql.unsafe(
  `UPDATE public.p SET v = '{}'::jsonb || jsonb_build_object('_ce', '{"a":3}'::jsonb) WHERE k=1`,
);
console.log('C:', JSON.stringify(await sql`SELECT v FROM public.p`));

// D: param cast outside build_object, merged with ||
await sql.unsafe(
  `UPDATE public.p SET v = COALESCE(v,'{}'::jsonb) || ($1::jsonb || jsonb_build_object('_ce2', 'x')) WHERE k=1`,
  [JSON.stringify({ b: 2 })],
);
console.log('D:', JSON.stringify(await sql`SELECT v FROM public.p`));

// E: EXACT closeAsCommitted shape with two params ($1 where, $2 evidence)
await sql.unsafe(
  `UPDATE public.p SET v = COALESCE(v,'{}'::jsonb) || jsonb_build_object('_completionEvidence', $2::jsonb) WHERE k=$1`,
  [1, JSON.stringify({ summary: 'v', filesChanged: ['src/fix.ts'] })],
);
console.log('E:', JSON.stringify(await sql`SELECT v FROM public.p`));
console.log('E typeof:', JSON.stringify(await sql`SELECT jsonb_typeof(v) AS t, v->'_completionEvidence' IS NOT NULL AS has_ev FROM public.p`));

await sql.end({ timeout: 5 });
await db.drop();
