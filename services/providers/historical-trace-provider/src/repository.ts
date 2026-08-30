import type pg from "pg";
import type {
  DataSnapshotContext,
  EvidenceReference,
  GowmV07HistoricalGap,
  GowmV07HistoricalTrajectoryQuery,
  GowmV071HistoricalTrajectoryResult,
  GowmV071HistoricalTrajectoryResultInputTrackletVersion,
  GowmV071HistoricalTrajectoryResultPreviewPoint,
  GowmV071HistoricalTrajectoryResultTimeRange,
  GowmV07QuerySnapshotManifest
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { historicalSemanticRequestHash } from "../../../../packages/historical-trace-core/src/canonical-hash.js";
import { ProviderProtocolError,sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import { HISTORICAL_TRACE_SCHEMAS } from "./schemas.js";

export const HISTORICAL_TRACE_SQL={
  setScope:"SELECT gowm_history_v1.set_data_scope($1::text)",
  enqueueProjection:`SELECT gowm_history.enqueue_historical_trajectory_projection(
      $1::text,$2::text,$3::text,$4::integer,$5::text,$6::text,$7::text,
      $8::timestamptz,$9::jsonb,$10::jsonb
    ) AS queue_id`,
  intervalAsOf:`SELECT * FROM gowm_history_v1.task_execution_interval_revision_by_reference_as_of($1::text,$2::integer,$3::timestamptz)`,
  outcomeAsOf:`SELECT * FROM gowm_history_v1.historical_trajectory_outcome_as_of($1::text,$2::text,$3::text,$4::text,$5::timestamptz)`,
  trajectoryAsOf:`SELECT candidate.*,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('start',lower(period),'end',upper(period),'bounds','[)') ORDER BY lower(period)) FROM unnest(candidate.requested_time) period),'[]'::jsonb) AS requested_periods,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('start',lower(period),'end',upper(period),'bounds','[)') ORDER BY lower(period)) FROM unnest(candidate.defined_time) period),'[]'::jsonb) AS defined_periods
    FROM gowm_history_v1.historical_trajectory_as_of($1::text,$2::text,$3::text,$4::text,$5::timestamptz,NULL::integer) candidate`,
  trajectoryPinnedAsOf:`SELECT candidate.*,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('start',lower(period),'end',upper(period),'bounds','[)') ORDER BY lower(period)) FROM unnest(candidate.requested_time) period),'[]'::jsonb) AS requested_periods,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('start',lower(period),'end',upper(period),'bounds','[)') ORDER BY lower(period)) FROM unnest(candidate.defined_time) period),'[]'::jsonb) AS defined_periods
    FROM gowm_history_v1.historical_trajectory_revision_by_reference_as_of($1::text,$2::integer,$3::timestamptz) candidate`,
  segments:`SELECT * FROM gowm_history_v1.historical_trajectory_segment WHERE trajectory_revision_id=$1::uuid ORDER BY segment_no`,
  gaps:`SELECT * FROM gowm_history_v1.historical_trajectory_gap WHERE trajectory_revision_id=$1::uuid ORDER BY gap_no`,
  exclusions:`SELECT * FROM gowm_history_v1.historical_trajectory_excluded_period WHERE trajectory_revision_id=$1::uuid ORDER BY excluded_no`,
  inputs:`SELECT * FROM gowm_history_v1.historical_trajectory_input WHERE trajectory_revision_id=$1::uuid ORDER BY input_no`,
  tracklets:`WITH requested AS (
      SELECT tracklet_version_id,ordinality FROM unnest($1::uuid[]) WITH ORDINALITY item(tracklet_version_id,ordinality)
    ), pins AS (
      SELECT * FROM jsonb_to_recordset($2::jsonb) AS pin(finalization_revision_id uuid,revision_no integer)
    )
    SELECT requested.ordinality,matched.*
    FROM requested
    JOIN LATERAL (
      SELECT tracklet.*
      FROM pins
      CROSS JOIN LATERAL gowm_history_v1.tracklet_version_as_of(requested.tracklet_version_id,$3::timestamptz,pins.revision_no) tracklet
      WHERE tracklet.finalization_revision_id=pins.finalization_revision_id
      ORDER BY pins.revision_no DESC,pins.finalization_revision_id
      LIMIT 1
    ) matched ON true
    ORDER BY requested.ordinality`,
  preview:`WITH selected AS (
      SELECT candidate.trajectory,candidate.requested_time
      FROM gowm_history_v1.historical_trajectory_revision_by_reference_as_of($1::text,$2::integer,$3::timestamptz) candidate
    ), requested AS (
      SELECT sample_index,ordinality FROM unnest($4::integer[]) WITH ORDINALITY sample(sample_index,ordinality)
    )
    SELECT requested.ordinality,sample.observed_at,
      ST_AsGeoJSON(ST_Transform(valueN(selected.trajectory,requested.sample_index),4326))::jsonb AS position
    FROM selected
    CROSS JOIN requested
    CROSS JOIN LATERAL (
      SELECT timestampN(selected.trajectory,requested.sample_index) AS observed_at
    ) sample
    WHERE sample.observed_at IS NOT NULL
      AND selected.requested_time @> sample.observed_at
      AND valueN(selected.trajectory,requested.sample_index) IS NOT NULL
    ORDER BY requested.ordinality`
} as const;

interface HistoricalTraceRepositoryOptions {
  maximumRows?:number;maximumCandidates?:number;statementTimeoutMs?:number;lockTimeoutMs?:number;
}

export interface HistoricalTraceRepositoryResult {
  output:GowmV071HistoricalTrajectoryResult;
  status:"COMPLETED"|"PARTIAL"|"NO_DATA"|"INDETERMINATE";
  dataSnapshot:DataSnapshotContext;evidenceReferences:EvidenceReference[];
  rows:number;candidates:number;warnings:string[];
}

interface IntervalRow extends Record<string,unknown> {
  reference_key:unknown;interval_revision_id:unknown;revision_no:unknown;execution_range:unknown;
  lifecycle_state:unknown;stability_state:unknown;input_event_set_hash:unknown;profile_key:unknown;
  profile_version:unknown;profile_hash:unknown;world_version:unknown;content_hash:unknown;created_at:unknown;
}

interface OutcomeRow extends Record<string,unknown> {
  outcome_status:unknown;reason_code:unknown;reason_codes:unknown;projection_pending:unknown;
  analysis_id:unknown;content_hash:unknown;created_at:unknown;
}

interface TrajectoryRow extends Record<string,unknown> {
  historical_trajectory_id:unknown;reference_key:unknown;subject_reference_key:unknown;phase_scope:unknown;
  semantic_request_hash:unknown;trajectory_revision_id:unknown;revision_no:unknown;interval_revision_id:unknown;
  requested_periods:unknown;defined_periods:unknown;start_event_time:unknown;end_event_time:unknown;
  sample_count:unknown;sequence_count:unknown;gap_count:unknown;temporal_coverage_ratio:unknown;
  prefix_complete:unknown;suffix_complete:unknown;finalization_state:unknown;input_set_hash:unknown;
  profile_key:unknown;profile_version:unknown;profile_hash:unknown;world_version:unknown;content_hash:unknown;
  analysis_id:unknown;created_at:unknown;
}

interface ChildInputRow extends Record<string,unknown> {
  input_no:unknown;input_kind:unknown;resource_namespace:unknown;resource_kind:unknown;resource_id:unknown;
  resource_version:unknown;resource_content_hash:unknown;pinning:unknown;authority:unknown;
  analysis_input_no:unknown;analysis_input_set_kind:unknown;
}

interface TrackletRow extends Record<string,unknown> {
  source_key:unknown;tracker_session_key:unknown;analysis_space_key:unknown;tracklet_id:unknown;
  tracklet_version_id:unknown;version_no:unknown;finalization_state:unknown;finalization_revision_id:unknown;
  finalization_revision_no:unknown;observed_through:unknown;content_hash:unknown;created_at:unknown;
}

export class HistoricalTraceRepository {
  private readonly maximumRows:number;
  private readonly maximumCandidates:number;
  private readonly statementTimeoutMs:number;
  private readonly lockTimeoutMs:number;

  constructor(private readonly pool:pg.Pool,options:HistoricalTraceRepositoryOptions={}) {
    this.maximumRows=boundedInteger(options.maximumRows??1_000,1,1_000,"maximumRows");
    this.maximumCandidates=boundedInteger(options.maximumCandidates??5_000,1,5_000,"maximumCandidates");
    this.statementTimeoutMs=boundedInteger(options.statementTimeoutMs??5_000,1,30_000,"statementTimeoutMs");
    this.lockTimeoutMs=boundedInteger(options.lockTimeoutMs??1_000,1,5_000,"lockTimeoutMs");
  }

  async execute(
    input:GowmV07HistoricalTrajectoryQuery,dataScopeKey:string,effective:GowmV07QuerySnapshotManifest,
    deadlineRemainingMs:number
  ):Promise<HistoricalTraceRepositoryResult> {
    if (!dataScopeKey.trim()) throw new ProviderProtocolError("SCOPE_DENIED","data scope is required");
    const capturedAt=validTimestamp(effective.capturedAt,"effective snapshot capturedAt");
    const semanticRequestHash=historicalSemanticRequestHash(input);
    const exactIntervalRevision=positiveInteger(input.executionIntervalReferenceKey.version,"execution interval version");
    const client=await this.pool.connect().catch((error:unknown)=>{
      throw new ProviderProtocolError("PROVIDER_NOT_READY","historical trace read pool is unavailable",{retryable:true,cause:error});
    });
    let transactionOpen=false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionOpen=true;
      // Scope authorization is intentionally the first statement after BEGIN.
      await client.query(HISTORICAL_TRACE_SQL.setScope,[dataScopeKey]);
      const timeout=Math.max(1,Math.min(this.statementTimeoutMs,Math.floor(deadlineRemainingMs)));
      await client.query("SELECT set_config('statement_timeout',$1::text,true)",[`${timeout}ms`]);
      await client.query("SELECT set_config('lock_timeout',$1::text,true)",[`${Math.min(timeout,this.lockTimeoutMs)}ms`]);

      const intervalResult=await client.query<IntervalRow>(HISTORICAL_TRACE_SQL.intervalAsOf,[
        input.executionIntervalReferenceKey.id,exactIntervalRevision,capturedAt
      ]);
      const interval=intervalResult.rows[0];
      const outcomeResult=await client.query<OutcomeRow>(HISTORICAL_TRACE_SQL.outcomeAsOf,[
        input.subjectReferenceKey.id,input.executionIntervalReferenceKey.id,input.phaseScope,semanticRequestHash,capturedAt
      ]);
      const outcome=outcomeResult.rows[0];
      if (!interval) {
        await client.query("COMMIT");transactionOpen=false;
        return emptyHistoricalResult(input,effective,dataScopeKey,capturedAt,semanticRequestHash,"NO_DATA","TASK_INTERVAL_UNAVAILABLE");
      }

      const trajectory=await this.readTrajectory(client,input,effective,capturedAt,semanticRequestHash);
      if (!trajectory) {
        await client.query("COMMIT");transactionOpen=false;
        if (outcome) {
          const absent=outcomeStatus(outcome);
          return emptyHistoricalResult(input,effective,dataScopeKey,capturedAt,semanticRequestHash,absent.status,absent.reasonCode,interval);
        }

        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        transactionOpen=true;
        // The controlled enqueue is a separate, bounded transaction. Scope remains
        // the first statement and the frozen read snapshot is copied verbatim.
        await client.query(HISTORICAL_TRACE_SQL.setScope,[dataScopeKey]);
        await client.query("SELECT set_config('statement_timeout',$1::text,true)",[`${timeout}ms`]);
        await client.query("SELECT set_config('lock_timeout',$1::text,true)",[`${Math.min(timeout,this.lockTimeoutMs)}ms`]);
        await client.query(HISTORICAL_TRACE_SQL.enqueueProjection,[
          dataScopeKey,input.subjectReferenceKey.id,input.executionIntervalReferenceKey.id,
          exactIntervalRevision,input.phaseScope,semanticRequestHash,effective.manifestHash,
          capturedAt,JSON.stringify(input),JSON.stringify(effective)
        ]);
        await client.query("COMMIT");transactionOpen=false;
        return emptyHistoricalResult(
          input,effective,dataScopeKey,capturedAt,semanticRequestHash,
          "PARTIAL","PROJECTION_PENDING",interval
        );
      }
      verifyTrajectoryIdentity(trajectory,input,semanticRequestHash);

      const revisionId=String(trajectory.trajectory_revision_id);
      // A pg Client serializes one wire protocol stream. Keep these snapshot reads
      // explicitly ordered instead of relying on concurrent query queuing, which is
      // deprecated and can make transaction behavior driver-version dependent.
      const segmentsResult=await client.query<Record<string,unknown>>(HISTORICAL_TRACE_SQL.segments,[revisionId]);
      const gapsResult=await client.query<Record<string,unknown>>(HISTORICAL_TRACE_SQL.gaps,[revisionId]);
      const exclusionsResult=await client.query<Record<string,unknown>>(HISTORICAL_TRACE_SQL.exclusions,[revisionId]);
      const inputsResult=await client.query<ChildInputRow>(HISTORICAL_TRACE_SQL.inputs,[revisionId]);
      const childInputs=inputsResult.rows;
      verifyIntervalInput(childInputs,input,interval,trajectory);
      const trackletInputs=childInputs.filter((row)=>String(row.resource_kind)==="TRACKLET_VERSION");
      const finalizationInputs=childInputs.filter((row)=>String(row.input_kind)==="TRACKLET_FINALIZATION_REVISION"||String(row.resource_kind)==="TRACKLET_FINALIZATION");
      if (trackletInputs.length>this.maximumCandidates||trackletInputs.length>4_096) {
        throw new ProviderProtocolError("BUDGET_EXCEEDED","historical trajectory input tracklet budget exceeded");
      }
      const trackletIds=trackletInputs.map((row)=>String(row.resource_id));
      if (trackletIds.length>0&&finalizationInputs.length===0) {
        throw resourceMismatch("trajectory revision does not pin tracklet finalization revisions","tracklet-finalization-input-set");
      }
      const finalizationPins=finalizationInputs.map((row)=>({
        finalization_revision_id:String(row.resource_id),revision_no:positiveInteger(row.resource_version,"tracklet finalization version")
      }));
      const trackletRows=trackletIds.length===0?[]:(await client.query<TrackletRow>(
        HISTORICAL_TRACE_SQL.tracklets,[trackletIds,JSON.stringify(finalizationPins),capturedAt]
      )).rows;
      verifyTracklets(trackletInputs,finalizationInputs,trackletRows,input,String(trajectory.finalization_state));

      const sampleCount=nonNegativeInteger(trajectory.sample_count,"sample_count");
      const fixedRows=segmentsResult.rows.length+gapsResult.rows.length+exclusionsResult.rows.length+trackletRows.length;
      if (fixedRows>this.maximumRows) throw new ProviderProtocolError("BUDGET_EXCEEDED","historical trajectory row budget exceeded before preview materialization");
      const requestedInline=Math.min(input.maximumInlinePoints??this.maximumRows,this.maximumRows-fixedRows);
      const sampleIndexes=previewIndexes(sampleCount,requestedInline);
      const previewRows=sampleIndexes.length===0?[]:(await client.query<Record<string,unknown>>(
        HISTORICAL_TRACE_SQL.preview,[String(trajectory.reference_key),positiveInteger(trajectory.revision_no,"revision_no"),capturedAt,sampleIndexes]
      )).rows;
      await client.query("COMMIT");transactionOpen=false;

      const preview=previewRows.map(mapPreviewPoint);
      const gaps=gapsResult.rows.map(mapGap);
      const exclusions=exclusionsResult.rows.map(mapExclusion);
      const inputTrackletVersions=trackletRows.map(mapInputTracklet);
      const resultOutcome=trajectoryOutcome(trajectory,interval,gaps.length,outcome);
      const previewTruncated=sampleCount>preview.length;
      const warnings=[
        "history.readContract=gowm_history_v1",
        "history.asOf=effectiveSnapshot.capturedAt",
        "history.sourceSelection=projectionOwned",
        ...(previewTruncated?["history.previewTruncated=true","history.artifactDeferred=true"]:[]),
        ...(childInputs.length+2>256?["history.snapshotInputsAggregated=true"]:[])
      ];
      const output:GowmV071HistoricalTrajectoryResult={
        schemaVersion:"1.0",status:resultOutcome.status,reasonCode:resultOutcome.reasonCode,
        subjectReferenceKey:{...input.subjectReferenceKey},executionIntervalReferenceKey:{...input.executionIntervalReferenceKey},
        trajectoryReferenceKey:{namespace:"gowm",kind:"HISTORICAL_TRAJECTORY",id:String(trajectory.reference_key),version:String(trajectory.revision_no)},
        requestedPeriods:timeRanges(trajectory.requested_periods,"requested_periods"),
        definedPeriods:timeRanges(trajectory.defined_periods,"defined_periods"),excludedPeriods:exclusions,gaps,
        inputTrackletVersions,completeness:{
          temporalCoverageRatio:unitNumber(trajectory.temporal_coverage_ratio,"temporal_coverage_ratio"),
          sampleCount,sequenceCount:positiveInteger(trajectory.sequence_count,"sequence_count"),
          gapCount:nonNegativeInteger(trajectory.gap_count,"gap_count"),
          prefixComplete:booleanValue(trajectory.prefix_complete,"prefix_complete"),
          suffixComplete:booleanValue(trajectory.suffix_complete,"suffix_complete")
        },
        finalization:{
          state:enumValue(trajectory.finalization_state,["PROVISIONAL","SEALED","CONFLICTED"] as const,"finalization_state"),
          ...observedThrough(trackletRows)
        },preview,warnings
      };
      return {
        output,status:resultOutcome.status,
        dataSnapshot:trajectorySnapshot(dataScopeKey,capturedAt,effective,trajectory,childInputs),
        evidenceReferences:trajectoryEvidence(trajectory,interval,input,trackletInputs,trackletRows),
        rows:preview.length+gaps.length+exclusions.length+segmentsResult.rows.length+trackletRows.length,
        candidates:trackletRows.length,warnings
      };
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK").catch(()=>undefined);
      if (error instanceof ProviderProtocolError) throw error;
      throw new ProviderProtocolError("PROVIDER_NOT_READY","historical trajectory as-of read failed",{retryable:true,cause:error});
    } finally {
      client.release();
    }
  }

  async readiness():Promise<{ready:boolean;reasons:string[]}> {
    try {
      await this.pool.query("SELECT * FROM gowm_history_v1.historical_trajectory_effective LIMIT 0");
      await this.pool.query("SELECT * FROM gowm_history_v1.historical_trajectory_outcome LIMIT 0");
      return {ready:true,reasons:[]};
    } catch { return {ready:false,reasons:["gowm_history_v1 historical trace read contract is unavailable"]}; }
  }

  private async readTrajectory(
    client:pg.PoolClient,input:GowmV07HistoricalTrajectoryQuery,effective:GowmV07QuerySnapshotManifest,
    capturedAt:string,semanticRequestHash:`sha256:${string}`
  ):Promise<TrajectoryRow|undefined> {
    const pins=effective.resources.filter((resource)=>resource.resourceKind==="HISTORICAL_TRAJECTORY");
    if (pins.length>16) throw new ProviderProtocolError("BUDGET_EXCEEDED","too many historical trajectory pins were supplied");
    const matches:TrajectoryRow[]=[];
    for (const pin of pins) {
      const revision=positiveInteger(pin.version,"pinned historical trajectory version");
      const rows=await client.query<TrajectoryRow>(HISTORICAL_TRACE_SQL.trajectoryPinnedAsOf,[
        snapshotReferenceId(pin.resourceId,"gowm"),revision,capturedAt
      ]);
      const row=rows.rows[0];
      if (!row) {
        if (pins.length===1) throw resourceMismatch("pinned historical trajectory revision is unavailable",pin.resourceId);
        continue;
      }
      if (String(row.semantic_request_hash)!==semanticRequestHash||String(row.subject_reference_key)!==input.subjectReferenceKey.id||String(row.phase_scope)!==input.phaseScope) continue;
      if (pin.contentHash!==undefined&&pin.contentHash!==String(row.content_hash)) {
        throw resourceMismatch("pinned historical trajectory content hash does not match",pin.resourceId);
      }
      matches.push(row);
    }
    if (matches.length>1) throw new ProviderProtocolError("SCHEMA_MISMATCH","multiple pinned trajectory revisions match the semantic request");
    if (matches[0]) return matches[0];
    const result=await client.query<TrajectoryRow>(HISTORICAL_TRACE_SQL.trajectoryAsOf,[
      input.subjectReferenceKey.id,input.executionIntervalReferenceKey.id,input.phaseScope,semanticRequestHash,capturedAt
    ]);
    return result.rows[0];
  }
}

export { historicalSemanticRequestHash };

function emptyHistoricalResult(
  input:GowmV07HistoricalTrajectoryQuery,effective:GowmV07QuerySnapshotManifest,dataScopeKey:string,capturedAt:string,
  semanticRequestHash:`sha256:${string}`,status:HistoricalTraceRepositoryResult["status"],reasonCode:string,
  interval?:IntervalRow
):HistoricalTraceRepositoryResult {
  const warnings=["history.readContract=gowm_history_v1","history.asOf=effectiveSnapshot.capturedAt"];
  const output:GowmV071HistoricalTrajectoryResult={
    schemaVersion:"1.0",status,reasonCode,subjectReferenceKey:{...input.subjectReferenceKey},
    executionIntervalReferenceKey:{...input.executionIntervalReferenceKey},requestedPeriods:[],definedPeriods:[],
    excludedPeriods:[],gaps:[],inputTrackletVersions:[],
    completeness:{temporalCoverageRatio:0,sampleCount:0,sequenceCount:0,gapCount:0,prefixComplete:false,suffixComplete:false},
    finalization:{state:"PROVISIONAL"},preview:[],warnings
  };
  const resources:DataSnapshotContext["resources"]=[{
    referenceKey:{namespace:"gowm",kind:"QUERY_RESULT",id:`history-search-${semanticRequestHash.slice(7)}`,version:capturedAt},
    authority:"gowm_history_v1",pinning:"PINNED",digest:sha256({dataScopeKey,semanticRequestHash,effectiveManifestHash:effective.manifestHash})
  }];
  if (interval) resources.push({
    referenceKey:{...input.executionIntervalReferenceKey},authority:"gowm_history_v1",pinning:"PINNED",
    digest:digest(interval.content_hash,{intervalRevisionId:interval.interval_revision_id}),
    worldVersion:nonNegativeInteger(interval.world_version,"world_version")
  });
  return {output,status,dataSnapshot:{
    consistency:effective.consistency,capturedAt,scopeDigest:sha256({dataScopeKey}),resources
  },evidenceReferences:[],rows:0,candidates:0,warnings};
}

function outcomeStatus(row:OutcomeRow|undefined):{status:HistoricalTraceRepositoryResult["status"];reasonCode:string} {
  if (!row) return {status:"PARTIAL",reasonCode:"PROJECTION_PENDING"};
  if (booleanValue(row.projection_pending,"projection_pending")) return {status:"PARTIAL",reasonCode:"PROJECTION_PENDING"};
  const persisted=enumValue(row.outcome_status,["AVAILABLE","NO_DATA","PARTIAL","INDETERMINATE","PENDING","FAILED"] as const,"outcome_status");
  const status:HistoricalTraceRepositoryResult["status"]=persisted==="AVAILABLE"?"COMPLETED"
    :persisted==="PENDING"?"PARTIAL":persisted==="FAILED"?"INDETERMINATE":persisted;
  return {
    status,
    reasonCode:reasonCode(row.reason_code,"reason_code")
  };
}

function trajectoryOutcome(
  trajectory:TrajectoryRow,interval:IntervalRow,gapCount:number,outcome:OutcomeRow|undefined
):{status:HistoricalTraceRepositoryResult["status"];reasonCode:string} {
  if (outcome) {
    const persisted=outcomeStatus(outcome);
    if (persisted.status==="NO_DATA") throw new ProviderProtocolError("SCHEMA_MISMATCH","persisted NO_DATA outcome conflicts with an available trajectory revision");
    if (persisted.status==="INDETERMINATE"||persisted.status==="PARTIAL") return persisted;
  }
  if (String(interval.lifecycle_state)==="OPEN") return {status:"PARTIAL",reasonCode:"OPEN_EXECUTION"};
  if (String(trajectory.finalization_state)==="CONFLICTED"||String(interval.stability_state)==="CONFLICTED") {
    return {status:"INDETERMINATE",reasonCode:"ENTITY_BINDING_AMBIGUOUS"};
  }
  if (gapCount>0||nonNegativeInteger(trajectory.gap_count,"gap_count")>0) return {status:"PARTIAL",reasonCode:"TRAJECTORY_GAP"};
  if (unitNumber(trajectory.temporal_coverage_ratio,"temporal_coverage_ratio")<1) return {status:"PARTIAL",reasonCode:"PARTIAL_TIME_COVERAGE"};
  return {status:"COMPLETED",reasonCode:"TRAJECTORY_AVAILABLE"};
}

function verifyTrajectoryIdentity(
  row:TrajectoryRow,input:GowmV07HistoricalTrajectoryQuery,semanticRequestHash:`sha256:${string}`
):void {
  if (String(row.subject_reference_key)!==input.subjectReferenceKey.id||String(row.phase_scope)!==input.phaseScope||String(row.semantic_request_hash)!==semanticRequestHash) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH","historical trajectory semantic identity does not match the request");
  }
}

function verifyIntervalInput(
  inputs:ChildInputRow[],input:GowmV07HistoricalTrajectoryQuery,interval:IntervalRow,trajectory:TrajectoryRow
):void {
  if (String(interval.reference_key)!==input.executionIntervalReferenceKey.id
      || String(interval.revision_no)!==input.executionIntervalReferenceKey.version) {
    throw resourceMismatch("resolved interval does not match the requested reference revision",input.executionIntervalReferenceKey.id);
  }
  const pinned=inputs.find((row)=>String(row.input_kind)==="TASK_INTERVAL_REVISION"||String(row.resource_kind)==="TASK_EXECUTION_INTERVAL");
  if (!pinned||String(pinned.resource_namespace)!=="gowm"
      ||String(pinned.resource_kind)!=="TASK_EXECUTION_INTERVAL"
      ||String(pinned.resource_id)!==String(interval.reference_key)
      ||String(pinned.resource_version)!==String(interval.revision_no)) {
    throw resourceMismatch("trajectory revision does not consume the requested interval revision",input.executionIntervalReferenceKey.id);
  }
  const expectedHash=String(pinned.resource_content_hash??"");
  if (expectedHash&&expectedHash!==String(interval.content_hash)) {
    throw resourceMismatch("trajectory interval input hash does not match the exact interval revision",input.executionIntervalReferenceKey.id);
  }
  if (String(trajectory.interval_revision_id)!==String(interval.interval_revision_id)) {
    throw resourceMismatch("trajectory revision points to a different interval revision",input.executionIntervalReferenceKey.id);
  }
  const profile=inputs.find((row)=>String(row.input_kind)==="METHOD_PROFILE"&&String(row.resource_kind)==="HISTORY_METHOD_PROFILE"
    &&String(row.resource_id)===input.sourceSelectionProfileReferenceKey.id
    &&String(row.resource_version)===input.sourceSelectionProfileReferenceKey.version);
  if (!profile) throw resourceMismatch("trajectory revision does not consume the requested source-selection profile",input.sourceSelectionProfileReferenceKey.id);
  if (input.analysisSpaceReferenceKey!==undefined) {
    const space=inputs.find((row)=>String(row.input_kind)==="ANALYSIS_SPACE"&&String(row.resource_id)===input.analysisSpaceReferenceKey?.id
      &&String(row.resource_version)===input.analysisSpaceReferenceKey?.version);
    if (!space) throw resourceMismatch("trajectory revision does not consume the requested analysis space",input.analysisSpaceReferenceKey.id);
  }
}

function verifyTracklets(
  inputs:ChildInputRow[],finalizations:ChildInputRow[],rows:TrackletRow[],query:GowmV07HistoricalTrajectoryQuery,
  trajectoryFinalizationState:string
):void {
  if (rows.length!==inputs.length) throw resourceMismatch("one or more pinned tracklet versions are unavailable","tracklet-input-set");
  const sources=new Set<string>();const sessions=new Set<string>();const spaces=new Set<string>();
  rows.forEach((row,index)=>{
    const input=inputs[index];
    if (!input||String(row.tracklet_version_id)!==String(input.resource_id)||String(row.version_no)!==String(input.resource_version)||String(row.content_hash)!==String(input.resource_content_hash)) {
      throw resourceMismatch("tracklet version pin does not match the stored trajectory input",String(input?.resource_id??"unknown"));
    }
    const finalization=finalizations.find((candidate)=>String(candidate.resource_id)===String(row.finalization_revision_id)
      &&String(candidate.resource_version)===String(row.finalization_revision_no));
    if (!finalization) throw resourceMismatch("tracklet finalization pin does not match the stored trajectory input",String(row.tracklet_version_id));
    sources.add(String(row.source_key));sessions.add(String(row.tracker_session_key));spaces.add(String(row.analysis_space_key));
  });
  if (trajectoryFinalizationState==="SEALED"&&rows.some((row)=>String(row.finalization_state)!=="SEALED")) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH","sealed trajectory revision has a non-sealed tracklet input");
  }
  if (sources.size>1||sessions.size>1) throw new ProviderProtocolError("SCHEMA_MISMATCH","stored historical trajectory contains hidden multi-source fusion");
  if (query.sourceSelection.mode==="EXPLICIT_SOURCE") {
    if (sources.size&&![...sources].includes(query.sourceSelection.sourceKey)) throw new ProviderProtocolError("SCHEMA_MISMATCH","stored trajectory source does not match explicit selection");
    if (query.sourceSelection.trackerSessionKey!==undefined&&sessions.size&&![...sessions].includes(query.sourceSelection.trackerSessionKey)) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH","stored trajectory session does not match explicit selection");
    }
  }
  if (query.analysisSpaceReferenceKey!==undefined&&spaces.size&&![...spaces].includes(query.analysisSpaceReferenceKey.id)) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH","stored trajectory analysis space does not match the request");
  }
}

function observedThrough(rows:TrackletRow[]):{observedThrough?:string} {
  if (rows.length===0||rows.some((row)=>row.observed_through===null||row.observed_through===undefined)) return {};
  const values=rows.map((row)=>validTimestamp(row.observed_through,"tracklet observed_through")).sort();
  return values[0]?{observedThrough:values[0]}:{};
}

function mapInputTracklet(row:TrackletRow):GowmV071HistoricalTrajectoryResultInputTrackletVersion {
  return {
    trackletId:String(row.tracklet_id),trackletVersionId:String(row.tracklet_version_id),
    versionNo:positiveInteger(row.version_no,"tracklet version_no"),sourceKey:String(row.source_key),
    trackerSessionKey:String(row.tracker_session_key),contentHash:digest(row.content_hash,{trackletVersionId:row.tracklet_version_id})
  };
}

function mapPreviewPoint(row:Record<string,unknown>):GowmV071HistoricalTrajectoryResultPreviewPoint {
  const position=jsonRecord(row.position,"preview position");
  if (position.type!=="Point"||!Array.isArray(position.coordinates)) throw new ProviderProtocolError("SCHEMA_MISMATCH","preview position is not a GeoJSON Point");
  return {observedAt:validTimestamp(row.observed_at,"preview observed_at"),position:position as GowmV071HistoricalTrajectoryResultPreviewPoint["position"]};
}

function mapGap(row:Record<string,unknown>):GowmV07HistoricalGap {
  const reasons=stringArray(row.reason_codes);
  return {
    range:range(row.gap_time,"gap_time"),
    reason:enumValue(row.gap_kind,["UNKNOWN_INPUT_GAP","SOURCE_COVERAGE_GAP","TRACKLET_BOUNDARY_GAP"] as const,"gap_kind"),
    ...(reasons.length?{details:reasons.join(", ").slice(0,1_024)}:{})
  };
}

function mapExclusion(row:Record<string,unknown>):{range:GowmV071HistoricalTrajectoryResultTimeRange;reason:"EXCLUDED_PAUSED_PHASE"} {
  return {range:range(row.excluded_time,"excluded_time"),reason:enumValue(row.exclusion_kind,["EXCLUDED_PAUSED_PHASE"] as const,"exclusion_kind")};
}

function trajectorySnapshot(
  dataScopeKey:string,capturedAt:string,effective:GowmV07QuerySnapshotManifest,trajectory:TrajectoryRow,inputs:ChildInputRow[]
):DataSnapshotContext {
  const root:DataSnapshotContext["resources"]=[{
    referenceKey:{namespace:"gowm",kind:"HISTORICAL_TRAJECTORY",id:String(trajectory.reference_key),version:String(trajectory.revision_no)},
    authority:"gowm_history_v1",pinning:"PINNED",digest:digest(trajectory.content_hash,{trajectoryRevisionId:trajectory.trajectory_revision_id}),
    worldVersion:nonNegativeInteger(trajectory.world_version,"world_version")
  },{
    referenceKey:{namespace:"gowm",kind:"HISTORY_INPUT_SET",id:`input-set-${digest(trajectory.input_set_hash,{trajectoryRevisionId:trajectory.trajectory_revision_id}).slice(7)}`,version:String(trajectory.revision_no)},
    authority:"gowm_history_v1",pinning:"PINNED",digest:digest(trajectory.input_set_hash,{trajectoryRevisionId:trajectory.trajectory_revision_id,inputs})
  }];
  const detailed=inputs.map((input)=>({
    referenceKey:{namespace:String(input.resource_namespace),kind:String(input.resource_kind),id:String(input.resource_id),version:String(input.resource_version)},
    authority:String(input.authority),pinning:"PINNED" as const,
    ...(input.resource_content_hash===null||input.resource_content_hash===undefined?{}:{digest:digest(input.resource_content_hash,{inputNo:input.input_no,resourceId:input.resource_id})})
  }));
  const resources=root.length+detailed.length<=256?[...root,...detailed]:root;
  return {consistency:effective.consistency,capturedAt,scopeDigest:sha256({dataScopeKey}),resources};
}

function trajectoryEvidence(
  trajectory:TrajectoryRow,interval:IntervalRow,input:GowmV07HistoricalTrajectoryQuery,
  trackletInputs:ChildInputRow[],tracklets:TrackletRow[]
):EvidenceReference[] {
  const worldVersion=nonNegativeInteger(trajectory.world_version,"world_version");
  const evidence:EvidenceReference[]=[{
    evidenceId:`analysis:${String(trajectory.analysis_id)}`,authority:"gowm_history_v1",evidenceType:"ANALYSIS_RECORD",
    referenceKey:{namespace:"gowm",kind:"DERIVED_REFERENCE",id:String(trajectory.analysis_id),version:String(trajectory.revision_no)},
    schemaUri:HISTORICAL_TRACE_SCHEMAS.outputSchemaUri,schemaHash:HISTORICAL_TRACE_SCHEMAS.outputSchemaHash,
    observedAt:validTimestamp(trajectory.created_at,"trajectory created_at"),worldVersion
  },{
    evidenceId:`interval:${String(interval.interval_revision_id)}`,authority:"gowm_history_v1",evidenceType:"CURRENT_PROJECTION_SOURCE",
    referenceKey:{...input.executionIntervalReferenceKey},schemaUri:"urn:gowm:sql:gowm_history_v1:task-execution-interval-revision:1.0",
    schemaHash:sha256(["interval_revision_id","revision_no","execution_range","lifecycle_state","stability_state","content_hash"]),
    observedAt:validTimestamp(interval.created_at,"interval created_at"),worldVersion:nonNegativeInteger(interval.world_version,"world_version")
  }];
  tracklets.forEach((tracklet,index)=>{
    const pin=trackletInputs[index];
    if (!pin) return;
    evidence.push({
      evidenceId:`tracklet:${String(tracklet.tracklet_version_id)}`,authority:String(pin.authority),evidenceType:"TRACKLET_VERSION",
      referenceKey:{namespace:String(pin.resource_namespace),kind:"TRACKLET_VERSION",id:String(pin.resource_id),version:String(pin.resource_version)},
      schemaUri:"urn:gowm:sql:gowm_history_v1:tracklet-version-effective:1.0",
      schemaHash:sha256(["tracklet_version_id","version_no","source_key","tracker_session_key","analysis_space_key","content_hash"]),
      observedAt:validTimestamp(tracklet.created_at,"tracklet created_at"),worldVersion
    });
  });
  return evidence;
}

function previewIndexes(sampleCount:number,limit:number):number[] {
  if (sampleCount===0||limit===0) return [];
  const count=Math.min(sampleCount,limit);
  if (count===1) return [1];
  const indexes=new Set<number>();
  for (let index=0;index<count;index+=1) indexes.add(1+Math.floor(index*(sampleCount-1)/(count-1)));
  return [...indexes];
}

function timeRanges(value:unknown,name:string):GowmV071HistoricalTrajectoryResultTimeRange[] {
  const parsed=typeof value==="string"?JSON.parse(value) as unknown:value;
  if (!Array.isArray(parsed)) throw new ProviderProtocolError("SCHEMA_MISMATCH",`${name} is not an array`);
  return parsed.map((item)=>{
    const record=jsonRecord(item,name);
    return {start:validTimestamp(record.start,`${name}.start`),end:validTimestamp(record.end,`${name}.end`),bounds:"[)"};
  });
}

function range(value:unknown,name:string):GowmV071HistoricalTrajectoryResultTimeRange {
  if (typeof value==="object"&&value!==null&&!Array.isArray(value)) {
    const record=value as Record<string,unknown>;
    return {start:validTimestamp(record.lower??record.start,`${name}.start`),end:validTimestamp(record.upper??record.end,`${name}.end`),bounds:"[)"};
  }
  const match=/^[[(]\s*"?([^,\"]+)"?\s*,\s*"?([^\]")]+)"?\s*[\])]$/.exec(String(value));
  if (!match?.[1]||!match[2]) throw new ProviderProtocolError("SCHEMA_MISMATCH",`${name} is not a finite tstzrange`);
  return {start:validTimestamp(match[1],`${name}.start`),end:validTimestamp(match[2],`${name}.end`),bounds:"[)"};
}

function jsonRecord(value:unknown,name:string):Record<string,unknown> {
  let parsed=value;
  for (let depth=0;depth<2&&typeof parsed==="string";depth+=1) {
    try { parsed=JSON.parse(parsed) as unknown; }
    catch { throw new ProviderProtocolError("SCHEMA_MISMATCH",`${name} is not valid JSON`); }
  }
  if (typeof parsed!=="object"||parsed===null||Array.isArray(parsed)) {
    const shape=parsed===null?"null":Array.isArray(parsed)?"array":typeof parsed;
    throw new ProviderProtocolError("SCHEMA_MISMATCH",`${name} is not an object (${shape})`);
  }
  return parsed as Record<string,unknown>;
}

function stringArray(value:unknown):string[] {
  const parsed=typeof value==="string"&&value.trim().startsWith("[")?JSON.parse(value) as unknown:value;
  return Array.isArray(parsed)?parsed.map((item)=>String(item)):[];
}

function resourceMismatch(message:string,resourceId:string):ProviderProtocolError {
  return new ProviderProtocolError("SCHEMA_MISMATCH",message,{details:{reason:"RESOURCE_MISSING",resourceId}});
}

function snapshotReferenceId(resourceId:string,expectedNamespace:string):string {
  const prefix=`${expectedNamespace}:`;
  if (!resourceId.startsWith(prefix)||resourceId.length===prefix.length) {
    throw resourceMismatch("pinned historical trajectory resource id is not canonical",resourceId);
  }
  return resourceId.slice(prefix.length);
}

function reasonCode(value:unknown,name:string):string {
  const candidate=String(value);
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(candidate)) throw new ProviderProtocolError("SCHEMA_MISMATCH",`${name} is invalid`);
  return candidate;
}

function digest(value:unknown,fallback:unknown):`sha256:${string}` {
  const candidate=String(value??"");
  return /^sha256:[0-9a-f]{64}$/.test(candidate)?candidate as `sha256:${string}`:sha256(fallback);
}

function validTimestamp(value:unknown,name:string):string {
  const parsed=value instanceof Date?value:new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new ProviderProtocolError("SCHEMA_MISMATCH",`${name} is invalid`);
  return parsed.toISOString();
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

function boundedInteger(value:number,minimum:number,maximum:number,name:string):number {
  if (!Number.isSafeInteger(value)||value<minimum||value>maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}

function unitNumber(value:unknown,name:string):number {
  const number=Number(value);
  if (!Number.isFinite(number)||number<0||number>1) throw new ProviderProtocolError("SCHEMA_MISMATCH",`${name} must be between zero and one`);
  return number;
}

function booleanValue(value:unknown,name:string):boolean {
  if (value===true||value==="true"||value===1) return true;
  if (value===false||value==="false"||value===0) return false;
  throw new ProviderProtocolError("SCHEMA_MISMATCH",`${name} must be boolean`);
}

function enumValue<const T extends readonly string[]>(value:unknown,allowed:T,name:string):T[number] {
  const candidate=String(value);
  if (!(allowed as readonly string[]).includes(candidate)) throw new ProviderProtocolError("SCHEMA_MISMATCH",`${name} is outside the frozen contract`);
  return candidate as T[number];
}
