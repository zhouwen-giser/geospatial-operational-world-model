import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,open,readFile,writeFile,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const tables=[['schema_migration','version'],['world_object','id'],['world_observation','observation_id'],['world_event','event_id'],
 ['source_registry','source_key'],['datastream','datastream_key'],['mobility_tracklet_version','tracklet_version_id'],
 ['gowm_history.historical_trajectory_revision','trajectory_revision_id'],['gowm_device.device','device_id'],
 ['gowm_device.device_service_binding','binding_id']] as const;
type Fingerprint={table:string;count:string;first100RowsSha256:string}[];
async function fingerprint(c:pg.Client):Promise<Fingerprint>{
 const result:Fingerprint=[];
 for(const [table,key] of tables){
  if(!(await c.query('SELECT to_regclass($1) present',[table])).rows[0].present)continue;
  const count=(await c.query(`SELECT count(*)::text n FROM ${table}`)).rows[0].n as string;
  const sample=(await c.query(`SELECT to_jsonb(t) v FROM ${table} t ORDER BY ${key} LIMIT 100`)).rows.map(r=>r.v);
  result.push({table,count,first100RowsSha256:createHash('sha256').update(JSON.stringify(sample)).digest('hex')});
 }
 return result;
}
async function fileHash(path:string){const hash=createHash('sha256');for await(const b of createReadStream(path))hash.update(b);return hash.digest('hex');}
function connectionEnv(databaseUrl:string):NodeJS.ProcessEnv{
 const u=new URL(databaseUrl);
 if(!['postgres:','postgresql:'].includes(u.protocol)||!u.pathname.slice(1))throw Error('OPERATIONS_DATABASE_URL_INVALID');
 const env:NodeJS.ProcessEnv={...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),
  PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1))};
 for(const [k,v]of u.searchParams){const key:Record<string,string>={sslmode:'PGSSLMODE',sslrootcert:'PGSSLROOTCERT',sslcert:'PGSSLCERT',sslkey:'PGSSLKEY'};
  if(key[k])env[key[k]!]=v;}
 return env;
}
async function pgTool(kind:'pg_dump'|'pg_restore',args:string[],url:string,outputFd?:number){
 const executable=process.env[kind==='pg_dump'?'GOWM_PG_DUMP_EXECUTABLE':'GOWM_PG_RESTORE_EXECUTABLE']??kind;
 await new Promise<void>((ok,no)=>{
  const p=spawn(executable,args,{env:connectionEnv(url),stdio:['ignore',outputFd??'ignore','ignore'],shell:false});
  const timer=setTimeout(()=>p.kill('SIGTERM'),1800000);timer.unref();
  p.once('error',()=>{clearTimeout(timer);no(Error('OPERATIONS_TOOL_UNAVAILABLE: '+kind));});
  p.once('exit',code=>{clearTimeout(timer);code===0?ok():no(Error('OPERATIONS_TOOL_FAILED: '+kind+' exit='+code));});
 });
}
async function connection(url:string){const c=new pg.Client({connectionString:url,application_name:'gowm-readonly-operations',statement_timeout:30000});await c.connect();await c.query("SET TIME ZONE 'UTC'");return c;}

export async function backupDatabase(url:string,directory:string){
 const dest=resolve(directory);await mkdir(dest,{mode:0o700}); // must be new; never overwrite another backup
 const dump=join(dest,'database.dump'),c=await connection(url);
 try {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot=(await c.query('SELECT pg_export_snapshot() snapshot')).rows[0].snapshot as string;
  const facts=await fingerprint(c),extensions=(await c.query('SELECT extname,extversion FROM pg_extension ORDER BY extname')).rows;
  const requiredRoles=(await c.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'gowm%' OR rolname LIKE 'ugv_%' OR rolname LIKE 'stas%' ORDER BY rolname")).rows.map(r=>String(r.rolname));
  const database=(await c.query('SELECT current_database() name,current_setting(\'server_version\') version')).rows[0];
  const fd=await open(dump,'wx',0o600);
  try{await pgTool('pg_dump',['--format=custom','--no-password','--snapshot='+snapshot],url,fd.fd);}finally{await fd.close();}
  await c.query('COMMIT');
  const manifest={formatVersion:1,kind:'GOWM_LOGICAL_BACKUP_V1',createdAt:new Date().toISOString(),source:database,
   sha256:await fileHash(dump),extensions,requiredRoles,facts,contentCheck:'EXACT_COUNTS_AND_FIRST_100_ROWS_PER_LISTED_TABLE',
   ownerAndAclRestorationRequired:true,rolePasswordsIncluded:false,pitrQualified:false,haQualified:false};
  await writeFile(join(dest,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return {status:'PASS',kind:manifest.kind,directory:dest,sha256:manifest.sha256,pitrQualified:false,haQualified:false};
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{await c.end();}
}

export async function verifyRestore(url:string,directory:string){
 const dest=resolve(directory),dump=join(dest,'database.dump'),metadata=join(dest,'manifest.json');
 for(const path of [dest,dump,metadata]){const s=await lstat(path);if(s.isSymbolicLink())throw Error('OPERATIONS_SYMLINK_FORBIDDEN');}
 const m=JSON.parse(await readFile(metadata,'utf8'));
 if(m.kind!=='GOWM_LOGICAL_BACKUP_V1'||m.formatVersion!==1||m.sha256!==await fileHash(dump))throw Error('BACKUP_CHECKSUM_OR_FORMAT_MISMATCH');
 const name=decodeURIComponent(new URL(url).pathname.slice(1));
 if(!/^gowm_restore_check_[a-z0-9_]{8,80}$/.test(name)||name===m.source.name)throw Error('ISOLATED_RESTORE_DATABASE_REQUIRED');
 const c=await connection(url);
 try {
  const occupied=await c.query("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT IN('public','information_schema') AND nspname NOT LIKE 'pg_%') OR EXISTS(SELECT 1 FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public') occupied");
  if(occupied.rows[0].occupied)throw Error('RESTORE_TARGET_NOT_EMPTY');
  for(const role of m.requiredRoles){if(!(await c.query('SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) present',[role])).rows[0].present)throw Error('RESTORE_REQUIRED_ROLE_MISSING');}
  for(const extension of m.extensions){if(!(await c.query('SELECT EXISTS(SELECT 1 FROM pg_available_extension_versions WHERE name=$1 AND version=$2) present',[extension.extname,extension.extversion])).rows[0].present)throw Error('RESTORE_EXTENSION_VERSION_UNAVAILABLE');}
  await pgTool('pg_restore',['--exit-on-error','--no-password','--dbname='+name,dump],url);
  const actual=await fingerprint(c);
  if(JSON.stringify(actual)!==JSON.stringify(m.facts))throw Error('RESTORE_FACT_FINGERPRINT_MISMATCH');
  const extensions=(await c.query('SELECT extname,extversion FROM pg_extension ORDER BY extname')).rows;
  if(JSON.stringify(extensions)!==JSON.stringify(m.extensions))throw Error('RESTORE_EXTENSION_MISMATCH');
  return {status:'PASS',kind:'ISOLATED_LOGICAL_RESTORE_VERIFIED',sha256:m.sha256,tables:actual.length,
   checks:m.contentCheck,productionReadiness:'NOT_GRANTED',pitrQualified:false,haQualified:false};
 }finally{await c.end();}
}

export async function diagnoseOperations(url:string,scope:string){
 if(!scope)throw Error('DATA_SCOPE_REQUIRED');const c=await connection(url);
 try {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SELECT set_config('gowm.data_scope_key',$1,true)",[scope]);
  if(!(await c.query('SELECT 1 FROM data_scope WHERE scope_key=$1',[scope])).rowCount)throw Error('DATA_SCOPE_NOT_FOUND');
  const counts=(await c.query(`SELECT (SELECT count(*) FROM world_observation WHERE data_scope_key=$1) observations,
   (SELECT count(*) FROM gowm_situation.cell_scored) cells,(SELECT count(*) FROM gowm_history_artifact.registry WHERE data_scope_key=$1) artifacts,
   (SELECT count(*) FROM gowm_device.device WHERE data_scope_key=$1 AND enabled) enabled_devices`,[scope])).rows[0];
  const queues=(await c.query(`SELECT state,attempts,count(*) count,min(created_at) oldest_created_at,
   max(lease_until) maximum_lease_until,bool_or(last_error IS NOT NULL) has_error
   FROM gowm_history.historical_trajectory_projection_queue WHERE data_scope_key=$1 GROUP BY state,attempts ORDER BY state,attempts`,[scope])).rows;
  const feed=(await c.query('SELECT count(*)::text events FROM public.world_event_feed WHERE data_scope_key=$1',[scope])).rows[0];
  const delivery=(await c.query(`SELECT count(*)::int pending,
   coalesce(max(extract(epoch FROM(clock_timestamp()-queued_at))),0)::float8 oldest_seconds
   FROM world_event_feed_pending WHERE data_scope_key=$1`,[scope])).rows[0];
  const scheduler=(await c.query(`SELECT count(*) FILTER(WHERE attempts<10 AND state IN('QUEUED','FAILED'))::int retryable_waiting,
   count(*) FILTER(WHERE state='RUNNING' AND lease_until>clock_timestamp())::int active,
   count(*) FILTER(WHERE state='RUNNING' AND lease_until<=clock_timestamp())::int expired_leases,
   coalesce(max(extract(epoch FROM(clock_timestamp()-created_at))) FILTER(WHERE attempts<10 AND state IN('QUEUED','FAILED')),0)::float8 wait_seconds
   FROM gowm_history.historical_trajectory_projection_queue WHERE data_scope_key=$1`,[scope])).rows[0];
  const capacity=(await c.query(`SELECT pg_database_size(current_database())::text bytes,
   current_setting('max_connections')::int maximum_connections,
   count(*) FILTER(WHERE a.state='active')::int active_connections,
   count(*) FILTER(WHERE a.state='idle in transaction')::int idle_in_transaction,
   count(*)::int connections FROM pg_stat_activity a WHERE a.datname=current_database()`)).rows[0];
  const limit=process.env.GOWM_OPS_STORAGE_WARN_BYTES;
  if(limit&&(!/^\d+$/.test(limit)||BigInt(limit)<=0))throw Error('STORAGE_WARN_BYTES_INVALID');
  const alerts:string[]=[];
  if(delivery.pending>1000||delivery.oldest_seconds>30)alerts.push('EVENT_DELIVERY_INDEX_BACKLOG');
  if(scheduler.wait_seconds>30)alerts.push('HISTORY_RETRYABLE_QUEUE_WAIT');
  if(scheduler.expired_leases>0)alerts.push('HISTORY_EXPIRED_LEASES');
  if(capacity.idle_in_transaction>0)alerts.push('DATABASE_IDLE_IN_TRANSACTION');
  if(capacity.connections>=capacity.maximum_connections*.8)alerts.push('DATABASE_CONNECTION_PRESSURE');
  if(limit&&BigInt(capacity.bytes)>=BigInt(limit))alerts.push('DATABASE_STORAGE_THRESHOLD');
  await c.query('COMMIT');return {scope,counts,historyQueues:queues,eventFeed:feed,delivery,scheduler,
   databaseCapacity:{...capacity,scope:'WHOLE_CURRENT_DATABASE',storageThreshold:limit??'NOT_CONFIGURED'},alerts,
   leaseRenewalFailureMetrics:'WORKER_STRUCTURED_LOGS',inProcessPoolMetrics:'NOT_OBSERVED_BY_DATABASE',
   queryMode:'READ_ONLY_SCOPED',credentialsOrPayloadsIncluded:false};
 }finally{await c.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--help')||!process.argv[2])console.log('GOWM_DATABASE_URL=... operations diagnose <scope> | backup <new-private-directory> | verify-restore <backup-directory>. Restore requires an explicitly created EMPTY gowm_restore_check_* database and existing roles/extensions; never creates or drops databases/roles. Matching pg_dump/pg_restore tools required.');
 else {const url=process.env.GOWM_DATABASE_URL;if(!url)throw Error('GOWM_DATABASE_URL required');const value=process.argv[3];if(!value)throw Error('OPERATIONS_ARGUMENT_REQUIRED');
  try{const command=process.argv[2];console.log(JSON.stringify(command==='backup'?await backupDatabase(url,value):command==='verify-restore'?await verifyRestore(url,value):command==='diagnose'?await diagnoseOperations(url,value):(()=>{throw Error('UNKNOWN_OPERATIONS_COMMAND');})()));}
  catch(e){console.error(JSON.stringify({status:'FAIL',stage:process.argv[2],reason:e instanceof Error&&/^[A-Z_]+(?:: (?:pg_dump|pg_restore) exit=\d+)?$/.test(e.message)?e.message:'OPERATIONS_FAILED',sqlstate:(e as {code?:string}).code??null}));process.exitCode=1;}
 }
}
