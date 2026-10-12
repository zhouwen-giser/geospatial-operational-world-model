import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import pg from 'pg';
const source=process.env.DATABASE_ADMIN_URL??process.env.DATABASE_URL;
if(!source) throw Error('DATABASE_ADMIN_URL required: this required gate cannot skip PostgreSQL');
const run=promisify(execFile),adminUrl=new URL(source);adminUrl.pathname='/postgres';
const admin=new pg.Pool({connectionString:adminUrl.href,max:1});
const results:unknown[]=[];
await run(process.execPath,['scripts/verify-functional-repair-freeze.mjs']);
try {
  for(const baseline of process.argv.includes('--fresh-only')?[0]:[0,86]) {
    const database=`gowm_functional_ci_${baseline}_${randomUUID().replaceAll('-','')}`,target=new URL(source);target.pathname='/'+database;
    const env={...process.env,DATABASE_URL:target.href,ANALYSIS_SRID:'32648',STAS_DB_PASSWORD:'functional-ci-disposable-stas'};
    const c=new pg.Client({connectionString:target.href});let created=false;
    const exec=async(args:string[])=>{const r=await run(process.execPath,['--import','tsx',...args],{env,maxBuffer:8*1024*1024});process.stdout.write(r.stdout);return r.stdout;};
    const migrate=(maximum:number)=>exec(['--input-type=module','-e',`import {migrate} from './scripts/migrate.ts';await migrate({maximumMigrationNumber:${maximum}});`]);
    try {
      await admin.query(`CREATE DATABASE "${database}"`);created=true;await c.connect();
      let before:unknown;
      if(baseline) {
        await migrate(86);await c.query('CREATE EXTENSION vector WITH SCHEMA public');
        // The retained baseline is locked to bytes from the previously released archive,
        // including every old native migration and overlay; the new installer is not used.
        const contract=JSON.parse(await readFile('database/shared-business-storage/install-manifest.json','utf8'));
        const lock=JSON.parse(await readFile('database/functional-repair-freeze-lock.json','utf8'));
        for(const schema of ['ugv_smpp','ugv_sdar']) await c.query(`CREATE SCHEMA ${schema};CREATE TABLE ${schema}.gowm_install_history(family text NOT NULL,file text NOT NULL,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(family,file))`);
        for(const item of [...contract.entries,...contract.overlays.filter((e:{family:string})=>e.family!=='GOWM_API')]) {
          const path='database/shared-business-storage/'+(item.generatedPath??item.path),sql=await readFile(path,'utf8');
          const digest=createHash('sha256').update(sql).digest('hex');
          assert.equal(lock.nativeSql.find((e:{path:string})=>e.path===path)?.sha256,digest);
          await c.query('BEGIN');try{await c.query(`SET LOCAL search_path=${item.schema},public,pg_catalog`);await c.query(sql);
            await c.query(`INSERT INTO ${item.schema}.gowm_install_history(family,file,checksum) VALUES($1,$2,$3)`,[item.family,item.file,digest]);await c.query('COMMIT');
          }catch(error){await c.query('ROLLBACK');throw error;}
        }
        await c.query("INSERT INTO world_object(id,data_scope_key,object_type,properties) VALUES('ugv:ugv','default','UGV','{\"name\":\"Retained UGV\"}')");
        await c.query("INSERT INTO gowm_device.device(device_id,data_scope_key,identifier_namespace,device_identifier,device_name,device_type) VALUES('ugv:ugv','default','ugv','ugv','Retained UGV','UGV')");
        await c.query("INSERT INTO gowm_device.device_service_binding(data_scope_key,device_id,smpp_service_key,provider_id,resource_id,sdar_service_key,sdar_mcp_server_id,agent_profile_id) VALUES('default','ugv:ugv','functional-smpp','ugv','functional-resource','functional-sdar','functional-mcp','functional-profile')");
        await c.query("INSERT INTO world_event(event_type,subject_type,subject_id,event_time,world_version,correlation_id,causation_id,data_scope_key) VALUES('retained.event','UGV','ugv:ugv',clock_timestamp(),1,'retained','retained','default')");
        // Original managed credentials are cluster-wide and created by the fresh gate.
        // Their password hashes and the old binding/objects/events must survive upgrade.
        before=(await c.query(`SELECT jsonb_build_object('world',(SELECT jsonb_agg(w) FROM world_object w),'devices',(SELECT jsonb_agg(d) FROM gowm_device.device d),
          'bindings',(SELECT jsonb_agg(b) FROM gowm_device.device_service_binding b),'events',(SELECT jsonb_agg(e) FROM world_event e),
          'passwords',(SELECT jsonb_agg(x ORDER BY rolname) FROM (SELECT rolname,rolpassword FROM pg_authid WHERE rolname IN ('ugv_smpp_app','ugv_sdar_app')) x)) v`)).rows[0].v;
        await exec(['scripts/functional-repair-upgrade.ts','--check']);await exec(['scripts/functional-repair-upgrade.ts']);await exec(['scripts/functional-repair-upgrade.ts']);
        assert.deepEqual((await c.query(`SELECT jsonb_build_object('world',(SELECT jsonb_agg(w) FROM world_object w),'devices',(SELECT jsonb_agg(d) FROM gowm_device.device d),
          'bindings',(SELECT jsonb_agg(b) FROM gowm_device.device_service_binding b),'events',(SELECT jsonb_agg(e) FROM world_event e),
          'passwords',(SELECT jsonb_agg(x ORDER BY rolname) FROM (SELECT rolname,rolpassword FROM pg_authid WHERE rolname IN ('ugv_smpp_app','ugv_sdar_app')) x)) v`)).rows[0].v,before);
      } else await migrate(89);
      await exec(['scripts/capability-completion-upgrade.ts','--projection-workers-stopped']);
      const output=await exec(['validation/scripts/functional-repair-e2e.ts']);
      const records=output.trim().split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l));
      const cases=records.find(r=>r.gate==='FUNCTIONAL_REPAIR_REAL_POSTGRES')?.cases;
      const nativeCases=records.find(r=>r.gate==='NATIVE_SDK_REGRESSION')?.cases;
      assert.ok(cases?.length>=15&&nativeCases===42,'required real-Postgres cases may not skip');
      results.push({baseline,status:'PASS',retainedRowsAndPasswordsStable:baseline===86?true:'NOT_APPLICABLE',
        cases,nativeSdkRegressionCases:nativeCases,gate:'REAL_POSTGRES_FIXTURE_NOT_EXTERNAL_ACCEPTANCE'});
    }catch(error){
      if(error && typeof error==='object' && 'stderr' in error) process.stderr.write(String(error.stderr));
      throw error;
    }finally{await c.end().catch(()=>{});if(created)await admin.query(`DROP DATABASE "${database}"`);}
  }
  const report={status:'PASS',migrationHead:'093',evidence:'LOCAL_REAL_POSTGRES_NOT_ONSITE_OR_EXTERNAL_ACCEPTANCE',results};
  await mkdir('reports/functional-repair-2026-10-12',{recursive:true});await writeFile('reports/functional-repair-2026-10-12/postgres.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{await admin.end();}
