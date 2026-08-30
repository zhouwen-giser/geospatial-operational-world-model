import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../../packages/historical-trace-core/src/index.js";
import type {
  HistoricalSemanticRequest,
  ReconstructedTaskExecutionInterval
} from "../../packages/historical-trace-model/src/index.js";
import {
  PostgresHistoricalTrajectoryInputLoader,
  PostgresHistoricalTrajectoryMaterializer,
  type HistoricalTrajectoryLoadResult,
  type HistoricalTrajectoryMaterializationRequest,
  type HistoricalTrajectoryOutcomeRepository,
  type HistoricalTrajectoryRepository,
  type HistoricalSnapshotResource,
  type SqlConnection,
  type SqlPool,
  type TemporalTrajectorySlicer
} from "../../packages/historical-trace-runtime/src/index.js";

const HASH = canonicalSha256({ runtime: "materializer" });
const CAPTURED_AT = "2026-08-30T04:00:00.000Z";

function query(): HistoricalSemanticRequest {
  return {
    subjectReferenceKey: { namespace: "gowm", kind: "WORLD_OBJECT", id: "wrf_subject", version: "4" },
    executionIntervalReferenceKey: { namespace: "gowm", kind: "TASK_EXECUTION_INTERVAL", id: "wrf_interval", version: "1" },
    phaseScope: "EXECUTION_ENVELOPE",
    sourceSelection: { mode: "ONLY_CANDIDATE" },
    sourceSelectionProfileReferenceKey: {
      namespace: "gowm.history", kind: "HISTORY_METHOD_PROFILE",
      id: "trajectory-single-authoritative-v1", version: "1.0"
    },
    analysisSpaceReferenceKey: { namespace: "gowm", kind: "ANALYSIS_SPACE", id: "space-a", version: "1" }
  };
}

function request(): HistoricalTrajectoryMaterializationRequest {
  return { dataScopeKey: "scope-a", capturedAt: CAPTURED_AT, query: query() };
}

function requestWithPins(resources: HistoricalSnapshotResource[]): HistoricalTrajectoryMaterializationRequest {
  const canonical = {
    querySnapshotId: "snapshot-a",
    mode: "LATEST_AT_START" as const,
    consistency: "CONSISTENT_AT_START" as const,
    capturedAt: CAPTURED_AT,
    resources
  };
  return {
    ...request(),
    requestedSnapshot: { ...canonical, manifestHash: canonicalSha256(canonical) }
  };
}

function reconstructed(): ReconstructedTaskExecutionInterval {
  return {
    executionNo: 1, lifecycleState: "CLOSED", derivationKind: "OBSERVED", stabilityState: "SEALED",
    start: "2026-08-30T01:00:00.000Z", end: "2026-08-30T01:30:00.000Z",
    phases: [{
      phaseNo: 1, phaseKind: "RUNNING", start: "2026-08-30T01:00:00.000Z",
      end: "2026-08-30T01:30:00.000Z", reasonCodes: []
    }],
    reasonCodes: [], inputEvents: [], inputEventSetHash: HASH,
    contentHash: canonicalSha256({ interval: 1 })
  };
}

const dummyPool: SqlPool = {
  query: async () => ({ rows: [] }),
  connect: async () => { throw new Error("pool should not be used by injected ports"); }
};

describe("Postgres historical trajectory on-demand materializer", () => {
  it("passes only fixed loaded inputs through independent slicing and atomic registration", async () => {
    const loaded: HistoricalTrajectoryLoadResult = {
      kind: "READY", request: request(), semanticRequestHash: canonicalSha256({ semantic: 1 }),
      interval: {
        intervalId: "00000000-0000-4000-8000-000000000001",
        intervalReferenceKey: "wrf_interval",
        intervalRevisionId: "00000000-0000-4000-8000-000000000002",
        revisionNo: 1, worldVersion: 10, contentHash: HASH,
        inputEventSetHash: HASH, createdAt: "2026-08-30T02:00:00.000Z",
        interval: reconstructed()
      },
      profile: {
        profileKey: "trajectory-single-authoritative-v1", profileVersion: "1.0",
        profileHash: HASH, createdAt: "2026-08-30T00:00:00.000Z"
      },
      analysisSpace: {
        analysisSpaceKey: "space-a", version: "1", contentHash: HASH,
        createdAt: "2026-08-30T00:00:00.000Z"
      },
      selectedSourceKey: "source-a", selectedTrackerSessionKey: "session-a",
      selectedTracklets: [{
        candidate: {
          sourceKey: "source-a", trackerSessionKey: "session-a", trackletId: "tracklet-a",
          trackletVersionId: "00000000-0000-4000-8000-000000000010", versionNo: 1,
          createdAt: "2026-08-30T02:30:00.000Z", subjectReferenceIdentity: "gowm:WORLD_OBJECT:wrf_subject",
          analysisSpaceIdentity: "space-a",
          periods: [{ start: "2026-08-30T01:00:00.000Z", end: "2026-08-30T01:30:00.000Z", bounds: "[)" }]
        },
        contentHash: HASH,
        finalizationRevisionId: "00000000-0000-4000-8000-000000000011",
        finalizationRevisionNo: 1, finalizationState: "SEALED",
        finalizationHash: HASH, finalizationCreatedAt: "2026-08-30T03:00:00.000Z",
        watermarkSetHash: HASH
      }],
      sourceSegments: [{
        sourceTrackletVersionId: "00000000-0000-4000-8000-000000000010",
        sourceSegmentNo: 1, sampleCount: 3,
        period: { start: "2026-08-30T01:00:00.000Z", end: "2026-08-30T01:30:00.000Z", bounds: "[)" }
      }],
      sourceGaps: [],
      resourceInputs: [
        ["TASK_INTERVAL_REVISION", "TASK_EXECUTION_INTERVAL", "wrf_interval"],
        ["TRACKLET_VERSION", "TRACKLET_VERSION", "tracklet-v1"],
        ["TRACKLET_FINALIZATION_REVISION", "TRACKLET_FINALIZATION", "finalization-r1"],
        ["METHOD_PROFILE", "HISTORY_METHOD_PROFILE", "profile-v1"],
        ["ANALYSIS_SPACE", "ANALYSIS_SPACE", "space-a"]
      ].map(([inputKind, resourceKind, resourceId], index) => ({
        analysisInputNo: index + 1, inputRole: inputKind!, inputKind: inputKind!,
        resourceNamespace: "gowm.history", resourceKind: resourceKind!, resourceId: resourceId!,
        resourceVersion: "1", resourceContentHash: HASH, authority: "gowm.history",
        createdAt: "2026-08-30T03:00:00.000Z"
      })),
      inputSets: ["TASK_EVENT_SET", "TRACKLET_INPUT_SET", "TIME_SOLUTION_SET", "WATERMARK_SET"].map((kind) => ({
        inputSetKind: kind, itemCount: 1, itemSetDigest: HASH,
        authority: "gowm.history", createdAt: "2026-08-30T03:00:00.000Z"
      }))
    };
    let sliceCalls = 0;
    const slicer: TemporalTrajectorySlicer = {
      slice: async (input) => {
        sliceCalls += 1;
        return { trajectory: "Sequence-value", sampleCount: 3, startTime: input.period.start, endTime: input.period.end };
      }
    };
    let registered: Parameters<HistoricalTrajectoryRepository["registerAtomically"]>[0] | undefined;
    const trajectories: HistoricalTrajectoryRepository = {
      registerAtomically: async (input) => {
        registered = input;
        return {
          trajectoryRevisionId: "00000000-0000-4000-8000-000000000020",
          analysisId: "00000000-0000-4000-8000-000000000021",
          contentHash: HASH, reused: false
        };
      }
    };
    const outcomes: HistoricalTrajectoryOutcomeRepository = { record: async () => { throw new Error("not called"); } };
    const materializer = new PostgresHistoricalTrajectoryMaterializer(dummyPool, {
      loader: { load: async () => loaded }, slicer, trajectories, outcomes
    });

    expect(await materializer.materialize(request())).toMatchObject({ status: "MATERIALIZED", reused: false });
    expect(sliceCalls).toBe(1);
    expect(registered).toMatchObject({
      capturedAt: CAPTURED_AT,
      intervalRevisionId: "00000000-0000-4000-8000-000000000002",
      selectedSourceKey: "source-a",
      selectedTrackerSessionKey: "session-a"
    });
    expect(registered!.resourceInputs).toHaveLength(5);
    expect(registered!.inputSets).toHaveLength(4);
  });

  it("records an ambiguity/no-data outcome and never invokes slicing or trajectory registration", async () => {
    const loaded: HistoricalTrajectoryLoadResult = {
      kind: "OUTCOME", request: request(), semanticRequestHash: HASH,
      status: "INDETERMINATE", reasonCode: "SOURCE_SELECTION_REQUIRED"
    };
    let recorded = 0;
    const outcomes: HistoricalTrajectoryOutcomeRepository = {
      record: async () => {
        recorded += 1;
        return { outcomeId: "outcome-a", analysisId: "analysis-a", contentHash: HASH, reused: false };
      }
    };
    const materializer = new PostgresHistoricalTrajectoryMaterializer(dummyPool, {
      loader: { load: async () => loaded },
      slicer: { slice: async () => { throw new Error("not called"); } },
      trajectories: { registerAtomically: async () => { throw new Error("not called"); } },
      outcomes
    });

    expect(await materializer.materialize(request())).toMatchObject({
      status: "OUTCOME", outcomeStatus: "INDETERMINATE", reasonCode: "SOURCE_SELECTION_REQUIRED"
    });
    expect(recorded).toBe(1);
  });

  it("uses the caller transaction for queued outcome writes", async () => {
    const loaded: HistoricalTrajectoryLoadResult = {
      kind: "OUTCOME", request: request(), semanticRequestHash: HASH,
      status: "NO_DATA", reasonCode: "TRACKLET_NOT_FOUND"
    };
    let transactionalWrites = 0;
    const outcomes: HistoricalTrajectoryOutcomeRepository = {
      record: async () => { throw new Error("must not open an independent write transaction"); },
      recordInTransaction: async (connection) => {
        transactionalWrites += 1;
        await connection.query("INSERT QUEUED OUTCOME");
        return { outcomeId: "outcome-a", analysisId: "analysis-a", contentHash: HASH, reused: false };
      }
    };
    const calls: string[] = [];
    const connection: SqlConnection = {
      query: async (sql) => { calls.push(sql); return { rows: [] }; },
      release: () => undefined
    };
    const materializer = new PostgresHistoricalTrajectoryMaterializer(dummyPool, {
      loader: { load: async () => loaded },
      slicer: { slice: async () => { throw new Error("not called"); } },
      trajectories: { registerAtomically: async () => { throw new Error("not called"); } },
      outcomes
    });

    expect(await materializer.materializeInTransaction(request(), connection)).toMatchObject({
      status: "OUTCOME", outcomeStatus: "NO_DATA"
    });
    expect(transactionalWrites).toBe(1);
    expect(calls).toEqual(["INSERT QUEUED OUTCOME"]);
  });

  it("sets scope first and performs exact interval discovery without consulting a mutable head", async () => {
    const calls: string[] = [];
    const connection: SqlConnection = {
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        calls.push(sql);
        return { rows: [] as Row[] };
      },
      release: () => { calls.push("RELEASE"); }
    };
    const pool: SqlPool = { query: connection.query, connect: async () => connection };
    const result = await new PostgresHistoricalTrajectoryInputLoader(pool).load(request());

    expect(result).toMatchObject({ kind: "OUTCOME", status: "NO_DATA", reasonCode: "TASK_INTERVAL_UNAVAILABLE" });
    expect(calls[0]).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(calls[1]).toContain("set_config('statement_timeout'");
    expect(calls[2]).toContain("gowm_history_v1.set_data_scope");
    expect(calls[3]).toContain("interval.data_scope_key = $1");
    expect(calls[3]).toContain("revision.revision_no = $3::integer");
    expect(calls[3]).toContain("revision.created_at <= $4::timestamptz");
    expect(calls[3]).not.toContain("_head");
    expect(calls).toContain("COMMIT");
  });

  it("chooses the latest immutable tracklet version before applying overlap selection", async () => {
    const calls: string[] = [];
    const connection: SqlConnection = {
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        calls.push(sql);
        let rows: Record<string, unknown>[] = [];
        if (sql.includes("revision.revision_no = $3::integer")) rows = [{
          interval_id: "00000000-0000-4000-8000-000000000001",
          reference_key: "wrf_interval", execution_no: 1,
          interval_revision_id: "00000000-0000-4000-8000-000000000002",
          revision_no: 1, interval_start: "2026-08-30T01:00:00Z",
          interval_end: "2026-08-30T01:30:00Z", lifecycle_state: "CLOSED",
          derivation_kind: "OBSERVED_ONLY", stability_state: "SEALED",
          start_event_id: "event-1", terminal_event_id: "event-2",
          input_event_set_hash: HASH, confidence: 1, reason_codes: [],
          world_version: 10, content_hash: HASH, created_at: "2026-08-30T02:00:00Z"
        }];
        else if (sql.includes("FROM gowm_history.task_execution_phase")) rows = [{
          phase_no: 1, phase_kind: "RUNNING", phase_start: "2026-08-30T01:00:00Z",
          phase_end: "2026-08-30T01:30:00Z", start_event_id: "event-1",
          end_event_id: "event-2", confidence: 1, reason_codes: []
        }];
        else if (sql.includes("FROM gowm_history.task_execution_interval_input")) rows = [{
          event_id: "event-1", event_type: "EXECUTION_STARTED_OBSERVED",
          event_time: "2026-08-30T01:00:00Z", received_time: "2026-08-30T01:00:01Z",
          source_authority: "authority-a", source_event_key: "source-event-1",
          source_revision_no: 1, content_hash: HASH, confidence: 1
        }];
        else if (sql.includes("FROM gowm_history.method_profile")) rows = [{
          profile_key: "trajectory-single-authoritative-v1", profile_version: "1.0",
          content_hash: HASH, created_at: "2026-08-30T00:00:00Z"
        }];
        else if (sql.includes("FROM public.world_reference_identity")) rows = [{
          internal_id: "subject-internal", entity_kind: "WORLD_OBJECT"
        }];
        return { rows: rows as Row[] };
      },
      release: () => { calls.push("RELEASE"); }
    };
    const pool: SqlPool = { query: connection.query, connect: async () => connection };
    const result = await new PostgresHistoricalTrajectoryInputLoader(pool).load(request());

    expect(result).toMatchObject({ kind: "OUTCOME", status: "NO_DATA", reasonCode: "TRACKLET_NOT_FOUND" });
    const candidateSql = calls.find((sql) => sql.includes("WITH eligible AS"));
    expect(candidateSql).toContain("row_number() OVER");
    expect(candidateSql).toContain("PARTITION BY tracklet.tracklet_id");
    expect(candidateSql).toContain("version.created_at <= $3::timestamptz");
    expect(candidateSql).toContain("$4::uuid[] IS NULL AND tracklet.version_rank = 1");
    expect(candidateSql).toContain("pinned.tracklet_version_id = ANY($4::uuid[])");
    expect(candidateSql).not.toContain("_head");
  });

  it("restricts discovered tracklets/finalizations to exact provided snapshot pins", async () => {
    const trackletId = "00000000-0000-4000-8000-000000000010";
    const finalizationId = "00000000-0000-4000-8000-000000000011";
    const wrongFinalizationHash = canonicalSha256({ finalization: "wrong" });
    const pinnedRequest = requestWithPins([
      {
        resourceKind: "TASK_EXECUTION_INTERVAL", resourceId: "wrf_interval", version: "1",
        pinning: "PINNED", contentHash: canonicalSha256({ interval: 1 }), worldVersion: 10
      },
      {
        resourceKind: "HISTORY_METHOD_PROFILE", resourceId: "trajectory-single-authoritative-v1",
        version: "1.0", pinning: "PINNED", contentHash: HASH
      },
      {
        resourceKind: "TRACKLET_VERSION", resourceId: trackletId, version: "1",
        pinning: "PINNED", contentHash: HASH
      },
      {
        resourceKind: "TRACKLET_FINALIZATION", resourceId: finalizationId, version: "1",
        pinning: "PINNED", contentHash: wrongFinalizationHash
      }
    ]);
    let candidateValues: readonly unknown[] | undefined;
    let finalizationValues: readonly unknown[] | undefined;
    const connection: SqlConnection = {
      query: async <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        let rows: Record<string, unknown>[] = [];
        if (sql.includes("revision.revision_no = $3::integer")) rows = [{
          interval_id: "00000000-0000-4000-8000-000000000001",
          reference_key: "wrf_interval", execution_no: 1,
          interval_revision_id: "00000000-0000-4000-8000-000000000002",
          revision_no: 1, interval_start: "2026-08-30T01:00:00Z",
          interval_end: "2026-08-30T01:30:00Z", lifecycle_state: "CLOSED",
          derivation_kind: "OBSERVED_ONLY", stability_state: "SEALED",
          start_event_id: "event-1", terminal_event_id: "event-2",
          input_event_set_hash: HASH, confidence: 1, reason_codes: [],
          world_version: 10, content_hash: canonicalSha256({ interval: 1 }),
          created_at: "2026-08-30T02:00:00Z"
        }];
        else if (sql.includes("FROM gowm_history.task_execution_phase")) rows = [{
          phase_no: 1, phase_kind: "RUNNING", phase_start: "2026-08-30T01:00:00Z",
          phase_end: "2026-08-30T01:30:00Z", start_event_id: "event-1",
          end_event_id: "event-2", confidence: 1, reason_codes: []
        }];
        else if (sql.includes("FROM gowm_history.task_execution_interval_input")) rows = [{
          event_id: "event-1", event_type: "EXECUTION_STARTED_OBSERVED",
          event_time: "2026-08-30T01:00:00Z", received_time: "2026-08-30T01:00:01Z",
          source_authority: "authority-a", source_event_key: "source-event-1",
          source_revision_no: 1, content_hash: HASH, confidence: 1
        }];
        else if (sql.includes("FROM gowm_history.method_profile")) rows = [{
          profile_key: "trajectory-single-authoritative-v1", profile_version: "1.0",
          content_hash: HASH, created_at: "2026-08-30T00:00:00Z"
        }];
        else if (sql.includes("FROM public.world_reference_identity")) rows = [{
          internal_id: "subject-internal", entity_kind: "WORLD_OBJECT"
        }];
        else if (sql.includes("WITH eligible AS")) {
          candidateValues = values;
          rows = [{
            tracklet_id: "00000000-0000-4000-8000-000000000009",
            source_key: "source-a", tracker_session_key: "session-a", analysis_space_key: "space-a",
            tracklet_version_id: trackletId, version_no: 1,
            start_event_time: "2026-08-30T01:00:00Z", end_event_time: "2026-08-30T01:30:00Z",
            content_hash: HASH, created_at: "2026-08-30T02:30:00Z", binding_state: "VALID"
          }];
        } else if (sql.includes("FROM public.analysis_space")) rows = [{
          analysis_space_key: "space-a", canonical_srid: 3857, dimension_model: "XY",
          distance_model: "PLANAR", transform_pipeline_version: "1", created_at: "2026-08-30T00:00:00Z"
        }];
        else if (sql.includes("FROM unnest($1::uuid[])")) {
          finalizationValues = values;
          rows = [{
            tracklet_version_id: trackletId, finalization_revision_id: finalizationId,
            revision_no: 1, finalization_state: "SEALED", watermark_set_hash: HASH,
            content_hash: HASH, created_at: "2026-08-30T03:00:00Z"
          }];
        }
        return { rows: rows as Row[] };
      },
      release: () => undefined
    };
    const pool: SqlPool = { query: connection.query, connect: async () => connection };

    await expect(new PostgresHistoricalTrajectoryInputLoader(pool).load(pinnedRequest))
      .rejects.toThrow("tracklet finalization differs from its requestedSnapshot pin");
    expect(candidateValues?.[3]).toEqual([trackletId]);
    expect(finalizationValues?.[3]).toEqual([finalizationId]);
  });

  it("preserves the exact core conflict reason in persisted outcome evidence", async () => {
    const conflicted = reconstructed();
    conflicted.lifecycleState = "CONFLICTED";
    conflicted.stabilityState = "CONFLICTED";
    const loaded: HistoricalTrajectoryLoadResult = {
      kind: "READY", request: request(), semanticRequestHash: HASH,
      interval: {
        intervalId: "00000000-0000-4000-8000-000000000001",
        intervalReferenceKey: "wrf_interval",
        intervalRevisionId: "00000000-0000-4000-8000-000000000002",
        revisionNo: 1, worldVersion: 10, contentHash: HASH,
        inputEventSetHash: HASH, createdAt: "2026-08-30T02:00:00Z",
        interval: conflicted
      },
      profile: {
        profileKey: "trajectory-single-authoritative-v1", profileVersion: "1.0",
        profileHash: HASH, createdAt: "2026-08-30T00:00:00Z"
      },
      analysisSpace: {
        analysisSpaceKey: "space-a", version: "1", contentHash: HASH,
        createdAt: "2026-08-30T00:00:00Z"
      },
      selectedSourceKey: "source-a", selectedTrackerSessionKey: "session-a",
      selectedTracklets: [{
        candidate: {
          sourceKey: "source-a", trackerSessionKey: "session-a", trackletId: "tracklet-a",
          trackletVersionId: "00000000-0000-4000-8000-000000000010", versionNo: 1,
          createdAt: "2026-08-30T02:30:00Z",
          subjectReferenceIdentity: "gowm:WORLD_OBJECT:wrf_subject", analysisSpaceIdentity: "space-a",
          periods: [{ start: "2026-08-30T01:00:00Z", end: "2026-08-30T01:30:00Z", bounds: "[)" }]
        },
        contentHash: HASH,
        finalizationRevisionId: "00000000-0000-4000-8000-000000000011",
        finalizationRevisionNo: 1, finalizationState: "SEALED",
        finalizationHash: HASH, finalizationCreatedAt: "2026-08-30T03:00:00Z",
        watermarkSetHash: HASH
      }],
      sourceSegments: [{
        sourceTrackletVersionId: "00000000-0000-4000-8000-000000000010",
        sourceSegmentNo: 1, sampleCount: 2,
        period: { start: "2026-08-30T01:00:00Z", end: "2026-08-30T01:30:00Z", bounds: "[)" }
      }],
      sourceGaps: [], resourceInputs: [], inputSets: []
    };
    let diagnostics: readonly string[] | undefined;
    const outcomes: HistoricalTrajectoryOutcomeRepository = {
      record: async (_request, _hash, _status, _reason, reasonCodes) => {
        diagnostics = reasonCodes;
        return { outcomeId: "outcome-a", analysisId: "analysis-a", contentHash: HASH, reused: false };
      }
    };
    const materializer = new PostgresHistoricalTrajectoryMaterializer(dummyPool, {
      loader: { load: async () => loaded },
      slicer: {
        slice: async (sliceRequest) => ({
          trajectory: "Sequence-conflicted",
          sampleCount: 2,
          startTime: sliceRequest.period.start,
          endTime: sliceRequest.period.end
        })
      },
      trajectories: { registerAtomically: async () => { throw new Error("not called"); } },
      outcomes
    });

    expect(await materializer.materialize(request())).toMatchObject({
      status: "OUTCOME", outcomeStatus: "INDETERMINATE", reasonCode: "TASK_INTERVAL_UNAVAILABLE"
    });
    expect(diagnostics).toEqual(["TASK_INTERVAL_CONFLICT"]);
  });
});
