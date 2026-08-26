import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceOnly = process.argv.includes("--evidence-only");
const matrix = (await readFile(resolve(root, "validation/gowm-v0.6.1/acceptance-matrix.csv"), "utf8"))
  .trim().split(/\r?\n/u).slice(1).map((line) => {
    const fields = line.split(",");
    if (fields.length !== 6) throw new Error(`invalid acceptance row: ${line}`);
    const [id, required, area, scenario, expected, testType] = fields;
    return { id, required, area, scenario, expected, testType };
  });
const required = matrix.filter((item) => item.required === "yes");
if (required.length !== 229 || new Set(required.map((item) => item.id)).size !== 229) {
  throw new Error(`expected 229 unique Required rows, received ${required.length}`);
}

const evidencePaths = {
  schema: requiredPath("GOWM_V061_SCHEMA_EVIDENCE"),
  gateway: requiredPath("GOWM_V061_GATEWAY_EVIDENCE"),
  recovery: requiredPath("GOWM_V061_RECOVERY_EVIDENCE"),
  compatibility: requiredPath("GOWM_V061_COMPATIBILITY_EVIDENCE")
};
const evidence = Object.fromEntries(await Promise.all(Object.entries(evidencePaths).map(async ([name, path]) => {
  if (!/^reports\/gowm-v0\.6\.1\/[a-z0-9._-]+\.json$/u.test(path.replaceAll("\\", "/"))) throw new Error(`invalid ${name} evidence path: ${path}`);
  const report = JSON.parse(await readFile(resolve(root, path), "utf8"));
  if (report.status !== "PASS") throw new Error(`${name} evidence is not PASS: ${path}`);
  return [name, report];
})));

assertSchemaEvidence(evidence.schema);
const runtimeSourceLockPath = "reports/gowm-v0.6.1/runtime-source-lock.json";
const runtimeSourceLock = JSON.parse(await readFile(resolve(root, runtimeSourceLockPath), "utf8"));
const runtimePaths = git(["ls-files", "--cached", "--others", "--exclude-standard", ...runtimeSourceLock.roots]).split("\n")
  .filter((path) => !path.startsWith("validation/scripts/") || path.startsWith("validation/scripts/coverage-")).sort();
if (JSON.stringify(runtimePaths) !== JSON.stringify(Object.keys(runtimeSourceLock.files).sort())) throw new Error("runtime source file set changed after real gates");
for (const [path, expected] of Object.entries({ ...runtimeSourceLock.files, ...runtimeSourceLock.runtimeReports })) {
  const actual = createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
  if (actual !== expected) throw new Error(`runtime source/evidence changed after real gates: ${path}`);
}
assertChecks("gateway", evidence.gateway.summary?.checks, [
  "capabilitySemanticsFromRegistry", "capabilitySemanticsUnique", "capabilitySemanticsDeterministic", "capabilitySemanticsCoverage", "capabilitySemanticsValidation", "capabilitySemanticsCatalog", "capabilitySemanticsDetail",
  "boundaryForwardPolygon", "boundaryReversePolygon", "boundaryPartialArcMembership", "boundaryMultiPolygon", "boundaryStartEndInside", "boundaryTouchDeterministic", "boundaryEvidenceReplay", "boundaryOverlapFailClosed", "boundaryInvalidAreaFailClosed",
  "routingCurrentnessCurrent", "routingCurrentnessGraphStale", "routingCurrentnessTravelStale", "routingCurrentnessCostStale", "routingCurrentnessConditionStale", "routingCurrentnessUnavailable", "routingCurrentnessWorldUnknown", "routingValiditySeparate", "frozenPlanInvalid",
  "dataProductKinds", "dataProductScopeBeforeCount", "dataProductVectorDescriptor", "dataProductSchemaCrsExtent", "dataProductLineageQuality", "dataProductCapabilities", "dataProductNetworkDescriptor", "dataProductCurrentDescriptor", "dataProductUnknownQuality", "dataProductVersions", "dataProductSchemaDetail", "dataProductDetails", "dataProductKindSearch", "dataProductSpatialSearch", "dataProductTimeSearch", "dataProductCapabilitySearch", "dataProductQualitySearch", "dataProductCursorStable", "dataProductCursorTamper", "dataProductCrossScopeOpaque",
  "validateDirect", "selectDirect", "planRequiresGatewayJob", "gatewayQueued", "gatewayClaimed", "typedDagCompleted", "typedDagOrder", "planAlternatives", "queryResultIdentity", "derivedAlternativeIdentity", "geometryOnDemand", "verifyDirect", "expandDirect", "expandOrder", "restartReplay", "resultRegistry", "atomicArtifacts", "pairwiseSimilarity",
  "platformResultValidation", "platformOriginalStatusRetained", "platformStatusMapping", "platformStatusBatchOrder", "platformStaleRevalidate", "platformRetiredReference", "platformResultScopeOpaque", "platformSnapshotGet", "platformSnapshotCurrent", "platformSnapshotStale", "platformSnapshotUnknown", "platformSnapshotConsistencyPreserved", "platformSnapshotConsistencyCurrent", "platformSnapshotGraphStale", "platformSnapshotLayerStale", "platformSnapshotWorldAdvanced", "platformSnapshotUnavailable", "platformSnapshotContentHash", "platformSnapshotHashReplay", "platformSnapshotScopeOpaque", "platformSnapshotReadOnly", "expiredIsStale", "expiredExpansionDenied", "gatewayJobAuthority"
]);
assertChecks("recovery.before", evidence.recovery.before?.checks, [
  "smallSelection", "smallPlan", "smallExpand", "mediumSelection", "mediumPlan", "mediumExpand", "mediumMemoryBound",
  "foreignResultDenied", "cursorTamperDenied", "sqlInjectionDenied", "sqlParameterized", "urlInjectionDenied", "areaVertexLimit", "candidateLimit", "outputLimit", "logRedaction", "nodeErrorIdentity", "networkUnaffected", "routeUnaffected",
  "concurrentDuplicateJob", "concurrentDuplicateResult", "concurrentDuplicateSingleton",
  "reclaimInitialAttemptGeneration", "reclaimExpiredReaped", "reclaimRequestRequeued", "reclaimConcurrentSingleton", "reclaimMonotonicAttemptGeneration", "reclaimOldHeartbeatFenced", "reclaimOldProblemFenced", "reclaimOldCandidateFenced", "reclaimOldResultFenced", "reclaimNewHeartbeat", "reclaimNewResultPublished", "reclaimDuplicatePublishFenced", "reclaimDurableMonotonicSingleton",
  "SOLVINGCancelled", "SOLVINGLateHeartbeatFenced", "SOLVINGLatePersistFenced", "VERIFYINGCancelled", "VERIFYINGLateHeartbeatFenced", "VERIFYINGLatePersistFenced", "PUBLISHINGCancelled", "PUBLISHINGLateHeartbeatFenced", "PUBLISHINGLatePersistFenced", "chaosCancellation"
]);
assertChecks("recovery.after", evidence.recovery.after?.checks, ["deterministicQuery", "gatewayWorkerReplay", "resultReadAfterRestart", "postgresRestartPersistence"]);
if (evidence.recovery.restart?.status !== "PASS" || !evidence.recovery.cleanup?.every((item) => item.status === "PASS")) throw new Error("recovery restart or cleanup is incomplete");
assertCompatibilityEvidence(evidence.compatibility);

const conformancePath = "reports/gowm-v0.6.1/provider-conformance/aggregate.json";
const conformance = JSON.parse(await readFile(resolve(root, conformancePath), "utf8"));
if (conformance.status !== "PASS" || conformance.providers?.length !== 9 || !conformance.providers.every((provider) => provider.status === "PASS")) throw new Error("nine-provider conformance evidence is incomplete");

const version = (await readFile(resolve(root, "VERSION"), "utf8")).trim();
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
if (version !== "0.6.1" || packageJson.version !== version || packageLock.version !== version || packageLock.packages?.[""]?.version !== version) throw new Error("VERSION and package metadata must converge on 0.6.1");
if (!evidenceOnly && git(["status", "--short", "--untracked-files=no"]) !== "") throw new Error("tracked worktree is not clean");

const { commands: staticEvidence, testFiles, testSummary } = await runStaticGates();
const caseMappingPath = "validation/gowm-v0.6.1/case-evidence.json";
const caseMapping = JSON.parse(await readFile(resolve(root, caseMappingPath), "utf8"));
if (Object.keys(caseMapping.cases ?? {}).length !== required.length) throw new Error("case evidence mapping must contain exactly 229 cases");
const runtimeChecks = {
  gateway: evidence.gateway.summary.checks,
  "recovery.before": evidence.recovery.before.checks,
  "recovery.after": evidence.recovery.after.checks
};
const cases = {};
for (const item of required) {
  const proof = caseMapping.cases[item.id];
  if (proof?.scenario !== item.scenario) throw new Error(`missing or mismatched case mapping: ${item.id}`);
  const unitEvidence = proof.unitFiles.map((path) => {
    const file = testFiles.get(path);
    if (file === undefined || file.status !== "passed" || file.assertionResults.length === 0 || file.assertionResults.some((test) => test.status !== "passed")) throw new Error(`${item.id} has missing, skipped, or failed unit proof: ${path}`);
    return { path, tests: file.assertionResults.map((test) => test.fullName), status: "PASS" };
  });
  const runtimeEvidence = proof.runtime.map((check) => {
    if (check.checks.length === 0) throw new Error(`${item.id} has an empty runtime check list`);
    assertChecks(`${item.id}:${check.report}`, runtimeChecks[check.report], check.checks);
    return { ...check, path: evidencePaths[check.report.split(".")[0]], status: "PASS" };
  });
  for (const path of proof.supportingEvidence) await readFile(resolve(root, path));
  if (unitEvidence.length + runtimeEvidence.length + proof.supportingEvidence.length === 0) throw new Error(`${item.id} has no evidence`);
  cases[item.id] = { status: "PASS", area: item.area, scenario: item.scenario, expected: item.expected, testType: item.testType, unitEvidence, runtimeEvidence, supportingEvidence: proof.supportingEvidence };
}
if (evidenceOnly) {
  const output = "/tmp/gowm-v0.6.1-evidence-preflight.json";
  await writeFile(output, `${JSON.stringify({ decision: "EVIDENCE_PASS_DELIVERY_PENDING", mappedCases: required.length, runtime: evidencePaths, testSummary, staticEvidence, cases }, null, 2)}\n`);
  process.stdout.write(`GOWM_V061_EVIDENCE_PASS cases=229 delivery=PENDING output=${output}\n`);
  process.exit(0);
}
const finalReportPath = "reports/gowm-v0.6.1/final-stable-candidate.md";
const finalReport = await readFile(resolve(root, finalReportPath), "utf8");
for (const marker of ["ROAD_COVERAGE_CORRECT", "CAPABILITY_CONTRACTS_HARDENED", "PUBLIC_DATA_FOUNDATION_HARDENED", "GOWM_V0_6_1_STABLE_CANDIDATE_COMPLETE"]) {
  if (!finalReport.includes(marker)) throw new Error(`final report is missing ${marker}`);
}
const sync = JSON.parse(await readFile(resolve(root, "reports/gowm-v0.6.1/sync-state.json"), "utf8"));
if (sync.status !== "COMPLETE" || sync.phase !== "S03" || Object.values(sync.markers).some((value) => value !== true) || sync.acceptance.passed !== 229 || sync.acceptance.failed !== 0 || sync.acceptance.notRun !== 0 || sync.blockers.length !== 0) throw new Error("sync-state is incomplete");
const phases = ["r00", "r01", "c00", "c01", "c02", "c03", "c04", "c05", "c06", "w00", "w01", "w02", "d00", "d01", "d02", "s00", "s01", "s02", "s03"];
for (const phase of phases) {
  await readFile(resolve(root, `reports/gowm-v0.6.1/${phase}-completion.md`));
  const report = JSON.parse(await readFile(resolve(root, `reports/gowm-v0.6.1/${phase}-acceptance.json`), "utf8"));
  if (report.status !== "PASS" || report.requiredCases !== report.passedCases || report.failedCases !== 0 || report.notRunCases !== 0) throw new Error(`${phase} phase acceptance is incomplete`);
}
for (const path of ["README.md", "PROJECT_STATUS.md", "CHANGELOG.md", "docs/20_PLATFORM_HARDENING_OPERATIONS_RUNBOOK.md", "execplans/EP-gowm-platform-hardening-v0.6.1.md"]) {
  if (!(await readFile(resolve(root, path), "utf8")).includes("0.6.1")) throw new Error(`version documentation is missing: ${path}`);
}

const branch = "codex/gowm-platform-hardening-v0.6.1";
const local = git(["rev-parse", "HEAD"]);
const tracking = git(["rev-parse", `origin/${branch}`]);
const remote = git(["ls-remote", "--heads", "origin", branch]).split(/\s+/u)[0];
const pr = JSON.parse(execFileSync("gh", ["pr", "view", "6", "--json", "number,state,isDraft,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,title,url,statusCheckRollup"], { cwd: root, encoding: "utf8" }));
if (!(local === tracking && local === remote && local === pr.headRefOid)) throw new Error(`candidate SHA mismatch: ${JSON.stringify({ local, tracking, remote, pr: pr.headRefOid })}`);
if (!(pr.state === "OPEN" && pr.isDraft === false && pr.headRefName === branch && pr.baseRefName === "main" && pr.title === "fix: harden GOWM road coverage and public platform contracts")) throw new Error(`PR Ready gate failed: ${JSON.stringify(pr)}`);
if ((pr.statusCheckRollup ?? []).some((check) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(check.conclusion ?? check.state))) throw new Error("PR has a failing check");
if ((pr.statusCheckRollup ?? []).some((check) => check.status !== undefined ? check.status !== "COMPLETED" : !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.state))) throw new Error("PR checks are not complete");
if (git(["status", "--short", "--untracked-files=no"]) !== "") throw new Error("static gates changed tracked candidate content");
const result = {
  schemaVersion: "1.0", goal: "GOWM+ v0.6.1 Platform Hardening", decision: "PASS",
  requiredCases: 229, passedCases: 229, blockedCases: 0, failedCases: 0, notRunCases: 0,
  candidateContentSha: local,
  candidateContentShaEvidence: { local, originTracking: tracking, lsRemote: remote, pullRequestHead: pr.headRefOid },
  pullRequest: pr,
  protectedActions: { merge: "NOT_RUN", tag: "NOT_RUN", release: "NOT_RUN", deploy: "NOT_RUN" },
  cancelledGates: { wsgsReadinessBlackBox: "NOT_IN_SCOPE", dataPlatformReadiness: "NOT_IN_SCOPE", mockElevationOnboarding: "NOT_IN_SCOPE" },
  evidenceCoverage: { caseMapping: caseMappingPath, runtimeSourceLock: runtimeSourceLockPath, runtime: evidencePaths, providerConformance: conformancePath, static: staticEvidence, testSummary },
  markers: ["ROAD_COVERAGE_CORRECT", "CAPABILITY_CONTRACTS_HARDENED", "PUBLIC_DATA_FOUNDATION_HARDENED", "GOWM_V0_6_1_STABLE_CANDIDATE_COMPLETE"],
  cases
};
const output = process.env.GOWM_V061_FINAL_OUTPUT ?? "/tmp/gowm-v0.6.1-final-acceptance.json";
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`GOWM_V0_6_1_STABLE_CANDIDATE_COMPLETE cases=229 passed=229 blocked=0 failed=0 notRun=0 sha=${local} output=${output}\n`);

function requiredPath(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function git(args) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
function assertChecks(name, checks, expected) {
  if (checks === null || typeof checks !== "object" || Object.values(checks).some((value) => value !== true)) throw new Error(`${name} contains missing or failed checks`);
  const missing = expected.filter((key) => checks[key] !== true);
  if (missing.length > 0) throw new Error(`${name} is missing Required checks: ${missing.join(",")}`);
}
function assertSchemaEvidence(report) {
  const summary = report.summary ?? {};
  if (summary.migrations !== 57 || summary.assertions !== 42 || summary.fresh?.migrationCount !== 57 || summary.v04Upgrade?.upgradeMarker !== "v0.4-preserved" || summary.v05Upgrade?.upgradeMarker !== "v0.5-preserved" || summary.v06Upgrade?.upgradeMarker !== "v0.6.0-preserved" || summary.deliberateFailureRollback !== true) throw new Error("schema evidence does not prove fresh/v0.4/v0.5/v0.6/rollback requirements");
  if (Object.values(summary.checksumReplaySkips ?? {}).length !== 4 || !Object.values(summary.checksumReplaySkips).every((value) => value === 57) || !report.cleanup?.every((item) => item.status === "PASS")) throw new Error("schema replay or cleanup evidence is incomplete");
}
function assertCompatibilityEvidence(report) {
  if (report.migrationMatrix?.migrations !== 57 || report.migrationMatrix?.assertions !== 42 || report.contractFreeze?.status !== "PASS_EXACT_A01_BYTES" || report.resultReplay?.checks?.postgresRestartPersistence !== true) throw new Error("compatibility evidence is incomplete");
  const profiles = report.networkRoutePerformance?.currentCoverageProfiles ?? {};
  if (!(profiles.small?.elapsedMs < 10_000 && profiles.medium?.elapsedMs < 30_000 && profiles.small?.heapDeltaBytes < 128 * 1024 * 1024 && profiles.medium?.heapDeltaBytes < 128 * 1024 * 1024)) throw new Error("compatibility performance bounds are incomplete");
}
async function runStaticGates() {
  const testOutput = "/tmp/gowm-v061-final-vitest.json";
  const commands = [
    ["node", ["validation/scripts/gowm-v061-predecessor-guard.mjs"], "R00 predecessor byte lock: 53 migrations / 103 contract artifacts"],
    ["npm", ["run", "check"], "npm run check"],
    ["npm", ["run", "verify:sql"], "npm run verify:sql"],
    [resolve(root, "node_modules/.bin/vitest"), ["run", "--reporter=json", `--outputFile=${testOutput}`], "vitest run"],
    ["npm", ["--prefix", "services/stas", "test"], "npm --prefix services/stas test"],
    ["npm", ["run", "build"], "npm run build"],
    ["npm", ["run", "validate:provider-conformance"], "npm run validate:provider-conformance"]
  ];
  for (const [command, args, label] of commands) {
    process.stdout.write(`STATIC_GATE running: ${label}\n`);
    execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe", maxBuffer: 128 * 1024 * 1024 });
  }
  const tests = JSON.parse(await readFile(testOutput, "utf8"));
  if (!tests.success || tests.numFailedTests !== 0 || tests.numPassedTests < 264) throw new Error("full Vitest regression did not pass");
  const testFiles = new Map(tests.testResults.map((file) => [relative(root, file.name).replaceAll("\\", "/"), file]));
  const skipped = tests.testResults.flatMap((file) => file.assertionResults.filter((test) => test.status !== "passed").map((test) => ({ file: relative(root, file.name), name: test.fullName, status: test.status })));
  if (skipped.some((test) => test.file !== "tests/integration/database.test.ts" || !["pending", "skipped"].includes(test.status))) throw new Error(`unexpected skipped regression: ${JSON.stringify(skipped)}`);
  return { commands: commands.map(([, , label]) => label), testFiles, testSummary: { passed: tests.numPassedTests, failed: tests.numFailedTests, skipped, realDatabaseReplacement: evidencePaths.schema } };
}
