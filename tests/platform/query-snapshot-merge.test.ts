import { describe, expect, it } from "vitest";
import type {
  CapabilityDescriptor,
  DataSnapshotContext,
  GowmV071QuerySnapshotManifest as QuerySnapshotManifest,
  GowmV071QuerySnapshotPolicy as QuerySnapshotPolicy
} from "../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { QuerySnapshotCoordinator } from "../../services/gateway/world-capability-gateway/src/query-snapshot-coordinator.js";

type SnapshotResource = QuerySnapshotManifest["resources"][number];
type ProviderResource = DataSnapshotContext["resources"][number];
type ResourceResolution = "DISCOVER_RESOURCES" | "REQUIRE_PINNED" | "NOT_APPLICABLE";

const capturedAt = "2026-08-30T00:00:00.000Z";
const strictLatestPolicy: QuerySnapshotPolicy = { mode: "LATEST_AT_START", allowDowngrade: false };

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function snapshotResource(
  id: string,
  overrides: Partial<SnapshotResource> = {}
): SnapshotResource {
  return {
    resourceKind: "TRACKLET_VERSION",
    resourceId: `scope:${id}`,
    version: "v1",
    pinning: "PINNED",
    ...overrides
  };
}

function manifest(
  resources: SnapshotResource[] = [],
  overrides: Partial<Omit<QuerySnapshotManifest, "manifestHash" | "resources">> = {}
): QuerySnapshotManifest {
  const content: Omit<QuerySnapshotManifest, "manifestHash"> = {
    querySnapshotId: "snapshot-query-merge",
    mode: "BEST_EFFORT",
    consistency: "BEST_EFFORT",
    capturedAt,
    resources: structuredClone(resources),
    ...overrides
  };
  return { ...content, manifestHash: sha256(content) };
}

function providerResource(
  id: string,
  overrides: {
    namespace?: string;
    kind?: string;
    version?: string;
    authority?: string;
    pinning?: ProviderResource["pinning"];
    digest?: `sha256:${string}`;
    worldVersion?: number;
  } = {}
): ProviderResource {
  return {
    referenceKey: {
      namespace: overrides.namespace ?? "scope",
      kind: overrides.kind ?? "TRACKLET_VERSION",
      id,
      version: overrides.version ?? "v1"
    },
    authority: overrides.authority ?? "provider:test",
    pinning: overrides.pinning ?? "PINNED",
    ...(overrides.digest === undefined ? {} : { digest: overrides.digest }),
    ...(overrides.worldVersion === undefined ? {} : { worldVersion: overrides.worldVersion })
  };
}

function providerSnapshot(
  resources: ProviderResource[],
  scopeDigest: `sha256:${string}` = digest("9"),
  overrides: Partial<Pick<DataSnapshotContext, "consistency" | "capturedAt">> = {}
): DataSnapshotContext {
  return {
    consistency: "PINNED",
    capturedAt,
    scopeDigest,
    resources,
    ...overrides
  };
}

function descriptor(
  resourceResolution?: ResourceResolution,
  dataBinding: CapabilityDescriptor["dataBinding"] = "WORLD_SNAPSHOT_BOUND"
): CapabilityDescriptor {
  return {
    dataBinding,
    snapshotPolicy: {
      dataSnapshot: dataBinding === "WORLD_INDEPENDENT" ? "NONE" : "REQUIRED",
      computeSnapshot: "REQUIRED",
      ...(resourceResolution === undefined ? {} : { resourceResolution })
    }
  } as CapabilityDescriptor;
}

function protocolError(action: () => unknown): ProviderProtocolError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderProtocolError);
    return error as ProviderProtocolError;
  }
  throw new Error("expected ProviderProtocolError");
}

describe("v0.7 effective snapshot merge", () => {
  it("rejects a later BEST_EFFORT provider snapshot for strict LATEST_AT_START", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest([], { mode: "LATEST_AT_START", consistency: "CONSISTENT_AT_START" });
    const error = protocolError(() => coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([providerResource("tracklet-late")], digest("9"), {
        consistency: "BEST_EFFORT",
        capturedAt: "2026-08-31T00:00:00.000Z"
      }),
      descriptor: descriptor("DISCOVER_RESOURCES"),
      policy: strictLatestPolicy,
      nodeId: "resolver-late"
    }));

    expect(error).toMatchObject({
      code: "SCHEMA_MISMATCH",
      details: { stage: "SNAPSHOT", reason: "CAPTURED_AT_AFTER_QUERY_BOUNDARY" }
    });
  });

  it("downgrades the effective snapshot and reports mismatch evidence when allowed", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest([], { mode: "LATEST_AT_START", consistency: "CONSISTENT_AT_START" });
    const result = coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([providerResource("tracklet-late")], digest("9"), {
        consistency: "BEST_EFFORT",
        capturedAt: "2026-08-31T00:00:00.000Z"
      }),
      descriptor: descriptor("DISCOVER_RESOURCES"),
      policy: { mode: "LATEST_AT_START", allowDowngrade: true },
      nodeId: "resolver-late"
    });

    expect(result.effective).toMatchObject({ consistency: "BEST_EFFORT", resources: [] });
    expect(result.adherence).toMatchObject({
      status: "MISMATCHED",
      expectedConsistency: "CONSISTENT_AT_START",
      actualConsistency: "BEST_EFFORT",
      expectedCapturedAt: capturedAt,
      actualCapturedAt: "2026-08-31T00:00:00.000Z"
    });
    expect(result.adherence.mismatches?.map((entry) => entry.reason)).toEqual([
      "CAPTURED_AT_AFTER_QUERY_BOUNDARY",
      "CONSISTENCY_LEVEL_TOO_WEAK"
    ]);
    expect(result.effective.manifestHash).not.toBe(requested.manifestHash);
  });

  it("marks later BEST_EFFORT data as advanced compatible under BEST_EFFORT", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest();
    const result = coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([providerResource("tracklet-late")], digest("9"), {
        consistency: "BEST_EFFORT",
        capturedAt: "2026-08-31T00:00:00.000Z"
      }),
      descriptor: descriptor("DISCOVER_RESOURCES"),
      policy: { mode: "BEST_EFFORT", allowDowngrade: true },
      nodeId: "resolver-late"
    });

    expect(result.adherence.status).toBe("ADVANCED_COMPATIBLE");
  });

  it("maps and pins a newly discovered resource without mutating the requested snapshot", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest();
    const before = structuredClone(requested);
    const result = coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([
        providerResource("tracklet-a", { digest: digest("a"), worldVersion: 17, pinning: "AT_LEAST" })
      ]),
      descriptor: descriptor("DISCOVER_RESOURCES"),
      nodeId: "resolver-a"
    });

    expect(requested).toEqual(before);
    expect(result.discoveredResourceCount).toBe(1);
    expect(result.adherence).toMatchObject({ status: "MATCHED", checkedResources: 1, mismatches: [] });
    expect(result.effective.resources).toEqual([{
      resourceKind: "TRACKLET_VERSION",
      resourceId: "scope:tracklet-a",
      version: "v1",
      contentHash: digest("a"),
      worldVersion: 17,
      pinning: "PINNED"
    }]);
    coordinator.assertManifestHash(result.effective);
  });

  it("verifies an opaque DATA_SCOPE reference against the delegated scope digest", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest();
    const scopedDescriptor = descriptor("DISCOVER_RESOURCES");
    scopedDescriptor.scopePolicy = "DATA_SCOPE_REQUIRED";
    const result = coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([
        providerResource("opaque-reference-key", {
          namespace: "gowm",
          kind: "DATA_SCOPE",
          version: "17",
          digest: digest("a")
        })
      ], sha256({ dataScopeKey: "delegated-scope", datasetScopeKey: "tenant-a" })),
      descriptor: scopedDescriptor,
      nodeId: "world-current-state",
      dataScopeClaim: "delegated-scope",
      datasetScopeClaim: "tenant-a"
    });

    expect(result.effective.resources).toEqual([{
      resourceKind: "DATA_SCOPE",
      resourceId: "gowm:opaque-reference-key",
      version: "17",
      contentHash: digest("a"),
      pinning: "PINNED"
    }]);
    expect(result.warnings).toContain("Provider scopeDigest was verified against the delegated Gateway scope");
    coordinator.assertManifestHash(result.effective);
  });

  it("fails closed when a DATA_SCOPE resource is not bound to the delegated scope digest", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest();
    const scopedDescriptor = descriptor("DISCOVER_RESOURCES");
    scopedDescriptor.scopePolicy = "DATA_SCOPE_REQUIRED";
    const error = protocolError(() => coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([
        providerResource("opaque-reference-key", { namespace: "gowm", kind: "DATA_SCOPE" })
      ], sha256({ dataScopeKey: "different-scope" })),
      descriptor: scopedDescriptor,
      nodeId: "world-current-state",
      dataScopeClaim: "delegated-scope"
    }));

    expect(error).toMatchObject({ code: "SCOPE_DENIED", retryable: false, details: { stage: "SNAPSHOT" } });
  });

  it("verifies required scope policy even when a Provider omits a DATA_SCOPE resource", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest();
    const scopedDescriptor = descriptor("DISCOVER_RESOURCES");
    scopedDescriptor.scopePolicy = "DATA_SCOPE_REQUIRED";
    const error = protocolError(() => coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([
        providerResource("dataset-a", { namespace: "gowm", kind: "DATASET" })
      ], sha256({ dataScopeKey: "different-scope" })),
      descriptor: scopedDescriptor,
      nodeId: "catalog-provider",
      dataScopeClaim: "delegated-scope"
    }));

    expect(error).toMatchObject({ code: "SCOPE_DENIED", retryable: false, details: { stage: "SNAPSHOT" } });
  });

  it("does not allow a DATASET_SCOPE_REQUIRED Provider to downgrade to a data-only digest", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest();
    const datasetDescriptor = descriptor("DISCOVER_RESOURCES");
    datasetDescriptor.scopePolicy = "DATASET_SCOPE_REQUIRED";
    const error = protocolError(() => coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([
        providerResource("dataset-a", { namespace: "gowm", kind: "DATASET" })
      ], sha256({ dataScopeKey: "delegated-scope" })),
      descriptor: datasetDescriptor,
      nodeId: "dataset-provider",
      dataScopeClaim: "delegated-scope",
      datasetScopeClaim: "tenant-a"
    }));

    expect(error).toMatchObject({ code: "SCOPE_DENIED", retryable: false, details: { stage: "SNAPSHOT" } });
  });

  it("is idempotent when a resolver reports the exact same resource again", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest();
    const observed = providerSnapshot([providerResource("tracklet-a", { digest: digest("a"), worldVersion: 17 })]);
    const first = coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: observed,
      descriptor: descriptor("DISCOVER_RESOURCES"),
      nodeId: "resolver-a"
    });
    const replay = coordinator.mergeProviderSnapshot({
      requested,
      effective: first.effective,
      providerSnapshot: observed,
      descriptor: descriptor("DISCOVER_RESOURCES"),
      nodeId: "resolver-a"
    });

    expect(replay.discoveredResourceCount).toBe(0);
    expect(replay.effective).toEqual(first.effective);
    expect(replay.effective.manifestHash).toBe(first.effective.manifestHash);
  });

  it("tightens a flexible same-version pin with provider digest and world version", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest([
      snapshotResource("tracklet-a", { pinning: "BEST_EFFORT" })
    ]);
    const result = coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([
        providerResource("tracklet-a", { digest: digest("a"), worldVersion: 21 })
      ]),
      descriptor: descriptor("DISCOVER_RESOURCES"),
      policy: { mode: "BEST_EFFORT", allowDowngrade: true },
      nodeId: "resolver-a"
    });

    expect(result.effective.resources[0]).toMatchObject({
      version: "v1",
      contentHash: digest("a"),
      worldVersion: 21,
      pinning: "PINNED"
    });
    expect(result.effective.manifestHash).not.toBe(requested.manifestHash);
  });

  it.each([
    {
      name: "digest",
      effective: snapshotResource("tracklet-a", { contentHash: digest("a") }),
      observed: providerResource("tracklet-a", { digest: digest("b") }),
      reason: "CONTENT_HASH_MISMATCH"
    },
    {
      name: "missing observed digest",
      effective: snapshotResource("tracklet-a", { contentHash: digest("a") }),
      observed: providerResource("tracklet-a"),
      reason: "CONTENT_HASH_MISMATCH"
    },
    {
      name: "version",
      effective: snapshotResource("tracklet-a", { version: "v1" }),
      observed: providerResource("tracklet-a", { version: "v2" }),
      reason: "VERSION_MISMATCH"
    },
    {
      name: "world version",
      effective: snapshotResource("tracklet-a", { worldVersion: 10 }),
      observed: providerResource("tracklet-a", { worldVersion: 11 }),
      reason: "VERSION_MISMATCH"
    },
    {
      name: "pinning downgrade",
      effective: snapshotResource("tracklet-a", { pinning: "PINNED" }),
      observed: providerResource("tracklet-a", { pinning: "AT_LEAST" }),
      reason: "PINNING_UNSUPPORTED"
    }
  ])("fails closed on a strict $name conflict and leaves effective state unchanged", ({ effective, observed, reason }) => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest([effective], { mode: "LATEST_AT_START", consistency: "CONSISTENT_AT_START" });
    const before = structuredClone(requested);
    const error = protocolError(() => coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([observed]),
      descriptor: descriptor("DISCOVER_RESOURCES"),
      policy: strictLatestPolicy,
      nodeId: "resolver-conflict"
    }));

    expect(error).toMatchObject({
      code: "SCHEMA_MISMATCH",
      retryable: false,
      details: { stage: "SNAPSHOT", nodeId: "resolver-conflict", reason }
    });
    expect(requested).toEqual(before);
  });

  it("accepts an AT_LEAST upgrade that meets the world-version floor and pins it", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest([
      snapshotResource("tracklet-a", { version: "floor-v1", worldVersion: 10, pinning: "AT_LEAST" })
    ], {
      mode: "AT_LEAST_WORLD_VERSION",
      consistency: "CONSISTENT_AT_START",
      minimumWorldVersion: 10
    });
    const result = coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([
        providerResource("tracklet-a", { version: "actual-v2", worldVersion: 11, digest: digest("a") })
      ]),
      descriptor: descriptor("DISCOVER_RESOURCES"),
      policy: { mode: "AT_LEAST_WORLD_VERSION", minimumWorldVersion: 10, allowDowngrade: false },
      nodeId: "resolver-at-least"
    });

    expect(result.effective.resources[0]).toMatchObject({
      version: "actual-v2",
      worldVersion: 11,
      contentHash: digest("a"),
      pinning: "PINNED"
    });
    expect(result.adherence.status).toBe("MATCHED");
  });

  it("rejects an AT_LEAST upgrade below the world-version floor", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest([
      snapshotResource("tracklet-a", { version: "floor-v1", worldVersion: 10, pinning: "AT_LEAST" })
    ], {
      mode: "AT_LEAST_WORLD_VERSION",
      consistency: "CONSISTENT_AT_START",
      minimumWorldVersion: 10
    });
    const error = protocolError(() => coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([
        providerResource("tracklet-a", { version: "too-old-v2", worldVersion: 9 })
      ]),
      descriptor: descriptor("DISCOVER_RESOURCES"),
      policy: { mode: "AT_LEAST_WORLD_VERSION", minimumWorldVersion: 10, allowDowngrade: false },
      nodeId: "resolver-at-least"
    }));

    expect(error).toMatchObject({
      code: "SCHEMA_MISMATCH",
      details: { stage: "SNAPSHOT", reason: "WORLD_VERSION_TOO_OLD" }
    });
  });

  it("rejects a same-version AT_LEAST observation below the world-version floor", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest([
      snapshotResource("tracklet-a", { version: "v1", pinning: "AT_LEAST" })
    ], {
      mode: "AT_LEAST_WORLD_VERSION",
      consistency: "CONSISTENT_AT_START",
      minimumWorldVersion: 10
    });
    const error = protocolError(() => coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([
        providerResource("tracklet-a", { version: "v1", worldVersion: 9 })
      ]),
      descriptor: descriptor("DISCOVER_RESOURCES"),
      policy: { mode: "AT_LEAST_WORLD_VERSION", minimumWorldVersion: 10, allowDowngrade: false },
      nodeId: "resolver-at-least-same-version"
    }));

    expect(error).toMatchObject({
      code: "SCHEMA_MISMATCH",
      details: { stage: "SNAPSHOT", reason: "WORLD_VERSION_TOO_OLD" }
    });
  });

  it("keeps the prior pin and reports an explicit mismatch under BEST_EFFORT", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest([
      snapshotResource("tracklet-a", { pinning: "BEST_EFFORT" })
    ]);
    const effective = manifest([
      snapshotResource("tracklet-a", { version: "v1", contentHash: digest("a"), pinning: "PINNED" })
    ]);
    const result = coordinator.mergeProviderSnapshot({
      requested,
      effective,
      providerSnapshot: providerSnapshot([
        providerResource("tracklet-a", { version: "v2", digest: digest("b") })
      ]),
      descriptor: descriptor("DISCOVER_RESOURCES"),
      policy: { mode: "BEST_EFFORT", allowDowngrade: true },
      nodeId: "resolver-best-effort"
    });

    expect(result.effective).toEqual(effective);
    expect(result.discoveredResourceCount).toBe(0);
    expect(result.adherence).toMatchObject({
      status: "MISMATCHED",
      mismatches: [expect.objectContaining({ reason: "VERSION_MISMATCH" })]
    });
    expect(result.warnings.some((warning) => warning.includes("retained prior effective pin"))).toBe(true);
  });

  it("checks but does not merge a new identity for a legacy descriptor", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest();
    const result = coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([providerResource("legacy-resource")]),
      descriptor: descriptor(),
      policy: { mode: "BEST_EFFORT", allowDowngrade: true },
      nodeId: "legacy-provider"
    });

    expect(result.effective).toEqual(requested);
    expect(result.discoveredResourceCount).toBe(0);
    expect(result.adherence).toMatchObject({
      status: "ADVANCED_COMPATIBLE",
      checkedResources: 1,
      mismatches: []
    });
    expect(result.warnings.some((warning) => warning.includes("legacy descriptor resources were checked but not merged"))).toBe(true);
  });

  it("requires a pre-existing pin and rejects a new identity for REQUIRE_PINNED", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const empty = manifest([], { mode: "LATEST_AT_START", consistency: "CONSISTENT_AT_START" });
    const preflight = protocolError(() => coordinator.assertProviderMayExecute({
      requested: empty,
      effective: empty,
      descriptor: descriptor("REQUIRE_PINNED"),
      policy: strictLatestPolicy,
      nodeId: "consumer-b"
    }));
    expect(preflight).toMatchObject({
      code: "SCHEMA_MISMATCH",
      details: { stage: "SNAPSHOT", reason: "RESOURCE_MISSING" }
    });

    const flexible = manifest([
      snapshotResource("tracklet-a", { pinning: "AT_LEAST" })
    ], { mode: "AT_LEAST_WORLD_VERSION", consistency: "CONSISTENT_AT_START", minimumWorldVersion: 1 });
    const flexiblePreflight = protocolError(() => coordinator.assertProviderMayExecute({
      requested: flexible,
      effective: flexible,
      descriptor: descriptor("REQUIRE_PINNED"),
      policy: { mode: "AT_LEAST_WORLD_VERSION", minimumWorldVersion: 1, allowDowngrade: false },
      nodeId: "consumer-flexible"
    }));
    expect(flexiblePreflight).toMatchObject({
      code: "SCHEMA_MISMATCH",
      details: { stage: "SNAPSHOT", reason: "PINNING_UNSUPPORTED" }
    });

    const requested = manifest([
      snapshotResource("tracklet-a")
    ], { mode: "LATEST_AT_START", consistency: "CONSISTENT_AT_START" });
    const newIdentity = protocolError(() => coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([providerResource("tracklet-b")]),
      descriptor: descriptor("REQUIRE_PINNED"),
      policy: strictLatestPolicy,
      nodeId: "consumer-b"
    }));
    expect(newIdentity).toMatchObject({
      code: "SCHEMA_MISMATCH",
      details: { stage: "SNAPSHOT", reason: "RESOURCE_MISSING" }
    });
  });

  it("rejects DataSnapshot output from a NOT_APPLICABLE world-independent provider", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest();
    const error = protocolError(() => coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([providerResource("forged")]),
      descriptor: descriptor("NOT_APPLICABLE", "WORLD_INDEPENDENT"),
      nodeId: "world-independent"
    }));
    expect(error).toMatchObject({
      code: "SCHEMA_MISMATCH",
      details: { stage: "SNAPSHOT", reason: "PINNING_UNSUPPORTED" }
    });
  });

  it("sorts resources and hashes the same effective manifest independent of Provider order", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const requested = manifest();
    const resources = [
      providerResource("z-tracklet", { kind: "TRACKLET_VERSION", version: "v2", digest: digest("b") }),
      providerResource("a-task", { kind: "TASK", version: "v1", digest: digest("a") }),
      providerResource("a-tracklet", { kind: "TRACKLET_VERSION", version: "v1", digest: digest("c") })
    ];
    const merge = (ordered: ProviderResource[]) => coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot(ordered),
      descriptor: descriptor("DISCOVER_RESOURCES"),
      nodeId: "resolver-order"
    });

    const forward = merge(resources);
    const reverse = merge([...resources].reverse());
    expect(forward.effective).toEqual(reverse.effective);
    expect(forward.effective.resources.map((resource) => `${resource.resourceKind}/${resource.resourceId}`)).toEqual([
      "TASK/scope:a-task",
      "TRACKLET_VERSION/scope:a-tracklet",
      "TRACKLET_VERSION/scope:z-tracklet"
    ]);
    expect(forward.effective.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("fails with BUDGET_EXCEEDED before changing a 512-resource effective snapshot", () => {
    const coordinator = new QuerySnapshotCoordinator();
    const resources = Array.from({ length: 512 }, (_, index) => snapshotResource(
      `tracklet-${String(index).padStart(3, "0")}`
    ));
    const requested = manifest(resources, { mode: "LATEST_AT_START", consistency: "CONSISTENT_AT_START" });
    const before = structuredClone(requested);
    const error = protocolError(() => coordinator.mergeProviderSnapshot({
      requested,
      effective: requested,
      providerSnapshot: providerSnapshot([providerResource("overflow")]),
      descriptor: descriptor("DISCOVER_RESOURCES"),
      policy: strictLatestPolicy,
      nodeId: "resolver-overflow"
    }));

    expect(error).toMatchObject({
      code: "BUDGET_EXCEEDED",
      retryable: false,
      details: { stage: "SNAPSHOT", limit: 512, actual: 513 }
    });
    expect(requested).toEqual(before);
  });
});
