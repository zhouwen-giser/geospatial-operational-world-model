import { describe, expect, it } from "vitest";
import {
  canonicalSha256,
  type CapabilityResultEnvelope
} from "../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import {
  buildGatewayApp,
  MemoryQueryPlanStore,
  QueryPlanValidator,
  WorldQueryRuntime
} from "../../services/gateway/world-capability-gateway/src/index.js";
import { createElevationMockProvider } from "../../services/providers/elevation-mock/src/provider.js";
import {
  CountingProviderClient,
  createOpenObjectProvider,
  createScopedProvider,
  descriptorFor,
  gatewayHarness,
  gatewayRequest,
  oneNodeSubmission,
  principal,
  providerRequest
} from "./fixtures.js";

const SENSITIVE_TOKEN = "p15-super-secret-token";
const SENSITIVE_COORDINATE = 12.345678901;

describe("P15 Snapshot, Receipt, Evidence, and leakage integrity", () => {
  it("binds stateless output and Compute Snapshot hashes without inventing data evidence", async () => {
    const runtime = createElevationMockProvider();
    const descriptor = descriptorFor(runtime);
    const request = providerRequest(descriptor);
    const result = await runtime.execute(request);
    const receipt = result.receipts[0];
    if (!receipt || !result.output) throw new Error("valid provider result omitted receipt/output");

    expect(receipt.inputHash).toBe(canonicalSha256(request.input));
    expect(receipt.outputHash).toBe(canonicalSha256(result.output.value));
    expect(receipt.computeSnapshotHash).toBe(canonicalSha256(result.computeSnapshot));
    expect(result.execution.resultHash).toBe(receipt.outputHash);
    expect(result.computeSnapshot).toMatchObject({
      provider: {
        providerId: runtime.manifest.provider.providerId,
        providerVersion: runtime.manifest.provider.providerVersion,
        implementationDigest: runtime.manifest.provider.implementationDigest
      },
      operation: { operationId: descriptor.operationId, operationVersion: descriptor.operationVersion },
      engine: { name: "gowm-elevation-mock", version: "1.0.0" },
      schemas: {
        inputSchemaHash: descriptor.inputSchemaHash,
        outputSchemaHash: descriptor.outputSchemaHash
      }
    });
    expect(result.dataSnapshot).toBeUndefined();
    expect(result.evidenceReferences).toEqual([]);
  });

  it("requires Data Snapshot for data-bound work and keeps Evidence distinct from receipts", async () => {
    const scoped = createScopedProvider();
    const result = await scoped.runtime.execute(providerRequest(scoped.descriptor, "scope:p15"));

    expect(result.dataSnapshot).toMatchObject({
      consistency: "PINNED",
      resources: [expect.objectContaining({
        referenceKey: { namespace: "gowm.test", kind: "DATASET", id: "p15", version: "7" },
        pinning: "PINNED"
      })]
    });
    expect(result.evidenceReferences).toEqual([
      expect.objectContaining({ evidenceId: "evidence-p15", evidenceType: "DATASET_VERSION", worldVersion: 7 })
    ]);
    expect(result.receipts[0]).not.toHaveProperty("evidenceId");
    expect(result.evidenceReferences[0]).not.toHaveProperty("method");

    const dishonest = createScopedProvider({ omitDataSnapshot: true });
    await expect(dishonest.runtime.execute(providerRequest(dishonest.descriptor, "scope:p15")))
      .rejects.toMatchObject({ code: "INTERNAL_PROVIDER_ERROR" });
  });

  it("rejects a provider that attaches fake World Snapshot or Evidence to stateless work", async () => {
    const runtime = createElevationMockProvider();
    const descriptor = descriptorFor(runtime);
    const client = new CountingProviderClient(runtime, (result) => {
      result.dataSnapshot = {
        consistency: "CONSISTENT_AT_START",
        capturedAt: new Date().toISOString(),
        scopeDigest: sha256("forged-scope"),
        resources: [{
          referenceKey: { namespace: "gowm.fake", kind: "DATASET", id: "forged", version: "1" },
          authority: "forged",
          pinning: "AT_LEAST"
        }]
      };
      result.evidenceReferences = [{
        evidenceId: "evidence-forged",
        authority: "forged",
        evidenceType: "DATASET_VERSION",
        referenceKey: { namespace: "gowm.fake", kind: "DATASET", id: "forged", version: "1" },
        schemaUri: descriptor.outputSchemaUri,
        schemaHash: descriptor.outputSchemaHash,
        worldVersion: 999
      }];
      return result;
    });
    const gateway = gatewayHarness(client, runtime.manifest);

    await expect(gateway.direct.execute(
      descriptor.operationId,
      gatewayRequest(descriptor, { idempotencyKey: "fake-world-evidence" }),
      principal()
    )).rejects.toMatchObject({ code: "SCHEMA_MISMATCH" });
  });

  it("rejects self-consistent provider, input, and schema identity forgery", async () => {
    const mutations: Array<(result: CapabilityResultEnvelope) => CapabilityResultEnvelope> = [
      (result) => {
        result.execution.providerId = "gowm.forged-provider";
        result.computeSnapshot.provider.providerId = "gowm.forged-provider";
        for (const receipt of result.receipts) receipt.providerId = "gowm.forged-provider";
        for (const receipt of result.receipts) receipt.computeSnapshotHash = canonicalSha256(result.computeSnapshot);
        return result;
      },
      (result) => {
        for (const receipt of result.receipts) receipt.inputHash = sha256({ forged: "input" });
        return result;
      },
      (result) => {
        result.computeSnapshot.schemas.inputSchemaHash = sha256({ forged: "schema" });
        for (const receipt of result.receipts) receipt.computeSnapshotHash = canonicalSha256(result.computeSnapshot);
        return result;
      }
    ];

    for (const [index, mutate] of mutations.entries()) {
      const runtime = createElevationMockProvider();
      const descriptor = descriptorFor(runtime);
      const gateway = gatewayHarness(new CountingProviderClient(runtime, mutate), runtime.manifest);
      await expect(gateway.direct.execute(
        descriptor.operationId,
        gatewayRequest(descriptor, { idempotencyKey: `forged-integrity-${index}` }),
        principal()
      )).rejects.toMatchObject({ code: "SCHEMA_MISMATCH" });
    }

    const replayRuntime = createElevationMockProvider();
    const replayDescriptor = descriptorFor(replayRuntime);
    const poisonedReplay = await replayRuntime.execute(providerRequest(replayDescriptor));
    poisonedReplay.execution.providerId = "gowm.forged-provider";
    poisonedReplay.computeSnapshot.provider.providerId = "gowm.forged-provider";
    for (const receipt of poisonedReplay.receipts) receipt.providerId = "gowm.forged-provider";
    for (const receipt of poisonedReplay.receipts) receipt.computeSnapshotHash = canonicalSha256(poisonedReplay.computeSnapshot);
    const replayClient = new CountingProviderClient(replayRuntime);
    const replayGateway = gatewayHarness(replayClient, replayRuntime.manifest, {
      async execute() {
        return { value: structuredClone(poisonedReplay), replayed: true };
      }
    });
    await expect(replayGateway.direct.execute(
      replayDescriptor.operationId,
      gatewayRequest(replayDescriptor, { idempotencyKey: "forged-replay" }),
      principal()
    )).rejects.toMatchObject({ code: "SCHEMA_MISMATCH" });
    expect(replayClient.executeCalls).toBe(0);
  });

  it("does not expose sensitive provider token or Geometry bytes in errors, audit, or traces", async () => {
    const runtime = createElevationMockProvider();
    const descriptor = descriptorFor(runtime);
    const client = new CountingProviderClient(runtime, undefined, () => {
      throw new ProviderProtocolError(
        "INTERNAL_PROVIDER_ERROR",
        `upstream Authorization: Bearer ${SENSITIVE_TOKEN}`,
        {
          details: {
            authorization: `Bearer ${SENSITIVE_TOKEN}`,
            geometry: { type: "Point", coordinates: [SENSITIVE_COORDINATE, 45.678901234] }
          }
        }
      );
    });
    const gateway = gatewayHarness(client, runtime.manifest);
    const app = buildGatewayApp({
      registry: gateway.registry,
      directExecution: gateway.direct,
      records: gateway.records,
      authenticate: async () => principal()
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/operations/${descriptor.operationId}:execute`,
      payload: gatewayRequest(descriptor, {
        idempotencyKey: "sensitive-provider-error",
        input: { longitude: SENSITIVE_COORDINATE, latitude: 45.678901234 }
      })
    });
    const serializedResponse = response.body;
    const serializedAudit = JSON.stringify(gateway.audit.events());

    expect(response.statusCode).toBe(500);
    expect(serializedResponse).not.toContain(SENSITIVE_TOKEN);
    expect(serializedResponse).not.toContain(String(SENSITIVE_COORDINATE));
    expect(serializedAudit).not.toContain(SENSITIVE_TOKEN);
    expect(serializedAudit).not.toContain(String(SENSITIVE_COORDINATE));
    expect(gateway.audit.events()[0]).toMatchObject({
      outcome: "REJECTED",
      inputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      errorCode: "INTERNAL_PROVIDER_ERROR"
    });
    await app.close();

    const open = createOpenObjectProvider();
    const dagGateway = gatewayHarness(new CountingProviderClient(open.runtime, undefined, sensitiveFailure), open.manifest);
    const dagRuntime = new WorldQueryRuntime({
      validator: new QueryPlanValidator(dagGateway.registry),
      directExecution: dagGateway.direct,
      store: new MemoryQueryPlanStore(),
      autoRunAsync: false
    });
    const submitted = await dagRuntime.submit(
      oneNodeSubmission(open.descriptor, { value: SENSITIVE_COORDINATE }, "query_sensitive_error"),
      principal()
    );
    const serializedDag = JSON.stringify(submitted.result);
    expect(serializedDag).not.toContain(SENSITIVE_TOKEN);
    expect(serializedDag).not.toContain(String(SENSITIVE_COORDINATE));
    expect(submitted.result?.nodes[0]?.error).toMatchObject({
      error: {
        code: "INTERNAL_PROVIDER_ERROR",
        message: "Gateway request failed",
        nodeId: "nodeA",
        providerId: open.manifest.provider.providerId
      }
    });

    const healthRuntime = createElevationMockProvider();
    const healthClient = new CountingProviderClient(healthRuntime);
    healthClient.health = async () => {
      throw new Error(`health Authorization: Bearer ${SENSITIVE_TOKEN}; coordinates=${SENSITIVE_COORDINATE}`);
    };
    const healthGateway = gatewayHarness(healthClient, healthRuntime.manifest);
    const healthApp = buildGatewayApp({
      registry: healthGateway.registry,
      directExecution: healthGateway.direct,
      authenticate: async () => principal()
    });
    const healthResponse = await healthApp.inject({ method: "GET", url: "/health" });
    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.body).not.toContain(SENSITIVE_TOKEN);
    expect(healthResponse.body).not.toContain(String(SENSITIVE_COORDINATE));
    expect(healthResponse.json()).toMatchObject({
      status: "degraded",
      providers: {
        [healthRuntime.manifest.provider.providerId]: {
          live: false,
          ready: false,
          detail: "health check failed"
        }
      }
    });
    await healthApp.close();
  });
});

function sensitiveFailure(): never {
  throw new ProviderProtocolError(
    "INTERNAL_PROVIDER_ERROR",
    `upstream Authorization: Bearer ${SENSITIVE_TOKEN}`,
    {
      details: {
        authorization: `Bearer ${SENSITIVE_TOKEN}`,
        geometry: { type: "Point", coordinates: [SENSITIVE_COORDINATE, 45.678901234] }
      }
    }
  );
}
