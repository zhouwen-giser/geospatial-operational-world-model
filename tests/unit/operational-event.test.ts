import { describe,expect,it } from "vitest";
import {
  OPERATIONAL_EVENT_TYPES,
  OperationalEventIngestSchema,
  parseOperationalEventIngest,
  validateOperationalEventTime
} from "../../packages/operational-model/src/events.js";

function eventInput() {
  return {
    dataScopeKey: "operational-test",
    sourceAuthority: "provider-a",
    sourceEventKey: "source-event-1",
    sourceRevisionNo: 1,
    eventId: "operational-event-1",
    operationalTaskId: "ot_internal_1",
    eventType: "EXECUTION_PROGRESS_OBSERVED" as const,
    eventTime: "2026-08-24T01:00:00.000Z",
    actorReferenceKeys: [{ namespace: "gowm" as const,kind: "WORLD_OBJECT" as const,id: "wrf_11111111111111111111111111111111",version: "1" }],
    targetReferenceKeys: [{ namespace: "gowm" as const,kind: "WORLD_OBJECT" as const,id: "wrf_22222222222222222222222222222222",version: "1" }],
    payload: { progress: 0.5 },
    confidence: 0.9,
    provenance: [{ evidenceId: "provider-record-1",authority: "provider-a",evidenceType: "PROVIDER_EVENT" }],
    correlationClaims: [{
      claimId: "claim-1",externalAuthority: "provider-a",externalKind: "PROVIDER_ACTION" as const,
      externalValue: "provider-action-1",matchBasis: "PROVIDER_DECLARED" as const,
      observedAt: "2026-08-24T01:00:00.000Z",receivedAt: "2026-08-24T01:00:01.000Z",
      evidenceIds: ["provider-record-1"]
    }]
  };
}

describe("v0.4 operational event ingest",() => {
  it("accepts every frozen event type and rejects boundary-owned output fields",() => {
    expect(OPERATIONAL_EVENT_TYPES).toHaveLength(15);
    for (const eventType of OPERATIONAL_EVENT_TYPES) {
      expect(OperationalEventIngestSchema.safeParse({ ...eventInput(),eventType }).success).toBe(true);
    }
    expect(OperationalEventIngestSchema.safeParse({
      ...eventInput(),receivedTime: "2026-08-24T01:00:01.000Z",worldVersion: 1
    }).success).toBe(false);
  });

  it("keeps internal task identity distinct from propagated external identity",() => {
    const parsed = parseOperationalEventIngest(eventInput());
    expect(parsed.operationalTaskId).toBe("ot_internal_1");
    expect(parsed.correlationClaims?.[0]?.externalValue).toBe("provider-action-1");
    expect(OperationalEventIngestSchema.safeParse({
      ...eventInput(),operationalTaskId: "provider-action-1"
    }).success).toBe(false);
  });

  it("classifies late events and rejects events beyond future skew",() => {
    expect(validateOperationalEventTime(
      "2026-08-24T01:00:00Z","2026-08-24T01:00:01Z",300_000,86_400_000
    )).toBe("CURRENT");
    expect(validateOperationalEventTime(
      "2026-08-20T01:00:00Z","2026-08-24T01:00:00Z",300_000,86_400_000
    )).toBe("LATE");
    expect(() => validateOperationalEventTime(
      "2026-08-24T02:00:00Z","2026-08-24T01:00:00Z",300_000,86_400_000
    )).toThrow(/future-skew/u);
  });
});
