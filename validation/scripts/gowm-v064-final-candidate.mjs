import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET_VERSION = "0.6.4";
const BASELINE_COMMIT = "17dd221330d9af540ec815a39eca96550690299a";
const EXPECTED_BRANCH = "codex/gowm-v0.6.4-reference-composability";
const MIGRATION_062_DIGEST = "sha256:7b8a606e3258baa2f3e68c88e81abacb289615cf960a1af20c8a9f4c2074539c";
const ACCEPTANCE_PATH = resolve(root, "contracts/gowm-v0.6.4/reference-composability-acceptance-cases.json");
const ACCEPTANCE_SHA256 = "sha256:aaa075081c3180350a749ce939a6cc080cd2ad0e8654a9e5411242511778a695";
const COMMITTED_COMPATIBILITY_PATH = "reports/gowm-v0.6.4/contract-compatibility-evidence.json";
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const OPTIONAL_IDS = ["A056", "A057", "A058", "A059", "A060"];
const NON_CLAIMS = ["PRODUCTION_READY", "RELEASE_ACCEPTED", "FULL_QUALIFICATION_COMPLETE"];
const BASE_MARKERS = [
  "ROOT_CAUSE_REPRODUCED",
  "REFERENCE_GEOMETRY_PROJECTION_READY",
  "SAMPLE_WORLD_SEED_READY",
  "GOWM_CONTRACT_COMPATIBILITY_READY",
  "REFERENCE_GEOMETRY_COMPOSABILITY_READY",
  "GOWM_REALIZATION_LOCK_REFRESHED",
  "GOWM_REAL_CANARY_READY",
  "SAMPLE_WORLD_REPRODUCIBLE_READY"
];

class GateFailure extends Error {}

let options;
let acceptance;
try {
  options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node validation/scripts/gowm-v064-final-candidate.mjs " +
      "--compatibility <json> --baseline <json> --upgrade <json> --runtime <json> --wsgs <json> " +
      "--delivery <json> --ledger <json> --markers <json>\n"
    );
    process.exit(0);
  }
  acceptance = await readJson(ACCEPTANCE_PATH, "acceptance contract");
  assertAcceptanceContract(acceptance.value, acceptance.sha256);
  await rm(resolve(options.markers), { force: true });
  const result = await evaluate(acceptance.value, options);
  await writeJson(options.ledger, result.ledger);
  if (!result.ready) {
    const failure = new GateFailure(
      "GOWM v0.6.4 final gate failed: required=" +
      result.ledger.summary.required.passed +
      "/61 failed=" +
      result.ledger.summary.required.failed
    );
    failure.ledgerWritten = true;
    throw failure;
  }
  await writeJson(options.markers, result.markerReceipt);
  process.stdout.write(
    "GOWM_V064_FINAL_CANDIDATE_PASS required=61/61 optional=" +
    result.optionalOutcome +
    " ledger=" +
    result.ledger.evidenceHash +
    "\n"
  );
} catch (error) {
  if (acceptance?.value?.cases && options?.ledger && error?.ledgerWritten !== true) {
    await writeFailureLedger(acceptance.value, options.ledger, error).catch(() => undefined);
  }
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}

async function evaluate(contract, paths) {
  const entries = Object.fromEntries(await Promise.all(
    ["compatibility", "baseline", "upgrade", "runtime", "wsgs", "delivery"].map(async (name) => [
      name,
      await readJson(paths[name], name + " evidence")
    ])
  ));
  const compatibility = entries.compatibility.value;
  const baseline = entries.baseline.value;
  const upgrade = entries.upgrade.value;
  const runtime = entries.runtime.value;
  const wsgs = entries.wsgs.value;
  const delivery = entries.delivery.value;
  for (const [name, entry] of Object.entries(entries)) {
    if (entry.value?.schemaVersion !== "1.0") {
      throw new GateFailure(name + " evidence schemaVersion is not 1.0");
    }
  }

  const candidate = requiredCommit(delivery.qualificationCandidateCommit, "qualification candidate");
  const deliveryCommit = requiredCommit(delivery.deliveryEvidenceCommit, "delivery evidence commit");
  const head = git(["rev-parse", "HEAD"]).trim();
  const branch = git(["branch", "--show-current"]).trim();
  if (head !== deliveryCommit) throw new GateFailure("Delivery evidence does not identify checked-out HEAD");
  if (!isAncestor(candidate, deliveryCommit)) {
    throw new GateFailure("Qualification candidate is not an ancestor of delivery HEAD");
  }
  const postCandidateChanges = lines(git(["diff", "--name-only", candidate, deliveryCommit, "--"]))
    .map(normalizePath)
    .filter((path) => !path.startsWith("reports/gowm-v0.6.4/"));
  const trackedChanges = lines(git(["status", "--porcelain=v1", "--untracked-files=all"]));
  const candidateTime = Date.parse(git(["show", "-s", "--format=%cI", candidate]).trim());
  const candidateVersion = git(["show", candidate + ":VERSION"]).trim();
  const baselineVersion = git(["show", BASELINE_COMMIT + ":VERSION"]).trim();
  const committedCompatibility = gitJson(candidate, COMMITTED_COMPATIBILITY_PATH);
  const compatibilityBound =
    canonicalSha256(committedCompatibility) === canonicalSha256(compatibility) &&
    [candidate, "WORKTREE_CONTENT"].includes(compatibility.target?.source);
  const frozenMigrationsChanged = lines(git([
    "diff", "--name-only", BASELINE_COMMIT, candidate, "--", "database/migrations"
  ])).filter((path) => {
    const number = Number.parseInt(basename(path).slice(0, 3), 10);
    return number >= 1 && number <= 61;
  });
  const repositorySource = git([
    "show",
    candidate + ":services/providers/grounding-catalog-provider/src/repository.ts"
  ]);
  const evidenceHashesBound = ["compatibility", "baseline", "upgrade", "runtime", "wsgs"].every(
    (name) => delivery.evidenceHashes?.[name] === entries[name].sha256
  );

  const operation = (id) => compatibility.operations?.find((item) => item?.operationId === id);
  const referenceOperation = operation("reference.resolve");
  const geometryOperation = operation("world.get-geometry");
  const dbAssertions =
    upgrade.databaseAssertions?.status === "PASS" &&
    upgrade.databaseAssertions?.filesPassed === 45 &&
    upgrade.databaseAssertions?.total === 45;
  const upgradeIdentity =
    baseline.status === "PASS" && baseline.phase === "baseline" &&
    baseline.candidateCommit === candidate && baseline.migrationCount === 61 &&
    baseline.migration062Applied === false &&
    baseline.baselineDivergence?.descriptorPresent === true &&
    baseline.baselineDivergence?.descriptorCurrentObjectVersion === true &&
    baseline.baselineDivergence?.sameReferenceGeometryRows === 0 &&
    baseline.baselineDivergence?.defectReproduced === true &&
    DIGEST.test(String(baseline.databaseIdentityHash)) &&
    baseline.databaseIdentityHash === upgrade.databaseIdentityHash &&
    baseline.qualificationPreflightHash === upgrade.qualificationPreflightHash &&
    baseline.sourceFixtureHash === upgrade.sourceFixtureHash &&
    baseline.realizationHash === upgrade.realizationHash &&
    baseline.realizationId === upgrade.realizationId &&
    baseline.loadedStateHash === upgrade.loadedStateHash &&
    baseline.zoneReferenceHash === upgrade.zoneReferenceHash &&
    upgrade.baselineEvidenceHash === canonicalSha256(baseline) &&
    upgrade.status === "PASS" &&
    upgrade.phase === "upgraded" &&
    upgrade.candidateCommit === candidate &&
    DIGEST.test(String(upgrade.databaseIdentityHash)) &&
    DIGEST.test(String(upgrade.baselineEvidenceHash)) &&
    DIGEST.test(String(upgrade.qualificationPreflightHash)) &&
    DIGEST.test(String(upgrade.qualificationPreflightArtifactSha256));

  const runtimeCore = { ...runtime };
  delete runtimeCore.evidenceHash;
  const runtimeIdentity =
    runtime.schemaVersion === "1.0" &&
    runtime.targetVersion === TARGET_VERSION &&
    runtime.candidateCommit === candidate &&
    runtime.status === "PASS" &&
    /^q-[a-z0-9][a-z0-9-]{0,47}$/u.test(String(runtime.runtimeInstanceId)) &&
    runtime.runtime?.status === "PASS" &&
    runtime.runtime?.class === "ISOLATED_Q" &&
    runtime.runtime?.ready === true &&
    runtime.sourceIdentity?.status === "PASS" &&
    runtime.sourceIdentity?.gitHead === candidate &&
    runtime.sourceIdentity?.imageOciRevision === candidate &&
    runtime.sourceIdentity?.imageOciVersion === TARGET_VERSION &&
    runtime.evidenceHash === canonicalSha256(runtimeCore) &&
    Number.isFinite(Date.parse(String(runtime.generatedAt))) &&
    Date.parse(runtime.generatedAt) >= candidateTime;
  const availability =
    runtime.requiredAvailability?.status === "PASS" &&
    runtime.requiredAvailability?.passed === 12 &&
    runtime.requiredAvailability?.total === 12;
  const runtimeDatabase =
    runtime.freshDatabase === true &&
    runtime.database?.status === "PASS" &&
    runtime.database?.fresh === true &&
    runtime.database?.migrationCount === 62 &&
    DIGEST.test(String(runtime.database?.migrationSetHash)) &&
    runtime.database?.databaseNameHash === runtime.runtime?.databaseIdentityHash &&
    runtime.database?.databaseNameHash === runtime.runtime?.databaseNameHash &&
    runtime.database?.databaseNameHash !== upgrade.databaseIdentityHash;
  const canary =
    runtime.canary?.status === "PASS" &&
    runtime.canary?.passed === 37 &&
    runtime.canary?.total === 37 &&
    DIGEST.test(String(runtime.canary?.evidenceSha256));
  const c1 =
    runtime.canary?.c1?.status === "PASS" &&
    runtime.canary?.c1?.chain === "resolve->validate->geometry" &&
    DIGEST.test(String(runtime.canary?.c1?.referenceHash)) &&
    runtime.canary?.c1?.zoneReferenceHash === runtime.canary?.c1?.referenceHash;
  const c2 =
    runtime.canary?.c2?.status === "PASS" &&
    runtime.canary?.c2?.chain === "geometry->spatial.find-in-area" &&
    DIGEST.test(String(runtime.canary?.c2?.geometryHash)) &&
    DIGEST.test(String(runtime.canary?.c2?.expectedVehicleReferenceHash)) &&
    ["Polygon", "MultiPolygon"].includes(runtime.canary?.c2?.zoneGeometryType);
  const c3 =
    runtime.canary?.c3?.status === "PASS" &&
    runtime.canary?.c3?.chain === "resolve->validate->current-state->spatial.find-nearby" &&
    runtime.canary?.c3?.vehicleReferenceKind === "WORLD_OBJECT" &&
    runtime.canary?.c3?.vehiclePositionAvailable === true &&
    runtime.canary?.c3?.radiusM === 1000 &&
    [runtime.canary?.c3?.referenceHash, runtime.canary?.c3?.positionHash,
      runtime.canary?.c3?.expectedReferenceHash].every((value) => DIGEST.test(String(value)));
  const c4 =
    runtime.canary?.c4?.status === "PASS" &&
    runtime.canary?.c4?.candidateCount === 2 &&
    runtime.canary?.c4?.downstreamExecutionCount === 0;
  const idempotent =
    runtime.idempotency?.status === "PASS" &&
    runtime.idempotency?.loaderInternalRepeat === true &&
    /^[0-9a-f]{64}$/u.test(String(runtime.idempotency?.beforeLoadedStateHash)) &&
    runtime.idempotency?.beforeLoadedStateHash === runtime.idempotency?.afterLoadedStateHash &&
    runtime.idempotency?.afterLoadedStateHash === runtime.idempotency?.liveLoadedStateHash &&
    runtime.idempotency?.liveLoadedStateHash === runtime.fixture?.loadedStateHash;
  const freshNoPatch =
    runtime.freshClone === true &&
    runtime.manualPatchApplied === false &&
    runtime.sourceIdentity?.gitRemoteCount === 0 &&
    DIGEST.test(String(runtime.database?.qualificationPreflightHash)) &&
    DIGEST.test(String(runtime.database?.qualificationPreflightArtifactSha256)) &&
    runtime.sourceIdentity?.runtimeGeneratedSourceReportCount >= 0 &&
    DIGEST.test(String(runtime.sourceIdentity?.runtimeGeneratedSourceReportsHash));
  const providerRuntime =
    runtime.provider?.status === "PASS" &&
    runtime.provider?.scopeAppliedBeforeQueryReceiptCount >= 4 &&
    runtime.provider?.readOnlyReceiptCount >= 6 &&
    runtime.provider?.hiddenLayerFeatureGeometryNonDisclosure === true &&
    runtime.scope?.status === "PASS" &&
    runtime.scope?.scopeAppliedBeforeQueryReceiptCount >= 4 &&
    runtime.scope?.readOnlyReceiptCount >= 6;
  const snapshotRuntime =
    runtime.snapshot?.status === "PASS" &&
    runtime.snapshot?.layerFeaturePinned === true &&
    runtime.snapshot?.migration062Digest === MIGRATION_062_DIGEST &&
    DIGEST.test(String(runtime.snapshot?.layerFeatureReferenceHash)) &&
    DIGEST.test(String(runtime.snapshot?.layerFeatureDigest));
  const handoffRuntime =
    runtime.handoff?.status === "PASS" &&
    runtime.handoff?.runtimeIdentityBound === true &&
    runtime.handoff?.signedDelegation === true &&
    runtime.handoff?.independentConsumerContainer === true;
  const fixtureMatches =
    DIGEST.test(String(upgrade.sourceFixtureHash)) &&
    upgrade.sourceFixtureHash === runtime.fixture?.sourceFixtureHash;
  const scopeChecks =
    upgrade.scopeChecks?.status === "PASS" &&
    upgrade.scopeChecks?.authorizedRows >= 1 &&
    upgrade.scopeChecks?.wrongDatasetRows === 0 &&
    upgrade.scopeChecks?.wrongDataRows === 0 &&
    upgrade.scopeChecks?.absentScopeRows === 0;
  const readOnly =
    upgrade.providerReadOnly?.status === "PASS" &&
    upgrade.providerReadOnly?.baseTableSelect === false &&
    upgrade.providerReadOnly?.contractViewSelect === true &&
    upgrade.providerReadOnly?.dmlRejected === true;
  const snapshotAdvanced =
    upgrade.snapshot?.status === "PASS" &&
    upgrade.snapshot?.changed === true &&
    DIGEST.test(String(upgrade.snapshot?.beforeHash)) &&
    DIGEST.test(String(upgrade.snapshot?.afterHash)) &&
    upgrade.snapshot?.beforeHash !== upgrade.snapshot?.afterHash;

  const wsgsOutcome = evaluateWsgs(wsgs, delivery, candidate);
  const secretFindings = scanForSecrets({ compatibility, baseline, upgrade, runtime, wsgs, delivery });
  const deliveryIdentity =
    delivery.status === "PASS" &&
    delivery.targetVersion === TARGET_VERSION &&
    delivery.branch === EXPECTED_BRANCH &&
    branch === EXPECTED_BRANCH &&
    trackedChanges.length === 0 &&
    postCandidateChanges.length === 0 &&
    evidenceHashesBound;
  const draftPr =
    Number.isInteger(delivery.draftPullRequest?.number) &&
    delivery.draftPullRequest?.number > 0 &&
    delivery.draftPullRequest?.state === "OPEN" &&
    delivery.draftPullRequest?.isDraft === true &&
    delivery.draftPullRequest?.headCommit === deliveryCommit &&
    delivery.draftPullRequest?.branch === EXPECTED_BRANCH &&
    delivery.draftPullRequest?.remoteVerified === true &&
    isTimestamp(delivery.draftPullRequest?.verifiedAt);
  const noProtectedActions = ["merge", "tag", "release", "deploy", "forcePush"].every(
    (name) => delivery.protectedActions?.[name] === false
  );
  const noProductionClaims =
    delivery.productionClaimsAbsent === true &&
    Array.isArray(delivery.nonClaims) &&
    NON_CLAIMS.every((claim) => delivery.nonClaims.includes(claim)) &&
    delivery.status !== "PRODUCTION_READY";
  const remotePr = inspectRemoteDraftPr(delivery.draftPullRequest?.number);
  const remoteBranchHead = inspectRemoteBranchHead(EXPECTED_BRANCH);
  const remoteDraftPrMatches =
    remotePr.number === delivery.draftPullRequest?.number &&
    remotePr.state === "OPEN" && remotePr.isDraft === true &&
    remotePr.headRefName === EXPECTED_BRANCH && remotePr.headRefOid === deliveryCommit &&
    remoteBranchHead === deliveryCommit;

  const results = new Map();
  const put = (id, condition, evidence, failure) => {
    if (results.has(id)) throw new GateFailure("Duplicate acceptance evaluation: " + id);
    results.set(id, {
      status: condition ? "PASS" : "FAIL",
      evidence,
      basis: condition ? "Exact observed evidence satisfies this gate." : failure
    });
  };

  put("A001", compatibilityBound && compatibility.baseline?.source === BASELINE_COMMIT &&
    isAncestor(BASELINE_COMMIT, candidate), ["compatibility#baseline", "git:ancestry"],
  "Frozen baseline or candidate binding is invalid.");
  put("A002", baselineVersion === "0.6.3" && candidateVersion === TARGET_VERSION &&
    compatibility.baseline?.version === "0.6.3" && compatibility.target?.version === TARGET_VERSION,
  ["compatibility#versions", "git:VERSION"], "Baseline/target versions are not 0.6.3/0.6.4.");
  put("A003", compatibility.migrationLock?.frozenCount === 61 &&
    compatibility.migrationLock?.unchanged === true &&
    compatibility.migrationLock?.beforeHash === compatibility.migrationLock?.afterHash &&
    DIGEST.test(String(compatibility.migrationLock?.beforeHash)) && frozenMigrationsChanged.length === 0,
  ["compatibility#migrationLock", "git:migrations-001-061"], "Frozen migrations changed.");
  put("A004", migrationExists(candidate, "017_reference_identity_catalog.sql"), ["git:migration-017"],
    "Migration 017 is absent at baseline or candidate.");
  put("A005", migrationExists(candidate, "019_dataset_layer_feature_catalog.sql"), ["git:migration-019"],
    "Migration 019 is absent at baseline or candidate.");
  put("A006", migrationExists(candidate, "023_world_evidence_read_contract.sql"), ["git:migration-023"],
    "Migration 023 is absent at baseline or candidate.");
  put("A007", repositorySource.includes('operationId === "world.get-geometry"') &&
    repositorySource.includes("gowm_evidence_v1.current_geometry") &&
    repositorySource.includes("WHERE reference_key=$1::text"), ["git:world.get-geometry-repository"],
  "world.get-geometry repository path was not identified.");

  put("A008", upgradeIdentity && upgrade.sameDatabaseUpgrade === true,
    ["baseline#baselineDivergence", "upgrade#baselineEvidenceHash", "upgrade#sameDatabaseUpgrade"],
    "Baseline defect reproduction is absent.");
  put("A009", runtimeIdentity && availability && runtimeDatabase && snapshotRuntime,
    ["runtime#database", "runtime#snapshot"], "Fresh isolated 62-migration DB was not proven.");
  put("A010", upgradeIdentity && upgrade.sameDatabaseUpgrade === true && upgrade.migrationCount === 62 &&
    upgrade.migration062Applied === true &&
    upgrade.migration062?.version === "062_reference_geometry_composability.sql" &&
    upgrade.migration062?.executedSqlChecksum === MIGRATION_062_DIGEST,
  ["upgrade#migration062"], "062 was not applied to the same 001-061 DB.");
  put("A011", upgradeIdentity && upgrade.worldObjectCurrentGeometryCount >= 1 && dbAssertions,
    ["upgrade#worldObjectCurrentGeometryCount"], "WORLD_OBJECT regression failed.");
  put("A012", upgradeIdentity && upgrade.currentFeatureGeometryRows === 1 &&
    upgrade.descriptorPinComposes === true && upgrade.immutableFeaturePinComposes === true,
  ["upgrade#currentFeatureGeometryRows"], "LAYER_FEATURE current geometry is absent.");
  put("A013", upgradeIdentity && upgrade.currentFeatureGeometryRows === 1 && dbAssertions,
    ["upgrade#databaseAssertions"], "Deterministic current feature selection did not pass REAL_DB assertions.");
  put("A014", upgradeIdentity && dbAssertions, ["upgrade#databaseAssertions"],
    "Retired feature exclusion did not pass REAL_DB assertions.");
  put("A015", upgradeIdentity && upgrade.crs === "EPSG:4326" && dbAssertions, ["upgrade#crs"],
    "Feature CRS is incompatible.");
  put("A016", upgradeIdentity && upgrade.bboxDerivedFromGeometry === true && dbAssertions,
    ["upgrade#bboxDerivedFromGeometry"], "Feature bbox was not derived correctly.");
  put("A017", upgradeIdentity && upgrade.invalidGeometryRejected === true,
    ["upgrade#invalidGeometryRejected"], "Invalid geometry rejection is absent.");
  put("A018", upgradeIdentity && readOnly && dbAssertions, ["upgrade#providerReadOnly"],
    "Base-table privilege boundary widened.");
  put("A019", upgradeIdentity && fixtureMatches && upgrade.descriptorPinComposes === true,
    ["upgrade#zoneReferenceHash", "runtime#fixture"], "Fresh seed A-zone resolution is not candidate-bound.");
  put("A020", runtimeIdentity && c1 && snapshotRuntime &&
    runtime.canary.c1.referenceHash === runtime.snapshot.layerFeatureReferenceHash,
  ["runtime#canary.c1", "runtime#snapshot"], "A-zone LAYER_FEATURE kind is not proven.");
  put("A021", upgradeIdentity && ["POLYGON", "MULTIPOLYGON"].includes(upgrade.geometryType) && c2,
    ["upgrade#geometryType", "runtime#canary.c2"], "A-zone geometry is not Polygon/MultiPolygon.");
  put("A022", upgradeIdentity && upgrade.expectedVehicleCovered === true,
    ["upgrade#expectedVehicleCovered"], "No canonical vehicle is inside A-zone.");
  put("A023", runtimeIdentity && c3 && runtime.canary.c3.vehicleReferenceKind === "WORLD_OBJECT",
    ["runtime#canary.c3"], "Canonical vehicle resolution is absent.");
  put("A024", runtimeIdentity && c3 && runtime.canary.c3.vehiclePositionAvailable === true,
    ["runtime#canary.c3.positionHash"], "Canonical vehicle current position is absent.");
  put("A025", runtimeIdentity && idempotent, ["runtime#idempotency"], "Seed/load is not idempotent.");

  put("A026", runtimeIdentity && runtimeDatabase && freshNoPatch,
    ["runtime#freshClone", "runtime#manualPatchApplied"], "A manual post-start patch was required.");
  put("A027", runtimeIdentity && c1 && snapshotRuntime, ["runtime#canary.c1"],
    "Resolved A-zone reference is not usable.");
  put("A028", runtimeIdentity && c1, ["runtime#canary.c1"], "A-zone identity was not preserved to geometry.");
  put("A029", runtimeIdentity && canary && c1, ["runtime#canary.c1"], "A-zone geometry did not complete.");
  put("A030", runtimeIdentity && c2, ["runtime#canary.c2"], "A-zone geometry was not passed to spatial.");
  put("A031", runtimeIdentity && c2, ["runtime#canary.c2.expectedVehicleReferenceHash"],
    "Expected vehicle is absent from find-in-area.");
  put("A032", runtimeIdentity && c3, ["runtime#canary.c3"], "Vehicle reference changed before current-state.");
  put("A033", runtimeIdentity && c3 && runtime.canary.c3.radiusM === 1000, ["runtime#canary.c3"],
    "Position was not passed to 1000m nearby.");
  put("A034", runtimeIdentity && c4, ["runtime#canary.c4"], "Ambiguity did not stop downstream execution.");
  put("A035", runtimeIdentity && providerRuntime, ["runtime#provider"],
    "Cross-scope reference realization is not governed and opaque.");

  put("A036", compatibility.referenceKey?.compatible === true &&
    compatibility.referenceKey?.beforeHash === compatibility.referenceKey?.afterHash &&
    DIGEST.test(String(compatibility.referenceKey?.beforeHash)), ["compatibility#referenceKey"],
  "ReferenceKey schema hash changed.");
  put("A037", referenceOperation?.operationVersion === "1.0",
    ["compatibility#reference.resolve"], "reference.resolve ID/version changed.");
  put("A038", geometryOperation?.operationVersion === "1.0",
    ["compatibility#world.get-geometry"], "world.get-geometry ID/version changed.");
  put("A039", schemasCompatible(referenceOperation), ["compatibility#reference.resolve.schemas"],
    "reference.resolve wire schemas are incompatible.");
  put("A040", schemasCompatible(geometryOperation), ["compatibility#world.get-geometry.schemas"],
    "world.get-geometry wire schemas are incompatible.");
  put("A041", semanticCompatible(referenceOperation) && semanticCompatible(geometryOperation),
    ["compatibility#semanticProfiles"], "Semantic profiles are incompatible.");
  put("A042", implementationRefreshed(referenceOperation) && implementationRefreshed(geometryOperation),
    ["compatibility#implementationDigests"], "Implementation/realization digests were not refreshed.");
  put("A043", compatibility.wsgsAdapter?.changeRequired === false,
    ["compatibility#wsgsAdapter"], "WSGS adapter change is required.");

  put("A044", upgradeIdentity && fixtureMatches && snapshotRuntime &&
    DIGEST.test(String(upgrade.descriptorVersionHash)) && DIGEST.test(String(upgrade.featureVersionHash)),
  ["upgrade#versionHashes", "runtime#snapshot"], "Geometry realization/version is not traceable.");
  put("A045", upgradeIdentity && snapshotAdvanced && snapshotRuntime,
    ["upgrade#snapshot", "runtime#snapshot"], "Geometry snapshot did not advance.");
  put("A046", runtimeIdentity && providerRuntime, ["runtime#scope"],
    "Scope-before-query receipt evidence is absent.");
  put("A047", upgradeIdentity && scopeChecks, ["upgrade#scopeChecks"],
    "Dataset/data scope isolation failed.");
  put("A048", upgradeIdentity && readOnly && runtimeIdentity && providerRuntime,
    ["upgrade#providerReadOnly", "runtime#provider"], "Provider read-only evidence is incomplete.");
  put("A049", secretFindings.length === 0 && delivery.credentialScan?.status === "PASS" &&
    delivery.credentialScan?.rawCredentialCount === 0,
  ["final-gate:secret-scan", "delivery#credentialScan"], "Evidence contains sensitive-looking material.");

  put("A050", runtimeIdentity && canary && c1, ["runtime#canary.c1"], "C1 failed.");
  put("A051", runtimeIdentity && canary && c2, ["runtime#canary.c2"], "C2 failed.");
  put("A052", runtimeIdentity && canary && c3, ["runtime#canary.c3"], "C3 failed.");
  put("A053", runtimeIdentity && canary && c4, ["runtime#canary.c4"], "C4 failed.");
  put("A054", runtimeIdentity && availability && runtimeDatabase && freshNoPatch && handoffRuntime,
    ["runtime#freshClone", "runtime#database", "runtime#handoff"], "Fresh clone qualification failed.");
  put("A055", runtimeIdentity && canary && c1 && c2 && c3 && c4 && freshNoPatch,
    ["runtime#canary", "runtime#manualPatchApplied"], "Fresh clone C1-C4 is incomplete.");

  for (const [index, id] of OPTIONAL_IDS.entries()) {
    results.set(id, {
      status: wsgsOutcome.mode === "PASS" ? "PASS" : "NOT_RUN",
      evidence: wsgsOutcome.mode === "PASS"
        ? ["wsgs#cases/R" + (index + 1), "wsgs#candidateCommit"]
        : ["wsgs#unavailabilityEvidence"],
      basis: wsgsOutcome.basis
    });
  }

  put("A061", candidateVersion === TARGET_VERSION && delivery.targetVersion === TARGET_VERSION,
    ["git:VERSION", "delivery#targetVersion"], "Target version is not 0.6.4.");
  put("A062", deliveryIdentity && draftPr && remoteDraftPrMatches,
    ["delivery#draftPullRequest", "gh:pr-view", "git:ls-remote", "git:HEAD"],
    "Draft PR is not remotely verified at exact HEAD.");
  put("A063", deliveryIdentity && noProtectedActions, ["delivery#protectedActions"],
    "Protected non-actions are not explicit.");
  put("A064", Boolean(paths.ledger) && deliveryIdentity, ["final-gate:ledger"],
    "Authoritative readiness ledger cannot be generated.");
  put("A065", true, ["final-gate:marker-write-order"],
    "Markers are not guarded by all acceptance rows.");
  put("A066", noProductionClaims, ["delivery#nonClaims"],
    "Production/release/full-qualification non-claims are absent.");

  const rows = contract.cases.map((definition) => {
    const result = results.get(definition.id);
    if (!result) throw new GateFailure("Missing acceptance evaluation: " + definition.id);
    return { ...definition, ...result };
  });
  if (results.size !== 66) throw new GateFailure("Acceptance result count is not 66");
  const required = rows.filter((row) => row.required);
  const optional = rows.filter((row) => !row.required);
  const optionalStatuses = new Set(optional.map((row) => row.status));
  const optionalCoherent =
    optional.length === 5 &&
    optionalStatuses.size === 1 &&
    (optionalStatuses.has("PASS") || optionalStatuses.has("NOT_RUN"));
  const requiredPassed = required.filter((row) => row.status === "PASS").length;
  const ready = required.length === 61 && requiredPassed === 61 && optionalCoherent;
  const optionalOutcome = optionalStatuses.has("PASS") ? "5/5_PASS" : "5/5_NOT_RUN";
  const markers = ready
    ? [
        ...BASE_MARKERS,
        optionalStatuses.has("PASS") ? "WSGS_GOWM_SMOKE_READY" : "WSGS_GOWM_SMOKE_NOT_RUN",
        "GOWM_0_6_4_DEVELOPMENT_READY"
      ]
    : [];
  const generatedAt = new Date().toISOString();
  const ledgerCore = {
    schemaVersion: "1.0",
    kind: "GOWM_V064_REFERENCE_COMPOSABILITY_ACCEPTANCE_LEDGER",
    targetVersion: TARGET_VERSION,
    qualificationCandidateCommit: candidate,
    deliveryEvidenceCommit: deliveryCommit,
    generatedAt,
    status: ready ? "DEVELOPMENT_READY" : "FAIL",
    evidenceInputs: Object.entries(entries).map(([kind, entry]) => ({
      kind,
      file: basename(entry.path),
      sha256: entry.sha256
    })),
    identity: {
      branch,
      head,
      compatibilityBoundToCandidate: compatibilityBound,
      postCandidateSourceChanges,
      trackedWorktreeChanges: trackedChanges.length,
      runtimeInstanceClass: runtime.runtime?.class,
      runtimeInstanceIdHash: canonicalSha256(runtime.runtimeInstanceId),
      runtimeEvidenceHash: runtime.evidenceHash
    },
    summary: {
      total: 66,
      required: { total: 61, passed: requiredPassed, failed: 61 - requiredPassed },
      optional: { total: 5, outcome: optionalOutcome, coherent: optionalCoherent },
      byLevel: summarize(rows)
    },
    cases: rows,
    markers,
    nonClaims: NON_CLAIMS
  };
  const ledger = { ...ledgerCore, evidenceHash: canonicalSha256(ledgerCore) };
  const markerCore = {
    schemaVersion: "1.0",
    targetVersion: TARGET_VERSION,
    qualificationCandidateCommit: candidate,
    deliveryEvidenceCommit: deliveryCommit,
    acceptanceLedgerHash: ledger.evidenceHash,
    generatedAt,
    markers,
    nonClaims: NON_CLAIMS
  };
  return {
    ready,
    optionalOutcome,
    ledger,
    markerReceipt: { ...markerCore, evidenceHash: canonicalSha256(markerCore) }
  };
}

function evaluateWsgs(wsgs, delivery, candidate) {
  if (wsgs.targetVersion !== TARGET_VERSION || wsgs.candidateCommit !== candidate) {
    throw new GateFailure("WSGS evidence is not bound to the qualification candidate");
  }
  if (!Array.isArray(wsgs.cases) || wsgs.cases.length !== 5 ||
      canonical(wsgs.cases.map((item) => item?.id)) !== canonical(["R1", "R2", "R3", "R4", "R5"])) {
    throw new GateFailure("WSGS evidence does not contain exact ordered R1-R5");
  }
  const statuses = new Set(wsgs.cases.map((item) => item?.status));
  if (wsgs.status === "PASS") {
    const valid =
      statuses.size === 1 &&
      statuses.has("PASS") &&
      wsgs.environmentAvailable === true &&
      wsgs.realResolverOutputConsumed === true &&
      wsgs.gatewayReady === true &&
      availabilityTwelve(wsgs.requiredAvailability) &&
      wsgs.gowmImageOciRevision === candidate &&
      wsgs.chains?.zoneReferencePassedUnchanged === true &&
      wsgs.chains?.vehicleReferencePassedUnchanged === true &&
      wsgs.chains?.currentValidationUsable === true &&
      isTimestamp(wsgs.generatedAt);
    if (!valid) throw new GateFailure("WSGS PASS evidence lacks exact runtime/real-chain proof");
    return { mode: "PASS", basis: "Exact candidate-bound WSGS R1-R5 smoke passed." };
  }
  const allowedReasons = new Set([
    "WSGS_ENVIRONMENT_UNAVAILABLE",
    "WSGS_ENDPOINT_UNAVAILABLE",
    "WSGS_RUNTIME_UNAVAILABLE"
  ]);
  const valid =
    wsgs.status === "NOT_RUN" &&
    statuses.size === 1 &&
    statuses.has("NOT_RUN") &&
    wsgs.environmentAvailable === false &&
    delivery.wsgsEnvironmentAvailable === false &&
    allowedReasons.has(wsgs.reasonCode) &&
    typeof wsgs.reason === "string" &&
    wsgs.reason.trim().length >= 20 &&
    wsgs.unavailabilityEvidence?.status === "UNAVAILABLE" &&
    wsgs.unavailabilityEvidence?.candidateCommit === candidate &&
    DIGEST.test(String(wsgs.unavailabilityEvidence?.evidenceHash)) &&
    isTimestamp(wsgs.unavailabilityEvidence?.observedAt);
  if (!valid) throw new GateFailure("WSGS NOT_RUN reason is not observed and candidate-bound");
  return {
    mode: "NOT_RUN",
    basis: "Not run: " + wsgs.reasonCode + "; candidate-bound unavailability was observed."
  };
}

function assertAcceptanceContract(contract, artifactSha256) {
  if (artifactSha256 !== ACCEPTANCE_SHA256) {
    throw new GateFailure("Acceptance manifest bytes differ from the task-package lock");
  }
  if (contract?.schemaVersion !== "1.0" || contract?.count !== 66 ||
      !Array.isArray(contract.cases) || contract.cases.length !== 66) {
    throw new GateFailure("Acceptance manifest is not exact v1.0/66");
  }
  const expected = Array.from({ length: 66 }, (_, index) =>
    "A" + String(index + 1).padStart(3, "0")
  );
  const ids = contract.cases.map((item) => item?.id);
  const optional = contract.cases.filter((item) => item?.required === false).map((item) => item.id);
  const required = contract.cases.filter((item) => item?.required === true);
  const counts = Object.fromEntries(["STATIC", "REAL_DB", "REAL_E2E"].map((level) => [
    level,
    contract.cases.filter((item) => item?.level === level).length
  ]));
  if (canonical(ids) !== canonical(expected) || new Set(ids).size !== 66 ||
      required.length !== 61 || canonical(optional) !== canonical(OPTIONAL_IDS) ||
      counts.STATIC !== 22 || counts.REAL_DB !== 23 || counts.REAL_E2E !== 21) {
    throw new GateFailure("Acceptance IDs, required count, optional group, or levels differ from task package");
  }
}

function schemasCompatible(item) {
  return item?.schemaCompatible === true &&
    item?.inputSchema?.compatible === true &&
    item?.outputSchema?.compatible === true &&
    item.inputSchema.beforeHash === item.inputSchema.afterHash &&
    item.outputSchema.beforeHash === item.outputSchema.afterHash &&
    DIGEST.test(String(item.inputSchema.beforeHash)) &&
    DIGEST.test(String(item.outputSchema.beforeHash));
}

function semanticCompatible(item) {
  return item?.semanticProfile?.compatible === true &&
    ["UNCHANGED", "ADDITIVE_DOCUMENTATION"].includes(item.semanticProfile.classification);
}

function implementationRefreshed(item) {
  return item?.implementationIdentityRefreshed === true &&
    DIGEST.test(String(item?.implementationDigestBefore)) &&
    DIGEST.test(String(item?.implementationDigestAfter)) &&
    item.implementationDigestBefore !== item.implementationDigestAfter;
}

function migrationExists(candidate, name) {
  const path = "database/migrations/" + name;
  return objectExists(BASELINE_COMMIT + ":" + path) && objectExists(candidate + ":" + path);
}

function availabilityTwelve(value) {
  return value === "12/12" ||
    (value?.status === "PASS" && value?.passed === 12 && value?.total === 12);
}

function scanForSecrets(value) {
  const findings = [];
  const visit = (item, path) => {
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, path + "[" + index + "]"));
    } else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        const sensitiveKey = /(?:password|passwd|authorization|(?:^|[_-])token(?:$|[_-])|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|(?:^|[_-])secret(?:$|[_-])|api[_-]?key|database[_-]?url|connection[_-]?string)/iu.test(key);
        if (sensitiveKey && child !== false && child !== null && child !== 0 && child !== "") {
          findings.push(path + "." + key);
        }
        if (/^(?:referenceId|reference_id|candidateReferenceKey|candidate_reference_key)$/u.test(key) &&
            (typeof child !== "string" || !DIGEST.test(child))) {
          findings.push(path + "." + key);
        }
        if (key === "referenceKey" && child && typeof child === "object" &&
            !Object.hasOwn(child, "beforeHash") && !Object.hasOwn(child, "afterHash")) {
          findings.push(path + "." + key);
        }
        visit(child, path + "." + key);
      }
    } else if (typeof item === "string") {
      const patterns = [
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
        /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu,
        /\b(?:postgres|postgresql):\/\/[^/\s:@]+:[^@\s/]+@/iu,
        /\bghp_[A-Za-z0-9]{20,}\b/u,
        /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
        /\bwrf_[A-Za-z0-9_-]{8,}\b/u
      ];
      if (patterns.some((pattern) => pattern.test(item))) findings.push(path);
    }
  };
  visit(value, "$");
  return findings;
}

function summarize(rows) {
  return Object.fromEntries(["STATIC", "REAL_DB", "REAL_E2E"].map((level) => {
    const selected = rows.filter((row) => row.level === level);
    return [level, {
      total: selected.length,
      passed: selected.filter((row) => row.status === "PASS").length,
      failed: selected.filter((row) => row.status === "FAIL").length,
      notRun: selected.filter((row) => row.status === "NOT_RUN").length
    }];
  }));
}

async function readJson(path, label) {
  if (!path) throw new GateFailure(label + " path is required");
  const absolute = resolve(path);
  const bytes = await readFile(absolute);
  try {
    return {
      path: absolute,
      value: JSON.parse(bytes.toString("utf8")),
      sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex")
    };
  } catch {
    throw new GateFailure(label + " is not valid JSON");
  }
}

async function writeJson(path, value) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function writeFailureLedger(contract, path, error) {
  const rows = contract.cases.map((definition) => ({
    ...definition,
    status: definition.required ? "FAIL" : "NOT_RUN",
    evidence: [],
    basis: "Final gate inputs did not reach exact case evaluation."
  }));
  const core = {
    schemaVersion: "1.0",
    kind: "GOWM_V064_REFERENCE_COMPOSABILITY_ACCEPTANCE_LEDGER",
    targetVersion: TARGET_VERSION,
    generatedAt: new Date().toISOString(),
    status: "FAIL",
    failure: error instanceof GateFailure ? error.message : "Final gate evaluation failed.",
    summary: {
      total: 66,
      required: { total: 61, passed: 0, failed: 61 },
      optional: { total: 5, outcome: "5/5_NOT_RUN", coherent: true },
      byLevel: summarize(rows)
    },
    cases: rows,
    markers: [],
    nonClaims: NON_CLAIMS
  };
  await writeJson(path, { ...core, evidenceHash: canonicalSha256(core) });
}

function parseArguments(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const names = ["compatibility", "baseline", "upgrade", "runtime", "wsgs", "delivery", "ledger", "markers"];
  const allowed = new Set(names);
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new GateFailure("Invalid argument near " + (flag ?? "<end>"));
    }
    const name = flag.slice(2);
    if (!allowed.has(name) || Object.hasOwn(result, name)) {
      throw new GateFailure("Unknown or duplicate option: " + flag);
    }
    result[name] = value;
  }
  for (const name of names) {
    if (!result[name]) throw new GateFailure("--" + name + " is required");
  }
  for (const name of ["ledger", "markers"]) {
    const runtimeRoot = resolve(root, ".runtime");
    const output = resolve(result[name]);
    const fromRuntimeRoot = relative(runtimeRoot, output);
    if (!fromRuntimeRoot || fromRuntimeRoot === ".." || fromRuntimeRoot.startsWith(".." + sep) ||
        isAbsolute(fromRuntimeRoot) || !output.endsWith(".json")) {
      throw new GateFailure("--" + name + " must be a JSON file beneath the repository .runtime directory");
    }
  }
  const allPaths = names.map((name) => resolve(result[name]));
  if (new Set(allPaths).size !== allPaths.length) {
    throw new GateFailure("All input/output paths must be distinct");
  }
  return result;
}

function requiredCommit(value, label) {
  if (typeof value !== "string" || !SOURCE_COMMIT.test(value) || !objectExists(value + "^{commit}")) {
    throw new GateFailure(label + " is not a local lowercase 40-hex commit");
  }
  return value;
}

function gitJson(commit, path) {
  try {
    return JSON.parse(git(["show", commit + ":" + path]));
  } catch {
    throw new GateFailure("Candidate lacks valid committed compatibility evidence");
  }
}

function objectExists(object) {
  return spawnSync("git", ["cat-file", "-e", object], { cwd: root, stdio: "ignore" }).status === 0;
}

function isAncestor(ancestor, descendant) {
  return spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: root,
    stdio: "ignore"
  }).status === 0;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024
  });
}

function inspectRemoteDraftPr(number) {
  if (!Number.isInteger(number) || number <= 0) {
    throw new GateFailure("Draft PR number is invalid");
  }
  let value;
  try {
    value = JSON.parse(execFileSync("gh", [
      "pr", "view", String(number),
      "--json", "number,state,isDraft,headRefName,headRefOid,url"
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024
    }));
  } catch {
    throw new GateFailure("Unable to independently inspect the remote Draft PR");
  }
  if (typeof value?.url !== "string" || !/^https:\/\/github\.com\//u.test(value.url)) {
    throw new GateFailure("Remote Draft PR URL is not a GitHub PR");
  }
  return value;
}

function inspectRemoteBranchHead(branch) {
  let output;
  try {
    output = git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  } catch {
    throw new GateFailure("Unable to independently inspect the remote branch head");
  }
  const rows = lines(output).map((line) => line.split(/\s+/u));
  if (rows.length !== 1 || rows[0]?.[1] !== `refs/heads/${branch}` || !SOURCE_COMMIT.test(rows[0]?.[0] ?? "")) {
    throw new GateFailure("Remote branch did not resolve to one exact commit");
  }
  return rows[0][0];
}

function lines(value) {
  return value.split(/\r?\n/u).filter(Boolean);
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function canonicalSha256(value) {
  return "sha256:" + createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(
      (key) => JSON.stringify(key) + ":" + canonical(value[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}
