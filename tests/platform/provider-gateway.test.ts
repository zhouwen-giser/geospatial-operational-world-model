import { describe, expect, it } from "vitest";
import {
  validateContract,
  type CapabilityProviderManifest,
  type GatewayExecuteRequest,
  type ProviderExecutionRequest
} from "../../packages/platform/contract-runtime/src/index.js";
import { runProviderConformance } from "../../packages/platform/conformance-kit/src/index.js";
import { ProviderProtocolError, sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import {
  buildGatewayApp,
  CapabilityRegistry,
  DirectExecutionService,
  HttpProviderClient,
  InProcessProviderClient,
  MemoryAuditSink,
  MemoryGatewayIdempotencyStore,
  MemoryGatewayRecordStore,
  ProviderCircuitBreaker,
  type GatewayPrincipal
} from "../../services/gateway/world-capability-gateway/src/index.js";
import { createElevationMockProvider } from "../../services/providers/elevation-mock/src/provider.js";

const principal: GatewayPrincipal = {
  principalRef: "principal:test",
  authenticationMethod: "TEST_ATTESTED",
  authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
  allowExperimental: true
};

function providerRequest(
  runtime: ReturnType<typeof createElevationMockProvider>,
  overrides: Partial<ProviderExecutionRequest> = {}
): ProviderExecutionRequest {
  const operation = runtime.manifest.capabilities[0];
  if (!operation) throw new Error("mock operation missing");
  const deadlineAt = new Date(Date.now() + 1_000).toISOString();
  return {
    providerProtocolVersion: "1.0",
    requestId: "provider_request_test",
    gatewayRequestId: "gateway_request_test",
    idempotencyKey: "provider-idem-1",
    operation: {
      operationId: operation.operationId,
      operationVersion: operation.operationVersion,
      inputSchemaHash: operation.inputSchemaHash,
      outputSchemaHash: operation.outputSchemaHash
    },
    input: { longitude: 116.4, latitude: 39.9 },
    securityContext: {
      principalRef: principal.principalRef,
      authenticationMethod: principal.authenticationMethod,
      authenticatedAt: principal.authenticatedAt,
      scopeAttestation: {
        issuer: "gateway-test",
        issuedAt: new Date().toISOString(),
        expiresAt: deadlineAt,
        claimDigest: sha256({ principal: principal.principalRef })
      }
    },
    gatewayContext: {
      gatewayId: "gateway-test",
      registryVersion: "registry-1",
      policyVersion: "policy-1"
    },
    executionPolicy: {
      deadlineAt,
      maximumInputBytes: 4_096,
      maximumResultBytes: 4_096,
      maximumCostClass: "LOW"
    },
    ...overrides
  };
}

function gatewayRequest(runtime: ReturnType<typeof createElevationMockProvider>): GatewayExecuteRequest {
  const operation = runtime.manifest.capabilities[0];
  if (!operation) throw new Error("mock operation missing");
  return {
    requestVersion: "1.0",
    requestId: "gateway_request_test",
    idempotencyKey: "gateway-idem-1",
    operationVersion: operation.operationVersion,
    inputSchemaHash: operation.inputSchemaHash,
    outputSchemaHash: operation.outputSchemaHash,
    input: { longitude: 116.4, latitude: 39.9 },
    executionPolicy: {
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
      maximumResultBytes: 4_096,
      maximumCostClass: "LOW",
      preferredExecution: "SYNC"
    }
  };
}

function gatewayHarness(runtime = createElevationMockProvider()) {
  const registry = new CapabilityRegistry();
  const client = new InProcessProviderClient(runtime);
  registry.register({
    approvalId: "approval-test-1",
    approved: true,
    endpoint: new URL("http://127.0.0.1:33010/"),
    client,
    manifest: runtime.manifest
  });
  const audit = new MemoryAuditSink();
  const records = new MemoryGatewayRecordStore();
  const direct = new DirectExecutionService({
    registry,
    circuits: new ProviderCircuitBreaker(),
    idempotency: new MemoryGatewayIdempotencyStore(),
    audit,
    gatewayId: "gateway-test",
    policyVersion: "policy-1",
    attestationIssuer: "gateway-test",
    records
  });
  return { registry, client, audit, records, direct };
}

describe("Provider SDK and conformance", () => {
  it("passes protocol, hash, deadline, budget, snapshot and idempotency checks", async () => {
    const runtime = createElevationMockProvider({ delayMs: 25 });
    const valid = providerRequest(runtime);
    const deadline = providerRequest(runtime, {
      idempotencyKey: "provider-idem-deadline",
      executionPolicy: {
        ...valid.executionPolicy,
        deadlineAt: new Date(Date.now() + 5).toISOString()
      }
    });
    const report = await runProviderConformance({
      runtime,
      validRequest: valid,
      differentInput: { longitude: 117, latitude: 40 },
      unknownFieldInput: { longitude: 116.4, latitude: 39.9, injected: true },
      deadlineRequest: deadline
    });

    expect(report, JSON.stringify(report, null, 2)).toMatchObject({ passed: true });
    expect(report.checks.every((check) => check.status === "PASS")).toBe(true);
  });

  it("keeps stateless receipts separate from world evidence and data snapshots", async () => {
    const runtime = createElevationMockProvider();
    const result = await runtime.execute(providerRequest(runtime));

    expect(result.status).toBe("COMPLETED");
    expect(result.computeSnapshot.operation.operationId).toBe("elevation.sample.mock");
    expect(result.receipts).toHaveLength(1);
    expect(result.evidenceReferences).toEqual([]);
    expect(result.dataSnapshot).toBeUndefined();
  });

  it("enforces the Gateway-attested input budget again inside the Provider", async () => {
    const runtime = createElevationMockProvider();
    const request = providerRequest(runtime);
    request.executionPolicy.maximumInputBytes = 1;

    await expect(runtime.execute(request)).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      details: { metric: "inputBytes", limit: 1 }
    });
  });
});

describe("Capability Registry and direct execution", () => {
  it("retains the controlled provider identity when an HTTP provider rejects a request", async () => {
    const runtime = createElevationMockProvider();
    const client = new HttpProviderClient({
      endpoint: new URL("http://127.0.0.1:33010/"),
      providerId: runtime.manifest.provider.providerId,
      providerVersion: runtime.manifest.provider.providerVersion,
      implementationDigest: runtime.manifest.provider.implementationDigest as `sha256:${string}`,
      manifestHash: sha256(runtime.manifest),
      approvedManifest: runtime.manifest,
      transportToken: "provider-transport-test-token-32-bytes-minimum",
      allowPlaintextPrivateNetwork: true,
      fetch: async (_input, init) => init?.method === "POST"
        ? new Response(JSON.stringify({
            schemaVersion: "1.0",
            requestId: "provider_request_test",
            error: {
              code: "INVALID_REQUEST",
              message: "Request validation failed",
              retryable: false,
              stage: "PROVIDER_EXECUTION",
              providerId: runtime.manifest.provider.providerId
            }
          }), { status: 422, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify(runtime.manifest), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
    });

    await expect(client.execute("elevation.sample.mock", providerRequest(runtime))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      retryable: false,
      details: {
        upstreamStatus: 422,
        providerId: runtime.manifest.provider.providerId,
        stage: "PROVIDER_EXECUTION"
      }
    });
  });

  it("registers a future provider and executes it without operation-specific Gateway code", async () => {
    const runtime = createElevationMockProvider();
    const { direct, audit } = gatewayHarness(runtime);
    const request = gatewayRequest(runtime);

    const first = await direct.execute("elevation.sample.mock", request, principal);
    const replay = await direct.execute("elevation.sample.mock", structuredClone(request), principal);

    expect(first.replayed).toBe(false);
    expect(first.result.output?.value).toEqual({ elevationMeters: 123.45, source: "MOCK_FIXED" });
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    expect(audit.events().map((event) => event.outcome)).toEqual(["COMPLETED", "REPLAYED"]);
  });

  it("enforces the caller output budget even when a nonconforming provider ignores it", async () => {
    const runtime = createElevationMockProvider();
    const client = new InProcessProviderClient(runtime);
    const compliantExecute = client.execute.bind(client);
    client.execute = async (operationId, request) => compliantExecute(operationId, {
      ...request,
      executionPolicy: {
        ...request.executionPolicy,
        maximumResultBytes: 4_096
      }
    });
    const registry = new CapabilityRegistry();
    registry.register({
      approvalId: "approval-gateway-output-budget",
      approved: true,
      endpoint: new URL("http://127.0.0.1:33010/"),
      client,
      manifest: runtime.manifest
    });
    const direct = new DirectExecutionService({
      registry,
      circuits: new ProviderCircuitBreaker(),
      idempotency: new MemoryGatewayIdempotencyStore(),
      audit: new MemoryAuditSink(),
      gatewayId: "gateway-test",
      policyVersion: "policy-1",
      attestationIssuer: "gateway-test"
    });
    const request = gatewayRequest(runtime);
    request.executionPolicy.maximumResultBytes = 1;

    await expect(direct.execute("elevation.sample.mock", request, principal)).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      details: { metric: "outputBytes", limit: 1 }
    });
  });

  it("independently enforces reported row and candidate budgets for a nonconforming provider", async () => {
    const runtime = createElevationMockProvider();
    const client = new InProcessProviderClient(runtime);
    client.execute = async (_operationId, request) => {
      const { maximumRows: _rows, maximumCandidates: _candidates, ...withoutNodeLimits } = request.executionPolicy;
      const result = await runtime.execute({ ...request, executionPolicy: withoutNodeLimits });
      return {
        ...result,
        consumption: { ...result.consumption, rows: 2, candidates: 2 }
      };
    };
    const registry = new CapabilityRegistry();
    registry.register({
      approvalId: "approval-gateway-row-budget",
      approved: true,
      endpoint: new URL("http://127.0.0.1:33010/"),
      client,
      manifest: runtime.manifest
    });
    const direct = new DirectExecutionService({
      registry,
      circuits: new ProviderCircuitBreaker(),
      idempotency: new MemoryGatewayIdempotencyStore(),
      audit: new MemoryAuditSink(),
      gatewayId: "gateway-test",
      policyVersion: "policy-1",
      attestationIssuer: "gateway-test"
    });
    const request = gatewayRequest(runtime);
    request.executionPolicy.maximumRows = 1;
    request.executionPolicy.maximumCandidates = 1;

    await expect(direct.execute("elevation.sample.mock", request, principal)).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      details: { metric: "rows", consumed: 2, limit: 1 }
    });
  });

  it("supports operation version coexistence and blocks unapproved maturity", () => {
    const runtime = createElevationMockProvider();
    const v1 = runtime.manifest.capabilities[0];
    if (!v1) throw new Error("mock operation missing");
    const v2 = structuredClone(v1);
    v2.operationVersion = "2.0";
    const manifest: CapabilityProviderManifest = {
      ...structuredClone(runtime.manifest),
      capabilities: [v1, v2]
    };
    const client = new InProcessProviderClient(runtime);
    const registry = new CapabilityRegistry();
    registry.register({
      approvalId: "approval-versions",
      approved: true,
      endpoint: new URL("http://localhost:33010/"),
      client,
      manifest
    });

    expect(registry.get("elevation.sample.mock", "1.0")).toBeDefined();
    expect(registry.get("elevation.sample.mock", "2.0")).toBeDefined();
    expect(() => registry.resolve("elevation.sample.mock", "1.0", false)).toThrowError(ProviderProtocolError);
    expect(registry.resolve("elevation.sample.mock", "2.0", true).descriptor.operationVersion).toBe("2.0");
  });

  it("isolates an unhealthy provider without disabling unrelated capabilities", async () => {
    const runtime = createElevationMockProvider();
    const { registry, direct } = gatewayHarness(runtime);
    const unhealthyManifest: CapabilityProviderManifest = structuredClone(runtime.manifest);
    unhealthyManifest.provider.providerId = "gowm.unhealthy-fixture";
    unhealthyManifest.capabilities[0]!.operationId = "elevation.sample.unhealthy";
    const unhealthyClient = {
      providerId: unhealthyManifest.provider.providerId,
      async manifest() {
        return structuredClone(unhealthyManifest);
      },
      async health() {
        return {
          live: true,
          ready: false,
          checkedAt: new Date().toISOString(),
          detail: "fixture unavailable"
        };
      },
      async execute(): Promise<never> {
        throw new Error("unhealthy provider must not execute");
      }
    };
    registry.register({
      approvalId: "approval-unhealthy-isolation",
      approved: true,
      endpoint: new URL("http://127.0.0.1:33011/"),
      client: unhealthyClient,
      manifest: unhealthyManifest
    });

    const health = await registry.health();
    const healthyResult = await direct.execute("elevation.sample.mock", gatewayRequest(runtime), principal);

    expect(health[unhealthyManifest.provider.providerId]).toMatchObject({ live: true, ready: false });
    expect(health[runtime.manifest.provider.providerId]).toMatchObject({ live: true, ready: true });
    expect(healthyResult.result.status).toBe("COMPLETED");
  });

  it("opens and recovers an isolated provider circuit", async () => {
    let now = 0;
    const circuit = new ProviderCircuitBreaker(2, 100, () => now);
    const failure = async () => { throw new Error("provider unavailable"); };

    await expect(circuit.execute("provider-a", failure)).rejects.toThrow("provider unavailable");
    await expect(circuit.execute("provider-a", failure)).rejects.toThrow("provider unavailable");
    expect(circuit.state("provider-a").state).toBe("OPEN");
    await expect(circuit.execute("provider-a", async () => "unexpected")).rejects.toMatchObject({ code: "PROVIDER_NOT_READY" });

    now = 101;
    await expect(circuit.execute("provider-a", async () => "ready")).resolves.toBe("ready");
    expect(circuit.state("provider-a")).toMatchObject({ state: "CLOSED", failures: 0 });
    expect(circuit.state("provider-b")).toMatchObject({ state: "CLOSED", failures: 0 });
  });

  it("exposes catalog/detail/execute HTTP without trusting scope fields in the body", async () => {
    const runtime = createElevationMockProvider();
    const { registry, direct, records } = gatewayHarness(runtime);
    const app = buildGatewayApp({ registry, directExecution: direct, records, authenticate: async () => principal });
    const request = gatewayRequest(runtime);

    const catalog = await app.inject({ method: "GET", url: "/v1/capabilities" });
    const detail = await app.inject({ method: "GET", url: "/v1/capabilities/elevation.sample.mock" });
    const execution = await app.inject({
      method: "POST",
      url: "/v1/operations/elevation.sample.mock:execute",
      payload: request
    });
    const receiptId = execution.json().receipts[0].receiptId as string;
    const receipt = await app.inject({ method: "GET", url: `/v1/receipts/${encodeURIComponent(receiptId)}` });
    const forged = await app.inject({
      method: "POST",
      url: "/v1/operations/elevation.sample.mock:execute",
      payload: { ...request, idempotencyKey: "forged", securityContext: { dataScopeClaim: "admin" } }
    });

    expect(catalog.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    expect(validateContract("capability-list-response.schema.json", catalog.json()).valid).toBe(true);
    expect(validateContract("capability-versions-response.schema.json", detail.json()).valid).toBe(true);
    expect(execution.statusCode).toBe(200);
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json().receiptId).toBe(receiptId);
    expect(execution.headers["idempotent-replay"]).toBe("false");
    expect(forged.statusCode).toBe(422);
    await app.close();
  });
});
