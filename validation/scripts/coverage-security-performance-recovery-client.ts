import { performance } from "node:perf_hooks";
import { Pool } from "pg";

import {
  getContractSchema,
  getContractSchemaHash,
  type CapabilityDescriptor,
  type CapabilityProviderManifest,
  type CapabilityResultEnvelope,
  type GatewayExecuteRequest,
  type WorldQueryPlanV2Node,
  type WorldQueryPlanV2SchemaPort,
  type WorldQueryResult,
  type WorldQuerySubmission
} from "../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256, type ProviderRuntime } from "../../packages/platform/provider-sdk/src/index.js";
import { PostgresCoverageAsyncRepository } from "../../packages/road-coverage-runtime-core/src/index.js";
import {
  CapabilityRegistry,
  DirectExecutionService,
  InProcessProviderClient,
  MemoryAuditSink,
  MemoryGatewayIdempotencyStore,
  PostgresQueryPlanStore,
  ProviderCircuitBreaker,
  QueryPlanValidator,
  WorldQueryRuntime,
  type GatewayPrincipal,
  type ProviderClient
} from "../../services/gateway/world-capability-gateway/src/index.js";
import { createNetworkProvider } from "../../services/providers/network-provider/src/provider.js";
import type { NetworkSqlClient, NetworkSqlPool, Row as NetworkRow } from "../../services/providers/network-provider/src/types.js";
import { createRoutePlanningProvider } from "../../services/providers/route-planning-provider/src/provider.js";
import {
  createRoadCoverageProvider,
  PostgresRoadCoverageEngine,
  ROAD_COVERAGE_RESOURCE_LIMITS,
  type CoverageRuntimeStageMeasurement
} from "../../services/providers/road-coverage-provider/src/provider.js";

type Row = Record<string, unknown>;
type Profile = "small" | "medium";
const runId = required("GOWM_V06_RUN_ID");
const phase = required("GOWM_V06_T00_PHASE");
if (phase !== "before" && phase !== "after") throw new Error("GOWM_V06_T00_PHASE must be before or after");
const providerPool = new Pool({ connectionString: required("COVERAGE_PROVIDER_DATABASE_URL"), max: 12 });
const gatewayPool = new Pool({ connectionString: required("COVERAGE_GATEWAY_DATABASE_URL"), max: 12 });
const adminPool = new Pool({ connectionString: required("COVERAGE_ADMIN_DATABASE_URL"), max: 4 });
const networkPool = new Pool({ connectionString: required("NETWORK_PROVIDER_DATABASE_URL"), max: 8 });
const routePool = new Pool({ connectionString: required("ROUTE_PROVIDER_DATABASE_URL"), max: 8 });
const checks: Record<string, boolean> = {};
const measurements: Array<CoverageRuntimeStageMeasurement & { profile: Profile }> = [];
let currentProfile: Profile = "small";

const smallSnapshot = {
  networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}`
};
const mediumSnapshot = {
  networkDatasetVersion: "dataset-medium-v1", graphVersion: "graph-medium-v1", travelProfileVersion: "travel-medium-v1", costProfileVersion: "cost-medium-v1",
  graphContentHash: `sha256:${"a".repeat(64)}`, costContentHash: `sha256:${"c".repeat(64)}`
};
const smallRequest = coverageRequest("small", smallSnapshot);
const mediumRequest = coverageRequest("medium", mediumSnapshot);
const smallPrincipal = principal("coverage-gateway-runtime", "tenant-a", "small");
const mediumPrincipal = principal("coverage-t00-performance", "medium", "medium");
const foreignPrincipal = principal("coverage-foreign-scope", "foreign-dataset", "foreign");

const engine = new PostgresRoadCoverageEngine({
  pool: providerPool, resultTtlMs: 300_000, leaseSeconds: 30, workerId: `coverage-t00-${runId}`,
  observeStage: (measurement) => measurements.push({ ...measurement, profile: currentProfile })
});
const coverage = createRoadCoverageProvider(engine);
const registry = new CapabilityRegistry();
register(registry, coverage.runtime, "coverage", 36201);
const audit = new MemoryAuditSink();
const direct = new DirectExecutionService({
  registry, circuits: new ProviderCircuitBreaker(), idempotency: new MemoryGatewayIdempotencyStore(), audit,
  gatewayId: "coverage-t00-gateway", policyVersion: "coverage-t00/1", attestationIssuer: "coverage-t00-gateway"
});
const store = new PostgresQueryPlanStore(gatewayPool);
const worldQueries = new WorldQueryRuntime({ validator: new QueryPlanValidator(registry), directExecution: direct, store, autoRunAsync: false });

try {
  if (phase === "before") await beforeRestart(); else await afterRestart();
} finally {
  await Promise.all([providerPool.end(), gatewayPool.end(), adminPool.end(), networkPool.end(), routePool.end()]);
}

async function beforeRestart(): Promise<void> {
  await persistRuntimeRegistry(adminPool, coverage.runtime, "http://coverage.t00.invalid");

  currentProfile = "small";
  const smallHeapBefore = process.memoryUsage().heapUsed;
  const smallStarted = performance.now();
  const smallSelection = envelopeValue((await directCall(direct, registry, "coverage.road.select-obligations", smallRequest, smallPrincipal, `${runId}-small-select`)).result);
  check("smallSelection", smallSelection.obligationCount === 1, smallSelection);
  const smallPlan = await planViaGateway("small", smallRequest, smallPrincipal);
  const smallResult = row(smallPlan.result.outputs.plan);
  check("smallPlan", smallResult.status === "SUCCEEDED" && array(smallResult.alternatives).length === 1, smallResult);
  const smallAlternative = row(array(smallResult.alternatives)[0]);
  const smallExpanded = envelopeValue((await directCall(direct, registry, "coverage.road.expand-geojson", {
    schemaVersion: "1.0", resultSetReferenceKey: smallResult.referenceKey,
    alternativeId: smallAlternative.alternativeId, include: ["SEGMENTS"]
  }, smallPrincipal, `${runId}-small-expand`)).result);
  check("smallExpand", array(smallExpanded.features).length > 0, smallExpanded);
  const smallElapsedMs = performance.now() - smallStarted;
  const smallHeapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - smallHeapBefore);

  currentProfile = "medium";
  const mediumHeapBefore = process.memoryUsage().heapUsed;
  const mediumStarted = performance.now();
  const mediumSelection = envelopeValue((await directCall(direct, registry, "coverage.road.select-obligations", mediumRequest, mediumPrincipal, `${runId}-medium-select`)).result);
  check("mediumSelection", mediumSelection.obligationCount === 20, mediumSelection);
  const mediumPlan = await planViaGateway("medium", mediumRequest, mediumPrincipal);
  const mediumResult = row(mediumPlan.result.outputs.plan);
  const mediumAlternative = row(array(mediumResult.alternatives)[0]);
  check("mediumPlan", mediumResult.status === "SUCCEEDED" && array(row(mediumAlternative.route).segments).length <= ROAD_COVERAGE_RESOURCE_LIMITS.maximumRouteSegments, mediumResult);
  const mediumExpanded = envelopeValue((await directCall(direct, registry, "coverage.road.expand-geojson", {
    schemaVersion: "1.0", resultSetReferenceKey: mediumResult.referenceKey,
    alternativeId: mediumAlternative.alternativeId, include: ["SEGMENTS"]
  }, mediumPrincipal, `${runId}-medium-expand`)).result);
  check("mediumExpand", array(mediumExpanded.features).length === array(row(mediumAlternative.route).segments).length, mediumExpanded);
  const mediumElapsedMs = performance.now() - mediumStarted;
  const mediumHeapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - mediumHeapBefore);
  check("mediumMemoryBound", mediumHeapDeltaBytes < 128 * 1024 * 1024, { mediumHeapDeltaBytes });

  await expectError("foreignResultDenied", ["VERSION_NOT_FOUND", "INTERNAL_PROVIDER_ERROR"], async () => {
    await directCall(direct, registry, "coverage.road.expand-geojson", {
      schemaVersion: "1.0", resultSetReferenceKey: smallResult.referenceKey,
      alternativeId: smallAlternative.alternativeId, include: ["SEGMENTS"]
    }, foreignPrincipal, `${runId}-foreign-expand`);
  }, String(row(smallResult.referenceKey).id));

  await expectError("cursorTamperDenied", ["SCHEMA_MISMATCH"], async () => {
    await directCall(direct, registry, "coverage.road.expand-geojson", {
      schemaVersion: "1.0", resultSetReferenceKey: smallResult.referenceKey,
      alternativeId: smallAlternative.alternativeId, include: ["SEGMENTS"], cursor: "tampered-cursor"
    }, smallPrincipal, `${runId}-cursor-tamper`);
  });

  await expectError("sqlInjectionDenied", ["INTERNAL_PROVIDER_ERROR", "INVALID_REQUEST"], async () => {
    await directCall(direct, registry, "coverage.road.expand-geojson", {
      schemaVersion: "1.0", resultSetReferenceKey: smallResult.referenceKey,
      alternativeId: "x'; DROP TABLE coverage_planner.coverage_result_set; --", include: ["SEGMENTS"]
    }, smallPrincipal, `${runId}-sql-injection`);
  });
  const relation = await adminPool.query<{ relation: string | null }>("SELECT to_regclass('coverage_planner.coverage_result_set')::text AS relation");
  check("sqlParameterized", relation.rows[0]?.relation === "coverage_planner.coverage_result_set", relation.rows[0]);

  await expectError("urlInjectionDenied", ["SCHEMA_MISMATCH"], async () => {
    await directCall(direct, registry, "coverage.road.validate", { ...smallRequest, providerUrl: "https://attacker.invalid", databaseUrl: "postgresql://attacker.invalid/db" }, smallPrincipal, `${runId}-url-injection`);
  });

  const oversized = structuredClone(smallRequest);
  oversized.area = { type: "Polygon", coordinates: [Array.from({ length: ROAD_COVERAGE_RESOURCE_LIMITS.maximumAreaVertices + 2 }, () => [0, 0])] };
  await expectError("areaVertexLimit", ["BUDGET_EXCEEDED"], async () => {
    await directCall(direct, registry, "coverage.road.validate", oversized, smallPrincipal, `${runId}-oversized-area`);
  });

  const overCandidates = structuredClone(smallRequest);
  row(overCandidates.alternativePolicy).maximumGenerationCandidates = ROAD_COVERAGE_RESOURCE_LIMITS.maximumGenerationCandidates + 1;
  await expectError("candidateLimit", ["SCHEMA_MISMATCH", "BUDGET_EXCEEDED"], async () => {
    await directCall(direct, registry, "coverage.road.validate", overCandidates, smallPrincipal, `${runId}-candidate-limit`);
  });

  await expectError("outputLimit", ["BUDGET_EXCEEDED"], async () => {
    await directCall(direct, registry, "coverage.road.validate", smallRequest, smallPrincipal, `${runId}-output-limit`, 64);
  });

  const selectionSchema = getContractSchema("urn:gowm:v0.6:road-selection-policy") as Row;
  check("obligationLimitContract", row(row(selectionSchema.properties).manualObligations).maxItems === ROAD_COVERAGE_RESOURCE_LIMITS.maximumObligations);
  check("matrixLimit", ROAD_COVERAGE_RESOURCE_LIMITS.maximumMatrixCells === 100_000);

  const foreignFailure = await failedNodeQuery();
  check("nodeErrorIdentity", foreignFailure.providerId === "gowm.road-coverage-planning" &&
    row(row(foreignFailure.error).error).nodeId === foreignFailure.nodeId &&
    row(row(foreignFailure.error).error).providerId === foreignFailure.providerId &&
    typeof row(row(foreignFailure.error).error).code === "string", foreignFailure);

  await providerOutageIsolation();
  const duplicate = await concurrentDuplicate();
  await chaosCancellation();

  const auditText = JSON.stringify(audit.events());
  const secret = "t00-sensitive-token-geometry-metadata";
  await directCall(direct, registry, "coverage.road.validate", { ...smallRequest, metadata: { token: secret } }, smallPrincipal, `${runId}-redaction`);
  check("logRedaction", !JSON.stringify(audit.events()).includes(secret) && !auditText.includes(JSON.stringify(smallRequest.area)) &&
    audit.events().every((event) => typeof event.inputHash === "string" && !("input" in event)), audit.events());

  const stageSummary = summarizeStages(measurements);
  for (const profile of ["small", "medium"] as const) {
    for (const stage of ["OBLIGATION_SELECTION", "ENDPOINT_RESOLUTION", "CONNECTOR_MATRIX_SEARCH", "SOLVER_TOTAL", "INDEPENDENT_VERIFIER", "RESULT_PERSIST", "GEOJSON_EXPAND"] as const) {
      check(`${profile}-${stage}`, stageSamples(stageSummary, profile, stage) > 0, stageSummary[profile]);
    }
  }

  await adminPool.query("CREATE TABLE coverage_t00_restart_probe(run_id text PRIMARY KEY, query_id text NOT NULL, result_hash text NOT NULL, result_reference_key text NOT NULL, gateway_job_id uuid NOT NULL)");
  await adminPool.query("INSERT INTO coverage_t00_restart_probe VALUES ($1,$2,$3,$4,$5::uuid)", [
    runId, smallPlan.submission.plan.queryId, sha256(smallPlan.result), row(smallResult.referenceKey).id, smallPlan.gatewayJobId
  ]);

  process.stdout.write(`${JSON.stringify({
    status: "PASS", phase, checks, profiles: {
      small: { obligationCount: smallSelection.obligationCount, elapsedMs: round(smallElapsedMs), heapDeltaBytes: smallHeapDeltaBytes },
      medium: { obligationCount: mediumSelection.obligationCount, elapsedMs: round(mediumElapsedMs), heapDeltaBytes: mediumHeapDeltaBytes, segmentCount: array(row(mediumAlternative.route).segments).length }
    }, stages: stageSummary, duplicate, restartProbe: { queryId: smallPlan.submission.plan.queryId, resultHash: sha256(smallPlan.result), resultReferenceKey: row(smallResult.referenceKey).id }
  })}\n`);
}

async function afterRestart(): Promise<void> {
  const probeResult = await adminPool.query<{ query_id: string; result_hash: string; result_reference_key: string; gateway_job_id: string }>(
    "SELECT query_id,result_hash,result_reference_key,gateway_job_id::text FROM coverage_t00_restart_probe WHERE run_id=$1", [runId]
  );
  const probe = probeResult.rows[0];
  if (!probe) throw new Error("restart probe is unavailable");
  const submission = planSubmission("small", smallRequest);
  check("deterministicQuery", submission.plan.queryId === probe.query_id, { submission: submission.plan.queryId, probe: probe.query_id });
  const replay = await worldQueries.submit(submission, smallPrincipal, "ASYNC");
  check("gatewayWorkerReplay", replay.replayed === true && replay.result !== undefined && sha256(replay.result) === probe.result_hash, replay);
  const artifact = await new PostgresCoverageAsyncRepository(providerPool).getArtifact(probe.result_reference_key, smallPrincipal.dataScopeClaim!, smallPrincipal.datasetScopeClaim!);
  check("resultReadAfterRestart", artifact !== null && row(artifact).expired === false, artifact);
  const rows = await adminPool.query(`SELECT
    (SELECT count(*)::integer FROM gowm_capability.gateway_job WHERE job_id=$1::uuid AND state='SUCCEEDED') AS jobs,
    (SELECT count(*)::integer FROM coverage_planner.coverage_request WHERE gateway_job_id=$1::uuid) AS requests,
    (SELECT count(*)::integer FROM coverage_planner.coverage_result_set result JOIN coverage_planner.coverage_request request USING(coverage_request_id,data_scope_key,dataset_scope_key) WHERE request.gateway_job_id=$1::uuid) AS results`, [probe.gateway_job_id]);
  const persisted = row(rows.rows[0]);
  check("postgresRestartPersistence", persisted.jobs === 1 && persisted.requests === 1 && persisted.results === 1, persisted);
  process.stdout.write(`${JSON.stringify({ status: "PASS", phase, checks, probe, persisted })}\n`);
}

async function planViaGateway(label: string, request: Row, owner: GatewayPrincipal) {
  const submission = planSubmission(label, request);
  const queued = await worldQueries.submit(submission, owner, "ASYNC");
  check(`${label}Queued`, queued.job.status === "QUEUED", queued);
  const claim = await store.claimNext(`t00-${label}-${runId}`, 60);
  if (!claim?.gatewayJobId) throw new Error(`${label} Gateway job was not claimed`);
  const result = await worldQueries.run(claim.job.jobId);
  check(`${label}Completed`, result.status === "COMPLETED", result);
  return { submission, result, gatewayJobId: claim.gatewayJobId, publicJobId: claim.job.jobId };
}

async function failedNodeQuery() {
  const descriptor = registry.resolve("coverage.road.validate", "1.0", true).descriptor;
  const submission = singleNodeSubmission(`foreign-error-${runId}`, "validate", descriptor, smallRequest);
  await worldQueries.submit(submission, foreignPrincipal, "ASYNC");
  const claim = await store.claimNext(`t00-error-${runId}`, 60);
  if (!claim) throw new Error("foreign failure query was not claimed");
  const result = await worldQueries.run(claim.job.jobId);
  check("foreignRequestDenied", result.status === "FAILED", result);
  return row(result.nodes.find((node) => node.nodeId === "validate"));
}

async function concurrentDuplicate() {
  const request = {
    ...smallRequest,
    requestId: `${runId}-duplicate-request`,
    objective: { profile: "FASTEST_COMPLETION" },
    alternativePolicy: {
      ...row(smallRequest.alternativePolicy),
      profiles: ["FASTEST_COMPLETION"]
    }
  };
  const submission = planSubmission("duplicate", request);
  const [left, right] = await Promise.all([
    worldQueries.submit(structuredClone(submission), smallPrincipal, "ASYNC"),
    worldQueries.submit(structuredClone(submission), smallPrincipal, "ASYNC")
  ]);
  check("concurrentDuplicateJob", left.job.jobId === right.job.jobId, { left: left.job, right: right.job });
  const claim = await store.claimNext(`t00-duplicate-${runId}`, 60);
  if (!claim) throw new Error("duplicate query was not claimed");
  const result = await worldQueries.run(claim.job.jobId);
  check("concurrentDuplicateResult", result.status === "COMPLETED", result);
  const counts = row((await adminPool.query(`SELECT
    (SELECT count(*)::integer FROM gowm_capability.world_query_job WHERE query_id=$1) AS jobs,
    (SELECT count(*)::integer FROM coverage_planner.coverage_request WHERE external_request_id=$2) AS requests,
    (SELECT count(*)::integer FROM coverage_planner.coverage_result_set result JOIN coverage_planner.coverage_request request USING(coverage_request_id,data_scope_key,dataset_scope_key) WHERE request.external_request_id=$2) AS results`,
  [submission.plan.queryId, request.requestId])).rows[0]);
  check("concurrentDuplicateSingleton", counts.jobs === 1 && counts.requests === 1 && counts.results === 1, counts);
  return counts;
}

async function chaosCancellation(): Promise<void> {
  const repository = new PostgresCoverageAsyncRepository(providerPool);
  for (const [index, stage] of ["SOLVING", "VERIFYING", "PUBLISHING"].entries()) {
    const externalRequestId = `${runId}-chaos-${stage.toLowerCase()}`;
    const gatewaySubmission = planSubmission(`chaos-${stage.toLowerCase()}`, {
      ...smallRequest,
      requestId: externalRequestId
    });
    await worldQueries.submit(gatewaySubmission, smallPrincipal, "ASYNC");
    const gatewayClaim = await store.claimNext(`t00-chaos-gateway-${stage.toLowerCase()}-${runId}`, 60);
    if (!gatewayClaim?.gatewayJobId) throw new Error(`${stage} Gateway job was not claimed`);
    const submission = await repository.submit({
      dataScopeKey: smallPrincipal.dataScopeClaim!, datasetScopeKey: smallPrincipal.datasetScopeClaim!,
      externalRequestId, idempotencyKey: externalRequestId, gatewayJobId: gatewayClaim.gatewayJobId,
      requestHash: sha256({ externalRequestId }), routingSnapshotHash: sha256(smallSnapshot), routingSnapshot: smallSnapshot, request: smallRequest
    });
    const owner = `chaos-${stage.toLowerCase()}-${runId}`;
    const claim = await repository.claim(submission.coverageRequestId, owner, 30);
    if (!claim) throw new Error(`${stage} chaos request was not claimed`);
    check(`${stage}Heartbeat`, await repository.heartbeat(claim, owner, 30, stage, 500_000 + index, { bounded: true }));
    check(`${stage}Cancelled`, await repository.cancel(submission.coverageRequestId, `T00_${stage}_CANCEL`));
    check(`${stage}LateHeartbeatFenced`, !(await repository.heartbeat(claim, owner, 30, stage, 600_000 + index, {})));
    if (stage === "SOLVING") {
      await expectReject(`${stage}LatePersistFenced`, repository.persistProblem(claim, owner, sha256({ stage }), { stage }));
    } else if (stage === "VERIFYING") {
      await expectReject(`${stage}LatePersistFenced`, repository.persistCandidate(claim, owner, {
        problemHash: sha256({ stage }), objectiveProfile: "SHORTEST_TOTAL_DISTANCE", candidateHash: sha256({ stage, candidate: true }),
        route: { segments: [] }, solverDiagnostics: {}, verification: {}
      }));
    } else {
      await expectReject(`${stage}LatePersistFenced`, repository.publishResult(claim, owner, {
        referenceKey: `wrf_${sha256({ stage }).slice(7,39)}`, status: "SUCCEEDED", resultHash: sha256({ stage, result: true }),
        validUntil: new Date(Date.now() + 60_000).toISOString(), result: { status: "SUCCEEDED", revalidationRequired: true }
      }));
    }
    await worldQueries.cancel(gatewaySubmission.plan.queryId, smallPrincipal);
  }
  const cancelled = Number((await adminPool.query("SELECT count(*) FROM coverage_planner.coverage_request WHERE external_request_id LIKE $1 AND status='CANCELLED'", [`${runId}-chaos-%`])).rows[0]?.count ?? 0);
  const ghosts = Number((await adminPool.query("SELECT count(*) FROM coverage_planner.coverage_result_set result JOIN coverage_planner.coverage_request request USING(coverage_request_id,data_scope_key,dataset_scope_key) WHERE request.external_request_id LIKE $1", [`${runId}-chaos-%`])).rows[0]?.count ?? 0);
  check("chaosCancellation", cancelled === 3 && ghosts === 0, { cancelled, ghosts });
}

async function providerOutageIsolation(): Promise<void> {
  const network = createNetworkProvider({ pool: sqlPool(networkPool) });
  const route = createRoutePlanningProvider({ pool: sqlPool(routePool), resultTtlMs: 300_000 });
  const isolatedRegistry = new CapabilityRegistry();
  register(isolatedRegistry, network.runtime, "network", 36211);
  register(isolatedRegistry, route.runtime, "route", 36212);
  isolatedRegistry.register({
    approvalId: "coverage-t00-outage", approved: true, endpoint: new URL("http://127.0.0.1:36213/"),
    client: unavailableClient(coverage.runtime.manifest), manifest: coverage.runtime.manifest
  });
  const isolated = new DirectExecutionService({
    registry: isolatedRegistry, circuits: new ProviderCircuitBreaker(1),
    idempotency: new MemoryGatewayIdempotencyStore(), audit: new MemoryAuditSink(), gatewayId: "coverage-t00-isolation",
    policyVersion: "coverage-t00/isolation", attestationIssuer: "coverage-t00-isolation"
  });
  await expectError("coverageOutage", ["PROVIDER_NOT_READY"], async () => {
    await directCall(isolated, isolatedRegistry, "coverage.road.validate", smallRequest, smallPrincipal, `${runId}-outage`);
  });
  const snap = envelopeValue((await directCall(isolated, isolatedRegistry, "network.snap.point", {
    routingSnapshot: smallSnapshot, location: { coordinates: [0, 0], crs: "EPSG:4326" }, maxDistanceM: 10_000, limit: 8
  }, smallPrincipal, `${runId}-network-after-outage`)).result);
  check("networkUnaffected", ["UNIQUE", "AMBIGUOUS"].includes(String(snap.status)), snap);
  const routeValidation = envelopeValue((await directCall(isolated, isolatedRegistry, "route.validate", {
    requestId: `${runId}-route-after-outage`, routingSnapshot: smallSnapshot,
    start: { arcKey: `arc_${"1".repeat(64)}`, fractionPpm: 0, direction: "FORWARD" },
    destination: { arcKey: `arc_${"5".repeat(64)}`, fractionPpm: 1_000_000, direction: "FORWARD" },
    travelProfile: "travel-v1", costProfile: "cost-v1", objective: "SHORTEST_DISTANCE", deadlineMs: 30_000
  }, smallPrincipal, `${runId}-route-after-outage`)).result);
  check("routeUnaffected", routeValidation.status === "VALID", routeValidation);
}

function planSubmission(label: string, request: Row): WorldQuerySubmission {
  const descriptor = registry.resolve("coverage.road.plan", "1.0", true).descriptor;
  return singleNodeSubmission(`plan-${label}-${runId}`, "plan", descriptor, request);
}

function singleNodeSubmission(queryLabel: string, nodeId: string, descriptor: CapabilityDescriptor, input: Row): WorldQuerySubmission {
  const node: WorldQueryPlanV2Node = {
    nodeId,
    operation: { operationId: descriptor.operationId, operationVersion: descriptor.operationVersion, inputSchemaHash: descriptor.inputSchemaHash, outputSchemaHash: descriptor.outputSchemaHash },
    inputs: { request: { kind: "LITERAL", port: port(descriptor.ports.inputs[0]!), value: input } },
    failurePolicy: "FAIL_FAST",
    budget: {
      maximumRows: Math.min(descriptor.limits.maximumRows ?? 100_000, 100_000),
      maximumCandidates: Math.min(descriptor.limits.maximumCandidates ?? 100_000, 100_000),
      maximumOutputBytes: descriptor.limits.maximumOutputBytes ?? 16_777_216,
      maximumExecutionMs: Math.min(120_000, descriptor.execution.maximumTimeoutMs)
    }
  };
  return {
    requestId: `request-${queryLabel}`, idempotencyKey: `idempotency-${queryLabel}`,
    parameterSchemaHash: getContractSchemaHash("world-query-parameters.schema.json"), parameters: {},
    plan: {
      queryPlanVersion: "2.0", queryId: `query-${queryLabel}`, nodes: [node],
      outputs: [{ name: "plan", binding: { kind: "NODE_OUTPUT", nodeId, outputPort: "result", port: port(descriptor.ports.outputs[0]!) } }],
      budgets: { maximumNodes: 1, maximumDepth: 1, maximumRows: node.budget.maximumRows, maximumCandidates: node.budget.maximumCandidates, maximumOutputBytes: node.budget.maximumOutputBytes, maximumExecutionMs: node.budget.maximumExecutionMs }
    }
  };
}

function coverageRequest(profile: Profile, snapshot: Row): Row {
  const medium = profile === "medium";
  return {
    schemaVersion: "1.0", requestId: `${runId}-${profile}-coverage`, routingSnapshot: snapshot,
    area: medium
      ? { type: "Polygon", coordinates: [[[-0.001,0.009],[0.003,0.009],[0.003,0.011],[-0.001,0.011],[-0.001,0.009]]] }
      : { type: "Polygon", coordinates: [[[0.0029,-0.0001],[0.0041,-0.0001],[0.0041,0.0001],[0.0029,0.0001],[0.0029,-0.0001]]] },
    routeCount: 1,
    selectionPolicy: { mode: "FULLY_COVERED_EDGE", roadClasses: ["LOCAL"], minimumSegmentLengthMm: 1, serviceMode: "FIXED_DIRECTION", fixedDirectionSource: "SOURCE_FEATURE_ATTRIBUTE", requiredPasses: 1, selectionPolicyVersion: "coverage-selection/1.0" },
    endpointPolicy: {
      start: { arcKey: medium ? `arc_${"0".repeat(63)}1` : `arc_${"1".repeat(64)}`, fractionPpm: medium ? 0 : 1_000_000, direction: "FORWARD" },
      entry: { mode: "AUTO", maximumCandidates: 8 }, exit: { mode: "AUTO", maximumCandidates: 8 },
      endpointMode: "RETURN_TO_START", boundaryCrossingPolicy: "FREE", snapToleranceMm: 1000
    },
    objective: { profile: "SHORTEST_TOTAL_DISTANCE" },
    alternativePolicy: { requestedCount: 1, minimumVerifiedCount: 1, profiles: ["SHORTEST_TOTAL_DISTANCE"], maximumWeightedArcOverlapPpm: 1_000_000, minimumDeadheadJaccardDistancePpm: 0, maximumGenerationCandidates: 64 },
    timeLimitMs: 60_000
  };
}

async function directCall(service: DirectExecutionService, target: CapabilityRegistry, operationId: string, input: Row, owner: GatewayPrincipal, key: string, maximumResultBytes?: number) {
  const descriptor = target.resolve(operationId, "1.0", true).descriptor;
  return await service.execute(operationId, gatewayRequest(descriptor, input, key, maximumResultBytes), owner);
}

function gatewayRequest(descriptor: CapabilityDescriptor, input: Row, key: string, maximumResultBytes?: number): GatewayExecuteRequest {
  const timeoutMs = Math.max(1_000, Math.min(120_000, descriptor.execution.maximumTimeoutMs) - 100);
  return {
    requestVersion: "1.0", requestId: `gateway_${key.replaceAll("-", "_")}`, idempotencyKey: key,
    operationVersion: "1.0", inputSchemaHash: descriptor.inputSchemaHash, outputSchemaHash: descriptor.outputSchemaHash, input,
    executionPolicy: {
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
      maximumResultBytes: maximumResultBytes ?? descriptor.limits.maximumOutputBytes ?? 16_777_216,
      maximumRows: Math.min(descriptor.limits.maximumRows ?? 100_000, 100_000),
      maximumCandidates: Math.min(descriptor.limits.maximumCandidates ?? 100_000, 100_000),
      maximumCostClass: descriptor.execution.costClass, preferredExecution: "SYNC"
    }
  };
}

async function expectError(name: string, codes: string[], action: () => Promise<unknown>, forbidden?: string): Promise<void> {
  try { await action(); } catch (error) {
    const code = error instanceof ProviderProtocolError ? error.code : "INTERNAL_PROVIDER_ERROR";
    check(name, codes.includes(code) && (forbidden === undefined || !String(error).includes(forbidden)), { code, message: String(error) });
    return;
  }
  throw new Error(`${name} unexpectedly succeeded`);
}

async function expectReject(name: string, promise: Promise<unknown>): Promise<void> {
  try { await promise; } catch { checks[name] = true; return; }
  throw new Error(`${name} unexpectedly succeeded`);
}

function unavailableClient(manifest: CapabilityProviderManifest): ProviderClient {
  return {
    providerId: manifest.provider.providerId,
    async manifest() { return structuredClone(manifest); },
    async health() { return { live: false, ready: false, checkedAt: new Date().toISOString(), detail: "coverage outage fixture" }; },
    async execute() { throw new ProviderProtocolError("PROVIDER_NOT_READY", "coverage outage fixture"); }
  };
}

function register(target: CapabilityRegistry, runtime: ProviderRuntime, label: string, portNumber: number): void {
  target.register({ approvalId: `coverage-t00-${label}`, approved: true, endpoint: new URL(`http://127.0.0.1:${portNumber}/`), client: new InProcessProviderClient(runtime), manifest: runtime.manifest });
}

async function persistRuntimeRegistry(pool: Pool, runtime: ProviderRuntime, endpoint: string): Promise<void> {
  const manifest = runtime.manifest;
  await pool.query(`INSERT INTO gowm_capability.provider_registry(
    provider_id,provider_version,display_name,owner_name,endpoint,manifest_uri,endpoint_bindings,
    manifest_hash,implementation_digest,source_ref,approval_state,approved_by,approved_at,enabled
  ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,'APPROVED','coverage-t00',clock_timestamp(),true)`,
  [manifest.provider.providerId,manifest.provider.providerVersion,manifest.provider.providerId,manifest.provider.owner,endpoint,`${endpoint}/v1/manifest`,JSON.stringify(manifest.endpoints),sha256(manifest),manifest.provider.implementationDigest,manifest.provider.sourceRef ?? null]);
  for (const descriptor of manifest.capabilities) {
    await pool.query(`INSERT INTO gowm_capability.capability(operation_id,semantic_role,data_binding,result_semantics,description)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (operation_id) DO NOTHING`,
    [descriptor.operationId,descriptor.semanticRole,descriptor.dataBinding,descriptor.resultSemantics,`${descriptor.operationId} T00 runtime operation`]);
    await pool.query(`INSERT INTO gowm_capability.provider_operation(
      operation_id,operation_version,provider_id,input_schema_uri,input_schema_hash,output_schema_uri,output_schema_hash,
      maturity,scope_policy,execution_mode,execution_bindings,critical_path_policy,default_timeout_ms,maximum_timeout_ms,
      cost_class,limits,ports,data_snapshot_policy,compute_snapshot_policy,policy_version,enabled
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,$20,true)`,
    [descriptor.operationId,descriptor.operationVersion,manifest.provider.providerId,descriptor.inputSchemaUri,descriptor.inputSchemaHash,descriptor.outputSchemaUri,descriptor.outputSchemaHash,descriptor.maturity,descriptor.scopePolicy,descriptor.execution.mode,descriptor.executionBindings,descriptor.criticalPathPolicy,descriptor.execution.defaultTimeoutMs,descriptor.execution.maximumTimeoutMs,descriptor.execution.costClass,JSON.stringify(descriptor.limits),JSON.stringify(descriptor.ports),descriptor.snapshotPolicy.dataSnapshot,descriptor.snapshotPolicy.computeSnapshot,`coverage-t00/${runId}`]);
  }
}

function sqlPool(pool: Pool): NetworkSqlPool {
  return { async connect(): Promise<NetworkSqlClient> {
    const client = await pool.connect();
    return { async query<T extends NetworkRow = NetworkRow>(text: string, values?: readonly unknown[]) {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    }, release: () => client.release() };
  } };
}

function summarizeStages(values: Array<CoverageRuntimeStageMeasurement & { profile: Profile }>): Row {
  const output: Record<string, Record<string, { samples: number; elapsedMs: number; units: number }>> = {};
  for (const value of values) {
    const stages = output[value.profile] ??= {};
    const total = stages[value.stage] ??= { samples: 0, elapsedMs: 0, units: 0 };
    total.samples += 1; total.elapsedMs = round(total.elapsedMs + value.elapsedMs); total.units += value.units;
  }
  return output;
}

function stageSamples(summary: Row, profile: Profile, stage: string): number {
  const profiles = row(summary[profile]);
  const measurement = row(profiles[stage]);
  return typeof measurement.samples === "number" ? measurement.samples : 0;
}

function principal(dataScopeClaim: string, datasetScopeClaim: string, label: string): GatewayPrincipal {
  return { principalRef: `principal:coverage-t00:${label}`, authenticationMethod: "RUNTIME_ACCEPTANCE", authenticatedAt: new Date(Date.now() - 1000).toISOString(), dataScopeClaim, datasetScopeClaim };
}
function port(value: CapabilityDescriptor["ports"]["inputs"][number]): WorldQueryPlanV2SchemaPort { return { schemaUri: value.schemaUri, schemaHash: value.schemaHash, valueKind: value.valueKind, unitSemantics: value.unitSemantics }; }
function envelopeValue(envelope: CapabilityResultEnvelope): Row { return row(envelope.output?.value); }
function row(value: unknown): Row { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`object expected: ${JSON.stringify(value)}`); return value as Row; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error(`array expected: ${JSON.stringify(value)}`); return value; }
function check(name: string, condition: boolean, details?: unknown): void { if (!condition) throw new Error(`${name} failed: ${JSON.stringify(details)}`); checks[name] = true; }
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function round(value: number): number { return Number(value.toFixed(3)); }
