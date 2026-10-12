import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {registerRuntimeProfile,activateRuntimeProfile} from '../packages/integrations/device-business-storage/src/ingest-profile.js';

export async function closeIngestSession(c:pg.PoolClient,scope:string,sessionId:string,reason:string){
 if(!scope.trim()||!reason.trim()||reason.length>512)throw Error('SESSION_CLOSE_INPUT_INVALID');
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,92012))',[scope]);
 const s=(await c.query(`SELECT session_id,disconnected_at,closed_at FROM ugv_ingest.mqtt_session
  WHERE session_id=$1::uuid AND mapper_context->>'dataScopeKey'=$2 FOR UPDATE`,[sessionId,scope])).rows[0];
 if(!s)throw Error('SESSION_NOT_FOUND_IN_SCOPE');
 if(s.closed_at)return {sessionId,closed:true,replayed:true};
 if(!s.disconnected_at)throw Error('SESSION_MUST_BE_DISCONNECTED');
 const pending=await c.query(`SELECT 1 FROM ugv_ingest.inbox_message i WHERE i.session_id=$1
  AND (i.processing_state IN('RECEIVED','VALIDATED','MAPPED','OUTBOXED') OR EXISTS(
   SELECT 1 FROM ugv_ingest.outbox_message o WHERE o.inbox_message_id=i.message_id AND o.delivery_state='PENDING')) LIMIT 1`,[sessionId]);
 if(pending.rowCount)throw Error('SESSION_DRAIN_REQUIRED');
 await c.query('UPDATE ugv_ingest.mqtt_session SET closed_at=clock_timestamp(),close_reason=$2 WHERE session_id=$1',[sessionId,reason]);
 return {sessionId,closed:true,replayed:false};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--help'))console.log('ingest-profile register <json> | activate <scope> <device-id> <profile-id> <version> | close-session <scope> <session-uuid> <reason>. Explicit admin operation; no device creation, password rotation or queue recovery.');
 else {
 const [command,...args]=process.argv.slice(2);const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL required');
 const pool=new pg.Pool({connectionString:url,max:1});const c=await pool.connect();
 try {
  await c.query('BEGIN');let result:unknown;
  if(command==='register'&&args.length===1)result=await registerRuntimeProfile(c,JSON.parse(await readFile(args[0]!,'utf8')));
  else if(command==='activate'&&args.length===4)result=await activateRuntimeProfile(c,args[0]!,args[1]!,args[2]!,args[3]!);
  else if(command==='close-session'&&args.length===3)result=await closeIngestSession(c,args[0]!,args[1]!,args[2]!);
  else throw Error('Usage: ingest-profile register <json> | activate <scope> <device-id> <profile-id> <version> | close-session <scope> <session-uuid> <reason>');
  await c.query('COMMIT');console.log(JSON.stringify({status:'PASS',result}));
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();await pool.end();}
 }
}
