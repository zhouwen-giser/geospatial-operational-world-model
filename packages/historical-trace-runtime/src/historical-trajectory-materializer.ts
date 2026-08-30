import {
  canonicalInputSetHash,
  canonicalSha256,
  deriveHistoricalRequestDomain,
  historicalSemanticRequestHash,
  selectHistoricalSource
} from "../../historical-trace-core/src/index.js";
import {
  logicalReferenceKey,
  referenceIdentity,
  type HistoricalSemanticRequest,
  type HistoricalTrackletCandidate,
  type ReconstructedTaskExecutionInterval,
  type Sha256Digest,
  type TaskExecutionPhase,
  type TaskIntervalEvent,
  type TimePeriod
} from "../../historical-trace-model/src/index.js";
import {
  configureLocalExecutionBounds,
  HistoricalProjectionInputError,
  isoTimestamp,
  optionalString,
  requiredInteger,
  requiredString,
  type SqlExecutionBounds,
  type SqlConnection,
  type SqlPool,
  withProjectionTransaction
} from "./database.js";
import {
  PostgresHistoricalTrajectoryRepository,
  PostgresMobilityDbTrajectorySlicer,
  prepareHistoricalTrajectory,
  type HistoricalInputSet,
  type HistoricalResourceInput,
  type HistoricalTrajectoryRegistration,
  type HistoricalTrajectoryCommitResult,
  type HistoricalTrajectoryRepository,
  type RuntimeSourceGap,
  type TemporalTrajectorySlicer
} from "./trajectory-repository.js";

export type MaterializationOutcomeReason =
  | "TASK_INTERVAL_UNAVAILABLE"
  | "TRACKLET_NOT_FOUND"
  | "SOURCE_SELECTION_REQUIRED"
  | "ENTITY_BINDING_AMBIGUOUS"
  | "MULTIPLE_TRACKLETS_AMBIGUOUS"
  | "ANALYSIS_SPACE_MISMATCH"
  | "PROJECTION_PENDING"
  | "RESOURCE_MISSING"
  | "SCHEMA_MISMATCH";

export interface HistoricalSnapshotResource {
  resourceKind: string;
  resourceId: string;
  version: string;
  pinning: "PINNED" | "AT_LEAST" | "BEST_EFFORT";
  contentHash?: Sha256Digest;
  worldVersion?: number;
}

export interface HistoricalRequestedSnapshot {
  querySnapshotId: string;
  mode: "LATEST_AT_START" | "PINNED" | "AT_LEAST_WORLD_VERSION" | "BEST_EFFORT";
  consistency: "PINNED" | "CONSISTENT_AT_START" | "BEST_EFFORT";
  capturedAt: string;
  resources: HistoricalSnapshotResource[];
  minimumWorldVersion?: number;
  manifestHash: Sha256Digest;
}

export interface HistoricalTrajectoryMaterializationRequest {
  dataScopeKey: string;
  capturedAt: string;
  query: HistoricalSemanticRequest;
  /** Frozen Gateway snapshot. Missing discoverable pins are resolved head-free at capturedAt. */
  requestedSnapshot?: HistoricalRequestedSnapshot;
}

export interface HistoricalTrajectoryOutcomeRecord {
  outcomeId: string;
  analysisId: string;
  contentHash: Sha256Digest;
  reused: boolean;
}

export type HistoricalTrajectoryMaterializationResult =
  | ({ status: "MATERIALIZED" } & HistoricalTrajectoryCommitResult)
  | {
      status: "OUTCOME";
      outcomeStatus: "NO_DATA" | "INDETERMINATE" | "PENDING";
      reasonCode: MaterializationOutcomeReason;
      outcome: HistoricalTrajectoryOutcomeRecord;
    };

interface LoadedInterval {
  intervalId: string;
  intervalReferenceKey: string;
  intervalRevisionId: string;
  revisionNo: number;
  worldVersion: number;
  contentHash: Sha256Digest;
  inputEventSetHash: Sha256Digest;
  createdAt: string;
  interval: ReconstructedTaskExecutionInterval;
}

interface LoadedProfile {
  profileKey: string;
  profileVersion: string;
  profileHash: Sha256Digest;
  createdAt: string;
}

interface LoadedAnalysisSpace {
  analysisSpaceKey: string;
  version: string;
  contentHash: Sha256Digest;
  createdAt: string;
}

interface SelectedTracklet {
  candidate: HistoricalTrackletCandidate;
  contentHash: Sha256Digest;
  finalizationRevisionId: string;
  finalizationRevisionNo: number;
  finalizationState: "PROVISIONAL" | "SEALED" | "REOPENED" | "CONFLICTED";
  finalizationHash: Sha256Digest;
  finalizationCreatedAt: string;
  watermarkSetHash: Sha256Digest;
}

interface LoadedMaterialization {
  kind: "READY";
  request: HistoricalTrajectoryMaterializationRequest;
  semanticRequestHash: Sha256Digest;
  interval: LoadedInterval;
  profile: LoadedProfile;
  analysisSpace: LoadedAnalysisSpace;
  selectedSourceKey: string;
  selectedTrackerSessionKey: string;
  selectedTracklets: SelectedTracklet[];
  sourceSegments: Array<{
    sourceTrackletVersionId: string;
    sourceSegmentNo: number;
    period: TimePeriod;
    sampleCount: number;
  }>;
  sourceGaps: RuntimeSourceGap[];
  resourceInputs: HistoricalResourceInput[];
  inputSets: HistoricalInputSet[];
}

interface LoadedOutcome {
  kind: "OUTCOME";
  request: HistoricalTrajectoryMaterializationRequest;
  semanticRequestHash: Sha256Digest;
  status: "NO_DATA" | "INDETERMINATE" | "PENDING";
  reasonCode: MaterializationOutcomeReason;
  diagnosticReasonCodes?: string[];
}

export type HistoricalTrajectoryLoadResult = LoadedMaterialization | LoadedOutcome;

export interface HistoricalTrajectoryMaterializationLoader {
  load(request: HistoricalTrajectoryMaterializationRequest): Promise<HistoricalTrajectoryLoadResult>;
}

export interface HistoricalTrajectoryOutcomeRepository {
  record(
    request: HistoricalTrajectoryMaterializationRequest,
    semanticRequestHash: Sha256Digest,
    status: "NO_DATA" | "INDETERMINATE" | "PENDING",
    reasonCode: MaterializationOutcomeReason,
    diagnosticReasonCodes?: readonly string[]
  ): Promise<HistoricalTrajectoryOutcomeRecord>;
  recordInTransaction?(
    connection: SqlConnection,
    request: HistoricalTrajectoryMaterializationRequest,
    semanticRequestHash: Sha256Digest,
    status: "NO_DATA" | "INDETERMINATE" | "PENDING",
    reasonCode: MaterializationOutcomeReason,
    diagnosticReasonCodes?: readonly string[]
  ): Promise<HistoricalTrajectoryOutcomeRecord>;
}

function digest(value: unknown, field: string): Sha256Digest {
  const result = requiredString(value, field);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new HistoricalProjectionInputError(`${field} is not SHA-256`);
  return result as Sha256Digest;
}

function nullableIso(value: unknown, field: string): string | undefined {
  return value === null || value === undefined ? undefined : isoTimestamp(value, field);
}

function validateRequestReferences(query: HistoricalSemanticRequest): void {
  if (query.subjectReferenceKey.namespace !== "gowm" || query.subjectReferenceKey.kind !== "WORLD_OBJECT") {
    throw new HistoricalProjectionInputError("subjectReferenceKey must identify a GOWM WORLD_OBJECT");
  }
  if (query.executionIntervalReferenceKey.namespace !== "gowm"
      || query.executionIntervalReferenceKey.kind !== "TASK_EXECUTION_INTERVAL") {
    throw new HistoricalProjectionInputError(
      "executionIntervalReferenceKey must identify a GOWM TASK_EXECUTION_INTERVAL"
    );
  }
  if (query.sourceSelectionProfileReferenceKey.namespace !== "gowm.history"
      || query.sourceSelectionProfileReferenceKey.kind !== "HISTORY_METHOD_PROFILE") {
    throw new HistoricalProjectionInputError(
      "sourceSelectionProfileReferenceKey must identify a GOWM history method profile"
    );
  }
  if (query.analysisSpaceReferenceKey !== undefined
      && (query.analysisSpaceReferenceKey.namespace !== "gowm"
        || query.analysisSpaceReferenceKey.kind !== "ANALYSIS_SPACE"
        || query.analysisSpaceReferenceKey.version !== "1")) {
    throw new HistoricalProjectionInputError(
      "analysisSpaceReferenceKey must identify the immutable GOWM ANALYSIS_SPACE version 1 contract"
    );
  }
}

const HISTORICAL_PIN_KINDS = new Set([
  "TASK_EXECUTION_INTERVAL",
  "TRACKLET_VERSION",
  "TRACKLET_FINALIZATION",
  "WATERMARK_REVISION",
  "WATERMARK",
  "HISTORY_METHOD_PROFILE",
  "ANALYSIS_SPACE"
]);

function validateRequestedSnapshot(
  request: HistoricalTrajectoryMaterializationRequest,
  capturedAt: string
): readonly HistoricalSnapshotResource[] {
  const snapshot = request.requestedSnapshot;
  if (snapshot === undefined) return [];
  if (isoTimestamp(snapshot.capturedAt, "requestedSnapshot capturedAt") !== capturedAt) {
    throw new HistoricalProjectionInputError("requestedSnapshot capturedAt differs from materialization capturedAt");
  }
  const { manifestHash, ...canonical } = snapshot;
  if (!/^sha256:[0-9a-f]{64}$/u.test(manifestHash) || canonicalSha256(canonical) !== manifestHash) {
    throw new HistoricalProjectionInputError("requestedSnapshot manifestHash is invalid");
  }
  const seen = new Set<string>();
  for (const pin of snapshot.resources) {
    const identity = `${pin.resourceKind}\u001f${pin.resourceId}`;
    if (seen.has(identity)) throw new HistoricalProjectionInputError("requestedSnapshot has duplicate resource pins");
    seen.add(identity);
    if (!HISTORICAL_PIN_KINDS.has(pin.resourceKind)) continue;
    if (pin.pinning !== "PINNED" || pin.contentHash === undefined
        || !/^sha256:[0-9a-f]{64}$/u.test(pin.contentHash)) {
      throw new HistoricalProjectionInputError(
        `${pin.resourceKind} requestedSnapshot resource must be exactly pinned by content hash`
      );
    }
  }
  return snapshot.resources;
}

function pinsOfKind(
  pins: readonly HistoricalSnapshotResource[],
  ...kinds: readonly string[]
): HistoricalSnapshotResource[] {
  const accepted = new Set(kinds);
  return pins.filter((pin) => accepted.has(pin.resourceKind));
}

function assertPin(
  pin: HistoricalSnapshotResource,
  actual: { resourceId: string; version: string; contentHash: Sha256Digest; worldVersion?: number },
  label: string
): void {
  if (pin.resourceId !== actual.resourceId
      || pin.version !== actual.version
      || pin.contentHash !== actual.contentHash
      || (pin.worldVersion !== undefined && pin.worldVersion !== actual.worldVersion)) {
    throw new HistoricalProjectionInputError(`${label} differs from its requestedSnapshot pin`);
  }
}

function watermarkPinHash(row: Record<string, unknown>): Sha256Digest {
  return canonicalSha256({
    watermarkRevisionId: requiredString(row.watermark_revision_id, "watermark_revision_id"),
    datastreamKey: requiredString(row.datastream_key, "watermark datastream_key"),
    closedThroughEventTime: row.closed_through_event_time === null || row.closed_through_event_time === undefined
      ? null
      : isoTimestamp(row.closed_through_event_time, "closed_through_event_time"),
    allowedLateness: requiredString(row.allowed_lateness, "watermark allowed_lateness"),
    completenessState: requiredString(row.completeness_state, "watermark completeness_state"),
    createdAt: isoTimestamp(row.watermark_created_at, "watermark created_at")
  });
}

function period(start: unknown, end: unknown, field: string): TimePeriod {
  const lower = isoTimestamp(start, `${field} start`);
  const upper = isoTimestamp(end, `${field} end`);
  if (Date.parse(upper) <= Date.parse(lower)) throw new HistoricalProjectionInputError(`${field} is empty`);
  return { start: lower, end: upper, bounds: "[)" };
}

function materializationReason(reason: string): {
  status: LoadedOutcome["status"];
  reasonCode: MaterializationOutcomeReason;
  diagnosticReasonCodes: string[];
} {
  const diagnosticReasonCodes = [reason];
  switch (reason) {
    case "NO_SOURCE_CANDIDATE": return { status: "NO_DATA", reasonCode: "TRACKLET_NOT_FOUND", diagnosticReasonCodes };
    case "ENTITY_BINDING_CONFLICT": return { status: "INDETERMINATE", reasonCode: "ENTITY_BINDING_AMBIGUOUS", diagnosticReasonCodes };
    case "ANALYSIS_SPACE_CONFLICT": return { status: "INDETERMINATE", reasonCode: "ANALYSIS_SPACE_MISMATCH", diagnosticReasonCodes };
    case "MULTIPLE_SOURCE_CANDIDATES": return { status: "INDETERMINATE", reasonCode: "SOURCE_SELECTION_REQUIRED", diagnosticReasonCodes };
    default: return { status: "INDETERMINATE", reasonCode: "MULTIPLE_TRACKLETS_AMBIGUOUS", diagnosticReasonCodes };
  }
}

function preparationReason(status: string, reason: string): {
  status: "NO_DATA" | "INDETERMINATE";
  reasonCode: MaterializationOutcomeReason;
  diagnosticReasonCodes: string[];
} {
  const diagnosticReasonCodes = [reason];
  if (status === "NO_DATA" || reason === "NO_TRAJECTORY_POINTS") {
    return { status: "NO_DATA", reasonCode: "TRACKLET_NOT_FOUND", diagnosticReasonCodes };
  }
  if (reason === "TASK_INTERVAL_CONFLICT" || reason === "INVALID_REQUEST_DURATION") {
    return { status: "INDETERMINATE", reasonCode: "TASK_INTERVAL_UNAVAILABLE", diagnosticReasonCodes };
  }
  if (reason === "SOURCE_SELECTION_CONFLICT") {
    return { status: "INDETERMINATE", reasonCode: "MULTIPLE_TRACKLETS_AMBIGUOUS", diagnosticReasonCodes };
  }
  return { status: "INDETERMINATE", reasonCode: "SCHEMA_MISMATCH", diagnosticReasonCodes };
}

function intervalEvent(row: Record<string, unknown>): TaskIntervalEvent {
  const result: TaskIntervalEvent = {
    eventId: requiredString(row.event_id, "event_id"),
    eventType: requiredString(row.event_type, "event_type"),
    eventTime: isoTimestamp(row.event_time, "event_time"),
    receivedTime: isoTimestamp(row.received_time, "received_time"),
    sourceAuthority: requiredString(row.source_authority, "source_authority"),
    sourceEventKey: requiredString(row.source_event_key, "source_event_key"),
    sourceRevisionNo: requiredInteger(row.source_revision_no, "source_revision_no"),
    eventContentHash: digest(row.content_hash, "event content_hash")
  };
  if (row.confidence !== null && row.confidence !== undefined) result.confidence = Number(row.confidence);
  return result;
}

function phase(row: Record<string, unknown>): TaskExecutionPhase {
  const value: TaskExecutionPhase = {
    phaseNo: requiredInteger(row.phase_no, "phase_no"),
    phaseKind: requiredString(row.phase_kind, "phase_kind") as TaskExecutionPhase["phaseKind"],
    reasonCodes: Array.isArray(row.reason_codes) ? row.reason_codes.map(String) as TaskExecutionPhase["reasonCodes"] : []
  };
  const start = nullableIso(row.phase_start, "phase_start");
  const end = nullableIso(row.phase_end, "phase_end");
  const startEvent = optionalString(row.start_event_id);
  const endEvent = optionalString(row.end_event_id);
  if (start !== undefined) value.start = start;
  if (end !== undefined) value.end = end;
  if (startEvent !== undefined) value.startEventId = startEvent;
  if (endEvent !== undefined) value.endEventId = endEvent;
  if (row.confidence !== null && row.confidence !== undefined) value.confidence = Number(row.confidence);
  return value;
}

async function setScopeFirst(connection: SqlConnection, scope: string): Promise<void> {
  await connection.query("SELECT gowm_history_v1.set_data_scope($1::text)", [scope]);
}

/** Internal projection loader: every base-table discovery carries an explicit scope and capturedAt bound. */
export class PostgresHistoricalTrajectoryInputLoader implements HistoricalTrajectoryMaterializationLoader {
  public constructor(
    private readonly pool: SqlPool,
    private readonly bounds: SqlExecutionBounds = {}
  ) {}

  public async load(request: HistoricalTrajectoryMaterializationRequest): Promise<HistoricalTrajectoryLoadResult> {
    validateRequestReferences(request.query);
    const capturedAt = isoTimestamp(request.capturedAt, "capturedAt");
    const snapshotPins = validateRequestedSnapshot(request, capturedAt);
    const semanticRequestHash = historicalSemanticRequestHash(request.query);
    const connection = await this.pool.connect();
    let open = false;
    try {
      await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      open = true;
      await configureLocalExecutionBounds(connection,this.bounds);
      await setScopeFirst(connection, request.dataScopeKey);

      const intervalRows = await connection.query<Record<string, unknown>>(`
        SELECT interval.interval_id, interval.reference_key, interval.execution_no,
               revision.interval_revision_id, revision.revision_no,
               lower(revision.execution_range) AS interval_start,
               upper(revision.execution_range) AS interval_end,
               revision.lifecycle_state, revision.derivation_kind,
               revision.stability_state, revision.start_event_id,
               revision.terminal_event_id, revision.input_event_set_hash,
               revision.confidence, revision.reason_codes, revision.world_version,
               revision.content_hash, revision.created_at
        FROM gowm_history.task_execution_interval interval
        JOIN gowm_history.task_execution_interval_revision revision USING (interval_id)
        WHERE interval.data_scope_key = $1
          AND interval.reference_key = $2
          AND revision.revision_no = $3::integer
          AND revision.created_at <= $4::timestamptz
      `, [
        request.dataScopeKey,
        request.query.executionIntervalReferenceKey.id,
        requiredInteger(request.query.executionIntervalReferenceKey.version, "interval version"),
        capturedAt
      ]);
      const intervalRow = intervalRows.rows[0];
      if (intervalRow === undefined) {
        await connection.query("COMMIT"); open = false;
        return { kind: "OUTCOME", request, semanticRequestHash, status: "NO_DATA", reasonCode: "TASK_INTERVAL_UNAVAILABLE" };
      }
      const intervalRevisionId = requiredString(intervalRow.interval_revision_id, "interval_revision_id");
      const phaseRows = await connection.query<Record<string, unknown>>(`
        SELECT phase.phase_no, phase.phase_kind,
               lower(phase.phase_range) AS phase_start,
               upper(phase.phase_range) AS phase_end,
               phase.start_event_id, phase.end_event_id,
               phase.confidence, phase.reason_codes
        FROM gowm_history.task_execution_phase phase
        JOIN gowm_history.task_execution_interval_revision revision USING (interval_revision_id)
        JOIN gowm_history.task_execution_interval interval USING (interval_id)
        WHERE interval.data_scope_key = $1
          AND phase.interval_revision_id = $2::uuid
          AND phase.created_at <= $3::timestamptz
        ORDER BY phase.phase_no
      `, [request.dataScopeKey, intervalRevisionId, capturedAt]);
      const eventRows = await connection.query<Record<string, unknown>>(`
        SELECT event.event_id, event.event_type, event.event_time,
               event.received_time, event.source_authority, event.source_event_key,
               event.source_revision_no, event.content_hash, event.confidence
        FROM gowm_history.task_execution_interval_input input
        JOIN public.operational_task_event event
          ON event.data_scope_key = input.data_scope_key
         AND event.event_id = input.operational_event_id
        JOIN gowm_history.task_execution_interval_revision revision
          ON revision.interval_revision_id = input.interval_revision_id
        JOIN gowm_history.task_execution_interval interval USING (interval_id)
        WHERE interval.data_scope_key = $1
          AND input.interval_revision_id = $2::uuid
          AND event.created_at <= $3::timestamptz
        ORDER BY input.event_no
      `, [request.dataScopeKey, intervalRevisionId, capturedAt]);
      const events = eventRows.rows.map(intervalEvent);
      if (events.length === 0) {
        await connection.query("COMMIT"); open = false;
        return {
          kind: "OUTCOME", request, semanticRequestHash,
          status: "INDETERMINATE", reasonCode: "RESOURCE_MISSING"
        };
      }
      const interval: ReconstructedTaskExecutionInterval = {
        executionNo: requiredInteger(intervalRow.execution_no, "execution_no"),
        lifecycleState: requiredString(intervalRow.lifecycle_state, "lifecycle_state") as ReconstructedTaskExecutionInterval["lifecycleState"],
        derivationKind: requiredString(intervalRow.derivation_kind, "derivation_kind") === "OBSERVED_ONLY" ? "OBSERVED" : "MIXED",
        stabilityState: requiredString(intervalRow.stability_state, "stability_state") as ReconstructedTaskExecutionInterval["stabilityState"],
        phases: phaseRows.rows.map(phase),
        reasonCodes: Array.isArray(intervalRow.reason_codes) ? intervalRow.reason_codes.map(String) as ReconstructedTaskExecutionInterval["reasonCodes"] : [],
        inputEvents: events,
        inputEventSetHash: digest(intervalRow.input_event_set_hash, "input_event_set_hash"),
        contentHash: digest(intervalRow.content_hash, "interval content_hash")
      };
      const start = nullableIso(intervalRow.interval_start, "interval_start");
      const end = nullableIso(intervalRow.interval_end, "interval_end");
      const startEventId = optionalString(intervalRow.start_event_id);
      const terminalEventId = optionalString(intervalRow.terminal_event_id);
      if (start !== undefined) interval.start = start;
      if (end !== undefined) interval.end = end;
      if (startEventId !== undefined) interval.startEventId = startEventId;
      if (terminalEventId !== undefined) interval.terminalEventId = terminalEventId;
      if (intervalRow.confidence !== null && intervalRow.confidence !== undefined) interval.confidence = Number(intervalRow.confidence);
      const loadedInterval: LoadedInterval = {
        intervalId: requiredString(intervalRow.interval_id, "interval_id"),
        intervalReferenceKey: requiredString(intervalRow.reference_key, "interval reference_key"),
        intervalRevisionId,
        revisionNo: requiredInteger(intervalRow.revision_no, "interval revision_no"),
        worldVersion: requiredInteger(intervalRow.world_version, "interval world_version"),
        contentHash: interval.contentHash,
        inputEventSetHash: interval.inputEventSetHash,
        createdAt: isoTimestamp(intervalRow.created_at, "interval created_at"),
        interval
      };
      const intervalPins = pinsOfKind(snapshotPins, "TASK_EXECUTION_INTERVAL");
      if (intervalPins.length > 1) {
        throw new HistoricalProjectionInputError("requestedSnapshot has multiple task interval pins");
      }
      for (const pin of intervalPins) {
        if (pin.resourceId !== loadedInterval.intervalReferenceKey) {
          throw new HistoricalProjectionInputError("task interval requestedSnapshot pin identifies another resource");
        }
        assertPin(
          pin,
          {
            resourceId: loadedInterval.intervalReferenceKey,
            version: String(loadedInterval.revisionNo),
            contentHash: loadedInterval.contentHash,
            worldVersion: loadedInterval.worldVersion
          },
          "task interval"
        );
      }

      const profileRows = await connection.query<Record<string, unknown>>(`
        SELECT profile_key, profile_version, content_hash, created_at
        FROM gowm_history.method_profile
        WHERE profile_key = $1
          AND profile_version = $2
          AND profile_kind = 'TRAJECTORY_SELECTION'
          AND created_at <= $3::timestamptz
      `, [
        request.query.sourceSelectionProfileReferenceKey.id,
        request.query.sourceSelectionProfileReferenceKey.version,
        capturedAt
      ]);
      const profileRow = profileRows.rows[0];
      if (profileRow === undefined) {
        await connection.query("COMMIT"); open = false;
        return { kind: "OUTCOME", request, semanticRequestHash, status: "INDETERMINATE", reasonCode: "RESOURCE_MISSING" };
      }
      const profile: LoadedProfile = {
        profileKey: requiredString(profileRow.profile_key, "profile_key"),
        profileVersion: requiredString(profileRow.profile_version, "profile_version"),
        profileHash: digest(profileRow.content_hash, "profile content_hash"),
        createdAt: isoTimestamp(profileRow.created_at, "profile created_at")
      };
      const profilePins = pinsOfKind(snapshotPins, "HISTORY_METHOD_PROFILE");
      if (profilePins.length > 1) {
        throw new HistoricalProjectionInputError("requestedSnapshot has multiple history method profile pins");
      }
      for (const pin of profilePins) {
        assertPin(pin, {
          resourceId: profile.profileKey,
          version: profile.profileVersion,
          contentHash: profile.profileHash
        }, "history method profile");
      }

      const subjectRows = await connection.query<Record<string, unknown>>(`
        SELECT internal_id, entity_kind
        FROM public.world_reference_identity
        WHERE reference_key = $1 AND data_scope_key = $2
          AND created_at <= $3::timestamptz
      `, [request.query.subjectReferenceKey.id, request.dataScopeKey, capturedAt]);
      const subject = subjectRows.rows[0];
      if (subject === undefined || subject.entity_kind !== "WORLD_OBJECT") {
        await connection.query("COMMIT"); open = false;
        return { kind: "OUTCOME", request, semanticRequestHash, status: "INDETERMINATE", reasonCode: "SCHEMA_MISMATCH" };
      }
      const subjectInternalId = requiredString(subject.internal_id, "subject internal_id");
      const trackletPins = pinsOfKind(snapshotPins, "TRACKLET_VERSION");
      const pinnedTrackletIds = trackletPins.length === 0
        ? null
        : trackletPins.map((pin) => pin.resourceId);
      const candidateRows = await connection.query<Record<string, unknown>>(`
        WITH eligible AS (
          SELECT tracklet.tracklet_id, tracklet.data_scope_key,
                 tracklet.source_key, tracklet.source_local_target_id,
                 tracklet.tracker_session_key, tracklet.analysis_space_key,
                 tracklet.world_object_id,
                 version.tracklet_version_id, version.version_no,
                 version.start_event_time, version.end_event_time,
                 version.content_hash, version.created_at,
                 row_number() OVER (
                   PARTITION BY tracklet.tracklet_id
                   ORDER BY version.version_no DESC, version.created_at DESC,
                            version.tracklet_version_id DESC
                 ) AS version_rank
          FROM public.mobility_tracklet tracklet
          JOIN public.mobility_tracklet_version version USING (tracklet_id)
          WHERE tracklet.data_scope_key = $1
            AND tracklet.world_object_id = $2
            AND tracklet.created_at <= $3::timestamptz
            AND version.created_at <= $3::timestamptz
        )
        SELECT tracklet.tracklet_id, tracklet.source_key,
               tracklet.tracker_session_key, tracklet.analysis_space_key,
               tracklet.tracklet_version_id, tracklet.version_no,
               tracklet.start_event_time, tracklet.end_event_time,
               CASE
                 WHEN tracklet.content_hash ~ '^[0-9a-f]{64}$'
                   THEN 'sha256:' || tracklet.content_hash
                 ELSE tracklet.content_hash
               END AS content_hash,
               tracklet.created_at,
               CASE WHEN EXISTS (
                 SELECT 1 FROM public.entity_binding binding
                 WHERE binding.data_scope_key = tracklet.data_scope_key
                   AND binding.source_key = tracklet.source_key
                   AND binding.source_local_target_id = tracklet.source_local_target_id
                   AND binding.tracker_session_key = tracklet.tracker_session_key
                   AND binding.created_at <= $3::timestamptz
                   AND binding.binding_status IN ('DECLARED','CONFIRMED')
                   AND binding.world_object_id IS DISTINCT FROM tracklet.world_object_id
               ) THEN 'CONFLICTED' ELSE 'VALID' END AS binding_state
        FROM eligible tracklet
        WHERE (
          $4::uuid[] IS NULL AND tracklet.version_rank = 1
        ) OR (
          $4::uuid[] IS NOT NULL AND (
            tracklet.tracklet_version_id = ANY($4::uuid[])
            OR (
              tracklet.version_rank = 1
              AND NOT EXISTS (
                SELECT 1 FROM eligible pinned
                WHERE pinned.tracklet_id = tracklet.tracklet_id
                  AND pinned.tracklet_version_id = ANY($4::uuid[])
              )
            )
          )
        )
        ORDER BY tracklet.source_key, tracklet.tracker_session_key,
                 tracklet.tracklet_id, tracklet.version_no,
                 tracklet.created_at, tracklet.tracklet_version_id
      `, [request.dataScopeKey, subjectInternalId, capturedAt, pinnedTrackletIds]);
      const subjectIdentity = referenceIdentity(logicalReferenceKey(request.query.subjectReferenceKey));
      const candidates: HistoricalTrackletCandidate[] = candidateRows.rows.map((row) => ({
        sourceKey: requiredString(row.source_key, "candidate source_key"),
        trackerSessionKey: requiredString(row.tracker_session_key, "candidate tracker_session_key"),
        trackletId: requiredString(row.tracklet_id, "candidate tracklet_id"),
        trackletVersionId: requiredString(row.tracklet_version_id, "candidate tracklet_version_id"),
        versionNo: requiredInteger(row.version_no, "candidate version_no"),
        createdAt: isoTimestamp(row.created_at, "candidate created_at"),
        subjectReferenceIdentity: subjectIdentity,
        analysisSpaceIdentity: requiredString(row.analysis_space_key, "candidate analysis_space_key"),
        periods: [period(row.start_event_time, row.end_event_time, "candidate period")],
        bindingState: row.binding_state === "CONFLICTED" ? "CONFLICTED" : "VALID"
      }));
      for (const pin of trackletPins) {
        const row = candidateRows.rows.find(
          (candidate) => String(candidate.tracklet_version_id) === pin.resourceId
        );
        if (row === undefined) {
          throw new HistoricalProjectionInputError("pinned tracklet version is unavailable at capturedAt");
        }
        assertPin(pin, {
          resourceId: requiredString(row.tracklet_version_id, "tracklet_version_id"),
          version: String(requiredInteger(row.version_no, "tracklet version_no")),
          contentHash: digest(row.content_hash, "tracklet content_hash")
        }, "tracklet version");
      }
      const pinnedTrackletIdentities = trackletPins.map((pin) => requiredString(
        candidateRows.rows.find((candidate) => String(candidate.tracklet_version_id) === pin.resourceId)?.tracklet_id,
        "pinned tracklet_id"
      ));
      if (new Set(pinnedTrackletIdentities).size !== trackletPins.length) {
        throw new HistoricalProjectionInputError("requestedSnapshot tracklet pins are not one-to-one");
      }
      const requestDomain = deriveHistoricalRequestDomain(interval, request.query.phaseScope, capturedAt);
      if (requestDomain.conflicted || requestDomain.requestedPeriods.length === 0) {
        await connection.query("COMMIT"); open = false;
        return {
          kind: "OUTCOME", request, semanticRequestHash,
          status: "INDETERMINATE", reasonCode: "TASK_INTERVAL_UNAVAILABLE",
          diagnosticReasonCodes: [
            requestDomain.conflicted ? "TASK_INTERVAL_CONFLICT" : "INVALID_REQUEST_DURATION"
          ]
        };
      }
      const selection = selectHistoricalSource(candidates, {
        selection: request.query.sourceSelection,
        capturedAt,
        subjectReferenceIdentity: subjectIdentity,
        ...(request.query.analysisSpaceReferenceKey === undefined
          ? {}
          : { analysisSpaceIdentity: request.query.analysisSpaceReferenceKey.id }),
        requestedPeriods: requestDomain.requestedPeriods
      });
      if (selection.status !== "SELECTED") {
        const outcome = materializationReason(selection.reasonCode);
        await connection.query("COMMIT"); open = false;
        return { kind: "OUTCOME", request, semanticRequestHash, ...outcome };
      }
      if (trackletPins.length > 0) {
        const selected = new Set(selection.candidates.map((candidate) => candidate.trackletVersionId));
        if (trackletPins.some((pin) => !selected.has(pin.resourceId))) {
          throw new HistoricalProjectionInputError("source selection does not consume every pinned tracklet version");
        }
      }
      const analysisSpaceKey = selection.analysisSpaceIdentity;
      const spaceRows = await connection.query<Record<string, unknown>>(`
        SELECT analysis_space_key, canonical_srid, dimension_model,
               distance_model, transform_pipeline_version, created_at
        FROM public.analysis_space
        WHERE analysis_space_key = $1 AND created_at <= $2::timestamptz
      `, [analysisSpaceKey, capturedAt]);
      const space = spaceRows.rows[0];
      if (space === undefined) {
        await connection.query("COMMIT"); open = false;
        return { kind: "OUTCOME", request, semanticRequestHash, status: "INDETERMINATE", reasonCode: "ANALYSIS_SPACE_MISMATCH" };
      }
      const analysisSpace: LoadedAnalysisSpace = {
        analysisSpaceKey,
        version: request.query.analysisSpaceReferenceKey?.version ?? "1",
        contentHash: canonicalSha256({
          analysisSpaceKey,
          canonicalSrid: requiredInteger(space.canonical_srid, "canonical_srid"),
          dimensionModel: requiredString(space.dimension_model, "dimension_model"),
          distanceModel: requiredString(space.distance_model, "distance_model"),
          transformPipelineVersion: requiredString(space.transform_pipeline_version, "transform_pipeline_version")
        }),
        createdAt: isoTimestamp(space.created_at, "analysis space created_at")
      };
      const analysisSpacePins = pinsOfKind(snapshotPins, "ANALYSIS_SPACE");
      if (analysisSpacePins.length > 1) {
        throw new HistoricalProjectionInputError("requestedSnapshot has multiple analysis-space pins");
      }
      for (const pin of analysisSpacePins) {
        assertPin(pin, {
          resourceId: analysisSpace.analysisSpaceKey,
          version: analysisSpace.version,
          contentHash: analysisSpace.contentHash
        }, "analysis space");
      }

      const selectedIds = selection.candidates.map((candidate) => candidate.trackletVersionId);
      const finalizationPins = pinsOfKind(snapshotPins, "TRACKLET_FINALIZATION");
      const pinnedFinalizationIds = finalizationPins.length === 0
        ? null
        : finalizationPins.map((pin) => pin.resourceId);
      const finalizationRows = await connection.query<Record<string, unknown>>(`
        SELECT requested.tracklet_version_id,
               finalization.finalization_revision_id,
               finalization.revision_no, finalization.finalization_state,
               finalization.watermark_set_hash,
               finalization.content_hash, finalization.created_at,
               CASE WHEN $4::uuid[] IS NULL THEN false ELSE EXISTS (
                 SELECT 1
                 FROM gowm_history.tracklet_finalization_revision pinned
                 WHERE pinned.tracklet_version_id = requested.tracklet_version_id
                   AND pinned.finalization_revision_id = ANY($4::uuid[])
               ) END AS requested_pin
        FROM unnest($1::uuid[]) requested(tracklet_version_id)
        LEFT JOIN LATERAL (
          SELECT revision.*
          FROM gowm_history.tracklet_finalization_revision revision
          JOIN public.mobility_tracklet_version version
            ON version.tracklet_version_id = revision.tracklet_version_id
          JOIN public.mobility_tracklet tracklet USING (tracklet_id)
          WHERE revision.tracklet_version_id = requested.tracklet_version_id
            AND tracklet.data_scope_key = $2
            AND revision.created_at <= $3::timestamptz
            AND (
              $4::uuid[] IS NULL
              OR revision.finalization_revision_id = ANY($4::uuid[])
              OR NOT EXISTS (
                SELECT 1
                FROM gowm_history.tracklet_finalization_revision pinned
                WHERE pinned.tracklet_version_id = requested.tracklet_version_id
                  AND pinned.finalization_revision_id = ANY($4::uuid[])
              )
            )
          ORDER BY revision.created_at DESC, revision.revision_no DESC
          LIMIT 1
        ) finalization ON true
        ORDER BY requested.tracklet_version_id
      `, [selectedIds, request.dataScopeKey, capturedAt, pinnedFinalizationIds]);
      const missingFinalizations = finalizationRows.rows.filter(
        (row) => row.finalization_revision_id === null || row.finalization_revision_id === undefined
      );
      if (missingFinalizations.length > 0) {
        if (missingFinalizations.some((row) => row.requested_pin === true)) {
          throw new HistoricalProjectionInputError("pinned tracklet finalization is unavailable at capturedAt");
        }
        await connection.query("COMMIT"); open = false;
        return { kind: "OUTCOME", request, semanticRequestHash, status: "PENDING", reasonCode: "PROJECTION_PENDING" };
      }
      for (const pin of finalizationPins) {
        const row = finalizationRows.rows.find(
          (candidate) => String(candidate.finalization_revision_id) === pin.resourceId
        );
        if (row === undefined) {
          throw new HistoricalProjectionInputError("pinned tracklet finalization is unavailable at capturedAt");
        }
        assertPin(pin, {
          resourceId: requiredString(row.finalization_revision_id, "finalization_revision_id"),
          version: String(requiredInteger(row.revision_no, "finalization revision_no")),
          contentHash: digest(row.content_hash, "finalization content_hash")
        }, "tracklet finalization");
      }
      const candidateById = new Map(selection.candidates.map((candidate) => [candidate.trackletVersionId, candidate]));
      const sourceRowById = new Map(candidateRows.rows.map((row) => [requiredString(row.tracklet_version_id, "tracklet_version_id"), row]));
      const selectedTracklets: SelectedTracklet[] = finalizationRows.rows.map((row) => {
        const id = requiredString(row.tracklet_version_id, "tracklet_version_id");
        const state = requiredString(row.finalization_state, "finalization_state") as SelectedTracklet["finalizationState"];
        return {
          candidate: candidateById.get(id)!,
          contentHash: digest(sourceRowById.get(id)?.content_hash, "tracklet content_hash"),
          finalizationRevisionId: requiredString(row.finalization_revision_id, "finalization_revision_id"),
          finalizationRevisionNo: requiredInteger(row.revision_no, "finalization revision_no"),
          finalizationState: state,
          finalizationHash: digest(row.content_hash, "finalization content_hash"),
          finalizationCreatedAt: isoTimestamp(row.created_at, "finalization created_at"),
          watermarkSetHash: digest(row.watermark_set_hash, "watermark_set_hash")
        };
      });

      const segmentRows = await connection.query<Record<string, unknown>>(`
        SELECT segment.tracklet_version_id, segment.segment_no,
               segment.sample_count, segment.start_time, segment.end_time
        FROM public.mobility_tracklet_segment segment
        JOIN public.mobility_tracklet_version version USING (tracklet_version_id)
        JOIN public.mobility_tracklet tracklet USING (tracklet_id)
        WHERE segment.tracklet_version_id = ANY($1::uuid[])
          AND tracklet.data_scope_key = $2
          AND version.created_at <= $3::timestamptz
        ORDER BY segment.start_time, segment.end_time,
                 segment.tracklet_version_id, segment.segment_no
      `, [selectedIds, request.dataScopeKey, capturedAt]);
      const sourceSegments = segmentRows.rows.map((row) => ({
        sourceTrackletVersionId: requiredString(row.tracklet_version_id, "segment tracklet_version_id"),
        sourceSegmentNo: requiredInteger(row.segment_no, "segment_no"),
        period: period(row.start_time, row.end_time, "source segment"),
        sampleCount: requiredInteger(row.sample_count, "segment sample_count")
      }));
      const trackletsWithSegments = new Set(sourceSegments.map((segment) => segment.sourceTrackletVersionId));
      if (selectedIds.some((id) => !trackletsWithSegments.has(id))) {
        await connection.query("COMMIT"); open = false;
        return {
          kind: "OUTCOME", request, semanticRequestHash,
          status: "INDETERMINATE", reasonCode: "RESOURCE_MISSING"
        };
      }
      const gapRows = await connection.query<Record<string, unknown>>(`
        SELECT gap.tracklet_version_id, gap.gap_no,
               lower(gap.gap_time) AS gap_start, upper(gap.gap_time) AS gap_end,
               gap.left_measurement_id, gap.right_measurement_id,
               gap.primary_reason, gap.reason_codes, gap.observability_state
        FROM public.mobility_tracklet_gap gap
        JOIN public.mobility_tracklet_version version USING (tracklet_version_id)
        JOIN public.mobility_tracklet tracklet USING (tracklet_id)
        WHERE gap.tracklet_version_id = ANY($1::uuid[])
          AND tracklet.data_scope_key = $2
          AND version.created_at <= $3::timestamptz
        ORDER BY gap.tracklet_version_id, gap.gap_no
      `, [selectedIds, request.dataScopeKey, capturedAt]);
      const sourceGaps: RuntimeSourceGap[] = gapRows.rows.map((row) => {
        const reasons = Array.isArray(row.reason_codes) ? row.reason_codes.map(String) : [];
        const reason = reasons.includes("SOURCE_COVERAGE_GAP")
          ? "SOURCE_COVERAGE_GAP"
          : reasons.includes("UNKNOWN_INPUT_GAP")
            ? "UNKNOWN_INPUT_GAP"
            : "TRACKLET_BOUNDARY_GAP";
        return {
          reason,
          range: period(row.gap_start, row.gap_end, "source gap"),
          sourceTrackletVersionId: requiredString(row.tracklet_version_id, "gap tracklet_version_id"),
          sourceTrackletGapNo: requiredInteger(row.gap_no, "gap_no"),
          ...(optionalString(row.left_measurement_id) === undefined ? {} : { leftMeasurementId: String(row.left_measurement_id) }),
          ...(optionalString(row.right_measurement_id) === undefined ? {} : { rightMeasurementId: String(row.right_measurement_id) }),
          ...(reasons.length === 0 ? {} : { details: reasons.join(",") }),
          reasonCodes: [
            ...new Set([
              reason,
              requiredString(row.primary_reason, "gap primary_reason"),
              requiredString(row.observability_state, "gap observability_state"),
              ...reasons
            ])
          ]
        };
      });

      const trackletInputRows = await connection.query<Record<string, unknown>>(`
        SELECT input.tracklet_version_id, input.measurement_id,
               input.observation_id, input.time_solution_id,
               input.segment_no, input.ordinal_no,
               measurement.command_fingerprint, measurement.created_at AS measurement_created_at,
               solution.phenomenon_time_estimate, solution.solution_method,
               solution.created_at AS solution_created_at
        FROM public.mobility_tracklet_input input
        JOIN public.mobility_tracklet_version version USING (tracklet_version_id)
        JOIN public.mobility_tracklet tracklet USING (tracklet_id)
        JOIN public.measurement measurement USING (measurement_id)
        JOIN public.observation_time_solution solution
          ON solution.time_solution_id = input.time_solution_id
        WHERE input.tracklet_version_id = ANY($1::uuid[])
          AND tracklet.data_scope_key = $2
          AND measurement.created_at <= $3::timestamptz
          AND solution.created_at <= $3::timestamptz
        ORDER BY input.tracklet_version_id, input.segment_no, input.ordinal_no,
                 input.measurement_id
      `, [selectedIds, request.dataScopeKey, capturedAt]);
      const watermarkRows = await connection.query<Record<string, unknown>>(`
        SELECT input.finalization_revision_id, input.input_no,
               input.datastream_key, input.watermark_revision_id,
               input.closed_through_event_time, input.allowed_lateness::text,
               input.completeness_state, input.watermark_created_at
        FROM gowm_history.tracklet_finalization_watermark_input input
        JOIN gowm_history.tracklet_finalization_revision finalization
          USING (finalization_revision_id)
        JOIN public.mobility_tracklet_version version USING (tracklet_version_id)
        JOIN public.mobility_tracklet tracklet USING (tracklet_id)
        WHERE input.finalization_revision_id = ANY($1::uuid[])
          AND tracklet.data_scope_key = $2
          AND finalization.created_at <= $3::timestamptz
          AND input.watermark_created_at <= $3::timestamptz
        ORDER BY input.finalization_revision_id, input.input_no
      `, [selectedTracklets.map((item) => item.finalizationRevisionId), request.dataScopeKey, capturedAt]);

      const watermarkPins = pinsOfKind(snapshotPins, "WATERMARK_REVISION", "WATERMARK");
      for (const pin of watermarkPins) {
        const row = watermarkRows.rows.find(
          (candidate) => String(candidate.watermark_revision_id) === pin.resourceId
        );
        if (row === undefined) {
          throw new HistoricalProjectionInputError("pinned watermark revision is not an input to the selected finalization");
        }
        assertPin(pin, {
          resourceId: requiredString(row.watermark_revision_id, "watermark_revision_id"),
          // Watermarks are immutable UUID revisions and have no separate revision_no.
          version: requiredString(row.watermark_revision_id, "watermark_revision_id"),
          contentHash: watermarkPinHash(row)
        }, "watermark revision");
      }

      const trackletsWithInputs = new Set(
        trackletInputRows.rows.map((row) => requiredString(row.tracklet_version_id, "input tracklet_version_id"))
      );
      if (selectedIds.some((id) => !trackletsWithInputs.has(id))) {
        await connection.query("COMMIT"); open = false;
        return {
          kind: "OUTCOME", request, semanticRequestHash,
          status: "INDETERMINATE", reasonCode: "RESOURCE_MISSING"
        };
      }
      const finalizationsWithWatermarks = new Set(
        watermarkRows.rows.map((row) => requiredString(row.finalization_revision_id, "watermark finalization_revision_id"))
      );
      if (selectedTracklets.some((tracklet) => !finalizationsWithWatermarks.has(tracklet.finalizationRevisionId))) {
        await connection.query("COMMIT"); open = false;
        return {
          kind: "OUTCOME", request, semanticRequestHash,
          status: "PENDING", reasonCode: "PROJECTION_PENDING"
        };
      }

      const resourceInputs: HistoricalResourceInput[] = [];
      const addResource = (value: Omit<HistoricalResourceInput, "analysisInputNo">): void => {
        resourceInputs.push({ analysisInputNo: resourceInputs.length + 1, ...value });
      };
      addResource({
        inputRole: "task-interval-revision", inputKind: "TASK_INTERVAL_REVISION",
        resourceNamespace: "gowm", resourceKind: "TASK_EXECUTION_INTERVAL",
        resourceId: loadedInterval.intervalReferenceKey, resourceVersion: String(loadedInterval.revisionNo),
        resourceContentHash: loadedInterval.contentHash, resourceWorldVersion: loadedInterval.worldVersion,
        authority: "gowm.history", createdAt: loadedInterval.createdAt
      });
      for (const tracklet of selectedTracklets) {
        addResource({
          inputRole: "source-tracklet-version", inputKind: "TRACKLET_VERSION",
          resourceNamespace: "gowm.mobility", resourceKind: "TRACKLET_VERSION",
          resourceId: tracklet.candidate.trackletVersionId,
          resourceVersion: String(tracklet.candidate.versionNo),
          resourceContentHash: tracklet.contentHash, authority: "gowm.mobility",
          createdAt: tracklet.candidate.createdAt
        });
        addResource({
          inputRole: "tracklet-finalization", inputKind: "TRACKLET_FINALIZATION_REVISION",
          resourceNamespace: "gowm.history", resourceKind: "TRACKLET_FINALIZATION",
          resourceId: tracklet.finalizationRevisionId,
          resourceVersion: String(tracklet.finalizationRevisionNo),
          resourceContentHash: tracklet.finalizationHash, authority: "gowm.history",
          createdAt: tracklet.finalizationCreatedAt
        });
      }
      addResource({
        inputRole: "trajectory-selection-profile", inputKind: "METHOD_PROFILE",
        resourceNamespace: "gowm.history", resourceKind: "HISTORY_METHOD_PROFILE",
        resourceId: profile.profileKey, resourceVersion: profile.profileVersion,
        resourceContentHash: profile.profileHash, authority: "gowm.history",
        createdAt: profile.createdAt
      });
      addResource({
        inputRole: "analysis-space", inputKind: "ANALYSIS_SPACE",
        resourceNamespace: "gowm", resourceKind: "ANALYSIS_SPACE",
        resourceId: analysisSpace.analysisSpaceKey, resourceVersion: analysisSpace.version,
        resourceContentHash: analysisSpace.contentHash, authority: "gowm.mobility",
        createdAt: analysisSpace.createdAt
      });

      const trackletMembers = trackletInputRows.rows.map((row) => ({
        trackletVersionId: requiredString(row.tracklet_version_id, "member tracklet_version_id"),
        measurementId: requiredString(row.measurement_id, "member measurement_id"),
        observationId: requiredString(row.observation_id, "member observation_id"),
        timeSolutionId: requiredString(row.time_solution_id, "member time_solution_id"),
        segmentNo: requiredInteger(row.segment_no, "member segment_no"),
        ordinalNo: requiredInteger(row.ordinal_no, "member ordinal_no"),
        commandFingerprint: requiredString(row.command_fingerprint, "member command_fingerprint"),
        measurementCreatedAt: isoTimestamp(row.measurement_created_at, "member measurement_created_at")
      }));
      const timeSolutionById = new Map<string, {
        timeSolutionId: string;
        phenomenonTimeEstimate: string;
        solutionMethod: string;
        createdAt: string;
      }>();
      for (const row of trackletInputRows.rows) {
        const timeSolutionId = requiredString(row.time_solution_id, "member time_solution_id");
        timeSolutionById.set(timeSolutionId, {
          timeSolutionId,
          phenomenonTimeEstimate: isoTimestamp(row.phenomenon_time_estimate, "member phenomenon_time_estimate"),
          solutionMethod: requiredString(row.solution_method, "member solution_method"),
          createdAt: isoTimestamp(row.solution_created_at, "member solution_created_at")
        });
      }
      const timeSolutionMembers = [...timeSolutionById.values()];
      const finalizationById = new Map(
        selectedTracklets.map((tracklet) => [tracklet.finalizationRevisionId, tracklet])
      );
      const watermarkMembers = watermarkRows.rows.map((row) => ({
        finalizationRevisionId: requiredString(row.finalization_revision_id, "member finalization_revision_id"),
        inputNo: requiredInteger(row.input_no, "member watermark input_no"),
        datastreamKey: requiredString(row.datastream_key, "member datastream_key"),
        watermarkRevisionId: requiredString(row.watermark_revision_id, "member watermark_revision_id"),
        ...(row.closed_through_event_time === null || row.closed_through_event_time === undefined
          ? {}
          : { closedThroughEventTime: isoTimestamp(row.closed_through_event_time, "member closed_through_event_time") }),
        allowedLateness: requiredString(row.allowed_lateness, "member allowed_lateness"),
        completenessState: requiredString(row.completeness_state, "member completeness_state"),
        watermarkCreatedAt: isoTimestamp(row.watermark_created_at, "member watermark_created_at"),
        pinnedWatermarkSetHash: finalizationById.get(
          requiredString(row.finalization_revision_id, "member finalization_revision_id")
        )!.watermarkSetHash
      }));
      const inputSets: HistoricalInputSet[] = [
        {
          inputSetKind: "TASK_EVENT_SET", itemCount: events.length,
          itemSetDigest: loadedInterval.inputEventSetHash,
          authority: "gowm.history", createdAt: loadedInterval.createdAt
        },
        {
          inputSetKind: "TRACKLET_INPUT_SET", itemCount: trackletMembers.length,
          itemSetDigest: canonicalInputSetHash(trackletMembers), authority: "gowm.mobility",
          createdAt: latestTimestamp(trackletInputRows.rows.map((row) => row.measurement_created_at), capturedAt)
        },
        {
          inputSetKind: "TIME_SOLUTION_SET", itemCount: timeSolutionMembers.length,
          itemSetDigest: canonicalInputSetHash(timeSolutionMembers), authority: "gowm.time",
          createdAt: latestTimestamp(trackletInputRows.rows.map((row) => row.solution_created_at), capturedAt)
        },
        {
          inputSetKind: "WATERMARK_SET", itemCount: watermarkMembers.length,
          itemSetDigest: canonicalInputSetHash(watermarkMembers), authority: "gowm.history",
          createdAt: latestTimestamp(watermarkRows.rows.map((row) => row.watermark_created_at), capturedAt)
        }
      ];

      await connection.query("COMMIT"); open = false;
      return {
        kind: "READY", request, semanticRequestHash, interval: loadedInterval,
        profile, analysisSpace,
        selectedSourceKey: selection.sourceKey,
        selectedTrackerSessionKey: selection.trackerSessionKey,
        selectedTracklets, sourceSegments, sourceGaps, resourceInputs, inputSets
      };
    } catch (error) {
      if (open) await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}

function latestTimestamp(values: readonly unknown[], fallback: string): string {
  const timestamps = values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => isoTimestamp(value, "input created_at"))
    .sort();
  return timestamps.at(-1) ?? fallback;
}

export class PostgresHistoricalTrajectoryOutcomeRepository implements HistoricalTrajectoryOutcomeRepository {
  public constructor(
    private readonly pool: SqlPool,
    private readonly bounds: SqlExecutionBounds = {}
  ) {}

  public async record(
    request: HistoricalTrajectoryMaterializationRequest,
    semanticRequestHash: Sha256Digest,
    status: "NO_DATA" | "INDETERMINATE" | "PENDING",
    reasonCode: MaterializationOutcomeReason,
    diagnosticReasonCodes: readonly string[] = []
  ): Promise<HistoricalTrajectoryOutcomeRecord> {
    return withProjectionTransaction(
      this.pool,
      (connection) => this.recordInTransaction(
        connection,
        request,
        semanticRequestHash,
        status,
        reasonCode,
        diagnosticReasonCodes
      ),
      this.bounds
    );
  }

  public async recordInTransaction(
    connection: SqlConnection,
    request: HistoricalTrajectoryMaterializationRequest,
    semanticRequestHash: Sha256Digest,
    status: "NO_DATA" | "INDETERMINATE" | "PENDING",
    reasonCode: MaterializationOutcomeReason,
    diagnosticReasonCodes: readonly string[] = []
  ): Promise<HistoricalTrajectoryOutcomeRecord> {
    const reasonCodes = [...new Set([reasonCode, ...diagnosticReasonCodes])];
    const contentHash = canonicalSha256({
      dataScopeKey: request.dataScopeKey,
      semanticRequestHash,
      status,
      reasonCode,
      reasonCodes,
      evaluatedAsOf: isoTimestamp(request.capturedAt, "capturedAt")
    });
      await connection.query(`
        SELECT pg_advisory_xact_lock(hashtextextended(
          $1 || E'\\u001f' || $2 || E'\\u001f' || $3 || E'\\u001f' || $4 || E'\\u001f' || $5,
          0
        ))
      `, [
        request.dataScopeKey, request.query.subjectReferenceKey.id,
        request.query.executionIntervalReferenceKey.id,
        request.query.phaseScope, semanticRequestHash
      ]);
      const existing = await connection.query<Record<string, unknown>>(`
        SELECT outcome_id, analysis_id
        FROM gowm_history.historical_trajectory_outcome
        WHERE data_scope_key = $1 AND subject_reference_key = $2
          AND interval_reference_key = $3 AND phase_scope = $4
          AND semantic_request_hash = $5 AND content_hash = $6
      `, [
        request.dataScopeKey, request.query.subjectReferenceKey.id,
        request.query.executionIntervalReferenceKey.id, request.query.phaseScope,
        semanticRequestHash, contentHash
      ]);
      const prior = existing.rows[0];
      if (prior !== undefined) {
        return {
          outcomeId: requiredString(prior.outcome_id, "outcome_id"),
          analysisId: requiredString(prior.analysis_id, "analysis_id"),
          contentHash, reused: true
        };
      }
      const analysis = await connection.query<{ analysis_id: unknown }>(`
        INSERT INTO public.analysis_record(
          data_scope_key, service_name, tool_name, tool_version,
          algorithm, algorithm_version, status, analysis_as_of,
          query_payload, result_payload, method_snapshot, snapshot_hash
        ) VALUES (
          $1, 'gowm.historical-trace', 'history.get-trajectory', '1.0',
          'gap-preserving-historical-trajectory', '1.0', $2,
          $3::timestamptz, $4::jsonb, $5::jsonb, $6::jsonb, $7
        ) RETURNING analysis_id
      `, [
        request.dataScopeKey,
        status === "PENDING" ? "PARTIAL" : status,
        request.capturedAt,
        JSON.stringify(request.query),
        JSON.stringify({ status, reasonCode }),
        JSON.stringify({ semanticRequestHash }),
        contentHash
      ]);
      const analysisId = requiredString(analysis.rows[0]?.analysis_id, "analysis_id");
      const recorded = await connection.query<{ outcome_id: unknown }>(`
        SELECT gowm_history.record_historical_trajectory_outcome(
          $1::text, $2::text, $3::text, $4::text, $5::text,
          $6::text, $7::text, $8::text[], $9::boolean,
          $10::uuid, $11::timestamptz, $12::text
        ) AS outcome_id
      `, [
        request.dataScopeKey, request.query.subjectReferenceKey.id,
        request.query.executionIntervalReferenceKey.id, request.query.phaseScope,
        semanticRequestHash, status, reasonCode, reasonCodes,
        reasonCode === "PROJECTION_PENDING", analysisId, request.capturedAt, contentHash
      ]);
    return {
      outcomeId: requiredString(recorded.rows[0]?.outcome_id, "outcome_id"),
      analysisId, contentHash, reused: false
    };
  }
}

export interface PostgresHistoricalTrajectoryMaterializerDependencies {
  loader?: HistoricalTrajectoryMaterializationLoader;
  slicer?: TemporalTrajectorySlicer;
  trajectories?: HistoricalTrajectoryRepository;
  outcomes?: HistoricalTrajectoryOutcomeRepository;
  executionBounds?: SqlExecutionBounds;
}

export type HistoricalTrajectoryPreparedCommit =
  | {
      kind: "OUTCOME";
      request: HistoricalTrajectoryMaterializationRequest;
      semanticRequestHash: Sha256Digest;
      status: "NO_DATA" | "INDETERMINATE" | "PENDING";
      reasonCode: MaterializationOutcomeReason;
      diagnosticReasonCodes?: readonly string[];
    }
  | {
      kind: "REVISION";
      registration: HistoricalTrajectoryRegistration;
    };

export class PostgresHistoricalTrajectoryMaterializer {
  private readonly loader: HistoricalTrajectoryMaterializationLoader;
  private readonly slicer: TemporalTrajectorySlicer;
  private readonly trajectories: HistoricalTrajectoryRepository;
  private readonly outcomes: HistoricalTrajectoryOutcomeRepository;

  public constructor(pool: SqlPool, dependencies: PostgresHistoricalTrajectoryMaterializerDependencies = {}) {
    this.loader = dependencies.loader ?? new PostgresHistoricalTrajectoryInputLoader(pool,dependencies.executionBounds);
    this.slicer = dependencies.slicer ?? new PostgresMobilityDbTrajectorySlicer(pool,dependencies.executionBounds);
    this.trajectories = dependencies.trajectories
      ?? new PostgresHistoricalTrajectoryRepository(pool,dependencies.executionBounds);
    this.outcomes = dependencies.outcomes
      ?? new PostgresHistoricalTrajectoryOutcomeRepository(pool,dependencies.executionBounds);
  }

  public async materialize(
    request: HistoricalTrajectoryMaterializationRequest
  ): Promise<HistoricalTrajectoryMaterializationResult> {
    return this.commitPrepared(await this.prepareForCommit(request));
  }

  /**
   * Queue-only entry point. The caller owns the transaction and performs its
   * lease/generation completion CAS after this method returns. A stale CAS then
   * rolls back the analysis, revision/outcome, children, and mutable head.
   */
  public async materializeInTransaction(
    request: HistoricalTrajectoryMaterializationRequest,
    connection: SqlConnection
  ): Promise<HistoricalTrajectoryMaterializationResult> {
    return this.commitPrepared(await this.prepareForCommit(request), connection);
  }

  /** Performs only bounded, capturedAt reads/slicing and opens no write transaction. */
  public async prepareForCommit(
    request: HistoricalTrajectoryMaterializationRequest
  ): Promise<HistoricalTrajectoryPreparedCommit> {
    const loaded = await this.loader.load(request);
    if (loaded.kind === "OUTCOME") {
      return {
        kind: "OUTCOME", request, semanticRequestHash: loaded.semanticRequestHash,
        status: loaded.status, reasonCode: loaded.reasonCode,
        ...(loaded.diagnosticReasonCodes === undefined
          ? {}
          : { diagnosticReasonCodes: loaded.diagnosticReasonCodes })
      };
    }
    const prepared = await prepareHistoricalTrajectory({
      dataScopeKey: request.dataScopeKey,
      interval: loaded.interval.interval,
      intervalRevisionId: loaded.interval.intervalRevisionId,
      phaseScope: request.query.phaseScope,
      capturedAt: request.capturedAt,
      sourceSegments: loaded.sourceSegments,
      sourceGaps: loaded.sourceGaps,
      trackletFinalizationStates: loaded.selectedTracklets.map((tracklet) => tracklet.finalizationState)
    }, this.slicer);
    if (prepared.kind === "OUTCOME") {
      const mapped = preparationReason(prepared.outcome.status,prepared.outcome.reasonCode);
      return {
        kind: "OUTCOME", request, semanticRequestHash: loaded.semanticRequestHash,
        status: mapped.status, reasonCode: mapped.reasonCode,
        diagnosticReasonCodes: mapped.diagnosticReasonCodes
      };
    }
    const registration = {
      dataScopeKey: request.dataScopeKey,
      subjectReferenceKey: request.query.subjectReferenceKey.id,
      intervalId: loaded.interval.intervalId,
      intervalReferenceKey: loaded.interval.intervalReferenceKey,
      intervalRevisionId: loaded.interval.intervalRevisionId,
      phaseScope: request.query.phaseScope,
      sourceSelectionKind: request.query.sourceSelection.mode,
      selectedSourceKey: loaded.selectedSourceKey,
      selectedTrackerSessionKey: loaded.selectedTrackerSessionKey,
      analysisSpaceKey: loaded.analysisSpace.analysisSpaceKey,
      semanticRequestHash: loaded.semanticRequestHash,
      capturedAt: request.capturedAt,
      profileKey: loaded.profile.profileKey,
      profileVersion: loaded.profile.profileVersion,
      profileHash: loaded.profile.profileHash,
      revision: prepared.revision,
      resourceInputs: loaded.resourceInputs,
      inputSets: loaded.inputSets,
      queryPayload: { ...request.query },
      methodSnapshot: {
        algorithm: "gap-preserving-historical-trajectory",
        algorithmVersion: "1.0",
        profileKey: loaded.profile.profileKey,
        profileVersion: loaded.profile.profileVersion,
        profileHash: loaded.profile.profileHash,
        capturedAt: request.capturedAt
      }
    } satisfies Parameters<HistoricalTrajectoryRepository["registerAtomically"]>[0];
    return { kind: "REVISION", registration };
  }

  public async commitPreparedInTransaction(
    prepared: HistoricalTrajectoryPreparedCommit,
    connection: SqlConnection
  ): Promise<HistoricalTrajectoryMaterializationResult> {
    return this.commitPrepared(prepared, connection);
  }

  private async commitPrepared(
    prepared: HistoricalTrajectoryPreparedCommit,
    connection?: SqlConnection
  ): Promise<HistoricalTrajectoryMaterializationResult> {
    if (prepared.kind === "OUTCOME") {
      return {
        status: "OUTCOME", outcomeStatus: prepared.status, reasonCode: prepared.reasonCode,
        outcome: await this.recordOutcome(
          connection,
          prepared.request,
          prepared.semanticRequestHash,
          prepared.status,
          prepared.reasonCode,
          prepared.diagnosticReasonCodes
        )
      };
    }
    const committed = connection === undefined
      ? await this.trajectories.registerAtomically(prepared.registration)
      : await this.registerTrajectory(connection, prepared.registration);
    return { status: "MATERIALIZED", ...committed };
  }

  private async recordOutcome(
    connection: SqlConnection | undefined,
    request: HistoricalTrajectoryMaterializationRequest,
    semanticRequestHash: Sha256Digest,
    status: "NO_DATA" | "INDETERMINATE" | "PENDING",
    reasonCode: MaterializationOutcomeReason,
    diagnosticReasonCodes: readonly string[] | undefined
  ): Promise<HistoricalTrajectoryOutcomeRecord> {
    if (connection === undefined) {
      return this.outcomes.record(
        request, semanticRequestHash, status, reasonCode, diagnosticReasonCodes
      );
    }
    if (this.outcomes.recordInTransaction === undefined) {
      throw new HistoricalProjectionInputError(
        "queued historical materialization requires a transactional outcome repository"
      );
    }
    return this.outcomes.recordInTransaction(
      connection, request, semanticRequestHash, status, reasonCode, diagnosticReasonCodes
    );
  }

  private async registerTrajectory(
    connection: SqlConnection,
    registration: Parameters<HistoricalTrajectoryRepository["registerAtomically"]>[0]
  ): Promise<HistoricalTrajectoryCommitResult> {
    if (this.trajectories.registerInTransaction === undefined) {
      throw new HistoricalProjectionInputError(
        "queued historical materialization requires a transactional trajectory repository"
      );
    }
    return this.trajectories.registerInTransaction(connection, registration);
  }
}
