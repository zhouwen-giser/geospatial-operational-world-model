import { describe, expect, it, vi } from "vitest";

import { executeCoverageWorkerOnce } from "../../packages/road-coverage-runtime-core/src/index.js";
import type { CoverageAsyncRepository, CoverageClaim } from "../../packages/road-coverage-runtime-core/src/index.js";

const claim: CoverageClaim = {
  coverageRequestId: "10000000-0000-0000-0000-000000000001",
  coverageRunId: "20000000-0000-0000-0000-000000000001",
  generation: 1,
  leaseUntil: "2026-08-25T06:00:00.000Z"
};

function repository(events: string[], claimed: CoverageClaim | null = claim): CoverageAsyncRepository {
  return {
    claimNext: vi.fn(async () => {
      events.push("claim");
      return claimed;
    }),
    heartbeat: vi.fn(async (_claim, _owner, _seconds, stage) => {
      events.push(`heartbeat:${stage}`);
      return true;
    }),
    persistProblem: vi.fn(async () => {
      events.push("persist-problem");
      return "30000000-0000-0000-0000-000000000001";
    }),
    publishResult: vi.fn(async () => {
      events.push("publish-result");
      return true;
    })
  };
}

describe("coverage async worker", () => {
  it("computes between bounded repository statements and publishes only after persistence", async () => {
    const events: string[] = [];
    const result = await executeCoverageWorkerOnce(
      repository(events),
      { attempt: 1, leaseOwner: "worker-a", leaseSeconds: 30, maximumScopeConcurrency: 2 },
      async () => {
        events.push("compute");
        return {
          problemHash: `sha256:${"a".repeat(64)}`,
          canonicalProblem: { obligationSet: { obligations: [] } },
          result: {
            referenceKey: `wrf_${"1".repeat(32)}`,
            status: "SUCCEEDED",
            resultHash: `sha256:${"b".repeat(64)}`,
            validUntil: "2026-08-25T06:05:00.000Z",
            record: { alternatives: [] }
          }
        };
      }
    );

    expect(result).toBe("PUBLISHED");
    expect(events).toEqual([
      "claim",
      "heartbeat:BUILDING",
      "compute",
      "persist-problem",
      "heartbeat:PUBLISHING",
      "publish-result"
    ]);
  });

  it("returns idle without invoking compute when no request can be admitted", async () => {
    const events: string[] = [];
    const compute = vi.fn();
    await expect(executeCoverageWorkerOnce(
      repository(events, null),
      { attempt: 1, leaseOwner: "worker-idle", leaseSeconds: 30, maximumScopeConcurrency: 1 },
      compute
    )).resolves.toBe("IDLE");
    expect(compute).not.toHaveBeenCalled();
    expect(events).toEqual(["claim"]);
  });

  it("fails closed when a generation loses its lease before compute", async () => {
    const events: string[] = [];
    const runtime = repository(events);
    runtime.heartbeat = vi.fn(async () => false);
    await expect(executeCoverageWorkerOnce(
      runtime,
      { attempt: 1, leaseOwner: "worker-stale", leaseSeconds: 30, maximumScopeConcurrency: 1 },
      vi.fn()
    )).rejects.toThrow(/lost its lease before compute/u);
    expect(runtime.persistProblem).not.toHaveBeenCalled();
    expect(runtime.publishResult).not.toHaveBeenCalled();
  });
});
