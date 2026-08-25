import { Pool } from "pg";

import {
  getContractSchema,
  getContractSchemaHash,
  type CapabilityDescriptor,
  type CapabilityResultEnvelope,
  type GatewayExecuteRequest,
  type WorldQueryPlanV2Node,
  type WorldQueryPlanV2SchemaPort,
  type WorldQueryResult,
  type WorldQuerySubmission
} from "../../packages/platform/contract-runtime/src/index.js";
import { createProviderRuntime, sha256, type ProviderOperation, type ProviderRuntime } from "../../packages/platform/provider-sdk/src/index.js";
import { createDataSnapshot } from "../../packages/platform/result-validation-core/src/index.js";
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
  PostgresRoadCoverageEngine,
  ROAD_COVERAGE_OPERATION_LOCKS
} from "../../services/providers/road-coverage-provider/src/provider.js";
import { createPlatformValidationProvider, PostgresPlatformValidationAuthority } from "../../services/providers/platform-validation-provider/src/index.js";

type Row = Record<string, unknown>;
const providerUrl = required("COVERAGE_PROVIDER_DATABASE_URL");
const gatewayUrl = required("COVERAGE_GATEWAY_DATABASE_URL");
const adminUrl = required("COVERAGE_ADMIN_DATABASE_URL");
const validationUrl = required("PLATFORM_VALIDATION_DATABASE_URL");
const runId = required("GOWM_V06_RUN_ID");
const DATA_SCOPE = "coverage-gateway-runtime";
const DATASET_SCOPE = "tenant-a";
const requestSchemaUri = "urn:gowm:v0.6:road-coverage-request";
const requestSchemaHash = ROAD_COVERAGE_OPERATION_LOCKS[0].inputSchemaHash;
const checks: Record<string, boolean> = {};
const providerPool = new Pool({ connectionString: providerUrl, max: 8 });
const gatewayPool = new Pool({ connectionString: gatewayUrl, max: 8 });
const adminPool = new Pool({ connectionString: adminUrl, max: 2 });
const validationPool = new Pool({ connectionString: validationUrl, max: 4 });
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

const coverage = createRoadCoverageProvider(new PostgresRoadCoverageEngine({
  pool: providerPool,
  resultTtlMs: 2500,
  leaseSeconds: 30,
  workerId: `coverage-${runId}`
}));
const platformValidation = createPlatformValidationProvider(new PostgresPlatformValidationAuthority(validationPool));
const geometry = createGeometryProvider();
const registry = new CapabilityRegistry();
register(registry, geometry, "geometry", 36100);
register(registry, coverage.runtime, "coverage", 36101);
register(registry, platformValidation.runtime, "platform-validation", 36102);
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
  await persistRuntimeRegistry(adminPool, geometry, "http://geometry.coverage-g00.invalid");
  await persistRuntimeRegistry(adminPool, coverage.runtime, "http://coverage.coverage-g00.invalid");
  await persistRuntimeRegistry(adminPool, platformValidation.runtime, "http://platform-validation.coverage-g00.invalid");
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

  const submission = coverageDag();
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
  check("geometryOnDemand", JSON.stringify(resultSet).includes("coordinates") === false);

  const firstAlternative = row(array(resultSet.alternatives)[0]);
  const verify = await execute("coverage.road.verify", {
    schemaVersion: "1.0",
    problemReference: resultSet.referenceKey,
    candidate: firstAlternative,
    routingSnapshot: snapshot,
    revalidateAgainstCurrentCondition: true
  }, `${runId}-verify`);
  check("verifyDirect", envelopeValue(verify).status === "VALID", envelopeValue(verify));

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

  const validationEvidence = await adminPool.query<{ data_snapshot_hash: string }>(
    "SELECT data_snapshot_hash FROM public.world_query_result_reference WHERE reference_key=$1",
    [row(resultSet.referenceKey).id]
  );
  const dataSnapshotHash = validationEvidence.rows[0]?.data_snapshot_hash;
  if (dataSnapshotHash === undefined) throw new Error("coverage result data snapshot hash is unavailable");
  const resultReferenceKey = row(resultSet.referenceKey) as { namespace: "gowm"; kind: string; id: string; version: string };
  const platformSnapshot = createDataSnapshot("PINNED", [{ referenceKey: resultReferenceKey, resourceKind: "QUERY_RESULT", resourceId: resultReferenceKey.id, version: resultReferenceKey.version, contentHash: dataSnapshotHash }]);
  await adminPool.query("SELECT public.register_platform_data_snapshot($1,$2,$3::jsonb)", [DATA_SCOPE, DATASET_SCOPE, JSON.stringify(platformSnapshot)]);
  const resultValidation = envelopeValue(await execute("result.validate", { schemaVersion: "1.0", references: [{ referenceKey: resultReferenceKey, requireCurrentSnapshot: true }] }, `${runId}-result-validation`));
  check("platformResultValidation", row(array(resultValidation.results)[0]).usable === "YES", resultValidation);
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

  await new Promise((resolve) => setTimeout(resolve, 2800));
  const stale = await execute("coverage.road.verify", {
    schemaVersion: "1.0",
    problemReference: resultSet.referenceKey,
    candidate: firstAlternative,
    routingSnapshot: snapshot,
    revalidateAgainstCurrentCondition: true
  }, `${runId}-stale`);
  const staleReport = envelopeValue(stale);
  check("expiredIsStale", staleReport.status === "STALE" && array(staleReport.violations).some((value) => row(value).code === "RESULT_EXPIRED"), staleReport);

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
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    checks,
    queryId: submission.plan.queryId,
    gatewayJobId: claim!.gatewayJobId,
    publicJobId: claim!.job.jobId,
    resultReferenceKey: row(resultSet.referenceKey).id,
    alternativeIds: array(resultSet.alternatives).map((value) => row(value).alternativeId),
    persisted
  })}\n`);
} finally {
  await app.close();
  await Promise.all([providerPool.end(), gatewayPool.end(), adminPool.end(), validationPool.end()]);
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
      deadlineAt: new Date(Date.now() + 120000).toISOString(),
      maximumResultBytes: descriptor.limits.maximumOutputBytes ?? 16777216,
      maximumRows: Math.min(descriptor.limits.maximumRows ?? 100000, 100000),
      maximumCandidates: descriptor.limits.maximumCandidates ?? 1000,
      maximumCostClass: descriptor.execution.costClass,
      preferredExecution
    }
  };
}

function coverageDag(): WorldQuerySubmission {
  const geometryDescriptor = registry.resolve("world.get-geometry", "1.0", true).descriptor;
  const validateDescriptor = registry.resolve("coverage.road.validate", "1.0", true).descriptor;
  const planDescriptor = registry.resolve("coverage.road.plan", "1.0", true).descriptor;
  const requestPort = port(geometryDescriptor.ports.inputs[0]!);
  const resolvedRequestPort = port(geometryDescriptor.ports.outputs[0]!);
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
    node("geometry", geometryDescriptor, { request: { kind: "LITERAL", port: requestPort, value: coverageRequest } }),
    node("validate", validateDescriptor, { request: { kind: "NODE_OUTPUT", nodeId: "geometry", outputPort: "result", port: resolvedRequestPort } }),
    node("plan", planDescriptor, { request: { kind: "NODE_OUTPUT", nodeId: "geometry", outputPort: "result", port: resolvedRequestPort } }, [{
      kind: "VALUE_EQUALS",
      binding: { kind: "NODE_OUTPUT", nodeId: "validate", outputPort: "valid", path: "/valid", port: validPort },
      value: true
    }])
  ];
  return {
    requestId: `gateway-request-${runId}`,
    idempotencyKey: `gateway-idempotency-${runId}`,
    parameterSchemaHash: getContractSchemaHash("world-query-parameters.schema.json"),
    parameters: {},
    plan: {
      queryPlanVersion: "2.0",
      queryId: `coverage-query-${runId}`,
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

function createGeometryProvider(): ProviderRuntime {
  const descriptor: CapabilityDescriptor = {
    operationId: "world.get-geometry",
    operationVersion: "1.0",
    semanticRole: "FOUNDATION_DATA_QUERY",
    dataBinding: "WORLD_SNAPSHOT_BOUND",
    resultSemantics: "DATA_QUERY",
    executionBindings: ["SYNC_HTTP"],
    criticalPathPolicy: "REMOTE_ONLY",
    maturity: "STABLE",
    inputSchemaUri: requestSchemaUri,
    inputSchemaHash: requestSchemaHash,
    outputSchemaUri: requestSchemaUri,
    outputSchemaHash: requestSchemaHash,
    scopePolicy: "DATA_SCOPE_REQUIRED",
    execution: { mode: "SYNC", defaultTimeoutMs: 1000, maximumTimeoutMs: 30000, costClass: "MEDIUM" },
    limits: { maximumInputBytes: 1048576, maximumOutputBytes: 1048576, maximumRows: 1, maximumCandidates: 1 },
    snapshotPolicy: { dataSnapshot: "REQUIRED", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{ name: "request", schemaUri: requestSchemaUri, schemaHash: requestSchemaHash, valueKind: "ANY", unitSemantics: "UNSPECIFIED" }],
      outputs: [{ name: "result", schemaUri: requestSchemaUri, schemaHash: requestSchemaHash, valueKind: "ANY", unitSemantics: "UNSPECIFIED" }]
    }
  };
  const operation: ProviderOperation = {
    descriptor,
    inputSchema: getContractSchema(requestSchemaUri),
    outputSchema: getContractSchema(requestSchemaUri),
    inputSchemaLockHash: requestSchemaHash,
    outputSchemaLockHash: requestSchemaHash,
    method: { engine: "GOWM Grounding Geometry", engineVersion: "1.0", methodId: "world.get-geometry/coverage-fixture", methodVersion: "1.0" },
    async handle(input) {
      const value = row(input);
      const area = row(value.area);
      if (area.type !== "Polygon" && area.type !== "MultiPolygon") throw new Error("geometry is not resolved");
      return {
        status: "COMPLETED",
        value,
        dataSnapshot: {
          consistency: "PINNED",
          capturedAt: new Date().toISOString(),
          scopeDigest: sha256({ dataScope: DATA_SCOPE, datasetScope: DATASET_SCOPE }),
          resources: [{
            referenceKey: { namespace: "gowm", kind: "DATASET", id: "wrf_60000000000000000000000000000001", version: "dataset-v1" },
            authority: "GOWM Grounding Geometry",
            pinning: "PINNED",
            digest: snapshot.graphContentHash
          }]
        },
        consumption: { rows: 1, candidates: 1 }
      };
    }
  };
  return createProviderRuntime({
    manifest: {
      providerProtocolVersion: "1.0",
      provider: { providerId: "gowm.coverage-geometry-fixture", providerVersion: "1.0.0", owner: "gowm-platform", implementationDigest: sha256({ fixture: "coverage-g00-geometry" }), sourceRef: "urn:gowm:source:g00:coverage-geometry" },
      endpoints: { manifest: "/v1/manifest", liveness: "/health/live", readiness: "/health/ready", execute: "/v1/operations/{operationId}:execute", job: "/v1/jobs/{jobId}" },
      capabilities: [descriptor]
    },
    operations: [operation],
    policyVersion: "coverage-g00-geometry/1",
    policyDigest: sha256({ policy: "coverage-g00-geometry/1" })
  });
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
