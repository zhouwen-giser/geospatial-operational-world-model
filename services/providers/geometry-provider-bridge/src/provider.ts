import semanticProfiles0 from "./semantic-profiles.geometry.json" with { type: "json" };
import { declaredSemanticProfile } from "../../../../packages/platform/provider-sdk/src/declared-semantics.js";
const DECLARED_SEMANTICS = { ...semanticProfiles0 };
import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  GeometryProviderDefinitionsGeometryOutput,
  GeometryProviderDefinitionsHashOutput,
  GeometryProviderDefinitionsOperand,
  GeometryProviderDefinitionsPredicateOutput,
  GeometryValidateOutputV1
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { getContractSchemaHash } from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,
  ProviderProtocolError,
  sha256,
  type ProviderOperation,
  type ProviderOperationResult,
  type ProviderRuntime
} from "../../../../packages/platform/provider-sdk/src/index.js";
import {
  GEOMETRY_OPERATION_SCHEMAS,
  POC_GEOS_VERSION,
  POC_INTEGRATION_VERSION,
  POC_OPENAPI_SHA256,
  POC_SOURCE_ZIP_SHA256
} from "./schemas.js";
import { GeometryUpstreamClient } from "./upstream-client.js";
import {
  GEOMETRY_OPERATION_IDS,
  type GeometryDeploymentAttestation,
  type GeometryOperationId,
  type GeometryProviderBridgeOptions,
  type GeometrySummary,
  type PocGeometryResult,
  type PocScalarResult,
  type PocValidationResult
} from "./types.js";

const PROVIDER_ID = "gowm.geometry.bridge";
const PROVIDER_VERSION = "0.2.0";
const POLICY_VERSION = "gowm-geometry-bridge-policy/1.0";
const VALIDATION_POLICY_VERSION = "gowm-geometry-validation/1.0";

const HIGH_COST_OPERATIONS = new Set<GeometryOperationId>([
  "geometry.make-valid",
  "geometry.buffer",
  "geometry.intersection",
  "geometry.union",
  "geometry.difference",
  "geometry.symmetric-difference",
  "geometry.simplify-preserve-topology",
  "geometry.convex-hull",
  "geometry.closest-point",
  "geometry.shortest-line"
]);

export interface GeometryProviderBridge {
  runtime: ProviderRuntime;
  upstream: GeometryUpstreamClient;
}

export function createGeometryProviderBridge(options: GeometryProviderBridgeOptions): GeometryProviderBridge {
  if (
    options.attestation.sourceZipSha256 !== POC_SOURCE_ZIP_SHA256 ||
    options.attestation.openApiSha256 !== POC_OPENAPI_SHA256 ||
    options.attestation.geosVersion !== POC_GEOS_VERSION ||
    options.attestation.integrationVersion !== POC_INTEGRATION_VERSION
  ) {
    throw new Error("Geometry deployment does not match the locked POC source/OpenAPI/engine/integration attestation");
  }
  const upstream = new GeometryUpstreamClient(
    options.endpoint,
    options.attestation,
    options.fetch,
    options.maximumInFlight,
    options.maximumQueueSize
  );
  const operations = GEOMETRY_OPERATION_IDS.map((operationId) => createOperation(operationId, upstream, options.attestation));
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0", manifestSchemaVersion: "1.1",
    provider: {
      providerId: PROVIDER_ID,
      providerVersion: PROVIDER_VERSION,
      owner: "gowm-platform",
      implementationDigest: sha256({
        bridge: PROVIDER_ID,
        version: PROVIDER_VERSION,
        sourceZipSha256: options.attestation.sourceZipSha256,
        openApiSha256: options.attestation.openApiSha256,
        engine: options.attestation.engine,
        engineVersion: options.attestation.geosVersion,
        integration: `${options.attestation.integration}@${options.attestation.integrationVersion}`,
        allowedOperations: GEOMETRY_OPERATION_IDS
      }),
      sourceRef: "urn:gowm:source:zip:geometry-tool-service:1.0.0"
    },
    endpoints: {
      manifest: "/v1/manifest",
      liveness: "/health/live",
      readiness: "/health/ready",
      execute: "/v1/operations/{operationId}:execute",
      job: "/v1/jobs/{jobId}"
    },
    capabilities: operations.map((operation) => operation.descriptor)
  };
  const policy = {
    version: POLICY_VERSION,
    immutableValidation: true,
    implicitRepairAllowed: false,
    explicitRepairOperation: "geometry.make-valid",
    units: "COORDINATE_SPACE_UNITS",
    geographicBufferRequiresPlanarAcknowledgement: true,
    providerCallsAllowed: false,
    arbitraryUrlAllowed: false,
    workerPoolRequired: true,
    sourceRedistributionAllowed: false,
    approvedEndpoint: {
      endpointId: options.endpoint.endpointId,
      configurationDigest: options.endpoint.configurationDigest
    },
    allowedOperations: GEOMETRY_OPERATION_IDS
  } as const;
  return {
    upstream,
    runtime: createProviderRuntime({
      manifest,
      operations,
      policyVersion: policy.version,
      policyDigest: sha256(policy),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.receiptId === undefined ? {} : { receiptId: options.receiptId })
    })
  };
}

function createOperation(
  operationId: GeometryOperationId,
  upstream: GeometryUpstreamClient,
  attestation: GeometryDeploymentAttestation
): ProviderOperation {
  const schemas = GEOMETRY_OPERATION_SCHEMAS[operationId];
  const scalar = operationId === "geometry.predicate" || operationId === "geometry.geometry-hash";
  const descriptor: CapabilityDescriptor = {
    operationId,
    operationVersion: "1.0", semanticProfile: declaredSemanticProfile(DECLARED_SEMANTICS, operationId, "1.0"),
    semanticRole: "FOUNDATION_PRIMITIVE",
    dataBinding: "CALLER_DATA_BOUND",
    resultSemantics: operationId === "geometry.validate"
      ? "VALIDATION"
      : scalar
        ? "DERIVED_ANALYSIS"
        : "TRANSFORMATION",
    executionBindings: ["SYNC_HTTP"],
    criticalPathPolicy: "REMOTE_ALLOWED",
    maturity: "PREVIEW",
    inputSchemaUri: schemas.inputSchemaUri,
    inputSchemaHash: schemas.inputSchemaHash,
    outputSchemaUri: schemas.outputSchemaUri,
    outputSchemaHash: schemas.outputSchemaHash,
    scopePolicy: "REQUEST_CONTEXT",
    execution: {
      mode: "SYNC",
      defaultTimeoutMs: HIGH_COST_OPERATIONS.has(operationId) ? 5_000 : 2_000,
      maximumTimeoutMs: 10_000,
      costClass: HIGH_COST_OPERATIONS.has(operationId) ? "HIGH" : "LOW"
    },
    limits: {
      maximumInputBytes: 16 * 1024 * 1024,
      maximumOutputBytes: 16 * 1024 * 1024,
      maximumBatchItems: 1,
      maximumVertices: 100_000
    },
    snapshotPolicy: { dataSnapshot: "NONE", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{
        name: "request",
        schemaUri: schemas.inputSchemaUri,
        schemaHash: schemas.inputSchemaHash,
        valueKind: schemas.inputValueKind,
        unitSemantics: "UNSPECIFIED"
      }],
      outputs: [{
        name: "result",
        schemaUri: schemas.outputSchemaUri,
        schemaHash: schemas.outputSchemaHash,
        valueKind: schemas.outputValueKind,
        unitSemantics: scalar ? "DIMENSIONLESS" : "UNSPECIFIED"
      }, ...geometryOutputSubports(operationId)]
    }
  };

  return {
    descriptor,
    inputSchema: schemas.input,
    outputSchema: schemas.output,
    method: {
      engine: attestation.engine,
      engineVersion: attestation.geosVersion,
      methodId: `geometry-tool-service/${methodName(operationId)}`,
      methodVersion: "1.0",
      artifacts: [
        {
          kind: "PACKAGE",
          name: attestation.integration,
          version: attestation.integrationVersion
        },
        {
          kind: "PACKAGE",
          name: "geometry-tool-service-locked-input",
          version: "1.0.0",
          digest: attestation.sourceZipSha256
        }
      ]
    },
    async handle(input, context): Promise<ProviderOperationResult<unknown>> {
      const raw = await upstream.execute(operationId, input, context.deadline, context.trace);
      const value = mapOutput(operationId, input, raw);
      const warnings = receiptWarnings(operationId, input, raw.warnings, attestation);
      const changes = geometryChanges(operationId, input, raw);
      return {
        status: "COMPLETED",
        value,
        warnings,
        consumption: consumption(raw),
        changes
      };
    }
  };
}

function geometryOutputSubports(operationId: GeometryOperationId): CapabilityDescriptor["ports"]["outputs"] {
  if (operationId === "geometry.validate") {
    return [{
      name: "valid",
      path: "/valid",
      schemaUri: "urn:gowm:v0.2:value:boolean",
      schemaHash: getContractSchemaHash("urn:gowm:v0.2:value:boolean"),
      valueKind: "SCALAR",
      unitSemantics: "DIMENSIONLESS"
    }];
  }
  if (operationId === "geometry.make-valid") {
    return [{
      name: "geometry",
      path: "/geometry",
      schemaUri: "urn:gowm:capability:geometry:geojson-geometry:1.0",
      schemaHash: getContractSchemaHash("urn:gowm:capability:geometry:geojson-geometry:1.0"),
      valueKind: "GEOMETRY",
      unitSemantics: "UNSPECIFIED"
    }];
  }
  return [];
}

function mapOutput(operationId: GeometryOperationId, input: unknown, raw: PocGeometryResult | PocScalarResult | PocValidationResult): unknown {
  if (operationId === "geometry.validate") {
    const validation = raw as PocValidationResult;
    const output: GeometryValidateOutputV1 = {
      valid: validation.detail.valid,
      issues: validation.detail.valid ? [] : [validation.detail.reason ?? "INVALID_GEOMETRY"],
      repairApplied: false,
      policyVersion: VALIDATION_POLICY_VERSION
    };
    return output;
  }

  const record = asRecord(input);
  const primary = primaryOperand(operationId, record);
  const warnings = mappedWarnings(operationId, primary.coordinateSpace, raw.warnings);

  if (operationId === "geometry.predicate") {
    const scalar = raw as PocScalarResult;
    const predicate = record.predicate as GeometryProviderDefinitionsPredicateOutput["predicate"];
    if (predicate === "relate" ? typeof scalar.result !== "string" : typeof scalar.result !== "boolean") {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "Geometry predicate result type does not match the requested predicate");
    }
    const output: GeometryProviderDefinitionsPredicateOutput = {
      predicate,
      value: scalar.result as boolean | string,
      units: "DIMENSIONLESS",
      warnings
    };
    return output;
  }

  if (operationId === "geometry.geometry-hash") {
    const scalar = raw as PocScalarResult;
    if (typeof scalar.result !== "string" || !/^[0-9a-f]{64}$/u.test(scalar.result)) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "Geometry hash upstream result is not a lowercase SHA-256 value");
    }
    const precision = isRecord(record.precision) && typeof record.precision.gridSize === "number"
      ? record.precision.gridSize
      : undefined;
    const output: GeometryProviderDefinitionsHashOutput = {
      hash: `sha256:${scalar.result}`,
      coordinateSpace: primary.coordinateSpace,
      ...(precision === undefined ? {} : { precisionGridSize: precision }),
      deterministicScope: "ENGINE_VERSION_INPUT_OPTIONS",
      warnings
    };
    return output;
  }

  const geometryResult = raw as PocGeometryResult;
  const coordinateLayout = outputCoordinateLayout(operationId, primary, geometryResult.summary);
  const output: GeometryProviderDefinitionsGeometryOutput = {
    geometry: geometryResult.result,
    coordinateSpace: primary.coordinateSpace,
    coordinateLayout,
    summary: {
      ...geometryResult.summary,
      coordinateLayout
    },
    warnings
  };
  return output;
}

function outputCoordinateLayout(
  operationId: GeometryOperationId,
  primary: GeometryProviderDefinitionsOperand,
  summary: GeometrySummary
): "XY" | "XYZ" {
  if (operationId === "geometry.force-2d") return "XY";
  if (summary.coordinateDimension >= 3) return "XYZ";
  if (summary.coordinateDimension === 0) return primary.coordinateLayout;
  return "XY";
}

function mappedWarnings(operationId: GeometryOperationId, coordinateSpace: string, upstream: readonly string[]): string[] {
  const units = operationId === "geometry.predicate"
    ? "Result is dimensionless."
    : coordinateSpace === "EPSG:4326" && operationId === "geometry.buffer"
      ? "Buffer distance was interpreted as angular coordinate-space degrees under explicit planar acknowledgement."
      : "Geometry parameters use the declared coordinate-space units.";
  return uniqueStrings([units, ...upstream]).slice(0, 128);
}

function receiptWarnings(
  operationId: GeometryOperationId,
  input: unknown,
  upstream: readonly string[],
  attestation: GeometryDeploymentAttestation
): string[] {
  const record = asRecord(input);
  const precision = isRecord(record.precision) && typeof record.precision.gridSize === "number"
    ? String(record.precision.gridSize)
    : "floating";
  const coordinateSpace = operationId === "geometry.validate"
    ? "UNSPECIFIED"
    : primaryOperand(operationId, record).coordinateSpace;
  const operationDetail = operationId === "geometry.predicate" && typeof record.predicate === "string"
    ? [`geometry.predicate=${record.predicate}`]
    : [];
  const units = operationId === "geometry.predicate"
    ? "dimensionless"
    : operationId === "geometry.validate"
      ? "topological"
      : "coordinate-space";
  return uniqueStrings([
    `geometry.coordinateSpace=${coordinateSpace}`,
    `geometry.precision=${precision}`,
    `geometry.units=${units}`,
    `geometry.engine=${attestation.engine}@${attestation.geosVersion}`,
    `geometry.integration=${attestation.integration}@${attestation.integrationVersion}`,
    `geometry.sourceZip=${attestation.sourceZipSha256}`,
    `geometry.openapi=${attestation.openApiSha256}`,
    "geometry.workerPool=true",
    "geometry.implicitRepair=false",
    ...(operationId === "geometry.make-valid" ? ["geometry.repair=explicit-make-valid"] : []),
    ...operationDetail,
    ...upstream
  ]);
}

function geometryChanges(
  operationId: GeometryOperationId,
  input: unknown,
  raw: PocGeometryResult | PocScalarResult | PocValidationResult
): NonNullable<ProviderOperationResult<unknown>["changes"]> {
  if (operationId === "geometry.validate" || operationId === "geometry.predicate" || operationId === "geometry.geometry-hash") {
    return { repairApplied: false, typeChanged: false };
  }
  const primary = primaryOperand(operationId, asRecord(input));
  const result = raw as PocGeometryResult;
  const inputGeometryType = geometryType(primary.geometry);
  const outputGeometryType = geometryType(result.result);
  return {
    repairApplied: operationId === "geometry.make-valid",
    typeChanged: result.summary.typeChanged === true || inputGeometryType !== outputGeometryType,
    inputGeometryType,
    outputGeometryType
  };
}

function consumption(raw: PocGeometryResult | PocScalarResult | PocValidationResult): { batchItems: number; vertices: number } {
  return {
    batchItems: 1,
    vertices: "vertexCount" in raw.summary && typeof raw.summary.vertexCount === "number"
      ? raw.summary.vertexCount
      : 1
  };
}

function primaryOperand(operationId: GeometryOperationId, record: Record<string, unknown>): GeometryProviderDefinitionsOperand {
  const value = operationId === "geometry.predicate" || isBinaryOperation(operationId) ? record.a : record.input;
  if (!isRecord(value)) throw new ProviderProtocolError("SCHEMA_MISMATCH", "Geometry operation input is missing its primary operand");
  return value as unknown as GeometryProviderDefinitionsOperand;
}

function isBinaryOperation(operationId: GeometryOperationId): boolean {
  return [
    "geometry.intersection",
    "geometry.union",
    "geometry.difference",
    "geometry.symmetric-difference",
    "geometry.closest-point",
    "geometry.shortest-line"
  ].includes(operationId);
}

function geometryType(value: unknown): string {
  const type = isRecord(value) ? value.type : undefined;
  if (typeof type !== "string") throw new ProviderProtocolError("SCHEMA_MISMATCH", "Geometry value has no type");
  return type;
}

function methodName(operationId: GeometryOperationId): string {
  return operationId === "geometry.predicate"
    ? "predicate"
    : operationId.slice("geometry.".length).replaceAll("-", "_");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ProviderProtocolError("SCHEMA_MISMATCH", "Geometry bridge expected an object after schema validation");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
