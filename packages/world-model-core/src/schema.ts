import { z } from "zod";
import {
  COMPUTED_RELATIONS,
  OBSERVATION_ORIGIN_KINDS,
  WORLD_OBJECT_TYPES,
  WORLD_EVENT_TYPES
} from "./types.js";

const Position2D = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90)
]);
const Position3D = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
  z.number()
]);
const Position = z.union([Position2D, Position3D]);

export const GeometrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Point"), coordinates: Position }),
  z.object({ type: z.literal("LineString"), coordinates: z.array(Position).min(2) }),
  z.object({ type: z.literal("Polygon"), coordinates: z.array(z.array(Position).min(4)).min(1) }),
  z.object({
    type: z.literal("MultiPolygon"),
    coordinates: z.array(z.array(z.array(Position).min(4)).min(1)).min(1)
  })
]);

const TimestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: "must be an ISO-8601 timestamp"
});

const ObjectTypeSchema = z.string().min(1).max(128);
const ObjectRefSchema = z.object({ type: ObjectTypeSchema, id: z.string().min(1).max(256) });

export const ObservationEnvelopeV11Schema = z.object({
  observationId: z.string().min(1).max(256),
  observer: ObjectRefSchema,
  subject: ObjectRefSchema,
  observationType: z.string().min(1).max(128),
  geometry: GeometrySchema.optional(),
  value: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1),
  observedAt: TimestampSchema,
  receivedAt: TimestampSchema.optional(),
  source: z.string().min(1).max(128),
  correlationId: z.string().min(1).max(256).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  schemaVersion: z.literal("1.0").default("1.0")
}).strict();

const NonNegativeFinite = z.number().finite().nonnegative();
const Probability = z.number().finite().min(0).max(1);

export const PositionUncertaintySchema = z.object({
  model: z.enum(["HARD_RADIUS", "STDDEV", "COVARIANCE", "INTERVAL", "UNKNOWN"]),
  unit: z.enum(["m", "m2"]).optional(),
  horizontalValue: NonNegativeFinite.optional(),
  confidenceLevel: Probability.optional(),
  covariance: z.tuple([
    z.tuple([z.number().finite().nonnegative(), z.number().finite()]),
    z.tuple([z.number().finite(), z.number().finite().nonnegative()])
  ]).optional()
}).strict().superRefine((value, context) => {
  if ((value.model === "HARD_RADIUS" || value.model === "STDDEV") &&
      (value.unit !== "m" || value.horizontalValue === undefined)) {
    context.addIssue({ code: "custom", message: `${value.model} requires horizontalValue in metres` });
  }
  if (value.model === "COVARIANCE") {
    const covariance = value.covariance;
    if (!covariance) {
      context.addIssue({ code: "custom", message: "COVARIANCE requires a 2x2 covariance matrix" });
    } else if (value.unit !== "m2") {
      context.addIssue({ code: "custom", message: "COVARIANCE requires unit m2" });
    } else if (covariance[0][1] !== covariance[1][0] ||
               covariance[0][0] * covariance[1][1] < covariance[0][1] * covariance[0][1]) {
      context.addIssue({ code: "custom", message: "covariance must be symmetric positive semidefinite" });
    }
  }
  if ((value.model === "INTERVAL" || value.model === "UNKNOWN") &&
      (value.horizontalValue !== undefined || value.covariance !== undefined)) {
    context.addIssue({ code: "custom", message: `${value.model} cannot masquerade as a radius or covariance` });
  }
});

const CanonicalMeasurementSchema = z.object({
  measurementId: z.string().uuid().optional(),
  measurementKey: z.string().min(1).max(256),
  measurementStage: z.enum(["PARSED_NATIVE", "NORMALIZED", "FUSED_DERIVED"]),
  observedProperty: z.string().min(1).max(128),
  resultKind: z.enum(["POSITION", "NUMERIC", "VECTOR", "GEOMETRY_SUPPORT"]),
  analysisSpaceKey: z.string().min(1).max(128).optional(),
  position: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    srid: z.number().int().positive()
  }).strict().optional(),
  sourceGeometry: GeometrySchema.refine((geometry) => geometry.type === "Point", {
    message: "sourceGeometry must be a WGS84 Point"
  }).optional(),
  altitudeM: z.number().finite().optional(),
  verticalDatum: z.string().min(1).max(128).optional(),
  uncertainty: PositionUncertaintySchema.optional(),
  scalarValue: z.number().finite().optional(),
  valueUnit: z.string().min(1).max(64).optional(),
  vectorValue: z.array(z.number().finite()).min(1).max(64).optional(),
  nativeFrame: z.string().min(1).max(128).optional(),
  measurementModel: z.string().min(1).max(256),
  measurementModelVersion: z.string().min(1).max(128),
  calibrationVersion: z.string().min(1).max(128).optional(),
  algorithmConfidence: Probability.optional(),
  qualityScore: Probability.optional(),
  qualityFlags: z.array(z.string().min(1).max(128)).default([]),
  continuityToken: z.string().min(1).max(256).optional(),
  manualCutBefore: z.boolean().default(false),
  attributes: z.record(z.string(), z.unknown()).default({})
}).strict().superRefine((measurement, context) => {
  if (measurement.resultKind === "POSITION") {
    if (!measurement.position || !measurement.sourceGeometry || !measurement.uncertainty) {
      context.addIssue({
        code: "custom",
        message: "POSITION requires normalized position, WGS84 sourceGeometry and typed uncertainty"
      });
    }
  } else if (measurement.position || measurement.sourceGeometry || measurement.uncertainty) {
    context.addIssue({ code: "custom", message: "position fields are only valid for POSITION measurements" });
  }
  if (measurement.resultKind === "NUMERIC" && measurement.scalarValue === undefined) {
    context.addIssue({ code: "custom", message: "NUMERIC requires scalarValue" });
  }
  if (measurement.resultKind === "VECTOR" && measurement.vectorValue === undefined) {
    context.addIssue({ code: "custom", message: "VECTOR requires vectorValue" });
  }
});

const CanonicalTimeSolutionSchema = z.object({
  phenomenonTimeEstimate: TimestampSchema,
  phenomenonTimeWindow: z.object({ start: TimestampSchema, end: TimestampSchema }).strict(),
  uncertaintySeconds: NonNegativeFinite,
  correctionMethod: z.string().min(1).max(256),
  clockModelVersion: z.string().min(1).max(128),
  clockDomain: z.string().min(1).max(128).default("SOURCE_DECLARED"),
  clockOffsetSeconds: z.number().finite().default(0),
  clockDriftPpm: z.number().finite().optional(),
  clockResidualSigmaMs: NonNegativeFinite.default(0),
  clockEstimationMethod: z.string().min(1).max(256).optional(),
  clockCalibrationReference: z.string().min(1).max(512).optional(),
  supersedesClockModelId: z.string().uuid().optional(),
  sourceTime: TimestampSchema.optional(),
  sourceTimeRaw: z.string().min(1).max(512).optional(),
  sourceTimeTicks: z.string().regex(/^-?\d+(?:\.\d+)?$/).optional(),
  resultTime: TimestampSchema.optional(),
  sourceEmittedTime: TimestampSchema.optional(),
  upstreamReceivedTime: TimestampSchema.optional(),
  processedTime: TimestampSchema.optional(),
  exposureOrScanDurationMs: NonNegativeFinite.optional(),
  supersedesTimeSolutionId: z.string().uuid().optional()
}).strict().superRefine((solution, context) => {
  const estimate = Date.parse(solution.phenomenonTimeEstimate);
  const start = Date.parse(solution.phenomenonTimeWindow.start);
  const end = Date.parse(solution.phenomenonTimeWindow.end);
  if (!(start <= estimate && estimate < end)) {
    context.addIssue({ code: "custom", path: ["phenomenonTimeWindow"], message: "window must be [start,end) and contain estimate" });
  }
});

const ObservationAssertionSchema = z.object({
  assertionKind: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  probability: Probability.optional(),
  calibrationVersion: z.string().min(1).max(128).optional(),
  basisReference: z.string().min(1).max(512),
  inputMeasurementKeys: z.array(z.string().min(1).max(256)).default([])
}).strict();

export const CanonicalObservationInputSchema = z.object({
  schemaVersion: z.literal("1.2"),
  observationId: z.string().min(1).max(256),
  dataScopeKey: z.string().min(1).max(128),
  sourceRecordKey: z.string().min(1).max(512),
  sourceRevisionNo: z.number().int().positive().default(1),
  supersedesObservationId: z.string().min(1).max(256).optional(),
  originKind: z.enum(OBSERVATION_ORIGIN_KINDS),
  observer: ObjectRefSchema,
  subject: ObjectRefSchema,
  sourceLocalTargetId: z.string().min(1).max(256).optional(),
  trackerSessionId: z.string().min(1).max(256).optional(),
  observationType: z.string().min(1).max(128),
  source: z.string().min(1).max(128),
  datastreamKey: z.string().min(1).max(256),
  producerPipelineKey: z.string().min(1).max(256),
  rawReference: z.string().min(1).max(2_048),
  correlationId: z.string().min(1).max(256).optional(),
  qualityFlags: z.array(z.string().min(1).max(128)).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  timeSolution: CanonicalTimeSolutionSchema,
  measurements: z.array(CanonicalMeasurementSchema).min(1).max(128),
  assertions: z.array(ObservationAssertionSchema).max(128).default([]),
  entityBindingStatus: z.enum(["DECLARED", "CANDIDATE", "CONFIRMED"]).default("DECLARED")
}).strict().superRefine((input, context) => {
  if (input.sourceRevisionNo > 1 && !input.supersedesObservationId) {
    context.addIssue({ code: "custom", path: ["supersedesObservationId"], message: "revision > 1 must supersede a prior observation" });
  }
  const keys = input.measurements.map((measurement) => measurement.measurementKey);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["measurements"], message: "measurementKey values must be unique" });
  }
});

export const ObservationInputSchema = z.union([CanonicalObservationInputSchema, ObservationEnvelopeV11Schema]);

/** @deprecated Use ObservationInputSchema at HTTP boundaries. */
export const ObservationEnvelopeSchema = ObservationEnvelopeV11Schema;

export const WorldObjectCreateSchema = z.object({
  id: z.string().min(1).max(256),
  type: ObjectTypeSchema,
  subtype: z.string().min(1).max(128).optional(),
  geometry: GeometrySchema.optional(),
  state: z.record(z.string(), z.unknown()).default({}),
  properties: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1).default(1)
});

export const WorldObjectPatchSchema = z.object({
  state: z.record(z.string(), z.unknown()).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  geometry: GeometrySchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  expectedVersion: z.number().int().nonnegative().optional()
}).refine((patch) => patch.state !== undefined || patch.properties !== undefined || patch.geometry !== undefined || patch.confidence !== undefined, {
  message: "patch must change state, properties, geometry or confidence"
});

export const RelationCreateSchema = z.object({
  relationType: z.string().min(1).max(128),
  fromObjectId: z.string().min(1).max(256),
  toObjectId: z.string().min(1).max(256),
  persisted: z.boolean().default(true),
  properties: z.record(z.string(), z.unknown()).default({})
}).superRefine((relation, context) => {
  if (relation.persisted && (COMPUTED_RELATIONS as readonly string[]).includes(relation.relationType)) {
    context.addIssue({ code: "custom", path: ["persisted"], message: `${relation.relationType} is computed from geometry and cannot be persisted` });
  }
});

export const NearbyQuerySchema = z.object({
  location: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
  objectTypes: z.array(ObjectTypeSchema).min(1).optional(),
  radiusM: z.number().positive().max(1_000_000),
  filter: z.record(z.string(), z.unknown()).default({}),
  limit: z.number().int().positive().max(1_000).default(10)
});

export const AreaQuerySchema = z.object({
  area: GeometrySchema.refine((g) => g.type === "Polygon" || g.type === "MultiPolygon", {
    message: "area must be Polygon or MultiPolygon"
  }),
  objectTypes: z.array(ObjectTypeSchema).optional(),
  filter: z.record(z.string(), z.unknown()).default({}),
  limit: z.number().int().positive().max(10_000).default(1_000)
});

export const DistanceQuerySchema = z.object({
  from: GeometrySchema.refine((g) => g.type === "Point", { message: "from must be Point" }),
  to: GeometrySchema.refine((g) => g.type === "Point", { message: "to must be Point" })
});

export const RouteQuerySchema = z.object({
  route: GeometrySchema.refine((g) => g.type === "LineString", { message: "route must be LineString" }),
  bufferM: z.number().nonnegative().max(100_000).default(100),
  objectTypes: z.array(ObjectTypeSchema).optional(),
  limit: z.number().int().positive().max(10_000).default(1_000)
});

export const HotspotQuerySchema = z.object({
  resolution: z.number().int().min(7).max(10).default(9),
  metric: z.enum(["activity", "risk", "coverage", "freshness", "observations"]).default("activity"),
  limit: z.number().int().positive().max(1_000).default(10),
  parentCell: z.string().optional()
});

export const EventSubscriptionFilterSchema = z.object({
  objectType: ObjectTypeSchema.optional(),
  eventType: z.union([z.enum(WORLD_EVENT_TYPES), z.string().min(1)]).optional(),
  areaId: z.string().optional(),
  sinceWorldVersion: z.coerce.number().int().nonnegative().optional()
});

export const TrackQuerySchema = z.object({
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
  limit: z.coerce.number().int().positive().max(100_000).default(10_000)
});

export const KnownWorldObjectTypes = WORLD_OBJECT_TYPES;
