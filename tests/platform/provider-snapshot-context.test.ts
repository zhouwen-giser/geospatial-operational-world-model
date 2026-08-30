import { describe, expect, it } from "vitest";
import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  GowmV07QuerySnapshotManifest,
  ProviderExecutionRequest
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  getContractSchema,
  getContractSchemaHash
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,
  ProviderProtocolError,
  sha256,
  type ProviderHandlerContext,
  type ProviderOperation
} from "../../packages/platform/provider-sdk/src/index.js";

const objectSchema = getContractSchema("value-object.schema.json");
const objectSchemaHash = getContractSchemaHash("value-object.schema.json");

function descriptor(): CapabilityDescriptor {
  return {
    operationId: "test.snapshot.context",
    operationVersion: "1.0",
    semanticRole: "GENERIC_ANALYSIS",
    dataBinding: "WORLD_INDEPENDENT",
    resultSemantics: "TRANSFORMATION",
    executionBindings: ["EMBEDDED_SDK"],
    criticalPathPolicy: "EMBEDDED_REQUIRED",
    maturity: "PREVIEW",
    inputSchemaUri: "urn:gowm:v0.2:value:object",
    inputSchemaHash: objectSchemaHash,
    outputSchemaUri: "urn:gowm:v0.2:value:object",
    outputSchemaHash: objectSchemaHash,
    scopePolicy: "REQUEST_CONTEXT",
    execution: { mode: "SYNC", defaultTimeoutMs: 1_000, maximumTimeoutMs: 5_000, costClass: "LOW" },
    limits: { maximumInputBytes: 16_384, maximumOutputBytes: 16_384 },
    snapshotPolicy: {
      dataSnapshot: "NONE",
      computeSnapshot: "REQUIRED",
      resourceResolution: "NOT_APPLICABLE"
    },
    ports: {
      inputs: [{
        name: "request",
        schemaUri: "urn:gowm:v0.2:value:object",
        schemaHash: objectSchemaHash,
        valueKind: "ANY",
        unitSemantics: "UNSPECIFIED"
      }],
      outputs: [{
        name: "result",
        schemaUri: "urn:gowm:v0.2:value:object",
        schemaHash: objectSchemaHash,
        valueKind: "ANY",
        unitSemantics: "UNSPECIFIED"
      }]
    }
  };
}

function manifest(capability: CapabilityDescriptor): CapabilityProviderManifest {
  return {
    providerProtocolVersion: "1.0",
    provider: {
      providerId: "gowm.snapshot-context-fixture",
      providerVersion: "1.0.0",
      owner: "gowm-platform",
      implementationDigest: sha256({ fixture: "snapshot-context", version: 1 })
    },
    endpoints: {
      manifest: "/v1/manifest",
      liveness: "/health/live",
      readiness: "/health/ready",
      execute: "/v1/operations/{operationId}:execute",
      job: "/v1/jobs/{jobId}"
    },
    capabilities: [capability]
  };
}

function snapshot(version = "1"): GowmV07QuerySnapshotManifest {
  const body = {
    querySnapshotId: "snapshot-test",
    mode: "PINNED" as const,
    consistency: "PINNED" as const,
    capturedAt: "2026-08-30T00:00:00.000Z",
    resources: [{
      resourceKind: "TRACKLET_VERSION",
      resourceId: "source-a:tracklet-1",
      version,
      contentHash: sha256({ version }),
      worldVersion: 7,
      pinning: "PINNED" as const
    }]
  };
  return { ...body, manifestHash: sha256(body) };
}

function request(
  capability: CapabilityDescriptor,
  idempotencyKey: string,
  snapshots: Pick<ProviderExecutionRequest, "requestedSnapshot" | "effectiveSnapshot"> = {}
): ProviderExecutionRequest {
  return {
    providerProtocolVersion: "1.0",
    requestId: `request-${idempotencyKey}`,
    gatewayRequestId: `gateway-${idempotencyKey}`,
    idempotencyKey,
    operation: {
      operationId: capability.operationId,
      operationVersion: capability.operationVersion,
      inputSchemaHash: capability.inputSchemaHash,
      outputSchemaHash: capability.outputSchemaHash
    },
    input: { value: idempotencyKey },
    securityContext: {
      principalRef: "principal:test",
      authenticationMethod: "TEST",
      authenticatedAt: "2026-08-30T00:00:00.000Z",
      scopeAttestation: {
        issuer: "gateway-test",
        issuedAt: "2026-08-30T00:00:00.000Z",
        expiresAt: "2026-08-30T00:10:00.000Z",
        claimDigest: sha256({ principal: "principal:test" })
      }
    },
    gatewayContext: {
      gatewayId: "gateway-test",
      registryVersion: "registry-test",
      policyVersion: "policy-test"
    },
    executionPolicy: {
      deadlineAt: "2026-08-30T00:05:00.000Z",
      maximumInputBytes: 16_384,
      maximumResultBytes: 16_384,
      maximumCostClass: "LOW"
    },
    ...snapshots
  };
}

function harness(
  onHandle: (context: ProviderHandlerContext) => void,
  options: {
    configureDescriptor?: (value: CapabilityDescriptor) => void;
    dataSnapshot?: NonNullable<Awaited<ReturnType<ProviderOperation["handle"]>>["dataSnapshot"]>;
  } = {}
) {
  const capability = descriptor();
  options.configureDescriptor?.(capability);
  const operation: ProviderOperation = {
    descriptor: capability,
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    method: { engine: "snapshot-fixture", engineVersion: "1.0", methodId: "identity", methodVersion: "1.0" },
    async handle(input, context) {
      onHandle(context);
      return {
        status: "COMPLETED",
        value: input,
        ...(options.dataSnapshot === undefined ? {} : { dataSnapshot: options.dataSnapshot })
      };
    }
  };
  return {
    capability,
    runtime: createProviderRuntime({
      manifest: manifest(capability),
      operations: [operation],
      policyVersion: "snapshot-fixture/1.0",
      policyDigest: sha256({ policy: "snapshot-fixture/1.0" }),
      now: () => new Date("2026-08-30T00:00:01.000Z")
    })
  };
}

describe("Provider SDK requested/effective snapshot context", () => {
  it("keeps old requests without snapshots compatible", async () => {
    let received: ProviderHandlerContext | undefined;
    const { capability, runtime } = harness((context) => { received = context; });
    await runtime.execute(request(capability, "old-request"));
    expect(received?.snapshots).toEqual({});
  });

  it("falls back effective to an independent requested clone", async () => {
    const original = snapshot();
    let observedEffectiveVersion: string | undefined;
    const { capability, runtime } = harness((context) => {
      expect(context.snapshots.requested).toEqual(original);
      expect(context.snapshots.effective).toEqual(original);
      expect(context.snapshots.requested).not.toBe(context.snapshots.effective);
      context.snapshots.requested!.resources[0]!.version = "handler-mutated";
      observedEffectiveVersion = context.snapshots.effective!.resources[0]!.version;
    });
    await runtime.execute(request(capability, "requested-only", { requestedSnapshot: original }));
    expect(observedEffectiveVersion).toBe("1");
    expect(original.resources[0]!.version).toBe("1");
  });

  it("passes separately cloned requested and effective manifests", async () => {
    const requested = snapshot("1");
    const effective = snapshot("2");
    let received: ProviderHandlerContext | undefined;
    const { capability, runtime } = harness((context) => { received = context; });
    await runtime.execute(request(capability, "both", { requestedSnapshot: requested, effectiveSnapshot: effective }));
    expect(received?.snapshots.requested).toEqual(requested);
    expect(received?.snapshots.effective).toEqual(effective);
    expect(received?.snapshots.requested).not.toBe(requested);
    expect(received?.snapshots.effective).not.toBe(effective);
  });

  it("rejects a structurally valid manifest with a forged manifestHash", async () => {
    const forged = { ...snapshot(), manifestHash: `sha256:${"0".repeat(64)}` };
    const { capability, runtime } = harness(() => undefined);
    await expect(runtime.execute(request(capability, "forged", { requestedSnapshot: forged })))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" } satisfies Partial<ProviderProtocolError>);
  });

  it("binds idempotency to requested/effective snapshot context", async () => {
    const { capability, runtime } = harness(() => undefined);
    await runtime.execute(request(capability, "same-key", { effectiveSnapshot: snapshot("1") }));
    await expect(runtime.execute(request(capability, "same-key", { effectiveSnapshot: snapshot("2") })))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<ProviderProtocolError>);
  });

  it("permits an explicitly declared caller-bound resource resolver to report its Data Snapshot", async () => {
    const dataSnapshot = {
      consistency: "PINNED" as const,
      capturedAt: "2026-08-30T00:00:00.000Z",
      scopeDigest: sha256({ scope: "caller-test" }),
      resources: [{
        referenceKey: { namespace: "gowm", kind: "TRACKLET_VERSION", id: "tracklet-1", version: "1" },
        authority: "caller-fixture",
        pinning: "PINNED" as const,
        digest: sha256({ tracklet: 1 }),
        worldVersion: 7
      }]
    };
    const { capability, runtime } = harness(() => undefined, {
      configureDescriptor(value) {
        value.dataBinding = "CALLER_DATA_BOUND";
        value.snapshotPolicy = {
          dataSnapshot: "REQUIRED",
          computeSnapshot: "REQUIRED",
          resourceResolution: "DISCOVER_RESOURCES"
        };
      },
      dataSnapshot
    });
    await expect(runtime.execute(request(capability, "caller-bound"))).resolves.toMatchObject({ dataSnapshot });
  });
});
