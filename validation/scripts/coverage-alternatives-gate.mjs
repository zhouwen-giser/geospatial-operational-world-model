import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateContract } from "../../dist/packages/platform/contract-runtime/src/index.js";
import { buildVerifiedCoverageResultSet, compareRoutes } from "../../dist/packages/road-coverage-alternatives-core/src/index.js";
import { admitVerifiedCoverageRoute, verifyCoverageRoute } from "../../dist/packages/road-coverage-verifier-core/src/index.js";
import { buildCanonicalCoverageProblem, buildRoadServiceObligation, obligationSetHash, solveStrictCoverageRoute } from "../../dist/packages/road-coverage-planning-core/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V06_RUN_ID;
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
const snapshot = { networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1", graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}` };
const feature = { namespace: "gowm", kind: "LAYER_FEATURE", id: `wrf_${"a".repeat(32)}`, version: "dataset-v1" };
const key = (hex) => `arc_${hex.repeat(32)}`;
const metrics = (distanceMm, durationMs) => ({ distanceMm, durationMs, riskMicroUnits: distanceMm, energyMwh: distanceMm, combinedCostUnits: distanceMm, turnPenaltyUnits: 0 });
const arc = (hex, fromNodeKey, toNodeKey, value) => ({ graphVersion: snapshot.graphVersion, arcKey: key(hex), fromNodeKey, toNodeKey, direction: "FORWARD", sourceFeatureReferenceKey: feature, metrics: value });
const start = arc("1", "X", "A", metrics(1, 1)), short = arc("2", "A", "D", metrics(10, 100)), fast1 = arc("3", "A", "C", metrics(10, 10)), fast2 = arc("4", "C", "D", metrics(10, 10)), service = arc("5", "D", "E", metrics(1, 1)), back = arc("6", "E", "A", metrics(1, 1));
const networkArcs = [start, short, fast1, fast2, service, back];
const obligation = buildRoadServiceObligation({ routingSnapshot: snapshot, graphVersion: snapshot.graphVersion, arcKey: service.arcKey, startFractionPpm: 0, endFractionPpm: 1_000_000, requiredPasses: 1, selectionPolicyVersion: "coverage-selection/1.0", sourceFeatureReferenceKey: feature });
const ledgerHash = obligationSetHash([obligation]);
const problem = buildCanonicalCoverageProblem({ routingSnapshot: snapshot, startState: { arcKey: start.arcKey, fractionPpm: 1_000_000, direction: "FORWARD" }, endpointMode: "RETURN_TO_START", boundaryCrossingPolicy: "FREE", obligationSet: { schemaVersion: "1.0", obligationSetId: `obls_${ledgerHash.slice("sha256:".length)}`, routingSnapshot: snapshot, selectionMode: "MANUAL_OBLIGATIONS", obligations: [obligation], obligationCount: 1, totalRequiredLengthMm: 1, selectionReceiptHash: `sha256:${"3".repeat(64)}`, warnings: [] }, objective: { profiles: ["SHORTEST_TOTAL_DISTANCE", "FASTEST_COMPLETION"] }, budgets: { timeLimitMs: 10_000, maximumCandidates: 8, maximumMatrixCells: 64 } });
const candidate = (objective, objectiveProfile) => {
  const solution = solveStrictCoverageRoute(problem, networkArcs, { objective, travelPolicy: { profileKey: "UGV/1.0" } });
  const verification = verifyCoverageRoute({ problem, candidate: solution.route, currentRoutingSnapshot: snapshot, networkArcs, objective, travelPolicy: { profileKey: "UGV/1.0" } });
  return { admitted: admitVerifiedCoverageRoute(solution.route, verification), objectiveProfile, solverDiagnostics: solution.diagnostics };
};
const shortest = candidate("SHORTEST_DISTANCE", "SHORTEST_TOTAL_DISTANCE"), fastest = candidate("FASTEST", "FASTEST_COMPLETION");
const build = (candidates, policy = {}, termination = "PROFILES_COMPLETE") => buildVerifiedCoverageResultSet({ requestId: "request-alternatives", problemHash: problem.problemHash, routingSnapshot: snapshot, policy: { requestedCount: 2, minimumVerifiedCount: 2, profiles: ["SHORTEST_TOTAL_DISTANCE", "FASTEST_COMPLETION"], maximumWeightedArcOverlapPpm: 900_000, minimumDeadheadJaccardDistancePpm: 500_000, maximumGenerationCandidates: 8, ...policy }, candidates, searchTerminatedBy: termination, createdAt: "2026-08-25T04:00:00Z", validUntil: "2026-08-25T04:05:00Z" });
const two = build([shortest, fastest]);
const one = build([shortest], { requestedCount: 1, minimumVerifiedCount: 1, profiles: ["SHORTEST_TOTAL_DISTANCE"] });
const duplicate = build([shortest, { ...shortest, objectiveProfile: "FASTEST_COMPLETION", displayMetadata: { label: "changed", color: "red" } }], { minimumVerifiedCount: 1 });
const strictDiversity = build([shortest, fastest], { maximumWeightedArcOverlapPpm: 0 });
const similarity = compareRoutes(shortest.admitted.route, fastest.admitted.route);
const replay = build([fastest, shortest]);
let unverifiedRejected = false;
try { const invalid = structuredClone(shortest); invalid.admitted.verification.status = "INVALID"; build([invalid], { requestedCount: 1, minimumVerifiedCount: 1, profiles: ["SHORTEST_TOTAL_DISTANCE"] }); } catch { unverifiedRejected = true; }
const checks = {
  oneAlternativeLogic: one.status === "SUCCEEDED" && one.alternatives.length === 1,
  twoAlternativeLogic: two.status === "SUCCEEDED" && two.alternatives.length === 2,
  minimumCountExplicit: strictDiversity.status === "PARTIAL" && strictDiversity.alternatives.length === 1,
  signatureDeduplication: duplicate.alternatives.length === 1,
  displayOnlyIgnored: duplicate.receipts[0].deduplicatedCandidateCount === 1,
  weightedOverlap: similarity.weightedArcOverlapPpm < 900_000,
  deadheadJaccard: similarity.deadheadJaccardDistancePpm >= 500_000,
  verifyFirst: unverifiedRejected && two.alternatives.every((value) => value.verification.status === "VALID"),
  deterministicRank: replay.resultHash === two.resultHash,
  truthfulExplanations: two.alternatives[0].pros[0] === `Verified distance ${two.alternatives[0].route.metrics.distanceMm} mm` && two.alternatives[1].pros[0] === `Verified duration ${two.alternatives[1].route.metrics.durationMs} ms`,
  immutableInMemory: Object.isFrozen(two) && Object.isFrozen(two.alternatives) && Object.isFrozen(two.pairwiseSimilarity),
  terminationReason: two.searchTerminatedBy === "PROFILES_COMPLETE",
  resultContract: validateContract("urn:gowm:v0.6:coverage-result-set", two).valid
};
const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
if (failed.length > 0) throw new Error(`alternatives gate failed: ${failed.join(", ")}`);
const evidence = { schemaVersion: "1.0", runId, status: "PASS", checks, resultSetId: two.resultSetId, resultHash: two.resultHash, routeSignatures: two.alternatives.map((value) => value.route.routeSignature), pairwiseSimilarity: two.pairwiseSimilarity, strictDiversityStatus: strictDiversity.status, strictDiversityCount: strictDiversity.alternatives.length, terminationReason: two.searchTerminatedBy };
const directory = resolve(root, "reports/gowm-v0.6");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, `l00-alternatives-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`GOWM_COVERAGE_ALTERNATIVES_PASS ${runId} checks=${Object.keys(checks).length} selected=${two.alternatives.length}\n`);
