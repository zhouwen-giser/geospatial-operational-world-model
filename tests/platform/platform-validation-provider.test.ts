import { describe, expect, it } from "vitest";
import { validateContract, type ProviderExecutionRequest } from "../../packages/platform/contract-runtime/src/index.js";
import { createDataSnapshot, type DataSnapshotManifest, type ReferenceRecord, type SnapshotResource } from "../../packages/platform/result-validation-core/src/index.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { createPlatformValidationProvider, type PlatformValidationAuthority } from "../../services/providers/platform-validation-provider/src/index.js";
import { buildPlatformValidationApp } from "../../services/providers/platform-validation-provider/src/app.js";

const now = new Date("2026-08-25T00:00:00.000Z");
const referenceKey = { namespace: "gowm" as const, kind: "QUERY_RESULT", id: `wrf_${"1".repeat(32)}`, version: "1" };
const resource: SnapshotResource = { referenceKey, resourceKind: "QUERY_RESULT", resourceId: referenceKey.id, version: "1", contentHash: `sha256:${"2".repeat(64)}` };
const snapshot = createDataSnapshot("PINNED", [resource], now.toISOString());

class Authority implements PlatformValidationAuthority {
  record: ReferenceRecord = { referenceKey, sourceStatus: "SUCCEEDED", sourceAuthority: "gowm.road-coverage-planning", available: true, snapshotStatus: "STALE" };
  async resolveReferences() { return [this.record]; }
  async getSnapshot(snapshotId: string): Promise<DataSnapshotManifest | undefined> { return snapshotId === snapshot.snapshotId ? snapshot : undefined; }
  async currentResources(): Promise<ReadonlyMap<string, SnapshotResource | "UNAVAILABLE">> { return new Map([[`QUERY_RESULT\0${referenceKey.id}`, { ...resource, version: "2" }]]); }
}

describe("platform validation Provider", () => {
  it("registers stable result and snapshot operations", () => {
    const manifest = createPlatformValidationProvider(new Authority(), () => now).runtime.manifest;
    expect(validateContract("capability-provider-manifest.schema.json", manifest).valid).toBe(true);
    expect(manifest.capabilities.map(({ operationId }) => operationId)).toEqual(["result.validate", "snapshot.get", "snapshot.validate"]);
    expect(manifest.capabilities.every(({ snapshotPolicy, scopePolicy }) => scopePolicy === "DATA_SCOPE_REQUIRED" && snapshotPolicy.dataSnapshot === "REQUIRED" && snapshotPolicy.computeSnapshot === "REQUIRED")).toBe(true);
  });

  it("normalizes result status without hiding source status and validates snapshots read-only", async () => {
    const authority = new Authority();
    const provider = createPlatformValidationProvider(authority, () => now);
    const validated = await execute(provider.runtime, "result.validate", { schemaVersion: "1.0", references: [{ referenceKey, requireCurrentSnapshot: true }] }, "result");
    expect(validated.output?.value).toMatchObject({ results: [{ existence: "AVAILABLE", freshness: "STALE", snapshot: "STALE", usable: "REVALIDATE", resultSemantics: { normalizedStatus: "COMPLETED", sourceStatus: "SUCCEEDED", sourceAuthority: "gowm.road-coverage-planning" } }] });

    const retrieved = await execute(provider.runtime, "snapshot.get", { schemaVersion: "1.0", snapshotId: snapshot.snapshotId }, "get");
    expect(retrieved.output?.value).toEqual(snapshot);
    const currentness = await execute(provider.runtime, "snapshot.validate", { schemaVersion: "1.0", snapshot }, "snapshot");
    expect(currentness.output?.value).toMatchObject({ snapshotId: snapshot.snapshotId, status: "STALE", resourceResults: [{ status: "STALE", currentVersion: "2" }] });
    expect(snapshot.resources[0]?.version).toBe("1");
  });

  it("serves the controlled Provider protocol over authenticated HTTP", async () => {
    const provider = createPlatformValidationProvider(new Authority(), () => now);
    const app = buildPlatformValidationApp(provider, "platform-validation-test-token-32-bytes");
    const manifest = await app.inject({ method: "GET", url: "/v1/manifest" });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toMatchObject({ provider: { providerId: "gowm.platform-validation" } });
    const request = executionRequest(provider.runtime, "result.validate", { schemaVersion: "1.0", references: [{ referenceKey }] }, "http");
    const denied = await app.inject({ method: "POST", url: "/v1/operations/result.validate:execute", payload: request });
    expect(denied.statusCode).toBe(403);
    const response = await app.inject({ method: "POST", url: "/v1/operations/result.validate:execute", headers: { authorization: "Bearer platform-validation-test-token-32-bytes" }, payload: request });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ output: { value: { results: [{ usable: "REVALIDATE" }] } } });
    await app.close();
  });
});

async function execute(runtime: ReturnType<typeof createPlatformValidationProvider>["runtime"], operationId: string, input: unknown, suffix: string) {
  return runtime.execute(executionRequest(runtime, operationId, input, suffix));
}

function executionRequest(runtime: ReturnType<typeof createPlatformValidationProvider>["runtime"], operationId: string, input: unknown, suffix: string): ProviderExecutionRequest {
  const descriptor = runtime.manifest.capabilities.find((value) => value.operationId === operationId);
  if (descriptor === undefined) throw new Error(`missing ${operationId}`);
  const deadlineAt = "2026-08-25T00:01:00.000Z";
  const request: ProviderExecutionRequest = {
    providerProtocolVersion: "1.0", requestId: `validation-${suffix}`, gatewayRequestId: `gateway-${suffix}`, idempotencyKey: `validation-idempotency-${suffix}`,
    operation: { operationId, operationVersion: "1.0", inputSchemaHash: descriptor.inputSchemaHash, outputSchemaHash: descriptor.outputSchemaHash }, input,
    securityContext: { principalRef: "principal:validation", authenticationMethod: "TEST", authenticatedAt: "2026-08-24T23:59:00.000Z", dataScopeClaim: "scope-a", datasetScopeClaim: "dataset-a", scopeAttestation: { issuer: "test", issuedAt: "2026-08-24T23:59:00.000Z", expiresAt: deadlineAt, claimDigest: sha256({ scope: "scope-a" }) } },
    gatewayContext: { gatewayId: "gateway", registryVersion: "v0.6.1", policyVersion: "v0.6.1" },
    executionPolicy: { deadlineAt, maximumInputBytes: 1_048_576, maximumResultBytes: 4_194_304, maximumCostClass: "LOW" }
  };
  return request;
}
