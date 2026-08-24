import { describe, expect, it } from "vitest";
import type { CapabilityResultEnvelope } from "../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import {
  MemoryQueryPlanStore,
  QueryPlanValidator,
  WorldQueryRuntime,
  type GatewayIdempotencyScope,
  type GatewayIdempotencyStore,
  type IdempotentResult
} from "../../services/gateway/world-capability-gateway/src/index.js";
import { createElevationMockProvider } from "../../services/providers/elevation-mock/src/provider.js";
import {
  CountingProviderClient,
  createOpenObjectProvider,
  deferred,
  descriptorFor,
  gatewayHarness,
  gatewayRequest,
  oneNodeSubmission,
  principal,
  providerRequest
} from "./fixtures.js";

interface DurableEntry<T> {
  requestHash: string;
  value: T;
}

class RestartableIdempotencyStore<T> implements GatewayIdempotencyStore<T> {
  constructor(private readonly durable: Map<string, DurableEntry<T>>) {}

  async execute(
    scope: GatewayIdempotencyScope,
    idempotencyKey: string,
    request: unknown,
    action: () => Promise<T>
  ): Promise<IdempotentResult<T>> {
    const key = `${scope.principalHash}\u0000${scope.operationId}@${scope.operationVersion}\u0000${idempotencyKey}`;
    const requestHash = sha256(request);
    const existing = this.durable.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ProviderProtocolError("IDEMPOTENCY_CONFLICT", "durable idempotency key payload differs");
      }
      return { value: structuredClone(existing.value), replayed: true };
    }
    const value = await action();
    this.durable.set(key, { requestHash, value: structuredClone(value) });
    return { value, replayed: false };
  }
}

describe("P15 restart, idempotency, deadline, and cancellation races", () => {
  it("replays across new Gateway and Provider instances through a durable-store abstraction", async () => {
    const durable = new Map<string, DurableEntry<CapabilityResultEnvelope>>();
    const firstProvider = createElevationMockProvider({ elevationMeters: 10 });
    const firstClient = new CountingProviderClient(firstProvider);
    const firstGateway = gatewayHarness(
      firstClient,
      firstProvider.manifest,
      new RestartableIdempotencyStore(durable)
    );
    const descriptor = descriptorFor(firstProvider);
    const request = gatewayRequest(descriptor, { idempotencyKey: "restart-durable-key" });
    const first = await firstGateway.direct.execute(descriptor.operationId, request, principal());

    const restartedProvider = createElevationMockProvider({ elevationMeters: 999 });
    const restartedClient = new CountingProviderClient(restartedProvider);
    const restartedGateway = gatewayHarness(
      restartedClient,
      restartedProvider.manifest,
      new RestartableIdempotencyStore(durable)
    );
    const replay = await restartedGateway.direct.execute(
      descriptor.operationId,
      structuredClone(request),
      principal()
    );

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    expect(firstClient.executeCalls).toBe(1);
    expect(restartedClient.executeCalls).toBe(0);

    await expect(restartedGateway.direct.execute(
      descriptor.operationId,
      { ...request, input: { longitude: 117, latitude: 40 } },
      principal()
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("fails input budget before provider work and aborts a deadline race fail-closed", async () => {
    const release = deferred<void>();
    const open = createOpenObjectProvider({ delay: release });
    const request = providerRequest(open.descriptor, undefined, {
      input: { value: "sensitive-work" },
      idempotencyKey: "deadline-race"
    });
    request.executionPolicy.maximumInputBytes = 1;
    await expect(open.runtime.execute(request)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(open.calls.count).toBe(0);

    request.executionPolicy.maximumInputBytes = 4_096;
    const deadlineAt = new Date(Date.now() + 15).toISOString();
    request.executionPolicy.deadlineAt = deadlineAt;
    request.securityContext.scopeAttestation.expiresAt = deadlineAt;
    await expect(open.runtime.execute(request)).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(open.calls.count).toBe(1);
    release.resolve();
    await Promise.resolve();
  });

  it("lets cancellation win against one in-flight node and discards the late result", async () => {
    const release = deferred<void>();
    const open = createOpenObjectProvider({ delay: release });
    const client = new CountingProviderClient(open.runtime);
    const gateway = gatewayHarness(client, open.manifest);
    const store = new MemoryQueryPlanStore();
    const runtime = new WorldQueryRuntime({
      validator: new QueryPlanValidator(gateway.registry),
      directExecution: gateway.direct,
      store,
      autoRunAsync: false
    });
    const submission = oneNodeSubmission(open.descriptor, { value: 1 }, "query_cancel_race");
    const queued = await runtime.submit(submission, principal(), "ASYNC");
    const running = runtime.run(queued.job.jobId);
    await until(() => open.calls.count === 1);

    const cancellation = await runtime.cancel(submission.plan.queryId, principal());
    expect(cancellation?.status).toBe("RUNNING");
    release.resolve();
    const result = await running;
    const persisted = await runtime.get(submission.plan.queryId, principal());

    expect(result.status).toBe("CANCELLED");
    expect(result.outputs).toEqual({});
    expect(result.nodes).toEqual([
      expect.objectContaining({ nodeId: "nodeA", status: "CANCELLED", attempt: 1 })
    ]);
    expect(persisted?.status).toBe("CANCELLED");
  });

  it("resumes an idempotent queued job from a fresh runtime over the store abstraction", async () => {
    const open = createOpenObjectProvider();
    const client = new CountingProviderClient(open.runtime);
    const gateway = gatewayHarness(client, open.manifest);
    const store = new MemoryQueryPlanStore();
    const original = new WorldQueryRuntime({
      validator: new QueryPlanValidator(gateway.registry),
      directExecution: gateway.direct,
      store,
      autoRunAsync: false
    });
    const submission = oneNodeSubmission(open.descriptor, { value: 7 }, "query_runtime_restart");
    const queued = await original.submit(submission, principal(), "ASYNC");
    const restarted = new WorldQueryRuntime({
      validator: new QueryPlanValidator(gateway.registry),
      directExecution: gateway.direct,
      store,
      autoRunAsync: false
    });

    const result = await restarted.run(queued.job.jobId);
    const replay = await restarted.submit(structuredClone(submission), principal(), "ASYNC");
    expect(result.status).toBe("COMPLETED");
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(result);
    expect(client.executeCalls).toBe(1);
  });
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not observed before the bounded test deadline");
}
