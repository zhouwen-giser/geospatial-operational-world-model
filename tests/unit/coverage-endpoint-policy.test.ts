import { describe, expect, it } from "vitest";

import {
  resolveCoverageEndpoints,
  verifyEndpointAndBoundaryPolicy
} from "../../packages/road-coverage-planning-core/src/index.js";
import type {
  BoundaryEvent,
  CoverageEndpointPolicy,
  CoverageEndpointRepository,
  DirectedState,
  EndpointCandidate,
  GeoJsonArea,
  NetworkLocation
} from "../../packages/road-coverage-planning-core/src/index.js";

const snapshot = {
  networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}`
} as const;
const area: GeoJsonArea = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
const scope = { dataScopeKey: "scope-a", datasetScopeKey: "tenant-a" };
const state = (hex: string, fractionPpm: number, direction: "FORWARD" | "REVERSE" = "FORWARD"): DirectedState => ({
  arcKey: `arc_${hex.repeat(64)}`, fractionPpm, direction
});
const candidate = (value: DirectedState, distanceMm = 0): EndpointCandidate => ({
  state: value, distanceMm, evidence: { method: "FIXTURE", arcKey: value.arcKey, fractionPpm: value.fractionPpm }
});

class FixtureEndpoints implements CoverageEndpointRepository {
  constructor(
    readonly locations = new Map<string, EndpointCandidate[]>(),
    readonly entries: EndpointCandidate[] = [],
    readonly exits: EndpointCandidate[] = []
  ) {}
  async resolveLocation(location: NetworkLocation): Promise<EndpointCandidate[]> {
    if ("arcKey" in location) return [candidate(location)];
    return structuredClone(this.locations.get(JSON.stringify(location)) ?? []);
  }
  async boundaryCandidates(
    _area: GeoJsonArea,
    _snapshot: typeof snapshot,
    _dataScopeKey: string,
    _datasetScopeKey: string,
    kind: "ENTRY" | "EXIT",
    maximum: number
  ): Promise<EndpointCandidate[]> {
    return structuredClone((kind === "ENTRY" ? this.entries : this.exits).slice(0, maximum));
  }
}

function policy(overrides: Partial<CoverageEndpointPolicy> = {}): CoverageEndpointPolicy {
  return {
    start: state("a", 250_000),
    entry: { mode: "AUTO", maximumCandidates: 8 },
    exit: { mode: "AUTO", maximumCandidates: 8 },
    endpointMode: "RETURN_TO_START",
    boundaryCrossingPolicy: "FREE",
    snapToleranceMm: 10_000,
    ...overrides
  };
}

describe("coverage endpoint and boundary policy", () => {
  it("returns ambiguity for equal-score parallel-road start candidates", async () => {
    const coordinate = { coordinates: [0.5, 0.5] as [number, number], crs: "EPSG:4326" as const };
    const repository = new FixtureEndpoints(new Map([[JSON.stringify(coordinate), [candidate(state("a", 1), 100), candidate(state("b", 1), 100)]]]));
    await expect(resolveCoverageEndpoints(repository, { ...scope, routingSnapshot: snapshot, area, policy: policy({ start: coordinate }) }))
      .rejects.toMatchObject({ code: "AMBIGUOUS_LOCATION" });
  });

  it("preserves an exact directed partial start without creating a graph arc", async () => {
    const start = state("a", 345_678, "REVERSE");
    const resolved = await resolveCoverageEndpoints(new FixtureEndpoints(), { ...scope, routingSnapshot: snapshot, area, policy: policy({ start }) });
    expect(resolved.startState).toEqual(start);
    expect(resolved.startState.fractionPpm).toBe(345_678);
    expect(Object.keys(resolved)).not.toContain("syntheticArc");
  });

  it("bounds, deduplicates, and deterministically orders AUTO boundary candidates", async () => {
    const entries = [candidate(state("c", 3), 30), candidate(state("a", 1), 10), candidate(state("a", 1), 20), candidate(state("b", 2), 20)];
    const resolved = await resolveCoverageEndpoints(new FixtureEndpoints(new Map(), entries), {
      ...scope, routingSnapshot: snapshot, area, policy: policy({ entry: { mode: "AUTO", maximumCandidates: 3 } })
    });
    expect(resolved.entryStates.map((item) => item.arcKey)).toEqual([state("a", 1).arcKey, state("b", 2).arcKey, state("c", 3).arcKey]);
  });

  it("limits CANDIDATE_SET to supplied validated states", async () => {
    const allowed = [state("a", 10), state("b", 20)];
    const resolved = await resolveCoverageEndpoints(new FixtureEndpoints(), {
      ...scope, routingSnapshot: snapshot, area, policy: policy({ entry: { mode: "CANDIDATE_SET", maximumCandidates: 2, states: allowed } })
    });
    expect(resolved.entryStates).toEqual(allowed);
  });

  it("requires exactly one state in FIXED boundary mode", async () => {
    await expect(resolveCoverageEndpoints(new FixtureEndpoints(), {
      ...scope, routingSnapshot: snapshot, area, policy: policy({ entry: { mode: "FIXED", states: [state("a", 1), state("b", 2)] } })
    })).rejects.toMatchObject({ code: "INVALID_SELECTION_POLICY" });
  });

  it("verifies RETURN_TO_START and FIXED_END terminals exactly", async () => {
    const start = state("a", 100);
    const end = state("b", 900);
    const closed = await resolveCoverageEndpoints(new FixtureEndpoints(), { ...scope, routingSnapshot: snapshot, area, policy: policy({ start }) });
    expect(verifyEndpointAndBoundaryPolicy(closed, start, start, [])).toEqual({ valid: true, violations: [] });
    expect(verifyEndpointAndBoundaryPolicy(closed, start, end, []).violations).toContain("RETURN_TO_START_MISMATCH");
    const open = await resolveCoverageEndpoints(new FixtureEndpoints(), {
      ...scope, routingSnapshot: snapshot, area, policy: policy({ start, endpointMode: "FIXED_END", fixedEnd: end })
    });
    expect(verifyEndpointAndBoundaryPolicy(open, start, end, [])).toEqual({ valid: true, violations: [] });
  });

  it("requires LAST_AREA_EXIT to end on the final outbound event", async () => {
    const start = state("a", 0);
    const exit = state("b", 500_000);
    const resolved = await resolveCoverageEndpoints(new FixtureEndpoints(), {
      ...scope, routingSnapshot: snapshot, area, policy: policy({ start, endpointMode: "LAST_AREA_EXIT" })
    });
    const events: BoundaryEvent[] = [{ sequence: 1, kind: "ENTRY", state: start }, { sequence: 2, kind: "EXIT", state: exit }];
    expect(verifyEndpointAndBoundaryPolicy(resolved, start, exit, events).valid).toBe(true);
    expect(verifyEndpointAndBoundaryPolicy(resolved, start, start, events).violations).toContain("LAST_AREA_EXIT_MISMATCH");
  });

  it("allows legal reentry under FREE and rejects it under NO_REENTRY", async () => {
    const start = state("a", 0); const exit = state("b", 1); const reentry = state("c", 2);
    const events: BoundaryEvent[] = [
      { sequence: 1, kind: "ENTRY", state: start }, { sequence: 2, kind: "EXIT", state: exit }, { sequence: 3, kind: "ENTRY", state: reentry }
    ];
    const free = await resolveCoverageEndpoints(new FixtureEndpoints(), { ...scope, routingSnapshot: snapshot, area, policy: policy({ start }) });
    expect(verifyEndpointAndBoundaryPolicy(free, start, start, events).valid).toBe(true);
    const noReentry = { ...free, boundaryCrossingPolicy: "NO_REENTRY" as const };
    expect(verifyEndpointAndBoundaryPolicy(noReentry, start, start, events).violations).toContain("NO_REENTRY_VIOLATION");
  });

  it("enforces FIRST_ENTRY_ONLY cardinality", async () => {
    const start = state("a", 0);
    const resolved = await resolveCoverageEndpoints(new FixtureEndpoints(), {
      ...scope, routingSnapshot: snapshot, area, policy: policy({ start, boundaryCrossingPolicy: "FIRST_ENTRY_ONLY" })
    });
    const twoEntries: BoundaryEvent[] = [{ sequence: 1, kind: "ENTRY", state: start }, { sequence: 2, kind: "ENTRY", state: state("b", 0) }];
    expect(verifyEndpointAndBoundaryPolicy(resolved, start, start, twoEntries).violations).toContain("FIRST_ENTRY_ONLY_VIOLATION");
  });

  it("enforces ENTRY_SET_ONLY against the approved crossing set", async () => {
    const start = state("a", 0); const approved = state("b", 10); const foreign = state("c", 10);
    const resolved = await resolveCoverageEndpoints(new FixtureEndpoints(), {
      ...scope, routingSnapshot: snapshot, area, policy: policy({
        start, boundaryCrossingPolicy: "ENTRY_SET_ONLY", entry: { mode: "CANDIDATE_SET", states: [approved] }
      })
    });
    expect(verifyEndpointAndBoundaryPolicy(resolved, start, start, [{ sequence: 1, kind: "ENTRY", state: approved }]).valid).toBe(true);
    expect(verifyEndpointAndBoundaryPolicy(resolved, start, start, [{ sequence: 1, kind: "ENTRY", state: foreign }]).violations)
      .toContain("ENTRY_SET_ONLY_VIOLATION");
  });
});
