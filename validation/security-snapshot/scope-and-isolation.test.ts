import { describe, expect, it } from "vitest";
import {
  buildGatewayApp,
  CapabilityRegistry,
  MemoryGatewayIdempotencyStore,
  MemoryQueryPlanStore,
  QueryPlanValidator,
  WorldQueryRuntime
} from "../../services/gateway/world-capability-gateway/src/index.js";
import { buildSpatialQuery } from "../../services/providers/spatial-provider-bridge/src/sql.js";
import {
  CountingProviderClient,
  createOpenObjectProvider,
  createScopedProvider,
  gatewayHarness,
  gatewayRequest,
  oneNodeSubmission,
  principal,
  providerRequest
} from "./fixtures.js";

describe("P15 scope and provider-isolation adversarial gates", () => {
  it("enforces DataScope independently at Gateway and Provider boundaries", async () => {
    const scoped = createScopedProvider();
    const client = new CountingProviderClient(scoped.runtime);
    const gateway = gatewayHarness(client, scoped.manifest);
    const request = gatewayRequest(scoped.descriptor);

    await expect(gateway.direct.execute(scoped.descriptor.operationId, request, principal()))
      .rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(client.executeCalls).toBe(0);

    await expect(scoped.runtime.execute(providerRequest(scoped.descriptor)))
      .rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(scoped.calls.count).toBe(0);

    const accepted = await gateway.direct.execute(
      scoped.descriptor.operationId,
      { ...request, idempotencyKey: "trusted-scope" },
      principal({ dataScopeClaim: "scope:trusted" })
    );
    expect(accepted.result.status).toBe("COMPLETED");
    expect(scoped.calls.scopes).toEqual(["scope:trusted"]);
  });

  it("rejects caller-forged identity and scope in direct request bodies", async () => {
    const scoped = createScopedProvider();
    const client = new CountingProviderClient(scoped.runtime);
    const gateway = gatewayHarness(client, scoped.manifest);
    const app = buildGatewayApp({
      registry: gateway.registry,
      directExecution: gateway.direct,
      records: gateway.records,
      authenticate: async () => principal({ dataScopeClaim: "scope:transport" })
    });
    const request = gatewayRequest(scoped.descriptor);
    const response = await app.inject({
      method: "POST",
      url: `/v1/operations/${scoped.descriptor.operationId}:execute`,
      payload: {
        ...request,
        securityContext: {
          principalRef: "principal:forged-admin",
          dataScopeClaim: "scope:*",
          authorization: "Bearer forged"
        }
      }
    });

    expect(response.statusCode).toBe(422);
    expect(client.executeCalls).toBe(0);
    await app.close();
  });

  it("rejects nested forged security claims in DAG parameters and literal bodies before execution", async () => {
    const open = createOpenObjectProvider();
    const client = new CountingProviderClient(open.runtime);
    const gateway = gatewayHarness(client, open.manifest);
    const runtime = new WorldQueryRuntime({
      validator: new QueryPlanValidator(gateway.registry),
      directExecution: gateway.direct,
      store: new MemoryQueryPlanStore(),
      autoRunAsync: false
    });

    const parameterForgery = oneNodeSubmission(open.descriptor, { value: 1 }, "query_parameter_forgery");
    parameterForgery.parameters = {
      nested: { securityContext: { principalRef: "principal:forged" } }
    };
    await expect(runtime.submit(parameterForgery, principal()))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const literalForgery = oneNodeSubmission(open.descriptor, {
      value: 1,
      dataScopeClaim: "scope:*",
      principalRef: "principal:forged"
    }, "query_literal_forgery");
    await expect(runtime.submit(literalForgery, principal()))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(client.executeCalls).toBe(0);
  });

  it("keeps provider endpoints registry-only and blocks dynamic discovery", async () => {
    const open = createOpenObjectProvider();
    const client = new CountingProviderClient(open.runtime);
    const endpoints = [
      { approved: false, endpoint: "http://127.0.0.1:34515/" },
      { approved: true, endpoint: "http://provider.example/" },
      { approved: true, endpoint: "https://user:secret@provider.example/" },
      { approved: true, endpoint: "https://provider.example/path" },
      { approved: true, endpoint: "https://provider.example/?target=http://169.254.169.254/" }
    ];
    for (const item of endpoints) {
      const registry = new CapabilityRegistry();
      expect(() => registry.register({
        approvalId: "approval-p15-ssrf",
        approved: item.approved,
        endpoint: new URL(item.endpoint),
        client,
        manifest: open.manifest
      })).toThrow();
    }

    const gateway = gatewayHarness(client, open.manifest, new MemoryGatewayIdempotencyStore());
    const forgedRouteRequest = gatewayRequest(open.descriptor, {
      input: { value: 1, providerUrl: "http://169.254.169.254/latest/meta-data" }
    });
    const fixedRoute = await gateway.direct.execute(open.descriptor.operationId, forgedRouteRequest, principal());
    expect(fixedRoute.result.status).toBe("COMPLETED");
    expect(gateway.registry.get(open.descriptor.operationId, "1.0")?.endpoint.toString())
      .toBe("http://127.0.0.1:34515/");

    await expect(gateway.direct.execute(
      "mcp.dynamic.discovery",
      { ...forgedRouteRequest, idempotencyKey: "dynamic-tool" },
      principal()
    )).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    expect(client.executeCalls).toBe(1);
  });

  it("keeps hostile SQL and Geometry bytes in parameters, never SQL text", () => {
    const injection = "vehicle'); DROP TABLE gowm_capability.job; --";
    const geometry = {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]
    };
    const query = buildSpatialQuery("spatial.count-in-area", {
      geometry,
      objectTypes: [injection]
    }, undefined, {
      maximumRows: 100,
      maximumCandidates: 1_000,
      maximumEvidenceReferences: 100
    });

    expect(query.text).not.toContain(injection);
    expect(query.text).not.toContain(JSON.stringify(geometry));
    expect(query.values).toContainEqual([injection]);
    expect(query.values).toContain(JSON.stringify(geometry));
    expect(query.text).toContain("$1::json");
  });
});
