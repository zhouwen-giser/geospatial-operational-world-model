import {
  getContractSchemaHash,
  validateContract
} from "../../../platform/contract-runtime/src/index.js";
import {
  FoundationPortError,
  type OperationSchemaAttestation
} from "../../../platform/foundation-ports/src/index.js";

export const FOUNDATION_OPERATION_SCHEMAS = Object.freeze({
  geometryValidate: schemaPair("geometry.validate"),
  crsNormalizeGeometry: schemaPair("crs.normalize.geometry"),
  h3IndexPoints: schemaPair("h3.index.points"),
  h3ProjectPoint: schemaPair("gowm.foundation.h3.project-point")
});

function schemaPair(operationId: string): OperationSchemaAttestation {
  return Object.freeze({
    inputSchemaHash: getContractSchemaHash(`urn:gowm:capability:${operationId}:input:1.0`),
    outputSchemaHash: getContractSchemaHash(`urn:gowm:capability:${operationId}:output:1.0`)
  });
}

export function assertOperationInput(operationId: string, value: unknown): void {
  assertOperationContract(operationId, "input", value);
}

export function assertOperationOutput(operationId: string, value: unknown): void {
  assertOperationContract(operationId, "output", value);
}

function assertOperationContract(operationId: string, direction: "input" | "output", value: unknown): void {
  const contract = `urn:gowm:capability:${operationId}:${direction}:1.0`;
  const validation = validateContract(contract, value);
  if (validation.valid) return;
  throw new FoundationPortError(
    direction === "input" ? "FOUNDATION_INVALID_INPUT" : "FOUNDATION_INVALID_ENGINE_RESULT",
    `${operationId}@1.0 ${direction} failed its locked contract`,
    {
      stage: direction === "input" ? "REQUEST_VALIDATION" : "RESULT_ASSEMBLY",
      retryable: false,
      details: {
        contract,
        issues: validation.issues,
        fallbackApplied: false
      }
    }
  );
}
