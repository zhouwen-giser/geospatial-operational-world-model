import { describe, expect, it } from "vitest";
import { PostgresPlatformValidationAuthority } from "../../services/providers/platform-validation-provider/src/postgres-authority.js";
import { validateReferenceRecord } from "../../packages/platform/result-validation-core/src/index.js";
import type { RoutingSnapshot } from "../../packages/network-query-core/src/index.js";

const key = { namespace: "gowm" as const, kind: "QUERY_RESULT", id: `wrf_${"1".repeat(32)}`, version: "1" };
const worldKey = { namespace: "gowm" as const, kind: "WORLD_OBJECT", id: `wrf_${"2".repeat(32)}`, version: "710" };
const featureKey = { namespace: "gowm" as const, kind: "LAYER_FEATURE", id: `wrf_${"3".repeat(32)}`, version: "698" };
const scope = { dataScopeKey: "validation-test", datasetScopeKey: "tenant-a" };
const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const pinned: RoutingSnapshot = {
  networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", graphContentHash: hash("a"),
  travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1", costContentHash: hash("b"),
  conditionSnapshotId: "condition-v1", conditionContentHash: hash("c"), sourceWorldVersion: 7
};

// These are explicitly unit-level SQL boundary doubles. Required authority and
// scope evidence comes from 043 SQL assertions and PostgreSQL/Gateway gates.
function fixture(options: { current?: Partial<RoutingSnapshot>; stored?: Record<string, unknown>; record?: Record<string, unknown>; catalogRecord?: Record<string, unknown>; missingGraph?: boolean } = {}) {
  const current = { ...pinned, ...options.current };
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let releases = 0;
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, ...(values === undefined ? {} : { values }) });
      if (sql.includes("SELECT * FROM gowm_platform_validation_v1.result_reference")) return { rows: [{
        source_status: "SUCCEEDED", source_authority: "gowm.road-coverage-planning",
        valid_until: new Date("2100-01-01T00:00:00Z"), created_at: new Date("2026-08-25T00:00:00Z"),
        data_snapshot_hash: hash("d"), content_hash: hash("e"), descriptor_stale: false, retired: false,
        result_record: options.stored ?? { routingSnapshot: pinned }, ...options.record
      }] };
      if (sql.includes("SELECT * FROM gowm_platform_validation_v1.world_reference_version")) return { rows: [{
        reference_key: worldKey.id, entity_kind: worldKey.kind,
        descriptor_version: "710", descriptor_object_version: "59",
        current_version: "710", object_version: "59", world_version: "59",
        stale: false, revalidation_required: false, retired: false,
        content_hash: hash("f"), created_at: new Date("2026-08-29T00:00:00Z")
      }] };
      if (sql.includes("FROM gowm_catalog_v1.feature_version")) return { rows: [{
        version: "1.0.0", current_version: "1.0.0",
        descriptor_version: "698", descriptor_object_version: "1.0.0",
        stale: false, revalidation_required: false, identity_retired: false,
        content_hash: hash("9"), published_at: new Date("2026-08-29T00:00:00Z"),
        ...options.catalogRecord
      }] };
      if (sql.includes("SELECT graph_key,graph_version_id")) return { rows: options.missingGraph ? [] : [{ graph_key: "roads", graph_version_id: "00000000-0000-0000-0000-000000000001" }] };
      if (sql.includes("FROM gowm_network_v1.resolve_active_graph")) return { rows: [{ graph_version_id: "00000000-0000-0000-0000-000000000002", graph_version: current.graphVersion, content_hash: current.graphContentHash, dataset_version: current.networkDatasetVersion }] };
      if (sql.includes("SELECT DISTINCT cost.profile_key")) return { rows: [{ cost_key: "cost-family", travel_key: "travel-family" }] };
      if (sql.includes("SELECT version FROM gowm_network_v1.travel_profile")) return { rows: [{ version: current.travelProfileVersion }] };
      if (sql.includes("SELECT version,content_hash FROM gowm_network_v1.cost_profile")) return { rows: [{ version: current.costProfileVersion, content_hash: current.costContentHash }] };
      if (sql.includes("FROM gowm_network_v1.condition_snapshot")) return { rows: [{ condition_snapshot_id: current.conditionSnapshotId, content_hash: current.conditionContentHash }] };
      if (sql.includes("FROM gowm_network_v1.source_world")) return { rows: [{ world_version: String(current.sourceWorldVersion) }] };
      if (sql.includes("SELECT reference_version,content_hash,retired")) return { rows: [{ reference_version: "1", content_hash: hash("e"), retired: false }] };
      if (sql.includes("SELECT descriptor_version::text,object_version")) return { rows: [{ descriptor_version: "7", object_version: "world-v2", world_version: null, content_hash: hash("f") }] };
      return { rows: [] };
    },
    release() { releases += 1; }
  };
  const authority = new PostgresPlatformValidationAuthority({ async connect() { return client as never; } });
  return { authority, calls, releases: () => releases };
}

describe("PostgreSQL platform validation authority", () => {
  it("does not override an authoritative stale descriptor with a CURRENT result default", async () => {
    const { authority, calls } = fixture({ record: { descriptor_stale: true } });
    const [record] = await authority.resolveReferences([{ referenceKey: key }], scope);
    expect(validateReferenceRecord(record, { referenceKey: key, requireCurrentSnapshot: true }, { SUCCEEDED: "COMPLETED" })).toMatchObject({ snapshot: "STALE", usable: "REVALIDATE" });
    expect(calls.some(({ sql }) => sql.includes("FROM gowm_network_v1"))).toBe(false);
  });

  it("proves CURRENT from all routing input authorities in one scoped repeatable-read transaction", async () => {
    const { authority, calls, releases } = fixture();
    const [record] = await authority.resolveReferences([{ referenceKey: key }], scope);
    expect(record).toMatchObject({ snapshotStatus: "CURRENT", sourceStatus: "SUCCEEDED" });
    expect(calls[0]?.sql).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(calls.find(({ sql }) => sql.includes("set_scope"))?.values).toEqual([scope.dataScopeKey, scope.datasetScopeKey]);
    expect(calls.some(({ sql }) => sql.includes("JOIN gowm_network_v1.travel_profile travel USING(travel_profile_version_id)"))).toBe(true);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
    expect(releases()).toBe(1);
  });

  it.each([
    ["graphVersion", "graph-v2", "GRAPH"], ["networkDatasetVersion", "dataset-v2", "GRAPH"],
    ["travelProfileVersion", "travel-v2", "TRAVEL_PROFILE"], ["costProfileVersion", "cost-v2", "COST_PROFILE"],
    ["conditionSnapshotId", "condition-v2", "CONDITION"], ["sourceWorldVersion", 8, "SOURCE_WORLD"]
  ])("detects changed %s without modifying the frozen plan", async (dimension, value, reason) => {
    const { authority } = fixture({ current: { [dimension as string]: value } });
    const original = structuredClone(pinned);
    const [record] = await authority.resolveReferences([{ referenceKey: key }], scope);
    expect(record).toMatchObject({ snapshotStatus: "STALE", sourceStatus: "SUCCEEDED" });
    expect(record?.validationReasons?.join(" ")).toContain(reason);
    expect(pinned).toEqual(original);
  });

  it.each([{ stored: {} }, { stored: { routingSnapshot: {} } }, { missingGraph: true }])("fails closed when it cannot prove snapshot currentness: %j", async (options) => {
    const { authority } = fixture(options);
    const [record] = await authority.resolveReferences([{ referenceKey: key }], scope);
    expect(validateReferenceRecord(record, { referenceKey: key, requireCurrentSnapshot: true }, { SUCCEEDED: "COMPLETED" })).toMatchObject({ snapshot: "UNKNOWN", usable: "REVALIDATE" });
  });

  it("keeps retirement and original result status independent", async () => {
    const { authority } = fixture({ record: { retired: true } });
    const [record] = await authority.resolveReferences([{ referenceKey: key }], scope);
    expect(validateReferenceRecord(record, { referenceKey: key }, { SUCCEEDED: "COMPLETED" })).toMatchObject({ existence: "RETIRED", usable: "NO", resultSemantics: { sourceStatus: "SUCCEEDED" } });
  });

  it("uses result content hash rather than its input snapshot hash", async () => {
    const { authority } = fixture();
    const requested = { resourceKind: "QUERY_RESULT", resourceId: key.id, version: "1", contentHash: hash("d") };
    const resources = await authority.currentResources([requested], scope);
    expect(resources.get(`QUERY_RESULT\0${key.id}`)).toMatchObject({ contentHash: hash("e") });
  });

  it("accepts both current descriptor and authority pins only for the exact WORLD_OBJECT binding", async () => {
    const { authority } = fixture();
    const [descriptorPin, authorityPin, prior] = await authority.resolveReferences([
      { referenceKey: worldKey },
      { referenceKey: { ...worldKey, version: "59" } },
      { referenceKey: { ...worldKey, version: "709" } }
    ], scope);
    expect(validateReferenceRecord(
      descriptorPin,
      { referenceKey: worldKey, requireCurrentSnapshot: true },
      { COMPLETED: "COMPLETED" }
    )).toMatchObject({ snapshot: "CURRENT", usable: "YES" });
    expect(validateReferenceRecord(
      authorityPin,
      { referenceKey: { ...worldKey, version: "59" }, requireCurrentSnapshot: true },
      { COMPLETED: "COMPLETED" }
    )).toMatchObject({ snapshot: "CURRENT", usable: "YES" });
    expect(validateReferenceRecord(
      prior,
      { referenceKey: { ...worldKey, version: "709" }, requireCurrentSnapshot: true },
      { COMPLETED: "COMPLETED" }
    )).toMatchObject({ snapshot: "STALE", usable: "REVALIDATE" });
  });

  it("accepts a current LAYER_FEATURE descriptor pin only when it binds to the active catalog version", async () => {
    const { authority } = fixture();
    const [descriptorPin, authorityPin] = await authority.resolveReferences([
      { referenceKey: featureKey },
      { referenceKey: { ...featureKey, version: "1.0.0" } }
    ], scope);
    expect(validateReferenceRecord(
      descriptorPin,
      { referenceKey: featureKey, requireCurrentSnapshot: true },
      { COMPLETED: "COMPLETED" }
    )).toMatchObject({ snapshot: "CURRENT", usable: "YES" });
    expect(validateReferenceRecord(
      authorityPin,
      { referenceKey: { ...featureKey, version: "1.0.0" }, requireCurrentSnapshot: true },
      { COMPLETED: "COMPLETED" }
    )).toMatchObject({ snapshot: "CURRENT", usable: "YES" });
  });

  it("keeps a LAYER_FEATURE descriptor pin stale when its object version is not active", async () => {
    const { authority } = fixture({ catalogRecord: {
      version: "0.9.0", current_version: "1.0.0",
      descriptor_version: "697", descriptor_object_version: "0.9.0"
    } });
    const staleKey = { ...featureKey, version: "697" };
    const [record] = await authority.resolveReferences([{ referenceKey: staleKey }], scope);
    expect(validateReferenceRecord(
      record,
      { referenceKey: staleKey, requireCurrentSnapshot: true },
      { COMPLETED: "COMPLETED" }
    )).toMatchObject({ snapshot: "STALE", usable: "REVALIDATE" });
  });

  it("never echoes a claimed world version when the authority does not have it", async () => {
    const { authority } = fixture();
    const resources = await authority.currentResources([{ resourceKind: "WORLD_REFERENCE", resourceId: key.id, version: "world-v2", worldVersion: 99 }], scope);
    expect(resources.get(`WORLD_REFERENCE\0${key.id}`)).not.toHaveProperty("worldVersion");
  });

  it("reports pool failures as unready/unavailable instead of claiming CURRENT", async () => {
    const authority = new PostgresPlatformValidationAuthority({ async connect(): Promise<never> { throw new Error("database unavailable"); } });
    await expect(authority.readiness()).resolves.toMatchObject({ ready: false });
    const resources = await authority.currentResources([{ resourceKind: "DATASET", resourceId: key.id, version: "1" }], scope);
    expect(resources.get(`DATASET\0${key.id}`)).toBe("UNAVAILABLE");
    await expect(authority.resolveReferences([{ referenceKey: key }], scope)).rejects.toThrow("database unavailable");
  });
});
