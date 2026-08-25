import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalSha256, validateContract } from "../../dist/packages/platform/contract-runtime/src/index.js";
import { admitVerifiedCoverageRoute, verifyCoverageRoute } from "../../dist/packages/road-coverage-verifier-core/src/index.js";
import { buildCanonicalCoverageProblem, buildRoadServiceObligation, obligationSetHash, solveStrictCoverageRoute } from "../../dist/packages/road-coverage-planning-core/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V06_RUN_ID;
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
const snapshot = { networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1", graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}` };
const feature = { namespace: "gowm", kind: "LAYER_FEATURE", id: `wrf_${"a".repeat(32)}`, version: "dataset-v1" };
const key = (hex) => `arc_${hex.repeat(32)}`;
const arc = (hex, fromNodeKey, toNodeKey, distanceMm) => ({ graphVersion: snapshot.graphVersion, arcKey: key(hex), fromNodeKey, toNodeKey, direction: "FORWARD", sourceFeatureReferenceKey: feature, roadClass: "LOCAL", surface: "PAVED", accessMask: 1, metrics: { distanceMm, durationMs: distanceMm * 2, riskMicroUnits: distanceMm * 3, energyMwh: distanceMm * 4, combinedCostUnits: distanceMm, turnPenaltyUnits: 0 } });
const start = arc("1", "X", "A", 1), connector = arc("2", "A", "D", 5), service = arc("3", "D", "E", 7), back = arc("4", "E", "A", 11);
const networkArcs = [start, connector, service, back];
const obligation = buildRoadServiceObligation({ routingSnapshot: snapshot, graphVersion: snapshot.graphVersion, arcKey: service.arcKey, startFractionPpm: 0, endFractionPpm: 1_000_000, requiredPasses: 1, selectionPolicyVersion: "coverage-selection/1.0", sourceFeatureReferenceKey: feature });
const ledgerHash = obligationSetHash([obligation]);
const problem = buildCanonicalCoverageProblem({ routingSnapshot: snapshot, startState: { arcKey: start.arcKey, fractionPpm: 1_000_000, direction: "FORWARD" }, endpointMode: "RETURN_TO_START", boundaryCrossingPolicy: "FREE", obligationSet: { schemaVersion: "1.0", obligationSetId: `obls_${ledgerHash.slice("sha256:".length)}`, routingSnapshot: snapshot, selectionMode: "MANUAL_OBLIGATIONS", obligations: [obligation], obligationCount: 1, totalRequiredLengthMm: 7, selectionReceiptHash: `sha256:${"3".repeat(64)}`, warnings: [] }, objective: { profile: "SHORTEST_DISTANCE" }, budgets: { timeLimitMs: 10_000, maximumCandidates: 4, maximumMatrixCells: 32 } });
const candidate = solveStrictCoverageRoute(problem, networkArcs, { objective: "SHORTEST_DISTANCE", travelPolicy: { profileKey: "UGV/1.0" } }).route;
const input = { problem, candidate, currentRoutingSnapshot: snapshot, networkArcs, objective: "SHORTEST_DISTANCE", travelPolicy: { profileKey: "UGV/1.0" }, turnRules: [] };
const rehash = (route) => { const { routeSignature: _, ...body } = structuredClone(route); return { ...body, routeSignature: canonicalSha256(body) }; };
const codes = (report) => report.violations.map((item) => item.code);

const valid = verifyCoverageRoute(input);
const unknown = structuredClone(candidate); unknown.segments[0].arcKey = key("f");
const discontinuous = structuredClone(candidate); discontinuous.segments[0].endFractionPpm = 500_000;
const reversed = structuredClone(candidate); reversed.segments[1].startFractionPpm = 1_000_000; reversed.segments[1].endFractionPpm = 0;
const missing = structuredClone(candidate); missing.segments = missing.segments.filter((segment) => segment.serviceRole !== "SERVICE");
const endpoint = structuredClone(candidate); endpoint.startState.fractionPpm = 999_999; endpoint.endState.fractionPpm = 999_999;
const boundary = structuredClone(candidate); boundary.boundaryEvents = [{ sequence: 1, kind: "ENTRY", state: problem.startState }, { sequence: 2, kind: "EXIT", state: problem.startState }, { sequence: 3, kind: "ENTRY", state: problem.startState }];
const metric = structuredClone(candidate); metric.segments[0].metrics.distanceMm += 1;
const hash = structuredClone(candidate); hash.metrics.distanceMm += 1;
const reports = {
  unknown: verifyCoverageRoute({ ...input, candidate: rehash(unknown) }),
  discontinuous: verifyCoverageRoute({ ...input, candidate: rehash(discontinuous) }),
  reversed: verifyCoverageRoute({ ...input, candidate: rehash(reversed) }),
  pairwise: verifyCoverageRoute({ ...input, turnRules: [{ ruleKey: "pair", arcSequence: [start.arcKey, connector.arcKey], ruleType: "FORBIDDEN" }] }),
  sequence: verifyCoverageRoute({ ...input, turnRules: [{ ruleKey: "sequence", arcSequence: [start.arcKey, connector.arcKey, service.arcKey], ruleType: "FORBIDDEN" }] }),
  missing: verifyCoverageRoute({ ...input, candidate: rehash(missing) }),
  endpoint: verifyCoverageRoute({ ...input, candidate: rehash(endpoint) }),
  boundary: verifyCoverageRoute({ ...input, problem: { ...problem, boundaryCrossingPolicy: "NO_REENTRY" }, candidate: rehash(boundary) }),
  profile: verifyCoverageRoute({ ...input, travelPolicy: { profileKey: "UGV/1.0", allowedRoadClasses: ["HIGHWAY"] } }),
  condition: verifyCoverageRoute({ ...input, networkArcs: networkArcs.map((value) => value.arcKey === service.arcKey ? { ...value, traversalAllowed: false } : value) }),
  metric: verifyCoverageRoute({ ...input, candidate: rehash(metric) }),
  hash: verifyCoverageRoute({ ...input, candidate: hash }),
  stale: verifyCoverageRoute({ ...input, currentRoutingSnapshot: { ...snapshot, costContentHash: `sha256:${"9".repeat(64)}` } })
};
let invalidAdmissionRejected = false, tamperedReceiptRejected = false;
try { admitVerifiedCoverageRoute(candidate, reports.pairwise); } catch { invalidAdmissionRejected = true; }
try { admitVerifiedCoverageRoute(candidate, { ...valid, reportHash: `sha256:${"0".repeat(64)}` }); } catch { tamperedReceiptRejected = true; }
const admitted = admitVerifiedCoverageRoute(candidate, valid);
const sourceFiles = await Promise.all(["types.ts", "verification.ts", "index.ts"].map((name) => readFile(resolve(root, `packages/road-coverage-verifier-core/src/${name}`), "utf8")));
const forbiddenImports = ["road-coverage-planning-core", "closed-dcpp", "fixed-rpp", "strict-routing"];
const mutationReports = Object.values(reports).filter((report) => report !== reports.stale);
const checks = {
  importIndependence: sourceFiles.every((source) => forbiddenImports.every((needle) => !source.includes(needle))),
  arcIdentity: codes(reports.unknown).includes("UNKNOWN_OR_WRONG_VERSION_ARC"),
  continuity: codes(reports.discontinuous).includes("DISCONTINUOUS_SEGMENT"),
  direction: codes(reports.reversed).includes("ILLEGAL_DIRECTION"),
  fractions: codes(reports.reversed).includes("INVALID_FRACTION"),
  pairwiseTurns: codes(reports.pairwise).includes("TURN_RESTRICTION_VIOLATION"),
  sequenceTurns: codes(reports.sequence).includes("TURN_RESTRICTION_VIOLATION"),
  coverageCount: codes(reports.missing).includes("OBLIGATION_PASS_DEFICIT"),
  coverageRatio: valid.coverageRatioPpm === 1_000_000 && reports.missing.coverageRatioPpm === 0,
  lengthWeightedRatio: valid.lengthWeightedCoverageRatioPpm === 1_000_000 && reports.missing.lengthWeightedCoverageRatioPpm === 0,
  startTerminal: codes(reports.endpoint).includes("START_STATE_MISMATCH"),
  endTerminal: codes(reports.endpoint).includes("END_STATE_MISMATCH"),
  boundaryPolicy: codes(reports.boundary).includes("BOUNDARY_POLICY_VIOLATION"),
  profile: codes(reports.profile).includes("PROFILE_ILLEGAL_ARC"),
  condition: codes(reports.condition).includes("CONDITION_CLOSED_ARC"),
  metrics: codes(reports.metric).includes("METRIC_MISMATCH"),
  resultHash: codes(reports.hash).includes("CANDIDATE_HASH_MISMATCH"),
  staleLogic: reports.stale.status === "STALE" && codes(reports.stale).includes("STALE_ROUTING_SNAPSHOT"),
  mutationSuite: mutationReports.every((report) => report.status === "INVALID"),
  knownBugCorpus: [reports.pairwise, reports.sequence, reports.missing, reports.metric].every((report) => report.status === "INVALID"),
  cannotBypass: invalidAdmissionRejected && tamperedReceiptRejected && admitted.verification.status === "VALID",
  verificationReceipt: validateContract("urn:gowm:v0.6:coverage-verification-report", valid).valid && valid.verifierVersion === "coverage-verifier/1.0" && valid.violations.length === 0
};
const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
if (failed.length > 0) throw new Error(`independent verifier gate failed: ${failed.join(", ")}`);
const evidence = { schemaVersion: "1.0", runId, status: "PASS", checks, valid: { verificationId: valid.verificationId, reportHash: valid.reportHash, routeSignature: candidate.routeSignature, coverageRatioPpm: valid.coverageRatioPpm, lengthWeightedCoverageRatioPpm: valid.lengthWeightedCoverageRatioPpm, recomputedMetrics: valid.recomputedMetrics, admissionHash: admitted.admissionHash }, mutations: Object.fromEntries(Object.entries(reports).map(([name, report]) => [name, { status: report.status, codes: codes(report) }])) };
const directory = resolve(root, "reports/gowm-v0.6");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, `v00-independent-verifier-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`GOWM_COVERAGE_INDEPENDENT_VERIFIER_PASS ${runId} checks=${Object.keys(checks).length} mutations=${mutationReports.length}\n`);
