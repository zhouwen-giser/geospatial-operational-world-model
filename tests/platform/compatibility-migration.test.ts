import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";
import type {
  CapabilityResultEnvelope,
  ProviderExecutionRequest
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  canonicalSha256,
  validateAgainstSchema,
  validateContract
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  compatibilityDeprecationHeaders,
  type ControlledCompatibilityOperation,
  type GatewayOperationClient,
  WorldApiCompatibilityAdapter
} from "../../packages/platform/compatibility-runtime/src/index.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { runProviderConformance } from "../../packages/platform/conformance-kit/src/index.js";
import {
  createObservationCommandMcpServer,
  createWorldQueryReadonlyMcpServer
} from "../../services/world-mcp-server/src/split-servers.js";
import { createGowmSituationProvider } from "../../services/providers/gowm-situation-provider/src/provider.js";
import { RepositorySituationReadPort } from "../../services/providers/gowm-situation-provider/src/repository-adapter.js";
import { GOWM_SITUATION_OPERATION_SCHEMAS } from "../../services/providers/gowm-situation-provider/src/schemas.js";
import type { GowmSituationReadPort } from "../../services/providers/gowm-situation-provider/src/types.js";
import type { SituationCell } from "../../packages/world-model-core/src/types.js";

const fixedNow = new Date("2026-08-23T00:00:00.000Z");
const h3Index = "8928308280fffff";
const reference = { namespace: "gowm", kind: "WORLD_OBJECT", id: "wrf_0123456789abcdef0123456789abcdef", version: "42" };
const situationCell: SituationCell = {
  h3Index,
  resolution: 9,
  metrics: {
    agentCount: 1,
    vehicleCount: 1,
    sensorCount: 0,
    incidentCount: 0,
    observationCount: 3,
    riskScore: 1,
    coverageScore: 20,
    activityScore: 12,
    freshnessScore: 99
  },
  updatedAt: "2026-08-22T23:59:59.000Z",
  worldVersion: 42
};

class MockSituationPort implements GowmSituationReadPort {
  readonly scopes: string[] = [];

  async getCells(scope: string, indexes: string[]): Promise<SituationCell[]> {
    this.scopes.push(scope);
    return indexes.includes(h3Index) ? [situationCell] : [];
  }

  async candidateReferences(scope: string): Promise<typeof reference[]> {
    this.scopes.push(scope);
    return [reference];
  }

  async areaCells(scope: string): Promise<SituationCell[]> {
    this.scopes.push(scope);
    return [situationCell];
  }

  async ranked(scope: string): Promise<SituationCell[]> {
    this.scopes.push(scope);
    return [situationCell];
  }

  async worldVersion(scope: string): Promise<number> {
    this.scopes.push(scope);
    return 42;
  }
}

describe("P14 GOWM Situation Gateway capability", () => {
  it("publishes four strict per-operation contracts and a matching canonical manifest", async () => {
    const provider = createGowmSituationProvider({ port: new MockSituationPort(), acceptedDataScope: "default", now: () => fixedNow });
    const staticManifest = JSON.parse(await readFile(
      new URL("../../contracts/manifests/providers/gowm-situation-provider.json", import.meta.url),
      "utf8"
    )) as unknown;

    expect(provider.runtime.manifest).toEqual(staticManifest);
    expect(provider.runtime.manifest.capabilities.map((value) => value.operationId)).toEqual([
      "gowm.situation.h3.get-cell",
      "gowm.situation.h3.get-area",
      "gowm.situation.h3.get-hotspots",
      "gowm.situation.h3.get-coverage-gaps"
    ]);
    expect(provider.runtime.manifest.capabilities.every((value) => value.scopePolicy === "DATA_SCOPE_REQUIRED")).toBe(true);
    expect(validateContract("urn:gowm:v0.2:capability-provider-manifest", provider.runtime.manifest)).toEqual({ valid: true, issues: [] });

    const schema = GOWM_SITUATION_OPERATION_SCHEMAS["gowm.situation.h3.get-cell"].input;
    expect(validateAgainstSchema(schema, { cells: [h3Index] }).valid).toBe(true);
    expect(validateAgainstSchema(schema, { h3Index, cells: [h3Index] }).valid).toBe(false);
    expect(validateAgainstSchema(schema, { cells: [h3Index], arbitrary: true }).valid).toBe(false);
  });

  it("returns only DB-grounded candidates and hashes the trusted deployment scope", async () => {
    const port = new MockSituationPort();
    const provider = createGowmSituationProvider({ port, acceptedDataScope: "default", now: () => fixedNow });
    const result = await provider.runtime.execute(providerRequest(provider.runtime.manifest.capabilities[0]!, {
      cells: [h3Index]
    }, "default"));

    expect(result.status).toBe("COMPLETED");
    expect(result.output?.value).toMatchObject({
      cells: [situationCell],
      references: [reference],
      candidateOnly: true,
      exactVerificationRequired: true,
      worldVersion: 42
    });
    expect(result.dataSnapshot).toMatchObject({
      consistency: "BEST_EFFORT",
      scopeDigest: sha256({ dataScopeKey: "default" }),
      resources: [{ referenceKey: { kind: "WORLD_PROJECTION", version: "42" } }]
    });
    expect(port.scopes.every((scope) => scope === "default")).toBe(true);
  });

  it("rejects a validly attested but non-deployment scope before repository access", async () => {
    const port = new MockSituationPort();
    const provider = createGowmSituationProvider({ port, acceptedDataScope: "default", now: () => fixedNow });

    await expect(provider.runtime.execute(providerRequest(provider.runtime.manifest.capabilities[0]!, {
      h3Index
    }, "tenant-b"))).rejects.toMatchObject({ code: "SCOPE_DENIED", retryable: false });
    expect(port.scopes).toEqual([]);
  });

  it("passes the shared Provider conformance kit with strict scope, hash, budget and deadline gates", async () => {
    const provider = createGowmSituationProvider({ port: new MockSituationPort(), acceptedDataScope: "default", now: () => fixedNow });
    const descriptor = provider.runtime.manifest.capabilities[0]!;
    const valid = providerRequest(descriptor, { cells: [h3Index] }, "default");
    const deadline = structuredClone(valid);
    deadline.idempotencyKey = "p14:deadline";
    deadline.executionPolicy.deadlineAt = new Date(Date.now() - 1_000).toISOString();
    const report = await runProviderConformance({
      runtime: provider.runtime,
      validRequest: valid,
      differentInput: { cells: ["8928308280bffff"] },
      unknownFieldInput: { cells: [h3Index], arbitrary: true },
      deadlineRequest: deadline
    });

    expect(report, JSON.stringify(report, null, 2)).toMatchObject({ passed: true });
    expect(report.checks.every((check) => check.status === "PASS")).toBe(true);
  });

  it("pins candidate SQL to the accepted scope and returns opaque reference keys", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      query: async (text: string, values: unknown[]) => {
        calls.push({ text, values });
        return text.includes("FROM data_scope")
          ? { rows: [{ scope_count: "1", accepted_count: "1" }] }
          : { rows: [{ reference_key: reference }] };
      }
    };
    const adapter = new RepositorySituationReadPort(
      {} as never,
      {} as never,
      pool as never,
      "default"
    );

    await expect(adapter.candidateReferences("tenant-b", [h3Index], 10)).rejects.toThrow("non-deployment data scope");
    await expect(adapter.candidateReferences("default", [h3Index], 10)).resolves.toEqual([reference]);
    const candidateCall = calls.find((call) => call.text.includes("world_reference_identity"));
    expect(candidateCall?.text).toContain("object.data_scope_key = $1");
    expect(candidateCall?.values).toEqual(["default", [h3Index], 10]);

    const multiScope = new RepositorySituationReadPort(
      {} as never,
      {} as never,
      { query: async () => ({ rows: [{ scope_count: "2", accepted_count: "1" }] }) } as never,
      "default"
    );
    await expect(multiScope.candidateReferences("default", [h3Index], 10)).rejects.toThrow("single-scope deployment");
    await expect(multiScope.readiness()).resolves.toEqual({
      ready: false,
      reasons: ["GOWM Situation provider requires a verifiable single-scope deployment"]
    });
  });
});

describe("P14 World API compatibility adapter", () => {
  it("dual-runs and returns the legacy result when exact and semantic parity match", async () => {
    const evidence: unknown[] = [];
    const gateway = new FakeGateway(spatialEnvelope());
    const adapter = new WorldApiCompatibilityAdapter({
      mode: "DUAL_RUN",
      gateway,
      now: () => fixedNow,
      onEvidence: (value) => evidence.push(value)
    });
    const legacy = legacyNearby();

    await expect(adapter.execute("spatial.nearby", nearbyInput(), async () => legacy)).resolves.toBe(legacy);
    expect(gateway.calls).toEqual(["spatial.find-nearby"]);
    expect(evidence).toEqual([expect.objectContaining({
      status: "MATCH",
      legacyResultHash: canonicalSha256(legacy.facts),
      legacySemanticHash: expect.stringMatching(/^sha256:/u)
    })]);
  });

  it("never switches on mismatch and requires an explicit zero-mismatch attestation for cutover", async () => {
    const evidence: Array<{ status: string }> = [];
    const gateway = new FakeGateway(spatialEnvelope({ status: "BUSY" }));
    const dual = new WorldApiCompatibilityAdapter({
      mode: "DUAL_RUN",
      gateway,
      now: () => fixedNow,
      onEvidence: (value) => evidence.push(value)
    });
    const legacy = legacyNearby();
    expect(await dual.execute("spatial.nearby", nearbyInput(), async () => legacy)).toBe(legacy);
    expect(evidence.at(-1)?.status).toBe("MISMATCH");

    const blockedGateway = new FakeGateway(spatialEnvelope());
    const blocked = new WorldApiCompatibilityAdapter({ mode: "GATEWAY", gateway: blockedGateway });
    expect(await blocked.execute("spatial.nearby", nearbyInput(), async () => legacy)).toBe(legacy);
    expect(blockedGateway.calls).toEqual([]);

    const cutover = new WorldApiCompatibilityAdapter({
      mode: "GATEWAY",
      gateway: new FakeGateway(spatialEnvelope()),
      attestations: [{
        schemaVersion: "1.0",
        route: "spatial.nearby",
        operationId: "spatial.find-nearby",
        verifiedAt: fixedNow.toISOString(),
        fixtureSetHash: sha256({ fixtures: "p14-nearby" }),
        comparisonCount: 20,
        mismatchCount: 0
      }]
    });
    await expect(cutover.execute("spatial.nearby", nearbyInput(), async () => {
      throw new Error("legacy should not run after attested cutover");
    })).resolves.toEqual(legacy);
  });

  it("keeps unsupported legacy filter semantics on the old implementation", async () => {
    const gateway = new FakeGateway(spatialEnvelope());
    const adapter = new WorldApiCompatibilityAdapter({ mode: "DUAL_RUN", gateway });
    const legacy = legacyNearby();
    await expect(adapter.execute("spatial.nearby", {
      ...nearbyInput(),
      filter: { status: "AVAILABLE" }
    }, async () => legacy)).resolves.toBe(legacy);
    expect(gateway.calls).toEqual([]);
  });

  it("adds Deprecation, Sunset and controlled successor links without removing routes", () => {
    expect(compatibilityDeprecationHeaders({
      path: "/spatial/nearby?trace=1",
      mode: "DUAL_RUN",
      sunset: new Date("2027-12-31T23:59:59.000Z")
    })).toEqual(expect.objectContaining({
      Deprecation: "true",
      Sunset: "Fri, 31 Dec 2027 23:59:59 GMT",
      Link: "</v1/operations/spatial.find-nearby:execute>; rel=\"successor-version\"",
      "X-GOWM-Compatibility-Mode": "DUAL_RUN"
    }));
    expect(compatibilityDeprecationHeaders({ path: "/health", mode: "LEGACY" })).toBeUndefined();
  });
});

describe("P14 MCP security split", () => {
  it("exposes only fixed read tools and sends every invocation to the Gateway", async () => {
    const gateway = new FakeGateway(situationEnvelope());
    const server = createWorldQueryReadonlyMcpServer({ gateway, gatewayContext: { dataScopeClaim: "default" } });
    const client = new Client({ name: "p14-read-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toEqual([
      "find_nearby_objects",
      "find_objects_in_area",
      "get_area_situation",
      "get_h3_situation",
      "get_h3_hotspots",
      "get_h3_coverage_gaps"
    ]);
    expect(names.some((name) => name.startsWith("publish_"))).toBe(false);
    const result = await client.callTool({ name: "get_h3_situation", arguments: { h3Index } });
    expect(result.isError).not.toBe(true);
    expect(gateway.calls).toEqual(["gowm.situation.h3.get-cell"]);

    await client.close();
    await server.close();
  });

  it("keeps Observation writes only on the command server and command path", async () => {
    const published: unknown[] = [];
    const server = createObservationCommandMcpServer({ client: { publish: async (input) => {
      published.push(input);
      return { accepted: true };
    } } });
    const client = new Client({ name: "p14-command-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport as unknown as Transport);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "publish_observation",
      "publish_canonical_observation"
    ]);
    const result = await client.callTool({
      name: "publish_observation",
      arguments: {
        observationId: "obs-p14-1",
        observer: { type: "Sensor", id: "sensor-1" },
        subject: { type: "Vehicle", id: "vehicle-1" },
        observationType: "position",
        value: {},
        confidence: 0.9,
        observedAt: fixedNow.toISOString(),
        source: "test",
        metadata: {},
        schemaVersion: "1.0"
      }
    });
    expect(result.isError).not.toBe(true);
    expect(published).toHaveLength(1);

    await client.close();
    await server.close();
  });
});

class FakeGateway implements GatewayOperationClient {
  readonly calls: ControlledCompatibilityOperation[] = [];
  constructor(private readonly result: CapabilityResultEnvelope) {}

  async execute(operationId: ControlledCompatibilityOperation): Promise<CapabilityResultEnvelope> {
    this.calls.push(operationId);
    return { ...structuredClone(this.result), operation: { ...this.result.operation, operationId } };
  }
}

function providerRequest(
  descriptor: { operationId: string; operationVersion: string; inputSchemaHash: string; outputSchemaHash: string },
  input: unknown,
  dataScopeClaim: string
): ProviderExecutionRequest {
  const issuedAt = fixedNow.toISOString();
  const deadlineAt = new Date(fixedNow.getTime() + 60_000).toISOString();
  return {
    providerProtocolVersion: "1.0",
    requestId: "p14_provider_request",
    gatewayRequestId: "p14_gateway_request",
    idempotencyKey: `p14:${dataScopeClaim}`,
    operation: {
      operationId: descriptor.operationId,
      operationVersion: descriptor.operationVersion,
      inputSchemaHash: descriptor.inputSchemaHash,
      outputSchemaHash: descriptor.outputSchemaHash
    },
    input,
    securityContext: {
      principalRef: "principal:p14",
      authenticationMethod: "TEST_ATTESTED",
      authenticatedAt: new Date(fixedNow.getTime() - 1_000).toISOString(),
      dataScopeClaim,
      scopeAttestation: {
        issuer: "gateway-test",
        issuedAt,
        expiresAt: deadlineAt,
        claimDigest: sha256({ principal: "principal:p14", dataScopeClaim })
      }
    },
    gatewayContext: { gatewayId: "gateway-test", registryVersion: "registry-1", policyVersion: "policy-1" },
    executionPolicy: {
      deadlineAt,
      maximumInputBytes: 1_048_576,
      maximumResultBytes: 16_777_216,
      maximumCostClass: "MEDIUM"
    }
  };
}

function nearbyInput() {
  return { location: { lon: 116.4, lat: 39.9 }, radiusM: 1_000, filter: {}, limit: 10 };
}

function legacyNearby(status = "AVAILABLE") {
  const facts = [{
    object: {
      id: reference.id,
      type: "Vehicle",
      state: { status },
      properties: { callsign: "V-1" },
      confidence: 0.9,
      observedAt: "2026-08-22T23:59:58.000Z",
      updatedAt: "2026-08-22T23:59:59.000Z",
      version: 42,
      freshnessMs: 2_000
    },
    distanceM: 230
  }];
  return {
    summary: { count: 1, nearestDistanceM: 230, radiusM: 1_000 },
    facts,
    context: { worldVersion: 42, dataFreshnessMs: 2_000, queryTimeMs: 3 }
  };
}

function spatialEnvelope(overrides: { status?: string } = {}): CapabilityResultEnvelope {
  const value = {
    objects: [{
      referenceKey: reference,
      objectType: "Vehicle",
      subtype: null,
      status: overrides.status ?? "AVAILABLE",
      source: "sensor",
      properties: { callsign: "V-1" },
      observedAt: "2026-08-22T23:59:58.000Z",
      receivedAt: "2026-08-22T23:59:58.100Z",
      updatedAt: "2026-08-22T23:59:59.000Z",
      worldVersion: 42,
      confidence: 0.9,
      freshnessMs: 2_000,
      provenance: { authority: "GOWM Foundation", sourceObservationId: "obs-1", summary: {} },
      distanceM: 230
    }],
    page: { count: 1, truncated: false },
    context: { crs: "EPSG:4326", snapshotConsistency: "CONSISTENT_AT_START", candidateCount: 1, rowCount: 1, evidenceTruncated: false }
  };
  return envelope("spatial.find-nearby", value, "gowm.spatial-analysis.bridge");
}

function situationEnvelope(): CapabilityResultEnvelope {
  return envelope("gowm.situation.h3.get-cell", {
    cells: [situationCell],
    references: [reference],
    candidateOnly: true,
    exactVerificationRequired: true,
    worldVersion: 42,
    metricProfile: {
      profileId: "gowm.h3-situation.metrics",
      profileVersion: "1.0",
      authority: "GOWM Foundation",
      resolutionPolicy: "GOWM_SITUATION_R7_R10",
      scoreMinimum: 0,
      scoreMaximum: 100
    }
  }, "gowm.situation.h3");
}

function envelope(operationId: string, value: unknown, providerId: string): CapabilityResultEnvelope {
  return {
    providerProtocolVersion: "1.0",
    requestId: "p14_result",
    operation: { operationId, operationVersion: "1.0" },
    status: "COMPLETED",
    output: { schemaUri: `urn:gowm:capability:${operationId}:output:1.0`, schemaHash: sha256({ operationId }), value },
    computeSnapshot: {
      provider: { providerId, providerVersion: "0.2.0", implementationDigest: sha256({ providerId }) },
      operation: { operationId, operationVersion: "1.0" },
      engine: { name: "test", version: "1.0" },
      policy: { version: "test/1.0", digest: sha256({ policy: "test" }) },
      schemas: { inputSchemaHash: sha256({ input: operationId }), outputSchemaHash: sha256({ output: operationId }) }
    },
    receipts: [],
    evidenceReferences: [],
    warnings: [],
    consumption: { outputBytes: Buffer.byteLength(JSON.stringify(value), "utf8") },
    execution: { providerId, providerVersion: "0.2.0", elapsedMs: 3, resultHash: sha256(value) }
  };
}
