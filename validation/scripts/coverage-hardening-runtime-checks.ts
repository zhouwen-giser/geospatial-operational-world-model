import type { Pool } from "pg";
import { canonicalSha256, type GowmV06CoverageProblem, type GowmV06CoverageRoute } from "../../packages/platform/contract-runtime/src/index.js";
import { verifyCoverageRoute } from "../../packages/road-coverage-verifier-core/src/index.js";
import type { LoadedNetwork, NetworkRepository } from "../../packages/network-query-core/src/index.js";

type Row = Record<string, unknown>;
type Check = (name: string, passed: boolean, details?: unknown) => void;
type Plan = (label: string, request: Row) => Promise<Row>;

/** All geometry and plan inputs below are read by the real scoped PostgreSQL contracts. */
export async function coverageHardeningCases(options: {
  admin: Pool; network: NetworkRepository; loaded: LoadedNetwork;
  scope: { dataScopeKey: string; datasetScopeKey: string };
  request: Row; problem: GowmV06CoverageProblem; route: GowmV06CoverageRoute;
  plan: Plan; check: Check;
}): Promise<void> {
  const { admin, network, loaded, scope, request, problem, route, plan, check } = options;
  const snapshot = loaded.routingSnapshot;
  const arcKey = `arc_${"2".repeat(64)}`;
  const strip = polygon(0.001, 0.002);
  const multi = { type: "MultiPolygon", coordinates: [polygon(0.0005, 0.001).coordinates, polygon(0.002, 0.0025).coordinates] };
  const arcs = loaded.arcs.map((arc) => ({ graphVersion: snapshot.graphVersion, arcKey: arc.key, fromNodeKey: arc.source, toNodeKey: arc.target, direction: arc.direction,
    metrics: { distanceMm: arc.distanceMm, durationMs: arc.durationMs, riskMicroUnits: arc.riskMicroUnits, energyMwh: arc.energyMwh, combinedCostUnits: arc.combinedCostUnits, turnPenaltyUnits: 0 }, conditionPenaltyUnits: arc.conditionPenaltyUnits }));
  const boundaryCase = async (label: string, area: Row, policy: GowmV06CoverageProblem["boundaryCrossingPolicy"], expected: boolean, start = 0, mode: "normal" | "allowed" | "last" | "wrong-last" = "normal") => {
    const segments = [{ ...route.segments[0]!, sequence: 1, arcKey, startFractionPpm: start, endFractionPpm: 1_000_000 }];
    const authority = await network.routeBoundaryCrossings(snapshot, area, segments as Row[], scope, 10_000);
    const states = authority.crossings.map((event) => ({ arcKey: event.state.arcKey, fractionPpm: event.state.fractionPpm, direction: event.state.direction }));
    const endIndex = authority.crossings.findLastIndex((event) => event.kind === "EXIT");
    const end = states[endIndex];
    const candidate = { ...route, segments, boundaryEvents: [], ...(mode === "last" && end ? { endState: end } : {}) };
    const { routeSignature: _old, ...body } = candidate;
    const report = verifyCoverageRoute({
      problem: { ...problem, boundaryCrossingPolicy: policy, ...(mode.includes("last") ? { endpointMode: "LAST_AREA_EXIT" } : {}), entryStates: mode === "allowed" ? states.filter((_, index) => authority.crossings[index]!.kind === "ENTRY") : [] },
      candidate: { ...body, routeSignature: canonicalSha256(body) }, currentRoutingSnapshot: snapshot, networkArcs: arcs,
      objective: "BALANCED", travelPolicy: { profileKey: snapshot.travelProfileVersion },
      authoritativeBoundaryEvents: authority.crossings, boundaryStartInside: authority.startInside
    });
    // This matrix isolates the boundary predicate; complete route validity is tested by the Gateway plan/verify gate.
    check(label, report.checks.boundary === expected, { crossings: authority.crossings, startInside: authority.startInside, boundary: report.checks.boundary });
  };
  await boundaryCase("boundaryPolicyFree", multi, "FREE", true);
  await boundaryCase("boundaryFirstOutsideOneEntry", strip, "FIRST_ENTRY_ONLY", true);
  await boundaryCase("boundaryFirstOutsideZeroEntry", polygon(1, 2), "FIRST_ENTRY_ONLY", false);
  await boundaryCase("boundaryFirstOutsideTwoEntries", multi, "FIRST_ENTRY_ONLY", false);
  await boundaryCase("boundaryFirstInsideNoEntry", polygon(-1, 1), "FIRST_ENTRY_ONLY", true);
  await boundaryCase("boundaryFirstInsideReentry", multi, "FIRST_ENTRY_ONLY", false, 250_000);
  await boundaryCase("boundaryEntrySetAllowed", strip, "ENTRY_SET_ONLY", true, 0, "allowed");
  await boundaryCase("boundaryEntrySetDenied", strip, "ENTRY_SET_ONLY", false);
  await boundaryCase("boundaryNoReentryIgnoresCandidateHints", multi, "NO_REENTRY", false);
  await boundaryCase("boundaryLastAreaExitValid", strip, "FREE", true, 0, "last");
  await boundaryCase("boundaryLastAreaExitWrongTerminal", strip, "FREE", false, 0, "wrong-last");

  const single = { requestedCount: 1, minimumVerifiedCount: 1, profiles: ["SHORTEST_TOTAL_DISTANCE"], maximumWeightedArcOverlapPpm: 1_000_000, minimumDeadheadJaccardDistancePpm: 0 };
  const onePlan = (label: string, patch: Row = {}) => plan(label, { ...request, alternativePolicy: single, ...patch });
  const firstArc = (result: Row) => String(((result.alternatives as Row[])[0]!.route as GowmV06CoverageRoute).segments[0]?.arcKey);
  for (const [profile, expectedArc] of [["SHORTEST_TOTAL_DISTANCE", "2"], ["FASTEST_COMPLETION", "3"], ["LOWEST_RISK", "3"], ["LEAST_DEADHEAD", "2"]]) {
    const result = await onePlan(`objective-${profile}`, { objective: { profile } });
    check(`objective-${profile}`, result.status === "SUCCEEDED" && firstArc(result) === `arc_${expectedArc!.repeat(64)}`, result);
    check(`objective-primary-${profile}`, (result.alternatives as Row[])[0]?.objectiveProfile === profile, result);
  }
  for (const [dimension, expectedArc] of [["distance", "2"], ["duration", "3"], ["risk", "3"], ["deadhead", "2"]]) {
    const weights = { distance: 0, duration: 0, risk: 0, deadhead: 0, [dimension!]: 1_000_000 };
    const result = await onePlan(`weighted-${dimension}`, { objective: { profile: "WEIGHTED", weights } });
    check(`objective-weighted-${dimension}`, result.status === "SUCCEEDED" && firstArc(result) === `arc_${expectedArc!.repeat(64)}`, result);
    const repeat = await onePlan(`weighted-${dimension}-replay`, { objective: { profile: "WEIGHTED", weights } });
    check(`objective-replay-${dimension}`, ((result.alternatives as Row[])[0]!.route as Row).routeSignature === ((repeat.alternatives as Row[])[0]!.route as Row).routeSignature, { result, repeat });
  }
  const noFeasible = async (label: string, patch: Row) => {
    const result = await onePlan(label, patch);
    check(label, result.status === "NO_FEASIBLE_PLAN" && (result.alternatives as unknown[]).length === 0 && (result.receipts as Row[]).some((receipt) => receipt.kind === "NO_FEASIBLE_RESULT" && (receipt.reasons as unknown[]).length > 0), result);
    const persisted = await admin.query("SELECT result_record->>'status' AS source_status,status FROM world_query_result_reference WHERE reference_key=$1", [(result.referenceKey as Row).id]);
    check(`${label}-registry`, persisted.rows[0]?.source_status === "NO_FEASIBLE_PLAN" && persisted.rows[0]?.status === "NO_FEASIBLE_RESULT", persisted.rows);
  };
  await noFeasible("noFeasibleEndpoint", { endpointPolicy: { ...(request.endpointPolicy as Row), endpointMode: "FIXED_END", fixedEnd: { arcKey: `arc_${"1".repeat(64)}`, fractionPpm: 0, direction: "FORWARD" } } });
  for (const [label, closed] of [["noFeasibleDisconnected", ["2", "3"]], ["noFeasibleCondition", ["5"]]] as const) {
    const hash = canonicalSha256({ label });
    const condition = await admin.query(`INSERT INTO network_condition_snapshot(graph_version_id,data_scope_key,condition_snapshot_key,source_snapshot_version,observed_at,valid_until,completeness,source_content_hash,content_hash)
      VALUES ($1::uuid,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '1 hour','COMPLETE',$5,$5) RETURNING condition_snapshot_id::text AS id`, [loaded.graph.graph_version_id, scope.dataScopeKey, `cs_${hash.slice(7)}`, label, hash]);
    const id = condition.rows[0].id;
    await admin.query(`INSERT INTO network_arc_condition(condition_snapshot_id,graph_version_id,arc_id,data_scope_key,traversal_allowed,content_hash)
      SELECT $1::uuid,graph_version_id,arc_id,data_scope_key,false,$2 FROM network_arc WHERE graph_version_id=$3::uuid AND arc_key=ANY($4::text[])`, [id, hash, loaded.graph.graph_version_id, closed.map((hex) => `ar_${hex.repeat(64)}`)]);
    await noFeasible(label, { routingSnapshot: { ...snapshot, conditionSnapshotId: id, conditionContentHash: hash } });
  }
  await admin.query(`INSERT INTO network_travel_profile_version(travel_profile_id,data_scope_key,version,mode,required_access_mask,maximum_speed_mm_per_s,content_hash)
    SELECT travel_profile_id,data_scope_key,'travel-excluded','SERVICE',2,100000,$2 FROM network_travel_profile WHERE data_scope_key=$1`, [scope.dataScopeKey, canonicalSha256({ profile: "excluded" })]);
  const excludedHash = canonicalSha256({ cost: "excluded" });
  await admin.query(`INSERT INTO network_cost_profile_version(cost_profile_id,travel_profile_id,travel_profile_version_id,data_scope_key,version,distance_weight_ppm,duration_weight_ppm,risk_weight_ppm,energy_weight_ppm,content_hash)
    SELECT cost.cost_profile_id,cost.travel_profile_id,travel.travel_profile_version_id,cost.data_scope_key,'cost-excluded',0,1000000,0,0,$2 FROM network_cost_profile cost JOIN network_travel_profile_version travel USING(travel_profile_id,data_scope_key) WHERE travel.version='travel-excluded' AND cost.data_scope_key=$1`, [scope.dataScopeKey, excludedHash]);
  await admin.query(`INSERT INTO network_arc_cost(graph_version_id,arc_id,travel_profile_version_id,cost_profile_version_id,data_scope_key,distance_mm,duration_ms,risk_microunits,energy_millijoules,combined_cost_units,content_hash)
    SELECT original.graph_version_id,original.arc_id,cost.travel_profile_version_id,cost.cost_profile_version_id,original.data_scope_key,original.distance_mm,original.duration_ms,original.risk_microunits,original.energy_millijoules,original.combined_cost_units,original.content_hash FROM network_arc_cost original JOIN network_cost_profile_version cost USING(data_scope_key) JOIN network_cost_profile_version old ON old.cost_profile_version_id=original.cost_profile_version_id WHERE cost.version='cost-excluded' AND old.version='cost-v1' AND original.data_scope_key=$1`, [scope.dataScopeKey]);
  await noFeasible("noFeasibleProfile", { routingSnapshot: { ...snapshot, travelProfileVersion: "travel-excluded", costProfileVersion: "cost-excluded", costContentHash: excludedHash } });
  await admin.query(`INSERT INTO network_turn_rule(graph_version_id,data_scope_key,rule_key,from_arc_id,via_node_id,to_arc_id,rule_type,content_hash)
    SELECT incoming.graph_version_id,incoming.data_scope_key,'tr_'||encode(digest(incoming.arc_key||':hardening','sha256'),'hex'),incoming.arc_id,incoming.target_node_id,service.arc_id,'FORBIDDEN',$2 FROM network_arc incoming JOIN network_arc service ON service.graph_version_id=incoming.graph_version_id AND service.source_node_id=incoming.target_node_id WHERE service.arc_key='ar_'||repeat('5',64) AND incoming.data_scope_key=$1`, [scope.dataScopeKey, canonicalSha256({ turns: "blocked" })]);
  await noFeasible("noFeasibleTurn", {});
}

function polygon(left: number, right: number) {
  return { type: "Polygon", coordinates: [[[left, -0.0001], [right, -0.0001], [right, 0.0001], [left, 0.0001], [left, -0.0001]]] };
}
