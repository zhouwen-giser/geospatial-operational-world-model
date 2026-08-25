import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateContract } from "../../dist/packages/platform/contract-runtime/src/index.js";
import {
  buildCanonicalCoverageProblem,
  buildRoadServiceObligation,
  obligationSetHash,
  solveClosedDcpp
} from "../../dist/packages/road-coverage-planning-core/src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V06_RUN_ID;
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
const snapshot = {
  networkDatasetVersion: "dataset-v1",
  graphVersion: "graph-v1",
  travelProfileVersion: "travel-v1",
  costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`,
  costContentHash: `sha256:${"2".repeat(64)}`
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
const graph = [
  arc("1", "A", "B", 50),
  arc("2", "B", "A", 10),
  arc("3", "B", "C", 1),
  arc("4", "C", "A", 1),
  arc("5", "A", "B", 1)
];
const obligations = graph.map((value) => buildRoadServiceObligation({
  routingSnapshot: snapshot,
  graphVersion: snapshot.graphVersion,
  arcKey: value.arcKey,
  startFractionPpm: 0,
  endFractionPpm: 1_000_000,
  requiredPasses: value.arcKey === key("1") ? 2 : 1,
  selectionPolicyVersion: "coverage-selection/1.0",
  sourceFeatureReferenceKey: feature
}));
const ledgerHash = obligationSetHash(obligations);
const problem = buildCanonicalCoverageProblem({
  routingSnapshot: snapshot,
  startState: { arcKey: key("1"), fractionPpm: 345_678, direction: "FORWARD" },
  endpointMode: "RETURN_TO_START",
  boundaryCrossingPolicy: "FREE",
  obligationSet: {
    schemaVersion: "1.0",
    obligationSetId: `obls_${ledgerHash.slice("sha256:".length)}`,
    routingSnapshot: snapshot,
    selectionMode: "INTERSECTING_COMPLETE_EDGE",
    obligations,
    obligationCount: obligations.length,
    totalRequiredLengthMm: 5_000,
    selectionReceiptHash: `sha256:${"3".repeat(64)}`,
    warnings: []
  },
  objective: { profile: "SHORTEST_TOTAL_DISTANCE" },
  budgets: { timeLimitMs: 10_000, maximumCandidates: 1, maximumMatrixCells: 64 }
});
const first = solveClosedDcpp(problem, [...graph].reverse());
const replay = solveClosedDcpp(problem, graph);
const checks = {
  closedAtExactDirectedState: JSON.stringify(first.route.startState) === JSON.stringify(first.route.endState) && first.route.startState.fractionPpm === 345_678,
  minimumCostAugmentation: JSON.stringify(first.augmentation) === JSON.stringify([{ fromNodeKey: "B", toNodeKey: "A", quantity: 1, unitCost: 2, arcKeys: [key("3"), key("4")] }]),
  balancedEulerTraversal: first.route.segments.length === 9 && first.diagnostics.imbalanceCount === 2,
  deterministicReplay: first.route.routeSignature === replay.route.routeSignature,
  routeContract: validateContract("urn:gowm:v0.6:coverage-route", first.route).valid,
  diagnosticsContract: validateContract("urn:gowm:v0.6:coverage-solver-diagnostics", first.diagnostics).valid
};
const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
if (failed.length > 0) throw new Error(`closed DCPP gate failed: ${failed.join(", ")}`);
const evidence = {
  schemaVersion: "1.0",
  runId,
  status: "PASS",
  checks,
  problemHash: problem.problemHash,
  routeSignature: first.route.routeSignature,
  augmentation: first.augmentation,
  requiredTraversalCount: first.diagnostics.resourceMetrics.requiredTraversalCount,
  augmentedTraversalCount: first.diagnostics.resourceMetrics.augmentedTraversalCount,
  segmentCount: first.route.segments.length
};
const reportDirectory = resolve(repositoryRoot, "reports/gowm-v0.6");
await mkdir(reportDirectory, { recursive: true });
await writeFile(resolve(reportDirectory, `s00-closed-dcpp-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`GOWM_COVERAGE_CLOSED_DCPP_PASS ${runId} checks=${Object.keys(checks).length} segments=${evidence.segmentCount}\n`);
