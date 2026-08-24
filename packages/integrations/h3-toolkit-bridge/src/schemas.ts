import { getContractSchema } from "../../../platform/contract-runtime/src/index.js";
import type { JsonSchema } from "../../../platform/provider-sdk/src/index.js";
import type { H3OperationId } from "./types.js";

interface H3OperationSchemas {
  input: JsonSchema;
  output: JsonSchema;
  inputSchemaUri: string;
  outputSchemaUri: string;
}

const OPERATION_FILES: Readonly<Record<H3OperationId, string>> = Object.freeze({
  "h3.index.points": "h3.index.points",
  "h3.geometry.cover": "h3.geometry.cover",
  "h3.cells.to-geojson": "h3.cells.to-geojson",
  "h3.neighborhood.disk": "h3.neighborhood.disk",
  "h3.hierarchy.parent": "h3.hierarchy.parent",
  "h3.hierarchy.children": "h3.hierarchy.children",
  "h3.hierarchy.compact": "h3.hierarchy.compact",
  "h3.hierarchy.uncompact": "h3.hierarchy.uncompact",
  "h3.analytics.aggregate": "h3.analytics.aggregate",
  "h3.analytics.coverage": "h3.analytics.coverage",
  "h3.analytics.flow": "h3.analytics.flow"
});

export const H3_OPERATION_SCHEMAS: Readonly<Record<H3OperationId, H3OperationSchemas>> = Object.freeze(
  Object.fromEntries(Object.entries(OPERATION_FILES).map(([operationId, directory]) => [
    operationId,
    {
      input: schema(`capabilities/${directory}/input-1.0.schema.json`),
      output: schema(`capabilities/${directory}/output-1.0.schema.json`),
      inputSchemaUri: `urn:gowm:capability:${operationId}:input:1.0`,
      outputSchemaUri: `urn:gowm:capability:${operationId}:output:1.0`
    }
  ])) as unknown as Record<H3OperationId, H3OperationSchemas>
);

function schema(key: string): JsonSchema {
  const value = getContractSchema(key);
  if (typeof value === "boolean") throw new Error(`${key} must be an object JSON Schema`);
  return value;
}
