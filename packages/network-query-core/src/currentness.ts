import type { RoutingSnapshot } from "./types.js";

export type CurrentnessDimension = "CURRENT" | "STALE" | "UNKNOWN" | "NOT_APPLICABLE";
export type RoutingSnapshotCurrentness = "CURRENT" | "STALE" | "UNKNOWN" | "UNAVAILABLE";
export type StaleDimension = "GRAPH" | "TRAVEL_PROFILE" | "COST_PROFILE" | "CONDITION" | "SOURCE_WORLD";

export interface RoutingSnapshotCurrentnessResult {
  schemaVersion: "1.0";
  requestedSnapshot: RoutingSnapshot;
  currentSnapshot?: RoutingSnapshot;
  currentness: RoutingSnapshotCurrentness;
  dimensions: {
    graph: CurrentnessDimension;
    travelProfile: CurrentnessDimension;
    costProfile: CurrentnessDimension;
    condition: CurrentnessDimension;
    sourceWorld: CurrentnessDimension;
  };
  staleDimensions: StaleDimension[];
  reasons: string[];
  evaluatedAt: string;
}

/** Separates immutable plan validity from the current state of its routing inputs. */
export class RoutingSnapshotCurrentnessEvaluator {
  evaluate(requested: RoutingSnapshot, current: RoutingSnapshot | undefined, evaluatedAt = new Date().toISOString()): RoutingSnapshotCurrentnessResult {
    if (current === undefined) {
      return {
        schemaVersion: "1.0", requestedSnapshot: structuredClone(requested), currentness: "UNAVAILABLE",
        dimensions: { graph: "UNKNOWN", travelProfile: "UNKNOWN", costProfile: "UNKNOWN", condition: "UNKNOWN", sourceWorld: requested.sourceWorldVersion === undefined ? "NOT_APPLICABLE" : "UNKNOWN" },
        staleDimensions: [], reasons: ["Current routing authority is unavailable"], evaluatedAt
      };
    }
    const dimensions: RoutingSnapshotCurrentnessResult["dimensions"] = {
      graph: equal(requested.graphVersion, current.graphVersion) && equal(requested.graphContentHash, current.graphContentHash) ? "CURRENT" : "STALE",
      travelProfile: equal(requested.travelProfileVersion, current.travelProfileVersion) ? "CURRENT" : "STALE",
      costProfile: equal(requested.costProfileVersion, current.costProfileVersion) && equal(requested.costContentHash, current.costContentHash) ? "CURRENT" : "STALE",
      condition: optionalDimension(requested.conditionSnapshotId, current.conditionSnapshotId, requested.conditionContentHash, current.conditionContentHash),
      sourceWorld: requested.sourceWorldVersion === undefined ? "NOT_APPLICABLE" : current.sourceWorldVersion === undefined ? "UNKNOWN" : requested.sourceWorldVersion === current.sourceWorldVersion ? "CURRENT" : "STALE"
    };
    const mapping = [
      ["GRAPH", dimensions.graph], ["TRAVEL_PROFILE", dimensions.travelProfile], ["COST_PROFILE", dimensions.costProfile],
      ["CONDITION", dimensions.condition], ["SOURCE_WORLD", dimensions.sourceWorld]
    ] as const;
    const staleDimensions = mapping.filter(([, status]) => status === "STALE").map(([name]) => name);
    const unknown = mapping.filter(([, status]) => status === "UNKNOWN").map(([name]) => name);
    const currentness = staleDimensions.length > 0 ? "STALE" : unknown.length > 0 ? "UNKNOWN" : "CURRENT";
    return {
      schemaVersion: "1.0", requestedSnapshot: structuredClone(requested), currentSnapshot: structuredClone(current), currentness,
      dimensions, staleDimensions,
      reasons: [...staleDimensions.map((name) => `${name} changed since the plan snapshot`), ...unknown.map((name) => `${name} currentness is unknown`)], evaluatedAt
    };
  }

  planValidation(planValidity: "VALID" | "INVALID" | "UNKNOWN", currentness: RoutingSnapshotCurrentnessResult, verificationRef?: string) {
    return {
      schemaVersion: "1.0" as const,
      planValidity,
      currentness: currentness.currentness,
      usable: planValidity === "INVALID" ? "NO" as const : planValidity === "UNKNOWN" || currentness.currentness !== "CURRENT" ? "REVALIDATE" as const : "YES" as const,
      staleDimensions: currentness.staleDimensions,
      reasons: [...(planValidity === "INVALID" ? ["Frozen plan verification failed"] : []), ...currentness.reasons],
      ...(verificationRef === undefined ? {} : { verificationRef }),
      currentnessResult: withoutInternalDimensions(currentness)
    };
  }
}

function optionalDimension(requestedId: string | undefined, currentId: string | undefined, requestedHash: string | undefined, currentHash: string | undefined): CurrentnessDimension {
  if (requestedId === undefined && currentId === undefined) return "NOT_APPLICABLE";
  if (currentId === undefined) return "UNKNOWN";
  return requestedId === currentId && (requestedHash === undefined || requestedHash === currentHash) ? "CURRENT" : "STALE";
}
function equal(left: string, right: string): boolean { return left === right; }
function withoutInternalDimensions(value: RoutingSnapshotCurrentnessResult): Omit<RoutingSnapshotCurrentnessResult, "staleDimensions"> {
  const { staleDimensions: _staleDimensions, ...contract } = value;
  return contract;
}
