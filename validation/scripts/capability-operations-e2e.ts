import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm,stat,open,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {backupDatabase,verifyRestore,diagnoseOperations} from '../../scripts/operations.js';

export async function verifyLogicalRecovery(databaseUrl:string,scope:string){
 const container=process.env.GOWM_CAPABILITY_PG_CONTAINER??process.env.GOWM_V071_DATABASE_CONTAINER;
 if(!container||!/^[a-zA-Z0-9_.-]+$/.test(container))throw Error('ISOLATED_PG_TOOL_CONTAINER_REQUIRED');
 const dir=await mkdtemp(join(tmpdir(),'gowm-capability-recovery-')),name='gowm_restore_check_'+randomUUID().replaceAll('-','');
 const adminUrl=new URL(databaseUrl);adminUrl.pathname='/postgres';const admin=new pg.Client({connectionString:adminUrl.href});await admin.connect();
 const target=new URL(databaseUrl);target.pathname='/'+name;let created=false;
 const originalDump=process.env.GOWM_PG_DUMP_EXECUTABLE,originalRestore=process.env.GOWM_PG_RESTORE_EXECUTABLE;
 try {
  for(const tool of ['pg_dump','pg_restore']){
   const path=join(dir,tool),prefix=`#!/usr/bin/env bash\nset -euo pipefail\n`;
   const exec=`docker exec -i --env PGUSER --env PGPASSWORD --env PGDATABASE --env PGHOST=127.0.0.1 --env PGPORT=5432 '${container}' ${tool}`;
   await writeFile(path,prefix+(tool==='pg_dump'?`${exec} "$@"\n`:`args=("$@"); last="\u0024{args[-1]}"; unset 'args[-1]'\n${exec} "\u0024{args[@]}" < "$last"\n`),{mode:0o700});
   process.env[tool==='pg_dump'?'GOWM_PG_DUMP_EXECUTABLE':'GOWM_PG_RESTORE_EXECUTABLE']=path;
  }
  const diagnosis=await diagnoseOperations(databaseUrl,scope);assert.equal(diagnosis.queryMode,'READ_ONLY_SCOPED');
  await assert.rejects(diagnoseOperations(databaseUrl,'missing-'+randomUUID()),/DATA_SCOPE_NOT_FOUND/);
  const backup=await backupDatabase(databaseUrl,join(dir,'backup'));assert.equal(backup.status,'PASS');
  await assert.rejects(backupDatabase(databaseUrl,join(dir,'backup')),/EEXIST/);
  await assert.rejects(verifyRestore(databaseUrl,join(dir,'backup')),/ISOLATED_RESTORE_DATABASE_REQUIRED/);
  await admin.query(`CREATE DATABASE "${name}"`);created=true;
  const occupied=new pg.Client({connectionString:target.href});await occupied.connect();
  try{await occupied.query('CREATE TABLE restore_target_sentinel(id int)');await assert.rejects(verifyRestore(target.href,join(dir,'backup')),/RESTORE_TARGET_NOT_EMPTY/);await occupied.query('DROP TABLE restore_target_sentinel');}finally{await occupied.end();}
  const dump=join(dir,'backup/database.dump'),size=(await stat(dump)).size,fd=await open(dump,'a');await fd.write('corrupted-test-only');await fd.close();
  await assert.rejects(verifyRestore(target.href,join(dir,'backup')),/BACKUP_CHECKSUM/);const recover=await open(dump,'r+');await recover.truncate(size);await recover.close();
  const result=await verifyRestore(target.href,join(dir,'backup'));assert.equal(result.status,'PASS');
  const check=new pg.Client({connectionString:target.href});await check.connect();
  try{assert.equal((await check.query("SELECT pg_get_userbyid(proowner) owner FROM pg_proc WHERE oid='gowm_history_artifact.open(jsonb,jsonb,text,integer,integer)'::regprocedure")).rows[0].owner,'gowm_history_artifact_owner');
   assert.equal((await check.query("SELECT has_table_privilege('gowm_history_reader','gowm_history_artifact.registry','INSERT') allowed")).rows[0].allowed,false);}finally{await check.end();}
  await assert.rejects(verifyRestore(target.href,join(dir,'backup')),/RESTORE_TARGET_NOT_EMPTY/);
  return {...result,checks:['consistent_exported_snapshot_backup','explicit_scope_readonly_diagnosis','same_database_nonempty_and_corruption_refused',
   'matching_engine_isolated_restore','counts_sample_hashes_owner_and_acl_preserved','repeat_restore_refused'],remoteDeployment:'NOT_RUN'};
 }finally{
  if(originalDump===undefined)delete process.env.GOWM_PG_DUMP_EXECUTABLE;else process.env.GOWM_PG_DUMP_EXECUTABLE=originalDump;
  if(originalRestore===undefined)delete process.env.GOWM_PG_RESTORE_EXECUTABLE;else process.env.GOWM_PG_RESTORE_EXECUTABLE=originalRestore;
  if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();await rm(dir,{recursive:true,force:true});
 }
}
if(process.argv[1]?.endsWith('capability-operations-e2e.ts')){
 const url=process.env.GOWM_CAPABILITY_TEST_DATABASE_URL,scope=process.env.GOWM_CAPABILITY_TEST_SCOPE;
 if(!url||!scope)throw Error('GOWM_CAPABILITY_TEST_DATABASE_URL and GOWM_CAPABILITY_TEST_SCOPE required');
 const result=await verifyLogicalRecovery(url,scope);await mkdir('reports/capability-completion-2026-10-12',{recursive:true});
 await writeFile('reports/capability-completion-2026-10-12/logical-recovery.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
