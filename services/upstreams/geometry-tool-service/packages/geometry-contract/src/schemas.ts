import { z } from "zod";
import type { Geometry } from "geojson";
import { GEOMETRY_OPERATIONS } from "./types.js";

const finiteNumber = z.number().finite();
const positionSchema = z.union([
  z.tuple([]),
  z.array(finiteNumber).min(2).max(4),
]);
const lineSchema = z.array(positionSchema);
const polygonCoordinatesSchema = z.array(lineSchema);

export const geometrySchema: z.ZodType<Geometry> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("Point"), coordinates: positionSchema }),
    z.object({ type: z.literal("MultiPoint"), coordinates: lineSchema }),
    z.object({ type: z.literal("LineString"), coordinates: lineSchema }),
    z.object({ type: z.literal("MultiLineString"), coordinates: z.array(lineSchema) }),
    z.object({ type: z.literal("Polygon"), coordinates: polygonCoordinatesSchema }),
    z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(polygonCoordinatesSchema) }),
    z.object({ type: z.literal("GeometryCollection"), geometries: z.array(geometrySchema) }),
  ]) as z.ZodType<Geometry>,
);

export const featureSchema = z.object({
  type: z.literal("Feature"),
  geometry: geometrySchema,
  properties: z.record(z.string(), z.unknown()).nullable(),
  id: z.union([z.string(), z.number()]).optional(),
});

export const geometryInputSchema = z.union([geometrySchema, featureSchema]);

export const precisionOptionsSchema = z.object({
  gridSize: z.number().positive().finite(),
  keepCollapsed: z.boolean().optional(),
});

export const commonOptionsSchema = z.object({
  mode: z.enum(["strict", "lenient"]).default("strict"),
  repairInvalid: z.boolean().default(false),
  normalizeOutput: z.boolean().default(false),
  precision: precisionOptionsSchema.optional(),
  planar: z.boolean().default(false),
  outputFormat: z.enum(["geojson", "wkt", "wkb-hex"]).default("geojson"),
}).partial();

export const geometryEnvelopeSchema = z.object({
  geometry: geometryInputSchema,
  srid: z.number().int().nonnegative().optional(),
  coordinateLayout: z.enum(["XY", "XYZ", "XYM", "XYZM"]).optional(),
  options: commonOptionsSchema.optional(),
});

export const binaryGeometryRequestSchema = z.object({
  a: geometryEnvelopeSchema,
  b: geometryEnvelopeSchema,
  options: commonOptionsSchema.optional(),
});

export const bufferRequestSchema = z.object({
  input: geometryEnvelopeSchema,
  options: commonOptionsSchema.extend({
    distance: z.number().finite(),
    quadrantSegments: z.number().int().min(1).max(64).default(8),
    endCapStyle: z.enum(["round", "flat", "square"]).default("round"),
    joinStyle: z.enum(["round", "mitre", "bevel"]).default("round"),
    mitreLimit: z.number().positive().finite().default(5),
    singleSided: z.boolean().default(false),
  }),
});

export const simplifyRequestSchema = z.object({
  input: geometryEnvelopeSchema,
  options: commonOptionsSchema.extend({
    tolerance: z.number().nonnegative().finite(),
    preserveTopology: z.boolean().default(true),
    preserveCoverageBoundary: z.boolean().default(true),
  }),
});

export const predicateRequestSchema = binaryGeometryRequestSchema.extend({
  predicate: z.enum(["equals", "disjoint", "intersects", "touches", "crosses", "within", "contains", "overlaps", "covers", "covered_by", "relate"]),
  pattern: z.string().regex(/^[012TF\*]{9}$/).optional(),
});

export const measureRequestSchema = z.object({
  measure: z.enum(["area", "length", "distance", "hausdorff_distance", "minimum_clearance"]),
  input: geometryEnvelopeSchema,
  other: geometryEnvelopeSchema.optional(),
  options: commonOptionsSchema.optional(),
});

export const geometryOperationSchema = z.enum(GEOMETRY_OPERATIONS);

export const operationRequestSchema = z.object({
  operation: geometryOperationSchema,
  input: geometryEnvelopeSchema.optional(),
  other: geometryEnvelopeSchema.optional(),
  inputs: z.array(geometryEnvelopeSchema).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  options: commonOptionsSchema.optional(),
});

export const batchRequestSchema = z.object({
  operation: geometryOperationSchema,
  items: z.array(operationRequestSchema.omit({ operation: true }).extend({ operation: geometryOperationSchema.optional() })).min(1),
  continueOnError: z.boolean().default(true),
});
