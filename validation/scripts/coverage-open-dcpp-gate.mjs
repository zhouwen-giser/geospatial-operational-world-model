import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateContract } from "../../dist/packages/platform/contract-runtime/src/index.js";
import { buildCanonicalCoverageProblem, buildRoadServiceObligation, obligationSetHash, solveOpenDcpp } from "../../dist/packages/road-coverage-planning-core/src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V06_RUN_ID;
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
const snapshot = {
  networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}`
};
const feature = { namespace: "gowm", kind: "LAYER_FEATURE", id: `wrf_${"a".repeat(32)}`, version: "dataset-v1" };
const key = (hex) => `arc_${hex.repeat(32)}`;
const arc = (hex, fromNodeKey, toNodeKey, cost) => ({
  graphVersion: snapshot.graphVersion,
  arcKey: key(hex),
  fromNodeKey,
  toNodeKey,
  direction: "FORWARD",
  sourceFeatureReferenceKey: feature,
  metrics: { distanceMm: cost * 1_000, durationMs: cost * 100, riskMicroUnits: cost, energyMwh: cost * 2, combinedCostUnits: cost, turnPenaltyUnits: 0 }
});
const graph = [arc("1", "A", "B", 3), arc("2", "B", "C", 5), arc("3", "C", "A", 7)];
const obligations = graph.map((value) => buildRoadServiceObligation({
  routingSnapshot: snapshot,
  graphVersion: snapshot.graphVersion,
  arcKey: value.arcKey,
  startFractionPpm: 0,
  endFractionPpm: 1_000_000,
  requiredPasses: 1,
  selectionPolicyVersion: "coverage-selection/1.0",
  sourceFeatureReferenceKey: feature
}));
const ledgerHash = obligationSetHash(obligations);
const problem = buildCanonicalCoverageProblem({
  routingSnapshot: snapshot,
  startState: { arcKey: key("1"), fractionPpm: 250_000, direction: "FORWARD" },
  fixedEndState: { arcKey: key("2"), fractionPpm: 500_000, direction: "FORWARD" },
  endpointMode: "FIXED_END",
  boundaryCrossingPolicy: "FREE",
  obligationSet: {
    schemaVersion: "1.0",
    obligationSetId: `obls_${ledgerHash.slice("sha256:".length)}`,
    routingSnapshot: snapshot,
    selectionMode: "INTERSECTING_COMPLETE_EDGE",
    obligations,
    obligationCount: obligations.length,
    totalRequiredLengthMm: 3_000,
    selectionReceiptHash: `sha256:${"3".repeat(64)}`,
    warnings: []
  },
  objective: { profile: "SHORTEST_TOTAL_DISTANCE" },
  budgets: { timeLimitMs: 10_000, maximumCandidates: 1, maximumMatrixCells: 64 }
});
const first = solveOpenDcpp(problem, [...graph].reverse());
const replay = solveOpenDcpp(problem, graph);
const terminalProblem = buildCanonicalCoverageProblem({
  routingSnapshot: snapshot,
  startState: { arcKey: key("1"), fractionPpm: 0, direction: "FORWARD" },
  fixedEndState: { arcKey: key("2"), fractionPpm: 0, direction: "FORWARD" },
  endpointMode: "FIXED_END",
  boundaryCrossingPolicy: "FREE",
  obligationSet: problem.obligationSet,
  objective: problem.objective,
  budgets: problem.budgets
});
const terminalSolution = solveOpenDcpp(terminalProblem, graph);
const checks = {
  distinctExactTerminals: JSON.stringify(first.route.startState) === JSON.stringify(problem.startState) && JSON.stringify(first.route.endState) === JSON.stringify(problem.fixedEndState),
  partialAccessPreserved: first.route.segments[0].serviceRole === "ACCESS" && first.route.segments[0].startFractionPpm === 250_000,
  partialReturnPreserved: first.route.segments.at(-1).serviceRole === "RETURN" && first.route.segments.at(-1).endFractionPpm === 500_000,
  openTerminalBalance: JSON.stringify(terminalSolution.augmentation) === JSON.stringify([{ fromNodeKey: "A", toNodeKey: "B", quantity: 1, unitCost: 3, arcKeys: [key("1")] }]) && terminalSolution.diagnostics.algorithmFamily === "OPEN_DCPP",
  deterministicReplay: first.route.routeSignature === replay.route.routeSignature,
  routeContract: validateContract("urn:gowm:v0.6:coverage-route", first.route).valid,
  diagnosticsContract: validateContract("urn:gowm:v0.6:coverage-solver-diagnostics", first.diagnostics).valid
};
const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
if (failed.length > 0) throw new Error(`open DCPP gate failed: ${failed.join(", ")}`);
const evidence = {
  schemaVersion: "1.0",
  runId,
  status: "PASS",
  checks,
  problemHash: problem.problemHash,
  routeSignature: first.route.routeSignature,
  startState: first.route.startState,
  endState: first.route.endState,
  augmentation: first.augmentation,
  terminalAugmentation: terminalSolution.augmentation,
  segmentCount: first.route.segments.length
};
const reportDirectory = resolve(repositoryRoot, "reports/gowm-v0.6");
await mkdir(reportDirectory, { recursive: true });
await writeFile(resolve(reportDirectory, `s01-open-dcpp-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`GOWM_COVERAGE_OPEN_DCPP_PASS ${runId} checks=${Object.keys(checks).length} segments=${evidence.segmentCount}\n`);
