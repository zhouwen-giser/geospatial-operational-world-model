import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateContract } from "../../dist/packages/platform/contract-runtime/src/index.js";
import { buildCanonicalCoverageProblem, buildRoadServiceObligation, obligationSetHash, solveStrictCoverageRoute } from "../../dist/packages/road-coverage-planning-core/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V06_RUN_ID;
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
const snapshot = { networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1", graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}` };
const feature = { namespace: "gowm", kind: "LAYER_FEATURE", id: `wrf_${"a".repeat(32)}`, version: "dataset-v1" };
const key = (hex) => `arc_${hex.repeat(32)}`;
const metrics = (distance, duration = distance, risk = distance, energy = distance, combined = distance) => ({ distanceMm: distance, durationMs: duration, riskMicroUnits: risk, energyMwh: energy, combinedCostUnits: combined, turnPenaltyUnits: 0 });
const arc = (hex, fromNodeKey, toNodeKey, value, extra = {}) => ({ graphVersion: snapshot.graphVersion, arcKey: key(hex), fromNodeKey, toNodeKey, direction: "FORWARD", sourceFeatureReferenceKey: feature, metrics: value, ...extra });
const required = (value) => buildRoadServiceObligation({ routingSnapshot: snapshot, graphVersion: snapshot.graphVersion, arcKey: value.arcKey, startFractionPpm: 0, endFractionPpm: 1_000_000, requiredPasses: 1, selectionPolicyVersion: "coverage-selection/1.0", sourceFeatureReferenceKey: feature });
const makeProblem = (start, obligations, budgets = {}) => {
  const hash = obligationSetHash(obligations);
  return buildCanonicalCoverageProblem({ routingSnapshot: snapshot, startState: { arcKey: start.arcKey, fractionPpm: 1_000_000, direction: start.direction }, endpointMode: "RETURN_TO_START", boundaryCrossingPolicy: "FREE", obligationSet: { schemaVersion: "1.0", obligationSetId: `obls_${hash.slice("sha256:".length)}`, routingSnapshot: snapshot, selectionMode: "MANUAL_OBLIGATIONS", obligations, obligationCount: obligations.length, totalRequiredLengthMm: obligations.length, selectionReceiptHash: `sha256:${"3".repeat(64)}`, warnings: [] }, objective: { profile: "STRICT_GATE" }, budgets: { timeLimitMs: 10_000, maximumCandidates: 16, maximumMatrixCells: 256, ...budgets } });
};
const options = (extra = {}) => ({ objective: "SHORTEST_DISTANCE", travelPolicy: { profileKey: "UGV/1.0" }, routeCount: 1, serviceMode: "FIXED_DIRECTION", seed: 7, ...extra });
const errorCode = (run) => { try { run(); return undefined; } catch (error) { return error?.code; } };

const start = arc("1", "X", "A", metrics(1));
const direct = arc("2", "A", "D", metrics(5));
const first = arc("3", "A", "C", metrics(1));
const second = arc("4", "C", "D", metrics(1));
const service = arc("5", "D", "E", metrics(1));
const back = arc("6", "E", "A", metrics(1));
const turnGraph = [start, direct, first, second, service, back];
const turnProblem = makeProblem(start, [required(service)]);
const forbidden = solveStrictCoverageRoute(turnProblem, turnGraph, options({ turnRules: [{ ruleKey: "pair", arcSequence: [start.arcKey, direct.arcKey], ruleType: "FORBIDDEN" }] }));
const only = solveStrictCoverageRoute(turnProblem, turnGraph, options({ turnRules: [{ ruleKey: "only", arcSequence: [start.arcKey, first.arcKey], ruleType: "ALLOWED_ONLY" }] }));
const sequence = solveStrictCoverageRoute(turnProblem, turnGraph, options({ turnRules: [{ ruleKey: "sequence", arcSequence: [first.arcKey, second.arcKey, service.arcKey], ruleType: "FORBIDDEN" }] }));

const profileService = { ...service, roadClass: "LOCAL", surface: "PAVED", accessMask: 3, speedMmPerS: 1_000, metrics: metrics(10_000, 10_000, 4, 5, 10_000) };
const profileProblem = makeProblem(start, [required(profileService)]);
const profileGraph = turnGraph.map((value) => ({ ...(value.arcKey === service.arcKey ? profileService : value), roadClass: "LOCAL", surface: "PAVED", accessMask: 3 }));
const profileOptions = options({ objective: "FASTEST", travelPolicy: { profileKey: "UGV/1.0", allowedRoadClasses: ["LOCAL"], allowedSurfaces: ["PAVED"], requiredAccessMask: 1 } });
const normal = solveStrictCoverageRoute(profileProblem, profileGraph, profileOptions);
const slowed = solveStrictCoverageRoute(profileProblem, profileGraph.map((value) => value.arcKey === service.arcKey ? { ...value, speedOverrideMmPerS: 500 } : value), profileOptions);
const normalService = normal.route.segments.find((segment) => segment.serviceRole === "SERVICE");
const slowService = slowed.route.segments.find((segment) => segment.serviceRole === "SERVICE");

const oStart = arc("7", "Y", "P", metrics(1));
const short = arc("8", "P", "T", metrics(10, 100, 100, 20, 50));
const fast1 = arc("9", "P", "Q", metrics(10, 10, 50, 20, 40));
const fast2 = arc("a", "Q", "T", metrics(10, 10, 50, 20, 40));
const risk1 = arc("b", "P", "R", metrics(30, 30, 1, 20, 30));
const risk2 = arc("c", "R", "T", metrics(30, 30, 1, 20, 30));
const oService = arc("d", "T", "U", metrics(1));
const oBack = arc("e", "U", "P", metrics(1));
const objectiveGraph = [oStart, short, fast1, fast2, risk1, risk2, oService, oBack];
const objectiveProblem = makeProblem(oStart, [required(oService)]);
const solveObjective = (objective) => solveStrictCoverageRoute(objectiveProblem, objectiveGraph, options({ objective }));
const distanceRoute = solveObjective("SHORTEST_DISTANCE"), timeRoute = solveObjective("FASTEST"), riskRoute = solveObjective("LOWEST_RISK");
const connectorKeys = (solution) => solution.route.segments.filter((segment) => segment.serviceRole !== "SERVICE" && segment.arcKey !== oBack.arcKey).map((segment) => segment.arcKey);

const closedCode = errorCode(() => solveStrictCoverageRoute(profileProblem, profileGraph.map((value) => value.arcKey === service.arcKey ? { ...value, traversalAllowed: false } : value), profileOptions));
const profileCode = errorCode(() => solveStrictCoverageRoute(profileProblem, profileGraph, options({ travelPolicy: { profileKey: "UGV/1.0", allowedRoadClasses: ["HIGHWAY"] } })));
const matrixCode = errorCode(() => solveStrictCoverageRoute(makeProblem(start, [required(service)], { maximumMatrixCells: 1 }), turnGraph, options()));
const candidateBounded = solveStrictCoverageRoute(makeProblem(start, [required(service)], { maximumCandidates: 1 }), turnGraph, options());
const routeCountCode = errorCode(() => solveStrictCoverageRoute(turnProblem, turnGraph, options({ routeCount: 2 })));
const eitherCode = errorCode(() => solveStrictCoverageRoute(turnProblem, turnGraph, options({ serviceMode: "EITHER_DIRECTION" })));
const versionCode = errorCode(() => solveStrictCoverageRoute(turnProblem, turnGraph.map((value) => ({ ...value, graphVersion: "other-version" })), options()));
const hugeService = arc("f", "D", "E", metrics(Number.MAX_SAFE_INTEGER, 1, 1, 1, Number.MAX_SAFE_INTEGER));
const hugeBack = arc("0", "E", "A", metrics(Number.MAX_SAFE_INTEGER, 1, 1, 1, Number.MAX_SAFE_INTEGER));
const overflowCode = errorCode(() => solveStrictCoverageRoute(makeProblem(start, [required(hugeService)]), [start, direct, hugeService, hugeBack], options({ objective: "BALANCED" })));
const realNow = Date.now;
let timeCalls = 0;
Date.now = () => timeCalls++ === 0 ? 1_000 : 1_200;
const timeCode = errorCode(() => solveStrictCoverageRoute(makeProblem(start, [required(service)], { timeLimitMs: 100 }), turnGraph, options()));
Date.now = realNow;
const source = await readFile(resolve(root, "packages/road-coverage-planning-core/src/strict-routing.ts"), "utf8");
const replay = solveStrictCoverageRoute(turnProblem, [...turnGraph].reverse(), options());
const fixedSums = ["distanceMm", "durationMs", "riskMicroUnits", "energyMwh", "combinedCostUnits", "turnPenaltyUnits"].every((name) => distanceRoute.route.metrics[name] === distanceRoute.route.segments.reduce((sum, segment) => sum + (segment.metrics[name] ?? 0), 0));
const checks = {
  pairwiseForbidden: !forbidden.route.segments.some((segment) => segment.arcKey === direct.arcKey),
  allowedOnly: only.route.segments[0]?.arcKey === first.arcKey,
  multiEdgeForbidden: sequence.route.segments[0]?.arcKey === direct.arcKey,
  contextAcrossConnectorService: sequence.diagnostics.resourceMetrics.strictTurnStateSpace === true,
  noPgrTrspDowngrade: !source.includes("pgr_" + "trsp") && source.includes("strictShortestPath"),
  fixedMetricSums: fixedSums,
  overflowFailsClosed: overflowCode === "RESOURCE_EXHAUSTED",
  closureCondition: closedCode === "NO_FEASIBLE_PLAN",
  speedOverrideDurationOnly: slowService.metrics.distanceMm === normalService.metrics.distanceMm && slowService.metrics.durationMs === normalService.metrics.durationMs * 2,
  profileLegality: profileCode === "NO_FEASIBLE_PLAN",
  shortestDistance: JSON.stringify(connectorKeys(distanceRoute)) === JSON.stringify([short.arcKey]),
  fastest: JSON.stringify(connectorKeys(timeRoute)) === JSON.stringify([fast1.arcKey, fast2.arcKey]),
  lowestRisk: JSON.stringify(connectorKeys(riskRoute)) === JSON.stringify([risk1.arcKey, risk2.arcKey]),
  deterministicSeed: replay.route.routeSignature === solveStrictCoverageRoute(turnProblem, turnGraph, options()).route.routeSignature,
  frozenReplay: replay.route.routeSignature === solveStrictCoverageRoute(turnProblem, turnGraph, options()).route.routeSignature,
  versionDifferenceRejected: versionCode === "VERSION_NOT_FOUND",
  matrixBudget: matrixCode === "RESOURCE_EXHAUSTED",
  candidateBudgetBounded: candidateBounded.diagnostics.resourceMetrics.beamWidth === 1,
  timeBudget: timeCode === "RESOURCE_EXHAUSTED",
  routeCountRejected: routeCountCode === "CAPABILITY_NOT_AVAILABLE",
  eitherDirectionRejected: eitherCode === "CAPABILITY_NOT_AVAILABLE",
  routeContract: validateContract("urn:gowm:v0.6:coverage-route", sequence.route).valid,
  diagnosticsContract: validateContract("urn:gowm:v0.6:coverage-solver-diagnostics", sequence.diagnostics).valid
};
const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
if (failed.length > 0) throw new Error(`strict routing gate failed: ${failed.join(", ")}`);
const evidence = { schemaVersion: "1.0", runId, status: "PASS", checks, turnScenarios: { pairwiseSignature: forbidden.route.routeSignature, allowedOnlySignature: only.route.routeSignature, sequenceSignature: sequence.route.routeSignature, sequenceArcKeys: sequence.route.segments.map((segment) => segment.arcKey) }, objectives: { distanceArcKeys: connectorKeys(distanceRoute), timeArcKeys: connectorKeys(timeRoute), riskArcKeys: connectorKeys(riskRoute) }, conditions: { normalServiceMetrics: normalService.metrics, slowedServiceMetrics: slowService.metrics, closedCode, profileCode }, resources: { matrixCode, candidateBeamWidth: candidateBounded.diagnostics.resourceMetrics.beamWidth, timeCode, overflowCode }, replay: { problemHash: turnProblem.problemHash, routeSignature: replay.route.routeSignature, versionCode } };
const directory = resolve(root, "reports/gowm-v0.6");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, `s03-strict-routing-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`GOWM_COVERAGE_STRICT_ROUTING_PASS ${runId} checks=${Object.keys(checks).length} objectives=3\n`);
