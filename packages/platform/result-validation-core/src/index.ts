import { canonicalSha256 } from "../../contract-runtime/src/index.js";

export type NormalizedResultStatus = "COMPLETED" | "PARTIAL" | "NO_DATA" | "AMBIGUOUS" | "INDETERMINATE" | "NO_FEASIBLE_RESULT" | "STALE" | "FAILED";

export type ReferenceKey = { namespace: "gowm"; kind: string; id: string; version: string };
export type SnapshotResource = { referenceKey?: ReferenceKey; resourceKind: string; resourceId: string; version: string; contentHash?: string; worldVersion?: number };
export type DataSnapshotManifest = { schemaVersion: "1.0"; snapshotId: string; consistency: "PINNED" | "CONSISTENT_AT_START" | "BEST_EFFORT"; resources: SnapshotResource[]; capturedAt?: string; snapshotHash: string };

export interface ReferenceRecord {
  referenceKey: ReferenceKey;
  sourceStatus: string;
  sourceAuthority: string;
  available: boolean;
  retired?: boolean;
  validUntil?: string;
  lastUpdatedAt?: string;
  snapshotStatus?: "CURRENT" | "STALE" | "UNKNOWN" | "NOT_APPLICABLE";
  validationEvidenceRefs?: string[];
}

export function normalizeResultStatus(sourceStatus: string, mapping: Readonly<Record<string, NormalizedResultStatus>>): NormalizedResultStatus {
  return mapping[sourceStatus] ?? "INDETERMINATE";
}

export function validateReferenceRecord(
  record: ReferenceRecord | undefined,
  request: { referenceKey: ReferenceKey; maximumAgeMs?: number; requireCurrentSnapshot?: boolean },
  mapping: Readonly<Record<string, NormalizedResultStatus>>,
  now = new Date()
): Record<string, unknown> {
  if (record === undefined) return {
    schemaVersion: "1.0", referenceKey: request.referenceKey, existence: "NOT_FOUND", freshness: "UNKNOWN",
    snapshot: "UNKNOWN", usable: "NO", reasons: ["Reference is unavailable in the authorized scope"]
  };
  const expired = record.validUntil !== undefined && Date.parse(record.validUntil) <= now.getTime();
  const maximumAgeExceeded = request.maximumAgeMs !== undefined && (record.lastUpdatedAt === undefined || now.getTime() - Date.parse(record.lastUpdatedAt) > request.maximumAgeMs);
  const snapshot = record.snapshotStatus ?? "NOT_APPLICABLE";
  const existence = record.retired ? "RETIRED" : record.available ? "AVAILABLE" : "NOT_FOUND";
  const freshness = expired ? "EXPIRED" : maximumAgeExceeded || snapshot === "STALE" ? "STALE" : "CURRENT";
  const usable = existence !== "AVAILABLE" || expired ? "NO" : maximumAgeExceeded || request.requireCurrentSnapshot === true && snapshot !== "CURRENT" ? "REVALIDATE" : snapshot === "STALE" || snapshot === "UNKNOWN" ? "REVALIDATE" : "YES";
  const reasons = [
    ...(record.retired ? ["Reference is retired"] : []),
    ...(expired ? ["Reference TTL expired"] : []),
    ...(maximumAgeExceeded ? ["Reference exceeds requested maximum age"] : []),
    ...(snapshot === "STALE" ? ["Pinned data snapshot is stale"] : []),
    ...(snapshot === "UNKNOWN" ? ["Snapshot currentness is unknown"] : [])
  ];
  return {
    schemaVersion: "1.0", referenceKey: record.referenceKey, existence, freshness, snapshot, usable, reasons,
    resultSemantics: { schemaVersion: "1.0", normalizedStatus: normalizeResultStatus(record.sourceStatus, mapping), sourceStatus: record.sourceStatus, sourceAuthority: record.sourceAuthority, reasons },
    ...(record.validationEvidenceRefs === undefined ? {} : { validationEvidenceRefs: record.validationEvidenceRefs })
  };
}

export function createDataSnapshot(
  consistency: DataSnapshotManifest["consistency"],
  resources: readonly SnapshotResource[],
  capturedAt = new Date().toISOString()
): DataSnapshotManifest {
  const ordered = [...resources].map((item) => structuredClone(item)).sort((left, right) => `${left.resourceKind}\u0000${left.resourceId}\u0000${left.version}`.localeCompare(`${right.resourceKind}\u0000${right.resourceId}\u0000${right.version}`));
  const identity = { consistency, resources: ordered };
  return { schemaVersion: "1.0", snapshotId: canonicalSha256(identity), consistency, resources: ordered, capturedAt, snapshotHash: canonicalSha256(identity) };
}

export function validateDataSnapshot(
  manifest: DataSnapshotManifest,
  current: ReadonlyMap<string, SnapshotResource | "UNAVAILABLE">,
  evaluatedAt = new Date().toISOString()
): Record<string, unknown> {
  const expected = createDataSnapshot(manifest.consistency, manifest.resources, manifest.capturedAt ?? evaluatedAt);
  if (manifest.snapshotHash !== expected.snapshotHash || manifest.snapshotId !== expected.snapshotId) {
    return {
      schemaVersion: "1.0", snapshotId: manifest.snapshotId, status: "STALE",
      resourceResults: manifest.resources.map((resource) => ({ resourceKind: resource.resourceKind, resourceId: resource.resourceId, status: "STALE", reason: "Snapshot identity or manifest hash is invalid" })),
      evaluatedAt
    };
  }
  const resourceResults = manifest.resources.map((requested) => {
    const key = `${requested.resourceKind}\u0000${requested.resourceId}`;
    const actual = current.get(key);
    if (actual === "UNAVAILABLE") return { resourceKind: requested.resourceKind, resourceId: requested.resourceId, status: "UNAVAILABLE", reason: "Current resource authority is unavailable" };
    if (actual === undefined) return { resourceKind: requested.resourceKind, resourceId: requested.resourceId, status: "UNKNOWN", reason: "Current resource version is unknown" };
    const stale = actual.version !== requested.version || requested.contentHash !== undefined && actual.contentHash !== requested.contentHash || requested.worldVersion !== undefined && actual.worldVersion !== requested.worldVersion;
    return { resourceKind: requested.resourceKind, resourceId: requested.resourceId, status: stale ? "STALE" : "CURRENT", currentVersion: actual.version, ...(actual.contentHash === undefined ? {} : { currentContentHash: actual.contentHash }), ...(stale ? { reason: "Resource version, content hash, or world version changed" } : {}) };
  });
  const statuses = resourceResults.map((item) => item.status);
  const status = statuses.includes("UNAVAILABLE") ? "UNAVAILABLE" : statuses.includes("STALE") ? "STALE" : statuses.includes("UNKNOWN") ? "UNKNOWN" : "CURRENT";
  return { schemaVersion: "1.0", snapshotId: manifest.snapshotId, status, resourceResults, evaluatedAt };
}
