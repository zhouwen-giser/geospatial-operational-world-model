import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateContract,
  type CapabilityDescriptor,
  type DelegationTokenClaims,
  type WorldQuerySubmission
} from "../../packages/platform/contract-runtime/src/index.js";
import { createElevationMockProvider } from "../../services/providers/elevation-mock/src/provider.js";
import {
  CapabilityRegistry,
  InProcessProviderClient,
  OperationAvailabilityService,
  ProviderCircuitBreaker,
  QuerySnapshotCoordinator,
  SignedDelegationVerifier,
  type GatewayPrincipal
} from "../../services/gateway/world-capability-gateway/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("GOWM v0.6.3 grounding core stabilization", () => {
  it("accepts only correctly bound one-hop delegated identity and derives stable hash-only context", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = 1_787_763_600;
    const verifier = new SignedDelegationVerifier({
      issuer: "https://identity.example.test",
      audience: "gowm-world-gateway",
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      now: () => new Date(now * 1_000)
    });
    const claims: DelegationTokenClaims = {
      iss: "https://identity.example.test", sub: "service:wsgs", aud: "gowm-world-gateway",
      iat: now - 1, nbf: now - 1, exp: now + 120, jti: "delegation-jti-0001",
      act: { sub: "actor:planner" }, requestId: "request:bound", delegationDepth: 1,
      dataScopes: ["tenant:a", "tenant:forged"], datasetScopes: ["dataset:roads"],
      allowedOperations: ["reference.get@1.0", "not.registered@1.0"]
    };
    const token = compactJws(claims, privateKey);
    const context = {
      servicePrincipalRef: "service:wsgs", requestId: "request:bound",
      allowedDataScopes: ["tenant:a"], allowedDatasetScopes: ["dataset:roads"],
      registeredOperations: ["reference.get@1.0"], allowExperimental: false
    };
    const first = verifier.verify(token, context);
    const resigned = verifier.verify(compactJws(claims, privateKey), context);

    expect(first).toMatchObject({
      mode: "SIGNED_DELEGATION_V1", servicePrincipalRef: "service:wsgs", actorRef: "actor:planner",
      effectiveDataScopes: ["tenant:a"], effectiveDatasetScopes: ["dataset:roads"],
      allowedOperations: ["reference.get@1.0"]
    });
    expect(first.authorizationContextHash).toBe(resigned.authorizationContextHash);
    expect(JSON.stringify(first)).not.toContain(token);
    expect(first.delegationJtiHash).toMatch(/^sha256:[0-9a-f]{64}$/u);

    for (const mutation of [
      { aud: "other" }, { iss: "https://evil.example.test" }, { sub: "service:other" },
      { requestId: "request:other" }, { delegationDepth: 2 }, { exp: now + 301 },
      { nbf: now + 60 }, { allowedOperations: ["not.registered@1.0"] }
    ]) {
      expect(() => verifier.verify(compactJws({ ...claims, ...mutation }, privateKey), context)).toThrow();
    }
    const parts = token.split(".");
    expect(() => verifier.verify(`${parts[0]}.${parts[1]}.AAAA`, context)).toThrow(/signature/u);
  });

  it("coordinates deterministic pinned snapshots and fails closed on strict mismatch", () => {
    const coordinator = new QuerySnapshotCoordinator(() => new Date("2026-08-27T00:00:00.000Z"));
    const submission = snapshotSubmission();
    const manifest = coordinator.resolve(submission);
    const replay = coordinator.resolve(submission);
    expect(manifest).toEqual(replay);
    expect(manifest).toMatchObject({ mode: "LATEST_AT_START", consistency: "CONSISTENT_AT_START" });
    expect(manifest.resources).toEqual([expect.objectContaining({ resourceKind: "DATASET", resourceId: "scope:roads", version: "42" })]);
    coordinator.assertManifestHash(manifest);
    const descriptor = { dataBinding: "WORLD_SNAPSHOT_BOUND" } as CapabilityDescriptor;
    const adherence = coordinator.adherence("node:reference", descriptor, manifest);
    expect(adherence.status).toBe("UNSUPPORTED");
    expect(() => coordinator.assertAdherence(submission.snapshotPolicy, adherence)).toThrow(/strict query snapshot/u);
    expect(() => coordinator.assertManifestHash({ ...manifest, capturedAt: "2026-08-27T00:00:01.000Z" })).toThrow(/hash/u);
  });

  it("projects authorized availability with bounded cache and no provider topology", async () => {
    const runtime = createElevationMockProvider();
    const client = new InProcessProviderClient(runtime);
    let healthCalls = 0;
    const registry = new CapabilityRegistry();
    registry.register({
      approvalId: "availability-test", approved: true, endpoint: new URL("http://127.0.0.1:39090/"),
      manifest: runtime.manifest,
      client: { ...client, providerId: client.providerId, manifest: () => client.manifest(), execute: (...args) => client.execute(...args), health: async () => { healthCalls += 1; return client.health(); } }
    });
    const service = new OperationAvailabilityService({ registry, circuits: new ProviderCircuitBreaker(), cacheTtlMs: 4_000 });
    const principal: GatewayPrincipal = {
      principalRef: "service:test", authenticationMethod: "TEST", authenticatedAt: new Date().toISOString(),
      allowExperimental: true, allowedOperations: ["elevation.sample.mock@1.0"]
    };
    const first = await service.list(principal);
    const second = await service.list(principal);
    expect(first.operations).toEqual([expect.objectContaining({ availability: "AVAILABLE", reasonCodes: ["READY"] })]);
    expect(second.operations).toHaveLength(1);
    expect(healthCalls).toBe(1);
    expect(JSON.stringify(first)).not.toMatch(/127\.0\.0\.1|providerId|endpoint/u);
    await expect(service.get("elevation.sample.mock", "1.0", { ...principal, allowedOperations: [] })).resolves.toBeUndefined();
    expect(() => new OperationAvailabilityService({ registry, circuits: new ProviderCircuitBreaker(), cacheTtlMs: 5_001 })).toThrow(/5000/u);
  });

  it("promotes exactly the ten qualified operations and validates the generated consumer distribution", async () => {
    const registry = JSON.parse(await readFile(join(root, "config/world-platform-gateway-registry.json"), "utf8"));
    const catalog = [];
    for (const provider of registry.providers) {
      const manifest = JSON.parse(await readFile(join(root, provider.manifestPath), "utf8"));
      catalog.push(...manifest.capabilities);
    }
    const expected = new Set([
      "reference.get@1.0", "reference.resolve@1.0", "world.get-current-state@1.0", "world.get-geometry@1.0",
      "world.get-provenance@1.0", "catalog.get@1.0", "catalog.search@1.0", "spatial.find-nearby@1.0",
      "spatial.find-in-area@1.0", "spatial.find-intersections@1.0"
    ]);
    expect(catalog.filter((operation) => operation.maturity === "STABLE")).toHaveLength(31);
    expect(catalog.filter((operation) => operation.maturity === "PREVIEW")).toHaveLength(89);
    expect(catalog.filter((operation) => operation.maturity === "EXPERIMENTAL")).toHaveLength(2);
    for (const key of expected) {
      const [operationId, operationVersion] = key.split("@");
      expect(catalog.find((operation) => operation.operationId === operationId && operation.operationVersion === operationVersion)?.maturity).toBe("STABLE");
    }
    const lock = JSON.parse(await readFile(join(root, "contracts/consumers/wsgs-southbound-operation-lock-v2.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(root, "packages/platform/world-gateway-contracts/bundle/MANIFEST.json"), "utf8"));
    expect(validateContract("urn:gowm:v0.6.3:wsgs-southbound-operation-lock-v2", lock)).toMatchObject({ valid: true });
    expect(validateContract("urn:gowm:v0.6.3:consumer-contract-bundle-manifest", manifest)).toMatchObject({ valid: true });
    expect(lock.defaultOperations).toHaveLength(31);
    expect(lock.consumerContractPackage.integrity).toBe(manifest.packageIntegrity);
    const bundleNames = await walk(join(root, "packages/platform/world-gateway-contracts/bundle"));
    expect(bundleNames.some((path) => /provider-registry|\.env|token/iu.test(path))).toBe(false);
  });
});

function compactJws(claims: unknown, privateKey: Parameters<typeof sign>[2]): string {
  const input = `${encoded({ alg: "RS256", typ: "JWT" })}.${encoded(claims)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

function snapshotSubmission(): WorldQuerySubmission {
  return {
    requestId: "request:snapshot", idempotencyKey: "idem:snapshot", parameterSchemaHash: `sha256:${"0".repeat(64)}`, parameters: {},
    snapshotPolicy: { mode: "LATEST_AT_START", allowDowngrade: false },
    plan: {
      queryPlanVersion: "2.0", queryId: "query:snapshot",
      nodes: [{
        nodeId: "node:reference", operationId: "reference.get", operationVersion: "1.0",
        inputSchemaHash: `sha256:${"1".repeat(64)}`, outputSchemaHash: `sha256:${"2".repeat(64)}`,
        inputs: { request: { kind: "REFERENCE_KEY", port: { schemaUri: "urn:test", schemaHash: `sha256:${"1".repeat(64)}`, valueKind: "REFERENCE_KEY", unitSemantics: "UNSPECIFIED" }, referenceKey: { kind: "DATASET", namespace: "scope", id: "roads", version: "42" } } },
        failurePolicy: "FAIL_FAST"
      }],
      outputs: [], budgets: { maximumNodes: 1, maximumDepth: 1, maximumRows: 1, maximumCandidates: 1, maximumOutputBytes: 1024, maximumExecutionMs: 1000 }
    }
  } as unknown as WorldQuerySubmission;
}

async function walk(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? walk(join(rootPath, entry.name)) : join(rootPath, entry.name)))).flat();
}
