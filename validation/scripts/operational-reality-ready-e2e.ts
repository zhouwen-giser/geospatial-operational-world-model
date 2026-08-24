import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import pg from "pg";

import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  CapabilityResultEnvelope,
  ProviderExecutionRequest,
  ReferenceKey,
  WorldQueryPlanV2InputBinding,
  WorldQueryPlanV2Node,
  WorldQueryPlanV2SchemaPort,
  WorldQuerySubmission
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  getContractSchemaHash
} from "../../packages/platform/contract-runtime/src/index.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { OperationalEventRepository } from "../../packages/runtime/src/operational-event-repository.js";
import { OperationalProjectionRepository } from "../../packages/runtime/src/operational-projection-repository.js";
import {
  buildGatewayApp,
  CapabilityRegistry,
  DirectExecutionService,
  HttpProviderClient,
  loadControlledProviderDeployments,
  MemoryAuditSink,
  PostgresGatewayIdempotencyStore,
  PostgresGatewayRecordStore,
  PostgresQueryPlanStore,
  ProviderCircuitBreaker,
  QueryPlanValidator,
  synchronizePostgresRegistry,
  WorldQueryRuntime,
  type GatewayPrincipal,
  type ProviderClient
} from "../../services/gateway/world-capability-gateway/src/index.js";
import { buildOperationalRealityApp } from "../../services/providers/operational-reality-provider/src/app.js";
import { createOperationalRealityProvider } from "../../services/providers/operational-reality-provider/src/provider.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
const runId = randomUUID().replaceAll("-", "").slice(0, 16);
const scope = `operational-ready-${runId}`;
const taskId = `ready-task-${runId}`;
const eventId = `ready-event-${runId}`;
const eventTime = new Date(Date.now() - 30_000).toISOString();
const receivedTime = new Date().toISOString();
const transportToken = "OperationalRealityReadyTransportToken_2026";
const parameterSchemaHash = getContractSchemaHash("world-query-parameters.schema.json");
let projectedTaskReferenceKey: ReferenceKey | undefined;
const stringPort: WorldQueryPlanV2SchemaPort = {
  schemaUri: "urn:gowm:v0.2:value:string",
  schemaHash: getContractSchemaHash("urn:gowm:v0.2:value:string"),
  valueKind: "SCALAR",
  unitSemantics: "UNSPECIFIED"
};

const principal: GatewayPrincipal = {
  principalRef: `principal:operational-ready:${runId}`,
  authenticationMethod: "TEST_ATTESTED",
  authenticatedAt: new Date().toISOString(),
  dataScopeClaim: scope,
  allowExperimental: true
};

let providerApp: ReturnType<typeof buildOperationalRealityApp> | undefined;
let gatewayApp: ReturnType<typeof buildGatewayApp> | undefined;

try {
  const deployments = await loadControlledProviderDeployments("config/grounding-gateway-registry.json");
  await synchronizePostgresRegistry(pool, deployments.map((config) => ({
    config,
    manifest: config.approvedManifest
  })));
  await seedOperationalReality();
  const provider = createOperationalRealityProvider({ pool });
  const manifest = provider.runtime.manifest;
  providerApp = buildOperationalRealityApp(provider, transportToken);
  await providerApp.listen({ host: "127.0.0.1", port: 0 });
  const providerAddress = providerApp.server.address();
  if (!providerAddress || typeof providerAddress === "string") throw new Error("provider address unavailable");

  const endpoint = new URL(`http://127.0.0.1:${providerAddress.port}/`);
  const httpClient = new HttpProviderClient({
    endpoint,
    providerId: manifest.provider.providerId,
    providerVersion: manifest.provider.providerVersion,
    implementationDigest: manifest.provider.implementationDigest as `sha256:${string}`,
    manifestHash: sha256(manifest),
    approvedManifest: manifest,
    transportToken,
    allowPlaintextPrivateNetwork: false
  });

  const first = gatewayRuntime(manifest, endpoint, httpClient, "initial");
  gatewayApp = first.app;
  await gatewayApp.listen({ host: "127.0.0.1", port: 0 });
  let gatewayBase = listenerBase(gatewayApp);

  const correlationSubmission = correlationTimelineSubmission(manifest);
  const correlationDag = await submitSync(gatewayBase, correlationSubmission);
  assert.equal(correlationDag.status, 200, JSON.stringify(correlationDag.body));
  assert.equal(correlationDag.body.status, "COMPLETED");
  assert.deepEqual(correlationDag.body.nodes.map((node: { status: string }) => node.status), ["COMPLETED", "COMPLETED"]);
  assert.equal(correlationDag.body.outputs.timeline.events[0].eventId, eventId);

  const predicateInput = {
    predicateId: `predicate-${runId}`,
    externalAuthority: "planner-operational-ready",
    subject: taskReferenceKey(),
    operator: "EVENT_OCCURRED",
    object: { eventType: "EXECUTION_STOPPED_OBSERVED" },
    parameters: { expectedSources: ["operational-ready-e2e"] }
  };
  const predicateSubmission = predicateObservabilityStateSubmission(manifest, predicateInput);
  const predicateDag = await submitSync(gatewayBase, predicateSubmission);
  assert.equal(predicateDag.status, 200, JSON.stringify(predicateDag.body));
  assert.equal(predicateDag.body.status, "COMPLETED", JSON.stringify(predicateDag.body));
  assert.deepEqual(predicateDag.body.nodes.map((node: { status: string }) => node.status), ["COMPLETED", "COMPLETED", "COMPLETED"], JSON.stringify(predicateDag.body));
  assert.equal(predicateDag.body.outputs.state.operationalTaskId, taskId);

  const predicateReplay = await submitSync(gatewayBase, predicateSubmission);
  assert.equal(predicateReplay.replayed, true);
  assert.deepEqual(predicateReplay.body, predicateDag.body);

  const restartSubmission = operationalGetSubmission(manifest, `restart-${runId}`);
  const queued = await submitAsync(gatewayBase, restartSubmission);
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal(queued.body.status, "QUEUED");
  const restartJobId = queued.body.jobId as string;

  await gatewayApp.close();
  gatewayApp = undefined;
  const resumed = gatewayRuntime(manifest, endpoint, httpClient, "resumed");
  const claimed = await resumed.store.claimNext(`operational-worker-${runId}`, 60);
  assert.equal(claimed?.job.jobId, restartJobId);
  const resumedResult = await resumed.runtime.run(restartJobId);
  assert.equal(resumedResult.status, "COMPLETED");
  gatewayApp = resumed.app;
  await gatewayApp.listen({ host: "127.0.0.1", port: 0 });
  gatewayBase = listenerBase(gatewayApp);
  const recovered = await fetch(`${gatewayBase}/v1/jobs/${encodeURIComponent(restartJobId)}`);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json() as { status: string }).status, "COMPLETED");

  await gatewayApp.close();
  gatewayApp = undefined;
  const delay = delayedClient(httpClient, "operational-task.get");
  const cancellation = gatewayRuntime(manifest, endpoint, delay.client, "cancellation");
  gatewayApp = cancellation.app;
  await gatewayApp.listen({ host: "127.0.0.1", port: 0 });
  gatewayBase = listenerBase(gatewayApp);
  const cancellationSubmission = operationalGetSubmission(manifest, `cancel-${runId}`);
  const cancellationQueued = await submitAsync(gatewayBase, cancellationSubmission);
  assert.equal(cancellationQueued.status, 202);
  const cancellationRun = cancellation.runtime.run(cancellationQueued.body.jobId as string);
  await delay.arrived;
  const cancelResponse = await fetch(
    `${gatewayBase}/v1/world-queries/${encodeURIComponent(cancellationSubmission.plan.queryId)}:cancel`,
    { method: "POST" }
  );
  assert.equal(cancelResponse.status, 200);
  delay.release();
  const cancelledResult = await cancellationRun;
  assert.equal(cancelledResult.status, "CANCELLED");
  assert.equal(cancelledResult.nodes[0]?.status, "CANCELLED");
  const cancelledJob = await cancellation.store.getByJobId(cancellationQueued.body.jobId as string);
  assert.equal(cancelledJob?.job.status, "CANCELLED");

  process.stdout.write(`${JSON.stringify({
    result: "OPERATIONAL_REALITY_READY",
    providerId: manifest.provider.providerId,
    providerTransport: "HTTP",
    gatewayTransport: "HTTP",
    correlationDag: "correlation.resolve -> operational-task.get-timeline",
    predicateDag: "predicate.evaluate -> observability.evaluate -> operational-task.get",
    exactPredicateReplay: true,
    durableGatewayRestart: true,
    cancellationWinsLateResult: true,
    nodeProviderIdentity: true,
    database: "PostgreSQL"
  }, null, 2)}\n`);
} finally {
  await Promise.allSettled([gatewayApp?.close(), providerApp?.close()]);
  await pool.end();
}

async function seedOperationalReality(): Promise<void> {
  await pool.query(
    "INSERT INTO data_scope(scope_key,operational_domain,description) VALUES ($1,'TEST','Operational Reality Ready E2E')",
    [scope]
  );
  const events = new OperationalEventRepository(pool);
  const projections = new OperationalProjectionRepository(pool);
  await events.insert({
    dataScopeKey: scope,
    sourceAuthority: "operational-ready-e2e",
    sourceEventKey: eventId,
    sourceRevisionNo: 1,
    eventId,
    operationalTaskId: taskId,
    eventType: "EXECUTION_STOPPED_OBSERVED",
    eventTime,
    actorReferenceKeys: [],
    targetReferenceKeys: [],
    payload: { taskType: "OPERATIONAL_READY_E2E" },
    confidence: 1,
    provenance: [{
      evidenceId: `evidence-${runId}`,
      authority: "operational-ready-e2e",
      evidenceType: "OPERATIONAL_EVENT",
      observedAt: eventTime
    }],
    correlationClaims: [correlationHint()]
  }, receivedTime);
  await projections.projectPending(100);
  const snapshot = await projections.get(scope, taskId);
  if (!snapshot) throw new Error("operational ready snapshot missing");
  projectedTaskReferenceKey = snapshot.referenceKey;
  await pool.query(
    `INSERT INTO operational_source_health_revision(
       data_scope_key,source_authority,health_status,valid_from,observed_at,evidence_id
     ) VALUES ($1,'operational-ready-e2e','HEALTHY',clock_timestamp()-interval '1 hour',clock_timestamp(),$2)`,
    [scope, `health-${runId}`]
  );
  await pool.query(
    `INSERT INTO operational_source_watermark_revision(
       data_scope_key,source_authority,closed_through_event_time,allowed_lateness,completeness_state,evidence_id
     ) VALUES ($1,'operational-ready-e2e',clock_timestamp()+interval '1 hour',interval '5 seconds','COMPLETE',$2)`,
    [scope, `watermark-${runId}`]
  );
  await pool.query(
    `INSERT INTO operational_coverage_evidence(
       data_scope_key,subject_reference_key,source_authority,valid_time,coverage_sufficient,evidence_id,policy_version
     ) VALUES ($1,$2,'operational-ready-e2e',tstzrange(clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','[)'),true,$3,'coverage-v1')`,
    [scope, snapshot.referenceKey.id, `coverage-${runId}`]
  );
}

function gatewayRuntime(
  manifest: CapabilityProviderManifest,
  endpoint: URL,
  client: ProviderClient,
  instance: string
) {
  const registry = new CapabilityRegistry();
  registry.register({
    approvalId: `operational-ready-${instance}`,
    approved: true,
    endpoint,
    client,
    manifest
  });
  const store = new PostgresQueryPlanStore(pool);
  const direct = new DirectExecutionService({
    registry,
    circuits: new ProviderCircuitBreaker(),
    idempotency: new PostgresGatewayIdempotencyStore(pool, { leaseOwner: `operational-ready-${instance}-${runId}` }),
    audit: new MemoryAuditSink(),
    gatewayId: `operational-ready-gateway-${instance}`,
    policyVersion: "operational-ready-policy-v1",
    attestationIssuer: `operational-ready-gateway-${instance}`,
    records: new PostgresGatewayRecordStore(pool)
  });
  const runtime = new WorldQueryRuntime({
    validator: new QueryPlanValidator(registry),
    directExecution: direct,
    store,
    autoRunAsync: false
  });
  const app = buildGatewayApp({
    registry,
    directExecution: direct,
    records: new PostgresGatewayRecordStore(pool),
    worldQueries: runtime,
    authenticate: async () => principal,
    logger: process.env.GOWM_E2E_DEBUG === "1"
  });
  return { app, runtime, store };
}

function correlationTimelineSubmission(manifest: CapabilityProviderManifest): WorldQuerySubmission {
  const correlation = descriptor(manifest, "correlation.resolve");
  const timeline = descriptor(manifest, "operational-task.get-timeline");
  const referencePort = outputPort(correlation, "operationalTaskReferenceKey");
  return submission(`correlation-${runId}`, [
    node("resolveCorrelation", correlation, {
      request: literal(inputPort(correlation), {
        schemaVersion: "1.0",
        correlationHints: [correlationHint()]
      })
    }),
    node("loadTimeline", timeline, {
      schemaVersion: { kind: "LITERAL", port: stringPort, value: "1.0", targetPath: "/schemaVersion" },
      referenceKey: {
        kind: "NODE_OUTPUT",
        port: shape(referencePort),
        nodeId: "resolveCorrelation",
        outputPort: referencePort.name,
        path: referencePort.path,
        targetPath: "/referenceKey"
      }
    })
  ], "loadTimeline", timeline, "timeline");
}

function predicateObservabilityStateSubmission(
  manifest: CapabilityProviderManifest,
  predicateInput: unknown
): WorldQuerySubmission {
  const predicate = descriptor(manifest, "predicate.evaluate");
  const observability = descriptor(manifest, "observability.evaluate");
  const get = descriptor(manifest, "operational-task.get");
  const predicateStatus = outputPort(predicate, "status");
  const observabilityStatus = outputPort(observability, "status");
  const query = { schemaVersion: "1.0", referenceKey: taskReferenceKey() };
  const nodes = [
    node("evaluatePredicate", predicate, {
      request: literal(inputPort(predicate), predicateInput)
    }),
    node("evaluateObservability", observability, {
      request: literal(inputPort(observability), query)
    }, [{
      kind: "VALUE_EQUALS",
      value: "SUPPORTED",
      binding: nodeOutput("evaluatePredicate", predicateStatus)
    }]),
    node("loadOperationalState", get, {
      request: literal(inputPort(get), query)
    }, [{
      kind: "VALUE_EQUALS",
      value: "FRESH",
      binding: nodeOutput("evaluateObservability", observabilityStatus)
    }])
  ];
  return submission(`predicate-${runId}`, nodes, "loadOperationalState", get, "state");
}

function operationalGetSubmission(manifest: CapabilityProviderManifest, queryId: string): WorldQuerySubmission {
  const get = descriptor(manifest, "operational-task.get");
  return submission(queryId, [node("loadOperationalState", get, {
    request: literal(inputPort(get), { schemaVersion: "1.0", referenceKey: taskReferenceKey() })
  })], "loadOperationalState", get, "state");
}

function submission(
  queryId: string,
  nodes: WorldQueryPlanV2Node[],
  outputNodeId: string,
  outputDescriptor: CapabilityDescriptor,
  outputName: string
): WorldQuerySubmission {
  const resultPort = outputPort(outputDescriptor, "result");
  return {
    requestId: `request-${queryId}`,
    idempotencyKey: `idempotency-${queryId}`,
    parameterSchemaHash,
    parameters: {},
    plan: {
      queryPlanVersion: "2.0",
      queryId,
      nodes,
      outputs: [{
        name: outputName,
        binding: nodeOutput(outputNodeId, resultPort)
      }],
      budgets: {
        maximumNodes: nodes.length,
        maximumDepth: nodes.length,
        maximumRows: nodes.length * 1_000,
        maximumCandidates: nodes.length * 5_000,
        maximumOutputBytes: nodes.length * 16_777_216,
        maximumExecutionMs: nodes.length * 30_000
      }
    }
  };
}

function node(
  nodeId: string,
  operation: CapabilityDescriptor,
  inputs: Record<string, WorldQueryPlanV2InputBinding>,
  preconditions?: WorldQueryPlanV2Node["preconditions"]
): WorldQueryPlanV2Node {
  return {
    nodeId,
    operation: {
      operationId: operation.operationId,
      operationVersion: operation.operationVersion,
      inputSchemaHash: operation.inputSchemaHash,
      outputSchemaHash: operation.outputSchemaHash
    },
    inputs,
    failurePolicy: preconditions ? "SKIP_IF_PRECONDITION_FALSE" : "FAIL_FAST",
    ...(preconditions === undefined ? {} : { preconditions }),
    budget: {
      maximumRows: 1_000,
      maximumCandidates: 5_000,
      maximumOutputBytes: 16_777_216,
      maximumExecutionMs: 30_000
    }
  };
}

function descriptor(manifest: CapabilityProviderManifest, operationId: string): CapabilityDescriptor {
  const value = manifest.capabilities.find((candidate) => candidate.operationId === operationId);
  if (!value) throw new Error(`${operationId} is absent from the Operational Reality manifest`);
  return value;
}

function inputPort(descriptor: CapabilityDescriptor) {
  const value = descriptor.ports.inputs.find((candidate) => candidate.name === "request");
  if (!value) throw new Error(`${descriptor.operationId} request port missing`);
  return value;
}

function outputPort(descriptor: CapabilityDescriptor, name: string) {
  const value = descriptor.ports.outputs.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`${descriptor.operationId} ${name} port missing`);
  return value;
}

function shape(value: CapabilityDescriptor["ports"]["inputs"][number]): WorldQueryPlanV2SchemaPort {
  return {
    schemaUri: value.schemaUri,
    schemaHash: value.schemaHash,
    valueKind: value.valueKind,
    unitSemantics: value.unitSemantics
  };
}

function literal(
  valuePort: CapabilityDescriptor["ports"]["inputs"][number],
  value: unknown
): Extract<WorldQueryPlanV2InputBinding, { kind: "LITERAL" }> {
  return { kind: "LITERAL", port: shape(valuePort), value };
}

function nodeOutput(
  nodeId: string,
  valuePort: CapabilityDescriptor["ports"]["outputs"][number]
): Extract<WorldQueryPlanV2InputBinding, { kind: "NODE_OUTPUT" }> {
  return {
    kind: "NODE_OUTPUT",
    nodeId,
    outputPort: valuePort.name,
    ...(valuePort.path === undefined ? {} : { path: valuePort.path }),
    port: shape(valuePort)
  };
}

function correlationHint() {
  return {
    claimId: `claim-${runId}`,
    externalAuthority: "planner-operational-ready",
    externalKind: "PLANNING_TASK" as const,
    externalValue: `planning-${runId}`,
    relationHint: "REPORTS_EXECUTION_OF" as const,
    matchBasis: "PROPAGATED_CORRELATION_ID" as const,
    confidence: 1,
    observedAt: eventTime,
    receivedAt: receivedTime,
    evidenceIds: [`evidence-${runId}`]
  };
}

function taskReferenceKey() {
  if (!projectedTaskReferenceKey) throw new Error("operational task reference is unavailable");
  return structuredClone(projectedTaskReferenceKey);
}

function listenerBase(app: ReturnType<typeof buildGatewayApp>): string {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Gateway address unavailable");
  return `http://127.0.0.1:${address.port}`;
}

async function submitSync(base: string, body: WorldQuerySubmission) {
  const response = await fetch(`${base}/v1/world-queries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    replayed: response.headers.get("idempotent-replay") === "true",
    body: await response.json() as any
  };
}

async function submitAsync(base: string, body: WorldQuerySubmission) {
  const response = await fetch(`${base}/v1/world-queries`, {
    method: "POST",
    headers: { "content-type": "application/json", prefer: "respond-async" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}

function delayedClient(delegate: ProviderClient, operationId: string) {
  let arrive!: () => void;
  let resume!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  const client: ProviderClient = {
    providerId: delegate.providerId,
    manifest: () => delegate.manifest(),
    health: () => delegate.health(),
    async execute(id: string, request: ProviderExecutionRequest): Promise<CapabilityResultEnvelope> {
      const result = await delegate.execute(id, request);
      if (id === operationId) {
        arrive();
        await released;
      }
      return result;
    }
  };
  return { client, arrived, release: resume };
}
