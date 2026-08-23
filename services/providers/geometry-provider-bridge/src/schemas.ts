import {
  getContractSchema,
  getContractSchemaHash,
  type CapabilityDescriptor
} from "../../../../packages/platform/contract-runtime/src/index.js";
import type { GeometryOperationId } from "./types.js";

export const POC_SOURCE_ZIP_SHA256 = "sha256:3527a06d7a6216c1bf1c2ee75690824298231917c03a8c99507a71df26f12c3d" as const;
export const POC_OPENAPI_SHA256 = "sha256:f45ad64ab0781289e960e826dde220db85c295d45d2d69e4f1afbf163e7cd600" as const;
export const POC_GEOS_VERSION = "3.13.0-CAPI-1.19.0" as const;
export const POC_INTEGRATION_VERSION = "3.1.1" as const;

export interface GeometryOperationSchemas {
  inputSchemaUri: string;
  inputSchemaHash: `sha256:${string}`;
  input: Readonly<Record<string, unknown>>;
  outputSchemaUri: string;
  outputSchemaHash: `sha256:${string}`;
  output: Readonly<Record<string, unknown>>;
  upstreamOutput: Readonly<Record<string, unknown>>;
  inputValueKind: CapabilityDescriptor["ports"]["inputs"][number]["valueKind"];
  outputValueKind: CapabilityDescriptor["ports"]["outputs"][number]["valueKind"];
}

const GEOMETRY_OUTPUT = { $ref: "urn:gowm:capability:geometry-provider:definitions:1.0#/$defs/pocGeometryResult" } as const;
const SCALAR_OUTPUT = { $ref: "urn:gowm:capability:geometry-provider:definitions:1.0#/$defs/pocScalarResult" } as const;
const VALIDATION_OUTPUT = { $ref: "urn:gowm:capability:geometry-provider:definitions:1.0#/$defs/pocValidationResult" } as const;

export const GEOMETRY_OPERATION_SCHEMAS: Readonly<Record<GeometryOperationId, GeometryOperationSchemas>> = Object.freeze({
  "geometry.validate": operationSchemas("geometry.validate", VALIDATION_OUTPUT, "GEOMETRY", "ANY"),
  "geometry.normalize": operationSchemas("geometry.normalize", GEOMETRY_OUTPUT, "GEOMETRY", "GEOMETRY"),
  "geometry.force-2d": operationSchemas("geometry.force-2d", GEOMETRY_OUTPUT, "GEOMETRY", "GEOMETRY"),
  "geometry.remove-repeated-points": operationSchemas("geometry.remove-repeated-points", GEOMETRY_OUTPUT, "GEOMETRY", "GEOMETRY"),
  "geometry.centroid": operationSchemas("geometry.centroid", GEOMETRY_OUTPUT, "GEOMETRY", "GEOMETRY"),
  "geometry.bounding-box": operationSchemas("geometry.bounding-box", GEOMETRY_OUTPUT, "GEOMETRY", "GEOMETRY"),
  "geometry.geometry-hash": operationSchemas("geometry.geometry-hash", SCALAR_OUTPUT, "GEOMETRY", "SCALAR"),
  "geometry.predicate": operationSchemas("geometry.predicate", SCALAR_OUTPUT, "ANY", "SCALAR"),
  "geometry.make-valid": operationSchemas("geometry.make-valid", GEOMETRY_OUTPUT, "GEOMETRY", "GEOMETRY"),
  "geometry.buffer": operationSchemas("geometry.buffer", GEOMETRY_OUTPUT, "GEOMETRY", "GEOMETRY"),
  "geometry.intersection": operationSchemas("geometry.intersection", GEOMETRY_OUTPUT, "ANY", "GEOMETRY"),
  "geometry.union": operationSchemas("geometry.union", GEOMETRY_OUTPUT, "ANY", "GEOMETRY"),
  "geometry.difference": operationSchemas("geometry.difference", GEOMETRY_OUTPUT, "ANY", "GEOMETRY"),
  "geometry.symmetric-difference": operationSchemas("geometry.symmetric-difference", GEOMETRY_OUTPUT, "ANY", "GEOMETRY"),
  "geometry.simplify": operationSchemas("geometry.simplify", GEOMETRY_OUTPUT, "GEOMETRY", "GEOMETRY"),
  "geometry.simplify-preserve-topology": operationSchemas("geometry.simplify-preserve-topology", GEOMETRY_OUTPUT, "GEOMETRY", "GEOMETRY"),
  "geometry.convex-hull": operationSchemas("geometry.convex-hull", GEOMETRY_OUTPUT, "GEOMETRY", "GEOMETRY"),
  "geometry.closest-point": operationSchemas("geometry.closest-point", GEOMETRY_OUTPUT, "ANY", "GEOMETRY"),
  "geometry.shortest-line": operationSchemas("geometry.shortest-line", GEOMETRY_OUTPUT, "ANY", "GEOMETRY")
});

function operationSchemas(
  operationId: GeometryOperationId,
  upstreamOutput: Readonly<Record<string, unknown>>,
  inputValueKind: GeometryOperationSchemas["inputValueKind"],
  outputValueKind: GeometryOperationSchemas["outputValueKind"]
): GeometryOperationSchemas {
  const inputSchemaUri = `urn:gowm:capability:${operationId}:input:1.0`;
  const outputSchemaUri = `urn:gowm:capability:${operationId}:output:1.0`;
  return {
    inputSchemaUri,
    inputSchemaHash: getContractSchemaHash(inputSchemaUri),
    input: getContractSchema(inputSchemaUri),
    outputSchemaUri,
    outputSchemaHash: getContractSchemaHash(outputSchemaUri),
    output: getContractSchema(outputSchemaUri),
    upstreamOutput,
    inputValueKind,
    outputValueKind
  };
}
