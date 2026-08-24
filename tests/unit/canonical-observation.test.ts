import { describe,expect,it } from "vitest";
import { CanonicalObservationInputSchema,ObservationInputSchema } from "../../packages/world-model-core/src/schema.js";
import { normalizeObservationInput } from "../../packages/observation-model/src/canonical.js";
import { makeObservation } from "../../packages/runtime/src/memory-world.js";

function canonicalInput() {
  return {
    schemaVersion: "1.2" as const,
    observationId: "camera-01:frame-42:target-17",
    dataScopeKey: "campus-test",
    sourceRecordKey: "frame-42:target-17",
    sourceRevisionNo: 1,
    originKind: "PHYSICAL_SENSOR" as const,
    observer: { type: "Camera",id: "camera-01" },
    subject: { type: "ObservedTarget",id: "camera-01:17" },
    sourceLocalTargetId: "17",
    trackerSessionId: "tracker-session-a",
    observationType: "position",
    source: "camera-01",
    datastreamKey: "camera-01:detections",
    producerPipelineKey: "camera-01:detector-v7",
    rawReference: "s3://evidence/frame-42.json#target-17",
    qualityFlags: [],
    metadata: { frame: 42 },
    timeSolution: {
      phenomenonTimeEstimate: "2026-08-13T00:00:01.000Z",
      phenomenonTimeWindow: {
        start: "2026-08-13T00:00:00.950Z",
        end: "2026-08-13T00:00:01.051Z"
      },
      uncertaintySeconds: 0.05,
      correctionMethod: "PTP_OFFSET_V2",
      clockModelVersion: "clock-camera-01-v2",
      sourceTime: "2026-08-13T00:00:01.000Z"
    },
    measurements: [{
      measurementKey: "position-ground-plane",
      measurementStage: "NORMALIZED" as const,
      observedProperty: "position",
      resultKind: "POSITION" as const,
      analysisSpaceKey: "campus-utm50n",
      position: { x: 448252.1,y: 4417768.4,srid: 32650 },
      sourceGeometry: { type: "Point" as const,coordinates: [116.4,39.9] as [number,number] },
      uncertainty: { model: "HARD_RADIUS" as const,unit: "m" as const,horizontalValue: 5,confidenceLevel: 0.95 },
      measurementModel: "CAMERA_GROUND_PLANE_PROJECTION",
      measurementModelVersion: "7.2",
      algorithmConfidence: 0.87,
      qualityScore: 0.91,
      qualityFlags: [],
      continuityToken: "tracker-session-a:17",
      manualCutBefore: false,
      attributes: { objectType: "person" }
    }],
    assertions: [{
      assertionKind: "OBJECT_CLASSIFICATION",
      label: "person",
      probability: 0.87,
      calibrationVersion: "cal-3",
      basisReference: "detector-v7",
      inputMeasurementKeys: ["position-ground-plane"]
    }],
    entityBindingStatus: "CANDIDATE" as const
  };
}

describe("GOWM+ canonical observation v1.2",() => {
  it("keeps time, position accuracy and algorithm confidence separate",() => {
    const parsed = CanonicalObservationInputSchema.parse(canonicalInput());
    const bundle = normalizeObservationInput(parsed,"2026-08-13T00:00:03.000Z");
    expect(bundle.envelope.receivedAt).toBe("2026-08-13T00:00:03.000Z");
    expect(bundle.timeSolution.uncertaintySeconds).toBe(0.05);
    expect(bundle.measurements[0]?.uncertainty).toMatchObject({ model: "HARD_RADIUS",horizontalValue: 5 });
    expect(bundle.measurements[0]?.algorithmConfidence).toBe(0.87);
    expect(bundle.entityBindingStatus).toBe("CANDIDATE");
    expect(bundle.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("excludes server receipt time but preserves upstream time in the idempotency fingerprint",() => {
    const input = CanonicalObservationInputSchema.parse(canonicalInput());
    const first = normalizeObservationInput(input,"2026-08-13T00:00:03.000Z");
    const retry = normalizeObservationInput(input,"2026-08-13T00:00:04.000Z");
    expect(retry.payloadHash).toBe(first.payloadHash);
    const changed = CanonicalObservationInputSchema.parse({
      ...canonicalInput(),timeSolution: {
        ...canonicalInput().timeSolution,upstreamReceivedTime: "2026-08-13T00:00:02.500Z"
      }
    });
    expect(normalizeObservationInput(changed,"2026-08-13T00:00:04.000Z").payloadHash).not.toBe(first.payloadHash);
  });

  it("propagates external correlation metadata as evidence without changing internal identity",() => {
    const correlated = CanonicalObservationInputSchema.parse({
      ...canonicalInput(),
      executionIntentId: "intent-42",
      operationCorrelationId: "operation-42",
      externalPlanningTaskId: "planning-task-42",
      externalPlanningStepId: "planning-step-7",
      providerActionId: "provider-action-9",
      deviceCommandId: "device-command-3"
    });
    const bundle = normalizeObservationInput(correlated,"2026-08-13T00:00:03.000Z");
    expect(bundle).toMatchObject({
      executionIntentId: "intent-42",
      operationCorrelationId: "operation-42",
      externalPlanningTaskId: "planning-task-42",
      externalPlanningStepId: "planning-step-7",
      providerActionId: "provider-action-9",
      deviceCommandId: "device-command-3"
    });
    expect(bundle.envelope).toMatchObject({
      observationId: correlated.observationId,
      externalPlanningTaskId: "planning-task-42",
      operationCorrelationId: "operation-42"
    });
    const changed = normalizeObservationInput(
      CanonicalObservationInputSchema.parse({ ...correlated,externalPlanningTaskId: "planning-task-43" }),
      "2026-08-13T00:00:04.000Z"
    );
    expect(changed.payloadHash).not.toBe(bundle.payloadHash);
    expect(CanonicalObservationInputSchema.safeParse({
      ...canonicalInput(),operationCorrelationId: "x".repeat(513)
    }).success).toBe(false);
  });

  it("rejects client-owned receivedAt and invalid typed uncertainty",() => {
    expect(ObservationInputSchema.safeParse({ ...canonicalInput(),receivedAt: "2026-08-13T00:00:03Z" }).success).toBe(false);
    const broken = canonicalInput();
    broken.measurements[0]!.uncertainty = { model: "HARD_RADIUS",unit: "m" } as never;
    expect(CanonicalObservationInputSchema.safeParse(broken).success).toBe(false);
  });

  it("adapts v1.1 without treating missing accuracy as zero error",() => {
    const legacy = makeObservation({
      observationId: "legacy-1",
      observer: { type: "Camera",id: "camera-legacy" },
      subject: { type: "Vehicle",id: "vehicle-1" },
      observationType: "position",
      geometry: { type: "Point",coordinates: [116.4,39.9] },
      source: "camera",
      observedAt: "2026-08-13T00:00:01Z",
      receivedAt: "2026-08-13T00:00:02Z"
    });
    const bundle = normalizeObservationInput(legacy,"2026-08-13T00:00:03Z");
    expect(bundle.compatibilityInputVersion).toBe("1.0");
    expect(bundle.timeSolution.upstreamReceivedTime).toBe("2026-08-13T00:00:02.000Z");
    expect(bundle.envelope.receivedAt).toBe("2026-08-13T00:00:03Z");
    expect(bundle.measurements[0]?.uncertainty).toEqual({ model: "UNKNOWN" });
    expect(bundle.measurements[0]?.continuityToken).toBeUndefined();
  });
});
