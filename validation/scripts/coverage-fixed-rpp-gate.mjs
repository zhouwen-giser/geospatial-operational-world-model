import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateContract } from "../../dist/packages/platform/contract-runtime/src/index.js";
import { buildCanonicalCoverageProblem, buildRoadServiceObligation, obligationSetHash, solveFixedDirectionRpp } from "../../dist/packages/road-coverage-planning-core/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V06_RUN_ID;
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
const snapshot = { networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1", graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}` };
const feature = { namespace: "gowm", kind: "LAYER_FEATURE", id: `wrf_${"a".repeat(32)}`, version: "dataset-v1" };
const key = (hex) => `arc_${hex.repeat(32)}`;
const arc = (hex, fromNodeKey, toNodeKey, cost, direction = "FORWARD") => ({ graphVersion: snapshot.graphVersion, arcKey: key(hex), fromNodeKey, toNodeKey, direction, sourceFeatureReferenceKey: feature, metrics: { distanceMm: cost * 1_000, durationMs: cost * 100, riskMicroUnits: cost, energyMwh: cost * 2, combinedCostUnits: cost, turnPenaltyUnits: 0 } });
const required = (value, start = 0, end = 1_000_000, passes = 1, edgeKey) => buildRoadServiceObligation({ routingSnapshot: snapshot, graphVersion: snapshot.graphVersion, ...(edgeKey === undefined ? {} : { edgeKey }), arcKey: value.arcKey, startFractionPpm: start, endFractionPpm: end, requiredPasses: passes, selectionPolicyVersion: "coverage-selection/1.0", sourceFeatureReferenceKey: feature });
const makeProblem = (obligations, startArc, fraction = 0) => {
  const hash = obligationSetHash(obligations);
  return buildCanonicalCoverageProblem({
    routingSnapshot: snapshot,
    startState: { arcKey: startArc.arcKey, fractionPpm: fraction, direction: startArc.direction },
    endpointMode: "RETURN_TO_START",
    boundaryCrossingPolicy: "FREE",
    obligationSet: { schemaVersion: "1.0", obligationSetId: `obls_${hash.slice("sha256:".length)}`, routingSnapshot: snapshot, selectionMode: "CLIPPED_INSIDE_AREA", obligations, obligationCount: obligations.length, totalRequiredLengthMm: obligations.length * 1_000, selectionReceiptHash: `sha256:${"3".repeat(64)}`, warnings: [] },
    objective: { profile: "LEAST_DEADHEAD" },
    budgets: { timeLimitMs: 10_000, maximumCandidates: 1, maximumMatrixCells: 256 }
  });
};

const first = arc("1", "A", "B", 1), connector = arc("2", "B", "C", 2), second = arc("3", "C", "D", 1), returnArc = arc("4", "D", "A", 2);
const disconnectedGraph = [first, connector, second, returnArc];
const disconnected = solveFixedDirectionRpp(makeProblem([required(first), required(second)], first), disconnectedGraph);
const partialForward = arc("5", "E", "F", 100), partialReverse = arc("6", "F", "E", 10, "REVERSE");
const partialProblem = makeProblem([required(partialForward, 250_000, 750_000)], partialForward, 250_000);
const partial = solveFixedDirectionRpp(partialProblem, [partialForward, partialReverse]);
const bothForward = arc("7", "G", "H", 1), bothReverse = arc("8", "H", "G", 1, "REVERSE"), sharedEdge = `edge_${"f".repeat(32)}`;
const both = solveFixedDirectionRpp(makeProblem([required(bothForward, 0, 1_000_000, 2, sharedEdge), required(bothReverse, 0, 1_000_000, 1, sharedEdge)], bothForward), [bothForward, bothReverse]);
const checks = {
  requiredSubsetSeparated: disconnectedGraph.length === 4 && disconnected.route.segments.filter((segment) => segment.serviceRole === "SERVICE").length === 2,
  disconnectedComponentsConnected: disconnected.diagnostics.requiredComponentCount === 2 && disconnected.route.segments.length === 4,
  fullNetworkConnectorUsed: disconnected.route.segments.some((segment) => segment.arcKey === connector.arcKey && segment.serviceRole === "TRANSIT"),
  partialServiceExact: partial.route.segments.some((segment) => segment.serviceRole === "SERVICE" && segment.startFractionPpm === 250_000 && segment.endFractionPpm === 750_000),
  transitClassified: partial.route.segments.filter((segment) => segment.serviceRole === "TRANSIT").length === 3,
  repeatedPassesSatisfied: both.route.segments.filter((segment) => segment.arcKey === bothForward.arcKey && segment.serviceRole === "SERVICE").length === 2,
  duplicateServiceClassified: both.route.segments.some((segment) => segment.arcKey === bothReverse.arcKey && segment.serviceRole === "DUPLICATE_SERVICE"),
  bothDirectionFamily: both.diagnostics.algorithmFamily === "BOTH_DIRECTIONS_RPP",
  deterministicReplay: disconnected.route.routeSignature === solveFixedDirectionRpp(makeProblem([required(first), required(second)], first), [...disconnectedGraph].reverse()).route.routeSignature,
  routeContracts: [disconnected, partial, both].every((solution) => validateContract("urn:gowm:v0.6:coverage-route", solution.route).valid),
  diagnosticsContracts: [disconnected, partial, both].every((solution) => validateContract("urn:gowm:v0.6:coverage-solver-diagnostics", solution.diagnostics).valid)
};
const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
if (failed.length > 0) throw new Error(`fixed RPP gate failed: ${failed.join(", ")}`);
const evidence = { schemaVersion: "1.0", runId, status: "PASS", checks, disconnected: { problemHash: makeProblem([required(first), required(second)], first).problemHash, routeSignature: disconnected.route.routeSignature, requiredComponentCount: disconnected.diagnostics.requiredComponentCount, segmentRoles: disconnected.route.segments.map((segment) => ({ arcKey: segment.arcKey, role: segment.serviceRole })) }, partial: { problemHash: partialProblem.problemHash, routeSignature: partial.route.routeSignature, segments: partial.route.segments.map((segment) => ({ arcKey: segment.arcKey, startFractionPpm: segment.startFractionPpm, endFractionPpm: segment.endFractionPpm, role: segment.serviceRole })) }, bothDirections: { routeSignature: both.route.routeSignature, algorithmFamily: both.diagnostics.algorithmFamily, roles: both.route.segments.map((segment) => ({ arcKey: segment.arcKey, role: segment.serviceRole })) } };
const directory = resolve(root, "reports/gowm-v0.6");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, `s02-fixed-rpp-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`GOWM_COVERAGE_FIXED_RPP_PASS ${runId} checks=${Object.keys(checks).length} scenarios=3\n`);
