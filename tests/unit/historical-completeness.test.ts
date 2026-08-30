import { describe, expect, it } from "vitest";
import type {
  HistoricalGap,
  HistoricalSourceSegment,
  TaskExecutionIntervalDraft,
  TimePeriod
} from "../../packages/historical-trace-model/src/index.js";
import {
  buildGapPreservingSlicePlan,
  calculateHistoricalCompleteness,
  deriveHistoricalRequestDomain,
  normalizeTimePeriods,
  timePeriodDurationMs
} from "../../packages/historical-trace-core/src/index.js";

function period(start: string, end: string): TimePeriod {
  return { start, end, bounds: "[)" };
}

function gap(start: string, end: string, reason: HistoricalGap["reason"] = "UNKNOWN_INPUT_GAP"): HistoricalGap {
  return { reason, range: period(start, end) };
}

function interval(): TaskExecutionIntervalDraft {
  return {
    executionNo: 1,
    lifecycleState: "CLOSED",
    derivationKind: "OBSERVED",
    stabilityState: "PROVISIONAL",
    start: "2026-08-30T01:00:00Z",
    end: "2026-08-30T01:30:00Z",
    phases: [
      { phaseNo: 1, phaseKind: "RUNNING", start: "2026-08-30T01:00:00Z", end: "2026-08-30T01:10:00Z", reasonCodes: [] },
      { phaseNo: 2, phaseKind: "PAUSED", start: "2026-08-30T01:10:00Z", end: "2026-08-30T01:20:00Z", reasonCodes: [] },
      { phaseNo: 3, phaseKind: "RUNNING", start: "2026-08-30T01:20:00Z", end: "2026-08-30T01:30:00Z", reasonCodes: [] }
    ],
    reasonCodes: [],
    inputEvents: []
  };
}

describe("historical trajectory request domains and completeness", () => {
  it("uses a union for defined duration and does not double-count overlaps", () => {
    const requested = [period("2026-08-30T01:00:00Z", "2026-08-30T01:10:00Z")];
    const result = calculateHistoricalCompleteness({
      requestedPeriods: requested,
      definedPeriods: [
        period("2026-08-30T01:00:00Z", "2026-08-30T01:06:00Z"),
        period("2026-08-30T01:04:00Z", "2026-08-30T01:10:00Z")
      ],
      gaps: [],
      sampleCount: 4,
      sequenceCount: 2
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.completeness).toMatchObject({ temporalCoverageRatio: 1, prefixComplete: true, suffixComplete: true });
    expect(result.definedPeriods).toEqual(requested.map((value) => normalizeTimePeriods([value])[0]));
  });

  it("computes partial coverage and boundary completeness", () => {
    const result = calculateHistoricalCompleteness({
      requestedPeriods: [period("2026-08-30T01:00:00Z", "2026-08-30T01:10:00Z")],
      definedPeriods: [period("2026-08-30T01:00:00Z", "2026-08-30T01:06:00Z")],
      gaps: [],
      sampleCount: 2,
      sequenceCount: 1
    });

    expect(result).toMatchObject({ status: "PARTIAL", reasonCode: "PARTIAL_TEMPORAL_COVERAGE" });
    expect(result.completeness.temporalCoverageRatio).toBeCloseTo(0.6);
    expect(result.completeness.prefixComplete).toBe(true);
    expect(result.completeness.suffixComplete).toBe(false);
  });

  it("keeps an explicit unknown gap partial even when defined-period union covers the request", () => {
    const result = calculateHistoricalCompleteness({
      requestedPeriods: [period("2026-08-30T01:00:00Z", "2026-08-30T01:10:00Z")],
      definedPeriods: [period("2026-08-30T01:00:00Z", "2026-08-30T01:10:00Z")],
      gaps: [gap("2026-08-30T01:04:00Z", "2026-08-30T01:05:00Z", "SOURCE_COVERAGE_GAP")],
      sampleCount: 4,
      sequenceCount: 2
    });

    expect(result).toMatchObject({ status: "PARTIAL", reasonCode: "UNKNOWN_GAPS_PRESENT" });
    expect(result.completeness).toMatchObject({ temporalCoverageRatio: 1, gapCount: 1 });
  });

  it("returns NO_DATA with no trajectory points and INDETERMINATE for an empty request", () => {
    expect(calculateHistoricalCompleteness({
      requestedPeriods: [period("2026-08-30T01:00:00Z", "2026-08-30T01:10:00Z")],
      definedPeriods: [], gaps: [], sampleCount: 0, sequenceCount: 0
    })).toMatchObject({ status: "NO_DATA", reasonCode: "NO_TRAJECTORY_POINTS" });

    expect(calculateHistoricalCompleteness({
      requestedPeriods: [], definedPeriods: [], gaps: [], sampleCount: 0, sequenceCount: 0
    })).toMatchObject({ status: "INDETERMINATE", reasonCode: "INVALID_REQUEST_DURATION" });
  });

  it("gives source and interval conflicts precedence over apparent coverage", () => {
    const completeInput = {
      requestedPeriods: [period("2026-08-30T01:00:00Z", "2026-08-30T01:10:00Z")],
      definedPeriods: [period("2026-08-30T01:00:00Z", "2026-08-30T01:10:00Z")],
      gaps: [], sampleCount: 2, sequenceCount: 1
    };
    expect(calculateHistoricalCompleteness({ ...completeInput, sourceConflict: true })).toMatchObject({
      status: "INDETERMINATE", reasonCode: "SOURCE_SELECTION_CONFLICT"
    });
    expect(calculateHistoricalCompleteness({ ...completeInput, intervalConflict: true })).toMatchObject({
      status: "INDETERMINATE", reasonCode: "TASK_INTERVAL_CONFLICT"
    });
  });

  it("uses the execution envelope including the paused period", () => {
    const domain = deriveHistoricalRequestDomain(interval(), "EXECUTION_ENVELOPE", "2026-08-30T02:00:00Z");

    expect(domain.requestedPeriods).toEqual([
      period("2026-08-30T01:00:00.000Z", "2026-08-30T01:30:00.000Z")
    ]);
    expect(domain.excludedPeriods).toEqual([]);
    expect(timePeriodDurationMs(domain.requestedPeriods)).toBe(30 * 60_000);
  });

  it("uses RUNNING phases for ACTIVE and records pauses as exclusions, not gaps", () => {
    const domain = deriveHistoricalRequestDomain(interval(), "ACTIVE_PHASES_ONLY", "2026-08-30T02:00:00Z");

    expect(domain.requestedPeriods).toEqual([
      period("2026-08-30T01:00:00.000Z", "2026-08-30T01:10:00.000Z"),
      period("2026-08-30T01:20:00.000Z", "2026-08-30T01:30:00.000Z")
    ]);
    expect(domain.excludedPeriods).toEqual([{
      reason: "EXCLUDED_PAUSED_PHASE",
      range: period("2026-08-30T01:10:00.000Z", "2026-08-30T01:20:00.000Z")
    }]);
    expect(timePeriodDurationMs(domain.requestedPeriods)).toBe(20 * 60_000);
  });

  it("uses capturedAt only as an effective open end and defaults suffixComplete to false", () => {
    const open = interval();
    open.lifecycleState = "OPEN";
    delete open.end;
    delete open.phases[2]!.end;
    const domain = deriveHistoricalRequestDomain(open, "EXECUTION_ENVELOPE", "2026-08-30T01:40:00Z");
    const result = calculateHistoricalCompleteness({
      requestedPeriods: domain.requestedPeriods,
      definedPeriods: domain.requestedPeriods,
      gaps: [], sampleCount: 3, sequenceCount: 1, openExecution: domain.openExecution
    });

    expect(open.end).toBeUndefined();
    expect(domain.requestedPeriods[0]!.end).toBe("2026-08-30T01:40:00.000Z");
    expect(result.status).toBe("COMPLETED");
    expect(result.completeness.suffixComplete).toBe(false);
  });

  it("builds independent Sequence slices and never bridges gaps or excluded periods", () => {
    const segments: HistoricalSourceSegment[] = [
      {
        sourceTrackletVersionId: "tracklet-v1",
        sourceSegmentNo: 1,
        period: period("2026-08-30T01:00:00Z", "2026-08-30T01:30:00Z"),
        sampleCount: 6
      },
      {
        sourceTrackletVersionId: "tracklet-v1",
        sourceSegmentNo: 2,
        period: period("2026-08-30T01:40:00Z", "2026-08-30T02:00:00Z"),
        sampleCount: 4
      }
    ];
    const plan = buildGapPreservingSlicePlan(segments, [
      gap("2026-08-30T01:30:00Z", "2026-08-30T01:40:00Z", "TRACKLET_BOUNDARY_GAP")
    ], [
      period("2026-08-30T01:00:00Z", "2026-08-30T01:10:00Z"),
      period("2026-08-30T01:20:00Z", "2026-08-30T01:50:00Z")
    ]);

    expect(plan.segments.map((segment) => [segment.sourceSegmentNo, segment.requestedPeriodNo, segment.period])).toEqual([
      [1, 1, period("2026-08-30T01:00:00.000Z", "2026-08-30T01:10:00.000Z")],
      [1, 2, period("2026-08-30T01:20:00.000Z", "2026-08-30T01:30:00.000Z")],
      [2, 2, period("2026-08-30T01:40:00.000Z", "2026-08-30T01:50:00.000Z")]
    ]);
    expect(plan.segments.map((segment) => segment.sequenceNo)).toEqual([1, 2, 3]);
    expect(plan.gaps).toEqual([
      gap("2026-08-30T01:30:00.000Z", "2026-08-30T01:40:00.000Z", "TRACKLET_BOUNDARY_GAP")
    ]);
  });
});
