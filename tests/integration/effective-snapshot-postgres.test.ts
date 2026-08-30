import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  GowmV07QuerySnapshotManifest as QuerySnapshotManifest,
  JobRecord,
  WorldQueryResultNodeResult,
  WorldQuerySubmission
} from "../../packages/platform/contract-runtime/src/index.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import {
  PostgresQueryPlanStore,
  principalContextHash,
  type GatewayPrincipal,
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

async function installFixtureOperation(): Promise<void> {
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

  it.skipIf(phase === "after")("persists a restart probe after the resolver commit", async () => {
    const store = new PostgresQueryPlanStore(pool);
    const fixture = context(restartQueryId);
    await store.create(fixture);
    const next = manifest(fixture.effectiveSnapshotManifest.querySnapshotId, [resource("restart")]);
    await store.commitNodeResult(fixture.job.jobId, completedNode("9"), {
      expectedManifestHash: fixture.effectiveSnapshotManifest.manifestHash,
      nextEffectiveManifest: next
    });
    expect((await store.getByJobId(fixture.job.jobId))?.effectiveSnapshotManifest).toEqual(next);
  });

  it.skipIf(phase === "before")("reloads the resolver node and expanded snapshot in a fresh process", async () => {
    const store = new PostgresQueryPlanStore(pool);
    const recovered = await store.getByJobId(`job:${restartQueryId}`);
    expect(recovered).toBeDefined();
    expect(recovered).toMatchObject({
      requestedSnapshotManifest: { resources: [] },
      effectiveSnapshotManifest: {
        resources: [expect.objectContaining({
          resourceKind: "TRACKLET_VERSION",
          resourceId: "scope:restart",
          version: "v1",
          pinning: "PINNED"
        })]
      },
      effectiveSnapshotRevision: 1
    });
    expect(await store.listNodes(`job:${restartQueryId}`)).toEqual([
      expect.objectContaining({
        nodeId: "resolver",
        status: "COMPLETED",
        outputHash: digest("9")
      })
    ]);
  });
});
