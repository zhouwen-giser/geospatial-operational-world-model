import {
  buildGapPreservingSlicePlan,
  calculateHistoricalCompleteness,
  canonicalSha256,
  deriveHistoricalRequestDomain
} from "../../historical-trace-core/src/index.js";
import type {
  HistoricalCompletenessResult,
  HistoricalGap,
  HistoricalPhaseScope,
  HistoricalSourceSegment,
  ReconstructedTaskExecutionInterval,
  Sha256Digest,
  TimePeriod
} from "../../historical-trace-model/src/index.js";
import {
  configureLocalExecutionBounds,
  HistoricalProjectionInputError,
  isoTimestamp,
  optionalString,
  requiredInteger,
  requiredString,
  type SqlExecutionBounds,
  type SqlExecutor,
  type SqlPool,
  withProjectionTransaction
} from "./database.js";

export interface RuntimeSourceGap extends HistoricalGap {
  sourceTrackletVersionId?: string;
  sourceTrackletGapNo?: number;
  /** Exact immutable source reason codes retained alongside the normalized gap kind. */
  reasonCodes?: string[];
}

export interface TemporalSliceRequest {
  dataScopeKey: string;
  sourceTrackletVersionId: string;
  sourceSegmentNo: number;
  period: TimePeriod;
  sequenceNo: number;
  requestedPeriodNo: number;
}

export interface MaterializedTemporalSlice {
  trajectory: string;
  sampleCount: number;
  startTime: string;
  endTime: string;
}

export interface TemporalTrajectorySlicer {
  slice(request: TemporalSliceRequest): Promise<MaterializedTemporalSlice | undefined>;
}

export interface HistoricalTrajectoryBuildInput {
  dataScopeKey: string;
  interval: ReconstructedTaskExecutionInterval;
  intervalRevisionId: string;
  phaseScope: HistoricalPhaseScope;
  capturedAt: string;
  sourceSegments: HistoricalSourceSegment[];
  sourceGaps: RuntimeSourceGap[];
  trackletFinalizationStates: Array<"PROVISIONAL" | "SEALED" | "REOPENED" | "CONFLICTED">;
}

export interface PreparedHistoricalTrajectorySegment {
  segmentNo: number;
  sourceTrackletVersionId: string;
  sourceSegmentNo: number;
  phaseNo?: number;
  trajectory: string;
  sampleCount: number;
  startTime: string;
  endTime: string;
}

export interface PreparedHistoricalTrajectoryGap {
  gapNo: number;
  gapKind: HistoricalGap["reason"];
  gapTime: TimePeriod;
  leftMeasurementId?: string;
  rightMeasurementId?: string;
  sourceTrackletVersionId?: string;
  sourceTrackletGapNo?: number;
  reasonCodes: string[];
}

export interface PreparedHistoricalExcludedPeriod {
  excludedNo: number;
  exclusionKind: "EXCLUDED_PAUSED_PHASE";
  excludedTime: TimePeriod;
  phaseNo: number;
}

export interface PreparedHistoricalTrajectoryRevision {
  outcome: HistoricalCompletenessResult;
  finalizationState: "PROVISIONAL" | "SEALED" | "CONFLICTED";
  requestedPeriods: TimePeriod[];
  definedPeriods: TimePeriod[];
  segments: PreparedHistoricalTrajectorySegment[];
  gaps: PreparedHistoricalTrajectoryGap[];
  excludedPeriods: PreparedHistoricalExcludedPeriod[];
  sampleCount: number;
  sequenceCount: number;
  startEventTime: string;
  endEventTime: string;
}

export type HistoricalTrajectoryPreparation =
  | { kind: "REVISION"; revision: PreparedHistoricalTrajectoryRevision }
  | { kind: "OUTCOME"; outcome: HistoricalCompletenessResult };

function millis(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new HistoricalProjectionInputError(`Invalid timestamp: ${value}`);
  return parsed;
}

function containsPeriod(containerStart: string | undefined, containerEnd: string | undefined, period: TimePeriod): boolean {
  if (containerStart === undefined) return false;
  const end = containerEnd === undefined ? Number.POSITIVE_INFINITY : millis(containerEnd);
  return millis(containerStart) <= millis(period.start) && end >= millis(period.end);
}

function phaseForSlice(interval: ReconstructedTaskExecutionInterval, period: TimePeriod): number | undefined {
  return interval.phases.find((phase) =>
    phase.phaseKind === "RUNNING" && containsPeriod(phase.start, phase.end, period)
  )?.phaseNo;
}

/**
 * Builds every requested period/tracklet segment as an independent MobilityDB
 * slice. No code path joins adjacent sequences or fills paused/unknown time.
 */
export async function prepareHistoricalTrajectory(
  input: HistoricalTrajectoryBuildInput,
  slicer: TemporalTrajectorySlicer
): Promise<HistoricalTrajectoryPreparation> {
  const domain = deriveHistoricalRequestDomain(input.interval, input.phaseScope, input.capturedAt);
  const plan = buildGapPreservingSlicePlan(input.sourceSegments, input.sourceGaps, domain.requestedPeriods);
  const materialized: PreparedHistoricalTrajectorySegment[] = [];
  const unavailableSlices: RuntimeSourceGap[] = [];
  for (const slice of plan.segments) {
    const value = await slicer.slice({
      dataScopeKey: input.dataScopeKey,
      sourceTrackletVersionId: slice.sourceTrackletVersionId,
      sourceSegmentNo: slice.sourceSegmentNo,
      period: slice.period,
      sequenceNo: slice.sequenceNo,
      requestedPeriodNo: slice.requestedPeriodNo
    });
    if (value === undefined) {
      unavailableSlices.push({
        reason: "UNKNOWN_INPUT_GAP",
        range: slice.period,
        sourceTrackletVersionId: slice.sourceTrackletVersionId,
        reasonCodes: ["UNKNOWN_INPUT_GAP", "SOURCE_SLICE_UNAVAILABLE"]
      });
      continue;
    }
    if (!Number.isSafeInteger(value.sampleCount) || value.sampleCount < 1) {
      throw new HistoricalProjectionInputError("Materialized slice sampleCount must be a positive integer");
    }
    const materializedPeriod: TimePeriod = {
      start: isoTimestamp(value.startTime, "slice startTime"),
      end: isoTimestamp(value.endTime, "slice endTime"),
      bounds: "[)"
    };
    if (!containsPeriod(slice.period.start,slice.period.end,materializedPeriod)) {
      throw new HistoricalProjectionInputError("Materialized slice escaped its fixed source/request intersection");
    }
    const phaseNo = input.phaseScope === "ACTIVE_PHASES_ONLY" ? phaseForSlice(input.interval, slice.period) : undefined;
    if (input.phaseScope === "ACTIVE_PHASES_ONLY" && phaseNo === undefined) {
      throw new HistoricalProjectionInputError("ACTIVE slice is not contained by one RUNNING phase");
    }
    materialized.push({
      segmentNo: materialized.length + 1,
      sourceTrackletVersionId: slice.sourceTrackletVersionId,
      sourceSegmentNo: slice.sourceSegmentNo,
      ...(phaseNo === undefined ? {} : { phaseNo }),
      trajectory: value.trajectory,
      sampleCount: value.sampleCount,
      startTime: materializedPeriod.start,
      endTime: materializedPeriod.end
    });
  }

  const plannedGaps = [...plan.gaps, ...unavailableSlices];
  const runtimeGaps = plannedGaps.map((gap, index): PreparedHistoricalTrajectoryGap => {
    const source = [...input.sourceGaps, ...unavailableSlices].find((candidate) =>
      candidate.reason === gap.reason
      && candidate.range.start === gap.range.start
      && candidate.range.end === gap.range.end
    );
    return {
      gapNo: index + 1,
      gapKind: gap.reason,
      gapTime: gap.range,
      ...(gap.leftMeasurementId === undefined ? {} : { leftMeasurementId: gap.leftMeasurementId }),
      ...(gap.rightMeasurementId === undefined ? {} : { rightMeasurementId: gap.rightMeasurementId }),
      ...(source?.sourceTrackletVersionId === undefined ? {} : { sourceTrackletVersionId: source.sourceTrackletVersionId }),
      ...(source?.sourceTrackletGapNo === undefined ? {} : { sourceTrackletGapNo: source.sourceTrackletGapNo }),
      reasonCodes: [...new Set([gap.reason, ...(source?.reasonCodes ?? [])])]
    };
  });
  const sampleCount = materialized.reduce((total, segment) => total + segment.sampleCount, 0);
  const definedPeriods = materialized.map((segment): TimePeriod => ({
    start: segment.startTime,
    end: segment.endTime,
    bounds: "[)"
  }));
  const conflictedFinalization = input.trackletFinalizationStates.some((state) => state === "CONFLICTED");
  const outcome = calculateHistoricalCompleteness({
    requestedPeriods: domain.requestedPeriods,
    definedPeriods,
    gaps: plannedGaps,
    sampleCount,
    sequenceCount: materialized.length,
    openExecution: domain.openExecution,
    sourceConflict: conflictedFinalization,
    intervalConflict: domain.conflicted
  });
  if (materialized.length === 0 || outcome.status === "INDETERMINATE") return { kind: "OUTCOME", outcome };

  const excludedPeriods: PreparedHistoricalExcludedPeriod[] = domain.excludedPeriods.map((excluded, index) => {
    const phase = input.interval.phases.find((candidate) =>
      candidate.phaseKind === "PAUSED" && containsPeriod(candidate.start, candidate.end, excluded.range)
    );
    if (phase === undefined) throw new HistoricalProjectionInputError("paused exclusion has no interval phase");
    return {
      excludedNo: index + 1,
      exclusionKind: "EXCLUDED_PAUSED_PHASE",
      excludedTime: excluded.range,
      phaseNo: phase.phaseNo
    };
  });
  const allSealed = input.interval.lifecycleState === "CLOSED"
    && input.interval.stabilityState === "SEALED"
    && input.trackletFinalizationStates.length > 0
    && input.trackletFinalizationStates.every((state) => state === "SEALED");
  const finalizationState = domain.conflicted || conflictedFinalization
    ? "CONFLICTED"
    : allSealed ? "SEALED" : "PROVISIONAL";
  const startEventTime = materialized.reduce((left, segment) =>
    millis(segment.startTime) < millis(left) ? segment.startTime : left,
  materialized[0]!.startTime);
  const endEventTime = materialized.reduce((left, segment) =>
    millis(segment.endTime) > millis(left) ? segment.endTime : left,
  materialized[0]!.endTime);
  return {
    kind: "REVISION",
    revision: {
      outcome,
      finalizationState,
      requestedPeriods: outcome.requestedPeriods,
      definedPeriods: outcome.definedPeriods,
      segments: materialized,
      gaps: runtimeGaps,
      excludedPeriods,
      sampleCount,
      sequenceCount: materialized.length,
      startEventTime,
      endEventTime
    }
  };
}

export interface HistoricalResourceInput {
  analysisInputNo: number;
  inputRole: string;
  inputKind: string;
  resourceNamespace: string;
  resourceKind: string;
  resourceId: string;
  resourceVersion: string;
  resourceContentHash?: Sha256Digest;
  resourceWorldVersion?: number;
  authority: string;
  worldReferenceKey?: string;
  sourceAnalysisId?: string;
  createdAt: string;
}

export interface HistoricalInputSet {
  inputSetKind: string;
  itemCount: number;
  itemSetDigest: Sha256Digest;
  manifestArtifactRef?: string;
  authority: string;
  createdAt: string;
}

export interface HistoricalTrajectoryRegistration {
  dataScopeKey: string;
  subjectReferenceKey: string;
  intervalId: string;
  intervalReferenceKey: string;
  intervalRevisionId: string;
  phaseScope: HistoricalPhaseScope;
  sourceSelectionKind: "EXPLICIT_SOURCE" | "ONLY_CANDIDATE";
  selectedSourceKey?: string;
  selectedTrackerSessionKey?: string;
  analysisSpaceKey: string;
  semanticRequestHash: Sha256Digest;
  capturedAt: string;
  profileKey: string;
  profileVersion: string;
  profileHash: Sha256Digest;
  revision: PreparedHistoricalTrajectoryRevision;
  resourceInputs: HistoricalResourceInput[];
  inputSets: HistoricalInputSet[];
  queryPayload: Record<string, unknown>;
  methodSnapshot: Record<string, unknown>;
}

export interface HistoricalTrajectoryCommitResult {
  trajectoryRevisionId: string;
  analysisId: string;
  contentHash: Sha256Digest;
  reused: boolean;
}

const REQUIRED_RESOURCES = [
  "TASK_INTERVAL_REVISION", "TRACKLET_VERSION", "TRACKLET_FINALIZATION_REVISION",
  "METHOD_PROFILE", "ANALYSIS_SPACE"
] as const;
const REQUIRED_INPUT_SETS = ["TASK_EVENT_SET", "TRACKLET_INPUT_SET", "TIME_SOLUTION_SET", "WATERMARK_SET"] as const;

function validateLineage(registration: HistoricalTrajectoryRegistration): void {
  const cutoff = millis(registration.capturedAt);
  const inputNumbers = new Set<number>();
  for (const input of registration.resourceInputs) {
    if (millis(input.createdAt) > cutoff) throw new HistoricalProjectionInputError(`${input.inputKind} was created after capturedAt`);
    if (input.resourceContentHash === undefined
        || !/^sha256:[0-9a-f]{64}$/u.test(input.resourceContentHash)) {
      throw new HistoricalProjectionInputError(`${input.inputKind} requires an exact SHA-256 content pin`);
    }
    if (!Number.isSafeInteger(input.analysisInputNo) || input.analysisInputNo < 1 || inputNumbers.has(input.analysisInputNo)) {
      throw new HistoricalProjectionInputError("Historical resource input numbers must be unique positive integers");
    }
    inputNumbers.add(input.analysisInputNo);
  }
  const inputSetKinds = new Set<string>();
  for (const set of registration.inputSets) {
    if (millis(set.createdAt) > cutoff) throw new HistoricalProjectionInputError(`${set.inputSetKind} was created after capturedAt`);
    if (!Number.isSafeInteger(set.itemCount) || set.itemCount < 1) {
      throw new HistoricalProjectionInputError(`${set.inputSetKind} must contain at least one pinned member`);
    }
    if (inputSetKinds.has(set.inputSetKind)) {
      throw new HistoricalProjectionInputError(`Duplicate historical input set: ${set.inputSetKind}`);
    }
    inputSetKinds.add(set.inputSetKind);
    if (!/^sha256:[0-9a-f]{64}$/u.test(set.itemSetDigest)) {
      throw new HistoricalProjectionInputError(`${set.inputSetKind} digest is not SHA-256`);
    }
  }
  for (const kind of REQUIRED_RESOURCES) {
    if (!registration.resourceInputs.some((input) => input.inputKind === kind)) {
      throw new HistoricalProjectionInputError(`Missing historical resource input: ${kind}`);
    }
  }
  for (const kind of REQUIRED_INPUT_SETS) {
    if (!registration.inputSets.some((set) => set.inputSetKind === kind)) {
      throw new HistoricalProjectionInputError(`Missing historical input set: ${kind}`);
    }
  }
  const trackletCount = registration.resourceInputs.filter((input) => input.inputKind === "TRACKLET_VERSION").length;
  const finalizationCount = registration.resourceInputs.filter(
    (input) => input.inputKind === "TRACKLET_FINALIZATION_REVISION"
  ).length;
  if (trackletCount < 1 || trackletCount !== finalizationCount) {
    throw new HistoricalProjectionInputError(
      "Historical lineage requires one finalization revision for every tracklet version"
    );
  }
  if (registration.selectedSourceKey === undefined || registration.selectedTrackerSessionKey === undefined) {
    throw new HistoricalProjectionInputError("Historical trajectory registration requires an exact selected source and session");
  }
  for (const singleton of ["TASK_INTERVAL_REVISION", "METHOD_PROFILE", "ANALYSIS_SPACE"] as const) {
    if (registration.resourceInputs.filter((input) => input.inputKind === singleton).length !== 1) {
      throw new HistoricalProjectionInputError(`Historical lineage requires exactly one ${singleton}`);
    }
  }
  if (registration.revision.requestedPeriods.length < 1
      || registration.revision.definedPeriods.length < 1
      || registration.revision.segments.length < 1) {
    throw new HistoricalProjectionInputError("Historical trajectory revision must contain requested, defined, and segment members");
  }
  if (registration.revision.sequenceCount !== registration.revision.segments.length
      || registration.revision.sampleCount !== registration.revision.segments.reduce(
        (total, segment) => total + segment.sampleCount,
        0
      )) {
    throw new HistoricalProjectionInputError("Historical trajectory segment counts do not match the revision summary");
  }
  if (new Set(registration.revision.segments.map((segment) => segment.segmentNo)).size
      !== registration.revision.segments.length) {
    throw new HistoricalProjectionInputError("Historical trajectory segment numbers must be unique");
  }
}

function analysisStatus(status: HistoricalCompletenessResult["status"]): string {
  return status === "COMPLETED" ? "COMPLETE" : status;
}

export interface HistoricalTrajectoryRepository {
  registerAtomically(registration: HistoricalTrajectoryRegistration): Promise<HistoricalTrajectoryCommitResult>;
  registerInTransaction?(
    connection: SqlExecutor,
    registration: HistoricalTrajectoryRegistration
  ): Promise<HistoricalTrajectoryCommitResult>;
}

export class PostgresMobilityDbTrajectorySlicer implements TemporalTrajectorySlicer {
  public constructor(
    private readonly pool: SqlPool,
    private readonly bounds: SqlExecutionBounds = {}
  ) {}

  public async slice(request: TemporalSliceRequest): Promise<MaterializedTemporalSlice | undefined> {
    const connection = await this.pool.connect();
    let open = false;
    try {
      await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      open = true;
      await configureLocalExecutionBounds(connection,this.bounds);
      await connection.query("SELECT gowm_history_v1.set_data_scope($1::text)", [request.dataScopeKey]);
      const result = await connection.query<Record<string, unknown>>(`
        WITH source AS (
          SELECT atTime(segment.trajectory, $4::tstzspan) AS sliced
          FROM public.mobility_tracklet_segment segment
          JOIN public.mobility_tracklet_version version USING (tracklet_version_id)
          JOIN public.mobility_tracklet tracklet USING (tracklet_id)
          WHERE segment.tracklet_version_id = $1::uuid
            AND segment.segment_no = $2::integer
            AND tracklet.data_scope_key = $3::text
        )
        SELECT sliced::text AS trajectory,
               numInstants(sliced) AS sample_count,
               startTimestamp(sliced) AS start_time,
               endTimestamp(sliced) AS end_time
        FROM source
        WHERE sliced IS NOT NULL
      `, [
        request.sourceTrackletVersionId,
        request.sourceSegmentNo,
        request.dataScopeKey,
        `[${request.period.start},${request.period.end})`
      ]);
      await connection.query("COMMIT");
      open = false;
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const sampleCount = requiredInteger(row.sample_count, "slice sample_count");
      if (sampleCount < 1) return undefined;
      return {
        trajectory: requiredString(row.trajectory, "slice trajectory"),
        sampleCount,
        startTime: isoTimestamp(row.start_time, "slice start_time"),
        endTime: isoTimestamp(row.end_time, "slice end_time")
      };
    } catch (error) {
      if (open) await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function multirangeText(connection: SqlExecutor, periods: readonly TimePeriod[]): Promise<string> {
  const result = await connection.query<{ value: unknown }>(`
    SELECT range_agg(tstzrange(
      (item->>'start')::timestamptz,
      (item->>'end')::timestamptz,
      '[)'
    ))::text AS value
    FROM jsonb_array_elements($1::jsonb) item
  `, [JSON.stringify(periods)]);
  return requiredString(result.rows[0]?.value, "tstzmultirange");
}

function tstzrangeText(value: TimePeriod): string {
  return `[${isoTimestamp(value.start,"range start")},${isoTimestamp(value.end,"range end")})`;
}

export class PostgresHistoricalTrajectoryRepository implements HistoricalTrajectoryRepository {
  public constructor(
    private readonly pool: SqlPool,
    private readonly bounds: SqlExecutionBounds = {}
  ) {}

  public async registerAtomically(registration: HistoricalTrajectoryRegistration): Promise<HistoricalTrajectoryCommitResult> {
    validateLineage(registration);
    return withProjectionTransaction(
      this.pool,
      (connection) => this.registerInTransaction(connection, registration),
      this.bounds
    );
  }

  public async registerInTransaction(
    connection: SqlExecutor,
    registration: HistoricalTrajectoryRegistration
  ): Promise<HistoricalTrajectoryCommitResult> {
    validateLineage(registration);
    const requestedTime = await multirangeText(connection,registration.revision.requestedPeriods);
    const definedTime = await multirangeText(connection,registration.revision.definedPeriods);
      await connection.query(`
        SELECT pg_advisory_xact_lock(hashtextextended(
          $1 || E'\\u001f' || $2 || E'\\u001f' || $3 || E'\\u001f' || $4 || E'\\u001f' || $5,
          0
        ))
      `, [
        registration.dataScopeKey, registration.subjectReferenceKey,
        registration.intervalId, registration.phaseScope, registration.semanticRequestHash
      ]);

      const assembled = await connection.query<Record<string, unknown>>(`
        WITH slices AS (
          SELECT (item->>'segmentNo')::integer AS segment_no,
                 (item->>'trajectory')::tgeompoint AS trajectory
          FROM jsonb_array_elements($1::jsonb) item
        ), value AS (
          SELECT tgeompointSeqSet(array_agg(trajectory ORDER BY segment_no)) AS trajectory
          FROM slices
        )
        SELECT trajectory::text AS trajectory, stbox(trajectory)::text AS extent_box
        FROM value
        WHERE trajectory IS NOT NULL
      `, [JSON.stringify(registration.revision.segments)]);
      const assembledRow = assembled.rows[0];
      if (assembledRow === undefined) throw new HistoricalProjectionInputError("trajectory has no materialized sequences");
      const trajectory = requiredString(assembledRow.trajectory, "trajectory");
      const extentBox = requiredString(assembledRow.extent_box, "extent_box");

      const persistedResourceInputs = registration.resourceInputs.map(({ createdAt, ...persisted }) => {
        void createdAt;
        return persisted;
      });
      const persistedInputSets = registration.inputSets.map(({ createdAt, ...persisted }) => {
        void createdAt;
        return persisted;
      });

      const inputHashResult = await connection.query<{ input_set_hash: unknown }>(`
        SELECT public.grounding_sha256(jsonb_build_object(
          'resources', $1::jsonb, 'sets', $2::jsonb
        )::text) AS input_set_hash
      `, [JSON.stringify(persistedResourceInputs), JSON.stringify(persistedInputSets)]);
      const inputSetHash = requiredString(inputHashResult.rows[0]?.input_set_hash, "input_set_hash") as Sha256Digest;
      const contentHash = canonicalSha256({
        intervalRevisionId: registration.intervalRevisionId,
        trajectory,
        extentBox,
        requestedTime,
        definedTime,
        sampleCount: registration.revision.sampleCount,
        sequenceCount: registration.revision.sequenceCount,
        gaps: registration.revision.gaps,
        excludedPeriods: registration.revision.excludedPeriods,
        completeness: registration.revision.outcome.completeness,
        finalizationState: registration.revision.finalizationState,
        inputSetHash,
        profile: {
          key: registration.profileKey,
          version: registration.profileVersion,
          hash: registration.profileHash
        }
      });

      const existing = await connection.query<Record<string, unknown>>(`
        SELECT revision.trajectory_revision_id, revision.analysis_id
        FROM gowm_history.historical_trajectory identity
        JOIN gowm_history.historical_trajectory_revision revision
          USING (historical_trajectory_id)
        WHERE identity.data_scope_key = $1
          AND identity.subject_reference_key = $2
          AND identity.interval_id = $3::uuid
          AND identity.phase_scope = $4
          AND identity.semantic_request_hash = $5
          AND revision.content_hash = $6
      `, [
        registration.dataScopeKey, registration.subjectReferenceKey,
        registration.intervalId, registration.phaseScope,
        registration.semanticRequestHash, contentHash
      ]);
      const prior = existing.rows[0];
      if (prior !== undefined) {
        return {
          trajectoryRevisionId: requiredString(prior.trajectory_revision_id, "trajectory_revision_id"),
          analysisId: requiredString(prior.analysis_id, "analysis_id"),
          contentHash,
          reused: true
        };
      }

      const head = await connection.query<Record<string, unknown>>(`
        SELECT revision.trajectory_revision_id, revision.analysis_id,
               revision.interval_revision_id,
               interval_revision.revision_no AS interval_revision_no,
               analysis.analysis_as_of
        FROM gowm_history.historical_trajectory identity
        JOIN gowm_history.historical_trajectory_head head USING (historical_trajectory_id)
        JOIN gowm_history.historical_trajectory_revision revision
          ON revision.trajectory_revision_id = head.current_revision_id
        JOIN gowm_history.task_execution_interval_revision interval_revision
          ON interval_revision.interval_revision_id = revision.interval_revision_id
        JOIN public.analysis_record analysis
          ON analysis.analysis_id = revision.analysis_id
        WHERE identity.data_scope_key = $1
          AND identity.subject_reference_key = $2
          AND identity.interval_id = $3::uuid
          AND identity.phase_scope = $4
          AND identity.semantic_request_hash = $5
      `, [
        registration.dataScopeKey, registration.subjectReferenceKey,
        registration.intervalId, registration.phaseScope, registration.semanticRequestHash
      ]);
      const supersedesRevisionId = optionalString(head.rows[0]?.trajectory_revision_id);
      const supersedesAnalysisId = optionalString(head.rows[0]?.analysis_id);
      if (supersedesRevisionId !== undefined) {
        const headCapturedAt = isoTimestamp(head.rows[0]?.analysis_as_of, "head analysis_as_of");
        const requestedCapturedAt = isoTimestamp(registration.capturedAt, "capturedAt");
        const intervalInput = registration.resourceInputs.find(
          (input) => input.inputKind === "TASK_INTERVAL_REVISION"
        )!;
        const requestedIntervalRevisionNo = requiredInteger(
          intervalInput.resourceVersion,
          "TASK_INTERVAL_REVISION resourceVersion"
        );
        const headIntervalRevisionNo = requiredInteger(
          head.rows[0]?.interval_revision_no,
          "head interval revision_no"
        );
        if (millis(requestedCapturedAt) < millis(headCapturedAt)
            || requestedIntervalRevisionNo < headIntervalRevisionNo) {
          throw new HistoricalProjectionInputError(
            "Historical trajectory inputs are older than the current head; an absent old revision cannot retrogress the head"
          );
        }
        if (millis(requestedCapturedAt) === millis(headCapturedAt)) {
          throw new HistoricalProjectionInputError(
            "Historical trajectory content conflicts at the same capturedAt"
          );
        }
      }
      const analysis = await connection.query<{ analysis_id: unknown }>(`
        INSERT INTO public.analysis_record(
          data_scope_key, service_name, tool_name, tool_version, algorithm,
          algorithm_version, status, analysis_as_of, query_payload,
          result_payload, method_snapshot, snapshot_hash, supersedes_analysis_id
        ) VALUES (
          $1, 'gowm.historical-trace', 'history.get-trajectory', '1.0',
          'gap-preserving-historical-trajectory', '1.0', $2, $3::timestamptz,
          $4::jsonb, $5::jsonb, $6::jsonb, $7, $8::uuid
        ) RETURNING analysis_id
      `, [
        registration.dataScopeKey,
        analysisStatus(registration.revision.outcome.status),
        registration.capturedAt,
        JSON.stringify(registration.queryPayload),
        JSON.stringify({
          status: registration.revision.outcome.status,
          reasonCode: registration.revision.outcome.reasonCode,
          completeness: registration.revision.outcome.completeness,
          contentHash
        }),
        JSON.stringify(registration.methodSnapshot),
        inputSetHash,
        supersedesAnalysisId ?? null
      ]);
      const analysisId = requiredString(analysis.rows[0]?.analysis_id, "analysis_id");

      const registered = await connection.query<{ revision_id: unknown }>(`
        SELECT gowm_history.register_historical_trajectory_revision(
          $1::text, $2::text, $3::uuid, $4::text, $5::text, $6::text,
          $7::text, $8::text, $9::text, $10::uuid, $11::tgeompoint,
          $12::stbox, $13::tstzmultirange, $14::tstzmultirange,
          $15::timestamptz, $16::timestamptz, $17::integer, $18::integer,
          $19::integer, $20::double precision, $21::boolean, $22::boolean,
          $23::text, $24::text, $25::text, $26::text, $27::text,
          $28::text, $29::uuid, $30::uuid, $31::jsonb, $32::jsonb,
          $33::jsonb, $34::jsonb, $35::jsonb
        ) AS revision_id
      `, [
        registration.dataScopeKey,
        registration.subjectReferenceKey,
        registration.intervalId,
        registration.phaseScope,
        registration.sourceSelectionKind,
        registration.selectedSourceKey ?? null,
        registration.selectedTrackerSessionKey ?? null,
        registration.analysisSpaceKey,
        registration.semanticRequestHash,
        registration.intervalRevisionId,
        trajectory,
        extentBox,
        requestedTime,
        definedTime,
        registration.revision.startEventTime,
        registration.revision.endEventTime,
        registration.revision.sampleCount,
        registration.revision.sequenceCount,
        registration.revision.gaps.length,
        registration.revision.outcome.completeness.temporalCoverageRatio,
        registration.revision.outcome.completeness.prefixComplete,
        registration.revision.outcome.completeness.suffixComplete,
        registration.revision.finalizationState,
        inputSetHash,
        registration.profileKey,
        registration.profileVersion,
        registration.profileHash,
        contentHash,
        analysisId,
        supersedesRevisionId ?? null,
        JSON.stringify(registration.revision.segments),
        JSON.stringify(registration.revision.gaps.map((gap) => ({
          ...gap,
          gapTime: tstzrangeText(gap.gapTime)
        }))),
        JSON.stringify(registration.revision.excludedPeriods.map((excluded) => ({
          ...excluded,
          excludedTime: tstzrangeText(excluded.excludedTime)
        }))),
        JSON.stringify(persistedResourceInputs),
        JSON.stringify(persistedInputSets)
      ]);
    return {
      trajectoryRevisionId: requiredString(registered.rows[0]?.revision_id, "trajectory revision_id"),
      analysisId,
      contentHash,
      reused: false
    };
  }
}
