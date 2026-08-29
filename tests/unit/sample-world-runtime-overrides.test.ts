import { describe, expect, it } from "vitest";
import {
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
});
