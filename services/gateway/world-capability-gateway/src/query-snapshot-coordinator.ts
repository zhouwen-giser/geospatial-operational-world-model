import type {
  CapabilityDescriptor,
  CapabilityResultEnvelope,
  QuerySnapshotAdherence,
  QuerySnapshotManifest,
  QuerySnapshotPolicy,
  WorldQueryPlanV2InputBinding,
  WorldQuerySubmission
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";

type SnapshotResource = QuerySnapshotManifest["resources"][number];

export class QuerySnapshotCoordinator {
  constructor(private readonly now: () => Date = () => new Date()) {}

  resolve(submission: WorldQuerySubmission): QuerySnapshotManifest {
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
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "query snapshot manifest hash is invalid", {
        details: { stage: "SNAPSHOT" }
      });
    }
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
    const mismatches: NonNullable<QuerySnapshotAdherence["mismatches"]> = [];
    for (const expected of manifest.resources) {
      const observed = actual.resources.find((resource) =>
        resource.referenceKey.kind === expected.resourceKind &&
        `${resource.referenceKey.namespace}:${resource.referenceKey.id}` === expected.resourceId
      );
      if (!observed) {
        mismatches.push({ resourceKind: expected.resourceKind, resourceId: expected.resourceId, expectedVersion: expected.version, reason: "RESOURCE_MISSING" });
        continue;
      }
      if (expected.contentHash !== undefined && observed.digest !== expected.contentHash) {
        mismatches.push({ resourceKind: expected.resourceKind, resourceId: expected.resourceId, expectedVersion: expected.version, actualVersion: observed.referenceKey.version, reason: "CONTENT_HASH_MISMATCH" });
        continue;
      }
      if (manifest.mode === "AT_LEAST_WORLD_VERSION") {
        const actualWorldVersion = numericVersion(observed.referenceKey.version);
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
    const effective = policy ?? { mode: "BEST_EFFORT", allowDowngrade: true };
    if (effective.mode !== "BEST_EFFORT" && !effective.allowDowngrade && ["MISMATCHED", "UNSUPPORTED"].includes(adherence.status)) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "strict query snapshot policy could not be satisfied", {
        retryable: false,
        details: { stage: "SNAPSHOT", nodeId: adherence.nodeId, adherenceStatus: adherence.status }
      });
    }
  }
}

function collectResources(submission: WorldQuerySubmission, mode: QuerySnapshotManifest["mode"]): SnapshotResource[] {
  const resources = new Map<string, SnapshotResource>();
  const add = (resource: SnapshotResource) => resources.set(`${resource.resourceKind}\u0000${resource.resourceId}\u0000${resource.version}`, resource);
  const visit = (binding: WorldQueryPlanV2InputBinding): void => {
    if (binding.kind === "REFERENCE_KEY") {
      add({
        resourceKind: binding.referenceKey.kind,
        resourceId: `${binding.referenceKey.namespace}:${binding.referenceKey.id}`,
        version: binding.referenceKey.version,
        pinning: mode === "AT_LEAST_WORLD_VERSION" ? "AT_LEAST" : mode === "BEST_EFFORT" ? "BEST_EFFORT" : "PINNED"
      });
    } else if (binding.kind === "DATASET_VERSION") {
      add({ resourceKind: "DATASET", resourceId: `dataset:${binding.datasetId}`, version: binding.version, pinning: mode === "BEST_EFFORT" ? "BEST_EFFORT" : "PINNED" });
    } else if (binding.kind === "ARTIFACT_REFERENCE") {
      add({ resourceKind: "ARTIFACT", resourceId: `artifact:${binding.artifactId}`, version: binding.digest, contentHash: binding.digest, pinning: mode === "BEST_EFFORT" ? "BEST_EFFORT" : "PINNED" });
    }
  };
  for (const node of submission.plan.nodes) {
    for (const binding of Object.values(node.inputs)) visit(binding);
  }
  return [...resources.values()].sort((left, right) =>
    `${left.resourceKind}:${left.resourceId}:${left.version}`.localeCompare(`${right.resourceKind}:${right.resourceId}:${right.version}`)
  );
}

function numericVersion(value: string): number | undefined {
  const matches = value.match(/[0-9]+/gu);
  if (!matches?.length) return undefined;
  const parsed = Number(matches.at(-1));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
