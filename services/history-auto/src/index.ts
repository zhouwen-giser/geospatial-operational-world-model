import pg from "pg";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { canonicalSha256 } from "../../../packages/historical-trace-core/src/index.js";
import { PostgresHistoricalTrajectoryInputLoader } from "../../../packages/historical-trace-runtime/src/historical-trajectory-materializer.js";
import type { HistoricalSemanticRequest } from "../../../packages/historical-trace-model/src/index.js";
import type { SqlPool } from "../../../packages/historical-trace-runtime/src/database.js";

export function retryDelay(failures: number): number { return Math.min(900,60*2**Math.min(4,Math.max(0,failures-1))); }
export function loadAutoConfig(env: NodeJS.ProcessEnv = process.env) {
  const boolean=(key:string,fallback:string)=>{const v=env[key]??fallback;if(!["true","false"].includes(v))throw Error(`${key} must be true or false`);return v==="true";};
  const integer=(key:string,fallback:number,min:number,max:number)=>{const v=Number(env[key]??fallback);if(!Number.isSafeInteger(v)||v<min||v>max)throw Error(`Invalid ${key}`);return v;};
  const owner=env.GOWM_HISTORY_AUTO_OWNER??"gowm";
  if(!["gowm","external"].includes(owner))throw Error("Unknown history scheduling owner");
  return {enabled:boolean("GOWM_HISTORY_AUTO_ENABLED","true"),owner,
    takeover:boolean("GOWM_HISTORY_AUTO_TAKEOVER","false"),
    interval:integer("GOWM_HISTORY_AUTO_INTERVAL_SECONDS",60,10,3600),
    batch:integer("GOWM_HISTORY_AUTO_MAX_TASKS",16,1,64),
    scope:env.GOWM_HISTORY_AUTO_DATA_SCOPE_KEY??"default",
    source:env.UGV_SOURCE_KEY??"ugv-airport-sim-mqtt",device:env.UGV_DEVICE_ID??"ugv"};
}
type Config=ReturnType<typeof loadAutoConfig>;
const escapeLike=(s:string)=>s.replaceAll("!","!!").replaceAll("%","!%").replaceAll("_","!_");

export async function tick(pool:pg.Pool,config:Config) {
  if(!config.enabled||config.owner!=="gowm")return {state:"DISABLED",queued:0};
  const client=await pool.connect();let locked=false;
  // Same advisory key as the legacy outer scheduler, so an old process cannot
  // enqueue concurrently during the explicit ownership handover.
  const lockKey=`history-auto:${config.scope}`;
  try {
    locked=(await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked",[lockKey])).rows[0].locked;
    if(!locked)return {state:"ANOTHER_SCHEDULER",queued:0};
    const outer=(await client.query("SELECT to_regclass('analysis_automation.history_checkpoint') IS NOT NULL present")).rows[0].present;
    if(outer&&!config.takeover)throw Error("EXTERNAL_SCHEDULER_HANDOVER_REQUIRED");
    await client.query("BEGIN");
    await client.query("SELECT gowm_history_v1.set_data_scope($1)",[config.scope]);
    await client.query("SELECT gowm_history.bootstrap_unknown_watermarks($1,$2,$3)",[config.scope,config.source,config.device]);
    await client.query("COMMIT");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT gowm_history_v1.set_data_scope($1)",[config.scope]);
    const capturedAt=(await client.query("SELECT clock_timestamp() t")).rows[0].t.toISOString();
    const rows=(await client.query(`
      SELECT i.reference_key interval_ref,r.revision_no,identity.reference_key subject_ref,
        descriptor.object_version subject_version,t.tracker_session_key,
        i.reference_key||':'||identity.reference_key||':'||t.tracker_session_key candidate_key,
        c.input_signature,c.queue_id,c.failures,q.state queue_state,o.outcome_status
      FROM gowm_history.task_execution_interval i
      JOIN gowm_history.task_execution_interval_head h USING(interval_id)
      JOIN gowm_history.task_execution_interval_revision r ON r.interval_revision_id=h.current_revision_id
      JOIN public.mobility_tracklet t ON t.data_scope_key=i.data_scope_key
        AND t.source_key=$2 AND t.source_local_target_id=$3 AND t.world_object_id IS NOT NULL
      JOIN public.world_reference_identity identity ON identity.internal_id=t.world_object_id
        AND identity.data_scope_key=i.data_scope_key AND identity.entity_kind='WORLD_OBJECT'
      JOIN LATERAL(SELECT state.version::text object_version FROM public.world_object_state state
        WHERE state.object_id=t.world_object_id AND state.updated_at<=$6::timestamptz) descriptor ON true
      LEFT JOIN gowm_history.auto_checkpoint c ON c.data_scope_key=i.data_scope_key
        AND c.candidate_key=i.reference_key||':'||identity.reference_key||':'||t.tracker_session_key
      LEFT JOIN gowm_history.historical_trajectory_projection_queue q ON q.queue_id=c.queue_id
      LEFT JOIN gowm_history.historical_trajectory_outcome o ON o.outcome_id=q.outcome_id
      WHERE i.data_scope_key=$1 AND r.lifecycle_state IN('OPEN','CLOSED')
        AND EXISTS(SELECT 1 FROM gowm_history.task_execution_interval_input ie
          JOIN public.operational_task_event event ON event.event_id=ie.operational_event_id AND event.data_scope_key=i.data_scope_key
          CROSS JOIN LATERAL jsonb_array_elements(event.provenance) proof
          JOIN public.world_observation obs ON obs.observation_id=proof->>'evidenceId'
          WHERE ie.interval_revision_id=r.interval_revision_id AND obs.data_scope_key=i.data_scope_key
            AND obs.source=$2 AND obs.observer_id IN('ugv:'||$3,'device:'||$3||':platform')
            AND (obs.metadata->>'worldEpoch')||':'||$3=t.tracker_session_key
            AND obs.created_at<=$6::timestamptz)
        AND (upper_inf(r.execution_range) OR upper(r.execution_range)>$6::timestamptz-interval '7 days')
        AND (i.operational_task_id LIKE $4 ESCAPE '!' OR i.operational_task_id LIKE $5 ESCAPE '!')
        AND (c.next_attempt_at IS NULL OR c.next_attempt_at<=$6::timestamptz)
      ORDER BY c.checked_at NULLS FIRST,i.reference_key,identity.reference_key,t.tracker_session_key LIMIT $7`,
    [config.scope,config.source,config.device,`mission:${escapeLike(config.device)}:chassis:%`,
      `mission:${escapeLike(config.device)}:recon:%`,capturedAt,config.batch])).rows;
    await client.query("COMMIT");
    const loader=new PostgresHistoricalTrajectoryInputLoader(pool as unknown as SqlPool);
    let queued=0,pending=0,completed=0,failed=0;
    for(const row of rows) {
      if(["QUEUED","RUNNING"].includes(row.queue_state)) {pending++;continue;}
      const query:HistoricalSemanticRequest={
        subjectReferenceKey:{namespace:"gowm",kind:"WORLD_OBJECT",id:row.subject_ref,version:String(row.subject_version)},
        executionIntervalReferenceKey:{namespace:"gowm",kind:"TASK_EXECUTION_INTERVAL",id:row.interval_ref,version:String(row.revision_no)},
        phaseScope:"ACTIVE_PHASES_ONLY",sourceSelection:{mode:"EXPLICIT_SOURCE",sourceKey:config.source,trackerSessionKey:row.tracker_session_key},
        sourceSelectionProfileReferenceKey:{namespace:"gowm.history",kind:"HISTORY_METHOD_PROFILE",id:"trajectory-single-authoritative-v2",version:"2.0"}};
      let outcome="FAILED",signature:string|null=null,queueId=row.queue_id??null,failures=Number(row.failures??0),transactionOpen=false;
      try {
        const loaded=await loader.load({dataScopeKey:config.scope,capturedAt,query});
        if(loaded.kind!=="READY") {outcome=loaded.reasonCode;pending++;failures++;}
        else {
          const resources=loaded.resourceInputs.map(x=>({resourceKind:x.resourceKind,resourceId:x.resourceId,
            version:x.resourceVersion,contentHash:x.resourceContentHash,pinning:"PINNED" as const}));
          resources.push(...loaded.inputSets.map(x=>({resourceKind:x.inputSetKind,resourceId:x.inputSetKind,
            version:x.itemSetDigest,contentHash:x.itemSetDigest,pinning:"PINNED" as const})));
          const sets=loaded.inputSets.map(x=>({kind:x.inputSetKind,count:x.itemCount,hash:x.itemSetDigest}));
          signature=canonicalSha256({query,resources,sets});
          if(signature===row.input_signature&&row.queue_state==="COMPLETED"&&row.outcome_status!=="PENDING") {outcome="UNCHANGED";completed++;failures=0;}
          else {
            const snapshotBase={querySnapshotId:`history-auto-${signature.slice(7)}`,mode:"LATEST_AT_START",consistency:"CONSISTENT_AT_START",capturedAt,resources};
            const snapshot={...snapshotBase,manifestHash:canonicalSha256(snapshotBase)};
            await client.query("BEGIN");transactionOpen=true;
            await client.query("SELECT gowm_history_v1.set_data_scope($1)",[config.scope]);
            queueId=(await client.query(`SELECT gowm_history.enqueue_historical_trajectory_projection($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb) id`,
              [config.scope,row.subject_ref,row.interval_ref,row.revision_no,query.phaseScope,loaded.semanticRequestHash,snapshot.manifestHash,capturedAt,JSON.stringify(query),JSON.stringify(snapshot)])).rows[0].id;
            queued++;outcome="QUEUED";failures=0;
          }
        }
      } catch(error) {await client.query("ROLLBACK");transactionOpen=false;queueId=row.queue_id??null;signature=null;failures++;failed++;outcome="RESOLUTION_FAILED";}
      if(!transactionOpen)await client.query("BEGIN");await client.query("SELECT gowm_history_v1.set_data_scope($1)",[config.scope]);
      await client.query(`INSERT INTO gowm_history.auto_checkpoint(data_scope_key,candidate_key,input_signature,queue_id,failures,last_outcome,next_attempt_at)
        VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 second')
        ON CONFLICT(data_scope_key,candidate_key) DO UPDATE SET input_signature=EXCLUDED.input_signature,
          queue_id=EXCLUDED.queue_id,failures=EXCLUDED.failures,last_outcome=EXCLUDED.last_outcome,
          checked_at=clock_timestamp(),next_attempt_at=EXCLUDED.next_attempt_at`,
      [config.scope,row.candidate_key,signature,queueId,failures,outcome,failures?retryDelay(failures):config.interval]);
      await client.query("COMMIT");
    }
    return {state:"SCANNED",candidates:rows.length,queued,pending,completed,failed};
  } finally {await client.query("ROLLBACK").catch(()=>{});if(locked)await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[lockKey]);client.release();}
}

async function main() {
 const config=loadAutoConfig();
 if(!process.env.HISTORY_AUTO_DATABASE_URL)throw Error("HISTORY_AUTO_DATABASE_URL is required");
 const pool=new pg.Pool({connectionString:process.env.HISTORY_AUTO_DATABASE_URL,max:2,statement_timeout:15000,connectionTimeoutMillis:5000});
 let running=true;process.on("SIGTERM",()=>{running=false;});process.on("SIGINT",()=>{running=false;});
 try {do {
   try {const result=await tick(pool,config);await writeFile('/tmp/gowm-history-auto-health.json',JSON.stringify({ok:true,at:Date.now(),...result}));console.log(JSON.stringify(result));}
   catch {await writeFile('/tmp/gowm-history-auto-health.json',JSON.stringify({ok:false,at:Date.now()}));console.error('history auto tick failed');if(process.argv.includes('--once'))process.exitCode=1;}
   if(process.argv.includes('--once'))break;
   for(let i=0;i<config.interval&&running;i++)await new Promise(r=>setTimeout(r,1000));
 }while(running);}finally{await pool.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void main().catch(error=>{console.error(error.message);process.exitCode=1;});
