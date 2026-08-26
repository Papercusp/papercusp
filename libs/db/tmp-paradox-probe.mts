import { createFreshTestDb } from '@papercusp/test-config/pg';
import postgres from 'postgres';

const db = await createFreshTestDb({ prefix: 'paradox' });
const sql = postgres(db.url, { max: 1, onnotice: () => {} });

await sql.unsafe('CREATE SCHEMA s');
await sql.unsafe('CREATE TABLE s.t1(x int)');

// A: multi-statement WITH explicit transaction
const batchTx = await sql.unsafe('BEGIN; CREATE TABLE s.t2(x int); COMMIT;').simple();
// B: single statement, extended protocol
await sql.unsafe('CREATE TABLE s.t3(x int)');
// C: multi-statement WITHOUT transaction
const batchPlain = await sql.unsafe('CREATE TABLE s.t4(x int); CREATE TABLE s.t5(x int);').simple();

console.log('batchTx commands:', JSON.stringify(batchTx.map((r: any) => r?.command)));
console.log('batchPlain commands:', JSON.stringify(batchPlain.map((r: any) => r?.command)));
console.log(
  'persisted:',
  JSON.stringify(await sql`SELECT tablename FROM pg_tables WHERE schemaname='s' ORDER BY tablename`),
);
console.log('db:', db.url.replace(/:\/\/[^@]*@/, '://***@'));

await sql.end({ timeout: 5 });
await db.drop();
