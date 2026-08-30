import { getContractSchema,getContractSchemaHash } from "../../../../packages/platform/contract-runtime/src/index.js";
import type { JsonSchema } from "../../../../packages/platform/provider-sdk/src/index.js";

export const HISTORICAL_TRACE_OPERATION_ID="history.get-trajectory" as const;
export const HISTORICAL_TRAJECTORY_INPUT_SCHEMA_URI="urn:gowm:v0.7:historical-trajectory-query";
export const HISTORICAL_TRAJECTORY_OUTPUT_SCHEMA_URI="urn:gowm:v0.7.1:historical-trajectory-result";

export const HISTORICAL_TRACE_SCHEMAS:{
  input:JsonSchema;output:JsonSchema;inputSchemaUri:string;outputSchemaUri:string;
  inputSchemaHash:`sha256:${string}`;outputSchemaHash:`sha256:${string}`;
}={
  input:getContractSchema(HISTORICAL_TRAJECTORY_INPUT_SCHEMA_URI),
  output:getContractSchema(HISTORICAL_TRAJECTORY_OUTPUT_SCHEMA_URI),
  inputSchemaUri:HISTORICAL_TRAJECTORY_INPUT_SCHEMA_URI,
  outputSchemaUri:HISTORICAL_TRAJECTORY_OUTPUT_SCHEMA_URI,
  inputSchemaHash:getContractSchemaHash(HISTORICAL_TRAJECTORY_INPUT_SCHEMA_URI),
  outputSchemaHash:getContractSchemaHash(HISTORICAL_TRAJECTORY_OUTPUT_SCHEMA_URI)
};
