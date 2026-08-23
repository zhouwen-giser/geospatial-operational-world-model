import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityProviderManifest,
  ProviderExecutionRequest
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  ProviderProtocolError,
  sha256
} from "../../packages/platform/provider-sdk/src/index.js";
import { MemoryAuditSink } from "../../services/gateway/world-capability-gateway/src/audit.js";
import { buildGatewayApp } from "../../services/gateway/world-capability-gateway/src/app.js";
import { ProviderCircuitBreaker } from "../../services/gateway/world-capability-gateway/src/circuit-breaker.js";
import {
  loadGatewayServerConfig,
  parseControlledProviderRegistryDocument
} from "../../services/gateway/world-capability-gateway/src/config.js";
import { DirectExecutionService } from "../../services/gateway/world-capability-gateway/src/direct-execution.js";
import { HttpProviderClient, controlledProviderUrl } from "../../services/gateway/world-capability-gateway/src/http-provider-client.js";
import { MemoryGatewayIdempotencyStore } from "../../services/gateway/world-capability-gateway/src/idempotency.js";
import { principalContextHash } from "../../services/gateway/world-capability-gateway/src/principal-context.js";
import { synchronizePostgresRegistry } from "../../services/gateway/world-capability-gateway/src/postgres-registry.js";
import { WorldQueryRuntime } from "../../services/gateway/world-capability-gateway/src/query-plan-runtime.js";
import { MemoryQueryPlanStore, type QueryJobContext } from "../../services/gateway/world-capability-gateway/src/query-plan-store.js";
import { assertControlledProviderEndpoint, CapabilityRegistry } from "../../services/gateway/world-capability-gateway/src/registry.js";
import type { GatewayPrincipal, ProviderClient } from "../../services/gateway/world-capability-gateway/src/types.js";
import { PostgresWorldQueryWorker } from "../../services/gateway/world-capability-gateway/src/world-query-worker.js";

const PROVIDER_TOKEN = "test-provider-transport-token-32-bytes-minimum";
const GATEWAY_TOKEN = "test-gateway-client-token-32-bytes-minimum";
const REGISTRY_PATH = resolve("config/capability-gateway-registry.json");
const MANIFEST_DIRECTORY = resolve("contracts/manifests/providers");

describe("P16 controlled production configuration", () => {
  it("loads six canonical manifests from strict repo-relative paths and verifies every identity/hash lock", async () => {
    const config = await loadGatewayServerConfig(gatewayEnv(REGISTRY_PATH));
    expect(config.providers).toHaveLength(6);
    expect(new Set(config.providers.map(({ transportToken }) => transportToken)).size).toBe(6);
    for (const deployment of config.providers) {
      expect(deployment.manifestPath).toMatch(/^contracts\/manifests\/providers\/[a-z0-9][a-z0-9.-]*-provider\.json$/u);
      expect(deployment.approvedManifest.provider.providerId).toBe(deployment.providerId);
      expect(sha256(deployment.approvedManifest)).toBe(deployment.manifestHash);
    }
  });

  it("rejects absolute/traversing/unknown manifest locations before filesystem access", async () => {
    const source = JSON.parse(await readFile(REGISTRY_PATH, "utf8")) as { providers: Array<Record<string, unknown>> };
    for (const malicious of [
      "../provider.json",
      "C:/provider.json",
      "contracts/manifests/providers/../provider.json",
      "config/provider-manifests/provider.json"
    ]) {
      const candidate = structuredClone(source);
      candidate.providers[0]!.manifestPath = malicious;
      expect(() => parseControlledProviderRegistryDocument(candidate)).toThrow(/manifestPath/u);
    }
  });

  it("loads from a packaged filesystem layout without Docker and the image copies canonical contracts", async () => {
    const packagedRoot = await mkdtemp(join(tmpdir(), "gowm-p16-package-"));
    try {
      await mkdir(join(packagedRoot, "config"), { recursive: true });
      await mkdir(join(packagedRoot, "contracts", "manifests", "providers"), { recursive: true });
      await copyFile(REGISTRY_PATH, join(packagedRoot, "config", "capability-gateway-registry.json"));
      const registry = JSON.parse(await readFile(REGISTRY_PATH, "utf8")) as { providers: Array<{ manifestPath: string }> };
      for (const provider of registry.providers) {
        await copyFile(resolve(provider.manifestPath), join(packagedRoot, provider.manifestPath));
      }
      const loaded = await loadGatewayServerConfig(gatewayEnv(join(packagedRoot, "config", "capability-gateway-registry.json")));
      expect(loaded.providers).toHaveLength(6);
      expect(await readFile("services/gateway/world-capability-gateway/Dockerfile", "utf8")).toContain("COPY contracts ./contracts");
    } finally {
      await rm(packagedRoot, { recursive: true, force: true });
    }
  });

  it("Registry one-shot reconciliation disables removed Providers before enabling the approved set", async () => {
    const config = await loadGatewayServerConfig(gatewayEnv(REGISTRY_PATH));
    const statements: string[] = [];
    const client = {
      async query(text: string) { statements.push(text); return { rows: [], rowCount: 0 }; },
      release() {}
    };
    await synchronizePostgresRegistry({ async connect() { return client; } } as never, [{
      config: config.providers[0]!,
      manifest: config.providers[0]!.approvedManifest
    }]);
    const operationDisable = statements.find((text) => text.includes("UPDATE gowm_capability.provider_operation SET enabled=false"));
    const providerDisable = statements.find((text) => text.includes("UPDATE gowm_capability.provider_registry SET enabled=false"));
    expect(operationDisable).toContain("WHERE enabled=true");
    expect(providerDisable).toContain("WHERE enabled=true");
    expect(`${operationDisable}${providerDisable}`).not.toContain("ANY(");
  });

  it("requires explicit internal-cleartext attestation and rejects non-container origins", () => {
    expect(() => assertControlledProviderEndpoint(new URL("http://provider:8080"))).toThrow();
    expect(() => assertControlledProviderEndpoint(new URL("http://provider:8080"), true)).not.toThrow();
    for (const endpoint of [
      "http://provider.internal:8080",
      "http://10.0.0.2:8080",
      "http://user@provider:8080",
      "http://provider:8080/?x=1",
      "ftp://provider:8080"
    ]) expect(() => assertControlledProviderEndpoint(new URL(endpoint), true)).toThrow();
  });
});

describe("P16 HTTP Provider client boundaries", () => {
  it("rejects schema-valid but semantically ambiguous approved output selectors before transport", async () => {
    const manifest = await canonicalManifest("crs-provider.json");
    const duplicate = structuredClone(manifest.capabilities[0]!);
    duplicate.maturity = duplicate.maturity === "STABLE" ? "PREVIEW" : "STABLE";
    manifest.capabilities.push(duplicate);
    expect(() => httpClient(manifest, vi.fn<typeof globalThis.fetch>())).toThrow();
  });

  it("keeps every route on the approved origin and rejects scheme-relative, query, fragment, absolute, and backslash routes", () => {
    const endpoint = new URL("https://provider.example");
    expect(controlledProviderUrl(endpoint, "/health/live").toString()).toBe("https://provider.example/health/live");
    for (const path of [
      "//evil.example/path",
      "/\\evil.example/path",
      "/path?redirect=https://evil.example",
      "/path#fragment",
      "https://evil.example/path",
      "relative/path"
    ]) expect(() => controlledProviderUrl(endpoint, path)).toThrowError(ProviderProtocolError);
  });

  it("does not issue a request for an unsafe manifestPath", async () => {
    const manifest = await canonicalManifest("h3-analysis-provider.json");
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = httpClient(manifest, fetch, { manifestPath: "//evil.example/manifest" });
    await expectCode(client.execute(manifest.capabilities[0]!.operationId, providerRequest()), "SCHEMA_MISMATCH");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malicious manifest-supplied liveness and execute routes without changing origin", async () => {
    const base = await canonicalManifest("h3-analysis-provider.json");
    const malicious = structuredClone(base);
    malicious.endpoints.liveness = "//evil.example/live";
    malicious.endpoints.execute = "//evil.example/{operationId}";
    const seen: URL[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      seen.push(url);
      return jsonResponse(malicious);
    };
    const client = httpClient(malicious, fetch);
    expect((await client.health()).ready).toBe(false);
    await expectCode(client.execute(malicious.capabilities[0]!.operationId, providerRequest()), "SCHEMA_MISMATCH");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((url) => url.origin === "https://provider.example")).toBe(true);
  });

  it("sends the deployment-only Bearer token, forbids redirects, and never accepts a caller URL", async () => {
    const manifest = await canonicalManifest("h3-analysis-provider.json");
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.pathname === "/v1/manifest") return jsonResponse(manifest);
      return jsonResponse({ error: { code: "OVERLOADED" } }, 429);
    };
    const client = httpClient(manifest, fetch);
    await expectCode(client.execute(manifest.capabilities[0]!.operationId, providerRequest()), "OVERLOADED");
    expect(calls.every(({ url }) => url.origin === "https://provider.example")).toBe(true);
    expect(calls.every(({ init }) => init?.redirect === "error")).toBe(true);
    const execute = calls.find(({ url }) => url.pathname.includes(":execute"));
    expect(new Headers(execute?.init?.headers).get("authorization")).toBe(`Bearer ${PROVIDER_TOKEN}`);
  });

  it("keeps delayed live-manifest and response bodies inside the caller deadline", async () => {
    const manifest = await canonicalManifest("h3-analysis-provider.json");
    for (const delayedPath of ["/v1/manifest", `/v1/operations/${manifest.capabilities[0]!.operationId}:execute`]) {
      const fetch: typeof globalThis.fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        if (path !== delayedPath) return jsonResponse(manifest);
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          headers: { "content-type": "application/json" }
        });
      };
      const client = httpClient(manifest, fetch, { controlTimeoutMs: 5_000 });
      const started = Date.now();
      await expectCode(client.execute(
        manifest.capabilities[0]!.operationId,
        providerRequest(new Date(Date.now() + 60).toISOString())
      ), "DEADLINE_EXCEEDED");
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });

  it("streams and cancels oversized chunked responses without relying on Content-Length", async () => {
    const manifest = await canonicalManifest("h3-analysis-provider.json");
    let cancelled = false;
    const fetch: typeof globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/manifest") return jsonResponse(manifest);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(12_000));
        },
        cancel() { cancelled = true; }
      }), { headers: { "content-type": "application/json" } });
    };
    const client = httpClient(manifest, fetch, { maximumResponseBytes: 10_000 });
    await expectCode(client.execute(manifest.capabilities[0]!.operationId, providerRequest()), "BUDGET_EXCEEDED");
    expect(cancelled).toBe(true);
  });
});

describe("P16 failure isolation, authorization identity, and restart worker", () => {
  it("registers canonical routes without live endpoints, reports one Provider degraded, and executes an unrelated route", async () => {
    const goodManifest = await canonicalManifest("h3-analysis-provider.json");
    const downManifest = await canonicalManifest("gowm-situation-provider.json");
    const good = fixtureClient(goodManifest, true);
    const down = fixtureClient(downManifest, false);
    const registry = new CapabilityRegistry();
    registry.register(binding(goodManifest, good, "https://good.example"));
    registry.register(binding(downManifest, down, "https://down.example"));
    const direct = {
      async execute(operationId: string, request: { operationVersion: string }) {
        const route = registry.resolve(operationId, request.operationVersion);
        const health = await route.client.health();
        if (!health.ready) throw new ProviderProtocolError("PROVIDER_NOT_READY", "selected Provider is unavailable");
        return { result: await route.client.execute(operationId, providerRequest()) as never, replayed: false };
      }
    };
    const app = buildGatewayApp({
      registry,
      directExecution: direct as never,
      authenticate: async () => principal("scope-a"),
      readiness: async () => true
    });
    try {
      expect((await app.inject({ method: "GET", url: "/v1/capabilities" })).json().capabilities).toHaveLength(
        goodManifest.capabilities.length + downManifest.capabilities.length
      );
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json()).toMatchObject({ status: "degraded", providers: { [down.providerId]: { ready: false } } });
      expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
      const goodResponse = await app.inject({
        method: "POST",
        url: `/v1/operations/${goodManifest.capabilities[0]!.operationId}:execute`,
        payload: { operationVersion: "1.0" }
      });
      expect(goodResponse.statusCode).toBe(200);
      const downResponse = await app.inject({
        method: "POST",
        url: `/v1/operations/${downManifest.capabilities[0]!.operationId}:execute`,
        payload: { operationVersion: "1.0" }
      });
      expect(downResponse.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("keeps DB readiness separate from process liveness and Provider degradation", async () => {
    const app = buildGatewayApp({
      registry: new CapabilityRegistry(),
      directExecution: {} as never,
      authenticate: async () => principal("scope-a"),
      readiness: async () => false
    });
    try {
      expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("bounds delayed health by the caller deadline and records the failure in only that Provider circuit", async () => {
    const manifest = await canonicalManifest("h3-analysis-provider.json");
    const client: ProviderClient = {
      providerId: manifest.provider.providerId,
      async manifest() { return structuredClone(manifest); },
      async health() { return new Promise(() => undefined); },
      async execute() { throw new Error("must not execute"); }
    };
    const registry = new CapabilityRegistry();
    registry.register(binding(manifest, client, "https://slow.example"));
    const circuits = new ProviderCircuitBreaker(1, 60_000);
    const service = new DirectExecutionService({
      registry,
      circuits,
      idempotency: new MemoryGatewayIdempotencyStore(),
      audit: new MemoryAuditSink(),
      gatewayId: "gateway-test",
      policyVersion: "policy-test",
      attestationIssuer: "gateway-test"
    });
    const descriptor = manifest.capabilities[0]!;
    const started = Date.now();
    await expectCode(service.execute(descriptor.operationId, {
      requestVersion: "1.0",
      requestId: "request_deadline",
      idempotencyKey: "deadline-key",
      operationVersion: descriptor.operationVersion,
      inputSchemaHash: descriptor.inputSchemaHash,
      outputSchemaHash: descriptor.outputSchemaHash,
      input: {},
      executionPolicy: {
        deadlineAt: new Date(Date.now() + 60).toISOString(),
        maximumResultBytes: Math.min(descriptor.limits.maximumOutputBytes ?? 1024, 1024),
        maximumCostClass: descriptor.execution.costClass,
        preferredExecution: "SYNC"
      }
    }, principal("scope-a")), "DEADLINE_EXCEEDED");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(circuits.state(client.providerId)).toMatchObject({ state: "OPEN", failures: 1 });
    expect(circuits.state("unrelated.provider")).toMatchObject({ state: "CLOSED", failures: 0 });
  });

  it("does not open a Provider circuit for caller/policy failures", async () => {
    const circuits = new ProviderCircuitBreaker(1, 60_000);
    await expectCode(circuits.execute("provider-a", async () => {
      throw new ProviderProtocolError("INVALID_REQUEST", "caller input is invalid");
    }), "INVALID_REQUEST");
    await expectCode(circuits.execute("provider-a", async () => {
      throw new ProviderProtocolError("SCOPE_DENIED", "caller scope is denied");
    }), "SCOPE_DENIED");
    expect(circuits.state("provider-a")).toMatchObject({ state: "CLOSED", failures: 0 });
  });

  it("does not execute a world query whose persisted submission-time budget expired in the queue", async () => {
    const context = queryContext(principal("scope-a"));
    context.job.createdAt = new Date(Date.now() - 2_000).toISOString();
    context.job.updatedAt = context.job.createdAt;
    const store = new MemoryQueryPlanStore();
    await store.create(context);
    const validate = vi.fn();
    const execute = vi.fn();
    const runtime = new WorldQueryRuntime({
      validator: { validate } as never,
      directExecution: { execute } as never,
      store
    });
    await expectCode(runtime.run(context.job.jobId), "DEADLINE_EXCEEDED");
    expect(validate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect((await store.getByJobId(context.job.jobId))?.job.status).toBe("FAILED");
  });

  it("binds replay and query authorization to exact principal+data+dataset scope context", async () => {
    const a = principal("scope-a", "dataset-a");
    const b = principal("scope-b", "dataset-a");
    expect(principalContextHash(a)).not.toBe(principalContextHash(b));

    const idempotency = new MemoryGatewayIdempotencyStore<number>();
    let actions = 0;
    const scope = (value: GatewayPrincipal) => ({ principalHash: principalContextHash(value), operationId: "test.operation", operationVersion: "1.0" });
    expect((await idempotency.execute(scope(a), "same-key", { x: 1 }, async () => ++actions)).replayed).toBe(false);
    expect((await idempotency.execute(scope(a), "same-key", { x: 1 }, async () => ++actions)).replayed).toBe(true);
    expect((await idempotency.execute(scope(b), "same-key", { x: 1 }, async () => ++actions)).replayed).toBe(false);
    expect(actions).toBe(2);

    const store = new MemoryQueryPlanStore();
    const context = queryContext(a);
    await store.create(context);
    const runtime = new WorldQueryRuntime({ validator: {} as never, directExecution: {} as never, store });
    expect(await runtime.get(context.submission.plan.queryId, a)).toMatchObject({ jobId: context.job.jobId });
    expect(await runtime.get(context.submission.plan.queryId, b)).toBeUndefined();
    expect(await runtime.getJob(context.job.jobId, b)).toBeUndefined();
    expect(await runtime.cancel(context.submission.plan.queryId, b)).toBeUndefined();
    expect(await store.cancellationRequested(context.job.jobId)).toBe(false);
  });

  it("authenticates read/cancel/job/receipt routes and fails closed across trusted scope contexts", async () => {
    const owner = principal("scope-a");
    const other = principal("scope-b");
    const store = new MemoryQueryPlanStore();
    const context = queryContext(owner);
    await store.create(context);
    const runtime = new WorldQueryRuntime({ validator: {} as never, directExecution: {} as never, store });
    const app = buildGatewayApp({
      registry: new CapabilityRegistry(),
      directExecution: {} as never,
      worldQueries: runtime,
      records: { putResult: async () => undefined, getJob: async () => undefined, getReceipt: async () => ({ receiptId: "receipt-1" }) as never },
      authenticate: async (request) => {
        if (request.headers.authorization === "Bearer owner") return owner;
        if (request.headers.authorization === "Bearer other") return other;
        throw new ProviderProtocolError("SCOPE_DENIED", "authentication required");
      }
    });
    try {
      const queryUrl = `/v1/world-queries/${context.submission.plan.queryId}`;
      expect((await app.inject({ method: "GET", url: queryUrl })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: queryUrl, headers: { authorization: "Bearer other" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: queryUrl, headers: { authorization: "Bearer owner" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/v1/jobs/${context.job.jobId}`, headers: { authorization: "Bearer other" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `${queryUrl}:cancel`, headers: { authorization: "Bearer other" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/v1/receipts/receipt-1" })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/v1/receipts/receipt-1", headers: { authorization: "Bearer owner" } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("immediately claims and resumes persisted work in a fresh bounded worker, then awaits shutdown", async () => {
    const context = queryContext(principal("scope-a"));
    const claims: Array<{ workerId: string; leaseSeconds: number }> = [];
    let claimed = false;
    let resumed!: () => void;
    const resumedPromise = new Promise<void>((resolvePromise) => { resumed = resolvePromise; });
    const worker = new PostgresWorldQueryWorker({
      async claimNext(workerId, leaseSeconds) {
        claims.push({ workerId, leaseSeconds });
        if (claimed) return undefined;
        claimed = true;
        return context;
      }
    }, {
      async run(jobId) {
        expect(jobId).toBe(context.job.jobId);
        resumed();
      }
    }, {
      workerId: "fresh-runtime-worker",
      leaseSeconds: 600,
      pollIntervalMs: 100,
      maximumClaimsPerTick: 2
    });
    worker.start();
    await resumedPromise;
    await worker.stop();
    expect(claims[0]).toEqual({ workerId: "fresh-runtime-worker", leaseSeconds: 600 });
    expect(claims.length).toBeLessThanOrEqual(2);
  });

  it("locks service principals, PUBLIC function ACL, safe lease horizon, non-root/resource/isolated-network Compose contracts", async () => {
    const migration = await readFile("database/migrations/014_capability_runtime_service_principals.sql", "utf8");
    expect(migration).toContain("REVOKE ALL ON FUNCTION gowm_capability.claim_world_query_job(text, integer) FROM PUBLIC");
    expect(migration).toContain("deadline_at + interval '30 seconds'");
    expect(migration).toContain("g.state = 'QUEUED' AND g.deadline_at > clock_timestamp()");
    expect(migration).toContain("QUEUE_DEADLINE_EXPIRED");
    expect(migration).toContain("GRANT gowm_gateway_runtime TO gowm_gateway_service");
    expect(migration).toContain("GRANT gowm_gateway_registry_admin TO gowm_gateway_registry_service");
    const assertions = await readFile("database/tests/006_capability_runtime_principal_assertions.sql", "utf8");
    expect(assertions).toContain("world-query claim function must be executable only through the gateway runtime role");

    const compose = await readFile("infrastructure/capability-platform/docker-compose.yml", "utf8");
    expect(compose).toContain("internal: true");
    expect(compose.match(/^\s+PROVIDER_TRANSPORT_SHARED_TOKEN:/gmu)).toHaveLength(6);
    for (const network of [
      "gateway_crs", "gateway_geometry", "gateway_h3_interactive",
      "gateway_h3_analysis", "gateway_spatial", "gateway_situation"
    ]) expect(compose).toContain(`${network}: { internal: true }`);
    expect(compose).toContain("GATEWAY_REGISTRY_DATABASE_URL: postgresql://gowm_gateway_registry_service");
    expect(compose).toContain("DATABASE_URL: postgresql://gowm_gateway_service");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("pids_limit:");
    expect(compose).toContain("mem_limit:");
    expect(compose).toContain("/health/ready");
  });
});

function gatewayEnv(registryPath: string): NodeJS.ProcessEnv {
  return {
    GATEWAY_PROVIDER_REGISTRY_PATH: registryPath,
    GATEWAY_AUTH_SHARED_TOKEN: GATEWAY_TOKEN,
    CRS_PROVIDER_TRANSPORT_TOKEN: "p16-crs-provider-token-is-unique-0001",
    GEOMETRY_PROVIDER_TRANSPORT_TOKEN: "p16-geometry-provider-token-unique-0002",
    H3_INTERACTIVE_PROVIDER_TRANSPORT_TOKEN: "p16-h3-interactive-token-is-unique-0003",
    H3_ANALYSIS_PROVIDER_TRANSPORT_TOKEN: "p16-h3-analysis-token-is-unique-0004",
    SPATIAL_PROVIDER_TRANSPORT_TOKEN: "p16-spatial-provider-token-unique-0005",
    SITUATION_PROVIDER_TRANSPORT_TOKEN: "p16-situation-provider-token-unique-0006",
    GATEWAY_RUNTIME_PRINCIPAL_REF: "p16-runtime",
    DATABASE_URL: "postgresql://runtime:secret@postgres:5432/gowm",
    GATEWAY_REGISTRY_DATABASE_URL: "postgresql://registry:secret@postgres:5432/gowm"
  };
}

async function canonicalManifest(filename: string): Promise<CapabilityProviderManifest> {
  return JSON.parse(await readFile(join(MANIFEST_DIRECTORY, filename), "utf8")) as CapabilityProviderManifest;
}

function httpClient(
  manifest: CapabilityProviderManifest,
  fetch: typeof globalThis.fetch,
  extra: Partial<ConstructorParameters<typeof HttpProviderClient>[0]> = {}
): HttpProviderClient {
  return new HttpProviderClient({
    endpoint: new URL("https://provider.example"),
    providerId: manifest.provider.providerId,
    providerVersion: manifest.provider.providerVersion,
    implementationDigest: manifest.provider.implementationDigest as `sha256:${string}`,
    manifestHash: sha256(manifest),
    approvedManifest: manifest,
    transportToken: PROVIDER_TOKEN,
    fetch,
    ...extra
  });
}

function providerRequest(deadlineAt = new Date(Date.now() + 5_000).toISOString()): ProviderExecutionRequest {
  return {
    requestId: "provider_request_p16",
    gatewayRequestId: "gateway_request_p16",
    executionPolicy: { deadlineAt }
  } as ProviderExecutionRequest;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderProtocolError);
    expect((error as ProviderProtocolError).code).toBe(code);
  }
}

function fixtureClient(manifest: CapabilityProviderManifest, ready: boolean): ProviderClient {
  return {
    providerId: manifest.provider.providerId,
    async manifest() { return structuredClone(manifest); },
    async health() { return { live: ready, ready, checkedAt: new Date().toISOString() }; },
    async execute() { return { selectedProvider: manifest.provider.providerId } as never; }
  };
}

function binding(manifest: CapabilityProviderManifest, client: ProviderClient, endpoint: string) {
  return { approvalId: `approval-${client.providerId}`, approved: true, endpoint: new URL(endpoint), client, manifest };
}

function principal(dataScopeClaim: string, datasetScopeClaim?: string): GatewayPrincipal {
  return {
    principalRef: "principal-p16",
    authenticationMethod: "TEST",
    authenticatedAt: new Date().toISOString(),
    dataScopeClaim,
    ...(datasetScopeClaim === undefined ? {} : { datasetScopeClaim })
  };
}

function queryContext(owner: GatewayPrincipal): QueryJobContext {
  return {
    job: {
      jobId: "query_job_p16",
      requestId: "request_query_p16",
      kind: "WORLD_QUERY",
      status: "QUEUED",
      queryId: "query_p16",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    submission: {
      requestId: "request_query_p16",
      idempotencyKey: "query-key-p16",
      plan: {
        queryId: "query_p16",
        nodes: [],
        budgets: { maximumExecutionMs: 1_000, maximumOutputBytes: 1_024 }
      }
    } as never,
    principal: owner,
    requestHash: sha256({ query: "p16" }),
    cancellationRequested: false
  };
}
