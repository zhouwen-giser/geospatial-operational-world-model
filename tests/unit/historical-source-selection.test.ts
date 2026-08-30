import { describe, expect, it } from "vitest";
import type {
  HistoricalSourceSelectionRequest,
  HistoricalTrackletCandidate,
  TimePeriod
} from "../../packages/historical-trace-model/src/index.js";
import { selectHistoricalSource } from "../../packages/historical-trace-core/src/index.js";

function period(start: string, end: string): TimePeriod {
  return { start, end, bounds: "[)" };
}

function candidate(overrides: Partial<HistoricalTrackletCandidate> = {}): HistoricalTrackletCandidate {
  return {
    sourceKey: "source-a",
    trackerSessionKey: "session-a",
    trackletId: "tracklet-a",
    trackletVersionId: "tracklet-a-v1",
    versionNo: 1,
    createdAt: "2026-08-30T02:00:00Z",
    subjectReferenceIdentity: "gowm:WORLD_OBJECT:vehicle-2",
    analysisSpaceIdentity: "gowm:SPATIAL_OBJECT:analysis-space-a",
    periods: [period("2026-08-30T01:00:00Z", "2026-08-30T01:30:00Z")],
    bindingState: "VALID",
    ...overrides
  };
}

function request(overrides: Partial<HistoricalSourceSelectionRequest> = {}): HistoricalSourceSelectionRequest {
  return {
    selection: { mode: "ONLY_CANDIDATE" },
    capturedAt: "2026-08-30T03:00:00Z",
    subjectReferenceIdentity: "gowm:WORLD_OBJECT:vehicle-2",
    analysisSpaceIdentity: "gowm:SPATIAL_OBJECT:analysis-space-a",
    requestedPeriods: [period("2026-08-30T01:00:00Z", "2026-08-30T01:30:00Z")],
    ...overrides
  };
}

describe("historical single-authoritative source selection", () => {
  it("selects exactly one ONLY_CANDIDATE source/session", () => {
    expect(selectHistoricalSource([candidate()], request())).toMatchObject({
      status: "SELECTED",
      sourceKey: "source-a",
      trackerSessionKey: "session-a",
      candidates: [{ trackletVersionId: "tracklet-a-v1" }]
    });
  });

  it("filters EXPLICIT_SOURCE by source and optional tracker session", () => {
    const selected = selectHistoricalSource([
      candidate(),
      candidate({ sourceKey: "source-b", trackerSessionKey: "session-b", trackletId: "tracklet-b", trackletVersionId: "tracklet-b-v1" })
    ], request({ selection: { mode: "EXPLICIT_SOURCE", sourceKey: "source-b", trackerSessionKey: "session-b" } }));

    expect(selected).toMatchObject({ status: "SELECTED", sourceKey: "source-b", trackerSessionKey: "session-b" });
  });

  it("fails closed when multiple sources are candidates", () => {
    const selected = selectHistoricalSource([
      candidate(),
      candidate({ sourceKey: "source-b", trackerSessionKey: "session-b", trackletId: "tracklet-b", trackletVersionId: "tracklet-b-v1" })
    ], request());

    expect(selected).toMatchObject({ status: "INDETERMINATE", reasonCode: "MULTIPLE_SOURCE_CANDIDATES" });
  });

  it("fails closed when multiple tracker sessions are candidates", () => {
    const selected = selectHistoricalSource([
      candidate(),
      candidate({ trackerSessionKey: "session-b", trackletId: "tracklet-b", trackletVersionId: "tracklet-b-v1" })
    ], request());

    expect(selected).toMatchObject({ status: "INDETERMINATE", reasonCode: "MULTIPLE_TRACKER_SESSIONS" });
  });

  it("chooses a unique latest immutable version and rejects an unresolved version tie", () => {
    const versionTwo = candidate({ trackletVersionId: "tracklet-a-v2", versionNo: 2, createdAt: "2026-08-30T02:30:00Z" });
    const selected = selectHistoricalSource([candidate(), versionTwo], request());
    expect(selected).toMatchObject({ status: "SELECTED", candidates: [{ trackletVersionId: "tracklet-a-v2", versionNo: 2 }] });

    const tied = selectHistoricalSource([
      versionTwo,
      candidate({ trackletVersionId: "tracklet-a-v2-conflict", versionNo: 2, createdAt: "2026-08-30T02:31:00Z" })
    ], request());
    expect(tied).toMatchObject({ status: "INDETERMINATE", reasonCode: "MULTIPLE_TRACKLET_VERSIONS" });
  });

  it("enforces capturedAt and cannot see later versions", () => {
    const future = candidate({ trackletVersionId: "tracklet-a-v2", versionNo: 2, createdAt: "2026-08-30T03:00:00.001Z" });
    const selected = selectHistoricalSource([candidate(), future], request({ capturedAt: "2026-08-30T03:00:00Z" }));

    expect(selected).toMatchObject({ status: "SELECTED", candidates: [{ trackletVersionId: "tracklet-a-v1" }] });
    expect(selectHistoricalSource([future], request({ capturedAt: "2026-08-30T03:00:00Z" }))).toMatchObject({
      status: "NO_DATA", reasonCode: "NO_SOURCE_CANDIDATE"
    });
  });

  it("rejects binding and analysis-space ambiguity", () => {
    expect(selectHistoricalSource([
      candidate({ bindingState: "CONFLICTED" })
    ], request())).toMatchObject({ status: "INDETERMINATE", reasonCode: "ENTITY_BINDING_CONFLICT" });

    const requestWithoutAnalysisSpace = request();
    delete requestWithoutAnalysisSpace.analysisSpaceIdentity;
    expect(selectHistoricalSource([
      candidate(),
      candidate({ analysisSpaceIdentity: "gowm:SPATIAL_OBJECT:analysis-space-b", trackletId: "tracklet-b", trackletVersionId: "tracklet-b-v1" })
    ], requestWithoutAnalysisSpace)).toMatchObject({
      status: "INDETERMINATE", reasonCode: "ANALYSIS_SPACE_CONFLICT"
    });
  });

  it("does not auto-fuse overlapping logical tracklets from one source/session", () => {
    const selected = selectHistoricalSource([
      candidate(),
      candidate({ trackletId: "tracklet-b", trackletVersionId: "tracklet-b-v1" })
    ], request());

    expect(selected).toMatchObject({ status: "INDETERMINATE", reasonCode: "MULTIPLE_TRACKLET_VERSIONS" });
  });
});
