import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import pg from 'pg';
import {verifyHistoricalArtifact} from './capability-artifact-e2e.js';
import {verifyScopedSituation} from './capability-situation-e2e.js';
import {verifyIngestProfiles} from './capability-profile-e2e.js';
import {fixtureIdentity,seedFixtureFoundation,insertPosition} from './history-concurrency-fixture.js';
import {verifyLogicalRecovery} from './capability-operations-e2e.js';

const url=process.env.DATABASE_ADMIN_URL??process.env.DATABASE_URL;if(!url)throw Error('DATABASE_ADMIN_URL required; PostgreSQL gate cannot skip');
const root=new URL(url);root.pathname='/postgres';const admin=new pg.Pool({connectionString:root.href,max:1}),run=promisify(execFile);
const results=[];
try {
 await run(process.execPath,['scripts/verify-capability-completion-freeze.mjs']);
 for(const baseline of [0,89]){
  const database='gowm_capability_ci_'+randomUUID().replaceAll('-',''),target=new URL(url);target.pathname='/'+database;
  const env={...process.env,DATABASE_URL:target.href,STAS_DB_PASSWORD:'capability-disposable-stas',ANALYSIS_SRID:'32650'};
  const exec=async(args:string[])=>{try{const r=await run(process.execPath,['--import','tsx',...args],{env,maxBuffer:8*1024*1024});process.stdout.write(r.stdout);}catch(e){if(e&&typeof e==='object'&&'stderr'in e)process.stderr.write(String(e.stderr));throw e;}};
  const c=new pg.Client({connectionString:target.href});await admin.query(`CREATE DATABASE "${database}"`);
  try {
   await c.connect();await exec(['--input-type=module','-e',`import {migrate} from './scripts/migrate.ts';await migrate({maximumMigrationNumber:${baseline||93}});`]);
   if(baseline){
    await c.query("INSERT INTO world_object(id,data_scope_key,object_type,properties) VALUES('retained-capability-device','default','UGV','{}')");
    const before=(await c.query("SELECT to_jsonb(w) v FROM world_object w WHERE id='retained-capability-device'")).rows[0].v;
    const legacy=new pg.Pool({connectionString:target.href,max:1}),fixtures=[fixtureIdentity(randomUUID()),fixtureIdentity(randomUUID())];
    try{for(const [index,f]of fixtures.entries()){
     await seedFixtureFoundation(legacy,f);await c.query("UPDATE world_object SET object_type='UGV' WHERE id=$1",[f.targetKey]);
     for(let i=1;i<=index+1;i++)await insertPosition(legacy,f,{ordinal:i,phenomenonTime:`2026-08-30T00:00:0${i}Z`,x:448000+i,subjectType:'UGV'});
     await c.query("UPDATE world_observation SET status='projected',projected_at=clock_timestamp() WHERE data_scope_key=$1",[f.dataScopeKey]);
     await c.query(`INSERT INTO world_object_state(object_id,state,confidence,observed_at,received_at,source,source_observation_id,version)
      VALUES($1,'{}',1,clock_timestamp(),clock_timestamp(),$2,$3,nextval('world_version_seq'))`,[f.targetKey,f.sourceKey,`history-queue-position-1-${f.targetKey}`]);
     await c.query(`INSERT INTO world_object_geometry(object_id,geometry,h3_r7,h3_r8,h3_r9,h3_r10)
      SELECT $1,g,h3_latlng_to_cell(g,7),h3_latlng_to_cell(g,8),h3_latlng_to_cell(g,9),h3_latlng_to_cell(g,10)
      FROM(SELECT ST_SetSRID(ST_MakePoint(116.4,39.9),4326) g) x`,[f.targetKey]);
    }}finally{await legacy.end();}
    const legacyBefore=(await c.query('SELECT to_jsonb(t) v FROM public.situation_cell t ORDER BY h3_index,resolution')).rows;
    await exec(['scripts/capability-completion-upgrade.ts','--check']);
    await exec(['scripts/capability-completion-upgrade.ts','--projection-workers-stopped']);
    await exec(['scripts/capability-completion-upgrade.ts','--projection-workers-stopped']);
    assert.deepEqual((await c.query("SELECT to_jsonb(w) v FROM world_object w WHERE id='retained-capability-device'")).rows[0].v,before);
    assert.deepEqual((await c.query('SELECT to_jsonb(t) v FROM public.situation_cell t ORDER BY h3_index,resolution')).rows,legacyBefore);
    for(const [index,f]of fixtures.entries()){
     const rows=(await c.query('SELECT observation_count,vehicle_count FROM gowm_situation.cell WHERE data_scope_key=$1 ORDER BY resolution',[f.dataScopeKey])).rows;
     assert.equal(rows.length,4);for(const r of rows){assert.equal(Number(r.observation_count),index+1);assert.equal(Number(r.vehicle_count),1);}
    }
   }
   const artifact=await verifyHistoricalArtifact(target.href),situation=await verifyScopedSituation(target.href),profile=await verifyIngestProfiles(target.href);
   const operations=baseline===0?await verifyLogicalRecovery(target.href,'default'):undefined;
   results.push({baseline,status:'PASS',artifact,situation,profile,operations});
  }finally{await c.end().catch(()=>{});await admin.query(`DROP DATABASE "${database}"`);}
 }
 const report={status:'PASS',migrationHead:'093',results,externalBusinessAcceptance:'NOT_RUN',remoteDeployment:'NOT_RUN'};
 await mkdir('reports/capability-completion-2026-10-12',{recursive:true});await writeFile('reports/capability-completion-2026-10-12/postgres.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await admin.end();}
