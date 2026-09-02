import type { Geometry } from "../../../world-model-core/src/types.js";
import {
  FoundationPortError,
  FoundationReceiptFactory,
  type CrsNormalizationInput,
  type CrsNormalizationPort,
  type CrsNormalizationResult,
  type FoundationExecution,
  type GeometryValidationPort
} from "../../../platform/foundation-ports/src/index.js";
import { ExistingGeometryValidationAdapter } from "./geometry-validation-adapter.js";
import {
  FOUNDATION_OPERATION_SCHEMAS,
  assertOperationInput,
  assertOperationOutput
} from "./contract-attestations.js";

const CRS_POLICY_VERSION = "gowm.crs-canonical-input/1.0";

export class Canonical4326CrsNormalizationAdapter implements CrsNormalizationPort {
  constructor(
    private readonly geometry: GeometryValidationPort = new ExistingGeometryValidationAdapter(),
    private readonly receipts: FoundationReceiptFactory = new FoundationReceiptFactory()
  ) {}

  async normalizeGeometry(input: CrsNormalizationInput): Promise<FoundationExecution<CrsNormalizationResult>> {
    const startedAt = this.receipts.start();
    if (input.sourceCrs !== "EPSG:4326") {
      throw new FoundationPortError(
        "FOUNDATION_CRS_TRANSFORMATION_UNAVAILABLE",
        "Foundation v0.2 accepts only canonical EPSG:4326 geometry; non-identity transformation requires the CRS Provider",
        {
          stage: "POLICY",
          retryable: false,
          details: {
            sourceCrs: input.sourceCrs,
            targetCrs: "EPSG:4326",
            requiredCapability: "crs.normalize.geometry@1.0",
            licenseStatus: "APPROVED",
            redistributionAllowed: true,
            fallbackApplied: false
          }
        }
      );
    }
    assertOperationInput("crs.normalize.geometry", input);

    const validation = await this.geometry.assertValid(input.geometry);
    const result: CrsNormalizationResult = {
      geometry: structuredClone(input.geometry),
      sourceCrs: "EPSG:4326",
      targetCrs: "EPSG:4326",
      axisOrder: ["longitude", "latitude"],
      coordinateCount: coordinateCount(input.geometry),
      zTransformed: false,
      normalizationMethod: "CANONICAL_IDENTITY",
      transformation: {
        engine: "GOWM",
        engineVersion: "0.2.0",
        integration: "foundation-local",
        integrationVersion: "0.2.0",
        sourceCrs: "EPSG:4326",
        targetCrs: "EPSG:4326",
        strictBestOperation: true,
        networkEnabled: false,
        cacheHit: false
      },
      warnings: [
        {
          code: "SOURCE_ALREADY_WGS84",
          message: "Input is already canonical EPSG:4326; no coordinate transformation was performed"
        }
      ]
    };
    assertOperationOutput("crs.normalize.geometry", result);
    const execution = this.receipts.complete({
      startedAt,
      operationId: "crs.normalize.geometry",
      operationVersion: "1.0",
      schemas: FOUNDATION_OPERATION_SCHEMAS.crsNormalizeGeometry,
      engine: {
        name: "gowm.canonical-geometry-identity",
        version: "1.0.0"
      },
      method: {
        methodId: "canonical-epsg4326-identity",
        methodVersion: "1.0.0"
      },
      policyVersion: CRS_POLICY_VERSION,
      policy: {
        acceptedSourceCrs: ["EPSG:4326"],
        targetCrs: "EPSG:4326",
        transformationFallback: "DENY"
      },
      input,
      result,
      changes: {
        repairApplied: false,
        typeChanged: false,
        inputGeometryType: input.geometry.type,
        outputGeometryType: result.geometry.type
      },
      warnings: result.warnings.map((warning) => warning.code)
    });
    return {
      ...execution,
      supportingReceipts: [
        {
          computeSnapshot: validation.computeSnapshot,
          receipt: validation.receipt
        }
      ]
    };
  }
}

function coordinateCount(geometry: Geometry): number {
  if (geometry.type === "Point") return 1;
  if (geometry.type === "LineString") return geometry.coordinates.length;
  if (geometry.type === "Polygon") {
    return geometry.coordinates.reduce((total, ring) => total + ring.length, 0);
  }
  return geometry.coordinates.reduce(
    (total, polygon) => total + polygon.reduce((polygonTotal, ring) => polygonTotal + ring.length, 0),
    0
  );
}
