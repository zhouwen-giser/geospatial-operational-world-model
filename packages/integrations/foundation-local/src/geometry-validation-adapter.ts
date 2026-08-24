import { validateGeometry } from "../../../spatial-engine/src/geometry.js";
import type { Geometry } from "../../../world-model-core/src/types.js";
import {
  FoundationPortError,
  FoundationReceiptFactory,
  type FoundationExecution,
  type GeometryValidationPort,
  type GeometryValidationResult
} from "../../../platform/foundation-ports/src/index.js";
import {
  FOUNDATION_OPERATION_SCHEMAS,
  assertOperationInput,
  assertOperationOutput
} from "./contract-attestations.js";

export interface GeometryValidationPolicy {
  policyVersion: string;
  repairMode: "REJECT";
}

export const DEFAULT_GEOMETRY_VALIDATION_POLICY: GeometryValidationPolicy = Object.freeze({
  policyVersion: "gowm.geometry-validation/1.0",
  repairMode: "REJECT"
});

export class ExistingGeometryValidationAdapter implements GeometryValidationPort {
  constructor(
    private readonly receipts: FoundationReceiptFactory = new FoundationReceiptFactory(),
    private readonly policy: GeometryValidationPolicy = DEFAULT_GEOMETRY_VALIDATION_POLICY
  ) {
    if ((policy as { repairMode?: unknown }).repairMode !== "REJECT") {
      throw new FoundationPortError(
        "FOUNDATION_REPAIR_POLICY_DENIED",
        "Foundation geometry repair is disabled; a separate, explicit versioned policy is required",
        {
          stage: "POLICY",
          retryable: false,
          details: {
            requestedRepairMode: (policy as { repairMode?: unknown }).repairMode ?? null,
            fallbackApplied: false
          }
        }
      );
    }
  }

  async validate(geometry: Geometry): Promise<FoundationExecution<GeometryValidationResult>> {
    const startedAt = this.receipts.start();
    assertOperationInput("geometry.validate", { geometry });
    let issues: string[];
    try {
      issues = validateGeometry(geometry);
    } catch (error) {
      throw new FoundationPortError("FOUNDATION_INVALID_INPUT", "Geometry input is not structurally valid", {
        stage: "REQUEST_VALIDATION",
        retryable: false,
        details: { fallbackApplied: false },
        cause: error
      });
    }

    const result: GeometryValidationResult = {
      valid: issues.length === 0,
      issues: [...issues],
      repairApplied: false,
      policyVersion: this.policy.policyVersion
    };
    assertOperationOutput("geometry.validate", result);
    return this.receipts.complete({
      startedAt,
      operationId: "geometry.validate",
      operationVersion: "1.0",
      schemas: FOUNDATION_OPERATION_SCHEMAS.geometryValidate,
      engine: {
        name: "gowm.spatial-engine",
        version: "0.1.0"
      },
      method: {
        methodId: "validateGeometry",
        methodVersion: "1.0.0"
      },
      policyVersion: this.policy.policyVersion,
      policy: {
        repairMode: this.policy.repairMode
      },
      input: { geometry },
      result,
      changes: {
        repairApplied: false,
        typeChanged: false,
        inputGeometryType: geometry.type,
        outputGeometryType: geometry.type
      }
    });
  }

  async assertValid(geometry: Geometry): Promise<FoundationExecution<GeometryValidationResult>> {
    const execution = await this.validate(geometry);
    if (!execution.result.valid) {
      throw new FoundationPortError(
        "FOUNDATION_GEOMETRY_INVALID",
        "Geometry was rejected before current projection",
        {
          stage: "REQUEST_VALIDATION",
          retryable: false,
          details: {
            issues: execution.result.issues,
            validationReceiptId: execution.receipt.receiptId,
            repairApplied: false,
            fallbackApplied: false
          },
          receipt: execution.receipt
        }
      );
    }
    return execution;
  }
}
