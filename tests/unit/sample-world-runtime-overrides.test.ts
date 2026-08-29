import { describe, expect, it } from "vitest";
import {
  resolveSampleRuntimeIdentity,
  sampleGatewayBaseUrl,
  samplePostgresEndpoint,
  type SampleRuntimeEnvironment
} from "../../scripts/sample-world/runtime.js";

const runtime = {
  paths: {} as SampleRuntimeEnvironment["paths"],
  values: {
    GATEWAY_BIND_ADDRESS: "127.0.0.1",
    GATEWAY_PORT: "18063",
    POSTGRES_BIND_ADDRESS: "127.0.0.1",
    POSTGRES_PORT: "55463"
  }
} satisfies SampleRuntimeEnvironment;

describe("sample-world isolated runtime overrides", () => {
  it("uses the shared-instance defaults when no process overrides are present", () => {
    expect(sampleGatewayBaseUrl(runtime, {})).toBe("http://127.0.0.1:18063");
    expect(samplePostgresEndpoint(runtime, {})).toEqual({ host: "127.0.0.1", port: 55463 });
  });

  it("accepts alternate loopback ports for a fresh-clone qualification instance", () => {
    const environment = {
      GATEWAY_BIND_ADDRESS: "localhost",
      GATEWAY_PORT: "28064",
      POSTGRES_BIND_ADDRESS: "::1",
      POSTGRES_PORT: "65464"
    };
    expect(sampleGatewayBaseUrl(runtime, environment)).toBe("http://localhost:28064");
    expect(samplePostgresEndpoint(runtime, environment)).toEqual({ host: "::1", port: 65464 });
  });

  it("rejects non-loopback hosts and invalid ports", () => {
    expect(() => sampleGatewayBaseUrl(runtime, { GATEWAY_BIND_ADDRESS: "0.0.0.0" })).toThrow(/loopback-only/u);
    expect(() => sampleGatewayBaseUrl(runtime, { GATEWAY_PORT: "70000" })).toThrow(/TCP port range/u);
    expect(() => samplePostgresEndpoint(runtime, { POSTGRES_PORT: "not-a-port" })).toThrow(/decimal TCP port/u);
  });

  it("derives every mutable Docker resource from one bounded qualification identity", () => {
    const identity = resolveSampleRuntimeIdentity({
      SAMPLE_WORLD_INSTANCE_ID: "q-9313668-a1",
      SAMPLE_WORLD_GATEWAY_PORT: "28064",
      SAMPLE_WORLD_POSTGRES_PORT: "65464"
    });
    expect(identity).toEqual({
      instanceId: "q-9313668-a1",
      composeProjectName: "gowm-wsgs-sample-q-9313668-a1",
      databaseName: "gowm_wsgs_sample_q_9313668_a1",
      gatewayPort: 28064,
      postgresPort: 65464,
      databaseVolumeName: "gowm-wsgs-sample-q-9313668-a1-db",
      runtimeVolumeName: "gowm-wsgs-sample-q-9313668-a1-runtime",
      applicationImage: "gowm-wsgs-sample:0.6.4-q-9313668-a1",
      databaseImage: "gowm-wsgs-sample-db:q-9313668-a1-18-3.6-mobilitydb-1.3-h3-4.5.0-pgrouting-4.0.1"
    });
  });

  it("rejects unbounded identities, missing ports and shared-port reuse", () => {
    expect(() => resolveSampleRuntimeIdentity({ SAMPLE_WORLD_INSTANCE_ID: "foreign" }))
      .toThrow(/bounded q-/u);
    expect(() => resolveSampleRuntimeIdentity({ SAMPLE_WORLD_INSTANCE_ID: "q-safe" }))
      .toThrow(/SAMPLE_WORLD_GATEWAY_PORT is required/u);
    expect(() => resolveSampleRuntimeIdentity({
      SAMPLE_WORLD_INSTANCE_ID: "q-safe",
      SAMPLE_WORLD_GATEWAY_PORT: "18063",
      SAMPLE_WORLD_POSTGRES_PORT: "65464"
    })).toThrow(/must not reuse/u);
    expect(() => resolveSampleRuntimeIdentity({
      SAMPLE_WORLD_INSTANCE_ID: "q-safe",
      SAMPLE_WORLD_GATEWAY_PORT: "55463",
      SAMPLE_WORLD_POSTGRES_PORT: "65464"
    })).toThrow(/must not reuse/u);
    expect(() => resolveSampleRuntimeIdentity({
      SAMPLE_WORLD_INSTANCE_ID: "q-safe",
      SAMPLE_WORLD_GATEWAY_PORT: "28064",
      SAMPLE_WORLD_POSTGRES_PORT: "18063"
    })).toThrow(/must not reuse/u);
  });
});
