import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../../packages/historical-trace-core/src/index.js";
import type {
  ReconstructedTaskExecutionInterval,
  TimePeriod
} from "../../packages/historical-trace-model/src/index.js";
import {
  HistoricalProjectionInputError,
  PostgresHistoricalTrajectoryRepository,
  PostgresMobilityDbTrajectorySlicer,
  prepareHistoricalTrajectory,
  type HistoricalInputSet,
  type HistoricalResourceInput,
  type HistoricalTrajectoryRegistration,
  type SqlConnection,
  type SqlPool,
  type TemporalTrajectorySlicer
} from "../../packages/historical-trace-runtime/src/index.js";

const CAPTURED_AT = "2026-08-30T02:00:00.000Z";
const HASH = canonicalSha256({ stable: true });

function period(start: string, end: string): TimePeriod {
  return { start, end, bounds: "[)" };
}

function interval(): ReconstructedTaskExecutionInterval {
  return {
    executionNo: 1,
    lifecycleState: "CLOSED",
    derivationKind: "OBSERVED",
    stabilityState: "SEALED",
    start: "2026-08-30T01:00:00.000Z",
    end: "2026-08-30T01:30:00.000Z",
    phases: [
      { phaseNo: 1, phaseKind: "RUNNING", start: "2026-08-30T01:00:00.000Z", end: "2026-08-30T01:10:00.000Z", reasonCodes: [] },
      { phaseNo: 2, phaseKind: "PAUSED", start: "2026-08-30T01:10:00.000Z", end: "2026-08-30T01:20:00.000Z", reasonCodes: [] },
      { phaseNo: 3, phaseKind: "RUNNING", start: "2026-08-30T01:20:00.000Z", end: "2026-08-30T01:30:00.000Z", reasonCodes: [] }
    ],
    reasonCodes: [],
    inputEvents: [],
    inputEventSetHash: HASH,
    contentHash: canonicalSha256({ interval: 1 })
  };
}

const slicer: TemporalTrajectorySlicer = {
  slice: async (request) => ({
    trajectory: `Sequence-${request.sequenceNo}`,
    sampleCount: 2,
    startTime: request.period.start,
    endTime: request.period.end
  })
};

function resources(createdAt = "2026-08-30T01:50:00.000Z"): HistoricalResourceInput[] {
  return [
    ["TASK_INTERVAL_REVISION", "TASK_EXECUTION_INTERVAL", "interval-r1", "1"],
    ["TRACKLET_VERSION", "TRACKLET_VERSION", "tracklet-v1", "1"],
    ["TRACKLET_FINALIZATION_REVISION", "TRACKLET_FINALIZATION", "finalization-r1", "1"],
    ["METHOD_PROFILE", "HISTORY_METHOD_PROFILE", "trajectory-single-authoritative-v1", "1.0"],
    ["ANALYSIS_SPACE", "ANALYSIS_SPACE", "analysis-space-a", "1"]
  ].map(([inputKind, resourceKind, resourceId, resourceVersion], index) => ({
    analysisInputNo: index + 1,
    inputRole: inputKind!,
    inputKind: inputKind!,
    resourceNamespace: "gowm",
    resourceKind: resourceKind!,
    resourceId: resourceId!,
    resourceVersion: resourceVersion!,
    resourceContentHash: HASH,
    authority: "gowm.history",
    createdAt
  }));
}

function inputSets(): HistoricalInputSet[] {
  return ["TASK_EVENT_SET", "TRACKLET_INPUT_SET", "TIME_SOLUTION_SET", "WATERMARK_SET"].map((kind) => ({
    inputSetKind: kind,
    itemCount: 1,
    itemSetDigest: HASH,
    authority: "gowm.history",
    createdAt: "2026-08-30T01:50:00.000Z"
  }));
}

function registration(
  revision: Extract<Awaited<ReturnType<typeof prepareHistoricalTrajectory>>, { kind: "REVISION" }>["revision"]
): HistoricalTrajectoryRegistration {
  return {
    dataScopeKey: "scope-a",
    subjectReferenceKey: "subject-reference-a",
    intervalId: "00000000-0000-4000-8000-000000000010",
    intervalReferenceKey: "interval-reference-a",
    intervalRevisionId: "00000000-0000-4000-8000-000000000011",
    phaseScope: "ACTIVE_PHASES_ONLY",
    sourceSelectionKind: "ONLY_CANDIDATE",
    selectedSourceKey: "source-a",
    selectedTrackerSessionKey: "session-a",
    analysisSpaceKey: "analysis-space-a",
    semanticRequestHash: canonicalSha256({ semantic: "history-a" }),
    capturedAt: CAPTURED_AT,
    profileKey: "trajectory-single-authoritative-v1",
    profileVersion: "1.0",
    profileHash: HASH,
    revision,
    resourceInputs: resources(),
    inputSets: inputSets(),
    queryPayload: { phaseScope: "ACTIVE_PHASES_ONLY" },
    methodSnapshot: { algorithm: "gap-preserving-historical-trajectory" }
  };
}

describe("historical trajectory runtime", () => {
  it("keeps ACTIVE paused time excluded and materializes every source/request slice independently", async () => {
    const prepared = await prepareHistoricalTrajectory({
      dataScopeKey: "scope-a",
      interval: interval(),
      intervalRevisionId: "interval-r1",
      phaseScope: "ACTIVE_PHASES_ONLY",
      capturedAt: CAPTURED_AT,
      sourceSegments: [
        { sourceTrackletVersionId: "tracklet-v1", sourceSegmentNo: 1, period: period("2026-08-30T01:00:00Z", "2026-08-30T01:05:00Z"), sampleCount: 2 },
        { sourceTrackletVersionId: "tracklet-v1", sourceSegmentNo: 2, period: period("2026-08-30T01:07:00Z", "2026-08-30T01:30:00Z"), sampleCount: 5 }
      ],
      sourceGaps: [{
        reason: "TRACKLET_BOUNDARY_GAP",
        range: period("2026-08-30T01:05:00Z", "2026-08-30T01:07:00Z"),
        sourceTrackletVersionId: "tracklet-v1",
        sourceTrackletGapNo: 1
      }],
      trackletFinalizationStates: ["SEALED"]
    }, slicer);

    expect(prepared.kind).toBe("REVISION");
    if (prepared.kind !== "REVISION") throw new Error("revision expected");
    expect(prepared.revision.segments.map((value) => [value.sourceSegmentNo, value.phaseNo, value.trajectory])).toEqual([
      [1, 1, "Sequence-1"],
      [2, 1, "Sequence-2"],
      [2, 3, "Sequence-3"]
    ]);
    expect(prepared.revision.excludedPeriods).toEqual([{
      excludedNo: 1,
      exclusionKind: "EXCLUDED_PAUSED_PHASE",
      excludedTime: period("2026-08-30T01:10:00.000Z", "2026-08-30T01:20:00.000Z"),
      phaseNo: 2
    }]);
    expect(prepared.revision.gaps).toHaveLength(1);
    expect(prepared.revision.gaps[0]).toMatchObject({ gapKind: "TRACKLET_BOUNDARY_GAP" });
    expect(prepared.revision.finalizationState).toBe("SEALED");
    expect(prepared.revision.outcome).toMatchObject({ status: "PARTIAL", reasonCode: "UNKNOWN_GAPS_PRESENT" });
  });

  it("fails closed instead of publishing a conflicted or empty trajectory", async () => {
    const conflicted = interval();
    conflicted.lifecycleState = "CONFLICTED";
    conflicted.stabilityState = "CONFLICTED";
    const prepared = await prepareHistoricalTrajectory({
      dataScopeKey: "scope-a",
      interval: conflicted,
      intervalRevisionId: "interval-r1",
      phaseScope: "EXECUTION_ENVELOPE",
      capturedAt: CAPTURED_AT,
      sourceSegments: [{
        sourceTrackletVersionId: "tracklet-v1", sourceSegmentNo: 1,
        period: period("2026-08-30T01:00:00Z", "2026-08-30T01:30:00Z"), sampleCount: 3
      }],
      sourceGaps: [],
      trackletFinalizationStates: ["SEALED"]
    }, slicer);

    expect(prepared).toMatchObject({
      kind: "OUTCOME",
      outcome: { status: "INDETERMINATE", reasonCode: "TASK_INTERVAL_CONFLICT" }
    });
  });

  it("records an explicit unknown gap when a fixed source slice cannot be materialized", async () => {
    const prepared = await prepareHistoricalTrajectory({
      dataScopeKey: "scope-a", interval: interval(), intervalRevisionId: "interval-r1",
      phaseScope: "EXECUTION_ENVELOPE", capturedAt: CAPTURED_AT,
      sourceSegments: [
        {
          sourceTrackletVersionId: "tracklet-v1", sourceSegmentNo: 1,
          period: period("2026-08-30T01:00:00Z", "2026-08-30T01:10:00Z"), sampleCount: 2
        },
        {
          sourceTrackletVersionId: "tracklet-v1", sourceSegmentNo: 2,
          period: period("2026-08-30T01:10:00Z", "2026-08-30T01:30:00Z"), sampleCount: 2
        }
      ],
      sourceGaps: [], trackletFinalizationStates: ["SEALED"]
    }, {
      slice: async (request) => request.sourceSegmentNo === 2
        ? undefined
        : {
            trajectory: "Sequence-available", sampleCount: 2,
            startTime: request.period.start, endTime: request.period.end
          }
    });

    expect(prepared.kind).toBe("REVISION");
    if (prepared.kind !== "REVISION") throw new Error("revision expected");
    expect(prepared.revision.gaps).toEqual([expect.objectContaining({
      gapKind: "UNKNOWN_INPUT_GAP",
      sourceTrackletVersionId: "tracklet-v1",
      reasonCodes: ["UNKNOWN_INPUT_GAP", "SOURCE_SLICE_UNAVAILABLE"]
    })]);
    expect(prepared.revision.outcome).toMatchObject({ status: "PARTIAL", reasonCode: "UNKNOWN_GAPS_PRESENT" });
  });

  it("bounds and scopes every MobilityDB slice in its own read-only repeatable-read transaction", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const connection: SqlConnection = {
      query: async <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, ...(values === undefined ? {} : { values }) });
        return {
          rows: (sql.includes("WITH source AS")
            ? [{
                trajectory: "Sequence-slice", sample_count: "2",
                start_time: "2026-08-30T01:00:00Z", end_time: "2026-08-30T01:10:00Z"
              }]
            : []) as unknown as Row[]
        };
      },
      release: () => { calls.push({ sql: "RELEASE" }); }
    };
    const pool: SqlPool = { query: connection.query, connect: async () => connection };
    const result = await new PostgresMobilityDbTrajectorySlicer(pool,{
      statementTimeoutMs: 2_000,
      lockTimeoutMs: 500
    }).slice({
      dataScopeKey: "scope-a",
      sourceTrackletVersionId: "00000000-0000-4000-8000-000000000010",
      sourceSegmentNo: 1,
      period: period("2026-08-30T01:00:00Z", "2026-08-30T01:10:00Z"),
      sequenceNo: 1,
      requestedPeriodNo: 1
    });

    expect(result).toMatchObject({ trajectory: "Sequence-slice", sampleCount: 2 });
    expect(calls.map((call) => call.sql)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT set_config('statement_timeout',$1::text,true), set_config('lock_timeout',$2::text,true)",
      "SELECT gowm_history_v1.set_data_scope($1::text)",
      expect.stringContaining("atTime(segment.trajectory, $4::tstzspan)"),
      "COMMIT",
      "RELEASE"
    ]);
    expect(calls[1]!.values).toEqual(["2000ms", "500ms"]);
    expect(calls[2]!.values).toEqual(["scope-a"]);
  });

  it("commits analysis, exact inputs, revision, and head through one stored-function transaction", async () => {
    const prepared = await prepareHistoricalTrajectory({
      dataScopeKey: "scope-a", interval: interval(), intervalRevisionId: "interval-r1",
      phaseScope: "ACTIVE_PHASES_ONLY", capturedAt: CAPTURED_AT,
      sourceSegments: [{
        sourceTrackletVersionId: "tracklet-v1", sourceSegmentNo: 1,
        period: period("2026-08-30T01:00:00Z", "2026-08-30T01:30:00Z"), sampleCount: 4
      }],
      sourceGaps: [], trackletFinalizationStates: ["SEALED"]
    }, slicer);
    if (prepared.kind !== "REVISION") throw new Error("revision expected");
    prepared.revision.gaps = [{
      gapNo: 1,
      gapKind: "UNKNOWN_INPUT_GAP",
      gapTime: period("2026-08-30T01:05:00Z", "2026-08-30T01:06:00Z"),
      reasonCodes: ["UNKNOWN_INPUT_GAP"]
    }];
    const calls: string[] = [];
    let registeredArguments: readonly unknown[] | undefined;
    let inputHashArguments: readonly unknown[] | undefined;
    const query: SqlConnection["query"] = async <Row extends Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[]
    ) => {
      calls.push(sql);
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("range_agg")) rows = [{ value: "{[2026-08-30 01:00:00+00,2026-08-30 01:30:00+00)}" }];
      else if (sql.includes("tgeompointSeqSet")) rows = [{ trajectory: "SequenceSet-value", extent_box: "STBOX-value" }];
      else if (sql.includes("AS input_set_hash")) {
        inputHashArguments = values;
        rows = [{ input_set_hash: HASH }];
      }
      else if (sql.includes("INSERT INTO public.analysis_record")) rows = [{ analysis_id: "00000000-0000-4000-8000-000000000020" }];
      else if (sql.includes("register_historical_trajectory_revision")) {
        registeredArguments = values;
        rows = [{ revision_id: "00000000-0000-4000-8000-000000000021" }];
      }
      return { rows: rows as Row[] };
    };
    const connection: SqlConnection = { query, release: () => { calls.push("RELEASE"); } };
    const pool: SqlPool = { query, connect: async () => connection };
    const result = await new PostgresHistoricalTrajectoryRepository(pool).registerAtomically(registration(prepared.revision));

    expect(result).toMatchObject({
      trajectoryRevisionId: "00000000-0000-4000-8000-000000000021",
      analysisId: "00000000-0000-4000-8000-000000000020",
      reused: false
    });
    const begin = calls.indexOf("BEGIN");
    const analysis = calls.findIndex((sql) => sql.includes("INSERT INTO public.analysis_record"));
    const revision = calls.findIndex((sql) => sql.includes("register_historical_trajectory_revision"));
    const commit = calls.indexOf("COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(analysis).toBeGreaterThan(begin);
    expect(revision).toBeGreaterThan(analysis);
    expect(commit).toBeGreaterThan(revision);
    expect(calls).not.toContain("ROLLBACK");
    expect(JSON.parse(String(registeredArguments![31]))).toEqual([expect.objectContaining({
      gapTime: "[2026-08-30T01:05:00.000Z,2026-08-30T01:06:00.000Z)"
    })]);
    expect(JSON.parse(String(registeredArguments![32]))).toEqual([expect.objectContaining({
      excludedTime: "[2026-08-30T01:10:00.000Z,2026-08-30T01:20:00.000Z)"
    })]);
    expect(JSON.parse(String(inputHashArguments![0]))[0]).not.toHaveProperty("createdAt");
    expect(JSON.parse(String(inputHashArguments![1]))[0]).not.toHaveProperty("createdAt");
  });

  it("refuses to create an absent older revision behind a newer trajectory head", async () => {
    const prepared = await prepareHistoricalTrajectory({
      dataScopeKey: "scope-a", interval: interval(), intervalRevisionId: "interval-r1",
      phaseScope: "ACTIVE_PHASES_ONLY", capturedAt: CAPTURED_AT,
      sourceSegments: [{
        sourceTrackletVersionId: "tracklet-v1", sourceSegmentNo: 1,
        period: period("2026-08-30T01:00:00Z", "2026-08-30T01:30:00Z"), sampleCount: 4
      }],
      sourceGaps: [], trackletFinalizationStates: ["SEALED"]
    }, slicer);
    if (prepared.kind !== "REVISION") throw new Error("revision expected");
    const calls: string[] = [];
    const query: SqlConnection["query"] = async <Row extends Record<string, unknown>>(sql: string) => {
      calls.push(sql);
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("range_agg")) rows = [{ value: "{[2026-08-30 01:00:00+00,2026-08-30 01:30:00+00)}" }];
      else if (sql.includes("tgeompointSeqSet")) rows = [{ trajectory: "SequenceSet-value", extent_box: "STBOX-value" }];
      else if (sql.includes("AS input_set_hash")) rows = [{ input_set_hash: HASH }];
      else if (sql.includes("historical_trajectory_head")) rows = [{
        trajectory_revision_id: "00000000-0000-4000-8000-000000000030",
        analysis_id: "00000000-0000-4000-8000-000000000031",
        interval_revision_id: "00000000-0000-4000-8000-000000000032",
        interval_revision_no: 2,
        analysis_as_of: "2026-08-30T03:00:00.000Z"
      }];
      return { rows: rows as Row[] };
    };
    const connection: SqlConnection = { query, release: () => { calls.push("RELEASE"); } };
    const pool: SqlPool = { query, connect: async () => connection };

    await expect(new PostgresHistoricalTrajectoryRepository(pool).registerAtomically(registration(prepared.revision)))
      .rejects.toThrow("cannot retrogress the head");
    expect(calls.some((sql) => sql.includes("INSERT INTO public.analysis_record"))).toBe(false);
    expect(calls).toContain("ROLLBACK");
  });

  it("reuses exact old content without consulting or moving the newer head", async () => {
    const prepared = await prepareHistoricalTrajectory({
      dataScopeKey: "scope-a", interval: interval(), intervalRevisionId: "interval-r1",
      phaseScope: "ACTIVE_PHASES_ONLY", capturedAt: CAPTURED_AT,
      sourceSegments: [{
        sourceTrackletVersionId: "tracklet-v1", sourceSegmentNo: 1,
        period: period("2026-08-30T01:00:00Z", "2026-08-30T01:30:00Z"), sampleCount: 4
      }],
      sourceGaps: [], trackletFinalizationStates: ["SEALED"]
    }, slicer);
    if (prepared.kind !== "REVISION") throw new Error("revision expected");
    const calls: string[] = [];
    const query: SqlConnection["query"] = async <Row extends Record<string, unknown>>(sql: string) => {
      calls.push(sql);
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("range_agg")) rows = [{ value: "{[2026-08-30 01:00:00+00,2026-08-30 01:30:00+00)}" }];
      else if (sql.includes("tgeompointSeqSet")) rows = [{ trajectory: "SequenceSet-value", extent_box: "STBOX-value" }];
      else if (sql.includes("AS input_set_hash")) rows = [{ input_set_hash: HASH }];
      else if (sql.includes("revision.content_hash = $6")) rows = [{
        trajectory_revision_id: "00000000-0000-4000-8000-000000000040",
        analysis_id: "00000000-0000-4000-8000-000000000041"
      }];
      return { rows: rows as Row[] };
    };
    const connection: SqlConnection = { query, release: () => { calls.push("RELEASE"); } };
    const pool: SqlPool = { query, connect: async () => connection };

    await expect(new PostgresHistoricalTrajectoryRepository(pool).registerAtomically(registration(prepared.revision)))
      .resolves.toMatchObject({
        trajectoryRevisionId: "00000000-0000-4000-8000-000000000040",
        analysisId: "00000000-0000-4000-8000-000000000041",
        reused: true
      });
    expect(calls.some((sql) => sql.includes("historical_trajectory_head"))).toBe(false);
    expect(calls.some((sql) => sql.includes("INSERT INTO public.analysis_record"))).toBe(false);
    expect(calls).toContain("COMMIT");
  });

  it("rejects post-capturedAt lineage before any database write", async () => {
    const prepared = await prepareHistoricalTrajectory({
      dataScopeKey: "scope-a", interval: interval(), intervalRevisionId: "interval-r1",
      phaseScope: "EXECUTION_ENVELOPE", capturedAt: CAPTURED_AT,
      sourceSegments: [{ sourceTrackletVersionId: "tracklet-v1", sourceSegmentNo: 1, period: period("2026-08-30T01:00:00Z", "2026-08-30T01:30:00Z"), sampleCount: 4 }],
      sourceGaps: [], trackletFinalizationStates: ["SEALED"]
    }, slicer);
    if (prepared.kind !== "REVISION") throw new Error("revision expected");
    const value = registration(prepared.revision);
    value.resourceInputs = resources("2026-08-30T03:00:00.000Z");
    let queried = false;
    const pool: SqlPool = {
      query: async () => { queried = true; return { rows: [] }; },
      connect: async () => { throw new Error("must not connect"); }
    };

    await expect(new PostgresHistoricalTrajectoryRepository(pool).registerAtomically(value))
      .rejects.toBeInstanceOf(HistoricalProjectionInputError);
    expect(queried).toBe(false);
  });

  it("rejects empty required input sets before any database query", async () => {
    const prepared = await prepareHistoricalTrajectory({
      dataScopeKey: "scope-a", interval: interval(), intervalRevisionId: "interval-r1",
      phaseScope: "EXECUTION_ENVELOPE", capturedAt: CAPTURED_AT,
      sourceSegments: [{
        sourceTrackletVersionId: "tracklet-v1", sourceSegmentNo: 1,
        period: period("2026-08-30T01:00:00Z", "2026-08-30T01:30:00Z"), sampleCount: 4
      }],
      sourceGaps: [], trackletFinalizationStates: ["SEALED"]
    }, slicer);
    if (prepared.kind !== "REVISION") throw new Error("revision expected");
    const value = registration(prepared.revision);
    value.inputSets[1]!.itemCount = 0;
    let queried = false;
    const pool: SqlPool = {
      query: async () => { queried = true; return { rows: [] }; },
      connect: async () => { throw new Error("must not connect"); }
    };

    await expect(new PostgresHistoricalTrajectoryRepository(pool).registerAtomically(value))
      .rejects.toThrow("must contain at least one pinned member");
    expect(queried).toBe(false);
  });
});
