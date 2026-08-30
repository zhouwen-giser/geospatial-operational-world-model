import { getContractSchema,getContractSchemaHash } from "../../../../packages/platform/contract-runtime/src/index.js";
import type { JsonSchema } from "../../../../packages/platform/provider-sdk/src/index.js";

export const OPERATIONAL_REALITY_OPERATION_IDS = [
  "operational-task.find","operational-task.get","operational-task.get-timeline",
  "operational-task.find-by-correlation","world-event.find-by-correlation",
  "correlation.resolve","predicate.evaluate","observability.evaluate",
  "operational-task.get-execution-intervals"
] as const;
export type OperationalRealityOperationId = (typeof OPERATIONAL_REALITY_OPERATION_IDS)[number];

const names: Record<OperationalRealityOperationId,readonly [string,string]> = {
  "operational-task.find": ["operational-query-request","operational-query-result"],
  "operational-task.get": ["operational-query-request","operational-task-snapshot"],
  "operational-task.get-timeline": ["operational-query-request","operational-event-timeline"],
  "operational-task.find-by-correlation": ["operational-query-request","operational-query-result"],
  "world-event.find-by-correlation": ["operational-query-request","operational-event-timeline"],
  "correlation.resolve": ["operational-query-request","correlation-finding"],
  "predicate.evaluate": ["external-predicate","predicate-evaluation"],
  "observability.evaluate": ["operational-query-request","observability-assessment"],
  "operational-task.get-execution-intervals": ["task-execution-interval-query","task-execution-interval-result"]
};

export interface OperationalSchemas {
  input: JsonSchema;output: JsonSchema;inputSchemaUri: string;outputSchemaUri: string;
  inputSchemaHash: `sha256:${string}`;outputSchemaHash: `sha256:${string}`;
}
export const OPERATIONAL_REALITY_SCHEMAS = Object.fromEntries(
  Object.entries(names).map(([operationId,[inputName,outputName]]) => {
    const version=operationId==="operational-task.get-execution-intervals"?"v0.7":"v0.4";
    const inputSchemaUri=`urn:gowm:${version}:${inputName}`;
    const outputSchemaUri=`urn:gowm:${version}:${outputName}`;
    return [operationId,{
      input:getContractSchema(inputSchemaUri),output:getContractSchema(outputSchemaUri),
      inputSchemaUri,outputSchemaUri,inputSchemaHash:getContractSchemaHash(inputSchemaUri),
      outputSchemaHash:getContractSchemaHash(outputSchemaUri)
    }];
  })
) as Record<OperationalRealityOperationId,OperationalSchemas>;
