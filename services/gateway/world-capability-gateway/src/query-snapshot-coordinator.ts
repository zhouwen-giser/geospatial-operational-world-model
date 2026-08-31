import {
  compareUnicodeCodePoints,
  snapshotResourceIdFromArtifact,
  snapshotResourceIdFromDataset,
  snapshotResourceIdFromReferenceKey,
  snapshotResourceEvidenceIdentity,
  snapshotResourceIdentity,
  type CapabilityDescriptor,
  type CapabilityResultEnvelope,
  type DataSnapshotContext,
  type GowmV071QuerySnapshotAdherence as QuerySnapshotAdherence,
  type GowmV071QuerySnapshotManifest as QuerySnapshotManifest,
  type GowmV071QuerySnapshotPolicy as QuerySnapshotPolicy,
  type WorldQueryPlanV2InputBinding,
  type WorldQuerySubmission
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import { validateProviderSnapshotBoundary } from "./provider-snapshot-boundary.js";

type SnapshotResource = QuerySnapshotManifest["resources"][number];
type SnapshotMismatch = NonNullable<QuerySnapshotAdherence["mismatches"]>[number];

export interface MergeProviderSnapshotArgs {
  requested: QuerySnapshotManifest;
  effective: QuerySnapshotManifest;
  providerSnapshot: DataSnapshotContext;
  descriptor: CapabilityDescriptor;
  policy?: QuerySnapshotPolicy;
  nodeId: string;
  dataScopeClaim?: string;
  datasetScopeClaim?: string;
}

export interface MergeProviderSnapshotResult {
  effective: QuerySnapshotManifest;
  adherence: QuerySnapshotAdherence;
  discoveredResourceCount: number;
  observedResourceIdentities: string[];
  warnings: string[];
}

export class ProviderSnapshotMismatchError extends ProviderProtocolError {
  constructor(readonly mergeResult: MergeProviderSnapshotResult, details: Record<string, unknown>) {
    super("SCHEMA_MISMATCH", "provider data snapshot conflicts with the effective snapshot", {
      retryable: false,
      details: { stage: "SNAPSHOT", ...details }
    });
    this.name = "ProviderSnapshotMismatchError";
  }
}

export class QuerySnapshotCoordinator {
  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Compatibility entrypoint retained for v0.6.x Gateway callers. */
  resolve(submission: WorldQuerySubmission): QuerySnapshotManifest {
    return this.resolveRequested(submission);
  }

  resolveRequested(submission: WorldQuerySubmission): QuerySnapshotManifest {
    const policy: QuerySnapshotPolicy = submission.snapshotPolicy ?? { mode: "BEST_EFFORT", allowDowngrade: true };
    if (policy.mode === "PINNED") {
      const pinned = structuredClone(policy.pinnedSnapshot!);
      this.assertManifestHash(pinned);
      return pinned;
    }
    const capturedAt = this.now().toISOString();
    const resources = collectResources(submission, policy.mode);
    const base = {
      querySnapshotId: `snapshot_${sha256({ queryId: submission.plan.queryId, requestId: submission.requestId, capturedAt }).slice(7, 39)}`,
      mode: policy.mode,
      consistency: policy.mode === "BEST_EFFORT" ? "BEST_EFFORT" as const : "CONSISTENT_AT_START" as const,
      capturedAt,
      resources,
      ...(policy.mode === "AT_LEAST_WORLD_VERSION" ? { minimumWorldVersion: policy.minimumWorldVersion! } : {})
    };
    return { ...base, manifestHash: sha256(base) };
  }

  assertManifestHash(manifest: QuerySnapshotManifest): void {
    const { manifestHash, ...content } = manifest;
    if (manifestHash !== sha256(content)) {
      throw snapshotError("query snapshot manifest hash is invalid", { reason: "CONTENT_HASH_MISMATCH" });
    }
    if (manifest.resources.length > 512) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", "query snapshot exceeds the resource limit", {
        retryable: false,
        details: { stage: "SNAPSHOT", limit: 512, actual: manifest.resources.length }
      });
    }
    assertUniqueManifestResources(manifest.resources);
  }

  assertProviderMayExecute(args: {
    requested: QuerySnapshotManifest;
    effective: QuerySnapshotManifest;
    descriptor: CapabilityDescriptor;
    policy?: QuerySnapshotPolicy;
    nodeId: string;
  }): void {
    this.assertManifestHash(args.requested);
    this.assertManifestHash(args.effective);
    if (args.requested.querySnapshotId !== args.effective.querySnapshotId) {
      throw snapshotError("requested and effective snapshots have different identities", {
        nodeId: args.nodeId,
        reason: "VERSION_MISMATCH"
      });
    }
    if (
      args.descriptor.snapshotPolicy.resourceResolution === "REQUIRE_PINNED" &&
      args.effective.resources.length === 0
    ) {
      throw snapshotError("provider requires a pinned resource that is not present", {
        nodeId: args.nodeId,
        reason: "RESOURCE_MISSING"
      });
    }
    if (
      args.descriptor.snapshotPolicy.resourceResolution === "REQUIRE_PINNED" &&
      args.effective.resources.some((resource) => resource.pinning !== "PINNED")
    ) {
      throw snapshotError("provider requires resources that are not yet pinned in the effective snapshot", {
        nodeId: args.nodeId,
        reason: "PINNING_UNSUPPORTED"
      });
    }
  }

  mergeProviderSnapshot(args: MergeProviderSnapshotArgs): MergeProviderSnapshotResult {
    this.assertProviderMayExecute(args);
    const behavior = args.descriptor.snapshotPolicy.resourceResolution;
    if (behavior === "NOT_APPLICABLE") {
      throw snapshotError("world-independent provider returned a data snapshot", {
        nodeId: args.nodeId,
        reason: "PINNING_UNSUPPORTED"
      });
    }

    const scopeDigestVerified = verifyProviderScopeBinding(
      args.providerSnapshot,
      args.descriptor.scopePolicy,
      args.dataScopeClaim,
      args.datasetScopeClaim
    );
    const effectivePolicy = args.policy ?? defaultPolicy(args.requested);
    const boundary = validateProviderSnapshotBoundary({
      requestedSnapshot: args.requested,
      effectiveSnapshot: args.effective,
      providerSnapshot: args.providerSnapshot,
      policy: effectivePolicy,
      descriptor: args.descriptor,
      nodeId: args.nodeId
    });
    const providerResources = normalizeProviderResources(args.providerSnapshot);
    const observedResourceIdentities = providerResources.map((resource) =>
      providerResourceId(() => snapshotResourceEvidenceIdentity(resource))
    );
    const warnings = [scopeDigestVerified
      ? "Provider scopeDigest was verified against the delegated Gateway scope"
      : "Provider scopeDigest is retained as evidence but is not recomputed by the Gateway"];
    const boundaryMismatches: SnapshotMismatch[] = boundary.mismatchReasons.map((reason) => ({
      resourceKind: "SNAPSHOT",
      resourceId: args.nodeId,
      reason
    }));
    const effectiveAtBoundary = boundary.downgradeRequired
      ? downgradedSnapshot(args.effective)
      : args.effective;
    const current = new Map(effectiveAtBoundary.resources.map((resource) => [resourceIdentity(resource), structuredClone(resource)]));
    const requested = new Map(args.requested.resources.map((resource) => [resourceIdentity(resource), resource]));
    const resourceMismatches: SnapshotMismatch[] = [];
    let discoveredResourceCount = 0;

    for (const observed of providerResources) {
      const identity = resourceIdentity(observed);
      const existing = current.get(identity);
      if (!existing) {
        if (behavior === "DISCOVER_RESOURCES") {
          if (effectivePolicy.mode === "PINNED") {
            resourceMismatches.push(mismatch(observed, undefined, "RESOURCE_MISSING"));
          } else if (
            effectivePolicy.mode === "AT_LEAST_WORLD_VERSION"
            && !providerVersionSatisfiesPolicy(observed, effectivePolicy)
          ) {
            resourceMismatches.push(mismatch(observed, undefined, versionMismatchReason(effectivePolicy, observed)));
          } else if (strictPolicy(effectivePolicy) && observed.pinning !== "PINNED") {
            resourceMismatches.push(mismatch(observed, undefined, "PINNING_UNSUPPORTED"));
          } else {
            current.set(identity, resolvedObservedResource(observed, boundary.downgradeRequired));
            discoveredResourceCount += 1;
          }
        } else if (behavior === "REQUIRE_PINNED") {
          resourceMismatches.push(mismatch(observed, undefined, "RESOURCE_MISSING"));
        }
        continue;
      }

      const requestedResource = requested.get(identity);
      const mayResolveFlexibleRequestedPin =
        requestedResource !== undefined &&
        existing.version === requestedResource.version &&
        existing.pinning !== "PINNED";

      if (mayResolveFlexibleRequestedPin && !providerVersionSatisfiesPolicy(observed, effectivePolicy)) {
        resourceMismatches.push(mismatch(observed, existing, versionMismatchReason(effectivePolicy, observed)));
        continue;
      }

      if (existing.version !== observed.version) {
        if (mayResolveFlexibleRequestedPin && providerVersionSatisfiesPolicy(observed, effectivePolicy)) {
          current.set(identity, resolvedObservedResource({
            ...observed,
            ...((observed.contentHash ?? existing.contentHash) === undefined
              ? {}
              : { contentHash: observed.contentHash ?? existing.contentHash! }),
            ...((observed.worldVersion ?? existing.worldVersion) === undefined
              ? {}
              : { worldVersion: observed.worldVersion ?? existing.worldVersion! })
          }, boundary.downgradeRequired));
          continue;
        }
        resourceMismatches.push(mismatch(observed, existing, versionMismatchReason(effectivePolicy, observed)));
        continue;
      }
      if (existing.contentHash !== undefined && observed.contentHash === undefined) {
        resourceMismatches.push(mismatch(observed, existing, "CONTENT_HASH_MISMATCH"));
        continue;
      }
      if (existing.contentHash !== undefined && observed.contentHash !== undefined && existing.contentHash !== observed.contentHash) {
        resourceMismatches.push(mismatch(observed, existing, "CONTENT_HASH_MISMATCH"));
        continue;
      }
      if (existing.worldVersion !== undefined && observed.worldVersion !== undefined && existing.worldVersion !== observed.worldVersion) {
        resourceMismatches.push(mismatch(observed, existing, "VERSION_MISMATCH"));
        continue;
      }
      if (existing.pinning === "PINNED" && observed.pinning !== "PINNED") {
        resourceMismatches.push(mismatch(observed, existing, "PINNING_UNSUPPORTED"));
        continue;
      }
      current.set(identity, {
        ...existing,
        ...(existing.contentHash === undefined && observed.contentHash !== undefined ? { contentHash: observed.contentHash } : {}),
        ...(existing.worldVersion === undefined && observed.worldVersion !== undefined ? { worldVersion: observed.worldVersion } : {}),
        ...(mayResolveFlexibleRequestedPin
          ? { pinning: resolvedObservedPinning(observed, boundary.downgradeRequired) }
          : {})
      });
    }

    const mismatches = [...boundaryMismatches, ...resourceMismatches];

    const adherenceEvidence = {
      expectedConsistency: boundary.expectedConsistency,
      actualConsistency: boundary.actualConsistency,
      expectedCapturedAt: boundary.expectedCapturedAt,
      actualCapturedAt: boundary.actualCapturedAt
    };
    const adherence: QuerySnapshotAdherence = mismatches.length === 0
      ? {
          nodeId: args.nodeId,
          status: boundary.status === "ADVANCED_COMPATIBLE" || (behavior === undefined && args.effective.resources.length === 0) ? "ADVANCED_COMPATIBLE" : "MATCHED",
          checkedResources: providerResources.length,
          mismatches: [],
          ...adherenceEvidence
        }
      : {
          nodeId: args.nodeId,
          status: "MISMATCHED",
          checkedResources: providerResources.length,
          mismatches,
          ...adherenceEvidence
        };

    if (mismatches.length > 0) {
      if (strictPolicy(effectivePolicy)) {
        const first = mismatches[0]!;
        const mergeResult: MergeProviderSnapshotResult = {
          effective: structuredClone(effectiveAtBoundary),
          adherence,
          discoveredResourceCount: 0,
          observedResourceIdentities,
          warnings
        };
        throw new ProviderSnapshotMismatchError(mergeResult, {
          nodeId: args.nodeId,
          reason: first.reason,
          resourceKind: first.resourceKind,
          resourceId: first.resourceId
        });
      }
      warnings.push(...resourceMismatches.map((item) =>
        `${args.nodeId}: retained prior effective pin for ${item.resourceKind}/${item.resourceId} (${item.reason})`
      ));
      if (resourceMismatches.length > 0) {
        return {
          effective: structuredClone(effectiveAtBoundary),
          adherence,
          discoveredResourceCount: 0,
          observedResourceIdentities,
          warnings
        };
      }
      warnings.push(...boundaryMismatches.map((item) =>
        `${args.nodeId}: downgraded the effective snapshot for Provider boundary mismatch (${item.reason})`
      ));
    }

    if (behavior === undefined) {
      warnings.push(`${args.nodeId}: legacy descriptor resources were checked but not merged`);
      return {
        effective: structuredClone(effectiveAtBoundary),
        adherence,
        discoveredResourceCount: 0,
        observedResourceIdentities,
        warnings
      };
    }

    const resources = [...current.values()].sort(compareResources);
    if (resources.length > 512) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", "effective query snapshot exceeds 512 resources", {
        retryable: false,
        details: { stage: "SNAPSHOT", nodeId: args.nodeId, limit: 512, actual: resources.length }
      });
    }
    const nextContent = { ...withoutManifestHash(effectiveAtBoundary), resources };
    const effective: QuerySnapshotManifest = { ...nextContent, manifestHash: sha256(nextContent) };
    return { effective, adherence, discoveredResourceCount, observedResourceIdentities, warnings };
  }

  adherence(
    nodeId: string,
    descriptor: CapabilityDescriptor,
    manifest: QuerySnapshotManifest,
    result?: CapabilityResultEnvelope
  ): QuerySnapshotAdherence {
    if (descriptor.dataBinding === "WORLD_INDEPENDENT") {
      return { nodeId, status: "NOT_APPLICABLE", checkedResources: 0, mismatches: [] };
    }
    const actual = result?.dataSnapshot;
    if (!actual) {
      return {
        nodeId,
        status: "UNSUPPORTED",
        checkedResources: 0,
        mismatches: [{ resourceKind: "SNAPSHOT", resourceId: nodeId, reason: "PINNING_UNSUPPORTED" }]
      };
    }
    if (manifest.mode === "BEST_EFFORT" && manifest.resources.length === 0) {
      return { nodeId, status: "ADVANCED_COMPATIBLE", checkedResources: actual.resources.length, mismatches: [] };
    }
    if (manifest.mode === "LATEST_AT_START" && manifest.resources.length === 0) {
      return {
        nodeId,
        status: "UNSUPPORTED",
        checkedResources: actual.resources.length,
        mismatches: [{ resourceKind: "SNAPSHOT", resourceId: nodeId, reason: "PINNING_UNSUPPORTED" }]
      };
    }
    const mismatches: SnapshotMismatch[] = [];
    for (const expected of manifest.resources) {
      const observed = actual.resources.find((resource) =>
        resource.referenceKey.kind === expected.resourceKind &&
        snapshotResourceIdFromReferenceKey(resource.referenceKey) === expected.resourceId
      );
      if (!observed) {
        mismatches.push({ resourceKind: expected.resourceKind, resourceId: expected.resourceId, expectedVersion: expected.version, reason: "RESOURCE_MISSING" });
        continue;
      }
      if (expected.contentHash !== undefined && observed.digest !== expected.contentHash) {
        mismatches.push({ resourceKind: expected.resourceKind, resourceId: expected.resourceId, expectedVersion: expected.version, actualVersion: observed.referenceKey.version, reason: "CONTENT_HASH_MISMATCH" });
        continue;
      }
      if (
        expected.worldVersion !== undefined &&
        observed.worldVersion !== undefined &&
        expected.worldVersion !== observed.worldVersion
      ) {
        mismatches.push({ resourceKind: expected.resourceKind, resourceId: expected.resourceId, expectedVersion: expected.version, actualVersion: observed.referenceKey.version, reason: "VERSION_MISMATCH" });
        continue;
      }
      if (manifest.mode === "AT_LEAST_WORLD_VERSION") {
        const actualWorldVersion = observed.worldVersion;
        if (actualWorldVersion === undefined || actualWorldVersion < (manifest.minimumWorldVersion ?? 0)) {
          mismatches.push({ resourceKind: expected.resourceKind, resourceId: expected.resourceId, expectedVersion: String(manifest.minimumWorldVersion), actualVersion: observed.referenceKey.version, reason: "WORLD_VERSION_TOO_OLD" });
        }
      } else if (observed.referenceKey.version !== expected.version) {
        mismatches.push({ resourceKind: expected.resourceKind, resourceId: expected.resourceId, expectedVersion: expected.version, actualVersion: observed.referenceKey.version, reason: "VERSION_MISMATCH" });
      }
    }
    if (mismatches.length > 0) {
      return { nodeId, status: "MISMATCHED", checkedResources: actual.resources.length, mismatches };
    }
    return { nodeId, status: "MATCHED", checkedResources: actual.resources.length, mismatches: [] };
  }

  assertAdherence(policy: QuerySnapshotPolicy | undefined, adherence: QuerySnapshotAdherence): void {
    if (strictPolicy(policy) && ["MISMATCHED", "UNSUPPORTED"].includes(adherence.status)) {
      throw snapshotError("strict query snapshot policy could not be satisfied", {
        nodeId: adherence.nodeId,
        adherenceStatus: adherence.status
      });
    }
  }
}

function collectResources(submission: WorldQuerySubmission, mode: QuerySnapshotManifest["mode"]): SnapshotResource[] {
  const resources = new Map<string, SnapshotResource>();
  const add = (resource: SnapshotResource): void => {
    const identity = resourceIdentity(resource);
    const existing = resources.get(identity);
    if (existing !== undefined && !sameResource(existing, resource)) {
      throw snapshotError("query input binds conflicting versions of the same resource", {
        reason: existing.version === resource.version ? "CONTENT_HASH_MISMATCH" : "VERSION_MISMATCH",
        resourceKind: resource.resourceKind,
        resourceId: resource.resourceId
      });
    }
    resources.set(identity, resource);
  };
  const visit = (binding: WorldQueryPlanV2InputBinding): void => {
    if (binding.kind === "REFERENCE_KEY") {
      add({
        resourceKind: binding.referenceKey.kind,
        resourceId: inputResourceId(() => snapshotResourceIdFromReferenceKey(binding.referenceKey)),
        version: binding.referenceKey.version,
        pinning: mode === "AT_LEAST_WORLD_VERSION" ? "AT_LEAST" : mode === "BEST_EFFORT" ? "BEST_EFFORT" : "PINNED"
      });
    } else if (binding.kind === "DATASET_VERSION") {
      add({ resourceKind: "DATASET", resourceId: inputResourceId(() => snapshotResourceIdFromDataset(binding.datasetId)), version: binding.version, pinning: mode === "BEST_EFFORT" ? "BEST_EFFORT" : "PINNED" });
    } else if (binding.kind === "ARTIFACT_REFERENCE") {
      add({ resourceKind: "ARTIFACT", resourceId: inputResourceId(() => snapshotResourceIdFromArtifact(binding.artifactId)), version: binding.digest, contentHash: binding.digest, pinning: mode === "BEST_EFFORT" ? "BEST_EFFORT" : "PINNED" });
    }
  };
  for (const node of submission.plan.nodes) {
    for (const binding of Object.values(node.inputs)) visit(binding);
  }
  return [...resources.values()].sort(compareResources);
}

function verifyProviderScopeBinding(
  snapshot: DataSnapshotContext,
  scopePolicy: CapabilityDescriptor["scopePolicy"],
  dataScopeClaim?: string,
  datasetScopeClaim?: string
): boolean {
  if (scopePolicy !== "DATA_SCOPE_REQUIRED" && scopePolicy !== "DATASET_SCOPE_REQUIRED") return false;
  if (scopePolicy === "DATA_SCOPE_REQUIRED" && (dataScopeClaim === undefined || dataScopeClaim.trim().length === 0)) {
    throw new ProviderProtocolError("SCOPE_DENIED", "provider data-scope snapshot lacks a delegated Gateway scope", {
      retryable: false,
      details: { stage: "SNAPSHOT" }
    });
  }
  if (scopePolicy === "DATASET_SCOPE_REQUIRED" && (datasetScopeClaim === undefined || datasetScopeClaim.trim().length === 0)) {
    throw new ProviderProtocolError("SCOPE_DENIED", "provider dataset-scope snapshot lacks a delegated Gateway scope", {
      retryable: false,
      details: { stage: "SNAPSHOT" }
    });
  }
  // DATA_SCOPE ids are immutable catalog/native identities and are not required
  // to expose the authorization claim. Verify the provider's canonical scope
  // binding instead. Dataset-scoped providers include the dataset claim while
  // data-scope-only providers bind only the data claim.
  const expected = scopePolicy === "DATASET_SCOPE_REQUIRED"
    ? new Set<string>([sha256({
        ...(dataScopeClaim === undefined ? {} : { dataScopeKey: dataScopeClaim }),
        datasetScopeKey: datasetScopeClaim
      })])
    : new Set<string>([
        sha256({ dataScopeKey: dataScopeClaim }),
        ...(datasetScopeClaim === undefined
          ? []
          : [sha256({ dataScopeKey: dataScopeClaim, datasetScopeKey: datasetScopeClaim })])
      ]);
  if (!expected.has(snapshot.scopeDigest)) {
    throw new ProviderProtocolError("SCOPE_DENIED", "provider data snapshot is not bound to the delegated Gateway scope", {
      retryable: false,
      details: { stage: "SNAPSHOT" }
    });
  }
  return true;
}

function normalizeProviderResources(snapshot: DataSnapshotContext): SnapshotResource[] {
  const resources = new Map<string, SnapshotResource>();
  for (const resource of snapshot.resources) {
    const { namespace, kind, id, version } = resource.referenceKey;
    if (![namespace, kind, id, version, resource.authority].every((value) => value.trim().length > 0)) {
      throw snapshotError("provider data snapshot contains an empty resource identity", { reason: "RESOURCE_MISSING" });
    }
    if (resource.digest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(resource.digest)) {
      throw snapshotError("provider data snapshot contains an invalid content hash", { reason: "CONTENT_HASH_MISMATCH" });
    }
    if (resource.worldVersion !== undefined && (!Number.isSafeInteger(resource.worldVersion) || resource.worldVersion < 0)) {
      throw snapshotError("provider data snapshot contains an invalid world version", { reason: "VERSION_MISMATCH" });
    }
    const normalized: SnapshotResource = {
      resourceKind: kind,
      resourceId: providerResourceId(() => snapshotResourceIdFromReferenceKey({ namespace, id })),
      version,
      ...(resource.digest === undefined ? {} : { contentHash: resource.digest }),
      ...(resource.worldVersion === undefined ? {} : { worldVersion: resource.worldVersion }),
      pinning: resource.pinning
    };
    const identity = resourceIdentity(normalized);
    const existing = resources.get(identity);
    if (existing !== undefined && !sameResource(existing, normalized)) {
      throw snapshotError("provider data snapshot contradicts itself for one resource identity", {
        reason: existing.version === normalized.version ? "CONTENT_HASH_MISMATCH" : "VERSION_MISMATCH",
        resourceKind: normalized.resourceKind,
        resourceId: normalized.resourceId
      });
    }
    resources.set(identity, normalized);
  }
  return [...resources.values()].sort(compareResources);
}

function assertUniqueManifestResources(resources: readonly SnapshotResource[]): void {
  const identities = new Map<string, SnapshotResource>();
  for (const resource of resources) {
    const identity = resourceIdentity(resource);
    const existing = identities.get(identity);
    if (existing !== undefined) {
      throw snapshotError("query snapshot contains a duplicate resource identity", {
        reason: sameResource(existing, resource) ? "RESOURCE_MISSING" : "VERSION_MISMATCH",
        resourceKind: resource.resourceKind,
        resourceId: resource.resourceId
      });
    }
    identities.set(identity, resource);
  }
}

function resolvedObservedResource(resource: SnapshotResource, preserveProviderPinning: boolean): SnapshotResource {
  return {
    ...structuredClone(resource),
    pinning: resolvedObservedPinning(resource, preserveProviderPinning)
  };
}

function resolvedObservedPinning(
  resource: SnapshotResource,
  preserveProviderPinning: boolean
): SnapshotResource["pinning"] {
  return preserveProviderPinning ? resource.pinning : "PINNED";
}

function resourceIdentity(resource: SnapshotResource): string {
  return providerResourceId(() => snapshotResourceIdentity(resource));
}

function compareResources(left: SnapshotResource, right: SnapshotResource): number {
  for (const [leftValue, rightValue] of [
    [left.resourceKind, right.resourceKind],
    [left.resourceId, right.resourceId],
    [left.version, right.version],
    [left.contentHash ?? "", right.contentHash ?? ""]
  ] as const) {
    const compared = compareUnicodeCodePoints(leftValue, rightValue);
    if (compared !== 0) return compared;
  }
  const worldVersion = (left.worldVersion ?? -1) - (right.worldVersion ?? -1);
  return worldVersion !== 0 ? worldVersion : compareUnicodeCodePoints(left.pinning, right.pinning);
}

function sameResource(left: SnapshotResource, right: SnapshotResource): boolean {
  return left.resourceKind === right.resourceKind &&
    left.resourceId === right.resourceId &&
    left.version === right.version &&
    left.contentHash === right.contentHash &&
    left.worldVersion === right.worldVersion &&
    left.pinning === right.pinning;
}

function providerVersionSatisfiesPolicy(resource: SnapshotResource, policy: QuerySnapshotPolicy | undefined): boolean {
  const effective = policy ?? { mode: "BEST_EFFORT", allowDowngrade: true };
  if (effective.mode === "PINNED" || effective.mode === "LATEST_AT_START") return false;
  if (effective.mode === "AT_LEAST_WORLD_VERSION") {
    return resource.worldVersion !== undefined && resource.worldVersion >= (effective.minimumWorldVersion ?? 0);
  }
  return true;
}

function versionMismatchReason(policy: QuerySnapshotPolicy | undefined, observed: SnapshotResource): SnapshotMismatch["reason"] {
  return policy?.mode === "AT_LEAST_WORLD_VERSION" &&
    (observed.worldVersion === undefined || observed.worldVersion < (policy.minimumWorldVersion ?? 0))
    ? "WORLD_VERSION_TOO_OLD"
    : "VERSION_MISMATCH";
}

function mismatch(
  actual: SnapshotResource,
  expected: SnapshotResource | undefined,
  reason: SnapshotMismatch["reason"]
): SnapshotMismatch {
  return {
    resourceKind: actual.resourceKind,
    resourceId: actual.resourceId,
    ...(expected === undefined ? {} : { expectedVersion: expected.version }),
    actualVersion: actual.version,
    reason
  };
}

function strictPolicy(policy: QuerySnapshotPolicy | undefined): boolean {
  const effective = policy ?? { mode: "BEST_EFFORT", allowDowngrade: true };
  return effective.mode !== "BEST_EFFORT" && effective.allowDowngrade !== true;
}

function defaultPolicy(manifest: QuerySnapshotManifest): QuerySnapshotPolicy {
  return {
    mode: manifest.mode,
    ...(manifest.minimumWorldVersion === undefined ? {} : { minimumWorldVersion: manifest.minimumWorldVersion }),
    ...(manifest.mode === "PINNED" ? { pinnedSnapshot: manifest } : {}),
    allowDowngrade: manifest.mode === "BEST_EFFORT"
  } as QuerySnapshotPolicy;
}

function downgradedSnapshot(manifest: QuerySnapshotManifest): QuerySnapshotManifest {
  const content = { ...withoutManifestHash(manifest), consistency: "BEST_EFFORT" as const };
  return { ...content, manifestHash: sha256(content) };
}

function inputResourceId(factory: () => string): string {
  try {
    return factory();
  } catch (error) {
    throw new ProviderProtocolError("INVALID_REQUEST", error instanceof Error ? error.message : "snapshot resource identity is invalid", {
      retryable: false,
      details: { stage: "SNAPSHOT" }
    });
  }
}

function providerResourceId(factory: () => string): string {
  try {
    return factory();
  } catch (error) {
    throw snapshotError(error instanceof Error ? error.message : "snapshot resource identity is invalid", { reason: "RESOURCE_MISSING" });
  }
}

function withoutManifestHash(manifest: QuerySnapshotManifest): Omit<QuerySnapshotManifest, "manifestHash"> {
  const { manifestHash: _manifestHash, ...content } = manifest;
  return content;
}

function snapshotError(message: string, details: Record<string, unknown>): ProviderProtocolError {
  return new ProviderProtocolError("SCHEMA_MISMATCH", message, {
    retryable: false,
    details: { stage: "SNAPSHOT", ...details }
  });
}
