import { getContractSchema } from "../../../../packages/platform/contract-runtime/src/index.js";
import type { JsonSchema } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { CrsOperationId } from "./types.js";

const canonicalSourceCrs = {
  type: "string",
  pattern: "^EPSG:[1-9][0-9]{0,5}$"
} as const;

const position = {
  type: "array",
  minItems: 2,
  maxItems: 4,
  items: { type: "number" }
} as const;

const warning = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message"],
  properties: {
    code: {
      enum: [
        "SOURCE_ALREADY_WGS84",
        "GRID_FALLBACK",
        "LOW_ACCURACY_TRANSFORMATION",
        "Z_NOT_TRANSFORMED",
        "BBOX_DROPPED"
      ]
    },
    message: { type: "string", minLength: 1, maxLength: 1024 }
  }
} as const;

const transformation = {
  type: "object",
  additionalProperties: false,
  required: [
    "engine",
    "engineVersion",
    "integration",
    "integrationVersion",
    "sourceCrs",
    "targetCrs",
    "strictBestOperation",
    "networkEnabled",
    "cacheHit"
  ],
  properties: {
    engine: { const: "PROJ" },
    engineVersion: { type: "string", minLength: 1, maxLength: 128 },
    integration: { const: "gdal-async" },
    integrationVersion: { type: "string", minLength: 1, maxLength: 128 },
    sourceCrs: canonicalSourceCrs,
    targetCrs: { const: "EPSG:4326" },
    strictBestOperation: { const: true },
    networkEnabled: { const: false },
    cacheHit: { type: "boolean" }
  }
} as const;

// GeoJSON foreign members are intentionally retained. Strictness applies to the
// bridge request/response envelope; feature properties remain caller data.
const geoJsonDefs = {
  position,
  geometry: {
    oneOf: [
      {
        type: "object",
        required: ["type", "coordinates"],
        properties: { type: { const: "Point" }, coordinates: { $ref: "#/$defs/position" } }
      },
      {
        type: "object",
        required: ["type", "coordinates"],
        properties: {
          type: { enum: ["MultiPoint", "LineString"] },
          coordinates: { type: "array", items: { $ref: "#/$defs/position" } }
        }
      },
      {
        type: "object",
        required: ["type", "coordinates"],
        properties: {
          type: { enum: ["MultiLineString", "Polygon"] },
          coordinates: {
            type: "array",
            items: { type: "array", items: { $ref: "#/$defs/position" } }
          }
        }
      },
      {
        type: "object",
        required: ["type", "coordinates"],
        properties: {
          type: { const: "MultiPolygon" },
          coordinates: {
            type: "array",
            items: {
              type: "array",
              items: { type: "array", items: { $ref: "#/$defs/position" } }
            }
          }
        }
      },
      {
        type: "object",
        required: ["type", "geometries"],
        properties: {
          type: { const: "GeometryCollection" },
          geometries: { type: "array", items: { $ref: "#/$defs/geometry" } }
        }
      }
    ]
  },
  feature: {
    type: "object",
    required: ["type", "geometry", "properties"],
    properties: {
      type: { const: "Feature" },
      id: { oneOf: [{ type: "string" }, { type: "number" }] },
      geometry: { oneOf: [{ $ref: "#/$defs/geometry" }, { type: "null" }] },
      properties: { oneOf: [{ type: "object" }, { type: "null" }] }
    }
  },
  featureCollection: {
    type: "object",
    required: ["type", "features"],
    properties: {
      type: { const: "FeatureCollection" },
      features: { type: "array", items: { $ref: "#/$defs/feature" } }
    }
  },
  warning,
  transformation
} as const;

const metadataProperties = {
  crs: { const: "EPSG:4326" },
  axisOrder: {
    type: "array",
    prefixItems: [{ const: "longitude" }, { const: "latitude" }],
    minItems: 2,
    maxItems: 2
  },
  coordinateCount: { type: "integer", minimum: 0 },
  zTransformed: { const: false },
  transformation: { $ref: "#/$defs/transformation" },
  warnings: { type: "array", maxItems: 128, items: { $ref: "#/$defs/warning" } }
} as const;

function normalizedResponseSchema(payloadName: "coordinate" | "coordinates" | "geometry" | "feature" | "featureCollection", payload: object): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: [
      payloadName,
      "crs",
      "axisOrder",
      "coordinateCount",
      "zTransformed",
      "transformation",
      "warnings"
    ],
    properties: { [payloadName]: payload, ...metadataProperties },
    $defs: geoJsonDefs
  };
}

const checkSourceInput = getContractSchema("capabilities/crs.check-source/input-1.0.schema.json");
const checkSourceOutput = getContractSchema("capabilities/crs.check-source/output-1.0.schema.json");
const pointInput = getContractSchema("capabilities/crs.normalize.point/input-1.0.schema.json");
const pointsInput = getContractSchema("capabilities/crs.normalize.points/input-1.0.schema.json");
const geometryInput = getContractSchema("capabilities/crs.normalize.geometry/input-1.0.schema.json");
const featureInput = getContractSchema("capabilities/crs.normalize.feature/input-1.0.schema.json");
const featureCollectionInput = getContractSchema("capabilities/crs.normalize.feature-collection/input-1.0.schema.json");

const pointOutput = getContractSchema("capabilities/crs.normalize.point/output-1.0.schema.json");
const pointsOutput = getContractSchema("capabilities/crs.normalize.points/output-1.0.schema.json");
const upstreamGeometryOutput = normalizedResponseSchema("geometry", { $ref: "#/$defs/geometry" });
const geometryOutput = getContractSchema("capabilities/crs.normalize.geometry/output-1.0.schema.json");
const featureOutput = getContractSchema("capabilities/crs.normalize.feature/output-1.0.schema.json");
const featureCollectionOutput = getContractSchema("capabilities/crs.normalize.feature-collection/output-1.0.schema.json");

export interface CrsOperationSchemas {
  input: JsonSchema;
  output: JsonSchema;
  upstreamOutput: JsonSchema;
  inputSchemaUri: string;
  outputSchemaUri: string;
}

export const CRS_OPERATION_SCHEMAS: Readonly<Record<CrsOperationId, CrsOperationSchemas>> = {
  "crs.check-source": {
    input: checkSourceInput,
    output: checkSourceOutput,
    upstreamOutput: checkSourceOutput,
    inputSchemaUri: "urn:gowm:capability:crs.check-source:input:1.0",
    outputSchemaUri: "urn:gowm:capability:crs.check-source:output:1.0"
  },
  "crs.normalize.point": {
    input: pointInput,
    output: pointOutput,
    upstreamOutput: pointOutput,
    inputSchemaUri: "urn:gowm:capability:crs.normalize.point:input:1.0",
    outputSchemaUri: "urn:gowm:capability:crs.normalize.point:output:1.0"
  },
  "crs.normalize.points": {
    input: pointsInput,
    output: pointsOutput,
    upstreamOutput: pointsOutput,
    inputSchemaUri: "urn:gowm:capability:crs.normalize.points:input:1.0",
    outputSchemaUri: "urn:gowm:capability:crs.normalize.points:output:1.0"
  },
  "crs.normalize.geometry": {
    input: geometryInput,
    output: geometryOutput,
    upstreamOutput: upstreamGeometryOutput,
    inputSchemaUri: "urn:gowm:capability:crs.normalize.geometry:input:1.0",
    outputSchemaUri: "urn:gowm:capability:crs.normalize.geometry:output:1.0"
  },
  "crs.normalize.feature": {
    input: featureInput,
    output: featureOutput,
    upstreamOutput: featureOutput,
    inputSchemaUri: "urn:gowm:capability:crs.normalize.feature:input:1.0",
    outputSchemaUri: "urn:gowm:capability:crs.normalize.feature:output:1.0"
  },
  "crs.normalize.feature-collection": {
    input: featureCollectionInput,
    output: featureCollectionOutput,
    upstreamOutput: featureCollectionOutput,
    inputSchemaUri: "urn:gowm:capability:crs.normalize.feature-collection:input:1.0",
    outputSchemaUri: "urn:gowm:capability:crs.normalize.feature-collection:output:1.0"
  }
};

export const POC_OPENAPI_SHA256 = "sha256:cd261d963c074394e01addeff32fad16dcdaef03bd2ae9f44dafae57ab9f6c06";
export const POC_SOURCE_ZIP_SHA256 = "sha256:3110e7b344d138908d27e759ede70701b8a20dd7bbbd9795b3a57d02b8d70995";
