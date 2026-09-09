import {describe,it,expect,vi} from 'vitest';
import {decodeResetAck} from '../../services/ugv-mqtt-ingest/src/reset-ack.js';
import {PostgresHistoricalTrajectoryInputLoader} from '../../packages/historical-trace-runtime/src/historical-trajectory-materializer.js';
import {queueStillRetryable,tick,loadAutoConfig} from '../../services/history-auto/src/index.js';
import {UgvIngestRepository} from '../../services/ugv-mqtt-ingest/src/repository.js';
import type pg from 'pg';
describe('reset control and history scheduling',()=>{
 it('decodes native and ROS String receipts with stable content',()=>{
  const ack={ok:true,target:'ugv',ts:1788948000};
  expect(decodeResetAck(Buffer.from(JSON.stringify(ack)))).toEqual(ack);
  expect(decodeResetAck(Buffer.from(JSON.stringify({data:JSON.stringify(ack)})))).toEqual(ack);
  for(const payload of ['{}','{"ok":"true","target":"all","ts":1}','{"ok":true,"target":"ugv","ts":-1}','{"data":{}}'])expect(()=>decodeResetAck(Buffer.from(payload))).toThrow();
 });
 it('durably accepts control without passing it through business schemas',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{accepted_message_id:'id',was_redelivery:false,accepted_packet_generation:'1'}]});
  const repo=new UgvIngestRepository({query} as unknown as pg.Pool,'ugv',10000);
  expect((await repo.accept('session','/sim/reset_ack',Buffer.from('{"ok":true,"target":"ugv","ts":1788948000}'),{qos:1,messageId:1},new Date().toISOString())).validationState).toBe('VALID');
 });
 it('leaves retryable requests attached after process restart even when inputs advance',async()=>{
  for(const [state,attempts] of [['QUEUED',0],['RUNNING',2],['FAILED',9]] as const){
   expect(queueStillRetryable(state,attempts)).toBe(true);
   for(let restart=0;restart<2;restart++){
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('pg_try_advisory_lock')?[{locked:true}]:sql.includes('to_regclass')?[{present:false}]:sql.includes('clock_timestamp() t')?[{t:new Date()}]:sql.includes('FROM gowm_history.task_execution_interval i')?[{queue_state:state,attempts}]:[]}));
    const c={query,release:vi.fn()};const pool={connect:async()=>c} as unknown as pg.Pool;
    expect(await tick(pool,loadAutoConfig({}))).toMatchObject({queued:0,pending:1});
    expect(query.mock.calls.some(([sql])=>sql.includes('enqueue_historical_trajectory_projection'))).toBe(false);
   }
  }
  expect(queueStillRetryable('FAILED',10)).toBe(false);
 });
 it('suppresses the same exhausted signature, permits new inputs and retains failure backoff',async()=>{
  const load=vi.spyOn(PostgresHistoricalTrajectoryInputLoader.prototype,'load').mockResolvedValue({kind:'READY',resourceInputs:[],inputSets:[],semanticRequestHash:'sha256:'+ 'a'.repeat(64)} as never);
  const row:Record<string,unknown>={subject_ref:'wrf_device',subject_version:'1',interval_ref:'wrf_interval',revision_no:1,
    tracker_session_key:'run:ugv',candidate_key:'candidate',failures:2};
  const query=vi.fn(async(sql:string,values?:unknown[])=>{
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.includes('to_regclass'))return {rows:[{present:false}]};
   if(sql.includes('clock_timestamp() t'))return {rows:[{t:new Date()}]};
   if(sql.includes('FROM gowm_history.task_execution_interval i'))return {rows:[{...row}]};
   if(sql.includes('SELECT gowm_history.enqueue_historical'))return {rows:[{id:'queue'}]};
   if(sql.includes('INSERT INTO gowm_history.auto_checkpoint')){row.input_signature=values![2];row.queue_id=values![3];row.failures=values![4];row.last_outcome=values![5];}
   return {rows:[]};
  });
  const pool={connect:async()=>({query,release:()=>{}})} as unknown as pg.Pool;
  try{
   expect(await tick(pool,loadAutoConfig({}))).toMatchObject({queued:1});
   Object.assign(row,{queue_state:'FAILED',attempts:10,last_outcome:'QUEUE_EXHAUSTED'});
   expect(await tick(pool,loadAutoConfig({}))).toMatchObject({queued:0,failed:1});
   row.subject_version='2';
   expect(await tick(pool,loadAutoConfig({}))).toMatchObject({queued:1});
   expect(row.failures).toBe(2);
  }finally{load.mockRestore();}
 });

});
