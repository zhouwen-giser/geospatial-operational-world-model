import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  CapabilityResultEnvelope,
  GatewayExecuteRequest,
  ProviderExecutionRequest,
  WorldQueryPlanV2Node,
  WorldQuerySubmission
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  getContractSchema,
  getContractSchemaHash
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,
  sha256,
  type ProviderOperation,
  type ProviderRuntime
} from "../../packages/platform/provider-sdk/src/index.js";
import {
  CapabilityRegistry,
  DirectExecutionService,
  MemoryAuditSink,
  MemoryGatewayIdempotencyStore,
  MemoryGatewayRecordStore,
  ProviderCircuitBreaker,
  type GatewayIdempotencyStore,
  type GatewayPrincipal,
  type ProviderClient
} from "../../services/gateway/world-capability-gateway/src/index.js";

export const INPUT_SCHEMA_URI = "urn:gowm:capability:elevation.sample.mock:input:1.0";
export const OUTPUT_SCHEMA_URI = "urn:gowm:capability:elevation.sample.mock:output:1.0";
export const OPEN_SCHEMA_URI = "urn:gowm:v0.2:world-query-parameters";
export const PARAMETER_SCHEMA_HASH = getContractSchemaHash("world-query-parameters.schema.json");
export const INPUT_SCHEMA = getContractSchema(INPUT_SCHEMA_URI);
export const OUTPUT_SCHEMA = getContractSchema(OUTPUT_SCHEMA_URI);
export const OPEN_SCHEMA = getContractSchema(OPEN_SCHEMA_URI);

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function principal(overrides: Partial<GatewayPrincipal> = {}): GatewayPrincipal {
  return {
    principalRef: "principal:p15-test",
    authenticationMethod: "TEST_TRANSPORT_ATTESTED",
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    allowExperimental: true,
    ...overrides
  };
}

export class CountingProviderClient implements ProviderClient {
  readonly providerId: string;
  executeCalls = 0;
  healthCalls = 0;

  constructor(
    readonly runtime: ProviderRuntime,
    readonly mutate?: (result: CapabilityResultEnvelope) => CapabilityResultEnvelope,
    readonly fail?: () => never
  ) {
    this.providerId = runtime.manifest.provider.providerId;
  }

  async manifest(): Promise<CapabilityProviderManifest> {
    return structuredClone(this.runtime.manifest);
  }

  async health() {
    this.healthCalls += 1;
    return { live: true, ready: true, checkedAt: new Date().toISOString() };
  }

  async execute(_operationId: string, request: ProviderExecutionRequest): Promise<CapabilityResultEnvelope> {
    this.executeCalls += 1;
    if (this.fail) this.fail();
    const result = await this.runtime.execute(request);
    return this.mutate ? this.mutate(structuredClone(result)) : result;
  }
}

export function gatewayHarness(
  client: ProviderClient,
  manifest: CapabilityProviderManifest,
  idempotency: GatewayIdempotencyStore<CapabilityResultEnvelope> = new MemoryGatewayIdempotencyStore()
) {
  const registry = new CapabilityRegistry();
  registry.register({
    approvalId: "approval-p15-test",
    approved: true,
    endpoint: new URL("http://127.0.0.1:34515/"),
    client,
    manifest
  });
  const audit = new MemoryAuditSink();
  const records = new MemoryGatewayRecordStore();
  const direct = new DirectExecutionService({
    registry,
    circuits: new ProviderCircuitBreaker(),
    idempotency,
    audit,
    records,
    gatewayId: "gateway-p15-test",
    policyVersion: "gateway-p15-policy/1.0",
    attestationIssuer: "gateway-p15-test"
  });
  return { registry, audit, records, direct };
}

export function gatewayRequest(
  descriptor: CapabilityDescriptor,
  overrides: Partial<GatewayExecuteRequest> = {}
): GatewayExecuteRequest {
  return {
    requestVersion: "1.0",
    requestId: "gateway_request_p15",
    idempotencyKey: "gateway-idempotency-p15",
    operationVersion: descriptor.operationVersion,
    inputSchemaHash: descriptor.inputSchemaHash,
    outputSchemaHash: descriptor.outputSchemaHash,
    input: { longitude: 116.4, latitude: 39.9 },
    executionPolicy: {
      deadlineAt: new Date(Date.now() + 1_500).toISOString(),
      maximumResultBytes: 4_096,
      maximumCostClass: descriptor.execution.costClass,
      preferredExecution: "SYNC"
    },
    ...overrides
  };
}

export function providerRequest(
  descriptor: CapabilityDescriptor,
  dataScopeClaim?: string,
  overrides: Partial<ProviderExecutionRequest> = {}
): ProviderExecutionRequest {
  const issuedAt = new Date();
  const deadlineAt = new Date(issuedAt.getTime() + 1_500).toISOString();
  return {
    providerProtocolVersion: "1.0",
    requestId: "provider_request_p15",
    gatewayRequestId: "gateway_request_p15",
    idempotencyKey: "provider-idempotency-p15",
    operation: {
      operationId: descriptor.operationId,
      operationVersion: descriptor.operationVersion,
      inputSchemaHash: descriptor.inputSchemaHash,
      outputSchemaHash: descriptor.outputSchemaHash
    },
    input: { longitude: 116.4, latitude: 39.9 },
    securityContext: {
      principalRef: "principal:p15-test",
      authenticationMethod: "TEST_GATEWAY_ATTESTED",
      authenticatedAt: new Date(issuedAt.getTime() - 1_000).toISOString(),
      ...(dataScopeClaim === undefined ? {} : { dataScopeClaim }),
      scopeAttestation: {
        issuer: "gateway-p15-test",
        issuedAt: issuedAt.toISOString(),
        expiresAt: deadlineAt,
        claimDigest: sha256({ principalRef: "principal:p15-test", dataScopeClaim: dataScopeClaim ?? null })
      }
    },
    gatewayContext: {
      gatewayId: "gateway-p15-test",
      registryVersion: "registry-p15-test",
      policyVersion: "gateway-p15-policy/1.0"
    },
    executionPolicy: {
      deadlineAt,
      maximumInputBytes: 4_096,
      maximumResultBytes: 4_096,
      maximumRows: 100,
      maximumCandidates: 100,
      maximumBatchItems: 100,
      maximumCostClass: descriptor.execution.costClass
    },
    ...overrides
  };
}

export function descriptorFor(runtime: ProviderRuntime): CapabilityDescriptor {
  const descriptor = runtime.manifest.capabilities[0];
  if (!descriptor) throw new Error("test provider omitted its operation descriptor");
  return descriptor;
}

export function createScopedProvider(options: { omitDataSnapshot?: boolean; delay?: Deferred<void> } = {}) {
  const descriptor: CapabilityDescriptor = {
    operationId: "test.scoped.elevation",
    operationVersion: "1.0",
    semanticRole: "FOUNDATION_DATA_QUERY",
    dataBinding: "WORLD_SNAPSHOT_BOUND",
    resultSemantics: "DERIVED_ANALYSIS",
    executionBindings: ["SYNC_HTTP"],
    criticalPathPolicy: "REMOTE_ONLY",
    maturity: "PREVIEW",
    inputSchemaUri: INPUT_SCHEMA_URI,
    inputSchemaHash: getContractSchemaHash(INPUT_SCHEMA_URI),
    outputSchemaUri: OUTPUT_SCHEMA_URI,
    outputSchemaHash: getContractSchemaHash(OUTPUT_SCHEMA_URI),
    scopePolicy: "DATA_SCOPE_REQUIRED",
    execution: { mode: "SYNC", defaultTimeoutMs: 500, maximumTimeoutMs: 2_000, costClass: "LOW" },
    limits: {
      maximumInputBytes: 4_096,
      maximumOutputBytes: 4_096,
      maximumRows: 100,
      maximumCandidates: 100,
      maximumBatchItems: 100
    },
    snapshotPolicy: { dataSnapshot: "REQUIRED", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{
        name: "request",
        schemaUri: INPUT_SCHEMA_URI,
        schemaHash: getContractSchemaHash(INPUT_SCHEMA_URI),
        valueKind: "POSITION",
        unitSemantics: "ANGULAR_DEGREES"
      }],
      outputs: [{
        name: "result",
        schemaUri: OUTPUT_SCHEMA_URI,
        schemaHash: getContractSchemaHash(OUTPUT_SCHEMA_URI),
        valueKind: "SCALAR",
        unitSemantics: "LINEAR_METERS"
      }]
    }
  };
  const calls = { count: 0, scopes: [] as string[] };
  const operation: ProviderOperation = {
    descriptor,
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
    method: { engine: "p15-scoped", engineVersion: "1.0.0", methodId: "sample", methodVersion: "1.0" },
    async handle(_input, context) {
      calls.count += 1;
      calls.scopes.push(context.security.dataScopeClaim ?? "");
      await options.delay?.promise;
      return {
        status: "COMPLETED",
        value: { elevationMeters: 12.5, source: "MOCK_FIXED" },
        consumption: { rows: 1, candidates: 1, batchItems: 1 },
        ...(options.omitDataSnapshot ? {} : {
          dataSnapshot: {
            consistency: "PINNED" as const,
            capturedAt: new Date().toISOString(),
            scopeDigest: sha256(context.security.dataScopeClaim ?? ""),
            resources: [{
              referenceKey: { namespace: "gowm.test", kind: "DATASET", id: "p15", version: "7" },
              authority: "GOWM Foundation",
              pinning: "PINNED" as const,
              digest: sha256({ dataset: "p15", version: 7 })
            }]
          },
          evidenceReferences: [{
            evidenceId: "evidence-p15",
            authority: "GOWM Foundation",
            evidenceType: "DATASET_VERSION" as const,
            referenceKey: { namespace: "gowm.test", kind: "DATASET", id: "p15", version: "7" },
            schemaUri: OUTPUT_SCHEMA_URI,
            schemaHash: getContractSchemaHash(OUTPUT_SCHEMA_URI),
            observedAt: new Date().toISOString(),
            worldVersion: 7
          }]
        })
      };
    }
  };
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0",
    provider: {
      providerId: "gowm.p15-scoped-test",
      providerVersion: "0.2.0",
      owner: "gowm-platform",
      implementationDigest: sha256({ provider: "gowm.p15-scoped-test", version: "0.2.0" }),
      sourceRef: "urn:gowm:source:test:p15-scoped"
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
  const runtime = createProviderRuntime({
    manifest,
    operations: [operation],
    policyVersion: "p15-scoped-policy/1.0",
    policyDigest: sha256({ policy: "p15-scoped-policy/1.0" })
  });
  return { runtime, descriptor, manifest, calls };
}

export function createOpenObjectProvider(options: { delay?: Deferred<void> } = {}) {
  const descriptor: CapabilityDescriptor = {
    operationId: "test.open-object",
    operationVersion: "1.0",
    semanticRole: "GENERIC_ANALYSIS",
    dataBinding: "CALLER_DATA_BOUND",
    resultSemantics: "DERIVED_ANALYSIS",
    executionBindings: ["SYNC_HTTP"],
    criticalPathPolicy: "REMOTE_ONLY",
    maturity: "PREVIEW",
    inputSchemaUri: OPEN_SCHEMA_URI,
    inputSchemaHash: getContractSchemaHash(OPEN_SCHEMA_URI),
    outputSchemaUri: OPEN_SCHEMA_URI,
    outputSchemaHash: getContractSchemaHash(OPEN_SCHEMA_URI),
    scopePolicy: "REQUEST_CONTEXT",
    execution: { mode: "SYNC", defaultTimeoutMs: 500, maximumTimeoutMs: 5_000, costClass: "LOW" },
    limits: {
      maximumInputBytes: 65_536,
      maximumOutputBytes: 65_536,
      maximumRows: 100,
      maximumCandidates: 100,
      maximumBatchItems: 100
    },
    snapshotPolicy: { dataSnapshot: "NONE", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{
        name: "request",
        schemaUri: OPEN_SCHEMA_URI,
        schemaHash: getContractSchemaHash(OPEN_SCHEMA_URI),
        valueKind: "ANY",
        unitSemantics: "UNSPECIFIED"
      }],
      outputs: [{
        name: "result",
        schemaUri: OPEN_SCHEMA_URI,
        schemaHash: getContractSchemaHash(OPEN_SCHEMA_URI),
        valueKind: "ANY",
        unitSemantics: "UNSPECIFIED"
      }]
    }
  };
  const calls = { count: 0 };
  const operation: ProviderOperation = {
    descriptor,
    inputSchema: OPEN_SCHEMA,
    outputSchema: OPEN_SCHEMA,
    method: { engine: "p15-open", engineVersion: "1.0.0", methodId: "echo", methodVersion: "1.0" },
    async handle(input) {
      calls.count += 1;
      await options.delay?.promise;
      return {
        status: "COMPLETED",
        value: structuredClone(input),
        consumption: { rows: 1, candidates: 1, batchItems: 1 }
      };
    }
  };
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0",
    provider: {
      providerId: "gowm.p15-open-test",
      providerVersion: "0.2.0",
      owner: "gowm-platform",
      implementationDigest: sha256({ provider: "gowm.p15-open-test", version: "0.2.0" }),
      sourceRef: "urn:gowm:source:test:p15-open"
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
  const runtime = createProviderRuntime({
    manifest,
    operations: [operation],
    policyVersion: "p15-open-policy/1.0",
    policyDigest: sha256({ policy: "p15-open-policy/1.0" })
  });
  return { runtime, descriptor, manifest, calls };
}

export function oneNodeSubmission(
  descriptor: CapabilityDescriptor,
  input: unknown,
  queryId = "query_p15"
): WorldQuerySubmission {
  const inputPort = descriptor.ports.inputs[0];
  const outputPort = descriptor.ports.outputs[0];
  if (!inputPort || !outputPort) throw new Error("test descriptor requires one input and output port");
  const node: WorldQueryPlanV2Node = {
    nodeId: "nodeA",
    operation: {
      operationId: descriptor.operationId,
      operationVersion: descriptor.operationVersion,
      inputSchemaHash: descriptor.inputSchemaHash,
      outputSchemaHash: descriptor.outputSchemaHash
    },
    inputs: {
      request: {
        kind: "LITERAL",
        value: input,
        port: schemaPort(inputPort)
      }
    },
    failurePolicy: "FAIL_FAST",
    budget: {
      maximumRows: 10,
      maximumCandidates: 10,
      maximumOutputBytes: 16_384,
      maximumExecutionMs: 2_000
    }
  };
  return {
    requestId: `request:${queryId}`,
    idempotencyKey: `idempotency:${queryId}`,
    parameterSchemaHash: PARAMETER_SCHEMA_HASH,
    parameters: {},
    plan: {
      queryPlanVersion: "2.0",
      queryId,
      nodes: [node],
      outputs: [{
        name: "answer",
        binding: {
          kind: "NODE_OUTPUT",
          nodeId: node.nodeId,
          outputPort: outputPort.name,
          port: schemaPort(outputPort)
        }
      }],
      budgets: {
        maximumNodes: 1,
        maximumDepth: 1,
        maximumRows: 10,
        maximumCandidates: 10,
        maximumOutputBytes: 32_768,
        maximumExecutionMs: 3_000
      }
    }
  };
}

function schemaPort(port: CapabilityDescriptor["ports"]["inputs"][number]) {
  return {
    schemaUri: port.schemaUri,
    schemaHash: port.schemaHash,
    valueKind: port.valueKind,
    unitSemantics: port.unitSemantics
  };
}
