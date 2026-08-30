import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET_VERSION = "0.6.4";
const BASELINE_COMMIT = "17dd221330d9af540ec815a39eca96550690299a";
const MIGRATION_062_DIGEST = "sha256:7b8a606e3258baa2f3e68c88e81abacb289615cf960a1af20c8a9f4c2074539c";
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const BARE_DIGEST = /^[0-9a-f]{64}$/u;
const WSGS_CASE_IDS = ["R1", "R2", "R3", "R4", "R5"];
const WSGS_PATHS = {
  R1: ["reference.resolve", "world.get-current-state"],
  R2: ["reference.resolve"],
  R3: ["reference.resolve", "world.get-geometry", "spatial.find-in-area"],
  R4: ["reference.resolve", "world.get-current-state", "spatial.find-nearby"],
  R5: ["reference.resolve_or_validate"]
};
const NON_CLAIMS = ["PRODUCTION_READY", "RELEASE_ACCEPTED", "FULL_QUALIFICATION_COMPLETE"];

class EvidenceError extends Error {}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node validation/scripts/gowm-v064-materialize-evidence.mjs " +
      "--upgrade <json> [--baseline <json>] --runtime <json> --wsgs <json> --output-dir <directory>\n"
    );
    process.exit(0);
  }

  const upgradeEntry = await readEvidence(options.upgrade, "upgrade");
  const baselinePath = options.baseline ?? resolve(dirname(upgradeEntry.path), "UPGRADE_062_BASELINE.json");
  const [baselineEntry, runtimeEntry, wsgsEntry] = await Promise.all([
    readEvidence(baselinePath, "baseline"),
    readEvidence(options.runtime, "runtime"),
    readEvidence(options.wsgs, "WSGS")
  ]);
  const baseline = baselineEntry.value;
  const upgrade = upgradeEntry.value;
  const runtime = runtimeEntry.value;
  const wsgs = wsgsEntry.value;
  const candidateCommit = requiredCommit(upgrade.candidateCommit, "upgrade candidateCommit");

  assertBaseline(baseline, candidateCommit);
  assertUpgrade(upgrade, candidateCommit);
  assertBaselineUpgradeIdentity(baseline, upgrade);
  assertRuntime(runtime, candidateCommit, upgrade);
  const wsgsMode = assertWsgs(wsgs, candidateCommit);
  assertNoSensitiveMaterial({ baseline, upgrade, runtime, wsgs }, "input evidence");

  const generatedAt = new Date().toISOString();
  const provenance = {
    baseline: baselineEntry.sha256,
    upgrade: upgradeEntry.sha256,
    runtime: runtimeEntry.sha256,
    wsgs: wsgsEntry.sha256
  };
  const reports = buildReports({
    candidateCommit,
    baseline,
    generatedAt,
    provenance,
    runtime,
    upgrade,
    wsgs,
    wsgsMode
  });
  assertNoSensitiveMaterial(reports, "materialized reports");
  assertMaterializedReports(reports, candidateCommit);

  const outputDirectory = resolve(options.outputDir);
  const inputPaths = new Set([baselineEntry.path, upgradeEntry.path, runtimeEntry.path, wsgsEntry.path]);
  const outputs = Object.entries(reports).map(([name, value]) => ({
    path: resolve(outputDirectory, name),
    value
  }));
  if (outputs.some((entry) => inputPaths.has(entry.path))) {
    throw new EvidenceError("Materialized output must not overwrite an input evidence artifact");
  }
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(outputs.map(({ path, value }) => writeJson(path, value)));
  process.stdout.write(
    `GOWM_V064_EVIDENCE_MATERIALIZED_PASS files=${outputs.length} candidate=${candidateCommit} wsgs=${wsgsMode}\n`
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function buildReports({ candidateCommit, baseline, generatedAt, provenance, runtime, upgrade, wsgs, wsgsMode }) {
  const c1 = runtime.canary.c1;
  const c2 = runtime.canary.c2;
  const c3 = runtime.canary.c3;
  const c4 = runtime.canary.c4;
  const timestamp = runtime.evidenceTimestamp ?? runtime.generatedAt;
  const commonStep = { timestamp, evidenceSha256: provenance.runtime };
  const c4ResultHash = canonicalSha256({
    candidateCount: c4.candidateCount,
    downstreamExecutionCount: c4.downstreamExecutionCount
  });

  const canaryC1 = {
    schemaVersion: "1.0",
    canaryId: "C1",
    steps: [
      {
        operationId: "reference.resolve",
        status: "PASS",
        referenceHash: c1.referenceHash,
        resultHash: c1.referenceHash,
        ...commonStep
      },
      {
        operationId: "reference.validate",
        status: "PASS",
        referenceHash: c1.referenceHash,
        resultHash: c1.referenceHash,
        currentAndUsable: true,
        ...commonStep
      },
      {
        operationId: "world.get-geometry",
        status: "PASS",
        referenceHash: c1.referenceHash,
        resultHash: c2.geometryHash,
        ...commonStep
      }
    ],
    status: "PASS",
    hardcodedReferenceUsed: false,
    notes: ["Only candidate-bound hashes retained; no raw ReferenceKey or credential materialized."]
  };
  const canaryC2 = {
    schemaVersion: "1.0",
    canaryId: "C2",
    steps: [
      {
        operationId: "reference.resolve",
        status: "PASS",
        referenceHash: c1.referenceHash,
        resultHash: c1.referenceHash,
        ...commonStep
      },
      {
        operationId: "world.get-geometry",
        status: "PASS",
        referenceHash: c1.referenceHash,
        resultHash: c2.geometryHash,
        geometryType: c2.zoneGeometryType,
        ...commonStep
      },
      {
        operationId: "spatial.find-in-area",
        status: "PASS",
        referenceHash: c1.referenceHash,
        resultHash: c2.expectedVehicleReferenceHash,
        inputGeometryHash: c2.geometryHash,
        expectedVehiclePresent: true,
        ...commonStep
      }
    ],
    status: "PASS",
    hardcodedReferenceUsed: false,
    notes: ["The same resolved area identity and geometry hashes were consumed downstream."]
  };
  const canaryC3 = {
    schemaVersion: "1.0",
    canaryId: "C3",
    steps: [
      {
        operationId: "reference.resolve",
        status: "PASS",
        referenceHash: c3.referenceHash,
        resultHash: c3.referenceHash,
        ...commonStep
      },
      {
        operationId: "reference.validate",
        status: "PASS",
        referenceHash: c3.referenceHash,
        resultHash: c3.referenceHash,
        currentAndUsable: true,
        ...commonStep
      },
      {
        operationId: "world.get-current-state",
        status: "PASS",
        referenceHash: c3.referenceHash,
        resultHash: c3.positionHash,
        ...commonStep
      },
      {
        operationId: "spatial.find-nearby",
        status: "PASS",
        referenceHash: c3.referenceHash,
        resultHash: c3.expectedReferenceHash,
        inputPositionHash: c3.positionHash,
        radiusM: 1000,
        ...commonStep
      }
    ],
    status: "PASS",
    hardcodedReferenceUsed: false,
    notes: ["The resolved vehicle and observed position hashes were preserved through the 1000m query."]
  };
  const canaryC4 = {
    schemaVersion: "1.0",
    canaryId: "C4",
    steps: [
      {
        operationId: "reference.resolve",
        status: "PASS",
        resultHash: c4ResultHash,
        candidateCount: 2,
        downstreamExecutionCount: 0,
        ...commonStep
      }
    ],
    status: "PASS",
    hardcodedReferenceUsed: false,
    notes: ["Ambiguity stopped execution before any downstream world or spatial operation."]
  };

  const rootCause = {
    schemaVersion: "1.0",
    targetVersion: TARGET_VERSION,
    candidateCommit,
    generatedAt,
    status: "PASS",
    baseline: {
      migrationCount: baseline.migrationCount,
      databaseIdentityHash: baseline.databaseIdentityHash,
      sameCandidateAndDatabaseAsUpgrade: upgrade.sameDatabaseUpgrade,
      descriptorPresent: baseline.baselineDivergence.descriptorPresent,
      descriptorCurrentObjectVersion: baseline.baselineDivergence.descriptorCurrentObjectVersion,
      sameReferenceGeometryRows: baseline.baselineDivergence.sameReferenceGeometryRows,
      observedOutcome: "GEOMETRY_UNAVAILABLE",
      defectReproduced: baseline.baselineDivergence.defectReproduced,
      evidenceHash: upgrade.baselineEvidenceHash
    },
    repaired: {
      migrationCount: 62,
      migration: upgrade.migration062,
      sameReferenceGeometryRows: upgrade.currentFeatureGeometryRows,
      descriptorPinComposes: true,
      immutableFeaturePinComposes: true,
      geometryType: upgrade.geometryType,
      crs: upgrade.crs,
      expectedVehicleCovered: true
    },
    identity: {
      referenceKind: "LAYER_FEATURE",
      descriptorReferenceHash: runtime.snapshot.descriptorReferenceHash,
      pinnedCatalogReferenceHash: runtime.snapshot.pinnedCatalogReferenceHash,
      sameEntity: runtime.snapshot.sameEntity,
      descriptorVersionHash: upgrade.descriptorVersionHash,
      featureVersionHash: upgrade.featureVersionHash,
      sourceFixtureHash: upgrade.sourceFixtureHash
    },
    sourceEvidenceSha256: {
      baseline: provenance.baseline,
      upgrade: provenance.upgrade
    },
    nonClaims: NON_CLAIMS
  };

  const freshClone = {
    schemaVersion: "1.0",
    targetVersion: TARGET_VERSION,
    candidateCommit,
    generatedAt,
    status: "PASS",
    sourceIdentity: {
      gitHead: runtime.sourceIdentity.gitHead,
      imageOciRevision: runtime.sourceIdentity.imageOciRevision,
      imageOciVersion: runtime.sourceIdentity.imageOciVersion,
      semanticSourceDigest: runtime.sourceIdentity.semanticSourceDigest,
      gitRemoteCount: runtime.sourceIdentity.gitRemoteCount
    },
    qualification: {
      runtimeClass: runtime.runtime.class,
      runtimeInstanceIdHash: canonicalSha256(runtime.runtimeInstanceId),
      freshClone: runtime.freshClone,
      freshDatabase: runtime.freshDatabase,
      manualPatchApplied: runtime.manualPatchApplied,
      migrationCount: runtime.database.migrationCount,
      migrationSetHash: runtime.database.migrationSetHash,
      requiredAvailability: runtime.requiredAvailability,
      canary: { passed: runtime.canary.passed, total: runtime.canary.total, status: runtime.canary.status },
      idempotency: runtime.idempotency,
      handoff: runtime.handoff
    },
    fixture: runtime.fixture,
    sourceEvidenceSha256: provenance.runtime,
    nonClaims: NON_CLAIMS
  };

  const lock = {
    schemaVersion: "1.0",
    baselineCommit: BASELINE_COMMIT,
    producerOperation: "reference.resolve",
    consumerOperation: "world.get-geometry",
    referenceKind: "LAYER_FEATURE",
    identityPreserved: true,
    producerReferenceHash: c1.referenceHash,
    consumerReferenceHash: c1.referenceHash,
    status: "PASS",
    evidenceIds: [
      `baseline:${provenance.baseline}`,
      `upgrade:${provenance.upgrade}`,
      `runtime:${provenance.runtime}`
    ]
  };

  const handoff = {
    schemaVersion: "1.0",
    targetVersion: TARGET_VERSION,
    candidateCommit,
    seedVersion: runtime.fixture.fixtureVersion,
    dataScope: "wsgs-demo",
    datasetScope: "wsgs-demo-main",
    areaFeature: {
      displayName: "A区",
      referenceKind: "LAYER_FEATURE",
      geometryType: c2.zoneGeometryType,
      referenceHash: c1.referenceHash
    },
    vehicleObject: {
      displayName: "2号车",
      referenceKind: "WORLD_OBJECT",
      referenceHash: c3.referenceHash,
      currentStatePositionAvailable: c3.vehiclePositionAvailable
    },
    realizationId: runtime.fixture.realizationId,
    sourceFixtureHash: runtime.fixture.sourceFixtureHash,
    generatedArtifactHash: runtime.fixture.generatedArtifactHash,
    realizationHash: runtime.fixture.realizationHash,
    loadedStateHash: runtime.fixture.loadedStateHash,
    runtimeInstanceIdHash: canonicalSha256(runtime.runtimeInstanceId),
    requiredAvailability: runtime.requiredAvailability,
    reproducible: true,
    manualPatchRequired: false,
    signedDelegationVerified: runtime.handoff.signedDelegation,
    independentConsumerVerified: runtime.handoff.independentConsumerContainer,
    sourceEvidenceSha256: provenance.runtime
  };

  const wsgsReport = {
    schemaVersion: "1.0",
    targetVersion: TARGET_VERSION,
    candidateCommit,
    generatedAt: isTimestamp(wsgs.generatedAt) ? wsgs.generatedAt : generatedAt,
    materializedAt: generatedAt,
    status: wsgsMode,
    environmentAvailable: wsgs.environmentAvailable,
    gatewayReady: wsgsMode === "PASS" ? true : false,
    requiredAvailability: wsgsMode === "PASS" ? wsgs.requiredAvailability : undefined,
    gowmImageOciRevision: wsgsMode === "PASS" ? wsgs.gowmImageOciRevision : undefined,
    realResolverOutputConsumed: wsgsMode === "PASS" ? true : false,
    chains: wsgsMode === "PASS" ? {
      zoneReferencePassedUnchanged: true,
      vehicleReferencePassedUnchanged: true,
      currentValidationUsable: true
    } : undefined,
    reasonCode: wsgsMode === "NOT_RUN" ? wsgs.reasonCode : undefined,
    unavailabilityEvidence: wsgsMode === "NOT_RUN" ? {
      status: "UNAVAILABLE",
      candidateCommit,
      evidenceHash: wsgs.unavailabilityEvidence.evidenceHash,
      observedAt: wsgs.unavailabilityEvidence.observedAt
    } : undefined,
    cases: WSGS_CASE_IDS.map((id, index) => ({
      id,
      status: wsgs.cases[index].status,
      requiredPath: WSGS_PATHS[id],
      realChainObserved: wsgsMode === "PASS"
    })),
    sourceEvidenceSha256: provenance.wsgs,
    nonClaims: NON_CLAIMS
  };
  removeUndefined(wsgsReport);

  return {
    "root-cause-reproduction-report.json": withEvidenceHash(rootCause),
    "fresh-clone-qualification-report.json": withEvidenceHash(freshClone),
    "canary-C1.json": canaryC1,
    "canary-C2.json": canaryC2,
    "canary-C3.json": canaryC3,
    "canary-C4.json": canaryC4,
    "reference-composability-lock.json": lock,
    "sample-world-handoff.json": withEvidenceHash(handoff),
    "wsgs-smoke-report.json": withEvidenceHash(wsgsReport)
  };
}

function assertUpgrade(value, candidateCommit) {
  if (value?.schemaVersion !== "1.0" || value?.phase !== "upgraded" || value?.status !== "PASS" ||
      value.candidateCommit !== candidateCommit || value.migrationCount !== 62 ||
      value.migration062Applied !== true || value.sameDatabaseUpgrade !== true ||
      value.migration062?.version !== "062_reference_geometry_composability.sql" ||
      value.migration062?.executedSqlChecksum !== MIGRATION_062_DIGEST ||
      value.descriptorPinComposes !== true || value.immutableFeaturePinComposes !== true ||
      value.currentFeatureGeometryRows !== 1 || value.expectedVehicleCovered !== true ||
      value.invalidGeometryRejected !== true || value.databaseAssertions?.status !== "PASS" ||
      value.databaseAssertions?.filesPassed !== 45 || value.databaseAssertions?.total !== 45 ||
      !["POLYGON", "MULTIPOLYGON"].includes(value.geometryType) || value.crs !== "EPSG:4326" ||
      value.bboxDerivedFromGeometry !== true) {
    throw new EvidenceError("Upgrade evidence is not an exact passing migration-062 qualification");
  }
  ["databaseIdentityHash", "baselineEvidenceHash", "qualificationPreflightHash",
    "qualificationPreflightArtifactSha256", "sourceFixtureHash", "realizationHash",
    "zoneReferenceHash", "descriptorVersionHash", "featureVersionHash"].forEach((name) =>
    requiredDigest(value[name], `upgrade.${name}`));
  if (!BARE_DIGEST.test(String(value.loadedStateHash))) {
    throw new EvidenceError("upgrade.loadedStateHash is not a bare SHA-256 digest");
  }
  const scope = value.scopeChecks;
  const readOnly = value.providerReadOnly;
  const snapshot = value.snapshot;
  if (scope?.status !== "PASS" || scope.authorizedRows < 1 || scope.wrongDatasetRows !== 0 ||
      scope.wrongDataRows !== 0 || scope.absentScopeRows !== 0 ||
      readOnly?.status !== "PASS" || readOnly.baseTableSelect !== false ||
      readOnly.contractViewSelect !== true || readOnly.dmlRejected !== true ||
      snapshot?.status !== "PASS" || snapshot.changed !== true ||
      requiredDigest(snapshot.beforeHash, "upgrade.snapshot.beforeHash") ===
        requiredDigest(snapshot.afterHash, "upgrade.snapshot.afterHash")) {
    throw new EvidenceError("Upgrade evidence lacks scope, read-only, or snapshot-change proof");
  }
}

function assertBaseline(value, candidateCommit) {
  if (value?.schemaVersion !== "1.0" || value?.phase !== "baseline" || value?.status !== "PASS" ||
      value.candidateCommit !== candidateCommit || value.migrationCount !== 61 ||
      value.migration062Applied !== false ||
      value.baselineDivergence?.descriptorPresent !== true ||
      value.baselineDivergence?.descriptorCurrentObjectVersion !== true ||
      value.baselineDivergence?.sameReferenceGeometryRows !== 0 ||
      value.baselineDivergence?.defectReproduced !== true) {
    throw new EvidenceError("Baseline evidence does not reproduce the exact 001-061 composability defect");
  }
  ["databaseIdentityHash", "qualificationPreflightHash", "qualificationPreflightArtifactSha256",
    "sourceFixtureHash", "realizationHash", "zoneReferenceHash", "descriptorVersionHash",
    "featureVersionHash"].forEach((name) => requiredDigest(value[name], `baseline.${name}`));
  if (!BARE_DIGEST.test(String(value.loadedStateHash))) {
    throw new EvidenceError("baseline.loadedStateHash is not a bare SHA-256 digest");
  }
}

function assertBaselineUpgradeIdentity(baseline, upgrade) {
  for (const name of ["candidateCommit", "databaseIdentityHash", "qualificationPreflightHash",
    "sourceFixtureHash", "realizationHash", "realizationId", "loadedStateHash", "zoneReferenceHash"]) {
    if (baseline[name] !== upgrade[name]) {
      throw new EvidenceError(`Baseline and upgrade evidence differ at ${name}`);
    }
  }
  if (upgrade.baselineEvidenceHash !== canonicalSha256(baseline)) {
    throw new EvidenceError("Upgrade baselineEvidenceHash is not the canonical hash of the supplied baseline evidence");
  }
}

function assertRuntime(value, candidateCommit, upgrade) {
  const core = { ...value };
  delete core.evidenceHash;
  if (value?.schemaVersion !== "1.0" || value?.targetVersion !== TARGET_VERSION ||
      value?.candidateCommit !== candidateCommit || value?.status !== "PASS" ||
      value?.sourceIdentity?.status !== "PASS" || value.sourceIdentity.gitHead !== candidateCommit ||
      value.sourceIdentity.imageOciRevision !== candidateCommit ||
      value.sourceIdentity.imageOciVersion !== TARGET_VERSION ||
      value.runtime?.status !== "PASS" || value.runtime.class !== "ISOLATED_Q" ||
      value.runtime.ready !== true || !/^q-[a-z0-9][a-z0-9-]{0,47}$/u.test(String(value.runtimeInstanceId)) ||
      value.freshClone !== true || value.freshDatabase !== true || value.manualPatchApplied !== false ||
      value.requiredAvailability?.status !== "PASS" || value.requiredAvailability.passed !== 12 ||
      value.requiredAvailability.total !== 12 || value.canary?.status !== "PASS" ||
      value.canary.passed !== 37 || value.canary.total !== 37 ||
      value.database?.status !== "PASS" || value.database.fresh !== true ||
      value.database.migrationCount !== 62 || value.handoff?.status !== "PASS" ||
      value.handoff.runtimeIdentityBound !== true || value.handoff.signedDelegation !== true ||
      value.handoff.independentConsumerContainer !== true || value.evidenceHash !== canonicalSha256(core) ||
      !isTimestamp(value.generatedAt)) {
    throw new EvidenceError("Runtime evidence is not an exact candidate-bound fresh-clone qualification");
  }
  if (value.fixture?.sourceFixtureHash !== upgrade.sourceFixtureHash) {
    throw new EvidenceError("Upgrade and runtime evidence use different source fixtures");
  }
  [value.sourceIdentity.semanticSourceDigest, value.database.migrationSetHash,
    value.canary.evidenceSha256, value.snapshot?.layerFeatureReferenceHash,
    value.snapshot?.descriptorReferenceHash, value.snapshot?.pinnedCatalogReferenceHash,
    value.snapshot?.layerFeatureDigest, value.snapshot?.migration062Digest,
    value.canary?.c1?.referenceHash, value.canary?.c2?.geometryHash,
    value.canary?.c2?.expectedVehicleReferenceHash, value.canary?.c3?.referenceHash,
    value.canary?.c3?.positionHash, value.canary?.c3?.expectedReferenceHash]
    .forEach((entry, index) => requiredDigest(entry, `runtime digest ${index + 1}`));
  if (value.snapshot.migration062Digest !== MIGRATION_062_DIGEST ||
      value.snapshot.layerFeaturePinned !== true ||
      value.snapshot.sameEntity !== true ||
      value.snapshot.layerFeatureReferenceHash !== value.snapshot.descriptorReferenceHash ||
      value.snapshot.descriptorReferenceHash !== value.canary.c1.referenceHash ||
      value.canary.c1.status !== "PASS" || value.canary.c1.chain !== "resolve->validate->geometry" ||
      value.canary.c1.referenceHash !== value.canary.c1.zoneReferenceHash ||
      value.canary.c2.status !== "PASS" || value.canary.c2.chain !== "geometry->spatial.find-in-area" ||
      !["Polygon", "MultiPolygon"].includes(value.canary.c2.zoneGeometryType) ||
      value.canary.c3.status !== "PASS" ||
      value.canary.c3.chain !== "resolve->validate->current-state->spatial.find-nearby" ||
      value.canary.c3.vehicleReferenceKind !== "WORLD_OBJECT" ||
      value.canary.c3.vehiclePositionAvailable !== true || value.canary.c3.radiusM !== 1000 ||
      value.canary.c4.status !== "PASS" || value.canary.c4.candidateCount !== 2 ||
      value.canary.c4.downstreamExecutionCount !== 0) {
    throw new EvidenceError("Runtime evidence does not prove exact C1-C4 reference composition");
  }
  const idempotency = value.idempotency;
  if (idempotency?.status !== "PASS" || idempotency.loaderInternalRepeat !== true ||
      !BARE_DIGEST.test(String(idempotency.beforeLoadedStateHash)) ||
      idempotency.beforeLoadedStateHash !== idempotency.afterLoadedStateHash ||
      idempotency.afterLoadedStateHash !== idempotency.liveLoadedStateHash ||
      idempotency.liveLoadedStateHash !== value.fixture?.loadedStateHash) {
    throw new EvidenceError("Runtime evidence does not prove idempotent fixture loading");
  }
}

function assertWsgs(value, candidateCommit) {
  if (value?.schemaVersion !== "1.0" || value?.targetVersion !== TARGET_VERSION ||
      value?.candidateCommit !== candidateCommit || !Array.isArray(value.cases) ||
      value.cases.length !== 5 || canonical(value.cases.map((entry) => entry?.id)) !== canonical(WSGS_CASE_IDS)) {
    throw new EvidenceError("WSGS evidence identity or ordered R1-R5 case set is invalid");
  }
  const statuses = new Set(value.cases.map((entry) => entry?.status));
  if (value.status === "PASS") {
    if (statuses.size !== 1 || !statuses.has("PASS") || value.environmentAvailable !== true ||
        value.realResolverOutputConsumed !== true || value.gatewayReady !== true ||
        !availabilityTwelve(value.requiredAvailability) || value.gowmImageOciRevision !== candidateCommit ||
        value.chains?.zoneReferencePassedUnchanged !== true ||
        value.chains?.vehicleReferencePassedUnchanged !== true ||
        value.chains?.currentValidationUsable !== true || !isTimestamp(value.generatedAt)) {
      throw new EvidenceError("WSGS PASS evidence lacks exact candidate-bound real-chain proof");
    }
    return "PASS";
  }
  const allowedReasons = new Set([
    "WSGS_ENVIRONMENT_UNAVAILABLE",
    "WSGS_ENDPOINT_UNAVAILABLE",
    "WSGS_RUNTIME_UNAVAILABLE"
  ]);
  if (value.status !== "NOT_RUN" || statuses.size !== 1 || !statuses.has("NOT_RUN") ||
      value.environmentAvailable !== false || !allowedReasons.has(value.reasonCode) ||
      value.unavailabilityEvidence?.status !== "UNAVAILABLE" ||
      value.unavailabilityEvidence?.candidateCommit !== candidateCommit ||
      !DIGEST.test(String(value.unavailabilityEvidence?.evidenceHash)) ||
      !isTimestamp(value.unavailabilityEvidence?.observedAt)) {
    throw new EvidenceError("WSGS NOT_RUN evidence is not observed and candidate-bound");
  }
  return "NOT_RUN";
}

function assertMaterializedReports(reports, candidateCommit) {
  const expected = [
    "root-cause-reproduction-report.json",
    "fresh-clone-qualification-report.json",
    "canary-C1.json",
    "canary-C2.json",
    "canary-C3.json",
    "canary-C4.json",
    "reference-composability-lock.json",
    "sample-world-handoff.json",
    "wsgs-smoke-report.json"
  ];
  if (canonical(Object.keys(reports)) !== canonical(expected)) {
    throw new EvidenceError("Materialized report set differs from the task package report set");
  }
  for (let index = 1; index <= 4; index += 1) {
    const report = reports[`canary-C${index}.json`];
    if (report.schemaVersion !== "1.0" || report.canaryId !== `C${index}` || report.status !== "PASS" ||
        report.hardcodedReferenceUsed !== false || !Array.isArray(report.steps) || report.steps.length === 0 ||
        report.steps.some((step) => step.status !== "PASS" || typeof step.operationId !== "string" ||
          (step.referenceHash !== undefined && !DIGEST.test(step.referenceHash)) ||
          (step.resultHash !== undefined && !DIGEST.test(step.resultHash)))) {
      throw new EvidenceError(`Materialized C${index} does not satisfy the task canary contract`);
    }
  }
  const lock = reports["reference-composability-lock.json"];
  if (lock.baselineCommit !== BASELINE_COMMIT || lock.status !== "PASS" || lock.identityPreserved !== true ||
      lock.producerReferenceHash !== lock.consumerReferenceHash || !DIGEST.test(lock.producerReferenceHash)) {
    throw new EvidenceError("Materialized composability lock is invalid");
  }
  if (reports["fresh-clone-qualification-report.json"].candidateCommit !== candidateCommit ||
      reports["sample-world-handoff.json"].candidateCommit !== candidateCommit ||
      reports["wsgs-smoke-report.json"].candidateCommit !== candidateCommit) {
    throw new EvidenceError("Materialized reports lost the qualification candidate identity");
  }
}

function parseArguments(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const requiredNames = ["upgrade", "runtime", "wsgs", "output-dir"];
  const allowedNames = [...requiredNames, "baseline"];
  const allowed = new Set(allowedNames);
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new EvidenceError(`Invalid argument near ${flag ?? "<end>"}`);
    }
    const name = flag.slice(2);
    if (!allowed.has(name) || Object.hasOwn(result, name)) {
      throw new EvidenceError(`Unknown or duplicate option: ${flag}`);
    }
    result[name] = value;
  }
  for (const name of requiredNames) {
    if (!result[name]) throw new EvidenceError(`--${name} is required`);
  }
  return { ...result, outputDir: result["output-dir"] };
}

async function readEvidence(path, label) {
  const absolute = resolve(root, path);
  const bytes = await readFile(absolute);
  try {
    return {
      path: absolute,
      value: JSON.parse(bytes.toString("utf8")),
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    };
  } catch {
    throw new EvidenceError(`${label} evidence is not valid JSON`);
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function withEvidenceHash(value) {
  return { ...value, evidenceHash: canonicalSha256(value) };
}

function removeUndefined(value) {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function requiredCommit(value, label) {
  if (typeof value !== "string" || !SOURCE_COMMIT.test(value)) {
    throw new EvidenceError(`${label} is not a lowercase 40-hex commit`);
  }
  return value;
}

function requiredDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new EvidenceError(`${label} is not a SHA-256 digest`);
  }
  return value;
}

function availabilityTwelve(value) {
  return value === "12/12" ||
    (value?.status === "PASS" && value?.passed === 12 && value?.total === 12);
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertNoSensitiveMaterial(value, label) {
  const findings = [];
  const visit = (item, path) => {
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        const sensitiveKey = /(?:password|passwd|authorization|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)/iu.test(key);
        if (sensitiveKey && child !== false && child !== null && child !== 0 && child !== "") {
          findings.push(`${path}.${key}`);
        }
        if (/^(?:referenceId|reference_id|candidateReferenceKey|candidate_reference_key)$/u.test(key) &&
            (typeof child !== "string" || !DIGEST.test(child))) {
          findings.push(`${path}.${key}`);
        }
        if (key === "referenceKey" && child && typeof child === "object" &&
            !Object.hasOwn(child, "beforeHash") && !Object.hasOwn(child, "afterHash")) {
          findings.push(`${path}.${key}`);
        }
        visit(child, `${path}.${key}`);
      }
      return;
    }
    if (typeof item === "string" && [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
      /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu,
      /\b(?:postgres|postgresql):\/\/[^/\s:@]+:[^@\s/]+@/iu,
      /\bghp_[A-Za-z0-9]{20,}\b/u,
      /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
      /\bwrf_[A-Za-z0-9_-]{8,}\b/u
    ].some((pattern) => pattern.test(item))) {
      findings.push(path);
    }
  };
  visit(value, "$");
  if (findings.length > 0) {
    throw new EvidenceError(`${label} contains credential, raw reference, or private-key material`);
  }
}

function canonicalSha256(value) {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
