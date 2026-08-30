import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type {
  GowmV07HistoricalTrajectoryQuery,
  ProviderExecutionRequest
} from "../../packages/platform/contract-runtime/src/index.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { buildHistoricalTraceApp } from "../../services/providers/historical-trace-provider/src/app.js";
import { loadHistoricalTraceConfig } from "../../services/providers/historical-trace-provider/src/config.js";
import { createHistoricalTraceProvider } from "../../services/providers/historical-trace-provider/src/provider.js";

const TOKEN = "historical-trace-test-token-with-at-least-32-bytes";
const NOW = "2026-08-30T10:00:00.000Z";
const input: GowmV07HistoricalTrajectoryQuery = {
  subjectReferenceKey: { namespace: "gowm", kind: "WORLD_OBJECT", id: "vehicle-2", version: "7" },
  executionIntervalReferenceKey: {
    namespace: "gowm",
    kind: "TASK_EXECUTION_INTERVAL",
    id: "interval-ref-1",
    version: "1"
  },
  phaseScope: "EXECUTION_ENVELOPE",
  sourceSelection: { mode: "ONLY_CANDIDATE" },
  sourceSelectionProfileReferenceKey: {
    namespace: "gowm",
    kind: "HISTORY_METHOD_PROFILE",
    id: "trajectory-single-authoritative-v1",
    version: "1.0"
  },
  maximumInlinePoints: 2
};

describe("historical trace Provider HTTP/bootstrap", () => {
  it("loads bounded server configuration without connecting or exposing credentials", async () => {
    const config = loadHistoricalTraceConfig({
      HISTORICAL_TRACE_DATABASE_URL: "postgresql://example.invalid/history",
      PROVIDER_TRANSPORT_SHARED_TOKEN: TOKEN
    });
    try {
      expect(config).toMatchObject({ host: "0.0.0.0", port: 8_100, transportToken: TOKEN });
    } finally {
      await config.close();
    }
    expect(() => loadHistoricalTraceConfig({
      HISTORICAL_TRACE_DATABASE_URL: "postgresql://example.invalid/history",
      PROVIDER_TRANSPORT_SHARED_TOKEN: TOKEN,
      HISTORICAL_TRACE_PORT: "0"
    })).toThrow("HISTORICAL_TRACE_PORT must be between 1 and 65535");
  });

  it("serves the standard authenticated protocol and binds scope before historical reads", async () => {
    const { pool, connect, directQuery, transactionQueries } = fakePool();
    const provider = createHistoricalTraceProvider({
      pool,
      now: () => new Date(NOW),
      receiptId: () => "history-http-receipt"
    });
    const app = buildHistoricalTraceApp(provider, TOKEN);
    const request = executionRequest(provider, "history-http-success");
    try {
      const manifest = await app.inject({ method: "GET", url: "/v1/manifest" });
      expect(manifest.statusCode).toBe(200);
      expect(manifest.json()).toMatchObject({
        provider: { providerId: "gowm.historical-trace", providerVersion: "0.7.1" },
        capabilities: [{ operationId: "history.get-trajectory" }]
      });
      expect(manifest.json().capabilities).toHaveLength(1);

      const live = await app.inject({ method: "GET", url: "/health/live" });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toMatchObject({ live: true, providerId: "gowm.historical-trace" });

      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({
        ready: true,
        providerId: "gowm.historical-trace",
        operationCount: 1,
        reasons: []
      });
      expect(directQuery).toHaveBeenCalledTimes(2);

      const denied = await app.inject({
        method: "POST",
        url: "/v1/operations/history.get-trajectory:execute",
        payload: request
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({
        error: { code: "SCOPE_DENIED", providerId: "gowm.historical-trace" }
      });
      expect(connect).not.toHaveBeenCalled();

      const mismatch = await app.inject({
        method: "POST",
        url: "/v1/operations/history.not-registered:execute",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: request
      });
      expect(mismatch.statusCode).toBe(422);
      expect(mismatch.json()).toMatchObject({
        error: { code: "SCHEMA_MISMATCH", stage: "REQUEST_VALIDATION" }
      });
      expect(connect).not.toHaveBeenCalled();

      const response = await app.inject({
        method: "POST",
        url: "/v1/operations/history.get-trajectory:execute",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          traceparent: "00-11111111111111111111111111111111-2222222222222222-01"
        },
        payload: request
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        providerProtocolVersion: "1.0",
        requestId: "history-http-success",
        operation: { operationId: "history.get-trajectory", operationVersion: "1.0" },
        status: "NO_DATA",
        output: { value: { status: "NO_DATA", reasonCode: "TASK_INTERVAL_UNAVAILABLE" } },
        execution: { providerId: "gowm.historical-trace", providerVersion: "0.7.1" }
      });
      expect(connect).toHaveBeenCalledOnce();
      expect(transactionQueries[0]?.sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(transactionQueries[1]).toEqual({
        sql: expect.stringContaining("gowm_history_v1.set_data_scope"),
        values: ["scope-a"]
      });
      expect(transactionQueries.some(({ sql }) => /provider|http|fetch|fusion/i.test(sql))).toBe(false);

      const job = await app.inject({ method: "GET", url: "/v1/jobs/not-supported" });
      expect(job.statusCode).toBe(404);
      expect(job.json()).toEqual({ error: "JOB_NOT_FOUND", jobId: "not-supported" });
    } finally {
      await app.close();
    }
  });

  it("reports database unavailability without leaking the underlying failure", async () => {
    const secret = "postgresql://secret-user:secret-password@example.invalid/history";
    const pool = {
      query: vi.fn(async () => { throw new Error(`connection refused: ${secret}`); }),
      connect: vi.fn(async () => { throw new Error(`connection refused: ${secret}`); })
    } as unknown as pg.Pool;
    const provider = createHistoricalTraceProvider({ pool, now: () => new Date(NOW) });
    const app = buildHistoricalTraceApp(provider, TOKEN);
    try {
      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({
        ready: false,
        providerId: "gowm.historical-trace",
        reasons: ["gowm_history_v1 historical trace read contract is unavailable"]
      });
      expect(ready.body).not.toContain(secret);

      const response = await app.inject({
        method: "POST",
        url: "/v1/operations/history.get-trajectory:execute",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: executionRequest(provider, "history-http-unavailable")
      });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          code: "PROVIDER_NOT_READY",
          message: "historical trace read pool is unavailable",
          retryable: true,
          providerId: "gowm.historical-trace"
        }
      });
      expect(response.body).not.toContain(secret);
    } finally {
      await app.close();
    }
  });
});

function executionRequest(
  provider: ReturnType<typeof createHistoricalTraceProvider>,
  requestId: string
): ProviderExecutionRequest {
  const descriptor = provider.runtime.manifest.capabilities[0];
  if (!descriptor) throw new Error("historical trace capability is unavailable");
  const effectiveSnapshot = {
    querySnapshotId: `snapshot-${requestId}`,
    mode: "LATEST_AT_START" as const,
    consistency: "CONSISTENT_AT_START" as const,
    capturedAt: NOW,
    resources: []
  };
  return {
    providerProtocolVersion: "1.0",
    requestId,
    gatewayRequestId: `gateway-${requestId}`,
    idempotencyKey: `idempotency-${requestId}`,
    operation: {
      operationId: descriptor.operationId,
      operationVersion: descriptor.operationVersion,
      inputSchemaHash: descriptor.inputSchemaHash,
      outputSchemaHash: descriptor.outputSchemaHash
    },
    input,
    securityContext: {
      principalRef: "principal:history-test",
      authenticationMethod: "TEST",
      authenticatedAt: "2026-08-30T09:59:00.000Z",
      dataScopeClaim: "scope-a",
      scopeAttestation: {
        issuer: "test",
        issuedAt: "2026-08-30T09:59:00.000Z",
        expiresAt: "2026-08-30T10:01:00.000Z",
        claimDigest: sha256({ dataScopeClaim: "scope-a" })
      }
    },
    gatewayContext: {
      gatewayId: "history-gateway",
      registryVersion: "v0.7.1",
      policyVersion: "v0.7.1"
    },
    effectiveSnapshot: { ...effectiveSnapshot, manifestHash: sha256(effectiveSnapshot) },
    executionPolicy: {
      deadlineAt: "2026-08-30T10:00:30.000Z",
      maximumInputBytes: 1_048_576,
      maximumResultBytes: 16_777_216,
      maximumRows: 1_000,
      maximumCandidates: 5_000,
      maximumCostClass: "MEDIUM"
    }
  };
}

function fakePool(): {
  pool: pg.Pool;
  connect: ReturnType<typeof vi.fn>;
  directQuery: ReturnType<typeof vi.fn>;
  transactionQueries: Array<{ sql: string; values?: readonly unknown[] }>;
} {
  const transactionQueries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      transactionQueries.push({ sql, ...(values === undefined ? {} : { values }) });
      return { rows: [], rowCount: 0 };
    },
    release() {}
  } as unknown as pg.PoolClient;
  const connect = vi.fn(async () => client);
  const directQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  return {
    pool: { connect, query: directQuery } as unknown as pg.Pool,
    connect,
    directQuery,
    transactionQueries
  };
}
