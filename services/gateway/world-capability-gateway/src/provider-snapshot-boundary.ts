import type {
  CapabilityDescriptor,
  DataSnapshotContext,
  GowmV071QuerySnapshotAdherence as QuerySnapshotAdherence,
  GowmV071QuerySnapshotManifest as QuerySnapshotManifest,
  GowmV071QuerySnapshotPolicy as QuerySnapshotPolicy
} from "../../../../packages/platform/contract-runtime/src/index.js";

export type SnapshotMismatchReason = NonNullable<QuerySnapshotAdherence["mismatches"]>[number]["reason"];

export interface ProviderSnapshotBoundaryInput {
  requestedSnapshot: QuerySnapshotManifest;
  effectiveSnapshot: QuerySnapshotManifest;
  providerSnapshot: DataSnapshotContext;
  policy: QuerySnapshotPolicy;
  descriptor: CapabilityDescriptor;
  nodeId: string;
}

export interface ProviderSnapshotBoundaryResult {
  status: "MATCHED" | "ADVANCED_COMPATIBLE" | "MISMATCHED";
  expectedConsistency: QuerySnapshotManifest["consistency"];
  actualConsistency: DataSnapshotContext["consistency"];
  expectedCapturedAt: string;
  actualCapturedAt: string;
  mismatchReasons: SnapshotMismatchReason[];
  downgradeRequired: boolean;
}

export function validateProviderSnapshotBoundary(input: ProviderSnapshotBoundaryInput): ProviderSnapshotBoundaryResult {
  const expectedConsistency = consistencyForMode(input.requestedSnapshot.mode);
  const actualConsistency = input.providerSnapshot.consistency;
  const expectedCapturedAt = input.effectiveSnapshot.capturedAt;
  const actualCapturedAt = input.providerSnapshot.capturedAt;
  const mismatchReasons: SnapshotMismatchReason[] = [];
  const expectedTime = Date.parse(expectedCapturedAt);
  const actualTime = Date.parse(actualCapturedAt);

  if (!Number.isFinite(actualTime)) {
    mismatchReasons.push("PROVIDER_SNAPSHOT_TIME_INVALID");
  } else if (input.requestedSnapshot.mode === "LATEST_AT_START" && actualTime !== expectedTime) {
    mismatchReasons.push(actualTime < expectedTime
      ? "CAPTURED_AT_BEFORE_QUERY_BOUNDARY"
      : "CAPTURED_AT_AFTER_QUERY_BOUNDARY");
  }

  const allowedConsistency = allowedConsistencyForMode(input.requestedSnapshot.mode);
  if (!allowedConsistency.includes(actualConsistency)) {
    mismatchReasons.push("CONSISTENCY_LEVEL_TOO_WEAK");
  }

  const advancedCompatible = mismatchReasons.length === 0 &&
    input.requestedSnapshot.mode === "BEST_EFFORT" &&
    Number.isFinite(actualTime) &&
    Number.isFinite(expectedTime) &&
    actualTime > expectedTime;

  return {
    status: mismatchReasons.length > 0 ? "MISMATCHED" : advancedCompatible ? "ADVANCED_COMPATIBLE" : "MATCHED",
    expectedConsistency,
    actualConsistency,
    expectedCapturedAt,
    actualCapturedAt,
    mismatchReasons: [...new Set(mismatchReasons)],
    downgradeRequired: mismatchReasons.length > 0 && input.policy.allowDowngrade === true
  };
}

function consistencyForMode(mode: QuerySnapshotManifest["mode"]): QuerySnapshotManifest["consistency"] {
  if (mode === "PINNED") return "PINNED";
  if (mode === "BEST_EFFORT") return "BEST_EFFORT";
  return "CONSISTENT_AT_START";
}

function allowedConsistencyForMode(mode: QuerySnapshotManifest["mode"]): readonly DataSnapshotContext["consistency"][] {
  if (mode === "PINNED") return ["PINNED"];
  if (mode === "BEST_EFFORT") return ["PINNED", "CONSISTENT_AT_START", "BEST_EFFORT"];
  return ["PINNED", "CONSISTENT_AT_START"];
}
