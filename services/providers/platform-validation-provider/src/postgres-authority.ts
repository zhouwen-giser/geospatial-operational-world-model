import type pg from "pg";
import type {
  DataSnapshotManifest,
  ReferenceRecord,
  SnapshotResource
} from "../../../../packages/platform/result-validation-core/src/index.js";
import type { PlatformValidationAuthority } from "./index.js";

type Scope = { dataScopeKey: string; datasetScopeKey?: string };
type ValidationRequest = { referenceKey: ReferenceRecord["referenceKey"] };

export class PostgresPlatformValidationAuthority implements PlatformValidationAuthority {
  constructor(readonly pool: Pick<pg.Pool, "connect">, readonly statementTimeoutMs = 5_000) {}

  async resolveReferences(requests: readonly ValidationRequest[], scope: Scope): Promise<Array<ReferenceRecord | undefined>> {
    return this.read(scope, async (client) => {
      const records: Array<ReferenceRecord | undefined> = [];
      for (const request of requests) {
        const key = request.referenceKey;
        const descriptor = await client.query<{
          entity_kind: string; descriptor_version: string; stale: boolean | null;
          revalidation_required: boolean; valid_to: Date; created_at: Date;
        }>(
          `SELECT entity_kind,descriptor_version::text,stale,revalidation_required,valid_to,created_at
           FROM gowm_reference_v1.current_descriptor
           WHERE reference_key=$1 AND entity_kind=$2`,
          [key.id, key.kind]
        );
        const found = descriptor.rows[0];
        if (found === undefined || found.descriptor_version !== key.version && key.version !== "1") {
          records.push(undefined);
          continue;
        }
        const result = await this.resultState(client, key.kind, key.id);
        records.push({
          referenceKey: key,
          sourceStatus: result?.status ?? "COMPLETED",
          sourceAuthority: result?.authority ?? "gowm.reference-catalog",
          available: true,
          validUntil: (result?.validUntil ?? found.valid_to).toISOString(),
          lastUpdatedAt: (result?.createdAt ?? found.created_at).toISOString(),
          snapshotStatus: result?.snapshotStatus ?? (found.stale === true || found.revalidation_required ? "STALE" : "CURRENT"),
          validationEvidenceRefs: result?.evidence ?? []
        });
      }
      return records;
    });
  }

  async getSnapshot(snapshotId: string, scope: Scope): Promise<DataSnapshotManifest | undefined> {
    return this.read(scope, async (client) => {
      const result = await client.query<{ manifest: DataSnapshotManifest }>(
        "SELECT manifest FROM gowm_platform_validation_v1.snapshot WHERE snapshot_id=$1",
        [snapshotId]
      );
      return result.rows[0]?.manifest;
    });
  }

  async currentResources(resources: readonly SnapshotResource[], scope: Scope): Promise<ReadonlyMap<string, SnapshotResource | "UNAVAILABLE">> {
    try {
      return await this.read(scope, async (client) => {
        const current = new Map<string, SnapshotResource | "UNAVAILABLE">();
        for (const requested of resources) {
          const key = resourceMapKey(requested);
          const actual = await this.currentResource(client, requested);
          if (actual !== undefined) current.set(key, actual);
        }
        return current;
      });
    } catch {
      return new Map(resources.map((resource) => [resourceMapKey(resource), "UNAVAILABLE" as const]));
    }
  }

  private async read<T>(scope: Scope, operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (scope.datasetScopeKey === undefined) throw new Error("dataset scope is required for platform validation");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('statement_timeout',$1,true)", [`${this.statementTimeoutMs}ms`]);
      await client.query("SELECT gowm_platform_validation_v1.set_scope($1,$2)", [scope.dataScopeKey, scope.datasetScopeKey]);
      await client.query("SELECT gowm_reference_v1.set_data_scope($1)", [scope.dataScopeKey]);
      await client.query("SELECT gowm_result_v1.set_data_scope($1)", [scope.dataScopeKey]);
      await client.query("SELECT gowm_catalog_v1.set_scope($1,$2)", [scope.dataScopeKey, scope.datasetScopeKey]);
      await client.query("SELECT gowm_network_v1.set_scope($1,$2)", [scope.dataScopeKey, scope.datasetScopeKey]);
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async resultState(client: pg.PoolClient, kind: string, id: string) {
    if (kind === "QUERY_RESULT") {
      const result = await client.query<{ status: string; valid_until: Date; created_at: Date; data_snapshot_hash: string }>(
        `SELECT status,valid_until,created_at,data_snapshot_hash FROM gowm_result_v1.query_result WHERE reference_key=$1
         UNION ALL
         SELECT status,valid_until,created_at,data_snapshot_hash FROM gowm_result_v1.route_query_result WHERE reference_key=$1
         LIMIT 1`, [id]
      );
      const row = result.rows[0];
      if (row !== undefined) return { status: row.status, authority: "gowm.result-registry", validUntil: row.valid_until, createdAt: row.created_at, snapshotStatus: "CURRENT" as const, evidence: [row.data_snapshot_hash] };
    }
    if (kind === "DERIVED_REFERENCE") {
      const result = await client.query<{ valid_until: Date; created_at: Date; revalidation_required: boolean; data_snapshot_hash: string }>(
        "SELECT valid_until,created_at,revalidation_required,data_snapshot_hash FROM gowm_result_v1.derived_reference WHERE reference_key=$1", [id]
      );
      const row = result.rows[0];
      if (row !== undefined) return { status: row.revalidation_required ? "STALE" : "COMPLETED", authority: "gowm.result-registry", validUntil: row.valid_until, createdAt: row.created_at, snapshotStatus: row.revalidation_required ? "STALE" as const : "CURRENT" as const, evidence: [row.data_snapshot_hash] };
    }
    if (kind === "REFERENCE_SET") {
      const result = await client.query<{ valid_until: Date; created_at: Date }>(
        "SELECT valid_until,created_at FROM gowm_result_v1.reference_set WHERE reference_key=$1", [id]
      );
      const row = result.rows[0];
      if (row !== undefined) return { status: "COMPLETED", authority: "gowm.result-registry", validUntil: row.valid_until, createdAt: row.created_at, snapshotStatus: "CURRENT" as const, evidence: [] };
    }
    return undefined;
  }

  private async currentResource(client: pg.PoolClient, requested: SnapshotResource): Promise<SnapshotResource | undefined> {
    if (requested.resourceKind === "NETWORK_GRAPH") {
      const result = await client.query<{ graph_version: string; content_hash: string }>(
        `SELECT graph_version,content_hash FROM gowm_network_v1.graph_version
         WHERE (graph_key=$1 OR graph_version_id::text=$1) AND status='ACTIVE'
         ORDER BY created_at DESC LIMIT 1`, [requested.resourceId]
      );
      const row = result.rows[0];
      return row === undefined ? undefined : { ...requested, version: row.graph_version, contentHash: row.content_hash };
    }
    if (requested.resourceKind === "DATASET" || requested.resourceKind === "LAYER") {
      const relation = requested.resourceKind === "DATASET" ? "dataset" : "layer";
      const result = await client.query<{ version: string; content_hash: string }>(
        `SELECT version,content_hash FROM gowm_catalog_v1.${relation} WHERE reference_key=$1`, [requested.resourceId]
      );
      const row = result.rows[0];
      return row === undefined ? undefined : { ...requested, version: row.version, contentHash: row.content_hash };
    }
    if (["QUERY_RESULT", "DERIVED_REFERENCE", "REFERENCE_SET"].includes(requested.resourceKind)) {
      const state = await this.resultState(client, requested.resourceKind, requested.resourceId);
      return state === undefined ? undefined : { ...requested, version: requested.referenceKey?.version ?? "1", ...(state.evidence[0] === undefined ? {} : { contentHash: state.evidence[0] }) };
    }
    return undefined;
  }
}

function resourceMapKey(resource: SnapshotResource): string {
  return `${resource.resourceKind}\u0000${resource.resourceId}`;
}
