import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import pg from "pg";
import { GroundingCatalogRepository } from "../../services/providers/grounding-catalog-provider/src/repository.js";
import { PostgresPlatformValidationAuthority } from "../../services/providers/platform-validation-provider/src/postgres-authority.js";
import type { PlatformCommonDefinitionsReferenceKey as ReferenceKey } from "../../packages/platform/contract-runtime/src/index.js";

const source=process.env.DATABASE_ADMIN_URL;
if(!source) throw new Error("DATABASE_ADMIN_URL must target an isolated test server");
const adminUrl=new URL(source); adminUrl.pathname="/postgres";
const admin=new pg.Pool({connectionString:adminUrl.toString(),max:1});
const run=promisify(execFile);
try {
  for(const baseline of [0,76]) {
    const suffix=randomUUID().replaceAll("-","");
    const database=`gowm_world_catalog_ci_${suffix}`;
    const target=new URL(source); target.pathname=`/${database}`;
    const roles:string[]=[], pools:pg.Pool[]=[];
    const connectionClosures:Promise<void>[]=[];
    const openPool=(connectionString:string,max:number)=>{
      const pool=new pg.Pool({connectionString,max});
      pool.on("connect",client=>{
        connectionClosures.push(new Promise<void>(resolve=>client.once("end",()=>resolve())));
      });
      pools.push(pool);
      return pool;
    };
    const directory=await mkdtemp("/dev/shm/gowm-world-catalog-");
    let created=false;
    const env={...process.env,DATABASE_URL:target.toString(),ANALYSIS_SRID:"32648",STAS_DB_PASSWORD:"catalog-isolated-stas"};
    const migrate=async(maximum:number)=>run(process.execPath,["--import","tsx","--input-type=module","-e",
      `import {migrate} from './scripts/migrate.ts'; await migrate({maximumMigrationNumber:${maximum}});`],{env,maxBuffer:4*1024*1024});
    try {
      await admin.query(`CREATE DATABASE "${database}"`); created=true;
      const setup=openPool(target.toString(),4);
      await migrate(baseline||77);
      const ledger=(await setup.query("SELECT version,checksum FROM schema_migration ORDER BY version")).rows;
      await setup.query("INSERT INTO data_scope(scope_key,operational_domain) VALUES ('catalog-a','TEST'),('catalog-b','TEST')");
      const seed=async(id:string,scope="catalog-a")=>{
        await setup.query("INSERT INTO world_object(id,object_type,data_scope_key,properties) VALUES ($1,'UGV',$2,'{}')",[id,scope]);
        await setup.query("INSERT INTO world_object_state(object_id,version,source) VALUES ($1,812,'catalog-ci')",[id]);
        return (await setup.query("SELECT reference_key FROM world_reference_identity WHERE internal_id=$1 AND entity_kind='WORLD_OBJECT'",[id])).rows[0].reference_key as string;
      };
      const ref=await seed("catalog-ci-object");
      const foreign=await seed("catalog-ci-foreign","catalog-b");
      const concurrentRef=baseline?await seed("catalog-ci-concurrent"):undefined;
      const legacyRef=baseline?await seed("catalog-ci-legacy"):undefined;
      if(legacyRef) await setup.query("INSERT INTO world_reference_descriptor_version(reference_key,data_scope_key,reference_type,display_name,content_hash) VALUES ($1,'catalog-a','UGV','Legacy authoritative label','sha256:'||repeat('a',64))",[legacyRef]);
      const oldState=(await setup.query("SELECT * FROM world_object_state WHERE object_id='catalog-ci-object'")).rows;
      const oldDescriptors=(await setup.query("SELECT * FROM world_reference_descriptor_version ORDER BY descriptor_version")).rows;
      await migrate(77); await migrate(77);
      assert.deepEqual((await setup.query("SELECT version,checksum FROM schema_migration ORDER BY version")).rows.slice(0,ledger.length),ledger);
      assert.deepEqual((await setup.query("SELECT * FROM world_object_state WHERE object_id='catalog-ci-object'")).rows,oldState);
      assert.deepEqual((await setup.query("SELECT * FROM world_reference_descriptor_version ORDER BY descriptor_version")).rows,oldDescriptors);
      const login=async(kind:string,membership:string)=>{
        const role=`catalog_${kind}_${suffix}`,password=randomUUID();
        await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`); roles.push(role);
        await admin.query(`GRANT ${membership} TO "${role}"`);
        const url=new URL(target); url.username=role; url.password=password;
        const pool=openPool(url.toString(),2);
        return {url:url.toString(),pool};
      };
      const reader=await login("reader","gowm_reference_service");
      const validator=await login("validator","platform_validation_provider");
      const operator=await login("operator","gowm_reference_catalog_operator");
      assert.equal((await reader.pool.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper,false);
      const repository=new GroundingCatalogRepository({pool:reader.pool,cursorSecret:"catalog-ci-secret-no-production-identity"});
      const authority=new PostgresPlatformValidationAuthority(validator.pool);
      const read=async(id=ref)=>repository.execute("reference.get",{referenceKey:{namespace:"gowm",kind:"WORLD_OBJECT",id,version:"1"}},
        {dataScopeKey:"catalog-a"},10000);
      if(baseline) await assert.rejects(()=>read(),{code:"SCOPE_DENIED"});
      const listFile=`${directory}/references.json`; await writeFile(listFile,JSON.stringify([ref]));
      const cli=async(extra:string[]=[],overrides:Record<string,string>={})=>{
        const result=await run(process.execPath,["--import","tsx","scripts/world-object-catalog-backfill.ts",
          "--scope","catalog-a","--references",listFile,...extra],
          {env:{...env,DATABASE_URL:operator.url,...overrides},maxBuffer:1024*1024});
        return JSON.parse(result.stdout) as Record<string,any>;
      };
      const dry=await cli(); assert.equal(dry.mode,"DRY_RUN");
      assert.equal(dry.items[0].action,baseline?"PROJECT":"NOOP_CURRENT");
      assert.deepEqual((await setup.query("SELECT * FROM world_reference_descriptor_version ORDER BY descriptor_version")).rows,oldDescriptors);
      await assert.rejects(()=>cli(["--apply"]));
      if(legacyRef) {
        const legacy=(await operator.pool.query("SELECT plan_world_object_catalog_backfill('catalog-a',$1::text[]) plan",[[legacyRef]])).rows[0].plan;
        assert.equal(legacy.items[0].action,"NOOP_LEGACY");
      }
      if(concurrentRef) {
        const plan=(await operator.pool.query("SELECT plan_world_object_catalog_backfill('catalog-a',$1::text[]) plan",[[concurrentRef]])).rows[0].plan;
        const applyOnce=async()=>{
          const c=await operator.pool.connect();
          try {
            await c.query("BEGIN"); await c.query("SELECT set_config('gowm.reference_catalog_allow_apply','YES',true)");
            const result=await c.query("SELECT apply_world_object_catalog_backfill('catalog-a',$1::text[],$2) result",[[concurrentRef],plan.planHash]);
            await c.query("COMMIT"); return result.rows[0].result.applied;
          } catch(error) { await c.query("ROLLBACK"); throw error; } finally {c.release();}
        };
        const attempts=await Promise.allSettled([applyOnce(),applyOnce()]);
        assert.equal(attempts.filter(value=>value.status==='fulfilled' && value.value===1).length,1);
        assert.equal(attempts.filter(value=>value.status==='rejected' && value.reason.code==='40001').length,1);
        assert.equal((await setup.query("SELECT count(*)::int n FROM world_reference_descriptor_version WHERE reference_key=$1",[concurrentRef])).rows[0].n,1);
      }
      await assert.rejects(()=>cli(["--apply"],{GOWM_REFERENCE_CATALOG_ALLOW_DB_MUTATION:"YES",
        GOWM_REFERENCE_CATALOG_EXPECTED_DB_FINGERPRINT:"sha256:wrong",GOWM_REFERENCE_CATALOG_EXPECTED_PLAN_HASH:dry.planHash}));
      const applied=await cli(["--apply"],{GOWM_REFERENCE_CATALOG_ALLOW_DB_MUTATION:"YES",
        GOWM_REFERENCE_CATALOG_EXPECTED_DB_FINGERPRINT:dry.databaseFingerprint,
        GOWM_REFERENCE_CATALOG_EXPECTED_PLAN_HASH:dry.planHash});
      assert.equal(applied.applied,baseline?1:0);
      const output=await read();
      const key=(output.output as {referenceKey:ReferenceKey}).referenceKey;
      assert.equal(key.id,ref); assert.equal(key.version,"812");
      assert.equal((await authority.resolveReferences([{referenceKey:key}],{dataScopeKey:"catalog-a"}))[0]?.snapshotStatus,"CURRENT");
      assert.match((output.output as {displayName:string}).displayName,/^Unnamed WORLD_OBJECT \[wrf_/);
      const counts=async()=>(await setup.query("SELECT (SELECT count(*) FROM world_reference_descriptor_version WHERE reference_key=$1)::int descriptors,(SELECT count(*) FROM world_reference_name WHERE reference_key=$1)::int names",[ref])).rows[0];
      const beforeGrowth=await counts();
      await setup.query("DO $$ BEGIN FOR n IN 813..1812 LOOP UPDATE world_object_state SET version=n,updated_at=clock_timestamp() WHERE object_id='catalog-ci-object'; END LOOP; END $$");
      assert.deepEqual(await counts(),beforeGrowth,"1000 state samples must not append catalog rows");
      const currentKey=((await read()).output as {referenceKey:ReferenceKey}).referenceKey;
      assert.equal(currentKey.version,"1812");
      assert.equal((await authority.resolveReferences([{referenceKey:key}],{dataScopeKey:"catalog-a"}))[0]?.snapshotStatus,"STALE");
      assert.equal((await authority.resolveReferences([{referenceKey:currentKey}],{dataScopeKey:"catalog-a"}))[0]?.snapshotStatus,"CURRENT");
      await assert.rejects(()=>read(foreign),{code:"SCOPE_DENIED"});
      for(const table of ["world_reference_identity","world_reference_descriptor_version","world_object_catalog_projection"]) {
        await assert.rejects(()=>reader.pool.query(`SELECT * FROM public.${table} LIMIT 0`),{code:"42501"});
      }
      await assert.rejects(()=>operator.pool.query("SELECT plan_world_object_catalog_backfill('catalog-a',$1::text[])",[[foreign]]),{code:"42501"});
      await setup.query("UPDATE world_object SET deleted_at=clock_timestamp() WHERE id='catalog-ci-foreign'");
      await assert.rejects(()=>operator.pool.query("SELECT plan_world_object_catalog_backfill('catalog-b',$1::text[])",[[foreign]]),{code:"42501"});
      const noop=await cli();
      const concurrent=await Promise.all([cli(["--apply"],{GOWM_REFERENCE_CATALOG_ALLOW_DB_MUTATION:"YES",GOWM_REFERENCE_CATALOG_EXPECTED_DB_FINGERPRINT:noop.databaseFingerprint,GOWM_REFERENCE_CATALOG_EXPECTED_PLAN_HASH:noop.planHash}),
        cli(["--apply"],{GOWM_REFERENCE_CATALOG_ALLOW_DB_MUTATION:"YES",GOWM_REFERENCE_CATALOG_EXPECTED_DB_FINGERPRINT:noop.databaseFingerprint,GOWM_REFERENCE_CATALOG_EXPECTED_PLAN_HASH:noop.planHash})]);
      assert.ok(concurrent.every(result=>result.applied===0)); assert.deepEqual(await counts(),beforeGrowth);
      const immutable=(await setup.query("SELECT * FROM world_reference_descriptor_version WHERE reference_key=$1 ORDER BY descriptor_version",[ref])).rows;
      // Normal metadata writer updates state version in the same transaction.
      await setup.query("BEGIN; UPDATE world_object_state SET version=1813 WHERE object_id='catalog-ci-object'; UPDATE world_object SET properties='{\"name\":\"Catalog vehicle\"}' WHERE id='catalog-ci-object'; COMMIT");
      assert.equal(((await read()).output as {displayName:string}).displayName,"Catalog vehicle");
      assert.equal((await counts()).descriptors,beforeGrowth.descriptors+1);
      await setup.query("UPDATE world_object SET properties=properties WHERE id='catalog-ci-object'");
      assert.equal((await counts()).descriptors,beforeGrowth.descriptors+1);
      assert.deepEqual((await setup.query("SELECT * FROM world_reference_descriptor_version WHERE reference_key=$1 ORDER BY descriptor_version",[ref])).rows.slice(0,immutable.length),immutable);
      await setup.query("SELECT rebuild_reference_search_projection('catalog-a')");
      assert.equal((await setup.query("SELECT count(*)::int n FROM reference_search_projection WHERE reference_key=$1 AND search_kind='DISPLAY_LABEL'",[ref])).rows[0].n,0);
      const scoped=await reader.pool.connect();
      try {
        await scoped.query("BEGIN");
        await scoped.query("SELECT set_config('gowm.data_scope_key','catalog-a',true)");
        assert.equal((await scoped.query("SELECT reference_key_value->>'version' version FROM gowm_reference_v1.identity WHERE reference_key=$1",[ref])).rows[0]?.version,"1813");
        await scoped.query("COMMIT");
      } finally { scoped.release(); }
      const retired=await seed("catalog-ci-retired");
      await setup.query("INSERT INTO world_reference_retirement(reference_key,reason,receipt_ref) VALUES ($1,'CI retirement','urn:ci:retirement')",[retired]);
      await assert.rejects(()=>operator.pool.query("SELECT plan_world_object_catalog_backfill('catalog-a',$1::text[])",[[ref,retired]]),{code:"42501"});
      console.log(JSON.stringify({status:"PASS",baseline,migration:77,reference:ref,nonSuperuser:true,
        getAndValidation:"PASS",oldReferenceStale:"PASS",backfillDefaultDryRun:"PASS",scopeAndRetirement:"PASS",
        concurrentIdempotence:"PASS",metadataAndSearchRebuild:"PASS",sampleUpdates:1000,catalogRowsBefore:beforeGrowth,catalogRowsAfterSamples:beforeGrowth,catalogRowsAfterMetadata:await counts()}));
    } finally {
      await Promise.all(pools.map(pool=>pool.end()));
      // pg-pool can resolve end() before idle clients emit their final end event.
      // Wait for socket closure before dropping the database; FORCE can otherwise
      // send 57P01 to an idle client and trigger an unhandled pool error after PASS.
      await Promise.all(connectionClosures);
      if(created) await admin.query(`DROP DATABASE "${database}"`);
      for(const role of roles) await admin.query(`DROP ROLE "${role}"`);
      await rm(directory,{recursive:true,force:true});
    }
  }
} finally { await admin.end(); }
