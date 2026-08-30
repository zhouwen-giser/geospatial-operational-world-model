import pg from "pg";
import type {
  DataSnapshotContext,
  EvidenceReference,
  GowmV04OperationalQueryRequest,
  GowmV07QuerySnapshotManifest,
  GowmV07TaskExecutionIntervalQuery,
  GowmV07TaskExecutionIntervalResult,
  GowmV07TaskExecutionIntervalResultInterval,
  GowmV07TaskExecutionIntervalResultTimeRange
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError,sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import { OperationalCorrelationRepository } from "../../../../packages/runtime/src/operational-correlation-repository.js";
import { OperationalObservabilityRepository } from "../../../../packages/runtime/src/operational-observability-repository.js";
import { OperationalPredicateRepository } from "../../../../packages/runtime/src/operational-predicate-repository.js";
import { OperationalReadRepository } from "../../../../packages/runtime/src/operational-read-repository.js";
import type { OperationalRealityOperationId } from "./schemas.js";

export interface OperationalProviderResult {
  output?: unknown;status?: "COMPLETED"|"PARTIAL"|"NO_DATA"|"INDETERMINATE";dataSnapshot: DataSnapshotContext;
  evidenceReferences?: EvidenceReference[];rows: number;candidates: number;warnings: string[];
}

const EXECUTION_EVENT_TYPES = new Set([
  "EXECUTION_STARTED_OBSERVED","EXECUTION_PROGRESS_OBSERVED","EXECUTION_PAUSED_OBSERVED",
  "EXECUTION_RESUMED_OBSERVED","EXECUTION_STOPPED_OBSERVED","CONTROL_COMPLETED_REPORTED","EXECUTION_FAILED_OBSERVED",
  "EXECUTION_CANCELLED_OBSERVED"
]);

interface TaskExecutionIntervalRow extends Record<string,unknown> {
  interval_id: unknown;task_reference_key: unknown;execution_no: unknown;reference_key: unknown;
  interval_revision_id: unknown;revision_no: unknown;execution_range: unknown;lifecycle_state: unknown;
  derivation_kind: unknown;stability_state: unknown;start_event_id: unknown;terminal_event_id: unknown;
  input_event_set_hash: unknown;profile_key: unknown;profile_version: unknown;profile_hash: unknown;
  confidence: unknown;reason_codes: unknown;world_version: unknown;content_hash: unknown;created_at: unknown;
}

interface TaskExecutionPhaseRow extends Record<string,unknown> {
  interval_revision_id: unknown;phase_no: unknown;phase_kind: unknown;phase_range: unknown;
  start_event_id: unknown;end_event_id: unknown;confidence: unknown;reason_codes: unknown;
}

interface TaskEventStateRow extends Record<string,unknown> {
  event_id: unknown;event_type: unknown;created_at: unknown;world_version: unknown;
}

export class OperationalRealityProviderRepository {
  private readonly reads: OperationalReadRepository;
  private readonly correlations: OperationalCorrelationRepository;
  private readonly predicates: OperationalPredicateRepository;
  private readonly observability: OperationalObservabilityRepository;
  constructor(readonly pool: pg.Pool,private readonly now:()=>Date=()=>new Date()) {
    this.reads=new OperationalReadRepository(pool);this.correlations=new OperationalCorrelationRepository(pool);
    this.predicates=new OperationalPredicateRepository(pool);this.observability=new OperationalObservabilityRepository(pool);
  }

  async execute(
    operationId:OperationalRealityOperationId,input:unknown,dataScopeKey:string,
    effectiveSnapshot?:GowmV07QuerySnapshotManifest,deadlineRemainingMs=10_000
  ):Promise<OperationalProviderResult> {
    if (!dataScopeKey.trim()) throw new ProviderProtocolError("SCOPE_DENIED","data scope is required");
    if (operationId==="operational-task.get-execution-intervals") {
      if (!effectiveSnapshot) throw new ProviderProtocolError("SCHEMA_MISMATCH","effective query snapshot is required");
      return this.executionIntervals(input as GowmV07TaskExecutionIntervalQuery,dataScopeKey,effectiveSnapshot,deadlineRemainingMs);
    }
    const query=input as GowmV04OperationalQueryRequest;
    if (operationId==="predicate.evaluate") {
      const stored=await this.predicates.evaluate(dataScopeKey,input);
      return this.result(dataScopeKey,stored.evaluation,1,1);
    }
    if (operationId==="observability.evaluate") {
      if (!query.referenceKey) throw new ProviderProtocolError("INVALID_REQUEST","referenceKey is required");
      const to=query.timeRange?.to??this.now().toISOString();
      const from=query.timeRange?.from??new Date(Date.parse(to)-300_000).toISOString();
      const stored=await this.observability.assess({
        dataScopeKey,subjectReferenceKey:query.referenceKey,timeRange:{from,to},
        expectedSources:await this.sources(dataScopeKey,query.referenceKey.id),freshnessSlaSeconds:300
      });
      return this.result(dataScopeKey,stored.assessment,1,1);
    }
    if (operationId==="correlation.resolve") {
      const hint=query.correlationHints?.[0];
      if (!hint) throw new ProviderProtocolError("INVALID_REQUEST","one correlation hint is required");
      const finding=await this.correlations.resolve({
        dataScopeKey,correlationHint:hint,actorReferenceKeys:query.actorReferenceKeys??[],timeRange:query.timeRange
      });
      return this.result(dataScopeKey,finding,1,1);
    }
    if (operationId==="operational-task.find-by-correlation" || operationId==="world-event.find-by-correlation") {
      const hint=query.correlationHints?.[0];
      if (!hint) throw new ProviderProtocolError("INVALID_REQUEST","one correlation hint is required");
      const finding=await this.correlations.resolve({
        dataScopeKey,correlationHint:hint,actorReferenceKeys:query.actorReferenceKeys??[],timeRange:query.timeRange
      });
      if (!finding.operationalTaskReferenceKey) {
        const empty=operationId.startsWith("world-event")
          ? {schemaVersion:"1.0",events:[],truncated:false}
          : {schemaVersion:"1.0",tasks:[],correlationFindings:[finding],truncated:false};
        return this.result(dataScopeKey,empty,0,0,"NO_DATA");
      }
      if (operationId.startsWith("world-event")) {
        const timeline=await this.reads.timeline(dataScopeKey,finding.operationalTaskReferenceKey,{...(query.limit===undefined?{}:{limit:query.limit})});
        return {output:timeline.result,dataSnapshot:await this.snapshot(dataScopeKey,timeline.snapshot),rows:timeline.result.events.length,candidates:1,warnings:[]};
      }
      const found=await this.reads.find(dataScopeKey,{referenceKey:finding.operationalTaskReferenceKey,...(query.limit===undefined?{}:{limit:query.limit})});
      return {output:{...found.result,correlationFindings:[finding]},dataSnapshot:await this.snapshot(dataScopeKey,found.snapshot),rows:found.result.tasks.length,candidates:1,warnings:[]};
    }
    if (operationId==="operational-task.get-timeline") {
      if (!query.referenceKey) throw new ProviderProtocolError("INVALID_REQUEST","referenceKey is required");
      const timeline=await this.reads.timeline(dataScopeKey,query.referenceKey,{
        ...(query.timeRange?.from===undefined?{}:{from:query.timeRange.from}),
        ...(query.timeRange?.to===undefined?{}:{to:query.timeRange.to}),...(query.limit===undefined?{}:{limit:query.limit})
      });
      return {output:timeline.result,dataSnapshot:await this.snapshot(dataScopeKey,timeline.snapshot),rows:timeline.result.events.length,candidates:timeline.result.events.length,warnings:[]};
    }
    const found=await this.reads.find(dataScopeKey,{
      ...(query.referenceKey===undefined?{}:{referenceKey:query.referenceKey}),
      ...(query.actorReferenceKeys===undefined?{}:{actorReferenceKeys:query.actorReferenceKeys}),
      ...(query.timeRange?.from===undefined?{}:{from:query.timeRange.from}),
      ...(query.timeRange?.to===undefined?{}:{to:query.timeRange.to}),
      ...(operationId==="operational-task.get"?{limit:1}:query.limit===undefined?{}:{limit:query.limit})
    });
    if (operationId==="operational-task.get") {
      const item=found.result.tasks[0];
      return {output:item,status:item?"COMPLETED":"NO_DATA",dataSnapshot:await this.snapshot(dataScopeKey,found.snapshot),rows:item?1:0,candidates:item?1:0,warnings:[]};
    }
    return {output:found.result,dataSnapshot:await this.snapshot(dataScopeKey,found.snapshot),rows:found.result.tasks.length,candidates:found.result.tasks.length,warnings:[]};
  }

  async readiness():Promise<{ready:boolean;reasons:string[]}> {
    try {
      await this.pool.query("SELECT * FROM gowm_operational_reality_v1.task_snapshot LIMIT 0");
      await this.pool.query("SELECT * FROM gowm_history_v1.task_execution_interval_effective LIMIT 0");
      return {ready:true,reasons:[]};
    }
    catch { return {ready:false,reasons:["operational reality SQL contract is unavailable"]}; }
  }

  private async executionIntervals(
    input:GowmV07TaskExecutionIntervalQuery,dataScopeKey:string,effectiveSnapshot:GowmV07QuerySnapshotManifest,
    deadlineRemainingMs:number
  ):Promise<OperationalProviderResult> {
    const capturedAt=validCapturedAt(effectiveSnapshot.capturedAt);
    const client=await this.pool.connect().catch((error:unknown)=>{
      throw new ProviderProtocolError("PROVIDER_NOT_READY","operational interval read pool is unavailable",{retryable:true,cause:error});
    });
    let transactionOpen=false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionOpen=true;
      // This must be the first statement after BEGIN: every following view/function is scope-filtered.
      await client.query("SELECT gowm_history_v1.set_data_scope($1::text)",[dataScopeKey]);
      const timeout=Math.max(1,Math.min(10_000,Math.floor(deadlineRemainingMs)));
      await client.query("SELECT set_config('statement_timeout',$1::text,true)",[`${timeout}ms`]);
      await client.query("SELECT set_config('lock_timeout',$1::text,true)",[`${Math.min(timeout,1_000)}ms`]);

      const limit=input.selection.kind==="ALL"?Math.min(input.selection.limit,250):1;
      const values:unknown[]=[input.taskReferenceKey.id,capturedAt];
      const filters:string[]=[];
      if (input.selection.kind==="EXECUTION_NO") {
        values.push(input.selection.executionNo);
        filters.push(`execution_no=$${values.length}::integer`);
      }
      values.push(limit+1);
      const intervalRows=await client.query<TaskExecutionIntervalRow>(
        `SELECT * FROM gowm_history_v1.task_execution_intervals_as_of($1::text,$2::timestamptz)
         ${filters.length?`WHERE ${filters.join(" AND ")}`:""}
         ORDER BY execution_no DESC,revision_no DESC
         LIMIT $${values.length}::integer`,values
      );
      const allRows=intervalRows.rows;
      const truncated=allRows.length>limit;
      const selected=allRows.slice(0,limit);

      const eventRows=await client.query<TaskEventStateRow>(
        `SELECT event_id,event_type,created_at,world_version
         FROM gowm_operational_reality_v1.task_event
         WHERE reference_key=$1::text AND created_at<=$2::timestamptz
         ORDER BY created_at,event_id`,[input.taskReferenceKey.id,capturedAt]
      );
      const executionEvents=eventRows.rows.filter((row)=>EXECUTION_EVENT_TYPES.has(String(row.event_type)));

      const revisionIds=selected.map((row)=>String(row.interval_revision_id));
      const phases=revisionIds.length===0?[]:(await client.query<TaskExecutionPhaseRow>(
        `SELECT * FROM gowm_history_v1.task_execution_phase
         WHERE interval_revision_id=ANY($1::uuid[])
         ORDER BY interval_revision_id,phase_no`,[revisionIds]
      )).rows;
      await client.query("COMMIT");
      transactionOpen=false;

      const mapped=selected.map((row)=>mapExecutionInterval(row,phases,capturedAt,input.phaseScope));
      const pending=projectionPending(input,selected,executionEvents);
      const outcome=intervalOutcome(mapped,eventRows.rows.length,executionEvents.length,pending);
      const output:GowmV07TaskExecutionIntervalResult={
        schemaVersion:"1.0",status:outcome.status,reasonCode:outcome.reasonCode,intervals:mapped,truncated
      };
      const dataSnapshot=executionIntervalSnapshot(dataScopeKey,capturedAt,input,selected,eventRows.rows,effectiveSnapshot);
      return {
        output,status:outcome.status,dataSnapshot,rows:mapped.length,candidates:allRows.length,warnings:[
          "operationalIntervals.readContract=gowm_history_v1",
          "operationalIntervals.asOf=effectiveSnapshot.capturedAt",
          ...(truncated?["operationalIntervals.truncated=true"]:[])
        ]
      };
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK").catch(()=>undefined);
      if (error instanceof ProviderProtocolError) throw error;
      throw new ProviderProtocolError("PROVIDER_NOT_READY","operational interval as-of read failed",{retryable:true,cause:error});
    } finally {
      client.release();
    }
  }

  private async sources(scope:string,reference:string):Promise<string[]> {
    const result=await this.pool.query<{source_authority:string}>(
      `SELECT DISTINCT event.source_authority FROM operational_task_event event
       JOIN operational_task task ON task.operational_task_id=event.operational_task_id AND task.data_scope_key=event.data_scope_key
       WHERE event.data_scope_key=$1 AND task.reference_key=$2 ORDER BY event.source_authority`,[scope,reference]
    );
    if (result.rows.length) return result.rows.map((row)=>row.source_authority);
    const world=await this.pool.query<{source:string}>(
      `SELECT state.source FROM world_reference_identity identity JOIN world_object_state state ON state.object_id=identity.internal_id
       WHERE identity.data_scope_key=$1 AND identity.reference_key=$2 AND state.source IS NOT NULL`,[scope,reference]
    );
    return world.rows.map((row)=>row.source);
  }

  private async result(scope:string,output:unknown,rows:number,candidates:number,status:"COMPLETED"|"NO_DATA"="COMPLETED"):Promise<OperationalProviderResult> {
    return {output,status,rows,candidates,warnings:[],dataSnapshot:await this.snapshot(scope,await this.reads.snapshot(scope))};
  }

  private async snapshot(scope:string,read?:{worldVersion:number;scopeDigest:string}):Promise<DataSnapshotContext> {
    const identity=await this.pool.query<{reference_key:string}>(
      "SELECT reference_key FROM world_reference_identity WHERE data_scope_key=$1 AND entity_kind='DATA_SCOPE'",[scope]
    );
    const ref=identity.rows[0]?.reference_key;
    if (!ref) throw new ProviderProtocolError("SCOPE_DENIED","data scope is unavailable");
    const capturedAt=this.now().toISOString();
    return {
      consistency:"CONSISTENT_AT_START",capturedAt,scopeDigest:sha256({dataScopeKey:scope}),resources:[{
        referenceKey:{namespace:"gowm",kind:"DATA_SCOPE",id:ref,version:read===undefined?"1":String(read.worldVersion)},authority:"GOWM Foundation",
        pinning:"AT_LEAST",digest:(read?.scopeDigest??sha256({dataScopeKey:scope,referenceKey:ref})) as `sha256:${string}`
      }]
    };
  }
}

function mapExecutionInterval(
  row:TaskExecutionIntervalRow,phases:TaskExecutionPhaseRow[],capturedAt:string,
  _phaseScope:GowmV07TaskExecutionIntervalQuery["phaseScope"]
):GowmV07TaskExecutionIntervalResultInterval {
  const range=parseRange(row.execution_range,capturedAt);
  const revisionId=String(row.interval_revision_id);
  const matching=phases.filter((phase)=>String(phase.interval_revision_id)===revisionId);
  const activePeriods:GowmV07TaskExecutionIntervalResultTimeRange[]=[];
  const pausedPeriods:GowmV07TaskExecutionIntervalResultTimeRange[]=[];
  for (const phase of matching) {
    const phaseRange=parseRange(phase.phase_range,capturedAt);
    if (!phaseRange) continue;
    const kind=String(phase.phase_kind).toUpperCase();
    if (kind==="PAUSED") pausedPeriods.push(phaseRange);
    else if (kind==="RUNNING"||kind==="ACTIVE") activePeriods.push(phaseRange);
  }
  const lifecycleState=enumValue(row.lifecycle_state,["OPEN","CLOSED","CONFLICTED"] as const,"lifecycle_state");
  const reasonCodes=stringArray(row.reason_codes);
  return {
    executionIntervalReferenceKey:intervalReferenceKey(row),executionNo:positiveInteger(row.execution_no,"execution_no"),
    revisionNo:positiveInteger(row.revision_no,"revision_no"),
    ...(range?{start:range.start,...(lifecycleState==="OPEN"?{}:{end:range.end})}:{}),
    lifecycleState,activePeriods,pausedPeriods,
    derivationKind:enumValue(row.derivation_kind,["OBSERVED","INFERRED","MIXED"] as const,"derivation_kind"),
    stabilityState:enumValue(row.stability_state,["PROVISIONAL","SEALED","CONFLICTED"] as const,"stability_state"),
    ...(row.confidence===null||row.confidence===undefined?{}:{confidence:unitNumber(row.confidence,"confidence")}),
    reasonCodes
  };
}

function intervalReferenceKey(row:TaskExecutionIntervalRow):GowmV07TaskExecutionIntervalResultInterval["executionIntervalReferenceKey"] {
  const value=jsonRecord(row.reference_key);
  return {
    namespace:typeof value?.namespace==="string"?value.namespace:"gowm",
    kind:"TASK_EXECUTION_INTERVAL",
    id:typeof value?.id==="string"?value.id:String(row.reference_key),
    version:String(row.revision_no)
  };
}

function projectionPending(
  input:GowmV07TaskExecutionIntervalQuery,intervals:TaskExecutionIntervalRow[],events:TaskEventStateRow[]
):boolean {
  if (events.length===0) return false;
  if (input.selection.kind==="EXECUTION_NO") {
    if (intervals.length>0) return false;
    return events.filter((row)=>String(row.event_type)==="EXECUTION_STARTED_OBSERVED").length>=input.selection.executionNo;
  }
  if (intervals.length===0) return true;
  const latestEvent=Math.max(...events.map((row)=>Date.parse(iso(row.created_at))));
  const latestProjection=Math.max(...intervals.map((row)=>Date.parse(iso(row.created_at))));
  return latestEvent>latestProjection;
}

function intervalOutcome(
  intervals:GowmV07TaskExecutionIntervalResultInterval[],taskEventCount:number,executionEventCount:number,pending:boolean
):{status:GowmV07TaskExecutionIntervalResult["status"];reasonCode:string} {
  if (taskEventCount===0) return {status:"NO_DATA",reasonCode:"TASK_NOT_FOUND"};
  if (executionEventCount===0) return {status:"NO_DATA",reasonCode:"NO_EXECUTION_EVENTS"};
  if (pending) return {status:"PARTIAL",reasonCode:"PROJECTION_PENDING"};
  if (intervals.length===0) return {status:"NO_DATA",reasonCode:"NO_EXECUTION_EVENTS"};
  const conflicted=intervals.find((interval)=>interval.lifecycleState==="CONFLICTED"||interval.stabilityState==="CONFLICTED");
  if (conflicted) return {
    status:"INDETERMINATE",
    reasonCode:conflicted.start===undefined||conflicted.reasonCodes.includes("EXECUTION_BOUNDARY_MISSING")
      ?"EXECUTION_BOUNDARY_MISSING":"EVENT_SEQUENCE_CONFLICT"
  };
  if (intervals.some((interval)=>interval.lifecycleState==="OPEN")) return {status:"PARTIAL",reasonCode:"OPEN_EXECUTION"};
  return {status:"COMPLETED",reasonCode:"INTERVALS_AVAILABLE"};
}

function executionIntervalSnapshot(
  dataScopeKey:string,capturedAt:string,input:GowmV07TaskExecutionIntervalQuery,intervals:TaskExecutionIntervalRow[],
  events:TaskEventStateRow[],effective:GowmV07QuerySnapshotManifest
):DataSnapshotContext {
  const authority="gowm_history_v1";
  const eventSetHashes=intervals.map((row)=>digest(row.input_event_set_hash,{intervalRevisionId:row.interval_revision_id}));
  const eventSetDigest=eventSetHashes.length===1?eventSetHashes[0] as `sha256:${string}`:sha256(
    eventSetHashes.length?eventSetHashes:events.map((row)=>({
      eventId:String(row.event_id),eventType:String(row.event_type),createdAt:iso(row.created_at),worldVersion:nonNegativeInteger(row.world_version,"world_version")
    }))
  );
  const resources:DataSnapshotContext["resources"]=[{
    referenceKey:{...input.taskReferenceKey},authority,pinning:"PINNED",
    digest:sha256({referenceKey:input.taskReferenceKey})
  }];
  for (const row of intervals) resources.push({
    referenceKey:intervalReferenceKey(row),authority,pinning:"PINNED",digest:digest(row.content_hash,{intervalRevisionId:row.interval_revision_id}),
    worldVersion:nonNegativeInteger(row.world_version,"world_version")
  });
  resources.push({
    referenceKey:{namespace:"gowm",kind:"TASK_EXECUTION_EVENT_SET",id:`event-set-${eventSetDigest.slice(7)}`,version:capturedAt},
    authority,pinning:"PINNED",digest:eventSetDigest,
    ...(events.length?{worldVersion:Math.max(...events.map((row)=>nonNegativeInteger(row.world_version,"world_version")))}:{})
  });
  const profiles=new Map<string,TaskExecutionIntervalRow>();
  for (const row of intervals) profiles.set(`${String(row.profile_key)}@${String(row.profile_version)}`,row);
  if (profiles.size===0) resources.push({
    referenceKey:{namespace:"gowm",kind:"HISTORY_METHOD_PROFILE",id:"task-interval-observed-v1",version:"1.0"},
    authority,pinning:"PINNED",digest:sha256({
      eventSemantics:"OBSERVED_ONLY",legacyResumeFromStarted:true,progressImpliesResume:false,sameTimeConflict:"CONFLICTED"
    })
  });
  else for (const row of profiles.values()) resources.push({
      referenceKey:{namespace:"gowm",kind:"HISTORY_METHOD_PROFILE",id:String(row.profile_key),version:String(row.profile_version)},
      authority,pinning:"PINNED",digest:digest(row.profile_hash,{profileKey:row.profile_key,profileVersion:row.profile_version})
    });
  if (resources.length>256) throw new ProviderProtocolError("BUDGET_EXCEEDED","execution interval snapshot resource budget exceeded");
  return {
    consistency:effective.consistency,capturedAt,
    scopeDigest:sha256({dataScopeKey,resources:resources.map((item)=>({
      referenceKey:item.referenceKey,...(item.digest===undefined?{}:{digest:item.digest}),
      ...(item.worldVersion===undefined?{}:{worldVersion:item.worldVersion})
    }))}),
    resources
  };
}

function parseRange(value:unknown,capturedAt:string):GowmV07TaskExecutionIntervalResultTimeRange|undefined {
  if (value===null||value===undefined) return undefined;
  if (typeof value==="object"&&!Array.isArray(value)) {
    const record=value as Record<string,unknown>;
    const lower=record.lower??record.start;
    const upper=record.upper??record.end;
    if (lower===null||lower===undefined) return undefined;
    return {start:iso(lower),end:isInfinite(upper)?capturedAt:iso(upper),bounds:"[)"};
  }
  const text=String(value);
  const match=/^[[(]\s*"?([^,\"]+)"?\s*,\s*"?([^\]")]+|)"?\s*[\])]$/.exec(text);
  if (!match?.[1]) return undefined;
  return {start:iso(match[1]),end:isInfinite(match[2])?capturedAt:iso(match[2]),bounds:"[)"};
}

function isInfinite(value:unknown):boolean {
  return value===null||value===undefined||String(value).trim()===""||String(value).toLowerCase()==="infinity";
}

function validCapturedAt(value:string):string {
  const parsed=new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new ProviderProtocolError("SCHEMA_MISMATCH","effective snapshot capturedAt is invalid");
  return parsed.toISOString();
}

function digest(value:unknown,fallback:unknown):`sha256:${string}` {
  const candidate=String(value??"");
  return /^sha256:[0-9a-f]{64}$/.test(candidate)?candidate as `sha256:${string}`:sha256(fallback);
}

function jsonRecord(value:unknown):Record<string,unknown>|undefined {
  if (typeof value==="object"&&value!==null&&!Array.isArray(value)) return value as Record<string,unknown>;
  if (typeof value!=="string"||!value.trim().startsWith("{")) return undefined;
  try {
    const parsed=JSON.parse(value) as unknown;
    return typeof parsed==="object"&&parsed!==null&&!Array.isArray(parsed)?parsed as Record<string,unknown>:undefined;
  } catch { return undefined; }
}

function stringArray(value:unknown):string[] {
  const parsed=typeof value==="string"&&value.trim().startsWith("[")?JSON.parse(value) as unknown:value;
  return Array.isArray(parsed)?parsed.map((item)=>String(item)):[];
}

function enumValue<const T extends readonly string[]>(value:unknown,allowed:T,name:string):T[number] {
  const candidate=String(value);
  if (!allowed.includes(candidate)) throw new ProviderProtocolError("SCHEMA_MISMATCH",`${name} is outside the frozen contract`);
  return candidate as T[number];
}

function positiveInteger(value:unknown,name:string):number {
  const number=Number(value);
  if (!Number.isSafeInteger(number)||number<1) throw new ProviderProtocolError("SCHEMA_MISMATCH",`${name} must be a positive integer`);
  return number;
}

function nonNegativeInteger(value:unknown,name:string):number {
  const number=Number(value);
  if (!Number.isSafeInteger(number)||number<0) throw new ProviderProtocolError("SCHEMA_MISMATCH",`${name} must be a non-negative integer`);
  return number;
}

function unitNumber(value:unknown,name:string):number {
  const number=Number(value);
  if (!Number.isFinite(number)||number<0||number>1) throw new ProviderProtocolError("SCHEMA_MISMATCH",`${name} must be between zero and one`);
  return number;
}

function iso(value:unknown):string {
  const parsed=value instanceof Date?value:new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new ProviderProtocolError("SCHEMA_MISMATCH","database timestamp is invalid");
  return parsed.toISOString();
}
