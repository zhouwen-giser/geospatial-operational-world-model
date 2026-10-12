import { createHash } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../packages/world-model-core/src/config.js';
import { canonicalizeMigrationSql,selectMigrationFiles } from './migrate.js';
import { applyRuntimeApi,checksum } from './business-storage/installer.js';

/** Established 086+ installations only. Never calls general migrate/bootstrap/account initialization. */
export async function upgradeFunctionalRepair(checkOnly=false) {
  const config=loadConfig(),pool=new pg.Pool({connectionString:config.databaseUrl,max:1,application_name:'gowm-functional-additive-upgrade'});
  const c=await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(hashtextextended('gowm-functional-087-089',0))");
    await c.query(checkOnly?'BEGIN READ ONLY':'BEGIN');
    await c.query("SET LOCAL lock_timeout='5s'");
    const files=selectMigrationFiles(await readdir('database/migrations'),89);
    const rows=(await c.query<{version:string;checksum:string}>('SELECT version,checksum FROM schema_migration ORDER BY version')).rows;
    if(rows.length<86 || rows.length>89 || rows.some((r,i)=>r.version!==files[i])) throw Error('CONTIGUOUS_086_TO_089_BASELINE_REQUIRED');
    const pending:Array<{file:string;sql:string;checksum:string}>=[];
    for(const [index,file] of files.entries()) {
      const sql=(await readFile(`database/migrations/${file}`,'utf8')).replaceAll(':ANALYSIS_SRID',String(config.analysisSrid))
        .replaceAll(':TRACKLET_MAX_TIME_GAP_MS',String(config.trackletMaxTimeGapMs)).replaceAll(':TRACKLET_MAX_DISTANCE_GAP_M',String(config.trackletMaxDistanceGapM))
        .replaceAll(':TRACKLET_MAX_REQUIRED_SPEED_MPS',String(config.trackletMaxRequiredSpeedMps));
      const hash=createHash('sha256').update(canonicalizeMigrationSql(sql)).digest('hex');
      if(rows[index]) { if(rows[index]!.checksum!==hash) throw Error('MIGRATION_CHECKSUM_MISMATCH: '+file); }
      else {
        if(index<86 || !/^BEGIN;[\s\S]*COMMIT;\s*$/.test(sql)) throw Error('ONLY_087_TO_089_APPEND_ALLOWED');
        pending.push({file,sql:sql.replace(/^BEGIN;/,'').replace(/COMMIT;\s*$/,''),checksum:hash});
      }
    }
    const contract=JSON.parse(await readFile('database/shared-business-storage/install-manifest.json','utf8'));
    const states=(await c.query("SELECT to_regclass('ugv_smpp.gowm_install_history') smpp,to_regclass('ugv_sdar.gowm_install_history') sdar")).rows[0];
    const nativeReady=Boolean(states.smpp&&states.sdar);
    if(nativeReady) for(const entry of [...contract.entries,...contract.overlays.filter((e:{family:string})=>e.family!=='GOWM_API')]) {
      const row=(await c.query(`SELECT checksum FROM ${entry.schema}.gowm_install_history WHERE family=$1 AND file=$2`,[entry.family,entry.file])).rows[0];
      if(row?.checksum!==(entry.generatedSha256??entry.sha256)) throw Error('NATIVE_BASELINE_CONFLICT: '+entry.family+'/'+entry.file);
    }
    // Refuse a new overlay mismatch before applying any core migrations.
    if(nativeReady) {
      const old=(await c.query("SELECT checksum FROM ugv_smpp.gowm_install_history WHERE family='GOWM_API' AND file='business_api_v2.sql'")).rows[0];
      if(old && old.checksum!==checksum(await readFile('database/shared-business-storage/overlays/business-api-v2.sql','utf8'))) throw Error('BUSINESS_API_CHECKSUM_CONFLICT');
    }
    if(!checkOnly) for(const m of pending) {await c.query(m.sql);await c.query('INSERT INTO schema_migration(version,checksum) VALUES($1,$2)',[m.file,m.checksum]);}
    await c.query('COMMIT');
    if(!checkOnly && nativeReady) await applyRuntimeApi(c);
    console.log(JSON.stringify({status:'PASS',checkOnly,[checkOnly?'pending':'applied']:pending.map(m=>m.file),
      nativeApi:nativeReady?'CHECKED_OR_APPLIED':'NOT_CONFIGURED',accountsInitialized:false,passwordsChanged:false,devicesInitialized:false}));
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
  finally{await c.query("SELECT pg_advisory_unlock(hashtextextended('gowm-functional-087-089',0))").catch(()=>{});c.release();await pool.end();}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.slice(2).some(a=>a!=='--check')) throw Error('Usage: functional-repair-upgrade [--check]');
  upgradeFunctionalRepair(process.argv.includes('--check')).catch((error:unknown)=>{
    console.error(JSON.stringify({event:'functional_upgrade_failed',code:(error as {code?:string}).code??'UPGRADE_FAILED',message:error instanceof Error?error.message:'upgrade failed'}));process.exitCode=1;
  });
}
