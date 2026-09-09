import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {fixtureIdentity,seedFixtureFoundation,seedPositions} from './history-concurrency-fixture.js';
const source=process.env.DATABASE_ADMIN_URL;if(!source)throw Error('DATABASE_ADMIN_URL required');
const url=new URL(source);url.pathname='/postgres';const admin=new pg.Pool({connectionString:url.toString()});
const runId=randomUUID().replaceAll('-','');const name='gowm_history_upgrade_'+runId;url.pathname='/'+name;
const run=promisify(execFile);const env={...process.env,DATABASE_URL:url.toString(),ANALYSIS_SRID:'32650',STAS_DB_PASSWORD:'isolated-history-upgrade-password'};
let pool:pg.Pool|undefined;
try{
 await admin.query(`CREATE DATABASE "${name}"`);pool=new pg.Pool({connectionString:url.toString()});
 await run(process.execPath,['--import','tsx','--input-type=module','-e',"import {migrate} from './scripts/migrate.ts'; await migrate({maximumMigrationNumber:84});"],{env});
 const f=fixtureIdentity(runId);await seedFixtureFoundation(pool,f);await seedPositions(pool,f);
 const id=(await pool.query("SELECT gowm_rebuild_mobility_tracklet($1,$2,$3,$4,'default','source-local-default') id",[f.dataScopeKey,f.sourceKey,f.targetKey,f.trackerSessionKey])).rows[0].id;
 const state=async()=>({ledger:(await pool!.query('SELECT * FROM schema_migration ORDER BY version')).rows,
  version:(await pool!.query('SELECT to_jsonb(v) v FROM mobility_tracklet_version v WHERE tracklet_version_id=$1',[id])).rows,
  roles:(await pool!.query('SELECT rolname,rolpassword FROM pg_authid ORDER BY rolname')).rows});
 const before=await state();
 for(const args of [['--check'],[],[]])await run(process.execPath,['--import','tsx','scripts/history-hot-migrate.ts',...args],{env});
 const after=await state();assert.deepEqual(after.ledger.slice(0,84),before.ledger);assert.equal(after.ledger.length,86);assert.deepEqual(after.version,before.version);assert.deepEqual(after.roles,before.roles);
 console.log(JSON.stringify({status:'PASS',gate:'HISTORY_ADDITIVE_UPGRADE',baseline:84,head:86,replay:true,oldLedgerAndVersionUnchanged:true,allRolePasswordsUnchanged:true}));
}finally{await pool?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}"`);await admin.end();}
