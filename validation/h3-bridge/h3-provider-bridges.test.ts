import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderExecutionRequest } from "../../packages/platform/contract-runtime/src/index.js";
import { getContractSchemaHash } from "../../packages/platform/contract-runtime/src/index.js";
import { runProviderConformance } from "../../packages/platform/conformance-kit/src/index.js";
import {
  buildH3ProviderApp,
  createH3AnalysisProvider,
  createH3InteractiveProvider,
  h3EndpointConfigurationDigest,
  H3_ANALYSIS_OPERATION_IDS,
  H3_INTERACTIVE_OPERATION_IDS,
  H3_TOOLKIT_SOURCE_LOCK,
  H3ToolkitHttpClient,
  LockedExternalH3ToolkitAdapter,
  lockedAttestation,
  resolveGenericResolution,
  type H3OperationId,
  type H3ToolkitResult,
  type H3ToolkitUpstream
} from "../../packages/integrations/h3-toolkit-bridge/src/index.js";
import { ProviderProtocolError, type DeadlineContext, type TraceContext } from "../../packages/platform/provider-sdk/src/index.js";
import { loadH3InteractiveServerConfig } from "../../services/providers/h3-interactive-provider/src/config.js";

const TOKYO = "892f5a32d97ffff";
const TOKYO_NEIGHBOR = "892f5a32d83ffff";
const TOKYO_PARENT = "852f5a33fffffff";
const TOKYO_CHILD = "862f5a327ffffff";
let requestCounter = 0;

describe("P08 H3 provider bridges", () => {
  it("locks the exact source and exposes disjoint interactive/analysis QoS manifests", () => {
    const upstream = new FixtureUpstream();
    const interactive = createH3InteractiveProvider({ upstream });
    const analysis = createH3AnalysisProvider({ upstream });

    expect(interactive.runtime.manifest.provider).toMatchObject({
      providerId: "gowm.h3.interactive.bridge",
      providerVersion: "0.2.0",
      sourceGitCommit: H3_TOOLKIT_SOURCE_LOCK.sourceGitCommit
    });
    expect(analysis.runtime.manifest.provider).toMatchObject({
      providerId: "gowm.h3.analysis.bridge",
      providerVersion: "0.2.0",
      sourceGitCommit: H3_TOOLKIT_SOURCE_LOCK.sourceGitCommit
    });
    expect(interactive.operationIds).toEqual(H3_INTERACTIVE_OPERATION_IDS);
    expect(analysis.operationIds).toEqual(H3_ANALYSIS_OPERATION_IDS);
    expect(interactive.operationIds.some((operationId) => operationId.startsWith("gowm.situation."))).toBe(false);
    expect(analysis.operationIds.some((operationId) => interactive.operationIds.includes(operationId))).toBe(false);

    const interactiveDescriptor = interactive.runtime.manifest.capabilities[0]!;
    const analysisDescriptor = analysis.runtime.manifest.capabilities[0]!;
    expect(interactiveDescriptor.execution).toMatchObject({ defaultTimeoutMs: 3_000, maximumTimeoutMs: 10_000, costClass: "LOW" });
    expect(analysisDescriptor.execution).toMatchObject({ defaultTimeoutMs: 10_000, maximumTimeoutMs: 30_000, costClass: "HIGH" });
    expect(interactiveDescriptor.executionBindings).toEqual(["SYNC_HTTP"]);
    expect(analysisDescriptor.executionBindings).toEqual(["SYNC_HTTP"]);
    expect(interactiveDescriptor.snapshotPolicy.dataSnapshot).toBe("NONE");
    expect(analysisDescriptor.snapshotPolicy.dataSnapshot).toBe("NONE");
    const interactiveLock = JSON.parse(readFileSync(
      new URL("../../contracts/manifests/providers/h3-interactive-provider.json", import.meta.url),
      "utf8"
    ));
    const analysisLock = JSON.parse(readFileSync(
      new URL("../../contracts/manifests/providers/h3-analysis-provider.json", import.meta.url),
      "utf8"
    ));
    expect(interactive.runtime.manifest).toEqual(interactiveLock);
    expect(analysis.runtime.manifest).toEqual(analysisLock);
  });

  it("emits center-containment candidate cover semantics and no fake world evidence", async () => {
    const bridge = createH3InteractiveProvider({
      upstream: new FixtureUpstream(),
      now: () => new Date("2026-08-23T00:00:00.000Z"),
      receiptId: () => "receipt-h3-cover"
    });
    const descriptor = findDescriptor(bridge, "h3.geometry.cover");
    const result = await bridge.runtime.execute(providerRequest(descriptor, {
      geometry: polygon(),
      resolution: "CITY"
    }));

    expect(result.output?.value).toEqual({
      schemaVersion: "1.0",
      resolution: 7,
      cells: [TOKYO_NEIGHBOR, TOKYO],
      truncated: false,
      semantics: "CENTER_CONTAINMENT_COVER",
      candidateOnly: true,
      exactVerificationRequired: true
    });
    expect(result.dataSnapshot).toBeUndefined();
    expect(result.evidenceReferences).toEqual([]);
    expect(result.output?.value).not.toHaveProperty("worldVersion");
    expect(result.receipts[0]).toMatchObject({
      receiptId: "receipt-h3-cover",
      operationId: "h3.geometry.cover",
      providerId: "gowm.h3.interactive.bridge",
      method: { engine: "h3-js", engineVersion: "4.5.0" }
    });
    expect(result.receipts[0]?.warnings).toEqual(expect.arrayContaining([
      `h3.sourceGitCommit=${H3_TOOLKIT_SOURCE_LOCK.sourceGitCommit}`,
      "h3.cover=CENTER_CONTAINMENT_COVER",
      "h3.exactVerificationRequired=true"
    ]));
    expect(result.computeSnapshot.schemas).toEqual({
      inputSchemaHash: getContractSchemaHash("urn:gowm:capability:h3.geometry.cover:input:1.0"),
      outputSchemaHash: getContractSchemaHash("urn:gowm:capability:h3.geometry.cover:output:1.0")
    });
  });

  it("normalizes only the generic resolution policy and keeps hierarchy delegated", async () => {
    const upstream = new FixtureUpstream();
    const bridge = createH3InteractiveProvider({ upstream });
    const result = await bridge.runtime.execute(providerRequest(findDescriptor(bridge, "h3.hierarchy.parent"), {
      cell: TOKYO,
      parentResolution: "CITY"
    }));

    expect(resolveGenericResolution("CITY")).toBe(7);
    expect(result.output?.value).toEqual({ index: TOKYO_PARENT, resolution: 7 });
    expect(upstream.calls.at(-1)).toMatchObject({
      operationId: "h3.hierarchy.parent",
      input: { cell: TOKYO, parentResolution: 7 }
    });
  });

  it("fails closed on an unavailable package-only operation and a forged source lock", () => {
    const endpointId = "h3-toolkit-test";
    const baseUrl = "http://127.0.0.1:13000";
    const http = new H3ToolkitHttpClient({
      endpointId,
      baseUrl,
      approvalStatus: "APPROVED",
      configurationDigest: h3EndpointConfigurationDigest(endpointId, baseUrl)
    }, fixtureFetch([]));
    expect(() => createH3InteractiveProvider({ upstream: http })).toThrowError(expect.objectContaining({
      code: "PROVIDER_NOT_READY",
      details: { missing: expect.arrayContaining(["h3.cells.to-geojson", "h3.hierarchy.parent"]) }
    }));

    const forged = new FixtureUpstream();
    forged.attestation = { ...forged.attestation, sourceGitCommit: "0000000000000000000000000000000000000000" as never };
    expect(() => createH3AnalysisProvider({ upstream: forged })).toThrowError(expect.objectContaining({
      code: "PROVIDER_NOT_READY"
    }));
  });

  it("uses only the six locked Toolkit HTTP routes and validates response attestations", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const endpointId = "h3-toolkit-test";
    const baseUrl = "http://127.0.0.1:13000";
    const client = new H3ToolkitHttpClient({
      endpointId,
      baseUrl,
      approvalStatus: "APPROVED",
      configurationDigest: h3EndpointConfigurationDigest(endpointId, baseUrl)
    }, fixtureFetch(calls));
    const result = await client.execute(
      "h3.geometry.cover",
      { geometry: polygon(), resolution: 7 },
      deadline(),
      trace()
    );
    expect(result.data).toEqual([TOKYO, TOKYO_NEIGHBOR]);
    await client.execute("h3.index.points", { points: [{ longitude: 0, latitude: 0 }], resolution: 7 }, deadline(), trace());
    await client.execute("h3.neighborhood.disk", { cell: TOKYO, radius: 1 }, deadline(), trace());
    await client.execute("h3.analytics.aggregate", { records: [], operation: "count", resolution: 7 }, deadline(), trace());
    await client.execute("h3.analytics.coverage", { area: polygon(), resolution: 7 }, deadline(), trace());
    await client.execute("h3.analytics.flow", { trajectories: [], resolution: 7, directed: true }, deadline(), trace());
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:13000/v1/h3/polygon/cover",
      "http://127.0.0.1:13000/v1/h3/index",
      "http://127.0.0.1:13000/v1/h3/neighbors",
      "http://127.0.0.1:13000/v1/h3/aggregate",
      "http://127.0.0.1:13000/v1/h3/coverage",
      "http://127.0.0.1:13000/v1/h3/flow"
    ]);
    expect(calls[0]?.body).toEqual({ geometry: polygon(), resolution: 7, output: "cells" });
    await expect(client.execute("h3.hierarchy.parent", {}, deadline(), trace())).rejects.toMatchObject({
      code: "OPERATION_NOT_FOUND"
    });

    expect(() => new H3ToolkitHttpClient({
      endpointId,
      baseUrl,
      approvalStatus: "APPROVED",
      configurationDigest: `sha256:${"0".repeat(64)}`
    }, fixtureFetch([]))).toThrowError(expect.objectContaining({ code: "PROVIDER_NOT_READY" }));
  });

  it("binds package-only cells-to-GeoJSON without implementing H3 in GOWM", async () => {
    const adapter = new LockedExternalH3ToolkitAdapter(fixtureBindings());
    const bridge = createH3InteractiveProvider({ upstream: adapter });
    const result = await bridge.runtime.execute(providerRequest(findDescriptor(bridge, "h3.cells.to-geojson"), {
      cells: [TOKYO]
    }));
    expect(result.output?.value).toEqual(featureCollection());
    expect(adapter.attestation).toMatchObject({
      interfaceKind: "LOCKED_EMBEDDED_PACKAGE",
      sourceGitCommit: H3_TOOLKIT_SOURCE_LOCK.sourceGitCommit
    });
    expect(() => new LockedExternalH3ToolkitAdapter({
      ...fixtureBindings(),
      selfCheck: () => "wrong-cell"
    })).toThrowError(expect.objectContaining({ code: "PROVIDER_NOT_READY" }));
  });

  it("requires only the bindings used by the interactive operation allowlist", () => {
    const bindings = fixtureBindings() as Record<string, unknown>;
    for (const analysisOnly of ["aggregate", "calculateCoverage", "trajectoryToFlow", "aggregateFlow"]) {
      delete bindings[analysisOnly];
    }
    const adapter = new LockedExternalH3ToolkitAdapter(bindings as never, {
      supportedOperations: H3_INTERACTIVE_OPERATION_IDS
    });
    expect(adapter.supportedOperations).toEqual(H3_INTERACTIVE_OPERATION_IDS);
    expect(() => new LockedExternalH3ToolkitAdapter(bindings as never)).toThrowError(expect.objectContaining({
      code: "PROVIDER_NOT_READY"
    }));
  });

  it("hashes and stages an approved self-contained bindings artifact before import", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gowm-h3-binding-test-"));
    const modulePath = join(directory, "bindings.mjs");
    const marker = `__gowmH3BindingLoaded_${Date.now()}`;
    const moduleSource = `
globalThis.${marker} = true;
export function createGowmH3ToolkitBindings() {
  return {
    pointToCell: () => ({ index: "${TOKYO}", resolution: 9 }),
    geometryToCells: () => ["${TOKYO}"],
    cellsToGeoJSON: () => ({ type: "FeatureCollection", features: [] }),
    gridDisk: () => ["${TOKYO}"],
    getParent: () => ({ index: "${TOKYO_PARENT}", resolution: 5 }),
    getChildren: () => [{ index: "${TOKYO_CHILD}", resolution: 6 }],
    compact: () => ["${TOKYO_PARENT}"],
    uncompact: () => ["${TOKYO}"],
    selfCheck: () => "${TOKYO}"
  };
}
`;
    await writeFile(modulePath, moduleSource, "utf8");
    const digest = `sha256:${createHash("sha256").update(moduleSource).digest("hex")}` as const;
    const environment = {
      H3_TOOLKIT_BINDINGS_MODULE: modulePath,
      H3_TOOLKIT_BINDINGS_MODULE_SHA256: digest,
      H3_TOOLKIT_ENDPOINT_ID: "h3-toolkit-test",
      H3_TOOLKIT_BASE_URL: "http://127.0.0.1:13000",
      H3_TOOLKIT_ENDPOINT_CONFIGURATION_DIGEST: h3EndpointConfigurationDigest("h3-toolkit-test", "http://127.0.0.1:13000"),
      PROVIDER_TRANSPORT_SHARED_TOKEN: "test-provider-transport-token-32-bytes-minimum"
    };
    try {
      await expect(loadH3InteractiveServerConfig(environment, {
        approvedBindingDigests: [`sha256:${"0".repeat(64)}`]
      })).rejects.toThrow(/committed source approval lock/u);
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();

      const config = await loadH3InteractiveServerConfig(environment, {
        approvedBindingDigests: [digest],
        temporaryRoot: directory
      });
      expect((globalThis as Record<string, unknown>)[marker]).toBe(true);
      expect(config.provider.upstream.artifacts).toContainEqual({
        kind: "PACKAGE",
        name: "h3-toolkit-bindings",
        version: "0.3.0",
        digest
      });
      const bridge = createH3InteractiveProvider(config.provider);
      const descriptor = findDescriptor(bridge, "h3.cells.to-geojson");
      const result = await bridge.runtime.execute(providerRequest(descriptor, { cells: [TOKYO] }));
      expect(result.computeSnapshot.artifacts).toContainEqual(expect.objectContaining({
        name: "h3-toolkit-bindings",
        digest
      }));
    } finally {
      delete (globalThis as Record<string, unknown>)[marker];
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("delegates disk, children, compact and uncompact through locked Toolkit operations", async () => {
    const upstream = new FixtureUpstream();
    const bridge = createH3InteractiveProvider({ upstream });
    const cases: Array<[H3OperationId, unknown, unknown]> = [
      ["h3.neighborhood.disk", { cell: TOKYO, radius: 1 }, { origin: TOKYO, radius: 1, cells: [TOKYO_NEIGHBOR, TOKYO] }],
      ["h3.hierarchy.children", { cell: TOKYO_PARENT, childResolution: 6 }, [{ index: TOKYO_CHILD, resolution: 6 }]],
      ["h3.hierarchy.compact", { cells: [TOKYO] }, { cells: [TOKYO_PARENT] }],
      ["h3.hierarchy.uncompact", { cells: [TOKYO_PARENT], resolution: 9 }, { resolution: 9, cells: [TOKYO] }]
    ];
    for (const [operationId, input, expected] of cases) {
      const result = await bridge.runtime.execute(providerRequest(findDescriptor(bridge, operationId), input));
      expect(result.output?.value).toEqual(expected);
    }
    expect(upstream.calls.slice(-4).map((call) => call.operationId)).toEqual(cases.map(([operationId]) => operationId));
  });

  it("rejects strict output drift including a fabricated worldVersion", async () => {
    const upstream = new FixtureUpstream({
      "h3.cells.to-geojson": { ...featureCollection(), worldVersion: 99 }
    });
    const bridge = createH3InteractiveProvider({ upstream });
    await expect(bridge.runtime.execute(providerRequest(findDescriptor(bridge, "h3.cells.to-geojson"), {
      cells: [TOKYO]
    }))).rejects.toMatchObject({ code: "SCHEMA_MISMATCH" });
  });

  it("keeps flow sequences isolated across UNKNOWN gaps", async () => {
    const upstream = new FixtureUpstream();
    const bridge = createH3AnalysisProvider({ upstream });
    const result = await bridge.runtime.execute(providerRequest(findDescriptor(bridge, "h3.analytics.flow"), {
      trajectories: [
        { sequenceId: "seq-before-gap", points: [{ longitude: 139.7, latitude: 35.6 }, { longitude: 139.8, latitude: 35.7 }] },
        { sequenceId: "seq-after-gap", points: [{ longitude: 140.0, latitude: 35.8 }, { longitude: 140.1, latitude: 35.9 }] }
      ],
      resolution: 8,
      directed: true
    }));
    expect(result.output?.value).toMatchObject({
      resolution: 8,
      directed: true,
      gapPolicy: "SEQUENCE_ISOLATED"
    });
    expect(upstream.calls.at(-1)?.input).toMatchObject({
      trajectories: [
        [{ longitude: 139.7, latitude: 35.6 }, { longitude: 139.8, latitude: 35.7 }],
        [{ longitude: 140.0, latitude: 35.8 }, { longitude: 140.1, latitude: 35.9 }]
      ]
    });
    expect(result.dataSnapshot).toBeUndefined();
    expect(result.evidenceReferences).toEqual([]);
  });

  it("marks coverage as candidate-only and rejects oversized/radius work", async () => {
    const upstream = new FixtureUpstream();
    const analysis = createH3AnalysisProvider({ upstream });
    const coverage = await analysis.runtime.execute(providerRequest(findDescriptor(analysis, "h3.analytics.coverage"), {
      area: polygon(),
      resolution: 7,
      visitedCells: [TOKYO]
    }));
    expect(coverage.output?.value).toMatchObject({
      coverSemantics: "CENTER_CONTAINMENT_COVER",
      candidateOnly: true,
      exactVerificationRequired: true
    });

    const interactive = createH3InteractiveProvider({ upstream: new FixtureUpstream() });
    await expect(interactive.runtime.execute(providerRequest(findDescriptor(interactive, "h3.neighborhood.disk"), {
      cell: TOKYO,
      radius: 21
    }))).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    const oversizedCases = [
      [interactive, "h3.geometry.cover", { geometry: polygon(), resolution: 7 }],
      [analysis, "h3.analytics.coverage", { area: polygon(), resolution: 7 }],
      [analysis, "h3.analytics.flow", {
        trajectories: [{
          sequenceId: "sequence-1",
          points: [{ longitude: 139.7, latitude: 35.6 }, { longitude: 139.8, latitude: 35.7 }]
        }],
        resolution: 7
      }]
    ] as const;
    for (const [bridge, operationId, input] of oversizedCases) {
      const descriptor = findDescriptor(bridge, operationId);
      const request = providerRequest(descriptor, input);
      await expect(bridge.runtime.execute({
        ...request,
        executionPolicy: { ...request.executionPolicy, maximumInputBytes: 1 }
      })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    }
  });

  it("passes the shared Provider SDK conformance kit", async () => {
    const bridge = createH3InteractiveProvider({ upstream: new FixtureUpstream() });
    const descriptor = findDescriptor(bridge, "h3.index.points");
    const request = providerRequest(descriptor, {
      points: [{ longitude: 139.7671, latitude: 35.6812 }],
      resolution: 9
    });
    const report = await runProviderConformance({
      runtime: bridge.runtime,
      validRequest: request,
      differentInput: { points: [{ longitude: 116.4, latitude: 39.9 }], resolution: 9 },
      unknownFieldInput: {
        points: [{ longitude: 139.7671, latitude: 35.6812 }],
        resolution: 9,
        worldVersion: "fake"
      },
      deadlineRequest: {
        ...request,
        requestId: "request-h3-deadline",
        idempotencyKey: "idempotency-h3-deadline",
        executionPolicy: { ...request.executionPolicy, deadlineAt: new Date(Date.now() - 1_000).toISOString() }
      }
    });
    expect(report, JSON.stringify(report, null, 2)).toMatchObject({ passed: true });
  });

  it("serves the Provider Protocol over the analysis bridge HTTP app", async () => {
    const bridge = createH3AnalysisProvider({ upstream: new FixtureUpstream() });
    const app = buildH3ProviderApp(bridge, "test-provider-transport-token-32-bytes-minimum");
    try {
      const descriptor = findDescriptor(bridge, "h3.analytics.aggregate");
      const response = await app.inject({
        method: "POST",
        url: "/v1/operations/h3.analytics.aggregate:execute",
        headers: { authorization: "Bearer test-provider-transport-token-32-bytes-minimum" },
        payload: providerRequest(descriptor, {
          records: [{ longitude: 139.7671, latitude: 35.6812, value: 2 }],
          operation: "sum",
          resolution: 9
        })
      });
      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.output.value).toEqual({
        resolution: 9,
        metrics: [{ cell: TOKYO, resolution: 9, metric: "sum", value: 2 }]
      });
      expect(payload.dataSnapshot).toBeUndefined();
      expect(payload.evidenceReferences).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("retains Apache notice, SBOM attribution, and the no-source-copy boundary", () => {
    const sourceLock = JSON.parse(readFileSync(
      new URL("../../contracts/manifests/providers/h3-toolkit-source-lock.json", import.meta.url),
      "utf8"
    )) as Record<string, unknown>;
    const sbom = readFileSync(
      new URL("../../packages/integrations/h3-toolkit-bridge/sbom.cdx.json", import.meta.url),
      "utf8"
    );
    const notices = readFileSync(
      new URL("../../packages/integrations/h3-toolkit-bridge/THIRD_PARTY_NOTICES.md", import.meta.url),
      "utf8"
    );
    expect(sourceLock).toMatchObject({
      sourceGitCommit: H3_TOOLKIT_SOURCE_LOCK.sourceGitCommit,
      license: "Apache-2.0",
      redistributionAllowed: true,
      sourceCopiedIntoGowm: false
    });
    expect(sbom).toContain(H3_TOOLKIT_SOURCE_LOCK.sourceGitCommit);
    expect(sbom).toContain("h3-js@4.5.0");
    expect(notices).toContain("Apache License 2.0");
  });
});

class FixtureUpstream implements H3ToolkitUpstream {
  attestation = lockedAttestation("TEST_DOUBLE");
  readonly supportedOperations = [...H3_INTERACTIVE_OPERATION_IDS, ...H3_ANALYSIS_OPERATION_IDS];
  readonly calls: Array<{ operationId: H3OperationId; input: unknown }> = [];

  constructor(private readonly overrides: Partial<Record<H3OperationId, unknown>> = {}) {}

  async execute(operationId: H3OperationId, input: unknown): Promise<H3ToolkitResult> {
    this.calls.push({ operationId, input: structuredClone(input) });
    return {
      data: Object.hasOwn(this.overrides, operationId) ? this.overrides[operationId] : defaultData(operationId, input),
      warnings: [],
      meta: { toolkitVersion: "0.3.0", engine: "h3-js", engineVersion: "4.5.0" }
    };
  }

  async readiness() {
    return {
      ready: true,
      reasons: [],
      sourceGitCommit: H3_TOOLKIT_SOURCE_LOCK.sourceGitCommit,
      toolkitVersion: "0.3.0",
      engineVersion: "4.5.0"
    };
  }
}

function defaultData(operationId: H3OperationId, value: unknown): unknown {
  const input = value as Record<string, unknown>;
  switch (operationId) {
    case "h3.index.points":
      return (input.points as unknown[]).map(() => ({ index: TOKYO, resolution: Number(input.resolution) }));
    case "h3.geometry.cover":
      return [TOKYO, TOKYO_NEIGHBOR];
    case "h3.cells.to-geojson":
      return featureCollection();
    case "h3.neighborhood.disk":
      return [TOKYO, TOKYO_NEIGHBOR];
    case "h3.hierarchy.parent":
      return { index: TOKYO_PARENT, resolution: Number(input.parentResolution) };
    case "h3.hierarchy.children":
      return [{ index: TOKYO_CHILD, resolution: Number(input.childResolution) }];
    case "h3.hierarchy.compact":
      return [TOKYO_PARENT];
    case "h3.hierarchy.uncompact":
      return [TOKYO];
    case "h3.analytics.aggregate":
      return [{ cell: TOKYO, resolution: Number(input.resolution), metric: input.metric ?? input.operation, value: 2 }];
    case "h3.analytics.coverage":
      return {
        resolution: Number(input.resolution),
        requiredCells: [TOKYO],
        visitedCells: [TOKYO],
        missingCells: [],
        duplicateCells: [],
        requiredCount: 1,
        visitedRequiredCount: 1,
        missingCount: 0,
        duplicateVisitCount: 0,
        coverageRatio: 1,
        coverageEfficiency: 1
      };
    case "h3.analytics.flow":
      return [{ origin: TOKYO, destination: TOKYO_NEIGHBOR, count: 1, weight: 0 }];
  }
}

function findDescriptor(bridge: { runtime: { manifest: { capabilities: Array<{ operationId: string; operationVersion: string; inputSchemaHash: string; outputSchemaHash: string }> } } }, operationId: H3OperationId) {
  const descriptor = bridge.runtime.manifest.capabilities.find((candidate) => candidate.operationId === operationId);
  if (!descriptor) throw new Error(`missing descriptor ${operationId}`);
  return descriptor;
}

function providerRequest(
  descriptor: { operationId: string; operationVersion: string; inputSchemaHash: string; outputSchemaHash: string },
  input: unknown
): ProviderExecutionRequest {
  requestCounter += 1;
  const suffix = `${descriptor.operationId.replaceAll(".", "-")}-${requestCounter}`;
  const now = Date.now();
  return {
    providerProtocolVersion: "1.0",
    requestId: `request-${suffix}`,
    gatewayRequestId: `gateway-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    operation: {
      operationId: descriptor.operationId,
      operationVersion: descriptor.operationVersion,
      inputSchemaHash: descriptor.inputSchemaHash,
      outputSchemaHash: descriptor.outputSchemaHash
    },
    input,
    securityContext: {
      principalRef: "principal:test",
      authenticationMethod: "test-attestation",
      authenticatedAt: new Date(now - 120_000).toISOString(),
      scopeAttestation: {
        issuer: "gowm-test-gateway",
        issuedAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 600_000).toISOString(),
        claimDigest: `sha256:${"c".repeat(64)}`
      }
    },
    gatewayContext: {
      gatewayId: "gateway-test",
      registryVersion: "test-registry/1",
      policyVersion: "test-policy/1"
    },
    executionPolicy: {
      deadlineAt: new Date(now + 60_000).toISOString(),
      maximumInputBytes: 64 * 1024 * 1024,
      maximumResultBytes: 128 * 1024 * 1024,
      maximumBatchItems: 100_000,
      maximumVertices: 10_000_000,
      maximumCostClass: "HIGH"
    }
  };
}

function polygon() {
  return {
    type: "Polygon" as const,
    coordinates: [[[139.75, 35.675], [139.77, 35.675], [139.77, 35.69], [139.75, 35.69], [139.75, 35.675]]]
  };
}

function featureCollection() {
  return {
    type: "FeatureCollection" as const,
    features: [{
      type: "Feature" as const,
      properties: { cell: TOKYO },
      geometry: polygon()
    }]
  };
}

function fixtureBindings() {
  return {
    pointToCell: (_point: unknown, resolution: number) => ({ index: TOKYO, resolution }),
    geometryToCells: () => [TOKYO],
    cellsToGeoJSON: () => featureCollection(),
    gridDisk: () => [TOKYO, TOKYO_NEIGHBOR],
    getParent: (_cell: string, resolution: number) => ({ index: TOKYO_PARENT, resolution }),
    getChildren: (_cell: string, resolution: number) => [{ index: TOKYO_CHILD, resolution }],
    compact: () => [TOKYO_PARENT],
    uncompact: () => [TOKYO],
    aggregate: () => [{ cell: TOKYO, resolution: 9, metric: "count", value: 1 }],
    calculateCoverage: () => defaultData("h3.analytics.coverage", { resolution: 9 }),
    trajectoryToFlow: () => ({ origin: TOKYO, destination: TOKYO_NEIGHBOR, count: 1 }),
    aggregateFlow: (flows: unknown[]) => flows,
    selfCheck: () => TOKYO
  };
}

function fixtureFetch(calls: Array<{ url: string; body: unknown }>): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, body });
    const data = url.endsWith("/v1/h3/polygon/cover") ? [TOKYO, TOKYO_NEIGHBOR] : [];
    return jsonResponse({
      data,
      meta: {
        requestId: "toolkit-request",
        durationMs: 1,
        toolkitVersion: "0.3.0",
        engine: "h3-js",
        engineVersion: "4.5.0",
        warnings: []
      }
    });
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function deadline(): DeadlineContext {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    remainingMs: () => 10_000
  };
}

function trace(): TraceContext {
  return { requestId: "request-http-test", traceId: "trace-http-test" };
}
