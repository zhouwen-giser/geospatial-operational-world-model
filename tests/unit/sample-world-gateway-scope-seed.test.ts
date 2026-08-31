import { describe, expect, it } from "vitest";
import { sampleGatewayScopeClaimFromEnvironment } from "../../scripts/sample-world/database.js";

describe("sample-world Gateway data-scope authority seed", () => {
  it("accepts one exact external claim only for a bounded qualification instance", () => {
    expect(sampleGatewayScopeClaimFromEnvironment({
      SAMPLE_WORLD_INSTANCE_ID: "q-n04-063",
      SAMPLE_WORLD_GATEWAY_DATA_SCOPE_CLAIM: "scope-gdps-v021-baseline"
    }, "q-n04-063")).toBe("scope-gdps-v021-baseline");
    expect(sampleGatewayScopeClaimFromEnvironment({
      SAMPLE_WORLD_INSTANCE_ID: "q-n04-063"
    }, "q-n04-063")).toBeUndefined();
  });

  it.each([
    ["shared", "scope-gdps-v021-baseline"],
    ["q-n04-063", "wsgs-demo"],
    ["q-n04-063", "wsgs-hidden"],
    ["q-n04-063", "scope-*"],
    ["q-n04-063", " scope-gdps-v021-baseline"]
  ])("rejects non-isolated or non-exact bindings (%s)", (instanceId, claim) => {
    expect(() => sampleGatewayScopeClaimFromEnvironment({
      SAMPLE_WORLD_INSTANCE_ID: instanceId,
      SAMPLE_WORLD_GATEWAY_DATA_SCOPE_CLAIM: claim
    }, instanceId)).toThrow();
  });

  it("rejects a declared qualification identity that differs from the verified database marker", () => {
    expect(() => sampleGatewayScopeClaimFromEnvironment({
      SAMPLE_WORLD_INSTANCE_ID: "q-n04-063",
      SAMPLE_WORLD_GATEWAY_DATA_SCOPE_CLAIM: "scope-gdps-v021-baseline"
    }, "shared")).toThrow();
  });
});
