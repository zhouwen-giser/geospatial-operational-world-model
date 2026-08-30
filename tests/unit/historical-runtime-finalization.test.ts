import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../../packages/historical-trace-core/src/index.js";
import {
  evaluateTrackletFinalization,
  selectWatermarkRevisionsAsOf,
  type TrackletFinalizationEvidence,
  type WatermarkRevisionEvidence
} from "../../packages/historical-trace-runtime/src/index.js";

const AS_OF = "2026-08-30T03:00:00.000Z";

function watermark(
  id: string,
  stream: string,
  createdAt: string,
  closedThrough = "2026-08-30T02:00:00.000Z",
  completenessState = "COMPLETE"
): WatermarkRevisionEvidence {
  return {
    datastreamKey: stream,
    watermarkRevisionId: id,
    closedThroughEventTime: closedThrough,
    allowedLateness: "00:05:00",
    completenessState,
    createdAt
  };
}

function evidence(overrides: Partial<TrackletFinalizationEvidence> = {}): TrackletFinalizationEvidence {
  return {
    claim: {
      queueId: "00000000-0000-4000-8000-000000000001",
      workerId: "worker",
      generation: 1,
      leaseUntil: "2026-08-30T03:01:00.000Z",
      trackletVersionId: "00000000-0000-4000-8000-000000000010",
      desiredEvidenceHash: canonicalSha256({ desired: 1 }),
      finalizationAsOf: AS_OF
    },
    trackletVersionState: "PROVISIONAL",
    trackletEndEventTime: "2026-08-30T01:30:00.000Z",
    requiredDatastreamKeys: ["stream-a", "stream-b"],
    watermarkCandidates: [
      watermark("00000000-0000-4000-8000-000000000101", "stream-a", "2026-08-30T02:00:00.000Z"),
      watermark("00000000-0000-4000-8000-000000000102", "stream-b", "2026-08-30T02:01:00.000Z")
    ],
    staleTimeSolutionCount: 0,
    activeDirtyCount: 0,
    profile: {
      profileKey: "tracklet-finalization-watermark-v1",
      profileVersion: "1.0",
      profileHash: canonicalSha256({ profile: "finalization" })
    },
    ...overrides
  };
}

describe("tracklet finalization runtime", () => {
  it("pins the newest watermark per datastream at finalizationAsOf and ignores later revisions", () => {
    const candidates = [
      watermark("00000000-0000-4000-8000-000000000111", "stream-a", "2026-08-30T01:00:00Z"),
      watermark("00000000-0000-4000-8000-000000000112", "stream-a", "2026-08-30T02:00:00Z"),
      watermark("00000000-0000-4000-8000-000000000113", "stream-a", "2026-08-30T04:00:00Z", "2026-08-30T05:00:00Z"),
      watermark("00000000-0000-4000-8000-000000000121", "stream-b", "2026-08-30T02:30:00Z")
    ];

    expect(selectWatermarkRevisionsAsOf(candidates, AS_OF).map((value) => value.watermarkRevisionId)).toEqual([
      "00000000-0000-4000-8000-000000000112",
      "00000000-0000-4000-8000-000000000121"
    ]);
  });

  it("seals only when every fixed watermark is complete and through the immutable tracklet end", () => {
    const decision = evaluateTrackletFinalization(evidence());

    expect(decision).toMatchObject({
      state: "SEALED",
      observedThrough: "2026-08-30T02:00:00.000Z",
      reasonCodes: ["WATERMARKS_COMPLETE"]
    });
    expect(decision.watermarkInputs.map((value) => [value.inputNo, value.datastreamKey])).toEqual([
      [1, "stream-a"], [2, "stream-b"]
    ]);
    expect(decision.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("keeps a failed seal provisional and expresses invalidation of an old SEALED decision as REOPENED", () => {
    const oldSealed = evidence({ priorFinalizationState: "SEALED" });
    const snapshot = structuredClone(oldSealed);
    const dirty = evaluateTrackletFinalization({ ...oldSealed, activeDirtyCount: 1 });

    expect(dirty).toMatchObject({ state: "REOPENED", reasonCodes: ["TRACKLET_REBUILD_PENDING"] });
    expect(oldSealed).toEqual(snapshot);
    expect(evaluateTrackletFinalization(evidence({
      watermarkCandidates: [
        watermark("00000000-0000-4000-8000-000000000101", "stream-a", "2026-08-30T02:00:00Z"),
        watermark("00000000-0000-4000-8000-000000000102", "stream-b", "2026-08-30T02:00:00Z", "2026-08-30T01:00:00Z")
      ]
    }))).toMatchObject({ state: "PROVISIONAL", reasonCodes: ["WATERMARK_BEHIND_TRACKLET"] });
  });

  it("fails closed on conflicted tracklets or superseded time solutions", () => {
    expect(evaluateTrackletFinalization(evidence({ trackletVersionState: "CONFLICTED" }))).toMatchObject({
      state: "CONFLICTED", reasonCodes: ["TRACKLET_CONFLICTED"]
    });
    expect(evaluateTrackletFinalization(evidence({ staleTimeSolutionCount: 1 }))).toMatchObject({
      state: "PROVISIONAL", reasonCodes: ["TIME_SOLUTION_SUPERSEDED"]
    });
  });
});
