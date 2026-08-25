import { describe, expect, it } from "vitest";
import { createDataSnapshot, normalizeResultStatus, validateDataSnapshot, validateReferenceRecord } from "../../packages/platform/result-validation-core/src/index.js";

const key = { namespace: "gowm" as const, kind: "QUERY_RESULT", id: `wrf_${"1".repeat(32)}`, version: "1" };
const mapping = { SUCCEEDED: "COMPLETED", NO_FEASIBLE_PLAN: "NO_FEASIBLE_RESULT", FAILED: "FAILED" } as const;

describe("normalized result and snapshot validation", () => {
  it("retains source status and maps unknown statuses fail closed", () => {
    expect(normalizeResultStatus("NO_FEASIBLE_PLAN", mapping)).toBe("NO_FEASIBLE_RESULT");
    expect(normalizeResultStatus("NEW_PROVIDER_STATUS", mapping)).toBe("INDETERMINATE");
    expect(validateReferenceRecord({ referenceKey: key, sourceStatus: "SUCCEEDED", sourceAuthority: "coverage", available: true, snapshotStatus: "STALE" }, { referenceKey: key, requireCurrentSnapshot: true }, mapping)).toMatchObject({ freshness: "STALE", snapshot: "STALE", usable: "REVALIDATE", resultSemantics: { normalizedStatus: "COMPLETED", sourceStatus: "SUCCEEDED" } });
  });

  it("keeps snapshot consistency and validates each resource without mutation", () => {
    const resource = { resourceKind: "GRAPH", resourceId: "roads", version: "1", contentHash: `sha256:${"a".repeat(64)}` };
    const manifest = createDataSnapshot("PINNED", [resource], "2026-08-25T00:00:00.000Z");
    expect(manifest.consistency).toBe("PINNED");
    expect(validateDataSnapshot(manifest, new Map([["GRAPH\u0000roads", { ...resource, version: "2" }]]), "2026-08-25T01:00:00.000Z")).toMatchObject({ status: "STALE", resourceResults: [{ status: "STALE" }] });
    expect(validateDataSnapshot(manifest, new Map(), "2026-08-25T01:00:00.000Z")).toMatchObject({ status: "UNKNOWN" });
  });
});
