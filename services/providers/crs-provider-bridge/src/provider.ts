import type {
  CapabilityDescriptor,
  CapabilityProviderManifest
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { getContractSchemaHash } from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,
  sha256,
  type ProviderOperation,
  type ProviderOperationResult,
  type ProviderRuntime
} from "../../../../packages/platform/provider-sdk/src/index.js";
import { CRS_OPERATION_SCHEMAS, POC_OPENAPI_SHA256, POC_SOURCE_ZIP_SHA256 } from "./schemas.js";
import { CrsUpstreamClient } from "./upstream-client.js";
import type {
  CrsDeploymentAttestation,
  CrsOperationId,
  CrsProviderBridgeOptions,
  CrsWarning,
  NormalizationMetadata,
  TransformationProvenance
} from "./types.js";

const OPERATION_IDS: readonly CrsOperationId[] = [
  "crs.check-source",
  "crs.normalize.point",
  "crs.normalize.points",
  "crs.normalize.geometry",
  "crs.normalize.feature",
  "crs.normalize.feature-collection"
];

const VALUE_KINDS: Readonly<Record<CrsOperationId, { input: CapabilityDescriptor["ports"]["inputs"][number]["valueKind"]; output: CapabilityDescriptor["ports"]["outputs"][number]["valueKind"] }>> = {
  "crs.check-source": { input: "SCALAR", output: "ANY" },
  "crs.normalize.point": { input: "POSITION", output: "POSITION" },
  "crs.normalize.points": { input: "POSITIONS", output: "POSITIONS" },
  "crs.normalize.geometry": { input: "GEOMETRY", output: "GEOMETRY" },
  "crs.normalize.feature": { input: "FEATURE", output: "FEATURE" },
  "crs.normalize.feature-collection": { input: "FEATURE_COLLECTION", output: "FEATURE_COLLECTION" }
};

export interface CrsProviderBridge {
  runtime: ProviderRuntime;
  upstream: CrsUpstreamClient;
}

export function createCrsProviderBridge(options: CrsProviderBridgeOptions): CrsProviderBridge {
  if (options.attestation.sourceZipSha256 !== POC_SOURCE_ZIP_SHA256 || options.attestation.openApiSha256 !== POC_OPENAPI_SHA256) {
    throw new Error("CRS deployment does not match the locked POC source/OpenAPI digests");
  }
  const upstream = new CrsUpstreamClient(options.endpoint, options.attestation, options.fetch);
  const operations = OPERATION_IDS.map((operationId) => createOperation(operationId, upstream, options.attestation));
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0",
    provider: {
      providerId: "gowm.crs-normalization.bridge",
      providerVersion: "0.2.0",
      owner: "gowm-platform",
      implementationDigest: sha256({
        bridge: "gowm.crs-normalization.bridge",
        version: "0.2.0",
        sourceZipSha256: options.attestation.sourceZipSha256,
        openApiSha256: options.attestation.openApiSha256,
        allowedOperations: OPERATION_IDS
      }),
      sourceRef: "urn:gowm:source:zip:crs-normalization-service:1.0.0"
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
    version: "gowm-crs-bridge-policy/1.0",
    targetCrs: "EPSG:4326",
    axisConvention: "TRADITIONAL_GIS",
    strictBestOperation: true,
    networkEnabled: false,
    arbitraryTargetAllowed: false,
    arbitraryUrlAllowed: false,
    approvedEndpoint: {
      endpointId: options.endpoint.endpointId,
      configurationDigest: options.endpoint.configurationDigest
    },
    allowedOperations: OPERATION_IDS
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
  operationId: CrsOperationId,
  upstream: CrsUpstreamClient,
  attestation: CrsDeploymentAttestation
): ProviderOperation {
  const schemas = CRS_OPERATION_SCHEMAS[operationId];
  const inputSchemaHash = sha256(schemas.input);
  const outputSchemaHash = sha256(schemas.output);
  const descriptor: CapabilityDescriptor = {
    operationId,
    operationVersion: "1.0",
    semanticRole: "FOUNDATION_PRIMITIVE",
    dataBinding: "CALLER_DATA_BOUND",
    resultSemantics: "TRANSFORMATION",
    executionBindings: ["SYNC_HTTP"],
    criticalPathPolicy: "REMOTE_ALLOWED",
    maturity: "PREVIEW",
    inputSchemaUri: schemas.inputSchemaUri,
    inputSchemaHash,
    outputSchemaUri: schemas.outputSchemaUri,
    outputSchemaHash,
    scopePolicy: "REQUEST_CONTEXT",
    execution: {
      mode: "SYNC",
      defaultTimeoutMs: 3_000,
      maximumTimeoutMs: 10_000,
      costClass: "LOW"
    },
    limits: {
      maximumInputBytes: 16 * 1024 * 1024,
      maximumOutputBytes: 16 * 1024 * 1024,
      maximumBatchItems: 100_000,
      maximumVertices: 100_000
    },
    snapshotPolicy: { dataSnapshot: "NONE", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{
        name: "request",
        schemaUri: schemas.inputSchemaUri,
        schemaHash: inputSchemaHash,
        valueKind: VALUE_KINDS[operationId].input,
        unitSemantics: "UNSPECIFIED"
      }],
      outputs: [{
        name: "result",
        schemaUri: schemas.outputSchemaUri,
        schemaHash: outputSchemaHash,
        valueKind: VALUE_KINDS[operationId].output,
        unitSemantics: operationId === "crs.check-source" ? "UNSPECIFIED" : "ANGULAR_DEGREES"
      }, ...crsOutputSubports(operationId)]
    }
  };
  return {
    descriptor,
    inputSchema: schemas.input,
    outputSchema: schemas.output,
    method: {
      engine: "PROJ",
      engineVersion: attestation.projVersion,
      methodId: methodId(operationId),
      methodVersion: "1.0",
      artifacts: [
        {
          kind: "DATABASE",
          name: "proj.db",
          version: attestation.projDbVersion,
          digest: attestation.projDbSha256
        },
        {
          kind: "GRID",
          name: "offline-grid-bundle",
          version: attestation.gridBundleVersion,
          digest: attestation.gridBundleSha256
        },
        {
          kind: "PACKAGE",
          name: attestation.integration,
          version: attestation.integrationVersion
        }
      ]
    },
    async handle(input, context): Promise<ProviderOperationResult<unknown>> {
      const raw = await upstream.execute(operationId, input, context.deadline, context.trace);
      const output = operationId === "crs.normalize.geometry" ? mapGeometryOutput(raw) : raw;
      const metadata = normalizationMetadata(raw);
      const warnings = receiptWarnings(input, metadata, attestation);
      return {
        status: "COMPLETED",
        value: output,
        warnings,
        consumption: {
          batchItems: metadata?.coordinateCount ?? 1,
          vertices: metadata?.coordinateCount ?? 1
        },
        changes: {
          repairApplied: false,
          typeChanged: false,
          ...(operationId === "crs.normalize.geometry" ? geometryTypes(input, output) : {})
        }
      };
    }
  };
}

function crsOutputSubports(operationId: CrsOperationId): CapabilityDescriptor["ports"]["outputs"] {
  if (operationId === "crs.normalize.point") {
    return [{
      name: "coordinate",
      path: "/coordinate",
      schemaUri: "urn:gowm:v0.2:value:array",
      schemaHash: getContractSchemaHash("urn:gowm:v0.2:value:array"),
      valueKind: "POSITION",
      unitSemantics: "ANGULAR_DEGREES"
    }];
  }
  if (operationId === "crs.normalize.geometry") {
    return [{
      name: "geometry",
      path: "/geometry",
      schemaUri: "urn:gowm:capability:geometry:geojson-geometry:1.0",
      schemaHash: getContractSchemaHash("urn:gowm:capability:geometry:geojson-geometry:1.0"),
      valueKind: "GEOMETRY",
      unitSemantics: "ANGULAR_DEGREES"
    }];
  }
  return [];
}

function mapGeometryOutput(value: unknown): unknown {
  const output = asRecord(value);
  const provenance = asRecord(output.transformation) as unknown as TransformationProvenance;
  return {
    geometry: output.geometry,
    sourceCrs: provenance.sourceCrs,
    targetCrs: "EPSG:4326",
    axisOrder: output.axisOrder,
    coordinateCount: output.coordinateCount,
    zTransformed: false,
    normalizationMethod: "PROJ_STRICT_BEST_OFFLINE",
    transformation: output.transformation,
    warnings: output.warnings
  };
}

function normalizationMetadata(value: unknown): NormalizationMetadata | undefined {
  const record = asRecord(value);
  if (record.crs !== "EPSG:4326" || !Array.isArray(record.axisOrder) || !isRecord(record.transformation)) return undefined;
  return record as unknown as NormalizationMetadata;
}

function receiptWarnings(input: unknown, metadata: NormalizationMetadata | undefined, attestation: CrsDeploymentAttestation): string[] {
  const record = asRecord(input);
  const source = metadata?.transformation.sourceCrs ?? canonicalSource(record.sourceCrs);
  return [
    `crs.source=${source}`,
    "crs.target=EPSG:4326",
    "crs.axis=TRADITIONAL_GIS:longitude,latitude",
    `crs.proj=${attestation.projVersion}`,
    `crs.integration=${attestation.integration}@${attestation.integrationVersion}`,
    `crs.projDb=${attestation.projDbSha256}`,
    `crs.gridBundle=${attestation.gridBundleSha256}`,
    "crs.strictBestOperation=true",
    "crs.networkEnabled=false",
    ...(metadata?.warnings.map((warning: CrsWarning) => `crs.warning=${warning.code}`) ?? [])
  ];
}

function canonicalSource(value: unknown): string {
  if (typeof value !== "string") return "UNAVAILABLE";
  if (/^WGS\s*84$/iu.test(value.trim())) return "EPSG:4326";
  const match = /^EPSG\s*:\s*([1-9][0-9]{0,5})$/iu.exec(value.trim());
  return match ? `EPSG:${Number(match[1])}` : "UNAVAILABLE";
}

function geometryTypes(input: unknown, output: unknown): { inputGeometryType?: string; outputGeometryType?: string } {
  const inputGeometry = asRecord(asRecord(input).geometry);
  const outputGeometry = asRecord(asRecord(output).geometry);
  return {
    ...(typeof inputGeometry.type === "string" ? { inputGeometryType: inputGeometry.type } : {}),
    ...(typeof outputGeometry.type === "string" ? { outputGeometryType: outputGeometry.type } : {})
  };
}

function methodId(operationId: CrsOperationId): string {
  return `gdal-async-offline-strict-best/${operationId.slice("crs.".length)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("CRS bridge expected an object after schema validation");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
