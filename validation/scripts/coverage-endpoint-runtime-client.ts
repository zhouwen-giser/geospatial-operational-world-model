import pg from "pg";

import {
  CoveragePlanningError,
  PostgresCoverageEndpointRepository,
  resolveCoverageEndpoints,
  verifyEndpointAndBoundaryPolicy
} from "../../packages/road-coverage-planning-core/src/index.js";
import type { BoundaryEvent, CoverageEndpointPolicy, DirectedState, GeoJsonArea } from "../../packages/road-coverage-planning-core/src/index.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const repository = new PostgresCoverageEndpointRepository(pool);
const snapshot = {
  networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}`
} as const;
const area: GeoJsonArea = { type: "Polygon", coordinates: [[[2, 4], [8, 4], [8, 6], [2, 6], [2, 4]]] };
const directed = (hex: string, fractionPpm: number, direction: "FORWARD" | "REVERSE" = "FORWARD"): DirectedState => ({
  arcKey: `arc_${hex.repeat(64)}`, fractionPpm, direction
});
const checks: Record<string, boolean> = {};
const scope = { dataScopeKey: "coverage-selection-runtime", datasetScopeKey: "tenant-a" };

function policy(overrides: Partial<CoverageEndpointPolicy> = {}): CoverageEndpointPolicy {
  return {
    start: directed("1", 250_000), entry: { mode: "AUTO", maximumCandidates: 8 }, exit: { mode: "AUTO", maximumCandidates: 8 },
    endpointMode: "RETURN_TO_START", boundaryCrossingPolicy: "FREE", snapToleranceMm: 100_000, ...overrides
  };
}
function check(name: string, condition: boolean, details?: unknown): void {
  if (!condition) throw new Error(`${name} failed${details === undefined ? "" : `: ${JSON.stringify(details)}`}`);
  checks[name] = true;
}
async function expectCode(name: string, code: string, operation: () => Promise<unknown>): Promise<void> {
  try { await operation(); } catch (error) {
    check(name, error instanceof CoveragePlanningError && error.code === code, error);
    return;
  }
  throw new Error(`${name} unexpectedly succeeded`);
}

try {
  const coordinate = { coordinates: [5, 5] as [number, number], crs: "EPSG:4326" as const };
  await expectCode("parallelRoadAmbiguity", "AMBIGUOUS_LOCATION", () => resolveCoverageEndpoints(repository, {
    ...scope, routingSnapshot: snapshot, area, policy: policy({ start: coordinate })
  }));

  const partial = directed("1", 234_567);
  const resolved = await resolveCoverageEndpoints(repository, { ...scope, routingSnapshot: snapshot, area, policy: policy({ start: partial }) });
  check("directedPartialPreserved", JSON.stringify(resolved.startState) === JSON.stringify(partial), resolved.startState);
  check("autoEntryBounded", resolved.entryStates.length === 2 && resolved.entryStates.every((state) => state.fractionPpm === 200_000), resolved.entryStates);
  check("autoExitBounded", resolved.exitStates.length === 2 && resolved.exitStates.every((state) => state.fractionPpm === 800_000), resolved.exitStates);
  check("deterministicBoundaryOrder", resolved.entryStates[0]!.arcKey < resolved.entryStates[1]!.arcKey);

  const reference = { namespace: "gowm" as const, kind: "LAYER_FEATURE" as const, id: `wrf_${"2".repeat(32)}`, version: "dataset-v1" };
  const referenceResolved = await resolveCoverageEndpoints(repository, {
    ...scope, routingSnapshot: snapshot, area, policy: policy({ start: reference })
  });
  check("referenceUniqueOneWay", referenceResolved.startState.arcKey === `arc_${"3".repeat(64)}`);

  const fixedEnd = directed("3", 900_000);
  const open = await resolveCoverageEndpoints(repository, {
    ...scope, routingSnapshot: snapshot, area,
    policy: policy({ endpointMode: "FIXED_END", fixedEnd, entry: { mode: "FIXED", states: [directed("1", 200_000)] } })
  });
  check("fixedEntryMandatory", open.entryStates.length === 1 && open.entryStates[0]?.fractionPpm === 200_000);
  check("fixedEndExact", verifyEndpointAndBoundaryPolicy(open, open.startState, fixedEnd, []).valid);

  const lastExit = { ...resolved, endpointMode: "LAST_AREA_EXIT" as const };
  const exitState = resolved.exitStates[0]!;
  const events: BoundaryEvent[] = [{ sequence: 1, kind: "ENTRY", state: resolved.entryStates[0]! }, { sequence: 2, kind: "EXIT", state: exitState }];
  check("lastExitExact", verifyEndpointAndBoundaryPolicy(lastExit, partial, exitState, events).valid);
  check("noReentry", !verifyEndpointAndBoundaryPolicy({ ...resolved, boundaryCrossingPolicy: "NO_REENTRY" }, partial, partial, [
    ...events, { sequence: 3, kind: "ENTRY", state: resolved.entryStates[1]! }
  ]).valid);
  check("entrySetOnly", !verifyEndpointAndBoundaryPolicy({ ...resolved, boundaryCrossingPolicy: "ENTRY_SET_ONLY" }, partial, partial, [
    { sequence: 1, kind: "ENTRY", state: directed("3", 100) }
  ]).valid);
  await expectCode("scopeFirst", "SCOPE_DENIED", () => resolveCoverageEndpoints(repository, {
    dataScopeKey: scope.dataScopeKey, datasetScopeKey: "foreign", routingSnapshot: snapshot, area, policy: policy()
  }));
  await expectCode("unknownDirectedState", "UNREACHABLE", () => resolveCoverageEndpoints(repository, {
    ...scope, routingSnapshot: snapshot, area, policy: policy({ start: directed("f", 10) })
  }));

  process.stdout.write(`${JSON.stringify({ status: "PASS", checks, entryCount: resolved.entryStates.length, exitCount: resolved.exitStates.length })}\n`);
} finally {
  await pool.end();
}
