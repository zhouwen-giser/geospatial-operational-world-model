import { canonicalSha256, type CapabilityDescriptor } from "../../../../packages/platform/contract-runtime/src/index.js";

export type NormalizedResultStatus = "COMPLETED" | "PARTIAL" | "NO_DATA" | "AMBIGUOUS" | "INDETERMINATE" | "NO_FEASIBLE_RESULT" | "STALE" | "FAILED";

export interface CapabilitySemanticProfile {
  operationId: string;
  operationVersion: string;
  domain: "REFERENCE" | "CATALOG" | "WORLD_STATE" | "SPATIAL" | "TEMPORAL" | "H3" | "NETWORK" | "ROUTING" | "COVERAGE" | "ANALYSIS" | "PLATFORM";
  acceptedReferenceKinds: string[];
  producedReferenceKinds: string[];
  relationSemantics: string[];
  spatialSemantics: "EXACT" | "CANDIDATE" | "AGGREGATED" | "NONE";
  timeSemantics: "CURRENT" | "HISTORICAL" | "INTERVAL" | "SNAPSHOT" | "NONE";
  resultNature: "FACT" | "PROJECTION" | "DERIVED" | "PLAN" | "VALIDATION" | "CATALOG";
  negativeEvidencePolicy: "SUPPORTED" | "NOT_SUPPORTED" | "NO_DATA_IS_UNKNOWN" | "NOT_APPLICABLE";
  freshnessSemantics: "NONE" | "TTL" | "WORLD_VERSION" | "SNAPSHOT_CURRENTNESS";
  domainStatusPath?: string;
  domainStatusMapping?: Record<string, NormalizedResultStatus>;
  exactVerificationOperation?: string;
  notes?: string[];
}

export interface CapabilitySemanticCatalog {
  schemaVersion: "1.0";
  registryRevision: string;
  profiles: CapabilitySemanticProfile[];
  catalogHash: `sha256:${string}`;
}

const STATUS_PLAN: Record<string, NormalizedResultStatus> = {
  SUCCEEDED: "COMPLETED", COMPLETED: "COMPLETED", PARTIAL: "PARTIAL",
  NO_PATH: "NO_FEASIBLE_RESULT", NO_FEASIBLE_PLAN: "NO_FEASIBLE_RESULT",
  STALE: "STALE", FAILED: "FAILED"
};

const OVERRIDES: Readonly<Record<string, Partial<CapabilitySemanticProfile>>> = {
  "reference.resolve@1.0": { domain: "REFERENCE", producedReferenceKinds: ["WORLD_OBJECT", "LAYER_FEATURE", "DATASET", "LAYER", "OPERATIONAL_TASK"], timeSemantics: "CURRENT", resultNature: "VALIDATION", freshnessSemantics: "WORLD_VERSION", domainStatusPath: "/resolutions/*/status", domainStatusMapping: { RESOLVED_EXACT: "COMPLETED", SUGGESTED_UNIQUE: "COMPLETED", AMBIGUOUS: "AMBIGUOUS", UNRESOLVED: "NO_DATA", INVALID: "FAILED" } },
  "world.get-current-state@1.0": { domain: "WORLD_STATE", acceptedReferenceKinds: ["WORLD_OBJECT", "OPERATIONAL_TASK"], spatialSemantics: "EXACT", timeSemantics: "CURRENT", resultNature: "FACT", freshnessSemantics: "WORLD_VERSION" },
  "spatial.find-in-area@1.0": { domain: "SPATIAL", acceptedReferenceKinds: ["WORLD_OBJECT", "LAYER_FEATURE", "DERIVED_REFERENCE"], producedReferenceKinds: ["REFERENCE_SET"], relationSemantics: ["INSIDE"], spatialSemantics: "EXACT", timeSemantics: "SNAPSHOT", freshnessSemantics: "SNAPSHOT_CURRENTNESS" },
  "h3.geometry.cover@1.0": { domain: "H3", acceptedReferenceKinds: ["LAYER_FEATURE", "DERIVED_REFERENCE"], relationSemantics: ["CANDIDATE_COVER"], spatialSemantics: "CANDIDATE", negativeEvidencePolicy: "NOT_APPLICABLE", freshnessSemantics: "NONE", exactVerificationOperation: "spatial.find-intersections", notes: ["H3 cover is candidate-only and cannot prove exact containment."] },
  "network.snap.point@1.0": { domain: "NETWORK", acceptedReferenceKinds: ["LAYER_FEATURE"], relationSemantics: ["SNAPPED_TO_NETWORK"], spatialSemantics: "EXACT", timeSemantics: "SNAPSHOT", freshnessSemantics: "SNAPSHOT_CURRENTNESS", domainStatusPath: "/status", domainStatusMapping: { RESOLVED_UNIQUE: "COMPLETED", AMBIGUOUS: "AMBIGUOUS", UNREACHABLE: "NO_FEASIBLE_RESULT" } },
  "route.plan@1.0": { domain: "ROUTING", acceptedReferenceKinds: ["WORLD_OBJECT", "LAYER_FEATURE", "DERIVED_REFERENCE"], producedReferenceKinds: ["QUERY_RESULT", "DERIVED_REFERENCE"], relationSemantics: ["ROUTE_BETWEEN"], spatialSemantics: "EXACT", timeSemantics: "SNAPSHOT", resultNature: "PLAN", freshnessSemantics: "SNAPSHOT_CURRENTNESS", domainStatusPath: "/status", domainStatusMapping: STATUS_PLAN },
  "coverage.road.plan@1.0": { domain: "COVERAGE", acceptedReferenceKinds: ["LAYER_FEATURE", "DERIVED_REFERENCE"], producedReferenceKinds: ["QUERY_RESULT", "DERIVED_REFERENCE"], relationSemantics: ["ROAD_COVERAGE_PLAN"], spatialSemantics: "EXACT", timeSemantics: "SNAPSHOT", resultNature: "PLAN", freshnessSemantics: "SNAPSHOT_CURRENTNESS", domainStatusPath: "/status", domainStatusMapping: STATUS_PLAN },
  "result.validate@1.0": { domain: "PLATFORM", acceptedReferenceKinds: ["QUERY_RESULT", "DERIVED_REFERENCE", "REFERENCE_SET"], relationSemantics: ["VALIDATES"], timeSemantics: "CURRENT", resultNature: "VALIDATION", negativeEvidencePolicy: "NOT_APPLICABLE", freshnessSemantics: "SNAPSHOT_CURRENTNESS" },
  "snapshot.validate@1.0": { domain: "PLATFORM", relationSemantics: ["VALIDATES_SNAPSHOT"], timeSemantics: "CURRENT", resultNature: "VALIDATION", negativeEvidencePolicy: "NOT_APPLICABLE", freshnessSemantics: "SNAPSHOT_CURRENTNESS" },
  "catalog.search@1.0": { domain: "CATALOG", producedReferenceKinds: ["DATASET", "LAYER"], relationSemantics: ["DISCOVERS_DATA_PRODUCT"], spatialSemantics: "EXACT", timeSemantics: "INTERVAL", resultNature: "CATALOG", freshnessSemantics: "WORLD_VERSION" }
};

export function projectCapabilitySemantics(descriptors: readonly CapabilityDescriptor[], registryRevision: string): CapabilitySemanticCatalog {
  const profiles = descriptors.map(profileFor).sort((left, right) => `${left.operationId}@${left.operationVersion}`.localeCompare(`${right.operationId}@${right.operationVersion}`));
  const body = { schemaVersion: "1.0" as const, registryRevision, profiles };
  return { ...body, catalogHash: canonicalSha256(body) };
}

function profileFor(descriptor: CapabilityDescriptor): CapabilitySemanticProfile {
  const id = descriptor.operationId;
  const validation = descriptor.resultSemantics === "VALIDATION";
  const base: CapabilitySemanticProfile = {
    operationId: id,
    operationVersion: descriptor.operationVersion,
    domain: domain(id),
    acceptedReferenceKinds: [],
    producedReferenceKinds: [],
    relationSemantics: [],
    spatialSemantics: id.startsWith("spatial.") ? "EXACT" : id.startsWith("h3.") ? "CANDIDATE" : "NONE",
    timeSemantics: descriptor.dataBinding === "WORLD_SNAPSHOT_BOUND" ? "SNAPSHOT" : "NONE",
    resultNature: validation ? "VALIDATION" : descriptor.resultSemantics === "DATA_QUERY" ? "FACT" : "DERIVED",
    negativeEvidencePolicy: validation ? "NOT_APPLICABLE" : "NO_DATA_IS_UNKNOWN",
    freshnessSemantics: descriptor.snapshotPolicy.dataSnapshot === "REQUIRED" ? "SNAPSHOT_CURRENTNESS" : "NONE"
  };
  return { ...base, ...OVERRIDES[`${id}@${descriptor.operationVersion}`] };
}

function domain(id: string): CapabilitySemanticProfile["domain"] {
  if (id.startsWith("reference.")) return "REFERENCE";
  if (id.startsWith("catalog.")) return "CATALOG";
  if (id.startsWith("world.")) return "WORLD_STATE";
  if (id.startsWith("spatial.")) return "SPATIAL";
  if (id.startsWith("h3.")) return "H3";
  if (id.startsWith("network.")) return "NETWORK";
  if (id.startsWith("route.")) return "ROUTING";
  if (id.startsWith("coverage.")) return "COVERAGE";
  if (id === "result.validate" || id.startsWith("snapshot.")) return "PLATFORM";
  return "ANALYSIS";
}
