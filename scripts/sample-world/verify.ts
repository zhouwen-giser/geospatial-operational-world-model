import { createHash, randomUUID, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  canonicalSha256,
  getContractSchemaHash,
  validateAgainstSchema,
  validateContract,
  type DelegationTokenClaims
} from "../../packages/platform/contract-runtime/src/index.js";
import { semanticSourceFingerprint } from "../../packages/platform/semantic-conformance/src/index.js";
import type { SampleWorldRealization } from "./model.js";
import { loadRuntimeSampleWorld } from "./loaded.js";
import { probeLiveSampleInstance } from "./readiness.js";
import { sampleGatewayBaseUrl, type SampleRuntimeEnvironment } from "./runtime.js";

type AnyRecord = Record<string, any>;

const REQUIRED_OPERATIONS = [
  "reference.get",
  "reference.resolve",
  "world.get-current-state",
  "world.get-geometry",
  "world.get-provenance",
  "catalog.get",
  "catalog.search",
  "spatial.find-nearby",
  "spatial.find-in-area",
  "spatial.find-intersections",
  "reference.validate",
  "result.validate"
] as const;
const PROMOTED_OPERATIONS = REQUIRED_OPERATIONS.slice(0, 10);
const HIDDEN_RESULT_REFERENCE_ARTIFACT = "HIDDEN_RESULT_REFERENCE.json";
const LATEST_BASELINE_SNAPSHOT = "LATEST_BASELINE_QUERY_SNAPSHOT.json";
const LATEST_MUTATION_REPLAY = "LATEST_MUTATION_PINNED_REPLAY.json";
const LATEST_FINAL_SNAPSHOT = "LATEST_FINAL_V1_QUERY_SNAPSHOT.json";

let currentBaselineSnapshot: SnapshotArtifactPointer | undefined;
let mutationReplayObserved = false;

interface VerifyOptions {
  runtime: SampleRuntimeEnvironment;
  expectedRevision?: "v1" | "v2";
  signedSmokeOnly?: boolean;
}

interface CaseReport {
  caseId: string;
  operationId: string;
  operationVersion: string;
  principal: string;
  status: "PASS" | "FAIL";
  evidenceSource: "GATEWAY_ENVELOPE" | "HTTP_RESPONSE" | "GATEWAY_HTTP" | "WORLD_QUERY";
  normalizedStatus?: string;
  responseStatus?: string;
  requestId?: string;
  inputHash?: string;
  outputHash?: string;
  submittedRequestHash?: string;
  httpResponseHash?: string;
  dataSnapshot?: unknown;
  computeSnapshot?: unknown;
  receipts?: unknown[];
  evidenceReferences?: unknown[];
  elapsedMs?: number;
  clientElapsedMs?: number;
  httpStatus?: number;
  errorCategory?: string;
  errorStage?: string;
  attackVector?: string;
  comparison?: Record<string, unknown>;
  artifact?: SnapshotArtifactPointer;
  detail?: string;
}

interface SnapshotArtifactPointer {
  phase: "BASELINE_V1" | "MUTATION_PINNED_REPLAY" | "FINAL_V1";
  artifactFile: string;
  artifactHash: string;
  snapshotManifestHash: string;
}

interface TimedGatewayResponse {
  statusCode: number;
  body: AnyRecord;
  clientElapsedMs: number;
}

export async function verifySampleWorld(options: VerifyOptions): Promise<Record<string, unknown>> {
  const realization = await loadRuntimeSampleWorld(options.runtime);
  const client = await GatewayClient.signed(options.runtime);
  await client.loadCatalog();
  assertRequiredOperations(client.catalog);
  if (options.signedSmokeOnly) {
    const reference = referenceFor(realization, "ugv-002", "world");
    const response = await client.execute("reference.get", { schemaVersion: "1.0", referenceKey: reference }, "SIGNED-DELEGATION-SMOKE");
    if (response.status !== "COMPLETED") throw new Error("Signed-delegation smoke did not complete");
    await assertSignedFailures(options.runtime, client, reference);
    process.stdout.write("SIGNED_DELEGATION_V1_SMOKE_PASS\n");
    return { status: "PASS", mode: "SIGNED_DELEGATION_V1" };
  }
  if (options.expectedRevision === "v2") return verifyMutation(client, realization, options.runtime);
  return verifyBaseline(client, realization, options.runtime);
}

export async function verifyStaticPrincipal(options: {
  runtime: SampleRuntimeEnvironment;
  principal: "VISIBLE" | "HIDDEN";
}): Promise<void> {
  const realization = await loadRuntimeSampleWorld(options.runtime);
  const token = options.principal === "VISIBLE"
    ? options.runtime.values.GOWM_WSGS_SAMPLE_TOKEN!
    : options.runtime.values.GOWM_WSGS_HIDDEN_TOKEN!;
  const client = new GatewayClient(options.runtime, { mode: "STATIC_SERVICE", token });
  await client.loadCatalog();
  const input = {
    schemaVersion: "1.0",
    mentions: [{ mentionId: `static-${options.principal.toLowerCase()}`, surfaceText: "2号车", expectedKinds: ["WORLD_OBJECT"] }],
    context: { anchorReferenceKeys: [], language: "zh-CN" },
    limitPerMention: 20
  };
  const result = await client.execute("reference.resolve", input, `STATIC-${options.principal}`);
  const ids = collectReferenceIds(result.output?.value);
  const expected = referenceFor(realization, options.principal === "VISIBLE" ? "ugv-002" : "hidden-ugv-002", "identity").id;
  const forbidden = referenceFor(realization, options.principal === "VISIBLE" ? "hidden-ugv-002" : "ugv-002", "identity").id;
  if (!ids.has(expected) || ids.has(forbidden)) {
    throw new Error(`Static ${options.principal} scope isolation failed`);
  }
  if (options.principal === "HIDDEN") {
    await captureHiddenResultReference(client, realization, options.runtime);
  }
  process.stdout.write(`STATIC_SERVICE_${options.principal}_PASS\n`);
}

async function verifyBaseline(
  client: GatewayClient,
  realization: SampleWorldRealization,
  runtime: SampleRuntimeEnvironment
): Promise<Record<string, unknown>> {
  const cases: CaseReport[] = [];
  for (const expected of realization.expectedCases as AnyRecord[]) {
    try {
      const operationId = String(expected.operationId);
      const result = await client.execute(operationId, expected.inputTemplate, String(expected.caseId));
      assertExpectedCase(expected, result, realization);
      cases.push(envelopeCaseReport({
        caseId: String(expected.caseId),
        operationId,
        principal: String(expected.principal),
        input: expected.inputTemplate,
        result,
        descriptor: client.descriptor(operationId)
      }));
    } catch (error) {
      cases.push(failCase(expected, error));
      throw withCaseReport(error, cases);
    }
  }

  const ugv2 = referenceFor(realization, "ugv-002", "world");
  const network = referenceFor(realization, "sample-road-network", "catalog");
  const extra = [
    ["REFERENCE-GET", "reference.get", { schemaVersion: "1.0", referenceKey: ugv2 }],
    ["CATALOG-GET", "catalog.get", { schemaVersion: "1.0", referenceKey: network }],
    ["REFERENCE-VALIDATE", "reference.validate", { schemaVersion: "1.0", references: [{ referenceKey: ugv2, requireCurrentSnapshot: true }] }],
    ["RESULT-VALIDATE", "result.validate", { schemaVersion: "1.0", references: [{ referenceKey: ugv2, requireCurrentSnapshot: true }] }]
  ] as const;
  for (const [caseId, operationId, input] of extra) {
    const result = await client.execute(operationId, input, caseId);
    if (!result.output?.value || !["COMPLETED", "PARTIAL", "NO_DATA"].includes(result.status)) {
      throw new Error(`${caseId} did not return a governed result`);
    }
    if ((operationId === "reference.validate" || operationId === "result.validate") &&
        !validationIsCurrent(result.output.value)) {
      throw new Error(`${caseId} did not confirm an available, current and usable reference`);
    }
    cases.push(envelopeCaseReport({
      caseId,
      operationId,
      principal: "VISIBLE",
      input,
      result,
      descriptor: client.descriptor(operationId)
    }));
  }

  const north = await client.execute("reference.resolve", {
    schemaVersion: "1.0",
    mentions: [{ mentionId: "north-gate", surfaceText: "北门", expectedKinds: ["LAYER_FEATURE"] }],
    context: { anchorReferenceKeys: [], language: "zh-CN" },
    limitPerMention: 20
  }, "REFERENCE-NORTH-GATE");
  if (!collectReferenceIds(north.output?.value).has(referenceFor(realization, "north-gate", "catalog").id)) {
    throw new Error("North-gate canonical reference did not resolve");
  }
  cases.push(envelopeCaseReport({
    caseId: "REFERENCE-NORTH-GATE",
    operationId: "reference.resolve",
    principal: "VISIBLE",
    input: {
      schemaVersion: "1.0",
      mentions: [{ mentionId: "north-gate", surfaceText: "北门", expectedKinds: ["LAYER_FEATURE"] }],
      context: { anchorReferenceKeys: [], language: "zh-CN" },
      limitPerMention: 20
    },
    result: north,
    descriptor: client.descriptor("reference.resolve")
  }));

  const chainResolveInput = {
    schemaVersion: "1.0",
    mentions: [{ mentionId: "chain-zone-a", surfaceText: "A区", expectedKinds: ["LAYER_FEATURE"] }],
    context: { anchorReferenceKeys: [], language: "zh-CN" },
    limitPerMention: 20
  };
  const chainResolve = await client.execute("reference.resolve", chainResolveInput, "CHAIN-REFERENCE-ZONE-A");
  const candidateReferenceKey = uniqueResolvedCandidateReferenceKey(chainResolve.output?.value, "Zone-A");
  const expectedIdentity = referenceFor(realization, "zone-a", "identity");
  const zoneReferenceHash = canonicalSha256(candidateReferenceKey);
  if (zoneReferenceHash !== canonicalSha256(expectedIdentity)) {
    throw new Error("Zone-A resolver candidate is not the expected immutable descriptor reference");
  }
  cases.push({
    ...envelopeCaseReport({
      caseId: "CHAIN-REFERENCE-ZONE-A",
      operationId: "reference.resolve",
      principal: "VISIBLE",
      input: chainResolveInput,
      result: chainResolve,
      descriptor: client.descriptor("reference.resolve")
    }),
    comparison: {
      referenceHash: zoneReferenceHash,
      referenceKind: "LAYER_FEATURE",
      hardcodedReferenceUsed: false
    }
  });

  const zoneValidateInput = {
    schemaVersion: "1.0",
    references: [{ referenceKey: candidateReferenceKey, requireCurrentSnapshot: true }]
  };
  const zoneValidate = await client.execute(
    "reference.validate",
    zoneValidateInput,
    "CHAIN-VALIDATE-ZONE-A"
  );
  if (!validationIsCurrent(zoneValidate.output?.value)) {
    throw new Error("Zone-A resolver descriptor pin was not CURRENT at the validation authority");
  }
  cases.push({
    ...envelopeCaseReport({
      caseId: "CHAIN-VALIDATE-ZONE-A",
      operationId: "reference.validate",
      principal: "VISIBLE",
      input: zoneValidateInput,
      result: zoneValidate,
      descriptor: client.descriptor("reference.validate")
    }),
    comparison: {
      referenceHash: zoneReferenceHash,
      inputReferenceHash: canonicalSha256(zoneValidateInput.references[0]!.referenceKey),
      requireCurrentSnapshot: true,
      currentAndUsable: true
    }
  });

  const chainGeometryInput = { schemaVersion: "1.0", referenceKey: candidateReferenceKey };
  const chainGeometry = await client.execute("world.get-geometry", chainGeometryInput, "CHAIN-GEOMETRY-ZONE-A");
  const geometry = currentGeometryFact(chainGeometry.output?.value);
  const expectedGeometryCase = (realization.expectedCases as AnyRecord[]).find((entry) =>
    entry.caseId === "WORLD-GEOMETRY-ZONE-A"
  );
  if (!expectedGeometryCase) throw new Error("Zone-A geometry expected case is missing");
  assertExpectedCase(expectedGeometryCase, chainGeometry, realization);
  cases.push({
    ...envelopeCaseReport({
      caseId: "CHAIN-GEOMETRY-ZONE-A",
      operationId: "world.get-geometry",
      principal: "VISIBLE",
      input: chainGeometryInput,
      result: chainGeometry,
      descriptor: client.descriptor("world.get-geometry")
    }),
    comparison: {
      referenceHash: zoneReferenceHash,
      inputReferenceHash: canonicalSha256(chainGeometryInput.referenceKey),
      geometryHash: canonicalSha256(geometry)
    }
  });

  const chainSpatialInput = {
    geometry,
    objectTypes: ["UGV"],
    limit: 1000,
    includeGeometry: true,
    crs: "EPSG:4326"
  };
  const chainSpatial = await client.execute("spatial.find-in-area", chainSpatialInput, "CHAIN-SPATIAL-ZONE-A");
  const expectedSpatialCase = (realization.expectedCases as AnyRecord[]).find((entry) =>
    entry.caseId === "SPATIAL-IN-ZONE-A"
  );
  if (!expectedSpatialCase) throw new Error("Zone-A spatial expected case is missing");
  assertExpectedCase(expectedSpatialCase, chainSpatial, realization);
  cases.push({
    ...envelopeCaseReport({
      caseId: "CHAIN-SPATIAL-ZONE-A",
      operationId: "spatial.find-in-area",
      principal: "VISIBLE",
      input: chainSpatialInput,
      result: chainSpatial,
      descriptor: client.descriptor("spatial.find-in-area")
    }),
    comparison: {
      referenceHash: zoneReferenceHash,
      geometryHash: canonicalSha256(geometry),
      inputGeometryHash: canonicalSha256(chainSpatialInput.geometry),
      expectedVehicleReferenceHash: canonicalSha256(referenceFor(realization, "ugv-002", "world")),
      expectedVehiclePresent: true
    }
  });

  const vehicleResolveInput = {
    schemaVersion: "1.0",
    mentions: [{ mentionId: "chain-ugv-002", surfaceText: "2号车", expectedKinds: ["WORLD_OBJECT"] }],
    context: { anchorReferenceKeys: [], language: "zh-CN" },
    limitPerMention: 20
  };
  const vehicleResolve = await client.execute(
    "reference.resolve",
    vehicleResolveInput,
    "CHAIN-REFERENCE-UGV-002"
  );
  const vehicleCandidateReferenceKey = uniqueResolvedCandidateReferenceKey(
    vehicleResolve.output?.value,
    "UGV-002"
  );
  const expectedVehicleIdentity = referenceFor(realization, "ugv-002", "identity");
  const vehicleReferenceHash = canonicalSha256(vehicleCandidateReferenceKey);
  if (vehicleReferenceHash !== canonicalSha256(expectedVehicleIdentity)) {
    throw new Error("UGV-002 resolver candidate is not the expected immutable descriptor reference");
  }
  cases.push({
    ...envelopeCaseReport({
      caseId: "CHAIN-REFERENCE-UGV-002",
      operationId: "reference.resolve",
      principal: "VISIBLE",
      input: vehicleResolveInput,
      result: vehicleResolve,
      descriptor: client.descriptor("reference.resolve")
    }),
    comparison: {
      referenceHash: vehicleReferenceHash,
      referenceKind: "WORLD_OBJECT",
      hardcodedReferenceUsed: false
    }
  });

  const vehicleValidateInput = {
    schemaVersion: "1.0",
    references: [{ referenceKey: vehicleCandidateReferenceKey, requireCurrentSnapshot: true }]
  };
  const vehicleValidate = await client.execute(
    "reference.validate",
    vehicleValidateInput,
    "CHAIN-VALIDATE-UGV-002"
  );
  if (!validationIsCurrent(vehicleValidate.output?.value)) {
    throw new Error("UGV-002 resolver descriptor pin was not CURRENT at the validation authority");
  }
  cases.push({
    ...envelopeCaseReport({
      caseId: "CHAIN-VALIDATE-UGV-002",
      operationId: "reference.validate",
      principal: "VISIBLE",
      input: vehicleValidateInput,
      result: vehicleValidate,
      descriptor: client.descriptor("reference.validate")
    }),
    comparison: {
      referenceHash: vehicleReferenceHash,
      inputReferenceHash: canonicalSha256(vehicleValidateInput.references[0]!.referenceKey),
      requireCurrentSnapshot: true,
      currentAndUsable: true
    }
  });

  const vehicleStateInput = { schemaVersion: "1.0", referenceKey: vehicleCandidateReferenceKey };
  const vehicleState = await client.execute(
    "world.get-current-state",
    vehicleStateInput,
    "CHAIN-STATE-UGV-002"
  );
  const vehiclePosition = currentPosition(vehicleState.output?.value, "UGV-002");
  cases.push({
    ...envelopeCaseReport({
      caseId: "CHAIN-STATE-UGV-002",
      operationId: "world.get-current-state",
      principal: "VISIBLE",
      input: vehicleStateInput,
      result: vehicleState,
      descriptor: client.descriptor("world.get-current-state")
    }),
    comparison: {
      referenceHash: vehicleReferenceHash,
      inputReferenceHash: canonicalSha256(vehicleStateInput.referenceKey),
      positionHash: canonicalSha256(vehiclePosition),
      positionCoordinatesHash: canonicalSha256(vehiclePosition.coordinates.slice(0, 2))
    }
  });

  const nearbyInput = {
    location: vehiclePosition.coordinates.slice(0, 2),
    radiusM: 1_000,
    objectTypes: ["UGV", "CAMERA", "TASK_TARGET", "SENSOR"],
    limit: 1_000,
    includeGeometry: true,
    crs: "EPSG:4326"
  };
  const nearby = await client.execute("spatial.find-nearby", nearbyInput, "CHAIN-NEARBY-UGV-002");
  const nearbyIds = collectReferenceIds(nearby.output?.value);
  if (!nearbyIds.has(referenceFor(realization, "target-01", "world").id) ||
      nearbyIds.has(referenceFor(realization, "hidden-ugv-002", "world").id)) {
    throw new Error("UGV-002 1km nearby chain did not preserve expected visible/hidden scope semantics");
  }
  cases.push({
    ...envelopeCaseReport({
      caseId: "CHAIN-NEARBY-UGV-002",
      operationId: "spatial.find-nearby",
      principal: "VISIBLE",
      input: nearbyInput,
      result: nearby,
      descriptor: client.descriptor("spatial.find-nearby")
    }),
    comparison: {
      referenceHash: vehicleReferenceHash,
      positionHash: canonicalSha256(vehiclePosition),
      positionCoordinatesHash: canonicalSha256(vehiclePosition.coordinates.slice(0, 2)),
      inputPositionHash: canonicalSha256(nearbyInput.location),
      radiusM: nearbyInput.radiusM,
      expectedReferenceHash: canonicalSha256(referenceFor(realization, "target-01", "world")),
      expectedReferencePresent: true
    }
  });

  const ambiguityInput = {
    schemaVersion: "1.0",
    mentions: [{ mentionId: "chain-river-road", surfaceText: "滨河路", expectedKinds: ["LAYER_FEATURE"] }],
    context: { anchorReferenceKeys: [], language: "zh-CN" },
    limitPerMention: 20
  };
  const ambiguity = await client.execute("reference.resolve", ambiguityInput, "CHAIN-AMBIGUITY-RIVER-ROAD");
  if (candidateCount(ambiguity.output?.value) !== 2 || !/AMBIGUOUS/u.test(JSON.stringify(ambiguity.output?.value))) {
    throw new Error("River-road ambiguity did not stop at the two governed candidates");
  }
  cases.push({
    ...envelopeCaseReport({
      caseId: "CHAIN-AMBIGUITY-RIVER-ROAD",
      operationId: "reference.resolve",
      principal: "VISIBLE",
      input: ambiguityInput,
      result: ambiguity,
      descriptor: client.descriptor("reference.resolve")
    }),
    comparison: { candidateCount: 2, downstreamExecutionCount: 0 }
  });

  const availabilityStarted = performance.now();
  const availability = await client.get("/v1/operation-availability", "OPERATION-AVAILABILITY", [...REQUIRED_OPERATIONS]);
  if (availability.statusCode !== 200 || !REQUIRED_OPERATIONS.every((operationId) =>
    (availability.body.operations as AnyRecord[] | undefined)?.some((entry) => entry.operationId === operationId && entry.availability === "AVAILABLE")
  )) throw new Error("Required operation availability is not AVAILABLE");
  if (/https?:\/\/|providerId|endpoint|containerName/iu.test(JSON.stringify(availability.body))) {
    throw new Error("Operation availability leaked Provider topology");
  }
  cases.push({
    caseId: "OPERATION-AVAILABILITY",
    operationId: "operation-availability",
    operationVersion: "1.0",
    principal: "VISIBLE",
    status: "PASS",
    evidenceSource: "GATEWAY_HTTP",
    normalizedStatus: "AVAILABLE",
    outputHash: canonicalSha256(availability.body),
    elapsedMs: performance.now() - availabilityStarted,
    clientElapsedMs: availability.clientElapsedMs,
    httpStatus: availability.statusCode
  });

  cases.push(...await assertSignedFailures(runtime, client, ugv2));
  cases.push(...await verifySecurityMatrix(client, realization, runtime));
  cases.push(await captureBaselineQuerySnapshot(client, realization, runtime));

  const promotedOperationPassCases = promotedOperationMapping(cases);
  const live = await probeLiveSampleInstance(runtime, { expectedRevision: "v1" });
  if (live.realizationId !== realization.fixture.realizationId) {
    throw new Error("Live realization does not match the canary fixture realization");
  }
  const semantics = await client.get("/v1/capability-semantics", "CAPABILITY-SEMANTICS", [...REQUIRED_OPERATIONS]);
  if (semantics.statusCode !== 200) throw new Error(`Capability semantics failed: HTTP ${semantics.statusCode}`);
  const contractCatalogRevision = requiredDigest(client.catalog.contractCatalogRevision, "live contractCatalogRevision");
  if (semantics.body.contractCatalogRevision !== contractCatalogRevision) {
    throw new Error("Live capability and semantic contract catalog revisions differ");
  }
  const semanticCatalogHash = requiredDigest(semantics.body.catalogHash, "live semantic catalog hash");
  const sourceDigest = await semanticSourceFingerprint(runtime.paths.root);

  const legacyReport = {
    schemaVersion: "1.0" as const,
    gatewayBaseUrlHash: canonicalSha256(sampleGatewayBaseUrl(runtime)),
    fixtureHash: realization.fixture.sourceFixtureHash,
    cases,
    status: "PASS" as const
  };
  const evidenceReport = {
    schemaVersion: "1.1" as const,
    gatewayBaseUrlHash: legacyReport.gatewayBaseUrlHash,
    fixtureHash: legacyReport.fixtureHash,
    realizationId: live.realizationId,
    loadedStateHash: live.loadedStateHash,
    contractCatalogRevision,
    semanticCatalogHash,
    sourceDigest,
    promotedOperationPassCases,
    cases,
    status: "PASS" as const
  };
  assertNoProviderTopology(evidenceReport);
  const legacyReportSchema = JSON.parse(await readFile(
    resolve(runtime.paths.root, "contracts/wsgs-sample-world/v1/sample-world-canary-report.schema.json"),
    "utf8"
  )) as Record<string, unknown>;
  const legacyValidation = validateAgainstSchema(legacyReportSchema, legacyReport, {
    schemaName: "sample-world-canary-report.schema.json"
  });
  if (!legacyValidation.valid) {
    throw new Error(`Canary report contract mismatch: ${JSON.stringify(legacyValidation.issues)}`);
  }
  const evidenceReportSchema = JSON.parse(await readFile(
    resolve(runtime.paths.root, "contracts/wsgs-sample-world/v1/sample-world-canary-evidence-report.schema.json"),
    "utf8"
  )) as Record<string, unknown>;
  const evidenceValidation = validateAgainstSchema(evidenceReportSchema, evidenceReport, {
    schemaName: "sample-world-canary-evidence-report.schema.json"
  });
  if (!evidenceValidation.valid) {
    throw new Error(`Canary evidence report contract mismatch: ${JSON.stringify(evidenceValidation.issues)}`);
  }
  await mkdir(runtime.paths.outputDirectory, { recursive: true });
  await writeJson(resolve(runtime.paths.outputDirectory, "CANARY_REPORT.json"), legacyReport);
  await writeJson(resolve(runtime.paths.outputDirectory, "CANARY_EVIDENCE_REPORT.json"), evidenceReport);
  process.stdout.write(`GROUNDING_CORE_SAMPLE_CANARY_PASS cases=${cases.length}\n`);
  return evidenceReport;
}

async function verifyMutation(
  client: GatewayClient,
  realization: SampleWorldRealization,
  runtime: SampleRuntimeEnvironment
): Promise<Record<string, unknown>> {
  const ugv2 = referenceFor(realization, "ugv-002", "world");
  const currentInput = { schemaVersion: "1.0", referenceKey: ugv2 };
  const current = await client.execute("world.get-current-state", currentInput, "MUTATION-STATE");
  const serialized = JSON.stringify(current.output?.value);
  for (const expected of ["PATROLLING", "73", "113.9355", "22.545"]) {
    if (!serialized.includes(expected)) throw new Error(`Mutation state is missing ${expected}`);
  }
  const inAreaCase = (realization.expectedCases as AnyRecord[]).find((entry) => entry.caseId === "SPATIAL-IN-ZONE-A");
  if (!inAreaCase) throw new Error("Zone-A expected case is missing");
  const zoneA = await client.execute("spatial.find-in-area", inAreaCase.inputTemplate, "MUTATION-ZONE-A");
  const zoneAIds = collectReferenceIds(zoneA.output?.value);
  if (zoneAIds.has(ugv2.id) || !zoneAIds.has(referenceFor(realization, "ugv-001", "world").id)) {
    throw new Error("Mutation did not move UGV-002 out of zone A");
  }
  const zoneB = (realization.features.visible as AnyRecord).features.find((feature: AnyRecord) => feature.properties.fixtureFeatureKey === "zone-b");
  const inZoneB = await client.execute("spatial.find-in-area", {
    geometry: zoneB.geometry,
    objectTypes: ["UGV"],
    limit: 100,
    includeGeometry: true,
    crs: "EPSG:4326"
  }, "MUTATION-ZONE-B");
  const zoneBIds = collectReferenceIds(inZoneB.output?.value);
  for (const fixtureKey of ["ugv-002", "ugv-003"]) {
    if (!zoneBIds.has(referenceFor(realization, fixtureKey, "world").id)) throw new Error(`${fixtureKey} is not in zone B after mutation`);
  }
  const pinnedReplay = await replayPinnedSnapshot(client, runtime);
  assertPinnedSnapshotMismatch(pinnedReplay.response);
  const cases = [
    envelopeCaseReport({
      caseId: "MUTATION-STATE",
      operationId: "world.get-current-state",
      principal: "VISIBLE",
      input: currentInput,
      result: current,
      descriptor: client.descriptor("world.get-current-state")
    }),
    envelopeCaseReport({
      caseId: "MUTATION-ZONE-A",
      operationId: "spatial.find-in-area",
      principal: "VISIBLE",
      input: inAreaCase.inputTemplate,
      result: zoneA,
      descriptor: client.descriptor("spatial.find-in-area")
    }),
    envelopeCaseReport({
      caseId: "MUTATION-ZONE-B",
      operationId: "spatial.find-in-area",
      principal: "VISIBLE",
      input: {
        geometry: zoneB.geometry,
        objectTypes: ["UGV"],
        limit: 100,
        includeGeometry: true,
        crs: "EPSG:4326"
      },
      result: inZoneB,
      descriptor: client.descriptor("spatial.find-in-area")
    })
  ];
  const report = {
    schemaVersion: "1.0",
    status: "PASS",
    scenarioId: "move-ugv-002-to-zone-b",
    checks: ["world-state-v2", "zone-a-membership-v2", "zone-b-membership-v2", "pinned-snapshot-stale"],
    cases,
    pinnedReplayArtifact: pinnedReplay.artifact,
    pinnedReplayStatus: securityCategory(pinnedReplay.response),
    generatedAt: new Date().toISOString()
  };
  await writeJson(resolve(runtime.paths.outputDirectory, "MUTATION_CANARY_REPORT.json"), report);
  process.stdout.write("SAMPLE_WORLD_MUTATION_CANARY_PASS\n");
  return report;
}

function assertExpectedCase(expected: AnyRecord, result: AnyRecord, realization: SampleWorldRealization): void {
  const body = result as AnyRecord;
  const value = body.output?.value;
  const ids = collectReferenceIds(value);
  for (const id of expected.expectedReferenceKeys ?? []) {
    if (!ids.has(String(id))) throw new Error(`${expected.caseId} is missing expected reference ${id}`);
  }
  const forbiddenIds = (expected.forbiddenFixtureKeys ?? []).map((fixtureKey: string) =>
    referenceFor(realization, fixtureKey, "identity").id
  );
  for (const id of forbiddenIds) if (ids.has(id)) throw new Error(`${expected.caseId} leaked forbidden reference ${id}`);
  if (expected.expectedCandidateCount !== undefined) {
    const count = candidateCount(value);
    if (count !== Number(expected.expectedCandidateCount)) {
      throw new Error(`${expected.caseId} candidate count mismatch: expected ${expected.expectedCandidateCount}, got ${count}`);
    }
  }
  if (expected.expectedStatus === "AMBIGUOUS" && !/AMBIGUOUS/u.test(JSON.stringify(value))) {
    throw new Error(`${expected.caseId} did not preserve ambiguity`);
  }
  if (expected.expectedStatus === "NO_DATA" &&
      body.status !== "NO_DATA" && !/UNRESOLVED|NO_DATA/u.test(JSON.stringify(value))) {
    throw new Error(`${expected.caseId} did not return governed no-data semantics`);
  }
  if (expected.expectedStatus === "COMPLETED" && body.status !== "COMPLETED") {
    throw new Error(`${expected.caseId} did not complete`);
  }
  if (expected.caseId === "WORLD-STATE-UGV2") {
    const serialized = JSON.stringify(value);
    for (const item of ["AVAILABLE", "78", "113.932", "22.542"]) {
      if (!serialized.includes(item)) throw new Error(`WORLD-STATE-UGV2 missing ${item}`);
    }
  }
}

async function assertSignedFailures(
  runtime: SampleRuntimeEnvironment,
  client: GatewayClient,
  reference: AnyRecord
): Promise<CaseReport[]> {
  const baseUrl = sampleGatewayBaseUrl(runtime);
  const input = { schemaVersion: "1.0", referenceKey: reference };
  const request = client.operationRequest("reference.get", input, "AUTH-NEGATIVE");
  const noDelegation = await timedJsonFetch(`${baseUrl}/v1/operations/reference.get:execute`, {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.values.GOWM_WSGS_SAMPLE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  assertSecurityError(noDelegation, "SCOPE_DENIED", "POLICY", "Signed mode accepted a request without delegation");
  const wrongBearer = await timedJsonFetch(`${baseUrl}/v1/operations/reference.get:execute`, {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.values.GOWM_WSGS_HIDDEN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  assertSecurityError(wrongBearer, "SCOPE_DENIED", "POLICY", "Signed mode accepted an unregistered bearer");
  const forged = await client.rawExecute("reference.get", request, {
    dataScopes: ["wsgs-hidden"], datasetScopes: ["wsgs-hidden-main"]
  });
  assertSecurityError(forged, "SCOPE_DENIED", "POLICY", "Signed mode accepted a forged hidden scope");
  return [
    httpSecurityCase("AUTH-MISSING-DELEGATION", "reference.get", "UNAUTHORIZED", "MISSING_SIGNED_DELEGATION", request, noDelegation),
    httpSecurityCase("AUTH-WRONG-BEARER", "reference.get", "UNAUTHORIZED", "UNREGISTERED_BEARER", request, wrongBearer),
    httpSecurityCase("AUTH-FORGED-DELEGATION-SCOPE", "reference.get", "VISIBLE", "FORGED_SIGNED_SCOPE", request, forged)
  ];
}

async function verifySecurityMatrix(
  client: GatewayClient,
  realization: SampleWorldRealization,
  runtime: SampleRuntimeEnvironment
): Promise<CaseReport[]> {
  const reports: CaseReport[] = [];
  const visibleUgv2 = referenceFor(realization, "ugv-002", "world");
  const hiddenUgv2 = referenceFor(realization, "hidden-ugv-002", "world");
  const hiddenFeature = referenceFor(realization, "hidden-zone-a", "catalog");

  const bodyForgeryInput = { schemaVersion: "1.0", referenceKey: visibleUgv2 };
  const bodyForgeryRequest = {
    ...client.operationRequest("reference.get", bodyForgeryInput, "SECURITY-FORGED-BODY-DATA-SCOPE"),
    securityContext: { dataScopeClaim: "wsgs-hidden" }
  };
  const bodyForgery = await client.rawExecute("reference.get", bodyForgeryRequest);
  assertSecurityError(bodyForgery, "INVALID_REQUEST", "REQUEST_VALIDATION", "Gateway accepted a body-forged DataScope");
  reports.push(httpSecurityCase(
    "SECURITY-FORGED-BODY-DATA-SCOPE",
    "reference.get",
    "VISIBLE",
    "BODY_DATA_SCOPE",
    bodyForgeryRequest,
    bodyForgery
  ));

  const headerForgeryInput = {
    schemaVersion: "1.0",
    mentions: [{ mentionId: "forged-dataset-header", surfaceText: "2号车", expectedKinds: ["WORLD_OBJECT"] }],
    context: { anchorReferenceKeys: [], language: "zh-CN" },
    limitPerMention: 20
  };
  const forgedDatasetScope = "wsgs-hidden-main";
  const headerForgeryRequest = client.operationRequest("reference.resolve", headerForgeryInput, "SECURITY-FORGED-HEADER-DATASET-SCOPE");
  const headerForgery = await client.rawExecute(
    "reference.resolve",
    headerForgeryRequest,
    {},
    { "x-gowm-dataset-scope": forgedDatasetScope }
  );
  if (headerForgery.statusCode !== 200) {
    throw new Error(`DatasetScope header forgery was not safely ignored: ${securityCategory(headerForgery.body)}`);
  }
  const headerIds = collectReferenceIds(headerForgery.body.output?.value);
  if (!headerIds.has(visibleUgv2.id) || headerIds.has(hiddenUgv2.id) || candidateCount(headerForgery.body.output?.value) !== 1) {
    throw new Error("DatasetScope header forgery changed the visible candidate set");
  }
  reports.push({
    ...envelopeCaseReport({
      caseId: "SECURITY-FORGED-HEADER-DATASET-SCOPE",
      operationId: "reference.resolve",
      principal: "VISIBLE",
      input: headerForgeryInput,
      result: headerForgery.body,
      descriptor: client.descriptor("reference.resolve")
    }),
    clientElapsedMs: headerForgery.clientElapsedMs,
    httpStatus: headerForgery.statusCode,
    submittedRequestHash: canonicalSha256(headerForgeryRequest),
    attackVector: "HEADER_DATASET_SCOPE",
    comparison: {
      forgedHeaderName: "x-gowm-dataset-scope",
      forgedHeaderValueHash: canonicalSha256(forgedDatasetScope),
      candidateCount: 1,
      hiddenCandidatePresent: false
    }
  });

  reports.push(await compareHiddenIdentifier({
    client,
    caseId: "SECURITY-DIRECT-HIDDEN-REFERENCE",
    operationId: "reference.get",
    hiddenInput: { schemaVersion: "1.0", referenceKey: hiddenUgv2 },
    controlInput: { schemaVersion: "1.0", referenceKey: absentReference("WORLD_OBJECT", "hidden-reference-control", hiddenUgv2.version) },
    attackVector: "HIDDEN_REFERENCE_KEY"
  }));
  reports.push(await compareHiddenIdentifier({
    client,
    caseId: "SECURITY-DIRECT-HIDDEN-FEATURE",
    operationId: "world.get-geometry",
    hiddenInput: { schemaVersion: "1.0", referenceKey: hiddenFeature },
    controlInput: { schemaVersion: "1.0", referenceKey: absentReference("LAYER_FEATURE", "hidden-feature-control", hiddenFeature.version) },
    attackVector: "HIDDEN_FEATURE_ID"
  }));

  const hiddenResult = await readHiddenResultReference(runtime);
  reports.push(await compareHiddenIdentifier({
    client,
    caseId: "SECURITY-DIRECT-HIDDEN-RESULT",
    operationId: "result.validate",
    hiddenInput: { schemaVersion: "1.0", references: [{ referenceKey: hiddenResult, requireCurrentSnapshot: true }] },
    controlInput: {
      schemaVersion: "1.0",
      references: [{ referenceKey: absentReference("QUERY_RESULT", "hidden-result-control", hiddenResult.version), requireCurrentSnapshot: true }]
    },
    attackVector: "HIDDEN_RESULT_ID"
  }));
  return reports;
}

async function compareHiddenIdentifier(options: {
  client: GatewayClient;
  caseId: string;
  operationId: string;
  hiddenInput: AnyRecord;
  controlInput: AnyRecord;
  attackVector: string;
}): Promise<CaseReport> {
  const descriptor = options.client.descriptor(options.operationId);
  for (const [label, input] of [["hidden", options.hiddenInput], ["control", options.controlInput]] as const) {
    const validation = validateContract(descriptor.inputSchemaUri, input);
    if (!validation.valid) throw new Error(`${options.caseId} ${label} input contract mismatch: ${JSON.stringify(validation.issues)}`);
  }
  const hiddenRequest = options.client.operationRequest(options.operationId, options.hiddenInput, `${options.caseId}-HIDDEN`);
  const controlRequest = options.client.operationRequest(options.operationId, options.controlInput, `${options.caseId}-CONTROL`);
  const hidden = await options.client.rawExecute(options.operationId, hiddenRequest);
  const control = await options.client.rawExecute(options.operationId, controlRequest);
  const hiddenCategory = securityCategory(hidden.body);
  const controlCategory = securityCategory(control.body);
  if (hidden.statusCode !== control.statusCode || hiddenCategory !== controlCategory) {
    throw new Error(
      `${options.caseId} leaked existence through HTTP/category ` +
      `${hidden.statusCode}/${hiddenCategory}; control was ${control.statusCode}/${controlCategory}`
    );
  }
  if (!["SCOPE_DENIED", "NO_DATA", "NOT_FOUND", "UNKNOWN"].includes(hiddenCategory)) {
    throw new Error(`${options.caseId} did not use a governed non-disclosure category: ${hiddenCategory}`);
  }
  const hiddenPublicResponse = normalizedNonDisclosureResponse(hidden.body, options.hiddenInput);
  const controlPublicResponse = normalizedNonDisclosureResponse(control.body, options.controlInput);
  const hiddenPublicResponseHash = canonicalSha256(hiddenPublicResponse);
  const controlPublicResponseHash = canonicalSha256(controlPublicResponse);
  const hiddenIdentifiers = submittedReferenceIdentifiers(options.hiddenInput);
  if (hiddenIdentifiers.some((identifier) => JSON.stringify(hiddenPublicResponse).includes(identifier))) {
    throw new Error(`${options.caseId} disclosed a hidden identifier outside the submitted-reference echo`);
  }
  if (hiddenPublicResponseHash !== controlPublicResponseHash) {
    throw new Error(`${options.caseId} leaked existence through its normalized public response shape`);
  }
  if (hidden.statusCode !== 200) {
    return {
      ...httpSecurityCase(
        options.caseId,
        options.operationId,
        "VISIBLE",
        options.attackVector,
        hiddenRequest,
        hidden
      ),
      comparison: {
        category: controlCategory,
        httpStatus: control.statusCode,
        submittedRequestHash: canonicalSha256(controlRequest),
        httpResponseHash: canonicalSha256(control.body),
        hiddenPublicResponseHash,
        controlPublicResponseHash,
        publicResponseEqual: true,
        hiddenIdentifierDisclosed: false,
        clientElapsedMs: control.clientElapsedMs,
        elapsedDeltaMs: Math.abs(hidden.clientElapsedMs - control.clientElapsedMs)
      }
    };
  }
  assertEnvelopeOutputContract(options.caseId, descriptor, hidden.body);
  assertEnvelopeOutputContract(`${options.caseId}-CONTROL`, descriptor, control.body);
  const report = envelopeCaseReport({
    caseId: options.caseId,
    operationId: options.operationId,
    principal: "VISIBLE",
    input: options.hiddenInput,
    result: hidden.body,
    descriptor
  });
  const controlReceipt = primaryReceipt(control.body, options.operationId, "1.0");
  return {
    ...report,
    clientElapsedMs: hidden.clientElapsedMs,
    httpStatus: hidden.statusCode,
    errorCategory: hiddenCategory,
    attackVector: options.attackVector,
    comparison: {
      category: controlCategory,
      normalizedStatus: String(control.body.status),
      inputHash: String(controlReceipt.inputHash),
      outputHash: String(controlReceipt.outputHash),
      hiddenPublicResponseHash,
      controlPublicResponseHash,
      publicResponseEqual: true,
      hiddenIdentifierDisclosed: false,
      elapsedMs: Number(control.body.execution?.elapsedMs),
      clientElapsedMs: control.clientElapsedMs,
      elapsedDeltaMs: Math.abs(hidden.clientElapsedMs - control.clientElapsedMs)
    }
  };
}

export function normalizedNonDisclosureResponse(body: unknown, submittedInput: unknown): unknown {
  const submittedReferences = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as AnyRecord;
    if (isReferenceKeyLike(record)) submittedReferences.add(canonicalSha256(record));
    Object.values(record).forEach(collect);
  };
  collect(submittedInput);
  const volatileKeys = new Set([
    "requestId", "receiptId", "generatedAt", "capturedAt", "durationMs", "elapsedMs",
    "clientElapsedMs", "inputHash", "outputHash", "computeSnapshotHash", "resultHash",
    "submittedRequestHash", "httpResponseHash", "instance", "traceId"
  ]);
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value === null || typeof value !== "object") return value;
    const record = value as AnyRecord;
    if (isReferenceKeyLike(record) && submittedReferences.has(canonicalSha256(record))) {
      return {
        namespace: "<SUBMITTED>",
        kind: record.kind,
        id: "<SUBMITTED>",
        version: "<SUBMITTED>"
      };
    }
    return Object.fromEntries(Object.entries(record)
      .filter(([key]) => !volatileKeys.has(key))
      .map(([key, child]) => [key, normalize(child)]));
  };
  return normalize(body);
}

export function submittedReferenceIdentifiers(value: unknown): string[] {
  const identifiers = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    const record = candidate as AnyRecord;
    if (isReferenceKeyLike(record) && record.id.length >= 8) identifiers.add(record.id);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...identifiers];
}

function isReferenceKeyLike(value: AnyRecord): value is AnyRecord & {
  namespace: string;
  kind: string;
  id: string;
  version: string;
} {
  return typeof value.namespace === "string" && typeof value.kind === "string" &&
    typeof value.id === "string" && typeof value.version === "string";
}

export function assertPinnedSnapshotMismatch(response: AnyRecord): void {
  const error = response?.error?.error;
  if (
    response?.status !== "FAILED" ||
    error?.code !== "SCHEMA_MISMATCH" ||
    error?.details?.stage !== "SNAPSHOT" ||
    error?.details?.adherenceStatus !== "MISMATCHED"
  ) {
    throw new Error("Pinned pre-mutation query did not prove a strict snapshot version mismatch");
  }
}

async function captureHiddenResultReference(
  client: GatewayClient,
  realization: SampleWorldRealization,
  runtime: SampleRuntimeEnvironment
): Promise<void> {
  const input = {
    schemaVersion: "1.0",
    referenceKey: referenceFor(realization, "hidden-ugv-002", "world")
  };
  const submission = buildSnapshotQuerySubmission(client, input, "hidden-security-result");
  const queued = await client.post("/v1/world-queries", submission, "HIDDEN-RESULT-CAPTURE", ["world.get-current-state"]);
  if (queued.statusCode !== 202) throw new Error(`Hidden world-query submission failed: ${JSON.stringify(queued.body)}`);
  const job = await pollJob(client, String(queued.body.jobId));
  if (job.result?.status !== "COMPLETED") {
    throw new Error(`Hidden world query did not complete: ${JSON.stringify(job)}`);
  }
  const surfaceText = `Query result ${String(submission.plan.queryId)}`;
  let resultReference: AnyRecord | undefined;
  for (let attempt = 0; attempt < 20 && resultReference === undefined; attempt += 1) {
    const resolved = await client.execute("reference.resolve", {
      schemaVersion: "1.0",
      mentions: [{ mentionId: "hidden-query-result", surfaceText, expectedKinds: ["QUERY_RESULT"] }],
      context: { anchorReferenceKeys: [], language: "en" },
      limitPerMention: 20
    }, `HIDDEN-RESULT-RESOLVE-${attempt}`);
    resultReference = collectReferenceKeys(resolved.output?.value).find((candidate) => candidate.kind === "QUERY_RESULT");
    if (resultReference === undefined) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (resultReference === undefined) throw new Error("Hidden query result identity did not become resolvable in the hidden scope");
  // reference.resolve reports the append-only descriptor version. Result validation is
  // pinned to the result registry's independent reference_version, which is v1.
  resultReference = { ...resultReference, version: "1" };
  const validationInput = {
    schemaVersion: "1.0",
    references: [{ referenceKey: resultReference, requireCurrentSnapshot: true }]
  };
  const validationResult = await client.execute(
    "result.validate",
    validationInput,
    "HIDDEN-RESULT-EXISTENCE-PROOF"
  );
  const validity = validationResult.output?.value?.results?.[0];
  if (validity?.existence !== "AVAILABLE") {
    throw new Error("Hidden query result was not AVAILABLE to its authorized hidden principal");
  }
  const existenceProof = envelopeCaseReport({
    caseId: "HIDDEN-RESULT-EXISTENCE-PROOF",
    operationId: "result.validate",
    principal: "HIDDEN",
    input: validationInput,
    result: validationResult,
    descriptor: client.descriptor("result.validate")
  });
  await writeJson(resolve(runtime.paths.outputDirectory, HIDDEN_RESULT_REFERENCE_ARTIFACT), {
    schemaVersion: "1.0",
    referenceKey: resultReference,
    referenceKeyHash: canonicalSha256(resultReference),
    queryIdHash: canonicalSha256(submission.plan.queryId),
    resultHash: canonicalSha256(job.result),
    existenceProof
  });
}

async function captureBaselineQuerySnapshot(
  client: GatewayClient,
  realization: SampleWorldRealization,
  runtime: SampleRuntimeEnvironment
): Promise<CaseReport> {
  const input = { schemaVersion: "1.0", referenceKey: referenceFor(realization, "ugv-002", "world") };
  const phase: SnapshotArtifactPointer["phase"] = mutationReplayObserved || process.argv[2] === "reset"
    ? "FINAL_V1"
    : "BASELINE_V1";
  const submission = buildSnapshotQuerySubmission(client, input, phase === "FINAL_V1" ? "final-v1" : "baseline-v1");
  const queued = await client.post("/v1/world-queries", submission, "QUERY-SNAPSHOT-CAPTURE", ["world.get-current-state"]);
  if (queued.statusCode !== 202) throw new Error(`World-query submission failed: ${JSON.stringify(queued.body)}`);
  const job = await pollJob(client, String(queued.body.jobId));
  if (job.result?.status !== "COMPLETED" || !job.result.snapshotManifest) {
    throw new Error(`${phase} world query did not capture a snapshot: ${JSON.stringify(job)}`);
  }
  const nodeEnvelope = (job.result.nodes as AnyRecord[] | undefined)?.find((node) => node.nodeId === "current")?.result;
  if (!nodeEnvelope) throw new Error(`${phase} world query omitted its real node envelope`);
  const snapshotManifestHash = canonicalSha256(job.result.snapshotManifest);
  const lineage = phase === "FINAL_V1"
    ? {
        baseline: currentBaselineSnapshot ?? await readSnapshotPointer(runtime, LATEST_BASELINE_SNAPSHOT, "BASELINE_V1"),
        mutationReplay: await readSnapshotPointer(runtime, LATEST_MUTATION_REPLAY, "MUTATION_PINNED_REPLAY")
      }
    : undefined;
  const artifactContent = {
    schemaVersion: "1.0",
    phase,
    submission,
    jobId: job.jobId,
    snapshotManifest: job.result.snapshotManifest,
    snapshotManifestHash,
    resultHash: canonicalSha256(job.result),
    ...(lineage === undefined ? {} : { lineage })
  };
  const artifactHash = canonicalSha256(artifactContent);
  const artifactFile = `${phase}_QUERY_SNAPSHOT-${String(submission.requestId)}.json`;
  await writeImmutableJson(resolve(runtime.paths.outputDirectory, artifactFile), {
    ...artifactContent,
    artifactHash
  });
  const pointer: SnapshotArtifactPointer = { phase, artifactFile, artifactHash, snapshotManifestHash };
  await writeJson(resolve(
    runtime.paths.outputDirectory,
    phase === "BASELINE_V1" ? LATEST_BASELINE_SNAPSHOT : LATEST_FINAL_SNAPSHOT
  ), pointer);
  if (phase === "BASELINE_V1") currentBaselineSnapshot = pointer;
  return {
    ...envelopeCaseReport({
      caseId: phase === "BASELINE_V1" ? "QUERY-SNAPSHOT-BASELINE-V1" : "QUERY-SNAPSHOT-FINAL-V1",
      operationId: "world.get-current-state",
      principal: "VISIBLE",
      input,
      result: nodeEnvelope,
      descriptor: client.descriptor("world.get-current-state")
    }),
    evidenceSource: "WORLD_QUERY",
    artifact: pointer
  };
}

export function buildSnapshotQuerySubmission(
  client: Pick<GatewayClient, "descriptor">,
  input: AnyRecord,
  label: string
): AnyRecord {
  const descriptor = client.descriptor("world.get-current-state");
  const outputPort = descriptor.ports.outputs.find((port: AnyRecord) => port.name === "result") ?? descriptor.ports.outputs[0];
  const requestId = `sample-query-${slug(label)}-${randomUUID()}`;
  const nodeBudget = {
    maximumRows: descriptor.limits.maximumRows ?? 100,
    maximumCandidates: descriptor.limits.maximumCandidates ?? 100,
    maximumOutputBytes: descriptor.limits.maximumOutputBytes,
    maximumExecutionMs: Math.min(30_000, descriptor.execution.maximumTimeoutMs)
  };
  return {
    requestId,
    idempotencyKey: requestId,
    snapshotPolicy: { mode: "LATEST_AT_START", allowDowngrade: false },
    parameterSchemaHash: getContractSchemaHash("world-query-parameters.schema.json"),
    parameters: {},
    plan: {
      queryPlanVersion: "2.0",
      queryId: `query-${requestId}`,
      nodes: [{
        nodeId: "current",
        operation: {
          operationId: "world.get-current-state",
          operationVersion: "1.0",
          inputSchemaHash: descriptor.inputSchemaHash,
          outputSchemaHash: descriptor.outputSchemaHash
        },
        inputs: {
          schemaVersion: {
            kind: "LITERAL",
            value: input.schemaVersion,
            targetPath: "/schemaVersion",
            port: {
              schemaUri: "urn:gowm:v0.2:value:string",
              schemaHash: getContractSchemaHash("urn:gowm:v0.2:value:string"),
              valueKind: "SCALAR",
              unitSemantics: "UNSPECIFIED"
            }
          },
          referenceKey: {
            kind: "REFERENCE_KEY",
            referenceKey: input.referenceKey,
            targetPath: "/referenceKey",
            port: {
              schemaUri: "urn:gowm:v0.4:reference-key",
              schemaHash: getContractSchemaHash("urn:gowm:v0.4:reference-key"),
              valueKind: "REFERENCE_KEY",
              unitSemantics: "UNSPECIFIED"
            }
          }
        },
        failurePolicy: "FAIL_FAST",
        budget: nodeBudget
      }],
      outputs: [{
        name: "value",
        binding: {
          kind: "NODE_OUTPUT",
          nodeId: "current",
          outputPort: outputPort.name,
          ...(outputPort.path ? { path: outputPort.path } : {}),
          port: portContract(outputPort)
        }
      }],
      budgets: {
        maximumNodes: 1,
        maximumDepth: 1,
        ...nodeBudget
      }
    }
  };
}

async function replayPinnedSnapshot(
  client: GatewayClient,
  runtime: SampleRuntimeEnvironment
): Promise<{ response: AnyRecord; artifact: SnapshotArtifactPointer }> {
  const baseline = await readBaselineSnapshot(runtime);
  const baselineBytesBefore = await readFile(baseline.path, "utf8");
  const baselineFileHashBefore = byteSha256(baselineBytesBefore);
  if (canonicalSha256(baseline.value.snapshotManifest) !== baseline.pointer.snapshotManifestHash) {
    throw new Error("Baseline snapshot manifest changed before replay");
  }
  const requestId = `sample-query-pinned-${randomUUID()}`;
  const submission = {
    ...baseline.value.submission,
    requestId,
    idempotencyKey: requestId,
    snapshotPolicy: { mode: "PINNED", pinnedSnapshot: baseline.value.snapshotManifest, allowDowngrade: false },
    plan: { ...baseline.value.submission.plan, queryId: `query-${requestId}` }
  };
  const queued = await client.post("/v1/world-queries", submission, "QUERY-SNAPSHOT-PINNED", ["world.get-current-state"]);
  const response = queued.statusCode === 202 ? await pollJob(client, String(queued.body.jobId)) : queued.body;
  const baselineBytesAfter = await readFile(baseline.path, "utf8");
  const baselineFileHashAfter = byteSha256(baselineBytesAfter);
  if (baselineFileHashAfter !== baselineFileHashBefore ||
      canonicalSha256(baseline.value.snapshotManifest) !== baseline.pointer.snapshotManifestHash) {
    throw new Error("Baseline snapshot artifact changed during pinned replay");
  }
  const artifactContent = {
    schemaVersion: "1.0",
    phase: "MUTATION_PINNED_REPLAY" as const,
    baselineArtifact: baseline.pointer,
    baselineFileHashBefore,
    baselineFileHashAfter,
    baselineSnapshotManifestHashBefore: baseline.pointer.snapshotManifestHash,
    baselineSnapshotManifestHashAfter: canonicalSha256(baseline.value.snapshotManifest),
    submission,
    response,
    responseHash: canonicalSha256(response)
  };
  const artifactHash = canonicalSha256(artifactContent);
  const artifactFile = `MUTATION_PINNED_REPLAY-${requestId}.json`;
  await writeImmutableJson(resolve(runtime.paths.outputDirectory, artifactFile), { ...artifactContent, artifactHash });
  const pointer: SnapshotArtifactPointer = {
    phase: "MUTATION_PINNED_REPLAY",
    artifactFile,
    artifactHash,
    snapshotManifestHash: baseline.pointer.snapshotManifestHash
  };
  await writeJson(resolve(runtime.paths.outputDirectory, LATEST_MUTATION_REPLAY), pointer);
  mutationReplayObserved = true;
  return { response, artifact: pointer };
}

async function pollJob(client: GatewayClient, jobId: string): Promise<AnyRecord> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const response = await client.get(`/v1/jobs/${jobId}`, `JOB-${jobId}-${attempt}`, ["world.get-current-state"]);
    if (response.statusCode !== 200) throw new Error(`Job read failed: ${JSON.stringify(response.body)}`);
    if (!["QUEUED", "RUNNING", "SUBMITTED"].includes(String(response.body.status))) return response.body;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`World-query job timed out: ${jobId}`);
}

class GatewayClient {
  catalog: AnyRecord = {};
  private readonly privateKey: string | undefined;
  private readonly baseUrl: string;

  constructor(
    private readonly runtime: SampleRuntimeEnvironment,
    private readonly auth: { mode: "STATIC_SERVICE" | "SIGNED_DELEGATION_V1"; token: string; privateKey?: string }
  ) {
    this.privateKey = auth.privateKey;
    this.baseUrl = sampleGatewayBaseUrl(runtime);
  }

  static async signed(runtime: SampleRuntimeEnvironment): Promise<GatewayClient> {
    const privateKey = await readFile(runtime.values.GOWM_WSGS_DELEGATION_PRIVATE_KEY_PATH!, "utf8");
    return new GatewayClient(runtime, { mode: "SIGNED_DELEGATION_V1", token: runtime.values.GOWM_WSGS_SAMPLE_TOKEN!, privateKey });
  }

  async loadCatalog(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/capabilities`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Capability catalog failed: ${response.status}`);
    this.catalog = await response.json() as AnyRecord;
  }

  descriptor(operationId: string): AnyRecord {
    const descriptor = (this.catalog.capabilities as AnyRecord[]).find((candidate) =>
      candidate.operationId === operationId && candidate.operationVersion === "1.0"
    );
    if (!descriptor) throw new Error(`Missing Gateway operation ${operationId}@1.0`);
    return descriptor;
  }

  operationRequest(operationId: string, input: unknown, label: string): AnyRecord {
    const descriptor = this.descriptor(operationId);
    const requestId = `sample-${slug(label)}-${randomUUID()}`.slice(0, 250);
    return {
      requestVersion: "1.0",
      requestId,
      idempotencyKey: requestId,
      operationVersion: "1.0",
      inputSchemaHash: descriptor.inputSchemaHash,
      outputSchemaHash: descriptor.outputSchemaHash,
      input,
      executionPolicy: {
        deadlineAt: new Date(Date.now() + Math.min(60_000, descriptor.execution.maximumTimeoutMs)).toISOString(),
        maximumResultBytes: descriptor.limits.maximumOutputBytes,
        maximumRows: descriptor.limits.maximumRows ?? 100,
        maximumCandidates: descriptor.limits.maximumCandidates ?? 100,
        maximumCostClass: descriptor.execution.costClass,
        preferredExecution: "SYNC"
      }
    };
  }

  async execute(operationId: string, input: unknown, label: string): Promise<AnyRecord> {
    const validation = validateContract(this.descriptor(operationId).inputSchemaUri, input);
    if (!validation.valid) throw new Error(`${label} input contract mismatch: ${JSON.stringify(validation.issues)}`);
    const request = this.operationRequest(operationId, input, label);
    const response = await this.rawExecute(operationId, request);
    if (response.statusCode !== 200) throw new Error(`${label} HTTP ${response.statusCode}: ${JSON.stringify(response.body)}`);
    const descriptor = this.descriptor(operationId);
    const output = response.body.output?.value;
    if (output !== undefined) {
      const outputValidation = validateContract(descriptor.outputSchemaUri, output);
      if (!outputValidation.valid) throw new Error(`${label} output contract mismatch: ${JSON.stringify(outputValidation.issues)}`);
    }
    return response.body;
  }

  async rawExecute(
    operationId: string,
    request: AnyRecord,
    claimOverrides: Partial<DelegationTokenClaims> = {},
    untrustedHeaders: Record<string, string> = {}
  ): Promise<TimedGatewayResponse> {
    return this.post(
      `/v1/operations/${operationId}:execute`,
      request,
      request.requestId,
      [operationId],
      claimOverrides,
      untrustedHeaders
    );
  }

  async get(path: string, label: string, allowedOperations: string[]): Promise<TimedGatewayResponse> {
    const requestId = `sample-${slug(label)}-${randomUUID()}`.slice(0, 250);
    const headers = await this.headers(requestId, allowedOperations);
    const started = performance.now();
    const response = await fetch(`${this.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    const body = await response.json() as AnyRecord;
    return { statusCode: response.status, body, clientElapsedMs: performance.now() - started };
  }

  async post(
    path: string,
    body: AnyRecord,
    label: string,
    allowedOperations: string[],
    claimOverrides: Partial<DelegationTokenClaims> = {},
    additionalHeaders: Record<string, string> = {}
  ): Promise<TimedGatewayResponse> {
    const requestId = typeof body.requestId === "string" ? body.requestId : `sample-${slug(label)}-${randomUUID()}`;
    const headers = await this.headers(requestId, allowedOperations, claimOverrides);
    const started = performance.now();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", prefer: "respond-async", ...additionalHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000)
    });
    const responseBody = await response.json() as AnyRecord;
    return { statusCode: response.status, body: responseBody, clientElapsedMs: performance.now() - started };
  }

  private async headers(
    requestId: string,
    operations: string[],
    overrides: Partial<DelegationTokenClaims> = {}
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.auth.token}`,
      "x-request-id": requestId
    };
    if (this.auth.mode === "SIGNED_DELEGATION_V1") {
      const now = Math.floor(Date.now() / 1_000);
      const claims: DelegationTokenClaims = {
        iss: this.runtime.values.GATEWAY_DELEGATION_ISSUER!,
        sub: this.runtime.values.GATEWAY_RUNTIME_PRINCIPAL_REF!,
        aud: this.runtime.values.GATEWAY_DELEGATION_AUDIENCE!,
        iat: now - 1,
        nbf: now - 1,
        exp: now + 120,
        jti: `sample-${randomUUID()}`,
        act: { sub: "actor:wsgs-integration" },
        requestId,
        delegationDepth: 1,
        dataScopes: ["wsgs-demo"],
        datasetScopes: ["wsgs-demo-main"],
        allowedOperations: [...new Set(operations.map((operation) => `${operation}@1.0`))],
        ...overrides
      };
      headers["x-gowm-delegation"] = compactJws(claims, this.privateKey!);
    }
    return headers;
  }
}

function compactJws(claims: DelegationTokenClaims, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput, "ascii"), privateKey).toString("base64url")}`;
}

function assertRequiredOperations(catalog: AnyRecord): void {
  for (const operationId of REQUIRED_OPERATIONS) {
    const descriptor = (catalog.capabilities as AnyRecord[]).find((candidate) =>
      candidate.operationId === operationId && candidate.operationVersion === "1.0"
    );
    if (!descriptor || descriptor.maturity !== "STABLE") throw new Error(`${operationId}@1.0 is not Stable in the live Gateway`);
  }
}

function referenceFor(realization: SampleWorldRealization, fixtureKey: string, pin: "identity" | "catalog" | "world"): AnyRecord {
  const entry = realization.referenceMap.entries.find((candidate) => candidate.fixtureKey === fixtureKey);
  if (!entry) throw new Error(`Reference-map fixture is missing: ${fixtureKey}`);
  if (pin === "catalog") return entry.currentCatalogReferenceKey ?? entry.identityReferenceKey;
  if (pin === "world") return entry.currentWorldReferenceKey ?? entry.identityReferenceKey;
  return entry.identityReferenceKey;
}

function candidateCount(value: unknown): number {
  const resolutions = (value as AnyRecord | undefined)?.resolutions;
  if (Array.isArray(resolutions) && Array.isArray(resolutions[0]?.candidates)) return resolutions[0].candidates.length;
  return collectReferenceIds(value).size;
}

function collectReferenceIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === "string" && /^wrf_[0-9a-f]{32}$/u.test(item)) ids.add(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item as AnyRecord).forEach(visit);
  };
  visit(value);
  return ids;
}

function collectReferenceKeys(value: unknown): AnyRecord[] {
  const references = new Map<string, AnyRecord>();
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== "object") return;
    const record = item as AnyRecord;
    if (record.namespace === "gowm" && typeof record.kind === "string" &&
        typeof record.id === "string" && /^wrf_[0-9a-f]{32}$/u.test(record.id) &&
        typeof record.version === "string") {
      references.set(`${record.kind}\u0000${record.id}\u0000${record.version}`, {
        namespace: record.namespace,
        kind: record.kind,
        id: record.id,
        version: record.version
      });
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...references.values()];
}

function uniqueResolvedCandidateReferenceKey(value: unknown, label: string): AnyRecord {
  const resolutions = (value as AnyRecord | undefined)?.resolutions;
  const candidates = Array.isArray(resolutions) && resolutions.length === 1 && Array.isArray(resolutions[0]?.candidates)
    ? resolutions[0].candidates
    : [];
  const referenceKey = candidates.length === 1 ? candidates[0]?.candidate?.referenceKey : undefined;
  if (!referenceKey || typeof referenceKey !== "object") {
    throw new Error(`${label} resolver did not return exactly one candidate reference key`);
  }
  return referenceKey as AnyRecord;
}

function currentPosition(value: unknown, label: string): { type: "Point"; coordinates: number[] } {
  const facts = (value as AnyRecord | undefined)?.facts;
  const position = Array.isArray(facts) && facts.length === 1 ? facts[0]?.position : undefined;
  if (!position || position.type !== "Point" || !Array.isArray(position.coordinates) ||
      position.coordinates.length < 2 || !position.coordinates.every((coordinate: unknown) =>
        typeof coordinate === "number" && Number.isFinite(coordinate)
      )) {
    throw new Error(`${label} current state did not return one authoritative Point position`);
  }
  return position as { type: "Point"; coordinates: number[] };
}

function currentGeometryFact(value: unknown): AnyRecord {
  const facts = (value as AnyRecord | undefined)?.facts;
  const geometry = Array.isArray(facts) && facts.length === 1 ? facts[0]?.geometry : undefined;
  if (!geometry || typeof geometry !== "object") {
    throw new Error("Zone-A world geometry did not return exactly one geometry fact");
  }
  return geometry as AnyRecord;
}

function validationIsCurrent(value: unknown): boolean {
  const results = (value as AnyRecord | undefined)?.results;
  return Array.isArray(results) && results.length > 0 && results.every((entry: AnyRecord) =>
    entry.existence === "AVAILABLE" && entry.usable === "YES" &&
    entry.freshness === "CURRENT" && entry.snapshot === "CURRENT"
  );
}

function envelopeCaseReport(options: {
  caseId: string;
  operationId: string;
  principal: string;
  input: unknown;
  result: AnyRecord;
  descriptor: AnyRecord;
}): CaseReport {
  assertEnvelopeOutputContract(options.caseId, options.descriptor, options.result);
  const operationVersion = String(options.result.operation.operationVersion);
  if (options.result.operation.operationId !== options.operationId || operationVersion !== "1.0") {
    throw new Error(`${options.caseId} returned the wrong operation identity`);
  }
  const receipt = primaryReceipt(options.result, options.operationId, operationVersion);
  const inputHash = String(receipt.inputHash);
  const outputHash = String(receipt.outputHash);
  const expectedInputHash = canonicalSha256(options.input);
  const expectedOutputHash = canonicalSha256(options.result.output?.value ?? null);
  if (inputHash !== expectedInputHash) throw new Error(`${options.caseId} receipt input hash mismatch`);
  if (outputHash !== expectedOutputHash) throw new Error(`${options.caseId} receipt output hash mismatch`);
  if (receipt.computeSnapshotHash !== canonicalSha256(options.result.computeSnapshot)) {
    throw new Error(`${options.caseId} receipt compute snapshot hash mismatch`);
  }
  if (options.result.execution?.resultHash !== outputHash) {
    throw new Error(`${options.caseId} execution result hash mismatch`);
  }
  if (options.descriptor.snapshotPolicy?.dataSnapshot === "REQUIRED" && options.result.dataSnapshot === undefined) {
    throw new Error(`${options.caseId} omitted its required data snapshot`);
  }
  if (!options.result.computeSnapshot || typeof options.result.computeSnapshot !== "object") {
    throw new Error(`${options.caseId} omitted its compute snapshot`);
  }
  if (!Array.isArray(options.result.receipts) || !Array.isArray(options.result.evidenceReferences)) {
    throw new Error(`${options.caseId} omitted receipt/evidence arrays`);
  }
  const elapsedMs = Number(options.result.execution?.elapsedMs);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error(`${options.caseId} omitted real envelope elapsed time`);
  return {
    caseId: options.caseId,
    operationId: options.operationId,
    operationVersion,
    principal: options.principal,
    status: "PASS",
    evidenceSource: "GATEWAY_ENVELOPE",
    normalizedStatus: String(options.result.status),
    responseStatus: String(options.result.status),
    requestId: String(options.result.requestId),
    inputHash,
    outputHash,
    dataSnapshot: options.result.dataSnapshot === undefined ? null : structuredClone(options.result.dataSnapshot),
    computeSnapshot: structuredClone(options.result.computeSnapshot),
    receipts: structuredClone(options.result.receipts),
    evidenceReferences: structuredClone(options.result.evidenceReferences),
    elapsedMs
  };
}

function assertEnvelopeOutputContract(caseId: string, descriptor: AnyRecord, result: AnyRecord): void {
  const envelopeValidation = validateContract("capability-result-envelope.schema.json", result);
  if (!envelopeValidation.valid) {
    throw new Error(`${caseId} result envelope contract mismatch: ${JSON.stringify(envelopeValidation.issues)}`);
  }
  if (result.output?.value !== undefined) {
    const outputValidation = validateContract(descriptor.outputSchemaUri, result.output.value);
    if (!outputValidation.valid) {
      throw new Error(`${caseId} output contract mismatch: ${JSON.stringify(outputValidation.issues)}`);
    }
  }
}

function primaryReceipt(result: AnyRecord, operationId: string, operationVersion: string): AnyRecord {
  const receipts = Array.isArray(result.receipts) ? result.receipts as AnyRecord[] : [];
  const receipt = receipts.find((candidate) =>
    candidate.operationId === operationId && candidate.operationVersion === operationVersion
  );
  if (!receipt) throw new Error(`${operationId}@${operationVersion} omitted its execution receipt`);
  return receipt;
}

function failCase(expected: AnyRecord, error: unknown): CaseReport {
  return {
    caseId: String(expected.caseId),
    operationId: String(expected.operationId),
    operationVersion: String(expected.operationVersion ?? "1.0"),
    principal: String(expected.principal),
    status: "FAIL",
    evidenceSource: "GATEWAY_ENVELOPE",
    normalizedStatus: "FAILED",
    detail: error instanceof Error ? error.message : String(error)
  };
}

function promotedOperationMapping(cases: CaseReport[]): Array<{
  operationId: string;
  operationVersion: "1.0";
  caseId: string;
}> {
  return PROMOTED_OPERATIONS.map((operationId) => {
    const match = cases.find((candidate) =>
      candidate.operationId === operationId && candidate.operationVersion === "1.0" &&
      candidate.status === "PASS" && candidate.normalizedStatus === "COMPLETED" &&
      ["GATEWAY_ENVELOPE", "WORLD_QUERY"].includes(candidate.evidenceSource)
    );
    if (!match) throw new Error(`Promoted operation has no real PASS canary case: ${operationId}@1.0`);
    return { operationId, operationVersion: "1.0", caseId: match.caseId };
  });
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} is missing or malformed`);
  }
  return value;
}

function assertNoProviderTopology(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (/"(?:endpoint|providerUrl|containerName)"\s*:/iu.test(serialized) ||
      /https?:\/\/(?:reference-catalog-provider|dataset-catalog-provider|world-evidence-provider|spatial-provider-bridge|platform-validation-provider)(?::|\/|"|$)/iu.test(serialized)) {
    throw new Error("Canary report leaked internal Provider topology");
  }
}

function securityCategory(body: AnyRecord): string {
  if (typeof body.error?.code === "string") return body.error.code;
  const firstValidation = body.output?.value?.results?.[0];
  if (typeof firstValidation?.existence === "string") return firstValidation.existence;
  if (typeof firstValidation?.snapshot === "string" && firstValidation.snapshot !== "NOT_APPLICABLE") {
    return firstValidation.snapshot;
  }
  if (typeof body.output?.value?.status === "string") return body.output.value.status;
  if (typeof body.status === "string") return body.status;
  return "UNKNOWN";
}

function assertSecurityError(
  response: TimedGatewayResponse,
  expectedCode: string,
  expectedStage: string,
  message: string
): void {
  if (response.statusCode < 400 || response.body.error?.code !== expectedCode ||
      response.body.error?.stage !== expectedStage) {
    throw new Error(`${message}: HTTP ${response.statusCode} category=${securityCategory(response.body)}`);
  }
}

function httpSecurityCase(
  caseId: string,
  operationId: string,
  principal: string,
  attackVector: string,
  request: AnyRecord,
  response: TimedGatewayResponse
): CaseReport {
  return {
    caseId,
    operationId,
    operationVersion: String(request.operationVersion ?? "1.0"),
    principal,
    status: "PASS",
    evidenceSource: "HTTP_RESPONSE",
    normalizedStatus: "REJECTED",
    responseStatus: String(response.statusCode),
    submittedRequestHash: canonicalSha256(request),
    httpResponseHash: canonicalSha256(response.body),
    clientElapsedMs: response.clientElapsedMs,
    httpStatus: response.statusCode,
    errorCategory: securityCategory(response.body),
    errorStage: typeof response.body.error?.stage === "string" ? response.body.error.stage : "UNKNOWN",
    attackVector
  };
}

async function timedJsonFetch(url: string, options: RequestInit): Promise<TimedGatewayResponse> {
  const started = performance.now();
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let body: AnyRecord;
  try {
    body = JSON.parse(text) as AnyRecord;
  } catch {
    throw new Error(`Gateway returned non-JSON security response: HTTP ${response.status}`);
  }
  return { statusCode: response.status, body, clientElapsedMs: performance.now() - started };
}

function absentReference(kind: string, label: string, version: string): AnyRecord {
  return {
    namespace: "gowm",
    kind,
    id: `wrf_${createHash("sha256").update(`sample-absent:${kind}:${label}`).digest("hex").slice(0, 32)}`,
    version
  };
}

async function readHiddenResultReference(runtime: SampleRuntimeEnvironment): Promise<AnyRecord> {
  const artifact = JSON.parse(await readFile(
    resolve(runtime.paths.outputDirectory, HIDDEN_RESULT_REFERENCE_ARTIFACT),
    "utf8"
  )) as AnyRecord;
  const reference = artifact.referenceKey as AnyRecord | undefined;
  if (reference?.namespace !== "gowm" || reference.kind !== "QUERY_RESULT" ||
      typeof reference.id !== "string" || !/^wrf_[0-9a-f]{32}$/u.test(reference.id) ||
      typeof reference.version !== "string" || artifact.referenceKeyHash !== canonicalSha256(reference) ||
      artifact.existenceProof?.status !== "PASS" || artifact.existenceProof?.principal !== "HIDDEN" ||
      artifact.existenceProof?.operationId !== "result.validate") {
    throw new Error("Hidden Result security artifact is missing or malformed; run the static hidden-principal lifecycle first");
  }
  return reference;
}

async function readBaselineSnapshot(runtime: SampleRuntimeEnvironment): Promise<{
  path: string;
  value: AnyRecord;
  pointer: SnapshotArtifactPointer;
}> {
  const pointer = currentBaselineSnapshot ?? await readSnapshotPointer(
    runtime,
    LATEST_BASELINE_SNAPSHOT,
    "BASELINE_V1"
  );
  const path = resolve(runtime.paths.outputDirectory, pointer.artifactFile);
  const value = JSON.parse(await readFile(path, "utf8")) as AnyRecord;
  const { artifactHash: embeddedHash, ...content } = value;
  if (embeddedHash !== pointer.artifactHash || canonicalSha256(content) !== pointer.artifactHash) {
    throw new Error("Baseline snapshot artifact content hash mismatch");
  }
  return { path, value, pointer };
}

async function readSnapshotPointer(
  runtime: SampleRuntimeEnvironment,
  name: string,
  expectedPhase: SnapshotArtifactPointer["phase"]
): Promise<SnapshotArtifactPointer> {
  const pointer = JSON.parse(await readFile(resolve(runtime.paths.outputDirectory, name), "utf8")) as SnapshotArtifactPointer;
  if (pointer.phase !== expectedPhase ||
      typeof pointer.artifactFile !== "string" || basename(pointer.artifactFile) !== pointer.artifactFile ||
      !pointer.artifactFile.startsWith(`${expectedPhase}`) || !pointer.artifactFile.endsWith(".json") ||
      !/^sha256:[0-9a-f]{64}$/u.test(pointer.artifactHash) ||
      !/^sha256:[0-9a-f]{64}$/u.test(pointer.snapshotManifestHash)) {
    throw new Error(`Snapshot pointer is malformed: ${name}`);
  }
  const artifact = JSON.parse(await readFile(
    resolve(runtime.paths.outputDirectory, pointer.artifactFile),
    "utf8"
  )) as AnyRecord;
  const { artifactHash: embeddedHash, ...content } = artifact;
  const embeddedSnapshotHash = expectedPhase === "MUTATION_PINNED_REPLAY"
    ? artifact.baselineSnapshotManifestHashAfter
    : artifact.snapshotManifestHash;
  const immutableSnapshotEvidenceValid = expectedPhase === "MUTATION_PINNED_REPLAY"
    ? artifact.baselineFileHashBefore === artifact.baselineFileHashAfter &&
      artifact.baselineSnapshotManifestHashBefore === artifact.baselineSnapshotManifestHashAfter
    : canonicalSha256(artifact.snapshotManifest) === pointer.snapshotManifestHash;
  if (!immutableSnapshotEvidenceValid || artifact.phase !== expectedPhase ||
      embeddedSnapshotHash !== pointer.snapshotManifestHash ||
      embeddedHash !== pointer.artifactHash || canonicalSha256(content) !== pointer.artifactHash) {
    throw new Error(`Snapshot pointer content hash mismatch: ${name}`);
  }
  return pointer;
}

function byteSha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function withCaseReport(error: unknown, reports: CaseReport[]): Error {
  const value = error instanceof Error ? error : new Error(String(error));
  value.message = `${value.message}; completed cases=${JSON.stringify(reports)}`;
  return value;
}

function portContract(port: AnyRecord): AnyRecord {
  return {
    schemaUri: port.schemaUri,
    schemaHash: port.schemaHash,
    valueKind: port.valueKind,
    unitSemantics: port.unitSemantics
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "request";
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}
