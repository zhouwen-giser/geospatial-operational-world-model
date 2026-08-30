import { describe, expect, it } from "vitest";
import type { HistoricalSemanticRequest } from "../../packages/historical-trace-model/src/index.js";
import {
  canonicalSha256,
  historicalSemanticRequestHash,
  historicalSemanticRequestIdentity
} from "../../packages/historical-trace-core/src/index.js";

function request(overrides: Partial<HistoricalSemanticRequest> = {}): HistoricalSemanticRequest {
  return {
    subjectReferenceKey: { namespace: "gowm", kind: "WORLD_OBJECT", id: "vehicle-2", version: "17" },
    executionIntervalReferenceKey: {
      namespace: "gowm",
      kind: "TASK_EXECUTION_INTERVAL",
      id: "execution-42",
      version: "3"
    },
    phaseScope: "ACTIVE_PHASES_ONLY",
    sourceSelection: { mode: "EXPLICIT_SOURCE", sourceKey: "tracker-a", trackerSessionKey: "session-9" },
    sourceSelectionProfileReferenceKey: {
      namespace: "gowm",
      kind: "HISTORY_METHOD_PROFILE",
      id: "strict-source-selection",
      version: "2"
    },
    analysisSpaceReferenceKey: {
      namespace: "gowm",
      kind: "SPATIAL_OBJECT",
      id: "analysis-space-a",
      version: "11"
    },
    maximumInlinePoints: 100,
    ...overrides
  };
}

describe("historical semantic request hash", () => {
  it("freezes the exact canonical logical-identity payload", () => {
    const input = request();
    const identity = historicalSemanticRequestIdentity(input);

    expect(identity).toEqual({
      subjectReferenceKey: { namespace: "gowm", kind: "WORLD_OBJECT", id: "vehicle-2" },
      executionIntervalReferenceKey: {
        namespace: "gowm",
        kind: "TASK_EXECUTION_INTERVAL",
        id: "execution-42"
      },
      phaseScope: "ACTIVE_PHASES_ONLY",
      sourceSelection: { mode: "EXPLICIT_SOURCE", sourceKey: "tracker-a", trackerSessionKey: "session-9" },
      sourceSelectionProfileReferenceKey: {
        namespace: "gowm",
        kind: "HISTORY_METHOD_PROFILE",
        id: "strict-source-selection",
        version: "2"
      },
      analysisSpaceReferenceKey: { namespace: "gowm", kind: "SPATIAL_OBJECT", id: "analysis-space-a" }
    });
    expect(historicalSemanticRequestHash(input)).toBe(canonicalSha256(identity));
    expect(historicalSemanticRequestHash(input)).toBe(
      "sha256:daef416f499dde9556747484fce9a369d6f8f7e6556f947723dbb83e33f5922a"
    );
    expect(JSON.stringify(identity)).not.toContain("maximumInlinePoints");
  });

  it("ignores presentation controls and non-profile reference versions", () => {
    const baseline = historicalSemanticRequestHash(request());
    const changedPins = request({
      subjectReferenceKey: { namespace: "gowm", kind: "WORLD_OBJECT", id: "vehicle-2", version: "999" },
      executionIntervalReferenceKey: {
        namespace: "gowm",
        kind: "TASK_EXECUTION_INTERVAL",
        id: "execution-42",
        version: "999"
      },
      analysisSpaceReferenceKey: {
        namespace: "gowm",
        kind: "SPATIAL_OBJECT",
        id: "analysis-space-a",
        version: "999"
      },
      maximumInlinePoints: 9_999
    });

    expect(historicalSemanticRequestHash(changedPins)).toBe(baseline);
    const withoutPresentationControl = request();
    delete withoutPresentationControl.maximumInlinePoints;
    expect(historicalSemanticRequestHash(withoutPresentationControl)).toBe(baseline);
  });

  it("retains the exact method-profile reference and every semantic selector", () => {
    const baseline = historicalSemanticRequestHash(request());
    const variants: HistoricalSemanticRequest[] = [
      request({ subjectReferenceKey: { namespace: "gowm", kind: "WORLD_OBJECT", id: "vehicle-3", version: "17" } }),
      request({
        executionIntervalReferenceKey: {
          namespace: "gowm",
          kind: "TASK_EXECUTION_INTERVAL",
          id: "execution-43",
          version: "3"
        }
      }),
      request({ phaseScope: "EXECUTION_ENVELOPE" }),
      request({ sourceSelection: { mode: "ONLY_CANDIDATE" } }),
      request({ sourceSelection: { mode: "EXPLICIT_SOURCE", sourceKey: "tracker-b", trackerSessionKey: "session-9" } }),
      request({ sourceSelection: { mode: "EXPLICIT_SOURCE", sourceKey: "tracker-a", trackerSessionKey: "session-10" } }),
      request({
        sourceSelectionProfileReferenceKey: {
          namespace: "gowm",
          kind: "HISTORY_METHOD_PROFILE",
          id: "strict-source-selection",
          version: "3"
        }
      }),
      request({
        analysisSpaceReferenceKey: {
          namespace: "gowm",
          kind: "SPATIAL_OBJECT",
          id: "analysis-space-b",
          version: "11"
        }
      })
    ];
    const withoutAnalysisSpace = request();
    delete withoutAnalysisSpace.analysisSpaceReferenceKey;
    variants.push(withoutAnalysisSpace);

    for (const variant of variants) expect(historicalSemanticRequestHash(variant)).not.toBe(baseline);
  });

  it("canonicalizes source-selection fields instead of hashing caller property order or extras", () => {
    const baseline = request();
    const reordered = request({
      sourceSelection: {
        trackerSessionKey: "session-9",
        sourceKey: "tracker-a",
        mode: "EXPLICIT_SOURCE",
        ignoredByTypedBoundary: "presentation-only"
      } as HistoricalSemanticRequest["sourceSelection"]
    });

    expect(historicalSemanticRequestHash(reordered)).toBe(historicalSemanticRequestHash(baseline));
  });
});
