import { describe, expect, it } from "vitest";
import type {
  GowmV07QuerySnapshotManifest as QuerySnapshotManifest,
  JobRecord,
  WorldQueryResultNodeResult,
  WorldQuerySubmission
} from "../../packages/platform/contract-runtime/src/index.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import {
  MemoryQueryPlanStore,
  type GatewayPrincipal,
  type QueryJobContext
} from "../../services/gateway/world-capability-gateway/src/index.js";

type SnapshotResource = QuerySnapshotManifest["resources"][number];

const capturedAt = "2026-08-30T00:00:00.000Z";
const operation = {
  operationId: "snapshot.fixture",
  operationVersion: "1.0",
  inputSchemaHash: digest("3"),
  outputSchemaHash: digest("4")
} as const;
const principal: GatewayPrincipal = {
  principalRef: "principal:memory-snapshot-test",
  authenticationMethod: "TEST_ATTESTED",
  authenticatedAt: capturedAt,
  allowExperimental: true
};

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
  resources: SnapshotResource[] = []
): QuerySnapshotManifest & { manifestHash: `sha256:${string}` } {
  const content: Omit<QuerySnapshotManifest, "manifestHash"> = {
    querySnapshotId: "snapshot-memory-store",
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

function context(queryId: string, initial = manifest()): QueryJobContext {
  const request = submission(queryId);
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

function completedNode(): WorldQueryResultNodeResult {
  return {
    nodeId: "resolver",
    operation,
    status: "COMPLETED",
    attempt: 1,
    startedAt: capturedAt,
    finishedAt: "2026-08-30T00:00:01.000Z",
    inputHash: digest("1"),
    outputHash: digest("2")
  };
}

describe("v0.7 MemoryQueryPlanStore effective snapshots", () => {
  it("normalizes a legacy snapshot-only context and returns defensive recovery clones", async () => {
    const store = new MemoryQueryPlanStore();
    const canonical = context("query-legacy");
    const {
      requestedSnapshotManifest: _requested,
      effectiveSnapshotManifest: _effective,
      effectiveSnapshotRevision: _revision,
      ...legacyFields
    } = canonical;
    const legacy = {
      ...legacyFields,
      snapshotManifest: canonical.requestedSnapshotManifest
    } as unknown as QueryJobContext;

    const created = await store.create(legacy);
    expect(created.context).toMatchObject({
      requestedSnapshotManifest: canonical.requestedSnapshotManifest,
      effectiveSnapshotManifest: canonical.requestedSnapshotManifest,
      effectiveSnapshotRevision: 0
    });
    expect("snapshotManifest" in created.context).toBe(false);

    const recovered = await store.getByJobId(canonical.job.jobId);
    expect(recovered).toBeDefined();
    recovered!.effectiveSnapshotManifest.resources.push(resource("caller-mutation"));
    const recoveredAgain = await store.getByJobId(canonical.job.jobId);
    expect(recoveredAgain?.effectiveSnapshotManifest.resources).toEqual([]);
  });

  it("commits a terminal node and effective snapshot together for later runtime recovery", async () => {
    const store = new MemoryQueryPlanStore();
    const initial = manifest();
    const fixture = context("query-commit", initial);
    await store.create(fixture);
    const next = manifest([resource("tracklet-a")]);

    await store.commitNodeResult(fixture.job.jobId, completedNode(), {
      expectedManifestHash: initial.manifestHash,
      nextEffectiveManifest: next
    });

    const recovered = await store.getByJobId(fixture.job.jobId);
    const nodes = await store.listNodes(fixture.job.jobId);
    expect(recovered).toMatchObject({
      requestedSnapshotManifest: initial,
      effectiveSnapshotManifest: next,
      effectiveSnapshotRevision: 1
    });
    expect(nodes).toEqual([expect.objectContaining({
      nodeId: "resolver",
      status: "COMPLETED",
      outputHash: digest("2")
    })]);

    next.resources[0]!.version = "caller-mutated";
    expect((await store.getByJobId(fixture.job.jobId))?.effectiveSnapshotManifest.resources[0]?.version).toBe("v1");
  });

  it("rejects a stale manifest CAS without changing either node or snapshot", async () => {
    const store = new MemoryQueryPlanStore();
    const initial = manifest();
    const fixture = context("query-cas", initial);
    await store.create(fixture);
    const nodesBefore = await store.listNodes(fixture.job.jobId);

    await expect(store.commitNodeResult(fixture.job.jobId, completedNode(), {
      expectedManifestHash: digest("f"),
      nextEffectiveManifest: manifest([resource("tracklet-a")])
    })).rejects.toMatchObject({
      code: "PROVIDER_NOT_READY",
      retryable: true
    });

    expect(await store.listNodes(fixture.job.jobId)).toEqual(nodesBefore);
    expect(await store.getByJobId(fixture.job.jobId)).toMatchObject({
      effectiveSnapshotManifest: initial,
      effectiveSnapshotRevision: 0
    });
  });

  it("rejects a superseded execution fence and accepts only the current lease", async () => {
    const store = new MemoryQueryPlanStore();
    const initial = manifest();
    const fixture = context("query-fence", initial);
    await store.create(fixture);
    const staleFence = store.assignExecutionFence(fixture.job.jobId, "worker-old");
    const currentFence = store.assignExecutionFence(fixture.job.jobId, "worker-current");
    const next = manifest([resource("tracklet-a")]);

    await expect(store.commitNodeResult(fixture.job.jobId, completedNode(), {
      expectedManifestHash: initial.manifestHash,
      nextEffectiveManifest: next
    }, staleFence)).rejects.toMatchObject({
      code: "PROVIDER_NOT_READY",
      retryable: false
    });
    expect(await store.getByJobId(fixture.job.jobId)).toMatchObject({
      effectiveSnapshotManifest: initial,
      effectiveSnapshotRevision: 0,
      executionFence: currentFence
    });

    await store.commitNodeResult(fixture.job.jobId, completedNode(), {
      expectedManifestHash: initial.manifestHash,
      nextEffectiveManifest: next
    }, currentFence);
    expect(await store.getByJobId(fixture.job.jobId)).toMatchObject({
      effectiveSnapshotManifest: next,
      effectiveSnapshotRevision: 1,
      executionFence: currentFence
    });
  });

  it("rolls back the snapshot when node persistence fails during an atomic commit", async () => {
    const store = new MemoryQueryPlanStore();
    const initial = manifest();
    const fixture = context("query-atomic-failure", initial);
    await store.create(fixture);
    const nodesBefore = await store.listNodes(fixture.job.jobId);
    const invalidNode = {
      ...completedNode(),
      result: { uncloneable: () => undefined }
    } as unknown as WorldQueryResultNodeResult;

    await expect(store.commitNodeResult(fixture.job.jobId, invalidNode, {
      expectedManifestHash: initial.manifestHash,
      nextEffectiveManifest: manifest([resource("tracklet-a")])
    })).rejects.toThrow();

    expect(await store.listNodes(fixture.job.jobId)).toEqual(nodesBefore);
    expect(await store.getByJobId(fixture.job.jobId)).toMatchObject({
      effectiveSnapshotManifest: initial,
      effectiveSnapshotRevision: 0
    });
  });
});
