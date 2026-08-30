import { describe,expect,it } from "vitest";
import type pg from "pg";
import { validateContract,type GowmV07HistoricalTrajectoryQuery,type GowmV07QuerySnapshotManifest } from "../../packages/platform/contract-runtime/src/index.js";
import { createHistoricalTraceProvider } from "../../services/providers/historical-trace-provider/src/provider.js";
import { HistoricalTraceRepository,historicalSemanticRequestHash } from "../../services/providers/historical-trace-provider/src/repository.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";

const HASH=`sha256:${"b".repeat(64)}` as const;
const CAPTURED_AT="2026-08-30T10:00:00.000Z";
const input:GowmV07HistoricalTrajectoryQuery={
  subjectReferenceKey:{namespace:"gowm",kind:"WORLD_OBJECT",id:"vehicle-2",version:"7"},
  executionIntervalReferenceKey:{namespace:"gowm",kind:"TASK_EXECUTION_INTERVAL",id:"interval-ref-1",version:"1"},
  phaseScope:"EXECUTION_ENVELOPE",sourceSelection:{mode:"EXPLICIT_SOURCE",sourceKey:"gps-a",trackerSessionKey:"session-a"},
  sourceSelectionProfileReferenceKey:{namespace:"gowm",kind:"HISTORY_METHOD_PROFILE",id:"trajectory-single-authoritative-v1",version:"1.0"},
  maximumInlinePoints:2
};

describe("historical trace provider",()=>{
  it("registers only the PREVIEW operation and returns a pinned, bounded, gap-preserving revision",async()=>{
    const semanticHash=historicalSemanticRequestHash(input);
    const effective:satisfiesManifest={
      querySnapshotId:"snapshot-history-pinned",mode:"PINNED",consistency:"PINNED",capturedAt:CAPTURED_AT,
      resources:[{resourceKind:"HISTORICAL_TRAJECTORY",resourceId:"gowm:trajectory-ref-1",version:"2",contentHash:HASH,pinning:"PINNED"}],
      manifestHash:HASH
    };
    const {pool,queries}=fakePool((sql)=>{
      if (sql.includes("task_execution_interval_revision_by_reference_as_of")) return [intervalRow()];
      if (sql.includes("historical_trajectory_outcome_as_of")) return [{
        outcome_status:"AVAILABLE",reason_code:"TRAJECTORY_AVAILABLE",reason_codes:["TRAJECTORY_AVAILABLE"],projection_pending:false,
        analysis_id:"00000000-0000-4000-8000-000000000050",content_hash:HASH,created_at:"2026-08-30T09:31:00.000Z"
      }];
      if (sql.includes("timestampN(")) return [
        {ordinality:"1",observed_at:"2026-08-30T08:00:00.000Z",position:{type:"Point",coordinates:[120.1,30.1]}},
        {ordinality:"2",observed_at:"2026-08-30T09:00:00.000Z",position:{type:"Point",coordinates:[120.2,30.2]}}
      ];
      if (sql.includes("historical_trajectory_revision_by_reference_as_of")) return [trajectoryRow(semanticHash)];
      if (sql.includes("historical_trajectory_segment")) return [{trajectory_revision_id:"00000000-0000-4000-8000-000000000020",segment_no:1}];
      if (sql.includes("historical_trajectory_gap")) return [];
      if (sql.includes("historical_trajectory_excluded_period")) return [];
      if (sql.includes("historical_trajectory_input")) return lineageInputs();
      if (sql.includes("tracklet_version_as_of")) return [{
        ordinality:"1",source_key:"gps-a",tracker_session_key:"session-a",analysis_space_key:"metric-default",
        tracklet_id:"00000000-0000-4000-8000-000000000030",tracklet_version_id:"00000000-0000-4000-8000-000000000031",
        version_no:3,finalization_state:"SEALED",finalization_revision_id:"00000000-0000-4000-8000-000000000032",
        finalization_revision_no:1,observed_through:"2026-08-30T09:00:00.000Z",content_hash:HASH,created_at:"2026-08-30T09:20:00.000Z"
      }];
      return [];
    });

    const provider=createHistoricalTraceProvider({pool});
    expect(provider.runtime.manifest.provider).toMatchObject({providerId:"gowm.historical-trace",providerVersion:"0.7.0"});
    expect(provider.runtime.manifest.capabilities).toHaveLength(1);
    expect(provider.runtime.manifest.capabilities[0]).toMatchObject({
      operationId:"history.get-trajectory",semanticRole:"DOMAIN_ANALYSIS",dataBinding:"WORLD_SNAPSHOT_BOUND",
      resultSemantics:"DERIVED_ANALYSIS",executionBindings:["SYNC_HTTP","VERSIONED_SQL_CONTRACT"],
      criticalPathPolicy:"REMOTE_ONLY",maturity:"PREVIEW",scopePolicy:"DATA_SCOPE_REQUIRED",
      snapshotPolicy:{dataSnapshot:"REQUIRED",computeSnapshot:"REQUIRED",resourceResolution:"DISCOVER_RESOURCES"},
      limits:{maximumInputBytes:1_048_576,maximumOutputBytes:16_777_216,maximumRows:1_000,maximumCandidates:5_000}
    });

    const result=await new HistoricalTraceRepository(pool).execute(input,"scope-a",effective,5_000);
    expect(result.status).toBe("COMPLETED");
    expect(result.output).toMatchObject({
      status:"COMPLETED",reasonCode:"TRAJECTORY_AVAILABLE",
      trajectoryReferenceKey:{id:"trajectory-ref-1",version:"2"},
      completeness:{temporalCoverageRatio:1,sampleCount:4,sequenceCount:1,gapCount:0,prefixComplete:true,suffixComplete:true},
      finalization:{state:"SEALED"}
    });
    expect(validateContract("urn:gowm:v0.7:historical-trajectory-result",result.output)).toMatchObject({valid:true});
    expect(result.output.preview).toHaveLength(2);
    expect(result.output.artifactReference).toMatchObject({digest:HASH,mediaType:"application/vnd.gowm.historical-trajectory+mfjson"});
    expect(result.output.inputTrackletVersions).toEqual([expect.objectContaining({sourceKey:"gps-a",trackerSessionKey:"session-a",versionNo:3})]);
    expect(result.dataSnapshot.capturedAt).toBe(CAPTURED_AT);
    expect(result.dataSnapshot.scopeDigest).toBe(sha256({dataScopeKey:"scope-a"}));
    expect(result.dataSnapshot.resources.map((item)=>item.referenceKey.kind)).toEqual(expect.arrayContaining([
      "HISTORICAL_TRAJECTORY","HISTORY_INPUT_SET","TASK_EXECUTION_INTERVAL","TRACKLET_VERSION","HISTORY_METHOD_PROFILE"
    ]));
    expect(result.evidenceReferences.map((item)=>item.evidenceType)).toEqual(expect.arrayContaining([
      "ANALYSIS_RECORD","CURRENT_PROJECTION_SOURCE","TRACKLET_VERSION"
    ]));
    expect(queries[0]?.sql).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(queries[1]).toEqual(expect.objectContaining({sql:expect.stringContaining("gowm_history_v1.set_data_scope"),values:["scope-a"]}));
    expect(queries.some((item)=>item.sql.includes("historical_trajectory_head"))).toBe(false);
    expect(queries.find((item)=>item.sql.includes("historical_trajectory_revision_by_reference_as_of")&&!item.sql.includes("timestampN"))?.values)
      .toEqual(["trajectory-ref-1",2,CAPTURED_AT]);
    expect(queries.find((item)=>item.sql.includes("timestampN"))?.sql).toContain("ST_Transform");
  });

  it("uses persisted as-of outcome authority instead of guessing source ambiguity",async()=>{
    const effective:satisfiesManifest={
      querySnapshotId:"snapshot-history-latest",mode:"LATEST_AT_START",consistency:"CONSISTENT_AT_START",
      capturedAt:CAPTURED_AT,resources:[],manifestHash:HASH
    };
    const {pool,queries}=fakePool((sql)=>{
      if (sql.includes("task_execution_interval_revision_by_reference_as_of")) return [intervalRow()];
      if (sql.includes("historical_trajectory_outcome_as_of")) return [{
        outcome_status:"INDETERMINATE",reason_code:"MULTIPLE_TRACKLETS_AMBIGUOUS",
        reason_codes:["MULTIPLE_TRACKLETS_AMBIGUOUS"],projection_pending:false,content_hash:HASH,
        created_at:"2026-08-30T09:30:00.000Z"
      }];
      return [];
    });
    const result=await new HistoricalTraceRepository(pool).execute(input,"scope-a",effective,5_000);
    expect(result).toMatchObject({status:"INDETERMINATE",output:{status:"INDETERMINATE",reasonCode:"MULTIPLE_TRACKLETS_AMBIGUOUS"}});
    expect(result.output.trajectoryReferenceKey).toBeUndefined();
    expect(queries.some((item)=>item.sql.includes("enqueue_historical_trajectory_projection"))).toBe(false);
  });

  it("idempotently enqueues the exact effective snapshot when no revision or outcome exists",async()=>{
    const effective:satisfiesManifest={
      querySnapshotId:"snapshot-history-enqueue",mode:"LATEST_AT_START",consistency:"CONSISTENT_AT_START",
      capturedAt:CAPTURED_AT,
      resources:[{
        resourceKind:"TASK_EXECUTION_INTERVAL",resourceId:"interval-ref-1",version:"1",
        contentHash:HASH,pinning:"PINNED",worldVersion:50
      }],manifestHash:HASH
    };
    const {pool,queries}=fakePool((sql)=>{
      if (sql.includes("task_execution_interval_revision_by_reference_as_of")) return [intervalRow()];
      if (sql.includes("enqueue_historical_trajectory_projection")) return [{queue_id:"00000000-0000-4000-8000-000000000099"}];
      return [];
    });

    const result=await new HistoricalTraceRepository(pool).execute(input,"scope-a",effective,5_000);
    expect(result).toMatchObject({
      status:"PARTIAL",output:{status:"PARTIAL",reasonCode:"PROJECTION_PENDING"},
      rows:0,candidates:0
    });
    const enqueue=queries.find((item)=>item.sql.includes("enqueue_historical_trajectory_projection"));
    expect(enqueue?.values?.slice(0,8)).toEqual([
      "scope-a","vehicle-2","interval-ref-1",1,"EXECUTION_ENVELOPE",
      historicalSemanticRequestHash(input),HASH,CAPTURED_AT
    ]);
    expect(JSON.parse(String(enqueue?.values?.[8]))).toEqual(input);
    expect(JSON.parse(String(enqueue?.values?.[9]))).toEqual(effective);
    const enqueueIndex=queries.indexOf(enqueue!);
    expect(queries[enqueueIndex-4]?.sql).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(queries[enqueueIndex-3]).toEqual(expect.objectContaining({
      sql:expect.stringContaining("gowm_history_v1.set_data_scope"),values:["scope-a"]
    }));
    expect(queries.filter((item)=>item.sql.includes("enqueue_historical_trajectory_projection"))).toHaveLength(1);
  });
});

type satisfiesManifest=GowmV07QuerySnapshotManifest;

function intervalRow():Record<string,unknown> {
  return {
    reference_key:"interval-ref-1",interval_revision_id:"00000000-0000-4000-8000-000000000010",revision_no:1,
    execution_range:'["2026-08-30 08:00:00+00","2026-08-30 09:00:00+00")',lifecycle_state:"CLOSED",stability_state:"SEALED",
    input_event_set_hash:HASH,profile_key:"task-interval-observed-v1",profile_version:"1.0",profile_hash:HASH,
    world_version:"50",content_hash:HASH,created_at:"2026-08-30T09:05:00.000Z"
  };
}

function trajectoryRow(semanticHash:string):Record<string,unknown> {
  return {
    historical_trajectory_id:"00000000-0000-4000-8000-000000000021",reference_key:"trajectory-ref-1",
    subject_reference_key:"vehicle-2",phase_scope:"EXECUTION_ENVELOPE",semantic_request_hash:semanticHash,
    trajectory_revision_id:"00000000-0000-4000-8000-000000000020",revision_no:2,
    interval_revision_id:"00000000-0000-4000-8000-000000000010",
    requested_periods:[{start:"2026-08-30T08:00:00.000Z",end:"2026-08-30T09:00:00.000Z",bounds:"[)"}],
    defined_periods:[{start:"2026-08-30T08:00:00.000Z",end:"2026-08-30T09:00:00.000Z",bounds:"[)"}],
    start_event_time:"2026-08-30T08:00:00.000Z",end_event_time:"2026-08-30T09:00:00.000Z",
    sample_count:4,sequence_count:1,gap_count:0,temporal_coverage_ratio:1,prefix_complete:true,suffix_complete:true,
    finalization_state:"SEALED",input_set_hash:HASH,profile_key:"trajectory-single-authoritative-v1",profile_version:"1.0",
    profile_hash:HASH,world_version:"51",content_hash:HASH,analysis_id:"00000000-0000-4000-8000-000000000050",
    created_at:"2026-08-30T09:30:00.000Z"
  };
}

function lineageInputs():Record<string,unknown>[] {
  return [{
    input_no:1,input_kind:"TASK_INTERVAL_REVISION",resource_namespace:"gowm",resource_kind:"TASK_EXECUTION_INTERVAL",
    resource_id:"interval-ref-1",resource_version:"1",resource_content_hash:HASH,pinning:"PINNED",authority:"gowm_history_v1",analysis_input_no:1
  },{
    input_no:2,input_kind:"TRACKLET_VERSION",resource_namespace:"gowm",resource_kind:"TRACKLET_VERSION",
    resource_id:"00000000-0000-4000-8000-000000000031",resource_version:"3",resource_content_hash:HASH,
    pinning:"PINNED",authority:"gowm_history_v1",analysis_input_no:2
  },{
    input_no:3,input_kind:"METHOD_PROFILE",resource_namespace:"gowm",resource_kind:"HISTORY_METHOD_PROFILE",
    resource_id:"trajectory-single-authoritative-v1",resource_version:"1.0",resource_content_hash:HASH,
    pinning:"PINNED",authority:"gowm_history_v1",analysis_input_no:3
  },{
    input_no:4,input_kind:"TRACKLET_FINALIZATION_REVISION",resource_namespace:"gowm",resource_kind:"TRACKLET_FINALIZATION",
    resource_id:"00000000-0000-4000-8000-000000000032",resource_version:"1",resource_content_hash:HASH,
    pinning:"PINNED",authority:"gowm_history_v1",analysis_input_no:4
  }];
}

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
