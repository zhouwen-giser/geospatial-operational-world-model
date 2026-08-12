import { z } from "zod";
import { COMPUTED_RELATIONS, WORLD_OBJECT_TYPES, WORLD_EVENT_TYPES } from "./types.js";

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

export const ObservationEnvelopeSchema = z.object({
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
});

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
