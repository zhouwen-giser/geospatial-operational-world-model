import pg from "pg";
import type { DataSnapshotContext,GowmV04OperationalQueryRequest } from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError,sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import { OperationalCorrelationRepository } from "../../../../packages/runtime/src/operational-correlation-repository.js";
import { OperationalObservabilityRepository } from "../../../../packages/runtime/src/operational-observability-repository.js";
import { OperationalPredicateRepository } from "../../../../packages/runtime/src/operational-predicate-repository.js";
import { OperationalReadRepository } from "../../../../packages/runtime/src/operational-read-repository.js";
import type { OperationalRealityOperationId } from "./schemas.js";

export interface OperationalProviderResult {
  output?: unknown;status?: "COMPLETED"|"NO_DATA";dataSnapshot: DataSnapshotContext;
  rows: number;candidates: number;warnings: string[];
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

  async execute(operationId:OperationalRealityOperationId,input:unknown,dataScopeKey:string):Promise<OperationalProviderResult> {
    if (!dataScopeKey.trim()) throw new ProviderProtocolError("SCOPE_DENIED","data scope is required");
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
    try { await this.pool.query("SELECT * FROM gowm_operational_reality_v1.task_snapshot LIMIT 0");return {ready:true,reasons:[]}; }
    catch { return {ready:false,reasons:["operational reality SQL contract is unavailable"]}; }
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
