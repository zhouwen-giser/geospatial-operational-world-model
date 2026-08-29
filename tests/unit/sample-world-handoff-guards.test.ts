import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  canonicalSha256,
  validateContract,
  validateWorldQueryPlanSemantics,
  type WorldQueryPlanV2,
  type WorldQuerySubmission
} from "../../packages/platform/contract-runtime/src/index.js";
import { lockedHandoffOperationContracts } from "../../scripts/sample-world/handoff.js";
import {
  assertSampleAvailabilityProjection,
  buildSampleAvailabilityProbePlan,
  REQUIRED_SAMPLE_OPERATIONS,
  SAMPLE_RUNTIME_PROVIDER_IDS
} from "../../scripts/sample-world/readiness.js";
import {
  assertPinnedSnapshotMismatch,
  buildSnapshotQuerySubmission
} from "../../scripts/sample-world/verify.js";
import { loadControlledProviderDeployments } from "../../services/gateway/world-capability-gateway/src/config.js";
import { QuerySnapshotCoordinator } from "../../services/gateway/world-capability-gateway/src/query-snapshot-coordinator.js";
import {
  SAMPLE_RUNTIME_SECRET_NAMES,
  sampleRuntimePaths,
  validateRuntimeEnvironment
} from "../../scripts/sample-world/runtime.js";

function validRuntimeValues(root: string): {
  paths: ReturnType<typeof sampleRuntimePaths>;
  values: Record<string, string>;
} {
  const paths = sampleRuntimePaths(root);
  const values: Record<string, string> = {
    COMPOSE_PROJECT_NAME: "gowm-wsgs-sample",
    GATEWAY_BIND_ADDRESS: "127.0.0.1",
    GATEWAY_PORT: "18063",
    POSTGRES_BIND_ADDRESS: "127.0.0.1",
    POSTGRES_PORT: "55463",
    POSTGRES_DB: "gowm_wsgs_sample",
    GATEWAY_AUTH_MODE: "SIGNED_DELEGATION_V1",
    GATEWAY_RUNTIME_PRINCIPAL_REF: "service:wsgs",
    GATEWAY_DATA_SCOPE_CLAIM: "wsgs-demo",
    GATEWAY_DATASET_SCOPE_CLAIM: "wsgs-demo-main",
    GATEWAY_DELEGATION_ISSUER: "https://gowm.local/wsgs-sample",
    GATEWAY_DELEGATION_AUDIENCE: "gowm-world-gateway",
    GATEWAY_DELEGATION_MAX_TTL_SECONDS: "300",
    GATEWAY_DELEGATION_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\\nunit-test\\n-----END PUBLIC KEY-----\\n",
    GOWM_WSGS_DELEGATION_PRIVATE_KEY_PATH: paths.privateKeyPath,
    SAMPLE_WORLD_EPOCH: "2026-08-27T00:00:00.000Z",
    SAMPLE_WORLD_SEED: "gowm-wsgs-sample-world-v1"
  };
  SAMPLE_RUNTIME_SECRET_NAMES.forEach((name, index) => {
    values[name] = `sample-secret-${index.toString().padStart(2, "0")}-${"x".repeat(32)}`;
  });
  return { paths, values };
}

describe("sample-world fixed runtime environment", () => {
  it("accepts only the isolated signed-delegation profile", () => {
    const { paths, values } = validRuntimeValues("sample-runtime-test");
    expect(() => validateRuntimeEnvironment(values, paths)).not.toThrow();
  });

  it.each([
    ["GATEWAY_AUTH_MODE", "STATIC_SERVICE"],
    ["GATEWAY_BIND_ADDRESS", "0.0.0.0"],
    ["GATEWAY_PORT", "8080"],
    ["POSTGRES_PORT", "5432"],
    ["GATEWAY_RUNTIME_PRINCIPAL_REF", "service:other"],
    ["GATEWAY_DATA_SCOPE_CLAIM", "other"],
    ["GATEWAY_DELEGATION_MAX_TTL_SECONDS", "301"]
  ])("rejects drift in %s", (name, value) => {
    const fixture = validRuntimeValues("sample-runtime-test");
    fixture.values[name] = value;
    expect(() => validateRuntimeEnvironment(fixture.values, fixture.paths)).toThrow(/fixed value mismatch/u);
  });

  it("rejects a foreign private-key path and duplicate secrets", () => {
    const foreign = validRuntimeValues("sample-runtime-test");
    foreign.values.GOWM_WSGS_DELEGATION_PRIVATE_KEY_PATH = "foreign/private.pem";
    expect(() => validateRuntimeEnvironment(foreign.values, foreign.paths)).toThrow(/private-key path mismatch/u);

    const duplicate = validRuntimeValues("sample-runtime-test");
    duplicate.values[SAMPLE_RUNTIME_SECRET_NAMES[1]] = duplicate.values[SAMPLE_RUNTIME_SECRET_NAMES[0]]!;
    expect(() => validateRuntimeEnvironment(duplicate.values, duplicate.paths)).toThrow(/unique/u);
  });
});

describe("sample-world handoff lock binding", () => {
  const semanticProfile = { profileVersion: "1.0", domain: "REFERENCE", resultNature: "FACT" };
  const semanticProfileHash = canonicalSha256(semanticProfile);
  const descriptor = {
    operationId: "reference.get",
    operationVersion: "1.0",
    maturity: "STABLE",
    inputSchemaHash: `sha256:${"a".repeat(64)}`,
    outputSchemaHash: `sha256:${"b".repeat(64)}`,
    semanticProfile
  };
  const semantic = {
    operationId: "reference.get",
    operationVersion: "1.0",
    semanticProfile,
    semanticProfileHash
  };
  const locked = {
    operationId: "reference.get",
    operationVersion: "1.0",
    maturity: "STABLE",
    inputSchemaHash: descriptor.inputSchemaHash,
    outputSchemaHash: descriptor.outputSchemaHash,
    semanticProfileHash
  };

  it("returns only a unique live descriptor and semantic profile matching the lock", () => {
    expect(lockedHandoffOperationContracts(
      { capabilities: [descriptor] },
      { profiles: [semantic] },
      { defaultOperations: [locked], previewOperations: [] },
      ["reference.get"]
    )).toEqual([locked]);
  });

  it("fails closed for a missing semantic profile or any per-operation drift", () => {
    expect(() => lockedHandoffOperationContracts(
      { capabilities: [descriptor] },
      { profiles: [] },
      { defaultOperations: [locked] },
      ["reference.get"]
    )).toThrow(/semantic profile is missing/u);

    expect(() => lockedHandoffOperationContracts(
      { capabilities: [{ ...descriptor, inputSchemaHash: `sha256:${"c".repeat(64)}` }] },
      { profiles: [semantic] },
      { defaultOperations: [locked] },
      ["reference.get"]
    )).toThrow(/differs from the WSGS lock/u);
  });
});

describe("sample-world full-registry availability profile", () => {
  it("maps the exact five running Providers and twelve required operations into the full registry", async () => {
    const deployments = await loadControlledProviderDeployments("config/world-platform-gateway-registry.json");
    const plan = buildSampleAvailabilityProbePlan(deployments);
    expect(SAMPLE_RUNTIME_PROVIDER_IDS).toHaveLength(5);
    expect(plan.requiredOperations).toEqual(REQUIRED_SAMPLE_OPERATIONS);
    expect(plan.requiredOperations).toHaveLength(12);
    expect(plan.absentProviderProbes).toHaveLength(deployments.length - SAMPLE_RUNTIME_PROVIDER_IDS.length);
    expect(new Set(plan.absentProviderProbes.map(({ providerId }) => providerId)).size)
      .toBe(plan.absentProviderProbes.length);
  });

  it("accepts required availability with every absent Provider probe unavailable", () => {
    const plan = {
      requiredOperations: ["reference.get", "catalog.get"],
      absentProviderProbes: [{
        providerId: "gowm.network",
        operationId: "network.graph.get",
        operationVersion: "1.0"
      }]
    };
    expect(() => assertSampleAvailabilityProjection({ operations: [
      { operationId: "catalog.get", operationVersion: "1.0", availability: "AVAILABLE" },
      { operationId: "network.graph.get", operationVersion: "1.0", availability: "UNAVAILABLE" },
      { operationId: "reference.get", operationVersion: "1.0", availability: "AVAILABLE" }
    ] }, plan)).not.toThrow();
  });

  it("fails closed for a missing required operation, an available absent Provider, or extra projection", () => {
    const plan = {
      requiredOperations: ["reference.get"],
      absentProviderProbes: [{
        providerId: "gowm.network",
        operationId: "network.graph.get",
        operationVersion: "1.0"
      }]
    };
    expect(() => assertSampleAvailabilityProjection({ operations: [
      { operationId: "network.graph.get", operationVersion: "1.0", availability: "UNAVAILABLE" }
    ] }, plan)).toThrow(/exact sample probe set/u);
    expect(() => assertSampleAvailabilityProjection({ operations: [
      { operationId: "reference.get", operationVersion: "1.0", availability: "AVAILABLE" },
      { operationId: "network.graph.get", operationVersion: "1.0", availability: "AVAILABLE" }
    ] }, plan)).toThrow(/unexpectedly serves/u);
    expect(() => assertSampleAvailabilityProjection({ operations: [
      { operationId: "reference.get", operationVersion: "1.0", availability: "AVAILABLE" },
      { operationId: "network.graph.get", operationVersion: "1.0", availability: "UNAVAILABLE" },
      { operationId: "route.plan", operationVersion: "1.0", availability: "UNAVAILABLE" }
    ] }, plan)).toThrow(/exact sample probe set/u);
  });
});

describe("sample-world snapshot query submission", () => {
  it("accepts only a structured strict version mismatch for the pinned replay", () => {
    const mismatch = {
      status: "FAILED",
      error: {
        error: {
          code: "SCHEMA_MISMATCH",
          details: { stage: "SNAPSHOT", adherenceStatus: "MISMATCHED" }
        }
      }
    };
    expect(() => assertPinnedSnapshotMismatch(mismatch)).not.toThrow();
    expect(() => assertPinnedSnapshotMismatch({
      ...mismatch,
      error: { error: { code: "SCHEMA_MISMATCH", details: { stage: "SNAPSHOT", adherenceStatus: "UNSUPPORTED" } } }
    })).toThrow(/strict snapshot version mismatch/u);
  });

  it("keeps aggregate plan budgets at least as large as the real Provider node budget", async () => {
    const manifest = JSON.parse(await readFile(
      "contracts/manifests/providers/world-evidence-provider.json",
      "utf8"
    )) as { capabilities: Record<string, any>[] };
    const descriptor = manifest.capabilities.find(({ operationId }) => operationId === "world.get-current-state");
    expect(descriptor).toBeDefined();
    expect(descriptor!.limits.maximumCandidates).toBeGreaterThan(100);

    const referenceKey = {
      namespace: "gowm",
      kind: "WORLD_OBJECT",
      id: `wrf_${"1".repeat(32)}`,
      version: "1"
    };
    const submission = buildSnapshotQuerySubmission(
      { descriptor: () => descriptor! } as never,
      { schemaVersion: "1.0", referenceKey },
      "hidden-security-result"
    );
    expect(validateContract("world-query-submission.schema.json", submission)).toMatchObject({ valid: true });
    const semanticValidation = validateWorldQueryPlanSemantics(submission.plan as WorldQueryPlanV2);
    expect(semanticValidation).toMatchObject({ valid: true, issues: [] });
    expect(submission.plan.budgets).toMatchObject(submission.plan.nodes[0].budget);
    expect(submission.snapshotPolicy).toEqual({ mode: "LATEST_AT_START", allowDowngrade: false });
    expect(submission.plan.nodes[0].inputs).toMatchObject({
      schemaVersion: { kind: "LITERAL", targetPath: "/schemaVersion" },
      referenceKey: { kind: "REFERENCE_KEY", targetPath: "/referenceKey", referenceKey }
    });
    const snapshot = new QuerySnapshotCoordinator(() => new Date("2026-08-28T00:00:00.000Z"))
      .resolve(submission as WorldQuerySubmission);
    expect(snapshot.resources).toEqual([{
      resourceKind: "WORLD_OBJECT",
      resourceId: `${referenceKey.namespace}:${referenceKey.id}`,
      version: referenceKey.version,
      pinning: "PINNED"
    }]);
  });
});
