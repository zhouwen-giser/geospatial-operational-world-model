import { timingSafeEqual } from "node:crypto";
import pg from "pg";
import type { FastifyRequest } from "fastify";
import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import { PostgresAuditSink } from "./postgres-audit.js";
import { buildGatewayApp } from "./app.js";
import { ProviderCircuitBreaker } from "./circuit-breaker.js";
import type { GatewayServerConfig } from "./config.js";
import { DirectExecutionService } from "./direct-execution.js";
import { HttpProviderClient } from "./http-provider-client.js";
import { PostgresGatewayIdempotencyStore } from "./postgres-idempotency.js";
import { PostgresQueryPlanStore } from "./postgres-query-plan-store.js";
import { PostgresGatewayRecordStore } from "./postgres-records.js";
import { WorldQueryRuntime } from "./query-plan-runtime.js";
import { QueryPlanValidator } from "./query-plan-validation.js";
import { CapabilityRegistry } from "./registry.js";
import type { GatewayPrincipal } from "./types.js";
import { PostgresWorldQueryWorker } from "./world-query-worker.js";

export interface GatewayRuntime {
  app: ReturnType<typeof buildGatewayApp>;
  registry: CapabilityRegistry;
  pool: pg.Pool;
  worker: PostgresWorldQueryWorker;
  close(): Promise<void>;
}

export async function createGatewayRuntime(config: GatewayServerConfig): Promise<GatewayRuntime> {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    application_name: "gowm-capability-gateway",
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
  pool.on("error", () => process.stderr.write("gateway postgres pool error\n"));
  const registry = new CapabilityRegistry();
  try {
    for (const deployment of config.providers) {
      const client = new HttpProviderClient({
        endpoint: deployment.endpoint,
        providerId: deployment.providerId,
        providerVersion: deployment.providerVersion,
        implementationDigest: deployment.implementationDigest,
        manifestHash: deployment.manifestHash,
        approvedManifest: deployment.approvedManifest,
        transportToken: deployment.transportToken,
        allowPlaintextPrivateNetwork: deployment.allowPlaintextPrivateNetwork
      });
      const manifest = deployment.approvedManifest;
      registry.register({
        approvalId: deployment.approvalId,
        approved: true,
        endpoint: deployment.endpoint,
        allowPlaintextPrivateNetwork: deployment.allowPlaintextPrivateNetwork,
        client,
        manifest
      });
    }

    const records = new PostgresGatewayRecordStore(pool);
    const directExecution = new DirectExecutionService({
      registry,
      circuits: new ProviderCircuitBreaker(),
      idempotency: new PostgresGatewayIdempotencyStore(pool, {
        leaseOwner: `${config.gatewayId}:${process.pid}`
      }),
      audit: new PostgresAuditSink(pool),
      gatewayId: config.gatewayId,
      policyVersion: config.policyVersion,
      attestationIssuer: config.attestationIssuer,
      records
    });
    const queryStore = new PostgresQueryPlanStore(pool);
    const worldQueries = new WorldQueryRuntime({
      validator: new QueryPlanValidator(registry),
      directExecution,
      store: queryStore,
      autoRunAsync: false
    });
    const worker = new PostgresWorldQueryWorker(queryStore, worldQueries, {
      workerId: `gateway_worker_${sha256({ gatewayId: config.gatewayId, pid: process.pid }).slice("sha256:".length, "sha256:".length + 32)}`,
      leaseSeconds: config.queryWorkerLeaseSeconds,
      pollIntervalMs: config.queryWorkerPollMs,
      maximumClaimsPerTick: config.queryWorkerMaximumClaimsPerTick
    });
    const app = buildGatewayApp({
      registry,
      directExecution,
      authenticate: createStaticBearerAuthenticator(config),
      records,
      worldQueries,
      readiness: async () => {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2_000);
          timer.unref();
        });
        try {
          return await Promise.race([
            pool.query("SELECT 1 AS ready").then((result) => result.rowCount === 1),
            timeout
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
      logger: false
    });
    worker.start();
    return {
      app,
      registry,
      pool,
      worker,
      async close(): Promise<void> {
        await worker.stop();
        await Promise.allSettled([app.close(), pool.end()]);
      }
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

export function createStaticBearerAuthenticator(
  config: Pick<GatewayServerConfig, "sharedToken" | "principalRef" | "dataScopeClaim" | "datasetScopeClaim" | "allowExperimental">
): (request: FastifyRequest) => Promise<GatewayPrincipal> {
  const expected = Buffer.from(`Bearer ${config.sharedToken}`, "utf8");
  return async (request): Promise<GatewayPrincipal> => {
    const raw = request.headers.authorization;
    const supplied = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.alloc(0);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ProviderProtocolError("SCOPE_DENIED", "Gateway transport authentication failed");
    }
    return {
      principalRef: config.principalRef,
      authenticationMethod: "COMPOSE_SHARED_TOKEN",
      authenticatedAt: new Date().toISOString(),
      ...(config.dataScopeClaim === undefined ? {} : { dataScopeClaim: config.dataScopeClaim }),
      ...(config.datasetScopeClaim === undefined ? {} : { datasetScopeClaim: config.datasetScopeClaim }),
      allowExperimental: config.allowExperimental
    };
  };
}
