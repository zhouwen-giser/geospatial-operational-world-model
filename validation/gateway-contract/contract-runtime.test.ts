import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalSha256,
  getContractSchema,
  getContractSchemaHash,
  validateAgainstSchema,
  validateCapabilityResultSemantics,
  validateContract,
  validateOperationSchemaAttestation,
  validateSchemaSet,
  type CapabilityDescriptor,
  type CapabilityProviderManifest,
  type CapabilityResultEnvelope,
  type ComputeSnapshotContext,
  type CrsNormalizeGeometryOutputV1,
  type ExecutionReceipt,
  type GowmFoundationH3ProjectPointOutputV1,
  type ProviderExecutionRequest,
  type WorldQueryPlanV2
} from "../../packages/platform/contract-runtime/src/index.js";

const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const SHA_C = `sha256:${"c".repeat(64)}`;

function descriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    operationId: "elevation.sample.mock",
    operationVersion: "1.0",
    semanticRole: "FOUNDATION_PRIMITIVE",
    dataBinding: "WORLD_INDEPENDENT",
    resultSemantics: "TRANSFORMATION",
    executionBindings: ["SYNC_HTTP"],
    criticalPathPolicy: "REMOTE_ALLOWED",
    maturity: "PREVIEW",
    inputSchemaUri: "urn:gowm:capability:elevation.sample.mock:input:1.0",
    inputSchemaHash: getContractSchemaHash("urn:gowm:capability:elevation.sample.mock:input:1.0"),
    outputSchemaUri: "urn:gowm:capability:elevation.sample.mock:output:1.0",
    outputSchemaHash: getContractSchemaHash("urn:gowm:capability:elevation.sample.mock:output:1.0"),
    scopePolicy: "REQUEST_CONTEXT",
    execution: {
      mode: "SYNC",
      defaultTimeoutMs: 100,
      maximumTimeoutMs: 500,
      costClass: "LOW"
    },
    limits: { maximumInputBytes: 4096, maximumOutputBytes: 4096 },
    snapshotPolicy: { dataSnapshot: "NONE", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [
        {
          name: "request",
          schemaUri: "urn:gowm:capability:elevation.sample.mock:input:1.0",
          schemaHash: getContractSchemaHash("urn:gowm:capability:elevation.sample.mock:input:1.0"),
          valueKind: "ANY",
          unitSemantics: "UNSPECIFIED"
        }
      ],
      outputs: [
        {
          name: "result",
          schemaUri: "urn:gowm:capability:elevation.sample.mock:output:1.0",
          schemaHash: getContractSchemaHash("urn:gowm:capability:elevation.sample.mock:output:1.0"),
          valueKind: "SCALAR",
          unitSemantics: "LINEAR_METERS"
        }
      ]
    },
    ...overrides
  };
}

function providerRequest(): ProviderExecutionRequest {
  return {
    providerProtocolVersion: "1.0",
    requestId: "provider-request-1",
    gatewayRequestId: "gateway-request-1",
    idempotencyKey: "idem-1",
    operation: {
      operationId: "elevation.sample.mock",
      operationVersion: "1.0",
      inputSchemaHash: SHA_A,
      outputSchemaHash: SHA_B
    },
    input: { longitude: 0, latitude: 0 },
    securityContext: {
      principalRef: "principal:test",
      authenticationMethod: "TEST",
      authenticatedAt: "2026-08-22T23:59:59Z",
      scopeAttestation: {
        issuer: "gateway.test",
        issuedAt: "2026-08-23T00:00:00Z",
        expiresAt: "2026-08-23T00:01:00Z",
        claimDigest: SHA_C
      }
    },
    gatewayContext: {
      gatewayId: "gateway.test",
      registryVersion: "registry-v1",
      policyVersion: "policy-v1"
    },
    executionPolicy: {
      deadlineAt: "2026-08-23T00:00:30Z",
      maximumInputBytes: 4096,
      maximumResultBytes: 4096,
      maximumCostClass: "LOW"
    }
  };
}

describe("authoritative contract source", () => {
  it("has unique ids, resolvable refs, and supported strict formats", () => {
    expect(validateSchemaSet()).toEqual({ valid: true, issues: [] });
  });

  it("keeps generated TypeScript, schema bundle, and hashes reproducible", () => {
    execFileSync(
      process.execPath,
      ["packages/platform/contract-runtime/scripts/generate-contract-types.mjs", "--check"],
      { cwd: resolve("."), stdio: "pipe" }
    );
    const schema = getContractSchema("ElevationSampleMockInputV1");
    expect(getContractSchemaHash("ElevationSampleMockInputV1")).toBe(canonicalSha256(schema));
  });

  it("resolves every checked-in provider operation to the canonical schema bundle", () => {
    const manifestDirectory = resolve("contracts/manifests/providers");
    const manifestFiles = readdirSync(manifestDirectory)
      .filter((name) => name.endsWith("-provider.json"))
      .sort();

    expect(manifestFiles.length).toBeGreaterThan(0);
    for (const name of manifestFiles) {
      const manifest = JSON.parse(readFileSync(resolve(manifestDirectory, name), "utf8")) as CapabilityProviderManifest;
      expect(validateContract("CapabilityProviderManifest", manifest), name).toMatchObject({ valid: true });
      for (const capability of manifest.capabilities) {
        expect(getContractSchemaHash(capability.inputSchemaUri), `${name}:${capability.operationId}:input`)
          .toBe(capability.inputSchemaHash);
        expect(getContractSchemaHash(capability.outputSchemaUri), `${name}:${capability.operationId}:output`)
          .toBe(capability.outputSchemaHash);
        for (const port of [...capability.ports.inputs, ...capability.ports.outputs]) {
          expect(getContractSchemaHash(port.schemaUri), `${name}:${capability.operationId}:${port.name}`)
            .toBe(port.schemaHash);
        }
      }
    }
  });
});

describe("public and trusted request separation", () => {
  const publicRequest = {
    requestVersion: "1.0",
    requestId: "gateway-request-1",
    idempotencyKey: "idem-1",
    operationVersion: "1.0",
    inputSchemaHash: SHA_A,
    outputSchemaHash: SHA_B,
    input: { longitude: 0, latitude: 0 },
    executionPolicy: {
      deadlineAt: "2026-08-23T00:00:30Z",
      maximumResultBytes: 4096,
      maximumCostClass: "LOW"
    }
  };

  it("rejects caller-supplied identity or DataScope on the public API", () => {
    const result = validateContract("GatewayExecuteRequest", {
      ...publicRequest,
      securityContext: { principalRef: "admin", dataScopeClaim: "*" }
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((entry) => entry.path === "/securityContext")).toBe(true);
  });

  it("accepts Gateway-attested Provider context and checks its time window", () => {
    expect(validateContract("ProviderExecutionRequest", providerRequest()).valid).toBe(true);
    const expired = providerRequest();
    expired.executionPolicy.deadlineAt = "2026-08-23T00:02:00Z";
    expect(validateContract("ProviderExecutionRequest", expired).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "attestationWindow" })])
    );
    const futureAuthentication = providerRequest();
    futureAuthentication.securityContext.authenticatedAt = "2026-08-23T00:00:01Z";
    expect(validateContract("ProviderExecutionRequest", futureAuthentication).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "/securityContext/authenticatedAt" })])
    );
  });

  it("enforces date-time and URI formats for arbitrary operation schemas", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["at", "uri"],
      properties: {
        at: { type: "string", format: "date-time" },
        uri: { type: "string", format: "uri" }
      }
    };
    const validation = validateAgainstSchema(schema, { at: "2026-02-30T10:00:00", uri: "not a uri" });
    expect(validation.valid).toBe(false);
    expect(validation.issues.filter((entry) => entry.keyword === "format")).toHaveLength(2);
  });
});

describe("manifest, lock, and maturity semantics", () => {
  it("allows operation v1/v2 coexistence while failing closed on schema-hash drift", () => {
    const v1 = descriptor();
    const v2 = descriptor({ operationVersion: "2.0" });
    const manifest: CapabilityProviderManifest = {
      providerProtocolVersion: "1.0",
      provider: {
        providerId: "gowm.mock-provider",
        providerVersion: "0.2.0",
        owner: "GOWM",
        implementationDigest: SHA_A
      },
      endpoints: {
        manifest: "/.well-known/gowm-capability-provider",
        liveness: "/health/live",
        readiness: "/health/ready",
        execute: "/v1/provider-operations/{operationId}:execute",
        job: "/v1/provider-jobs/{jobId}"
      },
      capabilities: [v1, v2]
    };
    expect(validateContract("CapabilityProviderManifest", manifest).valid).toBe(true);
    expect(
      validateOperationSchemaAttestation(
        {
          operationId: v1.operationId,
          operationVersion: v1.operationVersion,
          inputSchemaHash: SHA_A,
          outputSchemaHash: v1.outputSchemaHash
        },
        v1
      ).issues
    ).toEqual(expect.arrayContaining([expect.objectContaining({ keyword: "schemaHash" })]));
  });

  it("does not enable PLANNED or RETIRED registrations", () => {
    const planned = descriptor({ maturity: "PLANNED" });
    const catalog = {
      catalogVersion: "catalog-v1",
      generatedAt: "2026-08-23T00:00:00Z",
      endpoints: [
        {
          endpointId: "mock-endpoint",
          baseUri: "https://provider.invalid",
          approval: {
            status: "APPROVED",
            approvedBy: "operator:test",
            approvedAt: "2026-08-23T00:00:00Z",
            configurationDigest: SHA_A
          },
          healthPolicy: {
            livenessPath: "/health/live",
            readinessPath: "/health/ready",
            intervalMs: 1000,
            timeoutMs: 100
          }
        }
      ],
      registrations: [
        {
          descriptor: planned,
          providerId: "gowm.mock-provider",
          providerVersion: "0.2.0",
          endpointId: "mock-endpoint",
          enabled: true
        }
      ]
    };
    const validation = validateContract("CapabilityCatalog", catalog);
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((entry) => entry.keyword)).toContain("maturityPolicy");
  });

  it("rejects duplicate operation versions and inconsistent snapshot policy", () => {
    const invalidDescriptor = descriptor({
      dataBinding: "WORLD_SNAPSHOT_BOUND",
      scopePolicy: "REQUEST_CONTEXT",
      snapshotPolicy: { dataSnapshot: "NONE", computeSnapshot: "REQUIRED" }
    });
    const manifest: CapabilityProviderManifest = {
      providerProtocolVersion: "1.0",
      provider: {
        providerId: "gowm.mock-provider",
        providerVersion: "0.2.0",
        owner: "GOWM",
        implementationDigest: SHA_A
      },
      endpoints: {
        manifest: "/.well-known/gowm-capability-provider",
        liveness: "/health/live",
        readiness: "/health/ready",
        execute: "/v1/provider-operations/{operationId}:execute",
        job: "/v1/provider-jobs/{jobId}"
      },
      capabilities: [invalidDescriptor, invalidDescriptor]
    };
    const validation = validateContract("CapabilityProviderManifest", manifest);
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((entry) => entry.keyword)).toEqual(
      expect.arrayContaining(["uniqueOperationVersion", "snapshotPolicy", "scopePolicy"])
    );
  });

  it("distinguishes 40-character Git commits from 64-character source hashes", () => {
    const invalid = validateContract("ProviderLock", {
      lockVersion: "1.0",
      generatedAt: "2026-08-23",
      providers: [
        {
          providerKey: "h3-toolkit",
          sourceKind: "GITHUB_COMMIT",
          version: "0.3.0",
          sourceRef: "https://github.com/example/h3",
          sourceSha256: "a".repeat(64),
          licenseStatus: "APPROVED",
          redistributionAllowed: true
        }
      ]
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.map((entry) => entry.keyword)).toContain("sourceDigest");
    const wrongSha256 = {
      lockVersion: "1.0",
      generatedAt: "2026-08-23",
      providers: [
        {
          providerKey: "zip-provider",
          sourceKind: "ZIP",
          version: "1.0.0",
          sourceRef: "artifact.zip",
          sourceSha256: "a".repeat(40),
          licenseStatus: "UNSPECIFIED",
          redistributionAllowed: false
        }
      ]
    };
    expect(validateContract("ProviderLock", wrongSha256).issues.map((entry) => entry.keyword)).toContain("pattern");
  });
});

describe("receipt, evidence, and snapshot separation", () => {
  it("accepts a stateless receipt with Compute Snapshot and no fake data/evidence", () => {
    const selected = descriptor();
    const output = { elevationMeters: 42, source: "MOCK_FIXED" as const };
    const computeSnapshot: ComputeSnapshotContext = {
      provider: { providerId: "gowm.mock-provider", providerVersion: "0.2.0" },
      operation: { operationId: selected.operationId, operationVersion: selected.operationVersion },
      engine: { name: "mock-fixed", version: "1.0.0" },
      policy: { version: "policy-v1", digest: SHA_C },
      schemas: {
        inputSchemaHash: selected.inputSchemaHash,
        outputSchemaHash: selected.outputSchemaHash
      }
    };
    const receipt: ExecutionReceipt = {
      receiptId: "receipt-1",
      operationId: selected.operationId,
      operationVersion: selected.operationVersion,
      providerId: "gowm.mock-provider",
      providerVersion: "0.2.0",
      inputHash: SHA_A,
      outputHash: canonicalSha256(output),
      computeSnapshotHash: canonicalSha256(computeSnapshot),
      generatedAt: "2026-08-23T00:00:01Z",
      durationMs: 0.5,
      method: {
        engine: "mock-fixed",
        engineVersion: "1.0.0",
        methodId: "fixed-elevation",
        methodVersion: "1.0"
      },
      changes: { repairApplied: false, typeChanged: false },
      warnings: []
    };
    const envelope: CapabilityResultEnvelope = {
      providerProtocolVersion: "1.0",
      requestId: "provider-request-1",
      operation: { operationId: selected.operationId, operationVersion: selected.operationVersion },
      status: "COMPLETED",
      output: {
        schemaUri: selected.outputSchemaUri,
        schemaHash: selected.outputSchemaHash,
        value: output
      },
      computeSnapshot,
      receipts: [receipt],
      evidenceReferences: [],
      warnings: [],
      consumption: { outputBytes: Buffer.byteLength(JSON.stringify(output), "utf8") },
      execution: {
        providerId: "gowm.mock-provider",
        providerVersion: "0.2.0",
        elapsedMs: 0.5,
        resultHash: canonicalSha256(output)
      }
    };
    expect(validateContract("CapabilityResultEnvelope", envelope).valid).toBe(true);
    expect(validateCapabilityResultSemantics(envelope, selected)).toEqual({ valid: true, issues: [] });

    envelope.dataSnapshot = {
      consistency: "PINNED",
      capturedAt: "2026-08-23T00:00:00Z",
      scopeDigest: SHA_C,
      resources: [
        {
          authority: "GOWM",
          pinning: "PINNED",
          referenceKey: { namespace: "gowm", kind: "OBSERVATION", id: "obs-1", version: "1" }
        }
      ]
    };
    expect(validateCapabilityResultSemantics(envelope, selected).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "fakeDataSnapshot" })])
    );
  });
});

describe("typed World Query plan", () => {
  const port = (schemaHash: string) => ({
    schemaUri: "urn:gowm:test:port",
    schemaHash,
    valueKind: "SCALAR" as const,
    unitSemantics: "DIMENSIONLESS" as const
  });

  function validPlan(): WorldQueryPlanV2 {
    return {
      queryPlanVersion: "2.0",
      queryId: "query-1",
      nodes: [
        {
          nodeId: "source",
          operation: {
            operationId: "test.source",
            operationVersion: "1.0",
            inputSchemaHash: SHA_A,
            outputSchemaHash: SHA_B
          },
          inputs: {
            request: { kind: "REQUEST_PATH", path: "/position", port: port(SHA_A) }
          },
          failurePolicy: "FAIL_FAST",
          budget: {
            maximumRows: 10,
            maximumCandidates: 10,
            maximumOutputBytes: 4096,
            maximumExecutionMs: 100
          }
        },
        {
          nodeId: "sink",
          operation: {
            operationId: "test.sink",
            operationVersion: "1.0",
            inputSchemaHash: SHA_B,
            outputSchemaHash: SHA_C
          },
          inputs: {
            value: {
              kind: "NODE_OUTPUT",
              nodeId: "source",
              outputPort: "result",
              port: port(SHA_B)
            }
          },
          failurePolicy: "FAIL_FAST",
          budget: {
            maximumRows: 10,
            maximumCandidates: 10,
            maximumOutputBytes: 4096,
            maximumExecutionMs: 100
          }
        }
      ],
      outputs: [
        {
          name: "result",
          binding: {
            kind: "NODE_OUTPUT",
            nodeId: "sink",
            outputPort: "result",
            port: port(SHA_C)
          }
        }
      ],
      budgets: {
        maximumNodes: 2,
        maximumDepth: 2,
        maximumRows: 100,
        maximumCandidates: 100,
        maximumOutputBytes: 8192,
        maximumExecutionMs: 1000
      }
    };
  }

  it("accepts strict typed bindings and rejects arbitrary requestPath objects", () => {
    expect(validateContract("WorldQueryPlanV2", validPlan()).valid).toBe(true);
    const invalid = validPlan() as unknown as Record<string, unknown>;
    const nodes = invalid.nodes as Array<Record<string, unknown>>;
    nodes[0]!.inputs = { request: { requestPath: "position" } };
    expect(validateContract("WorldQueryPlanV2", invalid).valid).toBe(false);
  });

  it("rejects cycles and schema-port drift", () => {
    const plan = validPlan();
    plan.nodes[0]!.inputs.request = {
      kind: "NODE_OUTPUT",
      nodeId: "sink",
      outputPort: "result",
      port: port(SHA_A)
    };
    plan.nodes[1]!.inputs.value = {
      kind: "NODE_OUTPUT",
      nodeId: "source",
      outputPort: "result",
      port: port(SHA_A)
    };
    const validation = validateContract("WorldQueryPlanV2", plan);
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((entry) => entry.keyword)).toEqual(
      expect.arrayContaining(["acyclic", "typedPort"])
    );
  });
});

describe("operation contracts and OpenAPI parity", () => {
  it("enforces elevation bounds and unknown-field rejection", () => {
    expect(validateContract("ElevationSampleMockInputV1", { longitude: 120, latitude: 31 }).valid).toBe(true);
    expect(validateContract("ElevationSampleMockInputV1", { longitude: 181, latitude: 31 }).valid).toBe(false);
    expect(validateContract("ElevationSampleMockInputV1", { longitude: 120, latitude: 31, role: "admin" }).valid).toBe(false);
  });

  it("locks Foundation CRS, Geometry, and H3 adapter wire shapes", () => {
    const axisOrder: CrsNormalizeGeometryOutputV1["axisOrder"] = ["longitude", "latitude"];
    const cells: GowmFoundationH3ProjectPointOutputV1["cells"] = {
      "9": "893000000000000"
    };
    expect(axisOrder).toEqual(["longitude", "latitude"]);
    expect(cells).toEqual({ "9": "893000000000000" });
    expect(
      validateContract("CrsNormalizeGeometryOutputV1", {
        geometry: { type: "Point", coordinates: [120, 31, 8] },
        sourceCrs: "EPSG:4326",
        targetCrs: "EPSG:4326",
        axisOrder: ["longitude", "latitude"],
        coordinateCount: 1,
        zTransformed: false,
        normalizationMethod: "CANONICAL_IDENTITY",
        transformation: {
          engine: "GOWM",
          engineVersion: "0.2.0",
          integration: "foundation-local",
          integrationVersion: "0.2.0",
          sourceCrs: "EPSG:4326",
          targetCrs: "EPSG:4326",
          strictBestOperation: true,
          networkEnabled: false,
          cacheHit: false
        },
        warnings: [{ code: "SOURCE_ALREADY_WGS84", message: "already normalized" }]
      }).valid
    ).toBe(true);
    expect(
      validateContract("CrsNormalizeGeometryOutputV1", {
        geometry: { type: "Point", coordinates: [120, 31] },
        sourceCrs: "EPSG:4326",
        targetCrs: "EPSG:4326",
        axisOrder: ["latitude", "longitude"],
        coordinateCount: 1,
        zTransformed: false,
        normalizationMethod: "CANONICAL_IDENTITY",
        transformation: {
          engine: "GOWM",
          engineVersion: "0.2.0",
          integration: "foundation-local",
          integrationVersion: "0.2.0",
          sourceCrs: "EPSG:4326",
          targetCrs: "EPSG:4326",
          strictBestOperation: true,
          networkEnabled: false,
          cacheHit: false
        },
        warnings: [{ code: "SOURCE_ALREADY_WGS84", message: "wrong axis" }]
      }).valid
    ).toBe(false);
    expect(
      validateContract("GeometryValidateInputV1", {
        geometry: { type: "LineString", coordinates: [[120], [121, 32]] }
      }).valid
    ).toBe(false);
    expect(
      validateContract("H3IndexPointsInputV1", {
        points: [{ longitude: 120, latitude: 31 }],
        resolution: "CITY"
      }).valid
    ).toBe(true);
    expect(
      validateContract("GowmFoundationH3ProjectPointOutputV1", {
        cells: { "16": "893000000000000" },
        candidateOnly: true,
        exactSpatialAuthority: "POSTGIS"
      }).valid
    ).toBe(false);
  });

  it("publishes every frozen Gateway and Provider lifecycle endpoint", () => {
    const gateway = readFileSync("contracts/platform/openapi/world-capability-gateway-v1.yaml", "utf8");
    const provider = readFileSync("contracts/platform/openapi/capability-provider-protocol-v1.yaml", "utf8");
    for (const route of [
      "/v1/capabilities/{operationId}",
      "/v1/jobs/{jobId}",
      "/v1/receipts/{receiptId}",
      "../gateway-execute-request.schema.json",
      "../world-query-submission.schema.json"
    ]) expect(gateway).toContain(route);
    for (const route of [
      "/health/live",
      "/health/ready",
      "/v1/provider-jobs/{jobId}",
      "/v1/provider-jobs/{jobId}:cancel",
      "../provider-execution-request.schema.json"
    ]) expect(provider).toContain(route);
    expect(gateway).not.toContain("provider-execution-request.schema.json");
  });
});
