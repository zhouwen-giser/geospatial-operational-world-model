import { describe,expect,it } from "vitest";
import {
  assertObservabilityAssessment,
  ObservabilityRequestSchema
} from "../../packages/operational-model/src/events.js";

const request = {
  dataScopeKey: "observability-test",
  subjectReferenceKey: {
    namespace: "gowm" as const,kind: "WORLD_OBJECT" as const,
    id: "wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",version: "1"
  },
  timeRange: { from: "2026-08-24T00:00:00Z",to: "2026-08-24T00:01:00Z" },
  expectedSources: ["sensor-a"],freshnessSlaSeconds: 300
};

describe("operational observability contracts",() => {
  it("requires bounded time, sources, and freshness policy",() => {
    expect(ObservabilityRequestSchema.parse(request)).toMatchObject(request);
    expect(ObservabilityRequestSchema.safeParse({ ...request,expectedSources: [] }).success).toBe(false);
    expect(ObservabilityRequestSchema.safeParse({
      ...request,timeRange: { from: request.timeRange.to,to: request.timeRange.from }
    }).success).toBe(false);
  });

  it.each(["FRESH","STALE","OBSERVATION_GAP","NO_DATA","SOURCE_UNHEALTHY","INDETERMINATE"] as const)(
    "accepts %s as a distinct assessment status",(status) => {
      expect(() => assertObservabilityAssessment({
        assessmentId: `oas-${status}`,status,coverageSufficient: status==="FRESH",
        evidenceIds: [],policyVersion: "operational-observability-v1",worldVersion: 1,
        warnings: []
      })).not.toThrow();
    }
  );
});
