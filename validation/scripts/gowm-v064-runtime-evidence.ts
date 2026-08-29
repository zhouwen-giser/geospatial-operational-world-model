import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { canonicalSha256 } from "../../packages/platform/contract-runtime/src/index.js";
import { semanticSourceFingerprint } from "../../packages/platform/semantic-conformance/src/index.js";
import { sampleHandoffPaths } from "../../scripts/sample-world/handoff.js";
import { loadRuntimeSampleWorld } from "../../scripts/sample-world/loaded.js";
import {
  assertCurrentV1Artifacts,
  probeLiveSampleInstance,
  REQUIRED_SAMPLE_OPERATIONS
} from "../../scripts/sample-world/readiness.js";
import {
  SAMPLE_RUNTIME_SECRET_NAMES,
  sampleGatewayBaseUrl,
  samplePostgresEndpoint,
  sampleRuntimeIdentityFromValues,
  type SampleRuntimeEnvironment
} from "../../scripts/sample-world/runtime.js";

type AnyRecord = Record<string, any>;

const TARGET_VERSION = "0.6.4";
const CANARY_CASE_COUNT = 37;
const MIGRATION_062_DIGEST = "sha256:7b8a606e3258baa2f3e68c88e81abacb289615cf960a1af20c8a9f4c2074539c";
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const BARE_DIGEST = /^[0-9a-f]{64}$/u;

export interface GowmV064RuntimeEvidenceOptions {
  runtime: SampleRuntimeEnvironment;
  candidateCommit?: string;
  idempotentStateHashBefore?: string;
  idempotentStateHashAfter?: string;
  freshClone?: boolean;
  freshDatabase?: boolean;
  manualPatchApplied?: boolean;
  outputPath?: string;
}

/**
 * Qualifies an already-running, isolated q-* Sample World instance and writes a
 * sanitized summary. The caller must perform the second fixture load before
 * invoking this function and pass the live state hashes observed immediately
 * before and after that load. Environment fallbacks make the same API usable
 * from a thin CLI without placing any secret material on its command line.
 */
export async function writeGowmV064RuntimeEvidence(
  options: GowmV064RuntimeEvidenceOptions
): Promise<Record<string, unknown>> {
  const { runtime } = options;
  const identity = sampleRuntimeIdentityFromValues(runtime.values);
  if (!identity.instanceId.startsWith("q-")) {
    throw new Error("GOWM v0.6.4 runtime qualification requires an isolated q-* instance");
  }

  const candidateCommit = requiredSourceCommit(
    options.candidateCommit ?? process.env.GOWM_V064_QUALIFICATION_SOURCE_COMMIT
  );
  const beforeHash = requiredBareDigest(
    options.idempotentStateHashBefore ?? process.env.GOWM_V064_IDEMPOTENT_STATE_HASH_BEFORE,
    "idempotent state hash before repeat load"
  );
  const afterHash = requiredBareDigest(
    options.idempotentStateHashAfter ?? process.env.GOWM_V064_IDEMPOTENT_STATE_HASH_AFTER,
    "idempotent state hash after repeat load"
  );
  const freshClone = options.freshClone ?? process.env.GOWM_V064_FRESH_CLONE === "YES";
  const freshDatabase = options.freshDatabase ?? process.env.GOWM_V064_FRESH_DATABASE === "YES";
  const manualPatchApplied = options.manualPatchApplied ?? process.env.GOWM_V064_MANUAL_PATCH_APPLIED === "YES";
  if (!freshClone || !freshDatabase || manualPatchApplied) {
    throw new Error("Qualification must attest a fresh clone and fresh q-* database with no manual runtime patch");
  }

  const gitHead = git(runtime.paths.root, ["rev-parse", "HEAD"]).trim();
  if (gitHead !== candidateCommit) {
    throw new Error("Qualification candidate commit differs from the checked-out Git HEAD");
  }
  const gitRemotes = git(runtime.paths.root, ["remote"]).split(/\r?\n/u).filter(Boolean);
  if (gitRemotes.length !== 0) {
    throw new Error("Fresh-clone qualification source unexpectedly has a configured Git remote");
  }
  const runtimeGeneratedSourceReports = assertOnlyRuntimeReportChanges(runtime.paths.root);
  const database = await inspectDatabaseMigrationIdentity(runtime);

  const realization = await loadRuntimeSampleWorld(runtime);
  const live = await probeLiveSampleInstance(runtime, { expectedRevision: "v1" });
  await assertCurrentV1Artifacts(runtime, realization, live);
  if (REQUIRED_SAMPLE_OPERATIONS.length !== 12 || live.requiredAvailable !== 12) {
    throw new Error("Runtime qualification requires exact 12/12 signed operation availability");
  }
  if (beforeHash !== afterHash || afterHash !== live.loadedStateHash) {
    throw new Error("Repeated fixture load changed the live Sample World state hash");
  }

  const image = inspectCandidateImage(identity.applicationImage, candidateCommit);
  const runningApplicationContainerCount = assertRunningCandidateImage(
    identity.composeProjectName,
    image.imageId
  );
  const outputDirectory = runtime.paths.outputDirectory;
  const { handoffDirectory } = sampleHandoffPaths(runtime);
  const [
    loadReportArtifact,
    loadEvidenceArtifact,
    canaryArtifact,
    handoffCanaryArtifact,
    manifestArtifact,
    bindingArtifact,
    connectivityArtifact,
    preflightArtifact
  ] = await Promise.all([
    readJsonArtifact(resolve(outputDirectory, "LOAD_REPORT.json")),
    readJsonArtifact(resolve(outputDirectory, "LOAD_EVIDENCE.json")),
    readJsonArtifact(resolve(outputDirectory, "CANARY_EVIDENCE_REPORT.json")),
    readJsonArtifact(resolve(handoffDirectory, "CANARY_EVIDENCE_REPORT.json")),
    readJsonArtifact(resolve(handoffDirectory, "INSTANCE_MANIFEST.json")),
    readJsonArtifact(resolve(handoffDirectory, "INSTANCE_BINDING.json")),
    readJsonArtifact(resolve(handoffDirectory, "CONSUMER_CONNECTIVITY_REPORT.json")),
    readJsonArtifact(resolve(outputDirectory, "QUALIFICATION_PREFLIGHT.json"))
  ]);
  const loadReport = loadReportArtifact.value;
  const loadEvidence = loadEvidenceArtifact.value;
  const canary = canaryArtifact.value;
  const manifest = manifestArtifact.value;
  const binding = bindingArtifact.value;
  const connectivity = connectivityArtifact.value;
  const preflight = preflightArtifact.value;

  assertQualificationPreflight(preflight, candidateCommit, identity.instanceId);

  assertLoadEvidence(loadReport, loadEvidence, realization.fixture, live.loadedStateHash);
  assertRuntimeIdentity({
    identity: identity.instanceId,
    gatewayBaseUrl: sampleGatewayBaseUrl(runtime),
    realization,
    live,
    canary,
    manifest,
    binding,
    connectivity,
    outputCanarySha256: canaryArtifact.sha256,
    handoffCanarySha256: handoffCanaryArtifact.sha256
  });

  const cases = exactPassingCases(canary);
  const c1 = assertZoneReferenceChain(cases);
  const c2 = assertZoneSpatialChain(cases, realization);
  const c3 = assertVehicleChain(cases);
  const c4 = assertAmbiguityStop(cases);
  const snapshot = assertPinnedGeometrySnapshot(cases, realization);
  const scope = assertScopeAndReadOnlyReceipts(cases);
  const providers = assertProviderIdentities(cases);
  const hiddenGeometry = caseById(cases, "SECURITY-DIRECT-HIDDEN-FEATURE", "world.get-geometry");
  assertGovernedNonDisclosure(hiddenGeometry);

  const sourceDigest = await semanticSourceFingerprint(runtime.paths.root);
  if (canary.sourceDigest !== sourceDigest) {
    throw new Error("Canary source digest differs from the qualification source fingerprint");
  }

  const generatedAt = new Date().toISOString();
  const reportCore = {
    schemaVersion: "1.0",
    targetVersion: TARGET_VERSION,
    candidateCommit,
    runtimeInstanceId: identity.instanceId,
    status: "PASS",
    generatedAt,
    evidenceTimestamp: generatedAt,
    freshClone: true,
    freshDatabase: true,
    manualPatchApplied: false,
    requiredAvailability: { passed: 12, total: 12, status: "PASS" },
    canary: {
      passed: CANARY_CASE_COUNT,
      total: CANARY_CASE_COUNT,
      status: "PASS",
      c1,
      c2,
      c3,
      c4,
      evidenceSha256: canaryArtifact.sha256
    },
    idempotency: {
      status: "PASS",
      beforeLoadedStateHash: beforeHash,
      afterLoadedStateHash: afterHash,
      liveLoadedStateHash: live.loadedStateHash,
      loaderInternalRepeat: true
    },
    sourceIdentity: {
      status: "PASS",
      gitHead: candidateCommit,
      semanticSourceDigest: sourceDigest,
      imageId: image.imageId,
      imageReferenceHash: canonicalSha256(identity.applicationImage),
      imageRepositoryDigestHashes: image.repositoryDigestHashes,
      imageOciRevision: image.revision,
      imageOciVersion: image.version,
      runningApplicationContainerCount,
      gitRemoteCount: 0,
      runtimeGeneratedSourceReportCount: runtimeGeneratedSourceReports.length,
      runtimeGeneratedSourceReportsHash: canonicalSha256(runtimeGeneratedSourceReports)
    },
    runtime: {
      status: "PASS",
      class: "ISOLATED_Q",
      ready: true,
      revision: live.revision,
      fixtureId: live.fixtureId,
      realizationId: live.realizationId,
      databaseMarkerHash: canonicalSha256(live.databaseMarker),
      composeProjectNameHash: canonicalSha256(identity.composeProjectName),
      databaseNameHash: canonicalSha256(identity.databaseName),
      databaseIdentityHash: canonicalSha256(identity.databaseName),
      gatewayBaseUrlHash: canonicalSha256(sampleGatewayBaseUrl(runtime))
    },
    fixture: {
      fixtureVersion: realization.fixture.version,
      realizationId: realization.fixture.realizationId,
      sourceFixtureHash: realization.fixture.sourceFixtureHash,
      generatedArtifactHash: realization.fixture.generatedArtifactHash,
      realizationHash: realization.fixture.realizationHash,
      loadedStateHash: live.loadedStateHash
    },
    database: {
      status: "PASS",
      fresh: true,
      migrationCount: database.migrationCount,
      migrationSetHash: database.migrationSetHash,
      databaseNameHash: canonicalSha256(identity.databaseName),
      qualificationPreflightHash: preflight.evidenceHash,
      qualificationPreflightArtifactSha256: preflightArtifact.sha256
    },
    handoff: {
      status: "PASS",
      runtimeIdentityBound: true,
      signedDelegation: true,
      independentConsumerContainer: true,
      manifestSha256: manifestArtifact.sha256,
      bindingSha256: bindingArtifact.sha256,
      connectivitySha256: connectivityArtifact.sha256,
      canarySha256: handoffCanaryArtifact.sha256
    },
    provider: {
      status: "PASS",
      scopeAppliedBeforeQueryReceiptCount: scope.scopeAppliedBeforeQueryReceiptCount,
      readOnlyReceiptCount: scope.readOnlyReceiptCount,
      hiddenLayerFeatureGeometryNonDisclosure: true,
      implementationDigests: providers
    },
    scope: { status: "PASS", ...scope },
    snapshot: { status: "PASS", ...snapshot },
    artifacts: {
      loadReportSha256: loadReportArtifact.sha256,
      loadEvidenceSha256: loadEvidenceArtifact.sha256,
      canaryEvidenceSha256: canaryArtifact.sha256,
      handoffCanaryEvidenceSha256: handoffCanaryArtifact.sha256,
      qualificationPreflightSha256: preflightArtifact.sha256
    }
  } as const;
  const report = { ...reportCore, evidenceHash: canonicalSha256(reportCore) };
  assertSanitized(report, runtime);

  const outputPath = resolve(options.outputPath ?? resolve(outputDirectory, "V064_RUNTIME_EVIDENCE.json"));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `GOWM_V064_RUNTIME_EVIDENCE_PASS availability=12/12 canary=37/37 evidence=${report.evidenceHash}\n`
  );
  return report;
}

function assertQualificationPreflight(
  preflight: AnyRecord,
  candidateCommit: string,
  runtimeInstanceId: string
): void {
  const core = { ...preflight };
  delete core.evidenceHash;
  if (preflight.schemaVersion !== "1.0" || preflight.targetVersion !== TARGET_VERSION ||
      preflight.purpose !== "runtime" || preflight.candidateCommit !== candidateCommit ||
      preflight.runtimeInstanceId !== runtimeInstanceId || preflight.status !== "PASS" ||
      preflight.git?.remoteCount !== 0 || preflight.git?.sourceContextClean !== true ||
      preflight.observedAbsent?.composeProjectContainers !== 0 ||
      preflight.observedAbsent?.databaseVolumeAbsent !== true ||
      preflight.observedAbsent?.runtimeVolumeAbsent !== true ||
      preflight.observedAbsent?.composeNetworksAbsent !== true ||
      preflight.observedAbsent?.composeNetworkCount !== 3 ||
      typeof preflight.qualificationRunId !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(preflight.qualificationRunId) ||
      !Number.isFinite(Date.parse(String(preflight.generatedAt))) ||
      !DIGEST.test(String(preflight.resourceIdentityHash)) ||
      preflight.evidenceHash !== canonicalSha256(core)) {
    throw new Error("Runtime qualification preflight does not prove fresh q-* resource absence");
  }
}

function assertLoadEvidence(
  loadReport: AnyRecord,
  loadEvidence: AnyRecord,
  fixture: AnyRecord,
  liveStateHash: string
): void {
  if (loadReport.status !== "PASS" || loadReport.idempotent !== true ||
      loadReport.fixtureId !== fixture.id || loadReport.fixtureVersion !== fixture.version ||
      loadReport.sourceFixtureHash !== fixture.sourceFixtureHash ||
      loadReport.realizationHash !== fixture.realizationHash) {
    throw new Error("Load report is not a current, idempotent realization load");
  }
  if (loadEvidence.idempotent !== true || loadEvidence.realizationId !== fixture.realizationId ||
      loadEvidence.loadedStateHash !== liveStateHash ||
      canonicalSha256(loadEvidence.projectionWorldVersions) !== canonicalSha256(loadEvidence.repeatProjectionWorldVersions)) {
    throw new Error("Load evidence does not prove an idempotent projection");
  }
}

function assertRuntimeIdentity(options: {
  identity: string;
  gatewayBaseUrl: string;
  realization: AnyRecord;
  live: AnyRecord;
  canary: AnyRecord;
  manifest: AnyRecord;
  binding: AnyRecord;
  connectivity: AnyRecord;
  outputCanarySha256: string;
  handoffCanarySha256: string;
}): void {
  const { fixture } = options.realization;
  if (options.canary.status !== "PASS" || options.canary.realizationId !== options.live.realizationId ||
      options.canary.loadedStateHash !== options.live.loadedStateHash ||
      options.canary.fixtureHash !== fixture.sourceFixtureHash) {
    throw new Error("Canary identity differs from the live realization");
  }
  if (options.manifest.runtimeInstanceId !== options.identity ||
      options.binding.runtimeInstanceId !== options.identity ||
      options.manifest.instanceId !== options.live.realizationId ||
      options.binding.realizationId !== options.live.realizationId ||
      options.binding.loadedStateHash !== options.live.loadedStateHash ||
      options.binding.sourceFixtureHash !== fixture.sourceFixtureHash ||
      options.binding.realizationHash !== fixture.realizationHash ||
      options.manifest.gatewayBaseUrl !== options.gatewayBaseUrl ||
      options.manifest.authMode !== "SIGNED_DELEGATION_V1" ||
      options.manifest.stableOperations?.length !== 12 ||
      options.outputCanarySha256 !== options.handoffCanarySha256) {
    throw new Error("Handoff artifacts are not an exact copy of the qualified q-* runtime identity");
  }
  if (options.connectivity.status !== "PASS" ||
      options.connectivity.realizationId !== options.live.realizationId ||
      options.connectivity.loadedStateHash !== options.live.loadedStateHash ||
      options.connectivity.authMode !== "SIGNED_DELEGATION_V1" ||
      options.connectivity.evidenceSource !== "INDEPENDENT_CONTAINER") {
    throw new Error("Independent handoff consumer connectivity evidence is stale");
  }
}

function exactPassingCases(canary: AnyRecord): Map<string, AnyRecord> {
  if (canary.status !== "PASS" || !Array.isArray(canary.cases) || canary.cases.length !== CANARY_CASE_COUNT) {
    throw new Error("Runtime qualification requires an exact 37-case PASS canary");
  }
  const cases = new Map<string, AnyRecord>();
  for (const entry of canary.cases as AnyRecord[]) {
    if (typeof entry.caseId !== "string" || cases.has(entry.caseId) || entry.status !== "PASS") {
      throw new Error("Canary cases must be unique and all PASS");
    }
    cases.set(entry.caseId, entry);
  }
  return cases;
}

function assertZoneReferenceChain(cases: Map<string, AnyRecord>): Record<string, unknown> {
  const resolved = caseById(cases, "CHAIN-REFERENCE-ZONE-A", "reference.resolve");
  const validated = caseById(cases, "CHAIN-VALIDATE-ZONE-A", "reference.validate");
  const geometry = caseById(cases, "CHAIN-GEOMETRY-ZONE-A", "world.get-geometry");
  const referenceHash = comparisonDigest(resolved, "referenceHash");
  if (resolved.comparison.referenceKind !== "LAYER_FEATURE" || resolved.comparison.hardcodedReferenceUsed !== false ||
      comparisonDigest(validated, "referenceHash") !== referenceHash ||
      comparisonDigest(validated, "inputReferenceHash") !== referenceHash ||
      validated.comparison.requireCurrentSnapshot !== true || validated.comparison.currentAndUsable !== true ||
      comparisonDigest(geometry, "referenceHash") !== referenceHash ||
      comparisonDigest(geometry, "inputReferenceHash") !== referenceHash) {
    throw new Error("C1 did not preserve the exact resolved Zone-A reference through validation and geometry");
  }
  return {
    status: "PASS",
    chain: "resolve->validate->geometry",
    referenceHash,
    zoneReferenceHash: referenceHash
  };
}

function assertZoneSpatialChain(
  cases: Map<string, AnyRecord>,
  realization: AnyRecord
): Record<string, unknown> {
  const geometry = caseById(cases, "CHAIN-GEOMETRY-ZONE-A", "world.get-geometry");
  const spatial = caseById(cases, "CHAIN-SPATIAL-ZONE-A", "spatial.find-in-area");
  const geometryHash = comparisonDigest(geometry, "geometryHash");
  if (comparisonDigest(spatial, "geometryHash") !== geometryHash ||
      comparisonDigest(spatial, "inputGeometryHash") !== geometryHash ||
      spatial.comparison.expectedVehiclePresent !== true) {
    throw new Error("C2 did not pass the exact Zone-A geometry into spatial.find-in-area");
  }
  const visibleFeatures = realization.features?.visible?.features;
  const zoneFeature = Array.isArray(visibleFeatures) ? visibleFeatures.find((feature: AnyRecord) =>
    feature?.properties?.fixtureFeatureKey === "zone-a"
  ) : undefined;
  if (zoneFeature?.geometry?.type !== "Polygon" || canonicalSha256(zoneFeature.geometry) !== geometryHash) {
    throw new Error("C2 runtime geometry hash differs from the realized Zone-A Polygon");
  }
  return {
    status: "PASS",
    chain: "geometry->spatial.find-in-area",
    geometryHash,
    zoneGeometryType: "Polygon",
    expectedVehicleReferenceHash: comparisonDigest(spatial, "expectedVehicleReferenceHash")
  };
}

function assertVehicleChain(cases: Map<string, AnyRecord>): Record<string, unknown> {
  const resolved = caseById(cases, "CHAIN-REFERENCE-UGV-002", "reference.resolve");
  const validated = caseById(cases, "CHAIN-VALIDATE-UGV-002", "reference.validate");
  const state = caseById(cases, "CHAIN-STATE-UGV-002", "world.get-current-state");
  const nearby = caseById(cases, "CHAIN-NEARBY-UGV-002", "spatial.find-nearby");
  const referenceHash = comparisonDigest(resolved, "referenceHash");
  const positionHash = comparisonDigest(state, "positionCoordinatesHash");
  if (resolved.comparison.referenceKind !== "WORLD_OBJECT" || resolved.comparison.hardcodedReferenceUsed !== false ||
      comparisonDigest(validated, "referenceHash") !== referenceHash ||
      comparisonDigest(validated, "inputReferenceHash") !== referenceHash ||
      validated.comparison.requireCurrentSnapshot !== true || validated.comparison.currentAndUsable !== true ||
      comparisonDigest(state, "referenceHash") !== referenceHash ||
      comparisonDigest(state, "inputReferenceHash") !== referenceHash ||
      comparisonDigest(nearby, "referenceHash") !== referenceHash ||
      comparisonDigest(nearby, "positionCoordinatesHash") !== positionHash ||
      comparisonDigest(nearby, "inputPositionHash") !== positionHash ||
      nearby.comparison.radiusM !== 1_000 || nearby.comparison.expectedReferencePresent !== true) {
    throw new Error("C3 did not preserve the resolved vehicle reference and position through the nearby chain");
  }
  return {
    status: "PASS",
    chain: "resolve->validate->current-state->spatial.find-nearby",
    referenceHash,
    positionHash,
    expectedReferenceHash: comparisonDigest(nearby, "expectedReferenceHash"),
    radiusM: 1_000,
    vehicleReferenceKind: "WORLD_OBJECT",
    vehiclePositionAvailable: true
  };
}

function assertAmbiguityStop(cases: Map<string, AnyRecord>): Record<string, unknown> {
  const ambiguity = caseById(cases, "CHAIN-AMBIGUITY-RIVER-ROAD", "reference.resolve");
  if (ambiguity.comparison?.candidateCount !== 2 || ambiguity.comparison?.downstreamExecutionCount !== 0) {
    throw new Error("C4 ambiguity did not stop before downstream execution");
  }
  return { status: "PASS", candidateCount: 2, downstreamExecutionCount: 0 };
}

function assertPinnedGeometrySnapshot(
  cases: Map<string, AnyRecord>,
  realization: AnyRecord
): Record<string, unknown> {
  const geometry = caseById(cases, "CHAIN-GEOMETRY-ZONE-A", "world.get-geometry");
  const descriptorReferenceHash = comparisonDigest(geometry, "referenceHash");
  const zone = (realization.referenceMap?.entries as AnyRecord[] | undefined)?.find((entry) =>
    entry.fixtureKey === "zone-a"
  );
  const descriptorReferenceKey = zone?.identityReferenceKey as AnyRecord | undefined;
  const currentCatalogReferenceKey = zone?.currentCatalogReferenceKey as AnyRecord | undefined;
  if (!descriptorReferenceKey || !currentCatalogReferenceKey ||
      canonicalSha256(descriptorReferenceKey) !== descriptorReferenceHash ||
      !sameReferenceEntity(descriptorReferenceKey, currentCatalogReferenceKey)) {
    throw new Error("Zone-A descriptor is not bound to its current catalog reference entity");
  }
  const pinnedCatalogReferenceHash = canonicalSha256(currentCatalogReferenceKey);
  const resources = geometry.dataSnapshot?.resources;
  const pinned = Array.isArray(resources) ? resources.find((resource: AnyRecord) =>
    resource?.referenceKey?.kind === "LAYER_FEATURE" && resource.pinning === "PINNED" &&
    canonicalSha256(resource.referenceKey) === pinnedCatalogReferenceHash && DIGEST.test(String(resource.digest))
  ) : undefined;
  const artifacts = geometry.computeSnapshot?.artifacts;
  const migration = Array.isArray(artifacts) ? artifacts.find((artifact: AnyRecord) =>
    artifact?.kind === "DATABASE" && artifact.version === "migration-062" &&
    artifact.digest === MIGRATION_062_DIGEST
  ) : undefined;
  if (!pinned || !migration) {
    throw new Error("Zone-A geometry omitted its pinned LAYER_FEATURE snapshot or migration-062 compute artifact");
  }
  return {
    layerFeaturePinned: true,
    layerFeatureReferenceHash: descriptorReferenceHash,
    descriptorReferenceHash,
    pinnedCatalogReferenceHash,
    sameEntity: true,
    layerFeatureDigest: pinned.digest,
    migration062Digest: MIGRATION_062_DIGEST
  };
}

function sameReferenceEntity(left: AnyRecord, right: AnyRecord): boolean {
  return typeof left.namespace === "string" && left.namespace === right.namespace &&
    typeof left.kind === "string" && left.kind === right.kind &&
    typeof left.id === "string" && left.id === right.id;
}

function assertScopeAndReadOnlyReceipts(cases: Map<string, AnyRecord>): {
  scopeAppliedBeforeQueryReceiptCount: number;
  readOnlyReceiptCount: number;
} {
  const groundingIds = [
    "CHAIN-REFERENCE-ZONE-A",
    "CHAIN-GEOMETRY-ZONE-A",
    "CHAIN-REFERENCE-UGV-002",
    "CHAIN-STATE-UGV-002"
  ];
  const spatialIds = ["CHAIN-SPATIAL-ZONE-A", "CHAIN-NEARBY-UGV-002"];
  for (const caseId of groundingIds) {
    const warnings = receiptWarnings(caseById(cases, caseId));
    if (!warnings.includes("grounding.scopeAppliedBeforeQuery=true") ||
        !warnings.includes("grounding.transaction=REPEATABLE_READ_READ_ONLY")) {
      throw new Error(`${caseId} omitted scope-before-query or read-only receipt evidence`);
    }
  }
  for (const caseId of spatialIds) {
    const warnings = receiptWarnings(caseById(cases, caseId));
    if (!warnings.some((warning) => warning.startsWith("spatial.scopeDigest=sha256:")) ||
        !warnings.includes("spatial.transaction=REPEATABLE_READ_READ_ONLY")) {
      throw new Error(`${caseId} omitted scoped read-only spatial receipt evidence`);
    }
  }
  return {
    scopeAppliedBeforeQueryReceiptCount: groundingIds.length,
    readOnlyReceiptCount: groundingIds.length + spatialIds.length
  };
}

function assertGovernedNonDisclosure(entry: AnyRecord): void {
  const allowed = new Set(["SCOPE_DENIED", "NO_DATA", "NOT_FOUND", "UNKNOWN"]);
  const category = entry.errorCategory ?? entry.comparison?.category;
  if (!allowed.has(category) || entry.attackVector !== "HIDDEN_FEATURE_ID" ||
      entry.comparison?.publicResponseEqual !== true ||
      entry.comparison?.hiddenIdentifierDisclosed !== false ||
      !DIGEST.test(String(entry.comparison?.hiddenPublicResponseHash)) ||
      entry.comparison?.hiddenPublicResponseHash !== entry.comparison?.controlPublicResponseHash) {
    throw new Error("Hidden LAYER_FEATURE geometry canary did not use governed non-disclosure");
  }
}

function caseById(cases: Map<string, AnyRecord>, caseId: string, operationId?: string): AnyRecord {
  const entry = cases.get(caseId);
  if (!entry || (operationId !== undefined && entry.operationId !== operationId)) {
    throw new Error(`Required canary case is absent or has the wrong operation: ${caseId}`);
  }
  return entry;
}

function comparisonDigest(entry: AnyRecord, name: string): string {
  const value = entry.comparison?.[name];
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`${entry.caseId} comparison.${name} is not a SHA-256 digest`);
  }
  return value;
}

function receiptWarnings(entry: AnyRecord): string[] {
  if (!Array.isArray(entry.receipts) || entry.receipts.length === 0) {
    throw new Error(`${entry.caseId} has no execution receipt`);
  }
  return entry.receipts.flatMap((receipt: AnyRecord) =>
    Array.isArray(receipt.warnings) ? receipt.warnings.filter((warning: unknown): warning is string => typeof warning === "string") : []
  );
}

function assertProviderIdentities(cases: Map<string, AnyRecord>): Record<string, string> {
  const roles = {
    reference: ["CHAIN-REFERENCE-ZONE-A", "gowm.reference-catalog"],
    validation: ["CHAIN-VALIDATE-ZONE-A", "gowm.platform-validation"],
    evidence: ["CHAIN-GEOMETRY-ZONE-A", "gowm.world-evidence"],
    spatial: ["CHAIN-SPATIAL-ZONE-A", "gowm.spatial-analysis.bridge"]
  } as const;
  return Object.fromEntries(Object.entries(roles).map(([role, [caseId, providerId]]) => {
    const entry = caseById(cases, caseId);
    const provider = entry.computeSnapshot?.provider;
    if (provider?.providerId !== providerId || !DIGEST.test(String(provider.implementationDigest))) {
      throw new Error(`${caseId} is not bound to the expected provider implementation identity`);
    }
    return [role, String(provider.implementationDigest)];
  }));
}

async function inspectDatabaseMigrationIdentity(runtime: SampleRuntimeEnvironment): Promise<{
  migrationCount: number;
  migrationSetHash: string;
}> {
  const expected = (await readdir(resolve(runtime.paths.root, "database/migrations")))
    .filter((name) => /^\d{3}_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/u.test(name))
    .sort();
  if (expected.length !== 62 || expected[0]?.startsWith("001_") !== true ||
      expected[61] !== "062_reference_geometry_composability.sql") {
    throw new Error("Qualification source does not contain the exact migrations 001 through 062");
  }
  const endpoint = samplePostgresEndpoint(runtime);
  const pool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    database: runtime.values.POSTGRES_DB,
    user: "gowm",
    password: runtime.values.POSTGRES_PASSWORD,
    max: 1,
    connectionTimeoutMillis: 10_000
  });
  try {
    const result = await pool.query<{ database_name: string; versions: string[] }>(
      "SELECT current_database() AS database_name,array_agg(version ORDER BY version)::text[] AS versions FROM schema_migration"
    );
    if (result.rows.length !== 1) {
      throw new Error("Live qualification database migration query returned an unexpected row count");
    }
    const row = result.rows[0]!;
    if (row.database_name !== runtime.values.POSTGRES_DB || !Array.isArray(row.versions) ||
        JSON.stringify(row.versions) !== JSON.stringify(expected)) {
      throw new Error("Live qualification database does not contain the exact migration set 001 through 062");
    }
    return { migrationCount: row.versions.length, migrationSetHash: canonicalSha256(row.versions) };
  } finally {
    await pool.end();
  }
}

function inspectCandidateImage(imageReference: string, candidateCommit: string): {
  imageId: string;
  repositoryDigestHashes: string[];
  revision: string;
  version: string;
} {
  const parsed = JSON.parse(execFileSync("docker", ["image", "inspect", imageReference], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024
  })) as AnyRecord[];
  const inspected = parsed[0];
  const imageId = String(inspected?.Id ?? "");
  const labels = inspected?.Config?.Labels as AnyRecord | undefined;
  const revision = String(labels?.["org.opencontainers.image.revision"] ?? "");
  const version = String(labels?.["org.opencontainers.image.version"] ?? "");
  if (parsed.length !== 1 || !DIGEST.test(imageId) || revision !== candidateCommit || version !== TARGET_VERSION) {
    throw new Error("Runtime image identity does not match the exact v0.6.4 candidate commit");
  }
  const repositoryDigests = Array.isArray(inspected?.RepoDigests)
    ? inspected.RepoDigests.filter((value: unknown): value is string => typeof value === "string").sort()
    : [];
  return {
    imageId,
    repositoryDigestHashes: repositoryDigests.map((value) => canonicalSha256(value)),
    revision,
    version
  };
}

function assertRunningCandidateImage(composeProjectName: string, imageId: string): number {
  const applicationServices = new Set([
    "reference-catalog-provider",
    "dataset-catalog-provider",
    "world-evidence-provider",
    "spatial-provider-bridge",
    "platform-validation-provider",
    "world-capability-gateway"
  ]);
  const ids = execFileSync("docker", [
    "ps",
    "--filter", `label=com.docker.compose.project=${composeProjectName}`,
    "--format", "{{.ID}}"
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024
  }).split(/\r?\n/u).filter(Boolean);
  if (ids.length === 0) throw new Error("Qualification Compose project has no running containers");
  const inspected = JSON.parse(execFileSync("docker", ["container", "inspect", ...ids], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024
  })) as AnyRecord[];
  const matched = new Set<string>();
  for (const container of inspected) {
    const labels = container?.Config?.Labels as AnyRecord | undefined;
    const service = labels?.["com.docker.compose.service"];
    if (!applicationServices.has(service)) continue;
    if (labels?.["com.docker.compose.project"] !== composeProjectName ||
        container?.State?.Running !== true || container?.Image !== imageId) {
      throw new Error("A running qualification application container does not use the exact candidate image");
    }
    matched.add(service);
  }
  if (matched.size !== applicationServices.size) {
    throw new Error("Qualification runtime is missing one or more candidate application containers");
  }
  return matched.size;
}

function assertOnlyRuntimeReportChanges(root: string): string[] {
  const output = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const paths = output.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3).replaceAll("\\", "/"));
  const forbidden = paths.filter((path) => !path.startsWith("reports/gowm-v0.6.3/"));
  if (forbidden.length > 0) {
    throw new Error(`Qualification source changed outside generated v0.6.3 reports: ${forbidden.join(",")}`);
  }
  return paths.sort();
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024
  });
}

async function readJsonArtifact(path: string): Promise<{ value: AnyRecord; sha256: string }> {
  const bytes = await readFile(path);
  const value = JSON.parse(bytes.toString("utf8")) as AnyRecord;
  return { value, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

function requiredSourceCommit(value: string | undefined): string {
  if (value === undefined || !SOURCE_COMMIT.test(value)) {
    throw new Error("A lowercase 40-hex qualification candidate commit is required");
  }
  return value;
}

function requiredBareDigest(value: string | undefined, label: string): string {
  if (value === undefined || !BARE_DIGEST.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assertSanitized(report: unknown, runtime: SampleRuntimeEnvironment): void {
  const serialized = JSON.stringify(report);
  const exactSecrets = SAMPLE_RUNTIME_SECRET_NAMES
    .map((name) => runtime.values[name])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (exactSecrets.some((secret) => serialized.includes(secret)) ||
      /(?:postgres(?:ql)?:\/\/|BEGIN (?:RSA )?PRIVATE KEY|GOWM_WSGS_SAMPLE_TOKEN=|PROVIDER_TRANSPORT_TOKEN=|wrf_[0-9a-f]{32})/u.test(serialized)) {
    throw new Error("Sanitized runtime evidence contains prohibited credential, topology or raw reference material");
  }
}
