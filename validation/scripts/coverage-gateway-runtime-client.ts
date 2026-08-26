import { Pool } from "pg";

import {
  getContractSchemaHash,
  validateContract,
  type CapabilityDescriptor,
  type CapabilityResultEnvelope,
  type GatewayExecuteRequest,
  type WorldQueryPlanV2Node,
  type WorldQueryPlanV2SchemaPort,
  type WorldQueryResult,
  type WorldQuerySubmission,
  type GowmV06CoverageProblem,
  type GowmV06CoverageRoute
} from "../../packages/platform/contract-runtime/src/index.js";
import { sha256, type ProviderRuntime } from "../../packages/platform/provider-sdk/src/index.js";
import { createDataSnapshot } from "../../packages/platform/result-validation-core/src/index.js";
import { NetworkRepository, RoutingSnapshotCurrentnessEvaluator } from "../../packages/network-query-core/src/index.js";
import { coverageHardeningCases } from "./coverage-hardening-runtime-checks.js";
import { seedPlatformValidationCases, withAdvancedGraph } from "./coverage-validation-runtime-checks.js";
import {
  buildGatewayApp,
  CapabilityRegistry,
  DirectExecutionService,
  InProcessProviderClient,
  MemoryAuditSink,
  MemoryGatewayIdempotencyStore,
  PostgresQueryPlanStore,
  ProviderCircuitBreaker,
  QueryPlanValidator,
  WorldQueryRuntime,
  type GatewayPrincipal
} from "../../services/gateway/world-capability-gateway/src/index.js";
import {
  createRoadCoverageProvider,
  PostgresRoadCoverageEngine
} from "../../services/providers/road-coverage-provider/src/provider.js";
import { createGroundingCatalogProvider } from "../../services/providers/grounding-catalog-provider/src/provider.js";
import { createPlatformValidationProvider, PostgresPlatformValidationAuthority } from "../../services/providers/platform-validation-provider/src/index.js";
import { createNetworkProvider } from "../../services/providers/network-provider/src/provider.js";
import { createRoutePlanningProvider } from "../../services/providers/route-planning-provider/src/provider.js";

type Row = Record<string, unknown>;
const providerUrl = required("COVERAGE_PROVIDER_DATABASE_URL");
const gatewayUrl = required("COVERAGE_GATEWAY_DATABASE_URL");
const adminUrl = required("COVERAGE_ADMIN_DATABASE_URL");
const validationUrl = required("PLATFORM_VALIDATION_DATABASE_URL");
const catalogUrl = required("CATALOG_PROVIDER_DATABASE_URL");
const runId = required("GOWM_V06_RUN_ID");
const DATA_SCOPE = "coverage-gateway-runtime";
const DATASET_SCOPE = "tenant-a";
const checks: Record<string, boolean> = {};
const performanceEvidence: Record<string, { elapsedMs: number; maximumMs: number }> = {};
const providerPool = new Pool({ connectionString: providerUrl, max: 8 });
const gatewayPool = new Pool({ connectionString: gatewayUrl, max: 8 });
const adminPool = new Pool({ connectionString: adminUrl, max: 2 });
const validationPool = new Pool({ connectionString: validationUrl, max: 4 });
const catalogPool = new Pool({ connectionString: catalogUrl, max: 4 });
const referencePool = new Pool({ connectionString: adminUrl, options: "-c role=gowm_reference_reader", max: 2 });
const evidencePool = new Pool({ connectionString: adminUrl, options: "-c role=gowm_evidence_service", max: 2 });
const networkPool = new Pool({ connectionString: adminUrl, options: "-c role=network_provider", max: 2 });
const routePool = new Pool({ connectionString: adminUrl, options: "-c role=route_planner_provider", max: 2 });
const snapshot = {
  networkDatasetVersion: "dataset-v1",
  graphVersion: "graph-v1",
  travelProfileVersion: "travel-v1",
  costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`,
  costContentHash: `sha256:${"2".repeat(64)}`
};
const coverageRequest = {
  schemaVersion: "1.0",
  requestId: `${runId}-coverage-request`,
  routingSnapshot: snapshot,
  area: { type: "Polygon", coordinates: [[[0.0029,-0.0001],[0.0041,-0.0001],[0.0041,0.0001],[0.0029,0.0001],[0.0029,-0.0001]]] },
  routeCount: 1,
  selectionPolicy: {
    mode: "FULLY_COVERED_EDGE",
    roadClasses: ["LOCAL"],
    minimumSegmentLengthMm: 1,
    serviceMode: "FIXED_DIRECTION",
    fixedDirectionSource: "SOURCE_FEATURE_ATTRIBUTE",
    requiredPasses: 1,
    selectionPolicyVersion: "coverage-selection/1.0"
  },
  endpointPolicy: {
    start: { arcKey: `arc_${"1".repeat(64)}`, fractionPpm: 1000000, direction: "FORWARD" },
    entry: { mode: "AUTO", maximumCandidates: 8 },
    exit: { mode: "AUTO", maximumCandidates: 8 },
    endpointMode: "RETURN_TO_START",
    boundaryCrossingPolicy: "FREE",
    snapToleranceMm: 1000
  },
  objective: { profile: "FASTEST_COMPLETION" },
  alternativePolicy: {
    requestedCount: 2,
    minimumVerifiedCount: 2,
    profiles: ["SHORTEST_TOTAL_DISTANCE", "FASTEST_COMPLETION"],
    maximumWeightedArcOverlapPpm: 800000,
    minimumDeadheadJaccardDistancePpm: 100000
  },
  timeLimitMs: 60000
};

const principal: GatewayPrincipal = {
  principalRef: "principal:coverage-g00",
  authenticationMethod: "RUNTIME_ACCEPTANCE",
  authenticatedAt: new Date(Date.now() - 1000).toISOString(),
  dataScopeClaim: DATA_SCOPE,
  datasetScopeClaim: DATASET_SCOPE
};

const coverageEngine = new PostgresRoadCoverageEngine({
  pool: providerPool,
  resultTtlMs: 2500,
  leaseSeconds: 30,
  workerId: `coverage-${runId}`
});
const planWithDiagnostics = coverageEngine.plan.bind(coverageEngine);
coverageEngine.plan = async (input, context) => {
  try { return await planWithDiagnostics(input, context); }
  catch (error) { process.stderr.write(`CoveragePlanDiagnostic: ${error instanceof Error ? error.stack : String(error)}\n`); throw error; }
};
const coverage = createRoadCoverageProvider(coverageEngine);
const postgresValidationAuthority = new PostgresPlatformValidationAuthority(validationPool);
const platformValidation = createPlatformValidationProvider(postgresValidationAuthority);
const catalog = createGroundingCatalogProvider({
  mode: "dataset",
  pool: catalogPool,
  cursorSecret: "GowmCatalogG00CursorSecret_2026_Alpha_Bravo"
});
const referenceProvider = createGroundingCatalogProvider({ mode: "reference", pool: referencePool, cursorSecret: "GowmReferenceG00CursorSecret_2026_Alpha" });
const evidenceProvider = createGroundingCatalogProvider({ mode: "evidence", pool: evidencePool, cursorSecret: "GowmEvidenceG00CursorSecret_2026_Alpha" });
const networkProvider = createNetworkProvider({ pool: networkPool });
const routeProvider = createRoutePlanningProvider({ pool: routePool });
const registry = new CapabilityRegistry();
register(registry, coverage.runtime, "coverage", 36101);
register(registry, platformValidation.runtime, "platform-validation", 36102);
register(registry, catalog.runtime, "dataset-catalog", 36103);
register(registry, referenceProvider.runtime, "reference", 36104);
register(registry, evidenceProvider.runtime, "evidence", 36105);
register(registry, networkProvider.runtime, "network", 36106);
register(registry, routeProvider.runtime, "route", 36107);
const direct = new DirectExecutionService({
  registry,
  circuits: new ProviderCircuitBreaker(),
  idempotency: new MemoryGatewayIdempotencyStore(),
  audit: new MemoryAuditSink(),
  gatewayId: "coverage-g00-gateway",
  policyVersion: "coverage-g00/1",
  attestationIssuer: "coverage-g00-gateway"
});
const store = new PostgresQueryPlanStore(gatewayPool);
const worldQueries = new WorldQueryRuntime({
  validator: new QueryPlanValidator(registry),
  directExecution: direct,
  store,
  autoRunAsync: false
});
const app = buildGatewayApp({ registry, directExecution: direct, worldQueries, authenticate: async () => principal });

try {
  const validationCases = await seedPlatformValidationCases(adminPool, snapshot, DATA_SCOPE, DATASET_SCOPE);
  await persistRuntimeRegistry(adminPool, coverage.runtime, "http://coverage.coverage-g00.invalid");
  await persistRuntimeRegistry(adminPool, platformValidation.runtime, "http://platform-validation.coverage-g00.invalid");
  await persistRuntimeRegistry(adminPool, catalog.runtime, "http://dataset-catalog.coverage-g00.invalid");
  for (const runtime of [referenceProvider.runtime, evidenceProvider.runtime, networkProvider.runtime, routeProvider.runtime]) {
    await persistRuntimeRegistry(adminPool, runtime, `http://${runtime.manifest.provider.providerId}.coverage-g00.invalid`);
  }
  check("platformValidationSingleOwner", ["reference.validate", "result.validate"].every((id) => registry.resolve(id, "1.0").manifest.provider.providerId === "gowm.platform-validation"));
  const routePlan = envelopeValue(await execute("route.plan", {
    requestId: `${runId}-validation-route`, routingSnapshot: snapshot,
    start: coverageRequest.endpointPolicy.start, destination: { arcKey: `arc_${"5".repeat(64)}`, fractionPpm: 1_000_000, direction: "FORWARD" },
    travelProfile: "travel-v1", costProfile: "cost-v1", objective: "SHORTEST_DISTANCE", deadlineMs: 10_000
  }, `${runId}-validation-route`));
  const routeKey = row(routePlan.queryResultReferenceKey);
  check("platformRealRoutePublished", routePlan.status === "COMPLETED" && routeKey.kind === "QUERY_RESULT", routePlan);

  const semanticStartedAt = performance.now();
  const semanticCatalogResponse = await app.inject({ method: "GET", url: "/v1/capability-semantics" });
  const semanticCatalog = row(semanticCatalogResponse.json());
  const semanticProfiles = array(semanticCatalog.profiles).map(row);
  const semanticReplay = row((await app.inject({ method: "GET", url: "/v1/capability-semantics" })).json());
  check("capabilitySemanticsFromRegistry", semanticCatalogResponse.statusCode === 200 && semanticProfiles.length === registry.catalog().length, semanticCatalog);
  check("capabilitySemanticsUnique", new Set(semanticProfiles.map((profile) => `${profile.operationId}@${profile.operationVersion}`)).size === semanticProfiles.length, semanticProfiles);
  check("capabilitySemanticsDeterministic", semanticCatalog.catalogHash === semanticReplay.catalogHash, { semanticCatalog, semanticReplay });
  check("capabilitySemanticsCoverage", semanticProfiles.some((profile) => profile.operationId === "coverage.road.plan" && profile.resultNature === "PLAN" && profile.freshnessSemantics === "SNAPSHOT_CURRENTNESS"), semanticProfiles);
  check("capabilitySemanticsValidation", semanticProfiles.some((profile) => profile.operationId === "result.validate" && profile.resultNature === "VALIDATION") && semanticProfiles.some((profile) => profile.operationId === "snapshot.validate" && profile.resultNature === "VALIDATION"), semanticProfiles);
  check("capabilitySemanticsCatalog", semanticProfiles.some((profile) => profile.operationId === "catalog.search" && profile.resultNature === "CATALOG"), semanticProfiles);
  const coverageSemanticDetail = await app.inject({ method: "GET", url: "/v1/capability-semantics/coverage.road.plan/1.0" });
  check("capabilitySemanticsDetail", coverageSemanticDetail.statusCode === 200 && coverageSemanticDetail.json().operationId === "coverage.road.plan", coverageSemanticDetail.json());
  measured("semanticProjectionBounded", semanticStartedAt, 5000);

  const networkAuthority = new NetworkRepository({ pool: providerPool });
  const boundaryScope = { dataScopeKey: DATA_SCOPE, datasetScopeKey: DATASET_SCOPE };
  const loadedNetwork = await networkAuthority.loadPinned(snapshot, boundaryScope, 10_000);
  const currentRouting = await networkAuthority.inspectFreshness(loadedNetwork, boundaryScope, 10_000);
  check("routingCurrentnessCurrent", currentRouting.currentness.currentness === "CURRENT" && currentRouting.graphCurrent && currentRouting.profileCurrent && currentRouting.conditionCurrent, currentRouting);
  const unavailableRouting = await networkAuthority.inspectFreshness({ ...loadedNetwork, routingSnapshot: { ...loadedNetwork.routingSnapshot, graphVersion: "missing-g00-graph" } }, boundaryScope, 10_000);
  check("routingCurrentnessUnavailable", unavailableRouting.currentness.currentness === "UNAVAILABLE", unavailableRouting);
  const unknownWorldRouting = await networkAuthority.inspectFreshness({ ...loadedNetwork, routingSnapshot: { ...loadedNetwork.routingSnapshot, sourceWorldVersion: 1 } }, boundaryScope, 10_000);
  check("routingCurrentnessWorldStale", unknownWorldRouting.currentness.currentness === "STALE" && unknownWorldRouting.currentness.dimensions.sourceWorld === "STALE", unknownWorldRouting);
  const unknownConditionRouting = await networkAuthority.inspectFreshness({ ...loadedNetwork, routingSnapshot: { ...loadedNetwork.routingSnapshot, conditionSnapshotId: "unknown-prior-condition" } }, boundaryScope, 10_000);
  check("routingCurrentnessConditionUnknown", unknownConditionRouting.currentness.currentness === "UNKNOWN" && unknownConditionRouting.currentness.dimensions.condition === "UNKNOWN", unknownConditionRouting);
  const stripArea = { type: "Polygon", coordinates: [[[0.001,-0.0001],[0.002,-0.0001],[0.002,0.0001],[0.001,0.0001],[0.001,-0.0001]]] };
  const forwardBoundary = await networkAuthority.routeBoundaryCrossings(snapshot, stripArea, [{ arcKey: `arc_${"2".repeat(64)}`, startFractionPpm: 0, endFractionPpm: 1000000 }], boundaryScope, 10_000);
  check("boundaryForwardPolygon", forwardBoundary.crossings.map((item) => `${item.kind}:${item.fractionPpm}:${item.direction}`).join(",") === "ENTRY:333333:FORWARD,EXIT:666667:FORWARD" && forwardBoundary.startInside === false && forwardBoundary.endInside === false, forwardBoundary);
  const reverseBoundary = await networkAuthority.routeBoundaryCrossings(snapshot, stripArea, [{ arcKey: `arc_${"a".repeat(64)}`, startFractionPpm: 0, endFractionPpm: 1000000 }], boundaryScope, 10_000);
  check("boundaryReversePolygon", reverseBoundary.crossings.map((item) => `${item.kind}:${item.fractionPpm}:${item.direction}`).join(",") === "ENTRY:333333:REVERSE,EXIT:666667:REVERSE", reverseBoundary);
  const partialBoundary = await networkAuthority.routeBoundaryCrossings(snapshot, stripArea, [{ arcKey: `arc_${"2".repeat(64)}`, startFractionPpm: 500000, endFractionPpm: 1000000 }], boundaryScope, 10_000);
  check("boundaryPartialArcMembership", partialBoundary.startInside === true && partialBoundary.endInside === false && partialBoundary.crossings.length === 1 && partialBoundary.crossings[0]?.kind === "EXIT" && partialBoundary.crossings[0]?.fractionPpm === 666667, partialBoundary);
  const multiArea = { type: "MultiPolygon", coordinates: [
    [[[0.0005,-0.0001],[0.001,-0.0001],[0.001,0.0001],[0.0005,0.0001],[0.0005,-0.0001]]],
    [[[0.002,-0.0001],[0.0025,-0.0001],[0.0025,0.0001],[0.002,0.0001],[0.002,-0.0001]]]
  ] };
  const boundaryStartedAt = performance.now();
  const multiBoundary = await networkAuthority.routeBoundaryCrossings(snapshot, multiArea, [{ arcKey: `arc_${"2".repeat(64)}`, startFractionPpm: 0, endFractionPpm: 1000000 }], boundaryScope, 10_000);
  measured("boundaryQueryBounded", boundaryStartedAt, 10_000);
  check("boundaryMultiPolygon", multiBoundary.crossings.map((item) => item.kind).join(",") === "ENTRY,EXIT,ENTRY,EXIT" && multiBoundary.crossings.every((item, index) => item.sequence === index + 1), multiBoundary);
  const insideArea = { type: "Polygon", coordinates: [[[0.0029,-0.0001],[0.0041,-0.0001],[0.0041,0.0001],[0.0029,0.0001],[0.0029,-0.0001]]] };
  const insideBoundary = await networkAuthority.routeBoundaryCrossings(snapshot, insideArea, [{ arcKey: `arc_${"5".repeat(64)}`, startFractionPpm: 0, endFractionPpm: 1000000 }], boundaryScope, 10_000);
  check("boundaryStartEndInside", insideBoundary.startInside === true && insideBoundary.endInside === true && insideBoundary.crossings.length === 0, insideBoundary);
  const touchArea = { type: "Polygon", coordinates: [[[0.001,0],[0.0015,0.0002],[0.0005,0.0002],[0.001,0]]] };
  const touchBoundary = await networkAuthority.routeBoundaryCrossings(snapshot, touchArea, [{ arcKey: `arc_${"2".repeat(64)}`, startFractionPpm: 0, endFractionPpm: 1000000 }], boundaryScope, 10_000);
  check("boundaryTouchDeterministic", touchBoundary.crossings.length === 0 && touchBoundary.startInside === false && touchBoundary.endInside === false, touchBoundary);
  const boundaryReplay = await networkAuthority.routeBoundaryCrossings(snapshot, multiArea, [{ arcKey: `arc_${"2".repeat(64)}`, startFractionPpm: 0, endFractionPpm: 1000000 }], boundaryScope, 10_000);
  check("boundaryEvidenceReplay", boundaryReplay.crossings.map((item) => item.evidenceHash).join(",") === multiBoundary.crossings.map((item) => item.evidenceHash).join(","), { multiBoundary, boundaryReplay });
  let overlapRejected = false;
  try {
    await networkAuthority.routeBoundaryCrossings(snapshot, { type: "Polygon", coordinates: [[[0.001,0],[0.002,0],[0.002,0.0002],[0.001,0.0002],[0.001,0]]] }, [{ arcKey: `arc_${"2".repeat(64)}`, startFractionPpm: 0, endFractionPpm: 1000000 }], boundaryScope, 10_000);
  } catch (error) { overlapRejected = row(error).code === "INVALID_REQUEST"; }
  check("boundaryOverlapFailClosed", overlapRejected);
  let invalidAreaRejected = false;
  try {
    await networkAuthority.routeBoundaryCrossings(snapshot, { type: "Point", coordinates: [0, 0] }, [{ arcKey: `arc_${"2".repeat(64)}`, startFractionPpm: 0, endFractionPpm: 1000000 }], boundaryScope, 10_000);
  } catch (error) { invalidAreaRejected = row(error).code === "INVALID_REQUEST"; }
  check("boundaryInvalidAreaFailClosed", invalidAreaRejected);

  const productReference = (id: string, version: string) => ({ namespace: "gowm" as const, kind: "DATASET", id, version });
  const networkProductKey = productReference("wrf_60000000000000000000000000000001", "dataset-v1");
  const vectorProductKey = productReference("wrf_60000000000000000000000000000002", "vector-v1");
  const currentProductKey = productReference("wrf_60000000000000000000000000000003", "current-v1");
  const catalogStartedAt = performance.now();
  const productSearch = envelopeValue(await execute("catalog.search", { schemaVersion: "1.0", limit: 10 }, `${runId}-catalog-all`));
  measured("catalogSearchBounded", catalogStartedAt, 30_000);
  const productItems = array(productSearch.items).map(row);
  check("dataProductKinds", productItems.map((item) => item.dataKind).sort().join(",") === "CURRENT_PROJECTION,NETWORK,VECTOR", productItems);
  check("dataProductScopeBeforeCount", productItems.length === 3 && productItems.every((item) => row(item.referenceKey).id !== "wrf_6f000000000000000000000000000001"), productItems);

  const vectorProduct = envelopeValue(await execute("catalog.get", { schemaVersion: "1.0", referenceKey: vectorProductKey }, `${runId}-catalog-vector`));
  const boundCapabilities = (dataKind: "VECTOR" | "NETWORK" | "CURRENT_PROJECTION") => registry.catalog()
    .filter((descriptor) => dataKind === "CURRENT_PROJECTION"
      ? descriptor.dataBinding === "WORLD_SNAPSHOT_BOUND" && descriptor.operationId.startsWith("world.")
      : dataKind === "NETWORK"
        ? ["WORLD_SNAPSHOT_BOUND", "DATASET_VERSION_BOUND"].includes(descriptor.dataBinding) && /^(network|route|coverage)\./u.test(descriptor.operationId)
        : descriptor.dataBinding === "DATASET_VERSION_BOUND" && /^(dataset|layer|feature|spatial)\./u.test(descriptor.operationId))
    .map((descriptor) => descriptor.operationId).filter((operationId, index, values) => values.indexOf(operationId) === index).sort();
  check("dataProductVectorDescriptor", vectorProduct.dataKind === "VECTOR" && vectorProduct.currentVersion === "vector-v1", vectorProduct);
  check("dataProductSchemaCrsExtent", typeof vectorProduct.schemaHash === "string" && vectorProduct.crs === "EPSG:4326" && row(vectorProduct.spatialExtent).type === "Polygon" && row(vectorProduct.temporalExtent).from !== undefined, vectorProduct);
  check("dataProductLineageQuality", array(vectorProduct.lineage).includes("urn:test:vector-source:1") && row(vectorProduct.quality).validationStatus === "VALIDATED" && array(row(vectorProduct.quality).knownLimitations).includes("G00 fixture extent only"), vectorProduct);
  check("dataProductCapabilities", JSON.stringify(array(vectorProduct.supportedCapabilities)) === JSON.stringify(boundCapabilities("VECTOR")) && array(vectorProduct.supportedCapabilities).includes("dataset.get"), vectorProduct);
  const networkProduct = envelopeValue(await execute("catalog.get", { schemaVersion: "1.0", referenceKey: networkProductKey }, `${runId}-catalog-network`));
  const currentProduct = envelopeValue(await execute("catalog.get", { schemaVersion: "1.0", referenceKey: currentProductKey }, `${runId}-catalog-current`));
  check("dataProductNetworkDescriptor", networkProduct.dataKind === "NETWORK" && JSON.stringify(array(networkProduct.supportedCapabilities)) === JSON.stringify(boundCapabilities("NETWORK")) && array(networkProduct.supportedCapabilities).includes("coverage.road.plan"), networkProduct);
  check("dataProductCurrentDescriptor", currentProduct.dataKind === "CURRENT_PROJECTION" && JSON.stringify(array(currentProduct.supportedCapabilities)) === JSON.stringify(boundCapabilities("CURRENT_PROJECTION")), currentProduct);
  check("dataProductUnknownQuality", row(networkProduct.quality).validationStatus === "UNCHECKED" && row(networkProduct.quality).completeness === undefined, networkProduct);

  const versions = envelopeValue(await execute("catalog.list-versions", { schemaVersion: "1.0", referenceKey: vectorProductKey }, `${runId}-catalog-versions`));
  check("dataProductVersions", array(versions.value).map((item) => row(item).version).join(",") === "vector-v1,vector-v0", versions);
  const schemaDetail = envelopeValue(await execute("catalog.describe-schema", { schemaVersion: "1.0", referenceKey: vectorProductKey }, `${runId}-catalog-schema`));
  check("dataProductSchemaDetail", row(schemaDetail.value).schemaHash === vectorProduct.schemaHash && row(schemaDetail.value).schemaRef === vectorProduct.schemaRef, schemaDetail);
  const lineageDetail = envelopeValue(await execute("catalog.get-lineage", { schemaVersion: "1.0", referenceKey: vectorProductKey }, `${runId}-catalog-lineage`));
  const qualityDetail = envelopeValue(await execute("catalog.get-quality", { schemaVersion: "1.0", referenceKey: vectorProductKey }, `${runId}-catalog-quality`));
  const capabilityDetail = envelopeValue(await execute("catalog.get-capabilities", { schemaVersion: "1.0", referenceKey: vectorProductKey }, `${runId}-catalog-capabilities`));
  check("dataProductDetails", JSON.stringify(lineageDetail.value) === JSON.stringify(vectorProduct.lineage) && JSON.stringify(qualityDetail.value) === JSON.stringify(vectorProduct.quality) && JSON.stringify(capabilityDetail.value) === JSON.stringify(vectorProduct.supportedCapabilities));

  const vectorSearch = envelopeValue(await execute("catalog.search", { schemaVersion: "1.0", dataKinds: ["VECTOR"], limit: 10 }, `${runId}-catalog-kind`));
  check("dataProductKindSearch", array(vectorSearch.items).length === 1 && row(array(vectorSearch.items)[0]).dataKind === "VECTOR", vectorSearch);
  const spatialSearch = envelopeValue(await execute("catalog.search", { schemaVersion: "1.0", dataKinds: ["VECTOR"], spatialFilter: { type: "Polygon", coordinates: [[[0.003,-0.0001],[0.004,-0.0001],[0.004,0.0001],[0.003,0.0001],[0.003,-0.0001]]] }, limit: 10 }, `${runId}-catalog-spatial`));
  check("dataProductSpatialSearch", array(spatialSearch.items).length === 1, spatialSearch);
  const timeSearch = envelopeValue(await execute("catalog.search", { schemaVersion: "1.0", dataKinds: ["VECTOR"], timeFilter: { from: "2026-08-15T00:00:00Z", to: "2026-08-16T00:00:00Z" }, limit: 10 }, `${runId}-catalog-time`));
  check("dataProductTimeSearch", array(timeSearch.items).length === 1, timeSearch);
  const capabilitySearch = envelopeValue(await execute("catalog.search", { schemaVersion: "1.0", requiredCapabilities: ["coverage.road.plan"], limit: 10 }, `${runId}-catalog-capability`));
  check("dataProductCapabilitySearch", array(capabilitySearch.items).length === 1 && row(array(capabilitySearch.items)[0]).dataKind === "NETWORK", capabilitySearch);
  const validatedSearch = envelopeValue(await execute("catalog.search", { schemaVersion: "1.0", minimumValidationStatus: "VALIDATED", limit: 10 }, `${runId}-catalog-quality-search`));
  check("dataProductQualitySearch", array(validatedSearch.items).length === 2, validatedSearch);

  const firstPage = envelopeValue(await execute("catalog.search", { schemaVersion: "1.0", limit: 1 }, `${runId}-catalog-page-1`));
  const firstCursor = String(firstPage.nextCursor);
  const secondPage = envelopeValue(await execute("catalog.search", { schemaVersion: "1.0", cursor: firstCursor, limit: 1 }, `${runId}-catalog-page-2`));
  check("dataProductCursorStable", array(firstPage.items).length === 1 && array(secondPage.items).length === 1 && row(row(array(firstPage.items)[0]).referenceKey).id !== row(row(array(secondPage.items)[0]).referenceKey).id, { firstPage, secondPage });
  const tamperedCursor = await app.inject({ method: "POST", url: "/v1/operations/catalog.search:execute", payload: gatewayRequest("catalog.search", { schemaVersion: "1.0", cursor: `${firstCursor}x`, limit: 1 }, `${runId}-catalog-cursor-tamper`, "SYNC") });
  check("dataProductCursorTamper", tamperedCursor.statusCode === 422, tamperedCursor.json());
  const foreignGet = await app.inject({ method: "POST", url: "/v1/operations/catalog.get:execute", payload: gatewayRequest("catalog.get", { schemaVersion: "1.0", referenceKey: productReference("wrf_6f000000000000000000000000000001", "foreign-v1") }, `${runId}-catalog-foreign`, "SYNC") });
  check("dataProductCrossScopeOpaque", foreignGet.statusCode === 403 && JSON.stringify(foreignGet.json()).includes("wrf_6f000000000000000000000000000001") === false, foreignGet.json());
  const validate = await execute("coverage.road.validate", coverageRequest, `${runId}-validate`);
  const validation = envelopeValue(validate);
  check("validateDirect", validation.valid === true, validation);

  const selected = await execute("coverage.road.select-obligations", coverageRequest, `${runId}-select`);
  const obligationSet = envelopeValue(selected);
  check("selectDirect", obligationSet.obligationCount === 1, obligationSet);

  const directPlan = await app.inject({
    method: "POST",
    url: "/v1/operations/coverage.road.plan:execute",
    payload: gatewayRequest("coverage.road.plan", coverageRequest, `${runId}-forged-direct`, "ASYNC")
  });
  check("planRequiresGatewayJob", directPlan.statusCode === 422, directPlan.json());

  const submission = await coverageDag();
  try {
    new QueryPlanValidator(registry).validate(submission, principal);
  } catch (error) {
    const details = error !== null && typeof error === "object" && "details" in error ? (error as { details?: unknown }).details : error;
    throw new Error(`local DAG validation failed: ${JSON.stringify(details)}`);
  }
  const queued = await app.inject({ method: "POST", url: "/v1/world-queries", headers: { prefer: "respond-async" }, payload: submission });
  check("gatewayQueued", queued.statusCode === 202 && queued.json().status === "QUEUED", queued.json());
  const claim = await store.claimNext(`gateway-${runId}`, 60);
  check("gatewayClaimed", claim?.gatewayJobId !== undefined, claim);
  const result = await worldQueries.run(claim!.job.jobId);
  check("typedDagCompleted", result.status === "COMPLETED" && result.nodes.length === 3, result);
  check("typedDagOrder", result.nodes.map((node) => node.nodeId).join(",") === "geometry,validate,plan", result.nodes);
  const resultSet = row(result.outputs.plan);
  check("planAlternatives", resultSet.status === "SUCCEEDED" && array(resultSet.alternatives).length === 2, resultSet);
  check("queryResultIdentity", row(resultSet.referenceKey).kind === "QUERY_RESULT", resultSet.referenceKey);
  check("derivedAlternativeIdentity", array(resultSet.alternatives).every((value) => row(row(value).referenceKey).kind === "DERIVED_REFERENCE"));
  check("geometryOnDemand", array(resultSet.alternatives).every((value) => {
    const route = row(row(value).route);
    return route.geometry === undefined && route.geojson === undefined && array(route.segments).every((segment) => !JSON.stringify(segment).includes("coordinates"));
  }));

  const firstAlternative = row(array(resultSet.alternatives)[0]);
  const verify = await execute("coverage.road.verify", {
    schemaVersion: "1.0",
    problemReference: resultSet.referenceKey,
    candidate: firstAlternative,
    routingSnapshot: snapshot,
    revalidateAgainstCurrentCondition: true
  }, `${runId}-verify`);
  check("verifyDirect", envelopeValue(verify).status === "VALID", envelopeValue(verify));
  const tamperedAlternative = structuredClone(firstAlternative);
  const tamperedRoute = row(tamperedAlternative.route);
  tamperedRoute.metrics = { ...row(tamperedRoute.metrics), durationMs: Number(row(tamperedRoute.metrics).durationMs) + 1 };
  const invalidVerify = await execute("coverage.road.verify", {
    schemaVersion: "1.0",
    problemReference: resultSet.referenceKey,
    candidate: tamperedAlternative,
    routingSnapshot: snapshot,
    revalidateAgainstCurrentCondition: false
  }, `${runId}-verify-tampered`);
  check("frozenPlanInvalid", envelopeValue(invalidVerify).status === "INVALID", envelopeValue(invalidVerify));

  const expanded = await execute("coverage.road.expand-geojson", {
    schemaVersion: "1.0",
    resultSetReferenceKey: resultSet.referenceKey,
    alternativeId: firstAlternative.alternativeId,
    include: ["SEGMENTS"]
  }, `${runId}-expand`);
  const geojson = envelopeValue(expanded);
  const features = array(geojson.features).map(row);
  check("expandDirect", geojson.type === "FeatureCollection" && features.length > 0, geojson);
  check("expandOrder", features.every((feature, index) => row(feature.properties).sequence === index + 1));
  check("coverageTraversalCredit", features.every((feature) => row(feature.properties).coverageCredit === (row(feature.properties).traversalRole === "SERVICE")) && features.some((feature) => row(feature.properties).coverageCredit === true) && features.some((feature) => row(feature.properties).coverageCredit === false), features);

  const replayRuntime = new WorldQueryRuntime({
    validator: new QueryPlanValidator(registry), directExecution: direct, store, autoRunAsync: false
  });
  const replay = await replayRuntime.submit(structuredClone(submission), principal, "ASYNC");
  check("restartReplay", replay.replayed === true && sha256(replay.result) === sha256(result), replay);

  const registryRows = await adminPool.query(
    `SELECT
       (SELECT count(*)::integer FROM world_query_result_reference WHERE query_id=$1) AS query_results,
       (SELECT count(*)::integer FROM derived_reference WHERE source_query_id=$1) AS derived_results,
       (SELECT count(*)::integer FROM coverage_planner.coverage_candidate) AS candidates,
       (SELECT count(*)::integer FROM coverage_planner.coverage_route_segment) AS segments,
       (SELECT count(*)::integer FROM coverage_planner.coverage_verification_report) AS verifications,
       (SELECT count(*)::integer FROM coverage_planner.coverage_pairwise_similarity) AS similarities`,
    [submission.plan.queryId]
  );
  const persisted = row(registryRows.rows[0]);
  check("resultRegistry", persisted.query_results === 1 && persisted.derived_results === 2, persisted);
  check("atomicArtifacts", persisted.candidates === 2 && Number(persisted.segments) > 0 && persisted.verifications === 2, persisted);
  check("pairwiseSimilarity", persisted.similarities === 1, persisted);

  const validationEvidence = await adminPool.query<{ data_snapshot_hash: string; compute_snapshot_hash: string }>(
    "SELECT data_snapshot_hash,compute_snapshot_hash FROM public.world_query_result_reference WHERE reference_key=$1",
    [row(resultSet.referenceKey).id]
  );
  const dataSnapshotHash = validationEvidence.rows[0]?.data_snapshot_hash;
  const integrity = array(resultSet.receipts).map(row).find((receipt) => receipt.kind === "SNAPSHOT_INTEGRITY");
  check("coverageSnapshotHashSeparation", integrity !== undefined && new Set([resultSet.problemHash, integrity.dataSnapshotHash, integrity.computeSnapshotHash]).size === 3 &&
    validationEvidence.rows[0]?.data_snapshot_hash === integrity.dataSnapshotHash && validationEvidence.rows[0]?.compute_snapshot_hash === integrity.computeSnapshotHash, { integrity, registry: validationEvidence.rows[0] });
  const { snapshotHash: computeHash, ...computeBody } = row(integrity?.computeSnapshot);
  check("coverageComputeSnapshotContent", integrity !== undefined && validateContract("urn:gowm:v0.6.1:compute-snapshot-manifest", integrity.computeSnapshot).valid &&
    array(computeBody.engines).map(row).some((engine) => engine.name === "gowm-build-package" && /^sha256:[0-9a-f]{64}$/u.test(String(engine.digest))) &&
    sha256(computeBody) === computeHash && computeHash === integrity.computeSnapshotHash, integrity);
  if (dataSnapshotHash === undefined) throw new Error("coverage result data snapshot hash is unavailable");
  const resultReferenceKey = row(resultSet.referenceKey) as { namespace: "gowm"; kind: string; id: string; version: string };
  const resultContentHash = String((await adminPool.query("SELECT result_hash FROM world_query_result_reference WHERE reference_key=$1", [resultReferenceKey.id])).rows[0].result_hash);
  const platformSnapshot = createDataSnapshot("PINNED", [{ referenceKey: resultReferenceKey, resourceKind: "QUERY_RESULT", resourceId: resultReferenceKey.id, version: resultReferenceKey.version, contentHash: resultContentHash }]);
  await adminPool.query("SELECT public.register_platform_data_snapshot($1,$2,$3::jsonb)", [DATA_SCOPE, DATASET_SCOPE, JSON.stringify(platformSnapshot)]);
  const resultValidation = envelopeValue(await execute("result.validate", { schemaVersion: "1.0", references: [{ referenceKey: resultReferenceKey, requireCurrentSnapshot: true }] }, `${runId}-result-validation`));
  check("platformResultValidation", row(array(resultValidation.results)[0]).usable === "YES", resultValidation);
  const realResultSemantics = row(row(array(resultValidation.results)[0]).resultSemantics);
  check("platformOriginalStatusRetained", realResultSemantics.sourceStatus === "SUCCEEDED" && realResultSemantics.normalizedStatus === "COMPLETED" && array(row(array(resultValidation.results)[0]).validationEvidenceRefs).includes(dataSnapshotHash), resultValidation);

  const semanticKeys = validationCases.keys.slice(0, 8);
  const semanticValidation = envelopeValue(await execute("result.validate", {
    schemaVersion: "1.0",
    references: validationCases.keys.map((referenceKey) => ({ referenceKey }))
  }, `${runId}-result-semantic-mapping`));
  const semanticResults = array(semanticValidation.results).map(row);
  check("platformStatusMapping", semanticResults.slice(0, 8).map((item) => row(item.resultSemantics).normalizedStatus).join(",") === "COMPLETED,PARTIAL,NO_DATA,AMBIGUOUS,INDETERMINATE,NO_FEASIBLE_RESULT,STALE,FAILED", semanticResults);
  check("platformStatusBatchOrder", semanticResults.slice(0, 8).every((item, index) => row(item.referenceKey).id === semanticKeys[index]?.id), semanticResults);
  check("platformStaleRevalidate", semanticResults[6]?.freshness === "STALE" && semanticResults[6]?.usable === "REVALIDATE", semanticResults[6]);
  check("platformRetiredReference", semanticResults[8]?.existence === "RETIRED" && semanticResults[8]?.usable === "NO", semanticResults[8]);
  check("platformUnknownResultSnapshot", semanticResults[9]?.snapshot === "UNKNOWN" && semanticResults[9]?.usable === "REVALIDATE", semanticResults[9]);
  check("platformSiblingDatasetOpaque", semanticResults[10]?.existence === "NOT_FOUND" && semanticResults[10]?.resultSemantics === undefined, semanticResults[10]);
  const readStatuses = await Promise.all(semanticKeys.map((referenceKey, index) => execute("result.get", { schemaVersion: "1.0", referenceKey }, `${runId}-result-get-${index}`).then(envelopeValue)));
  check("resultGetCurrentSemantics", readStatuses.every((item, index) => item.status === row(semanticResults[index]!.resultSemantics).normalizedStatus && row(item.resultSemantics).sourceStatus === row(semanticResults[index]!.resultSemantics).sourceStatus), readStatuses);
  const foreignRead = await app.inject({ method: "POST", url: "/v1/operations/result.get:execute", payload: gatewayRequest("result.get", { schemaVersion: "1.0", referenceKey: validationCases.keys[10] }, `${runId}-result-get-sibling`, "SYNC") });
  check("resultGetSiblingDatasetOpaque", foreignRead.statusCode >= 400 && foreignRead.json().output === undefined, foreignRead.json());
  const unified = envelopeValue(await execute("reference.validate", { schemaVersion: "1.0", references: [validationCases.world, validationCases.derived, validationCases.set, vectorProductKey].map((referenceKey) => ({ referenceKey, requireCurrentSnapshot: true })) }, `${runId}-reference-validation`));
  check("platformReferenceKinds", array(unified.results).every((item) => row(item).usable === "YES"), unified);

  const foreignValidation = envelopeValue(await execute("result.validate", { schemaVersion: "1.0", references: [{ referenceKey: { namespace: "gowm", kind: "DATASET", id: "wrf_6f000000000000000000000000000001", version: "foreign-v1" } }] }, `${runId}-result-foreign`));
  const foreignValidity = row(array(foreignValidation.results)[0]);
  check("platformResultScopeOpaque", foreignValidity.existence === "NOT_FOUND" && JSON.stringify(foreignValidity).includes("coverage-gateway-foreign") === false, foreignValidity);
  const snapshotGet = envelopeValue(await execute("snapshot.get", { schemaVersion: "1.0", snapshotId: platformSnapshot.snapshotId }, `${runId}-snapshot-get`));
  check("platformSnapshotGet", snapshotGet.snapshotHash === platformSnapshot.snapshotHash && snapshotGet.consistency === "PINNED", snapshotGet);
  const snapshotCurrent = envelopeValue(await execute("snapshot.validate", { schemaVersion: "1.0", snapshot: platformSnapshot }, `${runId}-snapshot-current`));
  check("platformSnapshotCurrent", snapshotCurrent.status === "CURRENT", snapshotCurrent);
  const staleSnapshot = createDataSnapshot("PINNED", [{ ...platformSnapshot.resources[0]!, contentHash: `sha256:${"f".repeat(64)}` }]);
  const snapshotStale = envelopeValue(await execute("snapshot.validate", { schemaVersion: "1.0", snapshot: staleSnapshot }, `${runId}-snapshot-stale`));
  check("platformSnapshotStale", snapshotStale.status === "STALE", snapshotStale);
  const unknownSnapshot = createDataSnapshot("PINNED", [{ resourceKind: "UNKNOWN_RESOURCE", resourceId: "missing", version: "1" }]);
  const snapshotUnknown = envelopeValue(await execute("snapshot.validate", { schemaVersion: "1.0", snapshot: unknownSnapshot }, `${runId}-snapshot-unknown`));
  check("platformSnapshotUnknown", snapshotUnknown.status === "UNKNOWN", snapshotUnknown);

  const vectorSnapshotResource = { referenceKey: vectorProductKey, resourceKind: "DATASET", resourceId: vectorProductKey.id, version: "vector-v1", contentHash: `sha256:${"9".repeat(64)}` };
  const consistentSnapshot = createDataSnapshot("CONSISTENT_AT_START", [vectorSnapshotResource]);
  const bestEffortSnapshot = createDataSnapshot("BEST_EFFORT", [vectorSnapshotResource]);
  await adminPool.query("SELECT public.register_platform_data_snapshot($1,$2,$3::jsonb)", [DATA_SCOPE, DATASET_SCOPE, JSON.stringify(consistentSnapshot)]);
  await adminPool.query("SELECT public.register_platform_data_snapshot($1,$2,$3::jsonb)", [DATA_SCOPE, DATASET_SCOPE, JSON.stringify(bestEffortSnapshot)]);
  const consistentGet = envelopeValue(await execute("snapshot.get", { schemaVersion: "1.0", snapshotId: consistentSnapshot.snapshotId }, `${runId}-snapshot-consistent-get`));
  const bestEffortGet = envelopeValue(await execute("snapshot.get", { schemaVersion: "1.0", snapshotId: bestEffortSnapshot.snapshotId }, `${runId}-snapshot-best-effort-get`));
  check("platformSnapshotConsistencyPreserved", consistentGet.consistency === "CONSISTENT_AT_START" && bestEffortGet.consistency === "BEST_EFFORT", { consistentGet, bestEffortGet });
  const consistentCurrent = envelopeValue(await execute("snapshot.validate", { schemaVersion: "1.0", snapshot: consistentSnapshot }, `${runId}-snapshot-consistent-current`));
  const bestEffortCurrent = envelopeValue(await execute("snapshot.validate", { schemaVersion: "1.0", snapshot: bestEffortSnapshot }, `${runId}-snapshot-best-effort-current`));
  check("platformSnapshotConsistencyCurrent", consistentCurrent.status === "CURRENT" && bestEffortCurrent.status === "CURRENT", { consistentCurrent, bestEffortCurrent });

  const graphStale = createDataSnapshot("PINNED", [{ resourceKind: "NETWORK_GRAPH", resourceId: "coverage-gateway-graph", version: "graph-old", contentHash: `sha256:${"0".repeat(64)}` }]);
  const layerStale = createDataSnapshot("PINNED", [{ resourceKind: "LAYER", resourceId: "wrf_61000000000000000000000000000002", version: "layer-old", contentHash: `sha256:${"0".repeat(64)}` }]);
  const worldAdvanced = createDataSnapshot("PINNED", [{ resourceKind: "WORLD_REFERENCE", resourceId: validationCases.world.id, version: "1", worldVersion: 1 }]);
  const [graphStaleResult, layerStaleResult, worldAdvancedResult] = await Promise.all([
    execute("snapshot.validate", { schemaVersion: "1.0", snapshot: graphStale }, `${runId}-snapshot-graph-stale`).then(envelopeValue),
    execute("snapshot.validate", { schemaVersion: "1.0", snapshot: layerStale }, `${runId}-snapshot-layer-stale`).then(envelopeValue),
    execute("snapshot.validate", { schemaVersion: "1.0", snapshot: worldAdvanced }, `${runId}-snapshot-world-advanced`).then(envelopeValue)
  ]);
  check("platformSnapshotGraphStale", graphStaleResult.status === "STALE" && row(array(graphStaleResult.resourceResults)[0]).currentVersion === "graph-v1", graphStaleResult);
  check("platformSnapshotLayerStale", layerStaleResult.status === "STALE" && row(array(layerStaleResult.resourceResults)[0]).currentVersion === "layer-v1", layerStaleResult);
  check("platformSnapshotWorldAdvanced", worldAdvancedResult.status === "STALE", worldAdvancedResult);
  await adminPool.query("REVOKE SELECT ON gowm_network_v1.graph_version FROM network_provider");
  try {
    const unavailableResult = envelopeValue(await execute("snapshot.validate", { schemaVersion: "1.0", snapshot: graphStale }, `${runId}-snapshot-unavailable`));
    check("platformSnapshotUnavailable", unavailableResult.status === "UNAVAILABLE", unavailableResult);
  } finally { await adminPool.query("GRANT SELECT ON gowm_network_v1.graph_version TO network_provider"); }

  const invalidHashSnapshot = { ...structuredClone(consistentSnapshot), snapshotHash: `sha256:${"f".repeat(64)}` };
  const invalidHashResult = envelopeValue(await execute("snapshot.validate", { schemaVersion: "1.0", snapshot: invalidHashSnapshot }, `${runId}-snapshot-hash-mismatch`));
  check("platformSnapshotContentHash", invalidHashResult.status === "STALE" && String(row(array(invalidHashResult.resourceResults)[0]).reason).includes("identity"), invalidHashResult);
  const replaySnapshot = createDataSnapshot("CONSISTENT_AT_START", [vectorSnapshotResource]);
  check("platformSnapshotHashReplay", replaySnapshot.snapshotId === consistentSnapshot.snapshotId && replaySnapshot.snapshotHash === consistentSnapshot.snapshotHash, { replaySnapshot, consistentSnapshot });

  const foreignSnapshot = createDataSnapshot("PINNED", [{ resourceKind: "DATASET", resourceId: "wrf_6f000000000000000000000000000001", version: "foreign-v1", contentHash: `sha256:${"f".repeat(64)}` }]);
  await adminPool.query("SELECT public.register_platform_data_snapshot($1,$2,$3::jsonb)", ["coverage-gateway-foreign", "tenant-b", JSON.stringify(foreignSnapshot)]);
  const unavailableSnapshots = await Promise.all([foreignSnapshot.snapshotId, `snapshot_${"f".repeat(64)}`].map((snapshotId, index) => app.inject({
    method: "POST", url: "/v1/operations/snapshot.get:execute",
    payload: gatewayRequest("snapshot.get", { schemaVersion: "1.0", snapshotId }, `${runId}-snapshot-missing-${index}`, "SYNC")
  })));
  check("platformSnapshotScopeOpaque", unavailableSnapshots.every((response) => response.statusCode >= 400 && row(response.json().error).code === "VERSION_NOT_FOUND" && response.json().output === undefined) &&
    unavailableSnapshots[0]!.statusCode === unavailableSnapshots[1]!.statusCode, unavailableSnapshots.map((response) => response.json()));
  const snapshotCountBefore = Number((await adminPool.query("SELECT count(*) AS count FROM platform_data_snapshot")).rows[0]?.count);
  await execute("snapshot.validate", { schemaVersion: "1.0", snapshot: consistentSnapshot }, `${runId}-snapshot-read-only`);
  const snapshotCountAfter = Number((await adminPool.query("SELECT count(*) AS count FROM platform_data_snapshot")).rows[0]?.count);
  check("platformSnapshotReadOnly", snapshotCountAfter === snapshotCountBefore, { snapshotCountBefore, snapshotCountAfter });

  await new Promise((resolve) => setTimeout(resolve, 2800));
  const stale = await execute("coverage.road.verify", {
    schemaVersion: "1.0",
    problemReference: resultSet.referenceKey,
    candidate: firstAlternative,
    routingSnapshot: snapshot,
    revalidateAgainstCurrentCondition: true
  }, `${runId}-stale`);
  const staleReport = envelopeValue(stale);
  check("expiredIsStale", staleReport.status === "STALE" && row(staleReport.checks).currentness === true && row(staleReport.checks).resultTtl === false && array(staleReport.violations).some((value) => row(value).code === "RESULT_EXPIRED"), staleReport);

  const afterExpiry = await app.inject({
    method: "POST",
    url: "/v1/operations/coverage.road.expand-geojson:execute",
    payload: gatewayRequest("coverage.road.expand-geojson", {
      schemaVersion: "1.0", resultSetReferenceKey: resultSet.referenceKey,
      alternativeId: firstAlternative.alternativeId, include: ["SEGMENTS"]
    }, `${runId}-expired-expand`, "SYNC")
  });
  check("expiredExpansionDenied", afterExpiry.statusCode >= 400, afterExpiry.json());

  const queryGet = await app.inject({ method: "GET", url: `/v1/world-queries/${submission.plan.queryId}` });
  check("gatewayJobAuthority", queryGet.statusCode === 200 && queryGet.json().status === "COMPLETED", queryGet.json());

  await adminPool.query(`INSERT INTO network_travel_profile_version(
    travel_profile_id,data_scope_key,version,mode,required_access_mask,maximum_speed_mm_per_s,constraints,content_hash
  ) SELECT travel_profile_id,data_scope_key,'travel-v2',mode,required_access_mask,maximum_speed_mm_per_s,constraints,'sha256:'||repeat('8',64)
    FROM network_travel_profile_version WHERE version='travel-v1' AND data_scope_key=$1`, [DATA_SCOPE]);
  const travelStaleRouting = await networkAuthority.inspectFreshness(loadedNetwork, boundaryScope, 10_000);
  check("routingCurrentnessTravelStale", travelStaleRouting.currentness.staleDimensions.includes("TRAVEL_PROFILE"), travelStaleRouting);

  await adminPool.query(`INSERT INTO network_cost_profile_version(
    cost_profile_id,travel_profile_id,travel_profile_version_id,data_scope_key,version,
    distance_weight_ppm,duration_weight_ppm,risk_weight_ppm,energy_weight_ppm,formula,content_hash
  ) SELECT old.cost_profile_id,old.travel_profile_id,travel.travel_profile_version_id,old.data_scope_key,'cost-v2',
      old.distance_weight_ppm,old.duration_weight_ppm,old.risk_weight_ppm,old.energy_weight_ppm,old.formula,'sha256:'||repeat('6',64)
    FROM network_cost_profile_version old
    JOIN network_travel_profile_version travel ON travel.travel_profile_id=old.travel_profile_id AND travel.version='travel-v2'
    WHERE old.version='cost-v1' AND old.data_scope_key=$1`, [DATA_SCOPE]);
  const v2RoutingSnapshot = { ...loadedNetwork.routingSnapshot, travelProfileVersion: "travel-v2" };
  const costStaleRouting = await networkAuthority.inspectFreshness(loadedNetwork, boundaryScope, 10_000);
  check("routingCurrentnessCostStale", costStaleRouting.currentness.staleDimensions.includes("COST_PROFILE"), costStaleRouting);

  await adminPool.query(`INSERT INTO network_condition_snapshot(
    graph_version_id,data_scope_key,condition_snapshot_key,source_snapshot_version,observed_at,valid_until,
    completeness,source_content_hash,content_hash,metadata
  ) SELECT graph_version_id,data_scope_key,'cs_'||repeat('9',64),'condition-v2',clock_timestamp(),clock_timestamp()+interval '1 hour',
      'COMPLETE','sha256:'||repeat('9',64),'sha256:'||repeat('a',64),'{}'
    FROM network_graph_version WHERE graph_version='graph-v1' AND data_scope_key=$1`, [DATA_SCOPE]);
  const conditionStaleRouting = await networkAuthority.inspectFreshness({ ...loadedNetwork, routingSnapshot: { ...v2RoutingSnapshot, costProfileVersion: "cost-v2", costContentHash: `sha256:${"6".repeat(64)}` } }, boundaryScope, 10_000);
  check("routingCurrentnessConditionStale", conditionStaleRouting.currentness.staleDimensions.join(",") === "CONDITION", conditionStaleRouting);
  const staleResult = envelopeValue(await execute("result.validate", { schemaVersion: "1.0", references: [{ referenceKey: validationCases.keys[0]!, requireCurrentSnapshot: true }, { referenceKey: validationCases.derived, requireCurrentSnapshot: true }] }, `${runId}-result-currentness-after-update`));
  check("platformRoutingInputChanged", array(staleResult.results).every((item) => row(item).snapshot === "STALE" && row(item).usable === "REVALIDATE"), staleResult);
  const artifact = (await providerPool.query("SELECT coverage_planner.get_coverage_artifact($1,$2,$3) AS value", [row(resultSet.referenceKey).id, DATA_SCOPE, DATASET_SCOPE])).rows[0].value;
  await coverageHardeningCases({ admin: adminPool, network: networkAuthority, loaded: loadedNetwork, scope: boundaryScope,
    request: coverageRequest, problem: artifact.problem as GowmV06CoverageProblem, route: firstAlternative.route as GowmV06CoverageRoute,
    plan: planVariant, check });
  await withAdvancedGraph(adminPool, DATA_SCOPE, async () => {
    const graphStaleRouting = await networkAuthority.inspectFreshness(loadedNetwork, boundaryScope, 10_000);
    check("routingCurrentnessGraphStale", graphStaleRouting.currentness.currentness === "STALE" && graphStaleRouting.currentness.staleDimensions.includes("GRAPH"), graphStaleRouting);
    const stalePlanValidation = new RoutingSnapshotCurrentnessEvaluator().planValidation("VALID", graphStaleRouting.currentness);
    check("routingValiditySeparate", stalePlanValidation.planValidity === "VALID" && stalePlanValidation.currentness === "STALE" && stalePlanValidation.usable === "REVALIDATE", stalePlanValidation);
    const changed = envelopeValue(await execute("result.validate", { schemaVersion: "1.0", references: [resultReferenceKey, routeKey].map((referenceKey) => ({ referenceKey, requireCurrentSnapshot: true })) }, `${runId}-real-plan-graph-advanced`));
    check("platformRealPlanGraphChanged", array(changed.results).every((item) => row(item).snapshot === "STALE" && row(item).usable !== "YES"), changed);
  });
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    checks,
    performance: performanceEvidence,
    queryId: submission.plan.queryId,
    gatewayJobId: claim!.gatewayJobId,
    publicJobId: claim!.job.jobId,
    resultReferenceKey: row(resultSet.referenceKey).id,
    alternativeIds: array(resultSet.alternatives).map((value) => row(value).alternativeId),
    persisted
  })}\n`);
} finally {
  await app.close();
  await Promise.all([providerPool.end(), gatewayPool.end(), adminPool.end(), validationPool.end(), catalogPool.end(), referencePool.end(), evidencePool.end(), networkPool.end(), routePool.end()]);
}

async function execute(operationId: string, input: Row, idempotencyKey: string) {
  const response = await app.inject({
    method: "POST",
    url: `/v1/operations/${operationId}:execute`,
    payload: gatewayRequest(operationId, input, idempotencyKey, "SYNC")
  });
  if (response.statusCode !== 200) throw new Error(`${operationId} failed: ${response.statusCode} ${response.body}`);
  return response.json() as CapabilityResultEnvelope;
}

function measured(name: string, startedAt: number, maximumMs: number) {
  const elapsedMs = performance.now() - startedAt;
  performanceEvidence[name] = { elapsedMs, maximumMs };
  check(name, elapsedMs < maximumMs, performanceEvidence[name]);
}

function gatewayRequest(operationId: string, input: Row, idempotencyKey: string, preferredExecution: "SYNC" | "ASYNC"): GatewayExecuteRequest {
  const descriptor = registry.resolve(operationId, "1.0", true).descriptor;
  return {
    requestVersion: "1.0",
    requestId: `gateway_${idempotencyKey.replaceAll("-", "_")}`,
    idempotencyKey,
    operationVersion: "1.0",
    inputSchemaHash: descriptor.inputSchemaHash,
    outputSchemaHash: descriptor.outputSchemaHash,
    input,
    executionPolicy: {
      deadlineAt: new Date(Date.now() + Math.min(120000, descriptor.execution.maximumTimeoutMs)).toISOString(),
      maximumResultBytes: descriptor.limits.maximumOutputBytes ?? 16777216,
      maximumRows: Math.min(descriptor.limits.maximumRows ?? 100000, 100000),
      maximumCandidates: descriptor.limits.maximumCandidates ?? 1000,
      maximumCostClass: descriptor.execution.costClass,
      preferredExecution
    }
  };
}

async function planVariant(label: string, input: Row): Promise<Row> {
  const submission = await coverageDag({ ...input, requestId: `${runId}-${label}` }, `${runId}-${label}`);
  await worldQueries.submit(submission, principal, "ASYNC");
  const claim = await store.claimNext(`gateway-${label}`, 60);
  if (claim == null) throw new Error(`no Gateway job for ${label}`);
  const result = await worldQueries.run(claim.job.jobId);
  check(`${label}-gateway`, result.status === "COMPLETED", result);
  if (label === "objective-SHORTEST_TOTAL_DISTANCE") {
    const planned = row(result.outputs.plan);
    const candidate = row(array(planned.alternatives)[0]);
    const stale = envelopeValue(await execute("coverage.road.verify", { schemaVersion: "1.0", problemReference: planned.referenceKey, candidate, routingSnapshot: snapshot, revalidateAgainstCurrentCondition: true }, `${runId}-fresh-ttl-stale-snapshot`));
    check("routingCurrentnessFreshTtlStale", stale.status === "STALE" && row(stale.checks).resultTtl === true && row(stale.checks).currentness === false && row(stale.checks).metrics === true && row(stale.checks).snapshot === true, stale);
    const tampered = structuredClone(candidate);
    row(row(tampered.route).metrics).distanceMm = Number(row(row(tampered.route).metrics).distanceMm) + 1;
    const invalid = envelopeValue(await execute("coverage.road.verify", { schemaVersion: "1.0", problemReference: planned.referenceKey, candidate: tampered, routingSnapshot: snapshot, revalidateAgainstCurrentCondition: true }, `${runId}-invalid-and-stale`));
    check("frozenInvalidWithStaleSnapshot", invalid.status === "INVALID" && row(invalid.checks).currentness === false && row(invalid.checks).resultTtl === true, invalid);
  }
  return row(result.outputs.plan);
}

async function coverageDag(input: Row = coverageRequest, identity: string = runId): Promise<WorldQuerySubmission> {
  // Geometry is a real Foundation fact, read by the production World Evidence Provider.
  const objectId = `g00-area-${sha256(input.area).slice(7)}`;
  await adminPool.query("INSERT INTO world_object(id,object_type,data_scope_key) VALUES ($1,'COVERAGE_AREA',$2) ON CONFLICT (id) DO NOTHING", [objectId, DATA_SCOPE]);
  await adminPool.query("INSERT INTO world_object_state(object_id,version) VALUES ($1,1) ON CONFLICT (object_id) DO NOTHING", [objectId]);
  await adminPool.query("INSERT INTO world_object_geometry(object_id,geometry) VALUES ($1,ST_GeomFromGeoJSON($2)) ON CONFLICT (object_id) DO NOTHING", [objectId, JSON.stringify(input.area)]);
  const geometryKey = (await adminPool.query("SELECT reference_key FROM world_reference_identity WHERE entity_kind='WORLD_OBJECT' AND internal_id=$1 AND data_scope_key=$2", [objectId, DATA_SCOPE])).rows[0].reference_key;
  const geometryInput = { schemaVersion: "1.0", referenceKey: { namespace: "gowm", kind: "WORLD_OBJECT", id: geometryKey, version: "1" } };
  // Keep SQL diagnostics outside the public redacted Gateway error envelope.
  const geometryFact = await evidenceProvider.repository.execute("world.get-geometry", geometryInput, { dataScopeKey: DATA_SCOPE, datasetScopeKey: DATASET_SCOPE }, 10_000);
  check("worldGeometryAuthoritative", sha256(row(array(row(geometryFact.output).facts)[0]).geometry) === sha256(input.area), geometryFact.output);
  const geometryDescriptor = registry.resolve("world.get-geometry", "1.0", true).descriptor;
  const validateDescriptor = registry.resolve("coverage.road.validate", "1.0", true).descriptor;
  const planDescriptor = registry.resolve("coverage.road.plan", "1.0", true).descriptor;
  const requestPort = port(geometryDescriptor.ports.inputs[0]!);
  const geometryPort = port(geometryDescriptor.ports.outputs.find((candidate) => candidate.name === "geometry")!);
  const coverageInputs: WorldQueryPlanV2Node["inputs"] = {};
  for (const [name, value] of Object.entries(input)) {
    if (name === "area") {
      coverageInputs[name] = { kind: "NODE_OUTPUT", nodeId: "geometry", outputPort: "geometry", path: "/facts/0/geometry", targetPath: "/area", port: geometryPort };
    } else {
      const schemaUri = `urn:gowm:v0.2:value:${Array.isArray(value) ? "array" : typeof value}`;
      coverageInputs[name] = { kind: "LITERAL", targetPath: `/${name}`, value, port: { schemaUri, schemaHash: getContractSchemaHash(schemaUri), valueKind: "ANY", unitSemantics: "UNSPECIFIED" } };
    }
  }
  const validPort = port(validateDescriptor.ports.outputs.find((candidate) => candidate.name === "valid")!);
  const node = (nodeId: string, descriptor: CapabilityDescriptor, inputs: WorldQueryPlanV2Node["inputs"], preconditions?: WorldQueryPlanV2Node["preconditions"]): WorldQueryPlanV2Node => ({
    nodeId,
    operation: {
      operationId: descriptor.operationId,
      operationVersion: descriptor.operationVersion,
      inputSchemaHash: descriptor.inputSchemaHash,
      outputSchemaHash: descriptor.outputSchemaHash
    },
    inputs,
    ...(preconditions === undefined ? {} : { preconditions }),
    failurePolicy: "FAIL_FAST",
    budget: {
      maximumRows: Math.min(descriptor.limits.maximumRows ?? 100000, 100000),
      maximumCandidates: descriptor.limits.maximumCandidates ?? 100000,
      maximumOutputBytes: descriptor.limits.maximumOutputBytes ?? 16777216,
      maximumExecutionMs: Math.min(120000, descriptor.execution.maximumTimeoutMs)
    }
  });
  const nodes = [
    node("geometry", geometryDescriptor, { request: { kind: "LITERAL", port: requestPort, value: geometryInput } }),
    node("validate", validateDescriptor, coverageInputs),
    node("plan", planDescriptor, coverageInputs, [{
      kind: "VALUE_EQUALS",
      binding: { kind: "NODE_OUTPUT", nodeId: "validate", outputPort: "valid", path: "/valid", port: validPort },
      value: true
    }])
  ];
  return {
    requestId: `gateway-request-${identity}`,
    idempotencyKey: `gateway-idempotency-${identity}`,
    parameterSchemaHash: getContractSchemaHash("world-query-parameters.schema.json"),
    parameters: {},
    plan: {
      queryPlanVersion: "2.0",
      queryId: `coverage-query-${identity}`,
      nodes,
      outputs: [{ name: "plan", binding: { kind: "NODE_OUTPUT", nodeId: "plan", outputPort: "result", port: port(planDescriptor.ports.outputs[0]!) } }],
      budgets: {
        maximumNodes: 3,
        maximumDepth: 3,
        maximumRows: 300000,
        maximumCandidates: 300000,
        maximumOutputBytes: 50331648,
        maximumExecutionMs: 270000
      }
    }
  };
}

function register(target: CapabilityRegistry, runtime: ProviderRuntime, label: string, portNumber: number): void {
  target.register({ approvalId: `coverage-g00-${label}`, approved: true, endpoint: new URL(`http://127.0.0.1:${portNumber}/`), client: new InProcessProviderClient(runtime), manifest: runtime.manifest });
}
async function persistRuntimeRegistry(pool: Pool, runtime: ProviderRuntime, endpoint: string): Promise<void> {
  const manifest = runtime.manifest;
  await pool.query(
    `INSERT INTO gowm_capability.provider_registry(
       provider_id,provider_version,display_name,owner_name,endpoint,manifest_uri,endpoint_bindings,
       manifest_hash,implementation_digest,source_ref,approval_state,approved_by,approved_at,enabled
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,'APPROVED','coverage-g00',clock_timestamp(),true)`,
    [manifest.provider.providerId, manifest.provider.providerVersion, manifest.provider.providerId,
      manifest.provider.owner, endpoint, `${endpoint}/v1/manifest`, JSON.stringify(manifest.endpoints),
      sha256(manifest), manifest.provider.implementationDigest, manifest.provider.sourceRef ?? null]
  );
  for (const descriptor of manifest.capabilities) {
    await pool.query(
      `INSERT INTO gowm_capability.capability(operation_id,semantic_role,data_binding,result_semantics,description)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (operation_id) DO NOTHING`,
      [descriptor.operationId, descriptor.semanticRole, descriptor.dataBinding, descriptor.resultSemantics, `${descriptor.operationId} G00 runtime operation`]
    );
    await pool.query(
      `INSERT INTO gowm_capability.provider_operation(
         operation_id,operation_version,provider_id,input_schema_uri,input_schema_hash,output_schema_uri,
         output_schema_hash,maturity,scope_policy,execution_mode,execution_bindings,critical_path_policy,
         default_timeout_ms,maximum_timeout_ms,cost_class,limits,ports,data_snapshot_policy,
         compute_snapshot_policy,policy_version,enabled
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,$20,true)`,
      [descriptor.operationId, descriptor.operationVersion, manifest.provider.providerId,
        descriptor.inputSchemaUri, descriptor.inputSchemaHash, descriptor.outputSchemaUri, descriptor.outputSchemaHash,
        descriptor.maturity, descriptor.scopePolicy, descriptor.execution.mode, descriptor.executionBindings,
        descriptor.criticalPathPolicy, descriptor.execution.defaultTimeoutMs, descriptor.execution.maximumTimeoutMs,
        descriptor.execution.costClass, JSON.stringify(descriptor.limits), JSON.stringify(descriptor.ports),
        descriptor.snapshotPolicy.dataSnapshot, descriptor.snapshotPolicy.computeSnapshot, `coverage-g00/${runId}`]
    );
  }
}
function port(value: CapabilityDescriptor["ports"]["inputs"][number]): WorldQueryPlanV2SchemaPort {
  return { schemaUri: value.schemaUri, schemaHash: value.schemaHash, valueKind: value.valueKind, unitSemantics: value.unitSemantics };
}
function envelopeValue(envelope: CapabilityResultEnvelope): Row { return row(envelope.output?.value); }
function row(value: unknown): Row { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`object expected: ${JSON.stringify(value)}`); return value as Row; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error(`array expected: ${JSON.stringify(value)}`); return value; }
function check(name: string, condition: boolean, details?: unknown): void { if (!condition) throw new Error(`${name} failed: ${JSON.stringify(details)}`); checks[name] = true; }
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
