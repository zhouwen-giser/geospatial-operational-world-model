import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { buildH3ProviderApp } from "../../packages/integrations/h3-toolkit-bridge/src/app.js";
import { buildCrsProviderBridgeApp } from "../../services/providers/crs-provider-bridge/src/app.js";
import { buildElevationMockApp } from "../../services/providers/elevation-mock/src/app.js";
import { buildGeometryProviderBridgeApp } from "../../services/providers/geometry-provider-bridge/src/app.js";
import { buildGowmSituationProviderApp } from "../../services/providers/gowm-situation-provider/src/app.js";
import { buildSpatialProviderBridgeApp } from "../../services/providers/spatial-provider-bridge/src/app.js";

const TOKEN = "test-provider-transport-token-32-bytes-minimum";

describe("production Provider HTTP transport authentication", () => {
  for (const fixture of providerApps()) {
    it(`${fixture.name} rejects missing/forged Bearer before execution and accepts the controlled token`, async () => {
      const { app, execute } = fixture.build();
      const payload = { operation: { operationId: "test.operation" } };
      try {
        const missing = await app.inject({
          method: "POST",
          url: "/v1/operations/test.operation:execute",
          payload
        });
        expect(missing.statusCode).toBe(403);
        expect(execute).not.toHaveBeenCalled();

        const forged = await app.inject({
          method: "POST",
          url: "/v1/operations/test.operation:execute",
          headers: { authorization: `Bearer ${"x".repeat(48)}` },
          payload
        });
        expect(forged.statusCode).toBe(403);
        expect(execute).not.toHaveBeenCalled();

        const accepted = await app.inject({
          method: "POST",
          url: "/v1/operations/test.operation:execute",
          headers: { authorization: `Bearer ${TOKEN}` },
          payload
        });
        expect(accepted.statusCode).toBe(200);
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    });
  }
});

function providerApps(): Array<{
  name: string;
  build(): { app: FastifyInstance; execute: ReturnType<typeof vi.fn> };
}> {
  const runtime = (providerId: string) => {
    const execute = vi.fn(async () => ({ accepted: true }));
    return {
      execute,
      value: {
        manifest: { provider: { providerId }, capabilities: [] },
        execute,
        async health() { return { live: true, ready: true }; },
        readiness() { return { ready: true, reasons: [] }; }
      }
    };
  };
  const ready = async () => ({ ready: true, reasons: [] });
  return [
    {
      name: "CRS",
      build: () => {
        const item = runtime("gowm.crs-normalization.bridge");
        return { app: buildCrsProviderBridgeApp({ runtime: item.value, upstream: { readiness: ready } } as never, TOKEN), execute: item.execute };
      }
    },
    {
      name: "Geometry",
      build: () => {
        const item = runtime("gowm.geometry.bridge");
        return { app: buildGeometryProviderBridgeApp({ runtime: item.value, upstream: { readiness: async () => ({ ready: true, reasons: [], bridge: {} }) } } as never, TOKEN), execute: item.execute };
      }
    },
    {
      name: "H3 interactive",
      build: () => {
        const item = runtime("gowm.h3.interactive.bridge");
        return {
          app: buildH3ProviderApp({ runtime: item.value, upstream: { readiness: ready }, operationIds: [], bodyLimitBytes: 1024 } as never, TOKEN),
          execute: item.execute
        };
      }
    },
    {
      name: "H3 analysis",
      build: () => {
        const item = runtime("gowm.h3.analysis.bridge");
        return {
          app: buildH3ProviderApp({ runtime: item.value, upstream: { readiness: ready }, operationIds: [], bodyLimitBytes: 1024 } as never, TOKEN),
          execute: item.execute
        };
      }
    },
    {
      name: "Spatial",
      build: () => {
        const item = runtime("gowm.spatial-analysis.bridge");
        return { app: buildSpatialProviderBridgeApp({ runtime: item.value, repository: { readiness: ready } } as never, TOKEN), execute: item.execute };
      }
    },
    {
      name: "Situation",
      build: () => {
        const item = runtime("gowm.situation.h3");
        return { app: buildGowmSituationProviderApp({ runtime: item.value, port: { readiness: ready } } as never, TOKEN), execute: item.execute };
      }
    },
    {
      name: "Elevation conformance provider",
      build: () => {
        const item = runtime("gowm.elevation.mock");
        return { app: buildElevationMockApp(item.value as never, TOKEN), execute: item.execute };
      }
    }
  ];
}
