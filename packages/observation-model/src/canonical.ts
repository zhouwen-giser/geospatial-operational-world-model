import { createHash, randomUUID } from "node:crypto";
import { ObservationInputSchema } from "../../world-model-core/src/schema.js";
import type {
  CanonicalMeasurementInput,
  CanonicalObservationBundle,
  CanonicalObservationInput,
  ObservationEnvelope,
  ObservationOriginKind
} from "../../world-model-core/src/types.js";

type LegacyObservationInput = Omit<ObservationEnvelope, "receivedAt" | "schemaVersion"> & {
  receivedAt?: string;
  schemaVersion: "1.0";
};

export function normalizeObservationInput(input: unknown, receivedAt: string): CanonicalObservationBundle {
  const parsed = ObservationInputSchema.parse(input);
  return parsed.schemaVersion === "1.2"
    ? normalizeV12(parsed as unknown as CanonicalObservationInput, receivedAt)
    : normalizeLegacy(parsed as unknown as LegacyObservationInput, receivedAt);
}

function normalizeV12(input: CanonicalObservationInput, receivedAt: string): CanonicalObservationBundle {
  const primaryPosition = input.measurements.find((measurement) => measurement.resultKind === "POSITION");
  const confidence = primaryPosition?.algorithmConfidence ??
    input.assertions.find((assertion) => assertion.probability !== undefined)?.probability ?? 1;
  const envelope: ObservationEnvelope = {
    observationId: input.observationId,
    observer: input.observer,
    subject: input.subject,
    observationType: input.observationType,
    ...(primaryPosition?.sourceGeometry ? { geometry: primaryPosition.sourceGeometry } : {}),
    value: {
      measurementCount: input.measurements.length,
      assertionCount: input.assertions.length,
      primaryMeasurementKey: primaryPosition?.measurementKey,
      ...primaryPosition?.attributes
    },
    confidence,
    observedAt: input.timeSolution.phenomenonTimeEstimate,
    receivedAt,
    source: input.source,
    correlationId: input.correlationId ?? input.observationId,
    metadata: input.metadata,
    schemaVersion: "1.2"
  };
  const semanticCommand = {
    ...input,
    correlationId: envelope.correlationId,
    measurements: input.measurements.map(normalizeMeasurementForHash)
  };
  return {
    envelope,
    dataScopeKey: input.dataScopeKey,
    sourceRecordKey: input.sourceRecordKey,
    sourceRevisionNo: input.sourceRevisionNo,
    ...(input.supersedesObservationId ? { supersedesObservationId: input.supersedesObservationId } : {}),
    originKind: input.originKind,
    sourceLocalTargetId: input.sourceLocalTargetId ?? input.subject.id,
    ...(input.trackerSessionId ? { trackerSessionId: input.trackerSessionId } : {}),
    datastreamKey: input.datastreamKey,
    producerPipelineKey: input.producerPipelineKey,
    rawReference: input.rawReference,
    payloadHash: sha256(canonicalJson(semanticCommand)),
    qualityFlags: input.qualityFlags,
    timeSolution: input.timeSolution,
    measurements: input.measurements,
    assertions: input.assertions,
    entityBindingStatus: input.entityBindingStatus
  };
}

function normalizeLegacy(
  input: LegacyObservationInput,
  receivedAt: string
): CanonicalObservationBundle {
  const estimate = new Date(input.observedAt).toISOString();
  const legacyUpstreamReceived = input.receivedAt ? new Date(input.receivedAt).toISOString() : undefined;
  const measurement = legacyMeasurement(input);
  const envelope: ObservationEnvelope = {
    ...input,
    receivedAt,
    correlationId: input.correlationId ?? input.observationId,
    schemaVersion: "1.0"
  };
  const originKind = legacyOrigin(input.source);
  const semanticCommand = {
    ...input,
    receivedAt: undefined,
    upstreamReceivedTime: legacyUpstreamReceived,
    compatibilityAdapter: "gowm-v1.1-to-canonical-v1.2"
  };
  return {
    envelope,
    dataScopeKey: "default",
    sourceRecordKey: input.observationId,
    sourceRevisionNo: 1,
    originKind,
    sourceLocalTargetId: input.subject.id,
    datastreamKey: `${input.source}:legacy-observations`,
    producerPipelineKey: `${input.source}:legacy-adapter-v1.2`,
    rawReference: `inline://legacy/${encodeURIComponent(input.observationId)}`,
    payloadHash: sha256(canonicalJson(semanticCommand)),
    qualityFlags: ["LEGACY_V1_1_ADAPTER", ...(input.geometry?.type === "Point" ? [] : ["NO_POSITION_MEASUREMENT"])],
    timeSolution: {
      phenomenonTimeEstimate: estimate,
      phenomenonTimeWindow: { start: estimate, end: new Date(Date.parse(estimate) + 1).toISOString() },
      uncertaintySeconds: 0,
      correctionMethod: "LEGACY_DECLARED_UTC",
      clockModelVersion: "legacy-identity-v1",
      ...(legacyUpstreamReceived ? { upstreamReceivedTime: legacyUpstreamReceived } : {})
    },
    measurements: [measurement],
    assertions: [],
    entityBindingStatus: "DECLARED",
    compatibilityInputVersion: "1.0"
  };
}

function legacyMeasurement(
  input: LegacyObservationInput
): CanonicalMeasurementInput {
  const base = {
    measurementId: randomUUID(),
    measurementKey: "legacy-primary",
    measurementStage: "NORMALIZED" as const,
    observedProperty: input.observationType,
    measurementModel: "GOWM_V1_1_COMPATIBILITY_ADAPTER",
    measurementModelVersion: "1.2.0",
    algorithmConfidence: input.confidence,
    qualityFlags: ["LEGACY_UNTYPED_VALUE"],
    manualCutBefore: false,
    attributes: input.value
  };
  if (input.geometry?.type === "Point") {
    return {
      ...base,
      resultKind: "POSITION",
      analysisSpaceKey: "default",
      sourceGeometry: input.geometry,
      ...(input.geometry.coordinates[2] === undefined ? {} : { altitudeM: input.geometry.coordinates[2] }),
      uncertainty: { model: "UNKNOWN" }
    };
  }
  return { ...base, resultKind: "GEOMETRY_SUPPORT" };
}

function legacyOrigin(source: string): ObservationOriginKind {
  const normalized = source.toLowerCase();
  if (normalized.includes("sim")) return "SIMULATION";
  if (normalized.includes("operator") || normalized.includes("manual")) return "MANUAL";
  return "PHYSICAL_SENSOR";
}

function normalizeMeasurementForHash(measurement: CanonicalMeasurementInput): unknown {
  return {
    ...measurement,
    measurementId: measurement.measurementId ?? null,
    attributes: measurement.attributes ?? {},
    qualityFlags: [...measurement.qualityFlags].sort()
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)])
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
