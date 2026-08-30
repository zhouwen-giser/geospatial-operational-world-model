import { describe,expect,it } from "vitest";
import type pg from "pg";
import { validateContract,type GowmV07QuerySnapshotManifest,type GowmV07TaskExecutionIntervalResult } from "../../packages/platform/contract-runtime/src/index.js";
import { createOperationalRealityProvider } from "../../services/providers/operational-reality-provider/src/provider.js";
import { OperationalRealityProviderRepository } from "../../services/providers/operational-reality-provider/src/repository.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";

const HASH=`sha256:${"a".repeat(64)}` as const;
const CAPTURED_AT="2026-08-30T10:00:00.000Z";
const effective:GowmV07QuerySnapshotManifest={
  querySnapshotId:"snapshot-interval-test",mode:"LATEST_AT_START",consistency:"CONSISTENT_AT_START",
  capturedAt:CAPTURED_AT,resources:[],manifestHash:HASH
};
const input={
  taskReferenceKey:{namespace:"gowm",kind:"OPERATIONAL_TASK" as const,id:"task-ref-1",version:"1"},
  selection:{kind:"LATEST" as const},phaseScope:"EXECUTION_ENVELOPE" as const
};

describe("operational task execution interval provider",()=>{
  it("declares PREVIEW discovery and performs a scoped head-free as-of read",async()=>{
    const {pool,queries}=fakePool((sql)=>{
      if (sql.includes("task_execution_intervals_as_of")) return [{
        interval_id:"00000000-0000-4000-8000-000000000001",task_reference_key:"task-ref-1",execution_no:1,
        reference_key:"task-interval-ref-1",interval_revision_id:"00000000-0000-4000-8000-000000000002",revision_no:2,
        execution_range:'["2026-08-30 08:00:00+00","2026-08-30 09:00:00+00")',lifecycle_state:"CLOSED",
        derivation_kind:"OBSERVED_ONLY",stability_state:"SEALED",start_event_id:"event-start",terminal_event_id:"event-stop",
        input_event_set_hash:HASH,profile_key:"task-interval-observed-v1",profile_version:"1.0",profile_hash:HASH,
        confidence:0.95,reason_codes:["INTERVALS_AVAILABLE"],world_version:"41",content_hash:HASH,
        created_at:"2026-08-30T09:01:00.000Z"
      }];
      if (sql.includes("gowm_operational_reality_v1.task_event")) return [
        {event_id:"event-start",event_type:"EXECUTION_STARTED_OBSERVED",created_at:"2026-08-30T08:00:01.000Z",world_version:"40"},
        {event_id:"event-stop",event_type:"EXECUTION_STOPPED_OBSERVED",created_at:"2026-08-30T09:00:01.000Z",world_version:"41"}
      ];
      if (sql.includes("task_execution_phase")) return [{
        interval_revision_id:"00000000-0000-4000-8000-000000000002",phase_no:1,phase_kind:"RUNNING",
        phase_range:'["2026-08-30 08:00:00+00","2026-08-30 09:00:00+00")',reason_codes:[]
      }];
      return [];
    });
    const provider=createOperationalRealityProvider({pool});
    const capability=provider.runtime.manifest.capabilities.find((item)=>item.operationId==="operational-task.get-execution-intervals");
    expect(capability).toMatchObject({
      semanticRole:"PROJECTION_QUERY",dataBinding:"WORLD_SNAPSHOT_BOUND",resultSemantics:"WORLD_PROJECTION",
      maturity:"PREVIEW",scopePolicy:"DATA_SCOPE_REQUIRED",
      snapshotPolicy:{dataSnapshot:"REQUIRED",computeSnapshot:"REQUIRED",resourceResolution:"DISCOVER_RESOURCES"}
    });
    expect(capability?.ports.outputs).toEqual(expect.arrayContaining([expect.objectContaining({
      name:"executionIntervalReferenceKey",path:"/intervals/0/executionIntervalReferenceKey",
      schemaUri:"urn:gowm:v0.7:reference-key",valueKind:"REFERENCE_KEY"
    })]));

    const repository=new OperationalRealityProviderRepository(pool);
    const result=await repository.execute("operational-task.get-execution-intervals",input,"scope-a",effective,5_000);
    const output=result.output as GowmV07TaskExecutionIntervalResult;
    expect(output).toMatchObject({status:"COMPLETED",reasonCode:"INTERVALS_AVAILABLE",truncated:false});
    expect(validateContract("urn:gowm:v0.7:task-execution-interval-result",output)).toMatchObject({valid:true});
    expect(output.intervals[0]).toMatchObject({
      executionNo:1,revisionNo:2,lifecycleState:"CLOSED",derivationKind:"OBSERVED",
      start:"2026-08-30T08:00:00.000Z",end:"2026-08-30T09:00:00.000Z"
    });
    expect(result.dataSnapshot.capturedAt).toBe(CAPTURED_AT);
    expect(result.dataSnapshot.scopeDigest).toBe(sha256({dataScopeKey:"scope-a"}));
    expect(result.dataSnapshot.resources.map((item)=>item.referenceKey.kind)).toEqual(expect.arrayContaining([
      "OPERATIONAL_TASK","TASK_EXECUTION_INTERVAL","TASK_EXECUTION_EVENT_SET","HISTORY_METHOD_PROFILE"
    ]));
    expect(queries[0]?.sql).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(queries[1]).toEqual(expect.objectContaining({sql:expect.stringContaining("gowm_history_v1.set_data_scope"),values:["scope-a"]}));
    expect(queries.find((item)=>item.sql.includes("task_execution_intervals_as_of"))?.values?.[1]).toBe(CAPTURED_AT);
    expect(queries.some((item)=>item.sql.includes("task_execution_interval_head"))).toBe(false);
  });

  it("reports materialization lag as PARTIAL/PROJECTION_PENDING",async()=>{
    const {pool}=fakePool((sql)=>sql.includes("gowm_operational_reality_v1.task_event")?[{
      event_id:"event-start",event_type:"EXECUTION_STARTED_OBSERVED",created_at:"2026-08-30T08:00:01.000Z",world_version:"40"
    }]:[]);
    const result=await new OperationalRealityProviderRepository(pool).execute(
      "operational-task.get-execution-intervals",input,"scope-a",effective,5_000
    );
    expect(result.status).toBe("PARTIAL");
    expect(result.output).toMatchObject({status:"PARTIAL",reasonCode:"PROJECTION_PENDING",intervals:[]});
  });
});

function fakePool(resolve:(sql:string,values:readonly unknown[]|undefined)=>Record<string,unknown>[]) {
  const queries:Array<{sql:string;values?:readonly unknown[]}>=[];
  const client={
    async query(sql:string,values?:readonly unknown[]) {
      queries.push({sql,...(values===undefined?{}:{values})});
      const rows=resolve(sql,values);
      return {rows,rowCount:rows.length};
    },release() {}
  } as unknown as pg.PoolClient;
  const pool={connect:async()=>client} as unknown as pg.Pool;
  return {pool,queries};
}
