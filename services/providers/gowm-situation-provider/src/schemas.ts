import { getContractSchema } from "../../../../packages/platform/contract-runtime/src/index.js";
import { sha256, type JsonSchema } from "../../../../packages/platform/provider-sdk/src/index.js";

export const GOWM_SITUATION_OPERATION_IDS = [
  "gowm.situation.h3.get-cell",
  "gowm.situation.h3.get-area",
  "gowm.situation.h3.get-hotspots",
  "gowm.situation.h3.get-coverage-gaps"
] as const;

export type GowmSituationOperationId = (typeof GOWM_SITUATION_OPERATION_IDS)[number];

export interface SituationOperationSchemaPair {
  input: JsonSchema;
  output: JsonSchema;
  inputSchemaUri: string;
  outputSchemaUri: string;
  inputSchemaHash: `sha256:${string}`;
  outputSchemaHash: `sha256:${string}`;
}

function schema(operationId: GowmSituationOperationId, direction: "input" | "output"): JsonSchema {
  return getContractSchema(`urn:gowm:capability:${operationId}:${direction}:1.0`);
}

export const GOWM_SITUATION_OPERATION_SCHEMAS: Readonly<Record<GowmSituationOperationId, SituationOperationSchemaPair>> =
  Object.fromEntries(GOWM_SITUATION_OPERATION_IDS.map((operationId) => {
    const input = schema(operationId, "input");
    const output = schema(operationId, "output");
    return [operationId, {
      input,
      output,
      inputSchemaUri: `urn:gowm:capability:${operationId}:input:1.0`,
      outputSchemaUri: `urn:gowm:capability:${operationId}:output:1.0`,
      inputSchemaHash: sha256(input),
      outputSchemaHash: sha256(output)
    }];
  })) as Record<GowmSituationOperationId, SituationOperationSchemaPair>;

