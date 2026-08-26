import { describe, expect, it, vi } from "vitest";
import { createStasProvider } from "../../services/providers/stas-provider/src/provider.js";
import { buildStasProviderApp } from "../../services/providers/stas-provider/src/app.js";
import { validateContract, type ProviderExecutionRequest } from "../../packages/platform/contract-runtime/src/index.js";

describe("STAS protocol adapter", () => {
  const noIO = async (): Promise<never> => { throw new Error("unexpected native IO"); };
  it("exports all fifteen explicit operations without changing execution protocol or promoting maturity", () => {
    const { runtime } = createStasProvider({ withTransaction: noIO }, { execute: noIO });
    expect(runtime.manifest.providerProtocolVersion).toBe("1.0");
    expect(runtime.manifest.manifestSchemaVersion).toBe("1.1");
    expect(runtime.manifest.capabilities).toHaveLength(15);
    expect(runtime.manifest.capabilities.every((c) => c.maturity === "PREVIEW" && c.semanticProfile?.domain === "TEMPORAL")).toBe(true);
    expect(validateContract("capability-provider-manifest.schema.json", runtime.manifest).valid).toBe(true);
  });
  it("keeps liveness independent of unavailable native data", async () => {
    const provider = createStasProvider({ withTransaction: noIO }, { execute: noIO });
    const app = buildStasProviderApp(provider.runtime, "unit-test-transport-token-with-at-least-32-bytes", provider.readiness);
    try {
      expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(503);
      expect((await app.inject({ method: "POST", url: "/v1/operations/stas.get-tracklet:execute", payload: {} })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
  it("authorizes native UUID scope before invoking any analysis", async () => {
    const execute = vi.fn(noIO);
    const withTransaction = vi.fn(async (_timeout, _mode, callback) => callback({ query: async () => ({ rows: [] }) }));
    const { runtime } = createStasProvider({ withTransaction }, { execute });
    const descriptor = runtime.manifest.capabilities.find((c) => c.operationId === "stas.get-tracklet")!;
    const now = new Date(), deadline = new Date(now.getTime() + 5000).toISOString();
    const request: ProviderExecutionRequest = {
      providerProtocolVersion: "1.0", requestId: "stas-scope-test", gatewayRequestId: "stas-scope-test", idempotencyKey: "stas-scope-test",
      operation: { operationId: descriptor.operationId, operationVersion: "1.0", inputSchemaHash: descriptor.inputSchemaHash, outputSchemaHash: descriptor.outputSchemaHash },
      input: { dataScopeId: "11111111-1111-4111-8111-111111111111", tracklet: { trackletId: "22222222-2222-4222-8222-222222222222", versionNo: 1 } },
      securityContext: { principalRef: "test", authenticationMethod: "UNIT", authenticatedAt: now.toISOString(), dataScopeClaim: "authorized-tenant", scopeAttestation: { issuer: "test", issuedAt: now.toISOString(), expiresAt: deadline, claimDigest: `sha256:${"1".repeat(64)}` } },
      gatewayContext: { gatewayId: "test", registryVersion: "test", policyVersion: "test" },
      executionPolicy: { deadlineAt: deadline, maximumInputBytes: 1048576, maximumResultBytes: 1048576, maximumCostClass: "HIGH" }
    };
    await expect(runtime.execute(request)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(withTransaction).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
});
