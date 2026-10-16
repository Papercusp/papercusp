import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const migration=readFileSync(path.join(HERE,'..','sql','1009-hosted-workspace-reverse-connectors.sql'),'utf8');
let db:MigratedTestDb; let sql:Sql;

async function asRole<T>(role:string,fn:(tx:TransactionSql)=>Promise<T>):Promise<T>{return sql.begin(async(tx)=>{await tx.unsafe(`SET LOCAL ROLE ${role}`);return fn(tx);}) as Promise<T>;}

beforeAll(async()=>{
  db=await createFreshTestDb({prefix:'hostedconnector1009'}); sql=postgres(db.url,{max:1,onnotice:()=>{}});
  await sql.unsafe(`
    CREATE SCHEMA papercusp_auth; CREATE SCHEMA harness_shared;
    DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['hosted_owner','hosted_service','hosted_app','harness_app','harness_zero','harness_admin'] LOOP
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',r); END IF;
      -- The private-PG admin can itself be one of these roles.
      IF r <> current_user THEN EXECUTE format('GRANT %I TO %I',r,current_user); END IF;
    END LOOP; END $$;
    CREATE TABLE harness_shared.workspace_hosts(workspace_id text NOT NULL,id text NOT NULL,PRIMARY KEY(workspace_id,id));
    CREATE TABLE harness_shared.customer_workspaces(workspace_id text NOT NULL,id text NOT NULL,organization_id text NOT NULL,workspace_host_id text NOT NULL,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,organization_id,id),FOREIGN KEY(workspace_id,workspace_host_id) REFERENCES harness_shared.workspace_hosts(workspace_id,id));
  `);
  await sql.unsafe(migration);
  await sql`INSERT INTO harness_shared.workspace_hosts VALUES ('control','host-1')`;
  await sql`INSERT INTO harness_shared.customer_workspaces VALUES ('control','workspace-1','org-1','host-1')`;
},120_000);
afterAll(async()=>{await sql?.end({timeout:5}).catch(()=>{});await db?.drop().catch(()=>{});});

describe('migration 1009 — hosted workspace reverse connectors',()=>{
  it('is idempotent and keeps both relations hosted-owner-owned behind FORCE RLS',async()=>{
    await sql.unsafe(migration);
    const rows=await sql<{name:string;owner:string;rls:boolean;force:boolean}[]>`SELECT c.relname name,r.rolname owner,c.relrowsecurity rls,c.relforcerowsecurity force FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='papercusp_auth' AND c.relname IN ('hosted_workspace_connectors','hosted_workspace_connector_tickets') ORDER BY c.relname`;
    expect(rows).toEqual([
      {name:'hosted_workspace_connector_tickets',owner:'hosted_owner',rls:true,force:true},
      {name:'hosted_workspace_connectors',owner:'hosted_owner',rls:true,force:true},
    ]);
  });

  it('admits service-only state and atomically consumes a hash-only ticket once',async()=>{
    const hash='a'.repeat(64); const ticket='b'.repeat(64);
    await asRole('hosted_service',async(tx)=>{
      await tx`INSERT INTO papercusp_auth.hosted_workspace_connectors(control_workspace_id,organization_id,customer_workspace_id,host_id,route_label,generation,credential_hash,state,transport) VALUES('control','org-1','workspace-1','host-1','alpha',1,${hash},'active','websocket')`;
      await tx`INSERT INTO papercusp_auth.hosted_workspace_connector_tickets(ticket_hash,kind,control_workspace_id,organization_id,customer_workspace_id,host_id,route_label,generation,user_id,hosted_session_id,audience,transport,issued_at,expires_at) VALUES(${ticket},'session','control','org-1','workspace-1','host-1','alpha',1,'user-1','session-1','workspace-operator','websocket',now(),now()+interval '1 minute')`;
      const first=await tx`UPDATE papercusp_auth.hosted_workspace_connector_tickets SET consumed_at=now() WHERE ticket_hash=${ticket} AND consumed_at IS NULL RETURNING ticket_hash`;
      const second=await tx`UPDATE papercusp_auth.hosted_workspace_connector_tickets SET consumed_at=now() WHERE ticket_hash=${ticket} AND consumed_at IS NULL RETURNING ticket_hash`;
      expect(first).toHaveLength(1);expect(second).toHaveLength(0);
    });
    await expect(asRole('hosted_app',(tx)=>tx`SELECT * FROM papercusp_auth.hosted_workspace_connectors`)).rejects.toThrow(/permission denied/);
  });
});
