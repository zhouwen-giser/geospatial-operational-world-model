import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {loadConfig} from '../packages/world-model-core/src/config.js';
import {canonicalizeMigrationSql,selectMigrationFiles} from './migrate.js';

export async function upgradeCapabilities(checkOnly=false,workersStopped=false){
 if(!checkOnly&&!workersStopped)throw Error('UPGRADE_REQUIRES_PROJECTION_WORKERS_STOPPED');
 const cfg=loadConfig(),pool=new pg.Pool({connectionString:cfg.databaseUrl,max:1,application_name:'gowm-capability-additive-upgrade'}),c=await pool.connect();
 try {
  await c.query("SELECT pg_advisory_lock(hashtextextended('gowm-capabilities-090-093',0))");
  await c.query(checkOnly?'BEGIN READ ONLY':'BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
  const files=selectMigrationFiles(await readdir('database/migrations'),93);
  const rows=(await c.query<{version:string;checksum:string}>('SELECT version,checksum FROM schema_migration ORDER BY version')).rows;
  if(rows.length<89||rows.length>93||rows.some((r,i)=>r.version!==files[i]))throw Error('CONTIGUOUS_089_TO_093_BASELINE_REQUIRED');
  const pending=[];
  for(const [i,file] of files.entries()){
   const sql=(await readFile('database/migrations/'+file,'utf8')).replaceAll(':ANALYSIS_SRID',String(cfg.analysisSrid))
    .replaceAll(':TRACKLET_MAX_TIME_GAP_MS',String(cfg.trackletMaxTimeGapMs)).replaceAll(':TRACKLET_MAX_DISTANCE_GAP_M',String(cfg.trackletMaxDistanceGapM))
    .replaceAll(':TRACKLET_MAX_REQUIRED_SPEED_MPS',String(cfg.trackletMaxRequiredSpeedMps));
   const hash=createHash('sha256').update(canonicalizeMigrationSql(sql)).digest('hex');
   if(rows[i]){if(rows[i]!.checksum!==hash)throw Error('MIGRATION_CHECKSUM_MISMATCH: '+file);}
   else {if(i<89||!/^BEGIN;[\s\S]*COMMIT;\s*$/.test(sql))throw Error('ONLY_090_TO_093_APPEND_ALLOWED');pending.push({file,hash,sql:sql.replace(/^BEGIN;/,'').replace(/COMMIT;\s*$/,'')});}
  }
  if(!checkOnly)for(const m of pending){await c.query(m.sql);await c.query('INSERT INTO schema_migration(version,checksum) VALUES($1,$2)',[m.file,m.hash]);}
  await c.query('COMMIT');return {status:'PASS',checkOnly,pending:pending.map(m=>m.file),accountsInitialized:false,passwordsChanged:false,
   devicesInitialized:false,profilesActivated:false,queueRecoveryPerformed:false};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{
  await c.query("SELECT pg_advisory_unlock(hashtextextended('gowm-capabilities-090-093',0))").catch(()=>{});c.release();await pool.end();
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.slice(2).some(a=>!['--check','--projection-workers-stopped'].includes(a)))throw Error('Usage: capability-completion-upgrade [--check] [--projection-workers-stopped]');
 console.log(JSON.stringify(await upgradeCapabilities(process.argv.includes('--check'),process.argv.includes('--projection-workers-stopped'))));
}
