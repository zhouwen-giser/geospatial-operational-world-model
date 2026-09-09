import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {loadConfig} from '../packages/world-model-core/src/config.js';
import {canonicalizeMigrationSql,selectMigrationFiles} from './migrate.js';

/** Append only 085/086 to an established installation, without account or device initialization. */
export async function migrateHistoryConcurrency(checkOnly=false):Promise<void>{
 const config=loadConfig();
 const pool=new pg.Pool({connectionString:config.databaseUrl,max:1,application_name:'gowm-history-additive-migration'});
 try{
  await pool.query(checkOnly?'BEGIN READ ONLY':'BEGIN');
  if(!checkOnly) await pool.query("SELECT pg_advisory_xact_lock(hashtextextended('gowm-history-085-086',0))");
  await pool.query("SET LOCAL lock_timeout='5s'");
  const files=selectMigrationFiles(await readdir('database/migrations'),86);
  const rows=(await pool.query<{version:string;checksum:string}>('SELECT version,checksum FROM schema_migration ORDER BY version')).rows;
  if(rows.length<84||rows.length>86||rows.some((r,i)=>r.version!==files[i]))throw Error('Expected a contiguous 084–086 migration baseline');
  const pending:Array<{file:string;sql:string;checksum:string}>=[];
  for(const [index,file]of files.entries()){
   const sql=(await readFile(resolve('database/migrations',file),'utf8'))
    .replaceAll(':ANALYSIS_SRID',String(config.analysisSrid))
    .replaceAll(':TRACKLET_MAX_TIME_GAP_MS',String(config.trackletMaxTimeGapMs))
    .replaceAll(':TRACKLET_MAX_DISTANCE_GAP_M',String(config.trackletMaxDistanceGapM))
    .replaceAll(':TRACKLET_MAX_REQUIRED_SPEED_MPS',String(config.trackletMaxRequiredSpeedMps));
   const checksum=createHash('sha256').update(canonicalizeMigrationSql(sql)).digest('hex');
   const rawChecksum=createHash('sha256').update(sql).digest('hex');
   if(rows[index]){
    if(![checksum,rawChecksum].includes(rows[index]!.checksum))throw Error('Migration checksum mismatch: '+file);
   }else{
    if(index<84)throw Error('Only 085 and 086 may be appended');
    if(!/^BEGIN;[\s\S]*COMMIT;\s*$/.test(sql))throw Error('Unexpected migration transaction envelope: '+file);
    pending.push({file,sql:sql.replace(/^BEGIN;/,'').replace(/COMMIT;\s*$/,''),checksum});
   }
  }
  if(!checkOnly) for(const migration of pending){
   await pool.query(migration.sql);
   await pool.query('INSERT INTO schema_migration(version,checksum) VALUES($1,$2)',[migration.file,migration.checksum]);
  }
  await pool.query('COMMIT');
  console.log(JSON.stringify({event:'history_additive_migration',checkOnly,verified:rows.length,[checkOnly?'pending':'applied']:pending.map(m=>m.file),accountsInitialized:false}));
 }catch(error){await pool.query('ROLLBACK').catch(()=>{});throw error;}
 finally{await pool.end();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 if(process.argv.slice(2).some(a=>a!=='--check'))throw Error('Usage: history-hot-migrate [--check]');
 migrateHistoryConcurrency(process.argv.includes('--check')).catch((error:unknown)=>{
  console.error(JSON.stringify({event:'history_additive_migration_failed',message:error instanceof Error?error.message:'migration failed'}));process.exitCode=1;
 });
}
