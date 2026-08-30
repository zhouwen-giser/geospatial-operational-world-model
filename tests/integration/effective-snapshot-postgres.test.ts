import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  DataSnapshotContext,
  GowmV071QuerySnapshotManifest as QuerySnapshotManifest,
  JobRecord,
  WorldQueryPlanV2InputBinding,
  WorldQueryPlanV2Node,
  WorldQueryResultNodeResult,
  WorldQuerySubmission
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  getContractSchema,
  getContractSchemaHash
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,
  ProviderProtocolError,
  sha256,
  type ProviderHandlerContext,
  type ProviderOperation
} from "../../packages/platform/provider-sdk/src/index.js";
import {
  CapabilityRegistry,
  DirectExecutionService,
  InProcessProviderClient,
  MemoryAuditSink,
  MemoryGatewayIdempotencyStore,
  MemoryGatewayRecordStore,
  PostgresQueryPlanStore,
  ProviderCircuitBreaker,
  QueryPlanValidator,
  WorldQueryRuntime,
  principalContextHash,
  type GatewayPrincipal,
  type QueryExecutionFence,
  type QueryJobContext
} from "../../services/gateway/world-capability-gateway/src/index.js";

type SnapshotResource = QuerySnapshotManifest["resources"][number];
type Operation = WorldQuerySubmission["plan"]["nodes"][number]["operation"];

const databaseUrl = process.env.GOWM_V07_DATABASE_URL ?? process.env.DATABASE_URL;
const enabled = process.env.RUN_GOWM_V07_DB_INTEGRATION === "1" && databaseUrl !== undefined;
const phase = process.env.GOWM_V07_EFFECTIVE_SNAPSHOT_PHASE ?? "all";
const runId = (process.env.GOWM_V07_RUN_ID ?? randomUUID()).replaceAll("-", "").slice(0, 20);
const restartQueryId = `snapshot-restart-${runId}`;
const capturedAt = "2026-08-30T00:00:00.000Z";
const objectSchemaUri = "urn:gowm:v0.2:value:object";
const objectSchema = getContractSchema(objectSchemaUri);
const objectSchemaHash = getContractSchemaHash(objectSchemaUri);
const parameterSchemaHash = getContractSchemaHash("world-query-parameters.schema.json");
const restartResolverOperationId = "snapshot.restart-resolver";
const restartConsumerOperationId = "snapshot.restart-consumer";
const restartResourceId = `restart-${runId}`;
const restartResourceDigest = sha256({ fixture: "postgres-runtime-restart", runId });
const restartPrincipal: GatewayPrincipal = {
  principalRef: "principal:v071-postgres-runtime-restart",
  authenticationMethod: "TEST_ATTESTED",
  authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
  dataScopeClaim: "scope-a",
  allowExperimental: true
};

let pool: Pool;
let operation: Operation;

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function resource(id: string, version = "v1"): SnapshotResource {
  return {
    resourceKind: "TRACKLET_VERSION",
    resourceId: `scope:${id}`,
    version,
    contentHash: digest(version === "v1" ? "a" : "b"),
    worldVersion: version === "v1" ? 1 : 2,
    pinning: "PINNED"
  };
}

function manifest(
  querySnapshotId: string,
  resources: SnapshotResource[] = []
): QuerySnapshotManifest & { manifestHash: `sha256:${string}` } {
  const content: Omit<QuerySnapshotManifest, "manifestHash"> = {
    querySnapshotId,
    mode: "BEST_EFFORT",
    consistency: "BEST_EFFORT",
    capturedAt,
    resources: structuredClone(resources)
  };
  return { ...content, manifestHash: sha256(content) };
}

function submission(queryId: string): WorldQuerySubmission {
  return {
    requestId: `request:${queryId}`,
    idempotencyKey: `idempotency:${queryId}`,
    parameterSchemaHash: digest("0"),
    parameters: {},
    plan: {
      queryPlanVersion: "2.0",
      queryId,
      nodes: [{
        nodeId: "resolver",
        operation,
        inputs: {},
        failurePolicy: "FAIL_FAST",
        budget: {
          maximumRows: 1,
          maximumCandidates: 1,
          maximumOutputBytes: 1_024,
          maximumExecutionMs: 1_000
        }
      }],
      outputs: [],
      budgets: {
        maximumNodes: 1,
        maximumDepth: 1,
        maximumRows: 1,
        maximumCandidates: 1,
        maximumOutputBytes: 1_024,
        maximumExecutionMs: 1_000
      }
    }
  };
}

function context(queryId: string, initial = manifest(`snapshot-${queryId}`)): QueryJobContext {
  const request = submission(queryId);
  const principal: GatewayPrincipal = {
    principalRef: "principal:v07-postgres-snapshot-test",
    authenticationMethod: "TEST_ATTESTED",
    authenticatedAt: capturedAt,
    allowExperimental: true
  };
  const job: JobRecord = {
    jobId: `job:${queryId}`,
    requestId: request.requestId,
    queryId,
    kind: "WORLD_QUERY",
    status: "QUEUED",
    createdAt: capturedAt,
    updatedAt: capturedAt
  };
  return {
    job,
    submission: request,
    principal,
    requestHash: sha256(request),
    cancellationRequested: false,
    requestedSnapshotManifest: structuredClone(initial),
    effectiveSnapshotManifest: structuredClone(initial),
    effectiveSnapshotRevision: 0
  };
}

function completedNode(outputCharacter = "2"): WorldQueryResultNodeResult {
  return {
    nodeId: "resolver",
    operation,
    status: "COMPLETED",
    attempt: 1,
    startedAt: capturedAt,
    finishedAt: "2026-08-30T00:00:01.000Z",
    inputHash: digest("1"),
    outputHash: digest(outputCharacter)
  };
}

type RestartOperationKind = "resolver" | "consumer";

interface RestartHarness {
  descriptors: Record<RestartOperationKind, CapabilityDescriptor>;
  runtime: WorldQueryRuntime;
  observedConsumerSnapshots: ProviderHandlerContext["snapshots"][];
  calls: Record<RestartOperationKind, number>;
}

function restartSnapshot(snapshotCapturedAt: string): DataSnapshotContext {
  return {
    consistency: "PINNED",
    capturedAt: snapshotCapturedAt,
    scopeDigest: sha256({ dataScopeKey: "scope-a" }),
    resources: [{
      referenceKey: {
        namespace: "scope-a",
        kind: "TRACKLET_VERSION",
        id: restartResourceId,
        version: "v1"
      },
      authority: "gowm.postgres-runtime-restart-fixture",
      pinning: "PINNED",
      digest: restartResourceDigest,
      worldVersion: 71
    }]
  };
}

function restartDescriptor(
  operationId: string,
  resourceResolution: "DISCOVER_RESOURCES" | "REQUIRE_PINNED"
): CapabilityDescriptor {
  return {
    operationId,
    operationVersion: "1.0",
    semanticRole: "GENERIC_ANALYSIS",
    dataBinding: "WORLD_SNAPSHOT_BOUND",
    resultSemantics: "DERIVED_ANALYSIS",
    executionBindings: ["SYNC_HTTP"],
    criticalPathPolicy: "REMOTE_ONLY",
    maturity: "PREVIEW",
    inputSchemaUri: objectSchemaUri,
    inputSchemaHash: objectSchemaHash,
    outputSchemaUri: objectSchemaUri,
    outputSchemaHash: objectSchemaHash,
    scopePolicy: "DATA_SCOPE_REQUIRED",
    execution: {
      mode: "SYNC",
      defaultTimeoutMs: 5_000,
      maximumTimeoutMs: 120_000,
      costClass: "LOW"
    },
    limits: {
      maximumInputBytes: 16_384,
      maximumOutputBytes: 16_384,
      maximumRows: 10,
      maximumCandidates: 10,
      maximumBatchItems: 10
    },
    snapshotPolicy: {
      dataSnapshot: "REQUIRED",
      computeSnapshot: "REQUIRED",
      resourceResolution
    },
    ports: {
      inputs: [{
        name: "request",
        schemaUri: objectSchemaUri,
        schemaHash: objectSchemaHash,
        valueKind: "ANY",
        unitSemantics: "UNSPECIFIED"
      }],
      outputs: [{
        name: "result",
        schemaUri: objectSchemaUri,
        schemaHash: objectSchemaHash,
        valueKind: "ANY",
        unitSemantics: "UNSPECIFIED"
      }]
    }
  };
}

function createRestartHarness(
  store: PostgresQueryPlanStore,
  rejectResolverExecution: boolean
): RestartHarness {
  const descriptors = {
    resolver: restartDescriptor(restartResolverOperationId, "DISCOVER_RESOURCES"),
    consumer: restartDescriptor(restartConsumerOperationId, "REQUIRE_PINNED")
  };
  const calls: Record<RestartOperationKind, number> = { resolver: 0, consumer: 0 };
  const observedConsumerSnapshots: ProviderHandlerContext["snapshots"][] = [];
  const operations: ProviderOperation[] = [{
    descriptor: descriptors.resolver,
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    method: {
      engine: "postgres-runtime-restart-fixture",
      engineVersion: "1.0.0",
      methodId: "resolve-tracklet",
      methodVersion: "1.0"
    },
    async handle(input, context) {
      calls.resolver += 1;
      if (rejectResolverExecution) {
        throw new ProviderProtocolError(
          "PROVIDER_NOT_READY",
          "persisted Resolver A must not execute in the recovery process",
          { retryable: false }
        );
      }
      return {
        status: "COMPLETED",
        value: { ...input as Record<string, unknown>, resolvedTracklet: restartResourceId },
        dataSnapshot: restartSnapshot(context.snapshots.effective!.capturedAt),
        consumption: { rows: 1, candidates: 1 }
      };
    }
  }, {
    descriptor: descriptors.consumer,
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    method: {
      engine: "postgres-runtime-restart-fixture",
      engineVersion: "1.0.0",
      methodId: "consume-tracklet",
      methodVersion: "1.0"
    },
    async handle(input, context) {
      calls.consumer += 1;
      observedConsumerSnapshots.push(structuredClone(context.snapshots));
      return {
        status: "COMPLETED",
        value: { ...input as Record<string, unknown>, consumedVersion: "v1" },
        dataSnapshot: restartSnapshot(context.snapshots.effective!.capturedAt),
        consumption: { rows: 1, candidates: 1 }
      };
    }
  }];
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0",
    provider: {
      providerId: "v07.snapshot.fixture",
      providerVersion: "1.0.0",
      owner: "GOWM tests",
      implementationDigest: sha256({ fixture: "postgres-runtime-restart", version: 1 })
    },
    endpoints: {
      manifest: "/v1/manifest",
      liveness: "/health/live",
      readiness: "/health/ready",
      execute: "/v1/operations/{operationId}:execute",
      job: "/v1/jobs/{jobId}"
    },
    capabilities: [descriptors.resolver, descriptors.consumer]
  };
  const provider = createProviderRuntime({
    manifest,
    operations,
    policyVersion: "postgres-runtime-restart/1.0",
    policyDigest: sha256({ policy: "postgres-runtime-restart/1.0" })
  });
  const registry = new CapabilityRegistry();
  registry.register({
    approvalId: "approval-postgres-runtime-restart",
    approved: true,
    endpoint: new URL("http://127.0.0.1:34701/"),
    client: new InProcessProviderClient(provider),
    manifest
  });
  const direct = new DirectExecutionService({
    registry,
    circuits: new ProviderCircuitBreaker(),
    idempotency: new MemoryGatewayIdempotencyStore(),
    audit: new MemoryAuditSink(),
    gatewayId: "gateway-postgres-runtime-restart",
    policyVersion: "gateway-postgres-runtime-restart/1.0",
    attestationIssuer: "gateway-postgres-runtime-restart",
    records: new MemoryGatewayRecordStore()
  });
  return {
    descriptors,
    runtime: new WorldQueryRuntime({
      validator: new QueryPlanValidator(registry),
      directExecution: direct,
      store,
      autoRunAsync: false
    }),
    observedConsumerSnapshots,
    calls
  };
}

function restartOperation(descriptor: CapabilityDescriptor): Operation {
  return {
    operationId: descriptor.operationId,
    operationVersion: descriptor.operationVersion,
    inputSchemaHash: descriptor.inputSchemaHash,
    outputSchemaHash: descriptor.outputSchemaHash
  };
}

function restartPort(descriptor: CapabilityDescriptor) {
  const value = descriptor.ports.inputs[0];
  if (!value) throw new Error("restart fixture input port is missing");
  return {
    schemaUri: value.schemaUri,
    schemaHash: value.schemaHash,
    valueKind: value.valueKind,
    unitSemantics: value.unitSemantics
  };
}

function restartNode(
  nodeId: string,
  descriptor: CapabilityDescriptor,
  inputs: Record<string, WorldQueryPlanV2InputBinding>
): WorldQueryPlanV2Node {
  return {
    nodeId,
    operation: restartOperation(descriptor),
    inputs,
    failurePolicy: "FAIL_FAST",
    budget: {
      maximumRows: 10,
      maximumCandidates: 10,
      maximumOutputBytes: 16_384,
      maximumExecutionMs: 120_000
    }
  };
}

function restartSubmission(descriptors: RestartHarness["descriptors"]): WorldQuerySubmission {
  const resolver = restartNode("resolver-a", descriptors.resolver, {
    request: {
      kind: "LITERAL",
      value: { runId, stage: "resolver" },
      port: restartPort(descriptors.resolver)
    }
  });
  const consumer = restartNode("consumer-b", descriptors.consumer, {
    request: {
      kind: "NODE_OUTPUT",
      nodeId: "resolver-a",
      outputPort: "result",
      port: restartPort(descriptors.consumer)
    }
  });
  return {
    requestId: `request:${restartQueryId}`,
    idempotencyKey: `idempotency:${restartQueryId}`,
    parameterSchemaHash,
    parameters: {},
    snapshotPolicy: { mode: "LATEST_AT_START", allowDowngrade: false },
    plan: {
      queryPlanVersion: "2.0",
      queryId: restartQueryId,
      nodes: [resolver, consumer],
      outputs: [{
        name: "answer",
        binding: {
          kind: "NODE_OUTPUT",
          nodeId: "consumer-b",
          outputPort: "result",
          port: restartPort(descriptors.consumer)
        }
      }],
      budgets: {
        maximumNodes: 2,
        maximumDepth: 2,
        maximumRows: 20,
        maximumCandidates: 20,
        maximumOutputBytes: 32_768,
        maximumExecutionMs: 300_000
      }
    }
  };
}

function expectedRestartResource(): SnapshotResource {
  return {
    resourceKind: "TRACKLET_VERSION",
    resourceId: `scope-a:${restartResourceId}`,
    version: "v1",
    contentHash: restartResourceDigest,
    worldVersion: 71,
    pinning: "PINNED"
  };
}

function assertManifestHash(manifestValue: QuerySnapshotManifest): void {
  const { manifestHash, ...content } = manifestValue;
  expect(manifestHash).toBe(sha256(content));
}

class InterruptAfterPostgresResolverCommitStore extends PostgresQueryPlanStore {
  #interrupted = false;

  override async commitNodeResult(
    jobId: string,
    result: WorldQueryResultNodeResult,
    snapshotUpdate?: {
      expectedManifestHash: QuerySnapshotManifest["manifestHash"];
      nextEffectiveManifest: QuerySnapshotManifest;
    },
    fence?: QueryExecutionFence
  ): Promise<void> {
    await super.commitNodeResult(jobId, result, snapshotUpdate, fence);
    if (
      !this.#interrupted &&
      result.nodeId === "resolver-a" &&
      result.status === "COMPLETED" &&
      snapshotUpdate !== undefined
    ) {
      this.#interrupted = true;
      throw workerSupersededAfterCommit();
    }
  }
}

function workerSupersededAfterCommit(): ProviderProtocolError {
  return new ProviderProtocolError(
    "PROVIDER_NOT_READY",
    "fixture process disappeared after the Resolver A transaction committed",
    { retryable: false, details: { stage: "EXECUTION_FENCE" } }
  );
}

async function installFixtureOperation(): Promise<void> {
  await pool.query(
    `INSERT INTO public.data_scope(scope_key, operational_domain, description)
     VALUES ('scope-a', 'TEST', 'v0.7.1 PostgreSQL runtime restart fixture')
     ON CONFLICT (scope_key) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO gowm_capability.provider_registry(
       provider_id, provider_version, display_name, owner_name, endpoint,
       manifest_uri, endpoint_bindings, manifest_hash, implementation_digest,
       approval_state, approved_by, approved_at, enabled
     ) VALUES (
       'v07.snapshot.fixture', '1.0.0', 'v0.7 snapshot fixture', 'GOWM tests',
       'http://v07-snapshot.invalid', 'urn:test:v07-snapshot-manifest',
       '{"manifest":"/manifest","liveness":"/health/live","readiness":"/health/ready","execute":"/operations/{operationId}:execute","job":"/jobs/{jobId}"}'::jsonb,
       $1, $2, 'APPROVED', 'v07-test', clock_timestamp(), true
     ) ON CONFLICT (provider_id) DO NOTHING`,
    [digest("7"), digest("8")]
  );
  await pool.query(
    `INSERT INTO gowm_capability.capability(
       operation_id, semantic_role, data_binding, result_semantics, description
     ) VALUES (
       'snapshot.fixture', 'FOUNDATION_DATA_QUERY', 'WORLD_SNAPSHOT_BOUND',
       'DATA_QUERY', 'v0.7 PostgreSQL snapshot persistence fixture'
     ) ON CONFLICT (operation_id) DO NOTHING`
  );
  const ports = {
    inputs: [],
    outputs: [{
      name: "result",
      schemaUri: "urn:test:v07-snapshot-result",
      schemaHash: digest("4"),
      valueKind: "ANY",
      unitSemantics: "UNSPECIFIED"
    }]
  };
  await pool.query(
    `INSERT INTO gowm_capability.provider_operation(
       operation_id, operation_version, provider_id,
       input_schema_uri, input_schema_hash, output_schema_uri, output_schema_hash,
       maturity, scope_policy, execution_mode, execution_bindings,
       critical_path_policy, default_timeout_ms, maximum_timeout_ms, cost_class,
       limits, ports, data_snapshot_policy, policy_version, enabled
     ) VALUES (
       'snapshot.fixture', '1.0', 'v07.snapshot.fixture',
       'urn:test:v07-snapshot-input', $1, 'urn:test:v07-snapshot-result', $2,
       'EXPERIMENTAL', 'REQUEST_CONTEXT', 'SYNC', ARRAY['EMBEDDED_SDK'],
       'EMBEDDED_REQUIRED', 1000, 1000, 'LOW',
       '{"maximumRows":1}'::jsonb, $3::jsonb, 'REQUIRED', 'v07-test/1', true
     ) ON CONFLICT (operation_id, operation_version) DO NOTHING`,
    [digest("3"), digest("4"), JSON.stringify(ports)]
  );
  await pool.query(
    `INSERT INTO gowm_capability.capability(
       operation_id, semantic_role, data_binding, result_semantics, description
     ) VALUES
       ($1, 'GENERIC_ANALYSIS', 'WORLD_SNAPSHOT_BOUND', 'DERIVED_ANALYSIS',
        'v0.7.1 PostgreSQL runtime restart resolver fixture'),
       ($2, 'GENERIC_ANALYSIS', 'WORLD_SNAPSHOT_BOUND', 'DERIVED_ANALYSIS',
        'v0.7.1 PostgreSQL runtime restart consumer fixture')
     ON CONFLICT (operation_id) DO NOTHING`,
    [restartResolverOperationId, restartConsumerOperationId]
  );
  const restartPorts = {
    inputs: [{
      name: "request",
      schemaUri: objectSchemaUri,
      schemaHash: objectSchemaHash,
      valueKind: "ANY",
      unitSemantics: "UNSPECIFIED"
    }],
    outputs: [{
      name: "result",
      schemaUri: objectSchemaUri,
      schemaHash: objectSchemaHash,
      valueKind: "ANY",
      unitSemantics: "UNSPECIFIED"
    }]
  };
  await pool.query(
    `INSERT INTO gowm_capability.provider_operation(
       operation_id, operation_version, provider_id,
       input_schema_uri, input_schema_hash, output_schema_uri, output_schema_hash,
       maturity, scope_policy, execution_mode, execution_bindings,
       critical_path_policy, default_timeout_ms, maximum_timeout_ms, cost_class,
       limits, ports, data_snapshot_policy, policy_version, enabled
     ) VALUES
       ($1, '1.0', 'v07.snapshot.fixture',
        $3, $4, $3, $4,
        'EXPERIMENTAL', 'DATA_SCOPE_REQUIRED', 'SYNC', ARRAY['EMBEDDED_SDK'],
        'EMBEDDED_REQUIRED', 5000, 120000, 'LOW',
        '{"maximumRows":10,"maximumCandidates":10}'::jsonb, $5::jsonb,
        'REQUIRED', 'v071-restart-test/1', true),
       ($2, '1.0', 'v07.snapshot.fixture',
        $3, $4, $3, $4,
        'EXPERIMENTAL', 'DATA_SCOPE_REQUIRED', 'SYNC', ARRAY['EMBEDDED_SDK'],
        'EMBEDDED_REQUIRED', 5000, 120000, 'LOW',
        '{"maximumRows":10,"maximumCandidates":10}'::jsonb, $5::jsonb,
        'REQUIRED', 'v071-restart-test/1', true)
     ON CONFLICT (operation_id, operation_version) DO NOTHING`,
    [
      restartResolverOperationId,
      restartConsumerOperationId,
      objectSchemaUri,
      objectSchemaHash,
      JSON.stringify(restartPorts)
    ]
  );
  operation = {
    operationId: "snapshot.fixture",
    operationVersion: "1.0",
    inputSchemaHash: digest("3"),
    outputSchemaHash: digest("4")
  };
}

describe.skipIf(!enabled)("v0.7 PostgreSQL effective snapshot persistence", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    await installFixtureOperation();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it.skipIf(phase === "after")("commits a node and snapshot atomically, enforces CAS, and rolls back on a snapshot constraint failure", async () => {
    const store = new PostgresQueryPlanStore(pool);

    const committed = context(`snapshot-commit-${runId}`);
    await store.create(committed);
    const committedNext = manifest(
      committed.effectiveSnapshotManifest.querySnapshotId,
      [resource("committed")]
    );
    await store.commitNodeResult(committed.job.jobId, completedNode(), {
      expectedManifestHash: committed.effectiveSnapshotManifest.manifestHash,
      nextEffectiveManifest: committedNext
    });
    expect(await store.getByJobId(committed.job.jobId)).toMatchObject({
      effectiveSnapshotManifest: committedNext,
      effectiveSnapshotRevision: 1
    });
    expect(await store.listNodes(committed.job.jobId)).toEqual([
      expect.objectContaining({ nodeId: "resolver", status: "COMPLETED" })
    ]);

    const staleCas = context(`snapshot-cas-${runId}`);
    await store.create(staleCas);
    await expect(store.commitNodeResult(staleCas.job.jobId, completedNode(), {
      expectedManifestHash: digest("f"),
      nextEffectiveManifest: manifest(
        staleCas.effectiveSnapshotManifest.querySnapshotId,
        [resource("cas")]
      )
    })).rejects.toMatchObject({ code: "PROVIDER_NOT_READY", retryable: true });
    expect(await store.getByJobId(staleCas.job.jobId)).toMatchObject({
      effectiveSnapshotRevision: 0,
      effectiveSnapshotManifest: staleCas.effectiveSnapshotManifest
    });
    expect(await store.listNodes(staleCas.job.jobId)).toEqual([
      expect.objectContaining({ nodeId: "resolver", status: "QUEUED" })
    ]);

    const rollback = context(`snapshot-rollback-${runId}`);
    await store.create(rollback);
    const invalidNext = manifest("different-query-snapshot-id", [resource("rollback")]);
    await expect(store.commitNodeResult(rollback.job.jobId, completedNode(), {
      expectedManifestHash: rollback.effectiveSnapshotManifest.manifestHash,
      nextEffectiveManifest: invalidNext
    })).rejects.toMatchObject({ code: "23514" });
    expect(await store.getByJobId(rollback.job.jobId)).toMatchObject({
      effectiveSnapshotRevision: 0,
      effectiveSnapshotManifest: rollback.effectiveSnapshotManifest
    });
    expect(await store.listNodes(rollback.job.jobId)).toEqual([
      expect.objectContaining({ nodeId: "resolver", status: "QUEUED" })
    ]);
    for (const completedFixture of [committed, staleCas, rollback]) {
      await store.requestCancellation(
        completedFixture.submission.plan.queryId,
        principalContextHash(completedFixture.principal)
      );
    }
  });

  it.skipIf(phase === "after")("rejects a superseded worker fence without changing the node or effective snapshot", async () => {
    const store = new PostgresQueryPlanStore(pool);

    const expiredFixture = context(`snapshot-expired-fence-${runId}`);
    const expiredCreated = await store.create(expiredFixture);
    expect(expiredCreated.context.gatewayJobId).toBeDefined();
    const expiredFence = { leaseOwner: `worker-expired-${runId}`, attempt: 1 };
    await pool.query(
      `UPDATE gowm_capability.gateway_job
       SET state = 'RUNNING', lease_owner = $1,
           lease_until = clock_timestamp() - interval '1 second',
           attempt_count = $2, updated_at = clock_timestamp()
       WHERE job_id = $3::uuid`,
      [expiredFence.leaseOwner, expiredFence.attempt, expiredCreated.context.gatewayJobId]
    );
    await expect(store.commitNodeResult(
      expiredFixture.job.jobId,
      completedNode(),
      undefined,
      expiredFence
    )).rejects.toMatchObject({ code: "PROVIDER_NOT_READY", retryable: false });
    expect(await store.listNodes(expiredFixture.job.jobId)).toEqual([
      expect.objectContaining({ nodeId: "resolver", status: "QUEUED" })
    ]);
    await store.requestCancellation(
      expiredFixture.submission.plan.queryId,
      principalContextHash(expiredFixture.principal)
    );

    const fixture = context(`snapshot-fence-${runId}`);
    const created = await store.create(fixture);
    expect(created.context.gatewayJobId).toBeDefined();
    const staleFence = { leaseOwner: `worker-old-${runId}`, attempt: 1 };
    await pool.query(
      `UPDATE gowm_capability.gateway_job
       SET state = 'RUNNING', lease_owner = $1,
           lease_until = clock_timestamp() + interval '60 seconds',
           attempt_count = $2, updated_at = clock_timestamp()
       WHERE job_id = $3::uuid`,
      [staleFence.leaseOwner, staleFence.attempt, created.context.gatewayJobId]
    );
    await pool.query(
      `UPDATE gowm_capability.gateway_job
       SET lease_owner = $1, attempt_count = attempt_count + 1, updated_at = clock_timestamp()
       WHERE job_id = $2::uuid`,
      [`worker-current-${runId}`, created.context.gatewayJobId]
    );
    const current = await store.getByJobId(fixture.job.jobId);
    expect(current?.executionFence?.attempt).toBe(staleFence.attempt + 1);
    const next = manifest(fixture.effectiveSnapshotManifest.querySnapshotId, [resource("fenced")]);

    await expect(store.commitNodeResult(
      fixture.job.jobId,
      completedNode(),
      {
        expectedManifestHash: fixture.effectiveSnapshotManifest.manifestHash,
        nextEffectiveManifest: next
      },
      staleFence
    )).rejects.toMatchObject({ code: "PROVIDER_NOT_READY", retryable: false });
    expect(await store.getByJobId(fixture.job.jobId)).toMatchObject({
      effectiveSnapshotRevision: 0,
      effectiveSnapshotManifest: fixture.effectiveSnapshotManifest
    });
    expect(await store.listNodes(fixture.job.jobId)).toEqual([
      expect.objectContaining({ nodeId: "resolver", status: "QUEUED" })
    ]);
  });

  it.skipIf(phase !== "before")(
    "real WorldQueryRuntime restart phase A commits Resolver A atomically and then loses the process",
    async () => {
      const store = new InterruptAfterPostgresResolverCommitStore(pool);
      const test = createRestartHarness(store, false);
      const queued = await test.runtime.submit(
        restartSubmission(test.descriptors),
        restartPrincipal,
        "ASYNC"
      );

      expect(queued.replayed).toBe(false);
      await expect(test.runtime.run(queued.job.jobId)).rejects.toMatchObject({
        code: "PROVIDER_NOT_READY",
        retryable: false,
        details: { stage: "EXECUTION_FENCE" }
      });

      const interrupted = await store.getByJobId(queued.job.jobId);
      if (!interrupted) throw new Error("interrupted PostgreSQL query was not persisted");
      assertManifestHash(interrupted.requestedSnapshotManifest);
      assertManifestHash(interrupted.effectiveSnapshotManifest);
      expect(interrupted).toMatchObject({
        job: { status: "RUNNING" },
        requestedSnapshotManifest: { resources: [] },
        effectiveSnapshotManifest: { resources: [expectedRestartResource()] },
        effectiveSnapshotRevision: 1
      });

      const nodes = await store.listNodes(queued.job.jobId);
      expect(nodes).toHaveLength(2);
      const resolver = nodes.find((node) => node.nodeId === "resolver-a");
      const consumer = nodes.find((node) => node.nodeId === "consumer-b");
      expect(resolver).toMatchObject({
        nodeId: "resolver-a",
        status: "COMPLETED",
        attempt: 1,
        snapshotAdherence: {
          nodeId: "resolver-a",
          status: "MATCHED",
          checkedResources: 1,
          mismatches: []
        },
        effectiveSnapshotRevisionBefore: 0,
        effectiveSnapshotRevisionAfter: 1,
        observedSnapshotResourceIdentities: [
          `["TRACKLET_VERSION","scope-a:${restartResourceId}"]`
        ]
      });
      expect(consumer).toMatchObject({
        nodeId: "consumer-b",
        status: "QUEUED",
        attempt: 0
      });
      expect(test.calls).toEqual({ resolver: 1, consumer: 0 });
      if (!resolver?.outputHash) throw new Error("Resolver A output hash was not persisted");

      process.stdout.write(`${JSON.stringify({
        marker: "GOWM_V071_NODE_ADHERENCE_RESTART_BEFORE_ASSERTED",
        processId: process.pid,
        runId,
        queryId: restartQueryId,
        jobId: queued.job.jobId,
        effectiveManifestHash: interrupted.effectiveSnapshotManifest.manifestHash,
        resolverOutputHash: resolver.outputHash,
        resolverRecordHash: sha256(resolver),
        effectiveSnapshotRevision: interrupted.effectiveSnapshotRevision,
        resolverCalls: test.calls.resolver,
        consumerCalls: test.calls.consumer
      })}\n`);
    }
  );

  it.skipIf(phase !== "after")(
    "real WorldQueryRuntime restart phase B reconstructs the runtime and resumes only Consumer B",
    async () => {
      const store = new PostgresQueryPlanStore(pool);
      const recovered = await store.getByQueryId(restartQueryId);
      if (!recovered) throw new Error("phase A PostgreSQL query was not found by the recovery process");
      expect(recovered.job.status).toBe("RUNNING");
      expect(recovered.effectiveSnapshotRevision).toBe(1);
      expect(recovered.effectiveSnapshotManifest.resources).toEqual([expectedRestartResource()]);
      assertManifestHash(recovered.requestedSnapshotManifest);
      assertManifestHash(recovered.effectiveSnapshotManifest);

      const nodesBeforeRecovery = await store.listNodes(recovered.job.jobId);
      const resolverBeforeRecovery = nodesBeforeRecovery.find((node) => node.nodeId === "resolver-a");
      if (!resolverBeforeRecovery?.outputHash) {
        throw new Error("phase A Resolver record was not atomically persisted");
      }
      expect(resolverBeforeRecovery).toMatchObject({
        status: "COMPLETED",
        attempt: 1,
        snapshotAdherence: { status: "MATCHED" },
        effectiveSnapshotRevisionBefore: 0,
        effectiveSnapshotRevisionAfter: 1
      });

      const test = createRestartHarness(store, true);
      const result = await test.runtime.run(recovered.job.jobId);

      expect(result.status).toBe("COMPLETED");
      expect(test.calls).toEqual({ resolver: 0, consumer: 1 });
      expect(test.observedConsumerSnapshots).toHaveLength(1);
      expect(test.observedConsumerSnapshots[0]).toMatchObject({
        requested: { resources: [] },
        effective: { resources: [expectedRestartResource()] }
      });
      expect(result.requestedSnapshotManifest?.resources).toEqual([]);
      expect(result.effectiveSnapshotManifest?.resources).toEqual([expectedRestartResource()]);
      expect(result.snapshotManifest).toEqual(result.effectiveSnapshotManifest);
      expect(result.snapshotAdherence).toEqual([
        expect.objectContaining({
          nodeId: "resolver-a",
          status: "MATCHED",
          checkedResources: 1,
          mismatches: []
        }),
        expect.objectContaining({
          nodeId: "consumer-b",
          status: "MATCHED",
          checkedResources: 1,
          mismatches: []
        })
      ]);

      const finalContext = await store.getByJobId(recovered.job.jobId);
      if (!finalContext) throw new Error("recovered PostgreSQL query disappeared after completion");
      expect(finalContext).toMatchObject({
        job: { status: "COMPLETED" },
        effectiveSnapshotRevision: 1,
        effectiveSnapshotManifest: recovered.effectiveSnapshotManifest
      });
      assertManifestHash(finalContext.effectiveSnapshotManifest);

      const nodesAfterRecovery = await store.listNodes(recovered.job.jobId);
      const resolverAfterRecovery = nodesAfterRecovery.find((node) => node.nodeId === "resolver-a");
      const consumerAfterRecovery = nodesAfterRecovery.find((node) => node.nodeId === "consumer-b");
      expect(resolverAfterRecovery).toEqual(resolverBeforeRecovery);
      expect(consumerAfterRecovery).toMatchObject({
        nodeId: "consumer-b",
        status: "COMPLETED",
        attempt: 1,
        snapshotAdherence: {
          nodeId: "consumer-b",
          status: "MATCHED",
          checkedResources: 1,
          mismatches: []
        },
        effectiveSnapshotBeforeHash: recovered.effectiveSnapshotManifest.manifestHash,
        effectiveSnapshotAfterHash: recovered.effectiveSnapshotManifest.manifestHash,
        effectiveSnapshotRevisionBefore: 1,
        effectiveSnapshotRevisionAfter: 1,
        observedSnapshotResourceIdentities: [
          `["TRACKLET_VERSION","scope-a:${restartResourceId}"]`
        ]
      });

      process.stdout.write(`${JSON.stringify({
        marker: "GOWM_V071_NODE_ADHERENCE_RESTART_AFTER_ASSERTED",
        processId: process.pid,
        runId,
        queryId: restartQueryId,
        jobId: recovered.job.jobId,
        effectiveManifestHash: finalContext.effectiveSnapshotManifest.manifestHash,
        resolverOutputHash: resolverBeforeRecovery.outputHash,
        resolverRecordHash: sha256(resolverBeforeRecovery),
        effectiveSnapshotRevision: finalContext.effectiveSnapshotRevision,
        resultStatus: result.status,
        resolverRecordUnchanged: true,
        resolverCalls: test.calls.resolver,
        consumerCalls: test.calls.consumer
      })}\n`);
    }
  );
});
