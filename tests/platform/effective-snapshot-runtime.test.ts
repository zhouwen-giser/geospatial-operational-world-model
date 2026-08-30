import { describe, expect, it } from "vitest";
import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  DataSnapshotContext,
  GowmV071QuerySnapshotManifest,
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
  MemoryQueryPlanStore,
  ProviderCircuitBreaker,
  QueryPlanValidator,
  WorldQueryRuntime,
  type GatewayPrincipal,
  type QueryExecutionFence
} from "../../services/gateway/world-capability-gateway/src/index.js";

const objectSchemaUri = "urn:gowm:v0.2:value:object";
const objectSchema = getContractSchema(objectSchemaUri);
const objectSchemaHash = getContractSchemaHash(objectSchemaUri);
const parameterSchemaHash = getContractSchemaHash("world-query-parameters.schema.json");
const trackletDigestV1 = sha256({ trackletId: "tracklet-1", version: "v1" });
const trackletDigestV2 = sha256({ trackletId: "tracklet-1", version: "v2" });
const trackletDigestB = sha256({ trackletId: "tracklet-2", version: "v1" });

const principal: GatewayPrincipal = {
  principalRef: "principal:effective-snapshot-runtime",
  authenticationMethod: "TEST_ATTESTED",
  authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
  dataScopeClaim: "scope-a",
  allowExperimental: true
};

type ResourceResolution = "DISCOVER_RESOURCES" | "REQUIRE_PINNED";
type ConsumerKind = "consumer" | "conflict";

interface Harness {
  descriptors: Record<"resolver" | "resolverB" | ConsumerKind, CapabilityDescriptor>;
  store: MemoryQueryPlanStore;
  direct: DirectExecutionService;
  runtime(): WorldQueryRuntime;
  observedResolverSnapshots: ProviderHandlerContext["snapshots"][];
  observedConsumerSnapshots: ProviderHandlerContext["snapshots"][];
  calls: Record<"resolver" | "resolverB" | ConsumerKind, number>;
}

function snapshot(version: "v1" | "v2", capturedAt: string, id = "tracklet-1"): DataSnapshotContext {
  return {
    consistency: "PINNED",
    capturedAt,
    scopeDigest: sha256({ dataScopeKey: "scope-a" }),
    resources: [{
      referenceKey: {
        namespace: "scope-a",
        kind: "TRACKLET_VERSION",
        id,
        version
      },
      authority: "gowm.effective-snapshot-fixture",
      pinning: "PINNED",
      digest: id === "tracklet-2" ? trackletDigestB : version === "v1" ? trackletDigestV1 : trackletDigestV2,
      worldVersion: version === "v1" ? 41 : 42
    }]
  };
}

function descriptor(operationId: string, resourceResolution: ResourceResolution): CapabilityDescriptor {
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
      defaultTimeoutMs: 1_000,
      maximumTimeoutMs: 5_000,
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

function createHarness(store: MemoryQueryPlanStore = new MemoryQueryPlanStore()): Harness {
  const descriptors = {
    resolver: descriptor("test.snapshot.resolver", "DISCOVER_RESOURCES"),
    resolverB: descriptor("test.snapshot.resolver-b", "DISCOVER_RESOURCES"),
    consumer: descriptor("test.snapshot.consumer", "REQUIRE_PINNED"),
    conflict: descriptor("test.snapshot.consumer-conflict", "REQUIRE_PINNED")
  };
  const observedResolverSnapshots: ProviderHandlerContext["snapshots"][] = [];
  const observedConsumerSnapshots: ProviderHandlerContext["snapshots"][] = [];
  const calls: Record<"resolver" | "resolverB" | ConsumerKind, number> = { resolver: 0, resolverB: 0, consumer: 0, conflict: 0 };

  const operations: ProviderOperation[] = [{
    descriptor: descriptors.resolver,
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    method: {
      engine: "snapshot-fixture",
      engineVersion: "1.0.0",
      methodId: "resolve-tracklet",
      methodVersion: "1.0"
    },
    async handle(input, context) {
      calls.resolver += 1;
      observedResolverSnapshots.push(structuredClone(context.snapshots));
      return {
        status: "COMPLETED",
        value: { ...input as Record<string, unknown>, resolvedTracklet: "tracklet-1" },
        dataSnapshot: snapshot("v1", context.snapshots.effective!.capturedAt),
        consumption: { rows: 1, candidates: 1 }
      };
    }
  }, {
    descriptor: descriptors.resolverB,
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    method: {
      engine: "snapshot-fixture",
      engineVersion: "1.0.0",
      methodId: "resolve-tracklet-b",
      methodVersion: "1.0"
    },
    async handle(input, context) {
      calls.resolverB += 1;
      observedResolverSnapshots.push(structuredClone(context.snapshots));
      return {
        status: "COMPLETED",
        value: { ...input as Record<string, unknown>, resolvedTracklet: "tracklet-2" },
        dataSnapshot: snapshot("v1", context.snapshots.effective!.capturedAt, "tracklet-2"),
        consumption: { rows: 1, candidates: 1 }
      };
    }
  }, {
    descriptor: descriptors.consumer,
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    method: {
      engine: "snapshot-fixture",
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
        dataSnapshot: snapshot("v1", context.snapshots.effective!.capturedAt),
        consumption: { rows: 1, candidates: 1 }
      };
    }
  }, {
    descriptor: descriptors.conflict,
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    method: {
      engine: "snapshot-fixture",
      engineVersion: "1.0.0",
      methodId: "consume-conflicting-tracklet",
      methodVersion: "1.0"
    },
    async handle(input, context) {
      calls.conflict += 1;
      observedConsumerSnapshots.push(structuredClone(context.snapshots));
      return {
        status: "COMPLETED",
        value: { ...input as Record<string, unknown>, consumedVersion: "v2" },
        dataSnapshot: snapshot("v2", context.snapshots.effective!.capturedAt),
        consumption: { rows: 1, candidates: 1 }
      };
    }
  }];

  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0",
    provider: {
      providerId: "gowm.effective-snapshot-fixture",
      providerVersion: "0.7.0",
      owner: "gowm-platform",
      implementationDigest: sha256({ fixture: "effective-snapshot-runtime", version: 1 })
    },
    endpoints: {
      manifest: "/v1/manifest",
      liveness: "/health/live",
      readiness: "/health/ready",
      execute: "/v1/operations/{operationId}:execute",
      job: "/v1/jobs/{jobId}"
    },
    capabilities: Object.values(descriptors)
  };
  const provider = createProviderRuntime({
    manifest,
    operations,
    policyVersion: "snapshot-fixture/1.0",
    policyDigest: sha256({ policy: "snapshot-fixture/1.0" })
  });
  const registry = new CapabilityRegistry();
  registry.register({
    approvalId: "approval-effective-snapshot-fixture",
    approved: true,
    endpoint: new URL("http://127.0.0.1:34700/"),
    client: new InProcessProviderClient(provider),
    manifest
  });
  const direct = new DirectExecutionService({
    registry,
    circuits: new ProviderCircuitBreaker(),
    idempotency: new MemoryGatewayIdempotencyStore(),
    audit: new MemoryAuditSink(),
    gatewayId: "gateway-effective-snapshot-test",
    policyVersion: "gateway-effective-snapshot-test/1.0",
    attestationIssuer: "gateway-effective-snapshot-test",
    records: new MemoryGatewayRecordStore()
  });

  return {
    descriptors,
    store,
    direct,
    runtime: () => new WorldQueryRuntime({
      validator: new QueryPlanValidator(registry),
      directExecution: direct,
      store,
      autoRunAsync: false
    }),
    observedResolverSnapshots,
    observedConsumerSnapshots,
    calls
  };
}

function operation(capability: CapabilityDescriptor) {
  return {
    operationId: capability.operationId,
    operationVersion: capability.operationVersion,
    inputSchemaHash: capability.inputSchemaHash,
    outputSchemaHash: capability.outputSchemaHash
  };
}

function port(capability: CapabilityDescriptor) {
  const value = capability.ports.inputs[0];
  if (!value) throw new Error("fixture port missing");
  return {
    schemaUri: value.schemaUri,
    schemaHash: value.schemaHash,
    valueKind: value.valueKind,
    unitSemantics: value.unitSemantics
  };
}

function node(
  nodeId: string,
  capability: CapabilityDescriptor,
  inputs: WorldQueryPlanV2Node["inputs"],
  failurePolicy: WorldQueryPlanV2Node["failurePolicy"] = "FAIL_FAST"
): WorldQueryPlanV2Node {
  return {
    nodeId,
    operation: operation(capability),
    inputs,
    failurePolicy,
    budget: {
      maximumRows: 10,
      maximumCandidates: 10,
      maximumOutputBytes: 16_384,
      maximumExecutionMs: 1_000
    }
  };
}

function submission(
  queryId: string,
  descriptors: Harness["descriptors"],
  consumer: ConsumerKind,
  mode: "LATEST_AT_START" | "BEST_EFFORT"
): WorldQuerySubmission {
  const resolver = node("resolver-a", descriptors.resolver, {
    request: {
      kind: "LITERAL",
      value: { taskId: "task-1" },
      port: port(descriptors.resolver)
    }
  });
  const consumerNode = node(
    consumer === "consumer" ? "consumer-b" : "consumer-conflict",
    descriptors[consumer],
    {
      request: {
        kind: "NODE_OUTPUT",
        nodeId: "resolver-a",
        outputPort: "result",
        port: port(descriptors[consumer])
      }
    },
    consumer === "conflict" && mode === "BEST_EFFORT" ? "ALLOW_PARTIAL" : "FAIL_FAST"
  );
  return {
    requestId: `request:${queryId}`,
    idempotencyKey: `idempotency:${queryId}`,
    parameterSchemaHash,
    parameters: {},
    snapshotPolicy: { mode, allowDowngrade: mode === "BEST_EFFORT" },
    plan: {
      queryPlanVersion: "2.0",
      queryId,
      nodes: [resolver, consumerNode],
      outputs: [{
        name: "answer",
        binding: {
          kind: "NODE_OUTPUT",
          nodeId: consumerNode.nodeId,
          outputPort: "result",
          port: port(descriptors[consumer])
        }
      }],
      budgets: {
        maximumNodes: 2,
        maximumDepth: 2,
        maximumRows: 20,
        maximumCandidates: 20,
        maximumOutputBytes: 32_768,
        maximumExecutionMs: 2_000
      }
    }
  };
}

function twoResolverSubmission(queryId: string, descriptors: Harness["descriptors"]): WorldQuerySubmission {
  const resolverA = node("resolver-a", descriptors.resolver, {
    request: { kind: "LITERAL", value: { taskId: "task-a" }, port: port(descriptors.resolver) }
  });
  const resolverB = node("resolver-b", descriptors.resolverB, {
    request: { kind: "LITERAL", value: { taskId: "task-b" }, port: port(descriptors.resolverB) }
  });
  return {
    requestId: `request:${queryId}`,
    idempotencyKey: `idempotency:${queryId}`,
    parameterSchemaHash,
    parameters: {},
    snapshotPolicy: { mode: "LATEST_AT_START", allowDowngrade: false },
    plan: {
      queryPlanVersion: "2.0",
      queryId,
      nodes: [resolverA, resolverB],
      outputs: [{
        name: "answer",
        binding: { kind: "NODE_OUTPUT", nodeId: "resolver-b", outputPort: "result", port: port(descriptors.resolverB) }
      }],
      budgets: {
        maximumNodes: 2,
        maximumDepth: 1,
        maximumRows: 20,
        maximumCandidates: 20,
        maximumOutputBytes: 32_768,
        maximumExecutionMs: 2_000
      }
    }
  };
}

function expectedEffectiveResource() {
  return {
    resourceKind: "TRACKLET_VERSION",
    resourceId: "scope-a:tracklet-1",
    version: "v1",
    contentHash: trackletDigestV1,
    worldVersion: 41,
    pinning: "PINNED"
  } as const;
}

function expectExactConsumerPin(observed: ProviderHandlerContext["snapshots"] | undefined): void {
  expect(observed?.requested?.resources).toEqual([]);
  expect(observed?.effective?.resources).toEqual([expectedEffectiveResource()]);
  expect(observed?.effective?.manifestHash).not.toBe(observed?.requested?.manifestHash);
}

class InterruptAfterResolverCommitStore extends MemoryQueryPlanStore {
  #interrupted = false;

  override async commitNodeResult(
    jobId: string,
    result: WorldQueryResultNodeResult,
    snapshotUpdate?: {
      expectedManifestHash: GowmV071QuerySnapshotManifest["manifestHash"];
      nextEffectiveManifest: GowmV071QuerySnapshotManifest;
    },
    fence?: QueryExecutionFence
  ): Promise<void> {
    await super.commitNodeResult(jobId, result, snapshotUpdate, fence);
    if (!this.#interrupted && result.nodeId === "resolver-a" && result.status === "COMPLETED" && snapshotUpdate !== undefined) {
      this.#interrupted = true;
      throw workerSuperseded();
    }
  }

  override async putNode(
    jobId: string,
    result: WorldQueryResultNodeResult,
    fence?: QueryExecutionFence
  ): Promise<void> {
    if (this.#interrupted && result.nodeId === "resolver-a" && result.status === "FAILED") {
      throw workerSuperseded();
    }
    await super.putNode(jobId, result, fence);
  }
}

class RejectBeforeResolverCommitStore extends MemoryQueryPlanStore {
  #rejected = false;

  override async commitNodeResult(
    jobId: string,
    result: WorldQueryResultNodeResult,
    snapshotUpdate?: {
      expectedManifestHash: GowmV071QuerySnapshotManifest["manifestHash"];
      nextEffectiveManifest: GowmV071QuerySnapshotManifest;
    },
    fence?: QueryExecutionFence
  ): Promise<void> {
    if (!this.#rejected && result.nodeId === "resolver-a" && result.status === "COMPLETED" && snapshotUpdate !== undefined) {
      this.#rejected = true;
      throw new ProviderProtocolError("PROVIDER_NOT_READY", "fixture transaction was unavailable", { retryable: true });
    }
    await super.commitNodeResult(jobId, result, snapshotUpdate, fence);
  }
}

function workerSuperseded(): ProviderProtocolError {
  return new ProviderProtocolError("PROVIDER_NOT_READY", "fixture worker lease was superseded", {
    retryable: false,
    details: { stage: "EXECUTION_FENCE" }
  });
}

describe("v0.7 effective snapshot World Query runtime", () => {
  it("persists node-local adherence for two providers with distinct resources", async () => {
    const test = createHarness();
    const runtime = test.runtime();
    const executed = await runtime.submit(
      twoResolverSubmission("query-effective-two-provider", test.descriptors),
      principal
    );

    expect(executed.result?.status).toBe("COMPLETED");
    expect(executed.result?.effectiveSnapshotManifest?.resources.map((resource) => resource.resourceId)).toEqual([
      "scope-a:tracklet-1",
      "scope-a:tracklet-2"
    ]);
    expect(executed.result?.snapshotAdherence).toEqual([
      expect.objectContaining({ nodeId: "resolver-a", status: "MATCHED" }),
      expect.objectContaining({ nodeId: "resolver-b", status: "MATCHED" })
    ]);
    expect(executed.result?.nodes).toEqual([
      expect.objectContaining({
        nodeId: "resolver-a",
        snapshotAdherence: expect.objectContaining({ status: "MATCHED" }),
        effectiveSnapshotRevisionBefore: 0,
        effectiveSnapshotRevisionAfter: 1,
        observedSnapshotResourceIdentities: ['["TRACKLET_VERSION","scope-a:tracklet-1"]']
      }),
      expect.objectContaining({
        nodeId: "resolver-b",
        snapshotAdherence: expect.objectContaining({ status: "MATCHED" }),
        effectiveSnapshotRevisionBefore: 1,
        effectiveSnapshotRevisionAfter: 2,
        observedSnapshotResourceIdentities: ['["TRACKLET_VERSION","scope-a:tracklet-2"]']
      })
    ]);

    const persistedBeforeRestart = await test.store.listNodes(executed.job.jobId);
    const recovered = await test.runtime().run(executed.job.jobId);
    expect(recovered.snapshotAdherence).toEqual(executed.result?.snapshotAdherence);
    expect(await test.store.listNodes(executed.job.jobId)).toEqual(persistedBeforeRestart);
  });

  it("discovers a tracklet, passes the exact effective pin downstream, and binds it into the final result hash", async () => {
    const test = createHarness();
    const executed = await test.runtime().submit(
      submission("query-effective-success", test.descriptors, "consumer", "LATEST_AT_START"),
      principal
    );

    expect(test.observedResolverSnapshots[0]?.requested?.resources).toEqual([]);
    expect(test.observedResolverSnapshots[0]?.effective?.resources).toEqual([]);
    expectExactConsumerPin(test.observedConsumerSnapshots[0]);
    expect(executed.result).toMatchObject({
      status: "COMPLETED",
      requestedSnapshotManifest: { resources: [] },
      effectiveSnapshotManifest: { resources: [expectedEffectiveResource()] },
      snapshotManifest: { resources: [expectedEffectiveResource()] },
      outputs: { answer: { resolvedTracklet: "tracklet-1", consumedVersion: "v1" } }
    });
    expect(executed.result?.snapshotManifest).toEqual(executed.result?.effectiveSnapshotManifest);
    expect(executed.result?.outputHash).toBe(sha256({
      outputs: executed.result?.outputs,
      effectiveSnapshotManifest: executed.result?.effectiveSnapshotManifest
    }));
    expect((await test.store.getByJobId(executed.job.jobId))?.effectiveSnapshotRevision).toBe(1);
    expect(test.calls).toEqual({ resolver: 1, resolverB: 0, consumer: 1, conflict: 0 });
  });

  it("fails closed on a strict consumer version conflict without changing the discovered pin", async () => {
    const test = createHarness();
    const executed = await test.runtime().submit(
      submission("query-effective-strict-conflict", test.descriptors, "conflict", "LATEST_AT_START"),
      principal
    );

    expectExactConsumerPin(test.observedConsumerSnapshots[0]);
    expect(executed.result?.status).toBe("FAILED");
    expect(executed.result?.effectiveSnapshotManifest?.resources).toEqual([expectedEffectiveResource()]);
    expect(executed.result?.nodes.find((entry) => entry.nodeId === "resolver-a")).toMatchObject({
      nodeId: "resolver-a",
      status: "COMPLETED",
      snapshotAdherence: { status: "MATCHED" },
      effectiveSnapshotRevisionBefore: 0,
      effectiveSnapshotRevisionAfter: 1
    });
    expect(executed.result?.nodes.find((entry) => entry.nodeId === "consumer-conflict")).toMatchObject({
      nodeId: "consumer-conflict",
      status: "FAILED",
      error: { error: { code: "SCHEMA_MISMATCH" } }
    });
    expect((await test.store.getByJobId(executed.job.jobId))?.effectiveSnapshotRevision).toBe(1);
    expect(test.calls).toEqual({ resolver: 1, resolverB: 0, consumer: 0, conflict: 1 });
  });

  it("keeps the prior pin and reports PARTIAL/MISMATCHED for a BEST_EFFORT conflict", async () => {
    const test = createHarness();
    const executed = await test.runtime().submit(
      submission("query-effective-best-effort", test.descriptors, "conflict", "BEST_EFFORT"),
      principal
    );

    expectExactConsumerPin(test.observedConsumerSnapshots[0]);
    expect(executed.result).toMatchObject({
      status: "PARTIAL",
      effectiveSnapshotManifest: { resources: [expectedEffectiveResource()] },
      nodes: expect.arrayContaining([expect.objectContaining({ nodeId: "consumer-conflict", status: "PARTIAL" })]),
      snapshotAdherence: expect.arrayContaining([expect.objectContaining({
        nodeId: "consumer-conflict",
        status: "MISMATCHED",
        mismatches: [expect.objectContaining({
          resourceKind: "TRACKLET_VERSION",
          resourceId: "scope-a:tracklet-1",
          expectedVersion: "v1",
          actualVersion: "v2",
          reason: "VERSION_MISMATCH"
        })]
      })])
    });
    expect(executed.result?.warnings.some((warning) => warning.includes("retained prior effective pin"))).toBe(true);
    expect((await test.store.getByJobId(executed.job.jobId))?.effectiveSnapshotRevision).toBe(1);
  });

  it("resumes an async plan in a new runtime from the effective snapshot persisted with the Resolver node", async () => {
    const store = new InterruptAfterResolverCommitStore();
    const test = createHarness(store);
    const request = submission("query-effective-restart", test.descriptors, "consumer", "LATEST_AT_START");
    const firstRuntime = test.runtime();
    const queued = await firstRuntime.submit(request, principal, "ASYNC");
    const initiallyPersisted = await store.getByJobId(queued.job.jobId);

    expect(initiallyPersisted?.requestedSnapshotManifest.resources).toEqual([]);
    expect(initiallyPersisted?.effectiveSnapshotManifest.resources).toEqual([]);
    await expect(firstRuntime.run(queued.job.jobId)).rejects.toMatchObject({
      code: "PROVIDER_NOT_READY",
      details: { stage: "EXECUTION_FENCE" }
    });

    const interrupted = await store.getByJobId(queued.job.jobId);
    const interruptedNodes = await store.listNodes(queued.job.jobId);
    expect(interrupted).toMatchObject({
      job: { status: "RUNNING" },
      effectiveSnapshotRevision: 1,
      effectiveSnapshotManifest: { resources: [expectedEffectiveResource()] }
    });
    expect(interruptedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "resolver-a", status: "COMPLETED" }),
      expect.objectContaining({ nodeId: "consumer-b", status: "QUEUED" })
    ]));

    const result = await test.runtime().run(queued.job.jobId);
    expect(result.status).toBe("COMPLETED");
    expectExactConsumerPin(test.observedConsumerSnapshots[0]);
    expect(result.effectiveSnapshotManifest).toBeDefined();
    expect(result.effectiveSnapshotManifest!.resources).toEqual([expectedEffectiveResource()]);
    expect((await store.getByJobId(queued.job.jobId))?.effectiveSnapshotRevision).toBe(1);
    expect(test.calls).toEqual({ resolver: 1, resolverB: 0, consumer: 1, conflict: 0 });
  });

  it("does not persist a candidate snapshot revision when Gateway output validation fails", async () => {
    const test = createHarness();
    const originalExecute = test.direct.execute.bind(test.direct);
    test.direct.execute = async (...arguments_) => {
      const executed = await originalExecute(...arguments_);
      if (executed.result.output === undefined) throw new Error("fixture provider output is missing");
      return {
        ...executed,
        result: {
          ...executed.result,
          output: { ...executed.result.output, value: "not-an-object" }
        }
      };
    };
    const executed = await test.runtime().submit(
      submission("query-invalid-output-snapshot-atomicity", test.descriptors, "consumer", "LATEST_AT_START"),
      principal
    );
    const failed = executed.result?.nodes.find((entry) => entry.nodeId === "resolver-a");
    const persisted = await test.store.getByJobId(executed.job.jobId);

    expect(executed.result?.status).toBe("FAILED");
    expect(persisted?.effectiveSnapshotRevision).toBe(0);
    expect(persisted?.effectiveSnapshotManifest.resources).toEqual([]);
    expect(failed).toMatchObject({
      status: "FAILED",
      effectiveSnapshotBeforeHash: persisted?.effectiveSnapshotManifest.manifestHash,
      effectiveSnapshotAfterHash: persisted?.effectiveSnapshotManifest.manifestHash,
      effectiveSnapshotRevisionBefore: 0,
      effectiveSnapshotRevisionAfter: 0,
      observedSnapshotResourceIdentities: ['["TRACKLET_VERSION","scope-a:tracklet-1"]']
    });
  });

  it("retries from persisted state when the atomic node and snapshot commit is unavailable", async () => {
    const store = new RejectBeforeResolverCommitStore();
    const test = createHarness(store);
    const request = submission("query-snapshot-commit-retry", test.descriptors, "consumer", "LATEST_AT_START");
    const queued = await test.runtime().submit(request, principal, "ASYNC");

    await expect(test.runtime().run(queued.job.jobId)).rejects.toMatchObject({ code: "PROVIDER_NOT_READY" });
    expect(await store.getByJobId(queued.job.jobId)).toMatchObject({
      effectiveSnapshotRevision: 0,
      effectiveSnapshotManifest: { resources: [] }
    });
    const interruptedResolver = (await store.listNodes(queued.job.jobId))
      .find((entry) => entry.nodeId === "resolver-a");
    expect(interruptedResolver).toMatchObject({ nodeId: "resolver-a", status: "RUNNING" });
    expect(interruptedResolver).not.toHaveProperty("effectiveSnapshotRevisionAfter");

    const recovered = await test.runtime().run(queued.job.jobId);
    expect(recovered.status).toBe("COMPLETED");
    expect(await store.getByJobId(queued.job.jobId)).toMatchObject({
      effectiveSnapshotRevision: 1,
      effectiveSnapshotManifest: { resources: [expectedEffectiveResource()] }
    });
    expect((await store.listNodes(queued.job.jobId)).find((entry) => entry.nodeId === "resolver-a")).toMatchObject({
      status: "COMPLETED",
      effectiveSnapshotRevisionBefore: 0,
      effectiveSnapshotRevisionAfter: 1
    });
  });
});
