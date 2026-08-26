import type pg from "pg";
import { parseRoutingSnapshot, readRoutingSnapshotCurrentness } from "../../../../packages/network-query-core/src/index.js";
import { validateDataSnapshot, type DataSnapshotManifest, type ReferenceRecord, type SnapshotResource } from "../../../../packages/platform/result-validation-core/src/index.js";
import type { PlatformValidationAuthority } from "./index.js";

type Scope = { dataScopeKey: string; datasetScopeKey?: string };
type ValidationRequest = { referenceKey: ReferenceRecord["referenceKey"] };
type Row = Record<string, unknown>;
const resultKinds = new Set(["QUERY_RESULT", "DERIVED_REFERENCE", "REFERENCE_SET"]);
const catalogRelations: Readonly<Record<string, string>> = { DATASET: "dataset", LAYER: "layer", LAYER_FEATURE: "feature" };

export class PostgresPlatformValidationAuthority implements PlatformValidationAuthority {
  constructor(readonly pool: Pick<pg.Pool, "connect">, readonly statementTimeoutMs = 5_000) {}

  async readiness(): Promise<{ ready: boolean; reasons: string[] }> {
    let client: pg.PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("SELECT reference_key FROM gowm_platform_validation_v1.result_reference LIMIT 0");
      await client.query("SELECT manifest FROM gowm_platform_validation_v1.snapshot LIMIT 0");
      return { ready: true, reasons: [] };
    } catch {
      return { ready: false, reasons: ["PostgreSQL validation read contract is unavailable"] };
    } finally { client?.release(); }
  }

  async resolveReferences(requests: readonly ValidationRequest[], scope: Scope): Promise<Array<ReferenceRecord | undefined>> {
    return this.read(scope, async (client) => {
      const records: Array<ReferenceRecord | undefined> = [];
      for (const { referenceKey: key } of requests) {
        if (key.namespace !== "gowm") { records.push(undefined); continue; }
        if (resultKinds.has(key.kind)) {
          const row = (await client.query<Row>(
            `SELECT * FROM gowm_platform_validation_v1.result_reference
             WHERE reference_key=$1 AND entity_kind=$2 AND reference_version=$3`, [key.id, key.kind, key.version]
          )).rows[0];
          if (!row) { records.push(undefined); continue; }
          const currentness = await this.resultCurrentness(client, row);
          records.push({
            referenceKey: key, available: true, retired: row.retired === true,
            sourceStatus: text(row.source_status) ?? "INDETERMINATE", sourceAuthority: text(row.source_authority) ?? "gowm.result-registry",
            ...timestamps(row.valid_until, row.created_at), snapshotStatus: currentness.status,
            validationReasons: currentness.reasons,
            validationEvidenceRefs: [row.data_snapshot_hash, row.content_hash].filter((value): value is string => typeof value === "string")
          });
          continue;
        }
        const relation = catalogRelations[key.kind];
        if (relation !== undefined) {
          // The scoped Catalog read happens first. A descriptor in the same data
          // scope must never reveal a product from another dataset scope.
          const row = (await client.query<Row>(
            `SELECT version.*,current.version AS current_version,lifecycle.retired AS identity_retired,
                    descriptor.stale,descriptor.revalidation_required
             FROM gowm_catalog_v1.${relation}_version version
             JOIN gowm_catalog_v1.${relation} current USING(reference_key)
             LEFT JOIN gowm_platform_validation_v1.reference_lifecycle lifecycle USING(reference_key)
             LEFT JOIN gowm_reference_v1.current_descriptor descriptor USING(reference_key)
             WHERE version.reference_key=$1 AND version.version=$2`, [key.id, key.version]
          )).rows[0];
          if (!row) { records.push(undefined); continue; }
          records.push({
            referenceKey: key, available: true, retired: row.identity_retired === true || isPast(row.retired_at),
            sourceStatus: "COMPLETED", sourceAuthority: "gowm.dataset-catalog",
            ...timestamps(row.valid_to, row.published_at),
            snapshotStatus: row.current_version !== key.version || row.stale === true || row.revalidation_required === true ? "STALE" : "CURRENT",
            validationEvidenceRefs: typeof row.content_hash === "string" ? [row.content_hash] : []
          });
          continue;
        }
        const row = (await client.query<Row>(
          `SELECT * FROM gowm_platform_validation_v1.world_reference_version
           WHERE reference_key=$1 AND entity_kind=$2`, [key.id, key.kind]
        )).rows[0];
        records.push(row === undefined ? undefined : {
          referenceKey: key, available: true, retired: row.retired === true,
          sourceStatus: "COMPLETED", sourceAuthority: "gowm.reference-catalog",
          ...timestamps(row.valid_to, row.created_at),
          snapshotStatus: row.current_version === null ? "UNKNOWN" : row.current_version !== key.version || row.stale === true || row.revalidation_required === true ? "STALE" : "CURRENT",
          validationEvidenceRefs: typeof row.content_hash === "string" ? [row.content_hash] : []
        });
      }
      return records;
    });
  }

  async scopeReference(scope: Scope): Promise<ReferenceRecord["referenceKey"]> {
    return this.read(scope, async (client) => {
      const row = (await client.query<Row>("SELECT reference_key,entity_kind,reference_version FROM gowm_platform_validation_v1.scope_reference")).rows[0];
      if (!row) throw new Error("authorized Foundation scope reference is unavailable");
      return { namespace: "gowm", kind: String(row.entity_kind), id: String(row.reference_key), version: String(row.reference_version) };
    });
  }

  async getSnapshot(snapshotId: string, scope: Scope): Promise<DataSnapshotManifest | undefined> {
    return this.read(scope, async (client) => (await client.query<{ manifest: DataSnapshotManifest }>(
      "SELECT manifest FROM gowm_platform_validation_v1.snapshot WHERE snapshot_id=$1", [snapshotId]
    )).rows[0]?.manifest);
  }

  async currentResources(resources: readonly SnapshotResource[], scope: Scope): Promise<ReadonlyMap<string, SnapshotResource | "UNAVAILABLE">> {
    try { return await this.read(scope, (client) => this.resources(client, resources)); }
    catch { return new Map(resources.map((resource) => [resourceMapKey(resource), "UNAVAILABLE" as const])); }
  }

  private async read<T>(scope: Scope, operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); open = true;
      await client.query("SELECT set_config('statement_timeout',$1,true)", [`${this.statementTimeoutMs}ms`]);
      // All versioned contracts use these same transaction-local settings.
      await client.query("SELECT gowm_platform_validation_v1.set_scope($1,$2)", [scope.dataScopeKey, scope.datasetScopeKey ?? null]);
      const value = await operation(client);
      await client.query("COMMIT"); open = false;
      return value;
    } catch (error) {
      if (open) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async resultCurrentness(client: pg.PoolClient, row: Row): Promise<{ status: NonNullable<ReferenceRecord["snapshotStatus"]>; reasons: string[] }> {
    if (row.descriptor_stale === true) return { status: "STALE", reasons: ["Foundation descriptor requires revalidation"] };
    const payload = object(row.result_record);
    if (payload?.routingSnapshot !== undefined) {
      const requested = parseRoutingSnapshot(payload.routingSnapshot);
      if (!requested) return { status: "UNKNOWN", reasons: ["Stored routing snapshot is invalid"] };
      const currentness = await readRoutingSnapshotCurrentness(client, requested);
      if (currentness.currentness === "CURRENT") {
        const area = (await client.query<Row>(
          "SELECT * FROM gowm_platform_validation_v1.coverage_area_currentness WHERE reference_key=$1", [row.reference_key]
        )).rows;
        if (area.length > 1 || area.some((pin) => pin.pinned_version == null || pin.current_version == null)) {
          return {status:"UNKNOWN",reasons:["Coverage area pin cannot be proven against the scoped feature authority"]};
        }
        if (area.some((pin) => pin.pinned_version !== pin.current_version || pin.pinned_hash !== pin.current_hash)) {
          return {status:"STALE",reasons:["Coverage area feature version or content changed"]};
        }
      }
      return { status: currentness.currentness === "UNAVAILABLE" ? "UNKNOWN" : currentness.currentness, reasons: currentness.reasons };
    }
    const stored = (await client.query<{ manifest: DataSnapshotManifest }>(
      "SELECT manifest FROM gowm_platform_validation_v1.snapshot WHERE snapshot_hash=$1 LIMIT 1", [row.data_snapshot_hash]
    )).rows[0]?.manifest;
    if (stored !== undefined) {
      const validation = validateDataSnapshot(stored, await this.resources(client, stored.resources));
      const status = validation.status;
      return { status: status === "CURRENT" || status === "STALE" ? status : "UNKNOWN", reasons: status === "CURRENT" ? [] : ["Stored data snapshot is not current"] };
    }
    return { status: "UNKNOWN", reasons: ["No authoritative input snapshot is available for this result"] };
  }

  private async resources(client: pg.PoolClient, resources: readonly SnapshotResource[]) {
    const current = new Map<string, SnapshotResource | "UNAVAILABLE">();
    for (const requested of resources) {
      const actual = await this.currentResource(client, requested);
      if (actual !== undefined) current.set(resourceMapKey(requested), actual);
    }
    return current;
  }

  private async currentResource(client: pg.PoolClient, requested: SnapshotResource): Promise<SnapshotResource | undefined> {
    if (requested.resourceKind === "NETWORK_GRAPH") {
      const row = (await client.query<Row>(
        `SELECT graph.graph_version,graph.content_hash FROM gowm_network_v1.graph_version pinned
         JOIN LATERAL gowm_network_v1.resolve_active_graph(pinned.graph_key) graph ON true
         WHERE pinned.graph_key=$1 OR pinned.graph_version_id::text=$1 LIMIT 1`, [requested.resourceId]
      )).rows[0];
      return row === undefined ? undefined : resource(requested, String(row.graph_version), text(row.content_hash));
    }
    if (requested.referenceKey !== undefined && requested.referenceKey.id !== requested.resourceId) return undefined;
    const relation = catalogRelations[requested.resourceKind];
    if (relation !== undefined) {
      const row = (await client.query<Row>(
        `SELECT current.version,current.content_hash,current.retired_at,lifecycle.retired
         FROM gowm_catalog_v1.${relation} current
         LEFT JOIN gowm_platform_validation_v1.reference_lifecycle lifecycle USING(reference_key)
         WHERE current.reference_key=$1`, [requested.resourceId]
      )).rows[0];
      return row === undefined || row.retired === true || isPast(row.retired_at) ? undefined : resource(requested, String(row.version), text(row.content_hash));
    }
    if (requested.resourceKind === "WORLD_REFERENCE") {
      const row = (await client.query<Row>(
        `SELECT descriptor_version::text,object_version,world_version::text,content_hash
         FROM gowm_platform_validation_v1.world_reference_version
         WHERE reference_key=$1 AND current_version IS NOT NULL AND NOT COALESCE(retired,false)`, [requested.resourceId]
      )).rows[0];
      if (row === undefined) return undefined;
      const worldVersion = row.world_version === null ? undefined : Number(row.world_version);
      return { ...resource(requested, text(row.object_version) ?? String(row.descriptor_version), text(row.content_hash)),
        ...(worldVersion !== undefined && Number.isSafeInteger(worldVersion) && worldVersion >= 0 ? { worldVersion } : {}) };
    }
    if (resultKinds.has(requested.resourceKind)) {
      const row = (await client.query<Row>(
        `SELECT reference_version,content_hash,retired FROM gowm_platform_validation_v1.result_reference
         WHERE reference_key=$1 AND entity_kind=$2`, [requested.resourceId, requested.resourceKind]
      )).rows[0];
      return row === undefined || row.retired === true ? undefined : resource(requested, String(row.reference_version), text(row.content_hash));
    }
    return undefined;
  }
}

function resourceMapKey(value: SnapshotResource): string { return `${value.resourceKind}\u0000${value.resourceId}`; }
function resource(requested: SnapshotResource, version: string, contentHash?: string): SnapshotResource {
  // Do not copy requested hashes/world versions into an authoritative response.
  return { resourceKind: requested.resourceKind, resourceId: requested.resourceId, version,
    ...(contentHash === undefined ? {} : { contentHash }),
    ...(requested.referenceKey === undefined ? {} : { referenceKey: { ...requested.referenceKey, version } }) };
}
function object(value: unknown): Row | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function asIso(value: unknown): string | undefined {
  if (!(value instanceof Date) && typeof value !== "string") return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
function isPast(value: unknown): boolean { const at = asIso(value); return at !== undefined && Date.parse(at) <= Date.now(); }
function timestamps(until: unknown, created: unknown) {
  const validUntil = asIso(until), lastUpdatedAt = asIso(created);
  return { ...(validUntil === undefined ? {} : { validUntil }), ...(lastUpdatedAt === undefined ? {} : { lastUpdatedAt }) };
}
