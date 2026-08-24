import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  ElevationSampleMockInputV1,
  ElevationSampleMockOutputV1
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { getContractSchema } from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,
  sha256,
  type ProviderOperation,
  type ProviderRuntime
} from "../../../../packages/platform/provider-sdk/src/index.js";

const inputSchema = getContractSchema("capabilities/elevation.sample.mock/input-1.0.schema.json");
const outputSchema = getContractSchema("capabilities/elevation.sample.mock/output-1.0.schema.json");
if (typeof inputSchema === "boolean" || typeof outputSchema === "boolean") {
  throw new Error("elevation operation schemas must be JSON Schema objects");
}

export interface ElevationMockOptions {
  delayMs?: number;
  elevationMeters?: number;
  now?: () => Date;
}

export function createElevationMockProvider(options: ElevationMockOptions = {}): ProviderRuntime {
  const descriptor: CapabilityDescriptor = {
    operationId: "elevation.sample.mock",
    operationVersion: "1.0",
    semanticRole: "GENERIC_ANALYSIS",
    dataBinding: "WORLD_INDEPENDENT",
    resultSemantics: "DERIVED_ANALYSIS",
    executionBindings: ["SYNC_HTTP"],
    criticalPathPolicy: "REMOTE_ONLY",
    maturity: "EXPERIMENTAL",
    inputSchemaUri: "urn:gowm:capability:elevation.sample.mock:input:1.0",
    inputSchemaHash: sha256(inputSchema),
    outputSchemaUri: "urn:gowm:capability:elevation.sample.mock:output:1.0",
    outputSchemaHash: sha256(outputSchema),
    scopePolicy: "REQUEST_CONTEXT",
    execution: {
      mode: "SYNC",
      defaultTimeoutMs: 500,
      maximumTimeoutMs: 2_000,
      costClass: "LOW"
    },
    limits: {
      maximumInputBytes: 4_096,
      maximumOutputBytes: 4_096,
      maximumBatchItems: 1
    },
    snapshotPolicy: { dataSnapshot: "NONE", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{
        name: "request",
        schemaUri: "urn:gowm:capability:elevation.sample.mock:input:1.0",
        schemaHash: sha256(inputSchema),
        valueKind: "POSITION",
        unitSemantics: "ANGULAR_DEGREES"
      }],
      outputs: [{
        name: "result",
        schemaUri: "urn:gowm:capability:elevation.sample.mock:output:1.0",
        schemaHash: sha256(outputSchema),
        valueKind: "SCALAR",
        unitSemantics: "LINEAR_METERS"
      }]
    }
  };
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0",
    provider: {
      providerId: "gowm.elevation-mock",
      providerVersion: "0.2.0",
      owner: "gowm-platform",
      implementationDigest: sha256({ provider: "gowm.elevation-mock", version: "0.2.0", behavior: "fixed" }),
      sourceRef: "urn:gowm:source:in-tree:elevation-mock"
    },
    endpoints: {
      manifest: "/v1/manifest",
      liveness: "/health/live",
      readiness: "/health/ready",
      execute: "/v1/operations/{operationId}:execute",
      job: "/v1/jobs/{jobId}"
    },
    capabilities: [descriptor]
  };
  const operation: ProviderOperation<ElevationSampleMockInputV1, ElevationSampleMockOutputV1> = {
    descriptor,
    inputSchema,
    outputSchema,
    method: {
      engine: "gowm-elevation-mock",
      engineVersion: "1.0.0",
      methodId: "fixed-elevation",
      methodVersion: "1.0"
    },
    async handle(_input, context) {
      if ((options.delayMs ?? 0) > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          const abort = () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          };
          if (context.deadline.signal.aborted) abort();
          else context.deadline.signal.addEventListener("abort", abort, { once: true });
        });
      }
      return {
        status: "COMPLETED",
        value: { elevationMeters: options.elevationMeters ?? 123.45, source: "MOCK_FIXED" },
        consumption: { rows: 1, candidates: 1, batchItems: 1 }
      };
    }
  };
  return createProviderRuntime({
    manifest,
    operations: [operation],
    policyVersion: "elevation-mock-policy/1.0",
    policyDigest: sha256({ policy: "elevation-mock", version: "1.0" }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
}
