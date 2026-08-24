import {
  getContractSchema,
  getContractSchemaHash
} from "../../../../packages/platform/contract-runtime/src/index.js";
import type { JsonSchema } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { GroundingCatalogMode } from "./types.js";

export const REFERENCE_OPERATION_IDS = [
  "reference.get",
  "reference.resolve",
  "reference.validate",
  "reference.batch-get",
  "reference.search"
] as const;

export const DATASET_OPERATION_IDS = [
  "dataset.get",
  "dataset.list",
  "layer.get",
  "layer.list",
  "layer.find-features",
  "feature.get"
] as const;

export const EVIDENCE_OPERATION_IDS = [
  "world.get-current-state",
  "world.get-geometry",
  "world.get-provenance",
  "world.get-observations",
  "world.get-event-timeline",
  "world.get-state-history",
  "result.get",
  "result.validate",
  "reference-set.get-members"
] as const;

export type ReferenceOperationId = (typeof REFERENCE_OPERATION_IDS)[number];
export type DatasetOperationId = (typeof DATASET_OPERATION_IDS)[number];
export type EvidenceOperationId = (typeof EVIDENCE_OPERATION_IDS)[number];
export type GroundingCatalogOperationId = ReferenceOperationId | DatasetOperationId | EvidenceOperationId;

const schemaNames: Record<GroundingCatalogOperationId, readonly [string, string]> = {
  "reference.get": ["catalog-query-request", "reference-descriptor"],
  "reference.resolve": ["reference-resolve-request", "reference-resolve-result"],
  "reference.validate": ["reference-validate-request", "reference-validate-result"],
  "reference.batch-get": ["reference-validate-request", "catalog-result"],
  "reference.search": ["reference-resolve-request", "reference-resolve-result"],
  "dataset.get": ["catalog-query-request", "dataset-descriptor"],
  "dataset.list": ["catalog-query-request", "catalog-result"],
  "layer.get": ["catalog-query-request", "layer-descriptor"],
  "layer.list": ["catalog-query-request", "catalog-result"],
  "layer.find-features": ["catalog-query-request", "catalog-result"],
  "feature.get": ["catalog-query-request", "spatial-feature-descriptor"],
  "world.get-current-state": ["catalog-query-request", "world-fact-result"],
  "world.get-geometry": ["catalog-query-request", "world-fact-result"],
  "world.get-provenance": ["catalog-query-request", "world-fact-result"],
  "world.get-observations": ["catalog-query-request", "catalog-result"],
  "world.get-event-timeline": ["catalog-query-request", "catalog-result"],
  "world.get-state-history": ["catalog-query-request", "catalog-result"],
  "result.get": ["catalog-query-request", "query-result-reference"],
  "result.validate": ["catalog-query-request", "reference-validate-result"],
  "reference-set.get-members": ["catalog-query-request", "reference-set"]
};

export interface OperationSchemas {
  input: JsonSchema;
  output: JsonSchema;
  inputSchemaUri: string;
  outputSchemaUri: string;
  inputSchemaHash: `sha256:${string}`;
  outputSchemaHash: `sha256:${string}`;
}

export const GROUNDING_CATALOG_OPERATION_SCHEMAS = Object.fromEntries(
  Object.entries(schemaNames).map(([operationId, [inputName, outputName]]) => {
    const inputSchemaUri = `urn:gowm:v0.4:${inputName}`;
    const outputSchemaUri = `urn:gowm:v0.4:${outputName}`;
    return [operationId, {
      input: getContractSchema(inputSchemaUri),
      output: getContractSchema(outputSchemaUri),
      inputSchemaUri,
      outputSchemaUri,
      inputSchemaHash: getContractSchemaHash(inputSchemaUri),
      outputSchemaHash: getContractSchemaHash(outputSchemaUri)
    }];
  })
) as Record<GroundingCatalogOperationId, OperationSchemas>;

export function operationsForMode(mode: GroundingCatalogMode): readonly GroundingCatalogOperationId[] {
  return mode === "reference" ? REFERENCE_OPERATION_IDS : mode === "dataset" ? DATASET_OPERATION_IDS : EVIDENCE_OPERATION_IDS;
}
