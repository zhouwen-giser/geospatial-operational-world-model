import {
  getContractSchema,
  getContractSchemaHash
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { sha256, type JsonSchema } from "../../../../packages/platform/provider-sdk/src/index.js";

export const SPATIAL_OPERATION_IDS = [
  "spatial.find-nearby",
  "spatial.find-nearest",
  "spatial.find-in-area",
  "spatial.find-intersections",
  "spatial.find-near-route",
  "spatial.find-containing-area",
  "spatial.count-in-area",
  "spatial.summarize-area",
  "spatial.join",
  "spatial.aggregate"
] as const;

export type SpatialOperationId = (typeof SPATIAL_OPERATION_IDS)[number];

function schemaFor(operationId: SpatialOperationId, direction: "input" | "output"): JsonSchema {
  return getContractSchema(`urn:gowm:capability:${operationId}:${direction}:1.0`);
}

export interface SpatialOperationSchemaPair {
  input: JsonSchema;
  output: JsonSchema;
  inputSchemaUri: string;
  outputSchemaUri: string;
  inputSchemaHash: `sha256:${string}`;
  outputSchemaHash: `sha256:${string}`;
}

export const SPATIAL_OPERATION_SCHEMAS: Readonly<Record<SpatialOperationId, SpatialOperationSchemaPair>> = Object.fromEntries(
  SPATIAL_OPERATION_IDS.map((operationId) => {
    const input = schemaFor(operationId, "input");
    const output = schemaFor(operationId, "output");
    return [operationId, {
      input,
      output,
      inputSchemaUri: `urn:gowm:capability:${operationId}:input:1.0`,
      outputSchemaUri: `urn:gowm:capability:${operationId}:output:1.0`,
      inputSchemaHash: getContractSchemaHash(`urn:gowm:capability:${operationId}:input:1.0`),
      outputSchemaHash: getContractSchemaHash(`urn:gowm:capability:${operationId}:output:1.0`)
    }];
  })
) as Record<SpatialOperationId, SpatialOperationSchemaPair>;

export const SPATIAL_SOURCE_ZIP_SHA256 = "sha256:15cdaf00f3c5ee911eac1351c2d9a59ff06a5de93a176ce81b644b19ee5de322";
export const SPATIAL_OPENAPI_SHA256 = "sha256:ab22b8fd16adf48d91e8c5ed477a88a36268de958e4cd9359e756204c2701882";
export const SPATIAL_CONTRACT_TREE_SHA256 = "sha256:e04d74689caec0fee2bbdb2eb970ca43e2c22bbab3dc97d966c6471d1a711ae4";
export const SPATIAL_DEFINITIONS_SCHEMA_SHA256 = getContractSchemaHash("urn:gowm:capability:spatial-provider:operations:1.0");
export const GOWM_SPATIAL_V1_MIGRATION_SHA256 = "sha256:a04f0c58ce5f5f6c4cdc850e18ef42f7da78f06ed56cb276d21774fba28afe10";
export const CURRENT_OBJECT_EVIDENCE_SCHEMA_SHA256 = sha256({
  contract: "gowm_spatial_v1.current_object",
  version: "1"
});
export const LAYER_FEATURE_EVIDENCE_SCHEMA_SHA256 = sha256({
  contract: "gowm_spatial_v1.layer_feature",
  version: "1"
});
