import type { PoolClient } from "pg";
import type { NetworkBuildRequest, NetworkCatalogRepository, NetworkDatasetVersion, SourceLineFeature } from "./types.js";

type ScopedTransaction = Pick<PoolClient, "query">;

export class PostgresNetworkCatalogRepository implements NetworkCatalogRepository {
  constructor(private readonly database: ScopedTransaction) {}

  async getDatasetVersion(request: NetworkBuildRequest): Promise<NetworkDatasetVersion | null> {
    await this.database.query("SELECT gowm_catalog_v1.set_scope($1,$2)", [request.dataScopeKey, request.datasetScopeKey]);
    const result = await this.database.query<{
      reference_key: string;
      version: string;
      dataset_kind: string;
      content_hash: string;
    }>(`SELECT reference_key,version,dataset_kind,content_hash
        FROM gowm_catalog_v1.dataset_version
        WHERE reference_key=$1 AND version=$2`, [request.datasetReferenceKey, request.datasetVersion]);
    const row = result.rows[0];
    return row ? {
      datasetReferenceKey: row.reference_key,
      datasetVersion: row.version,
      datasetKind: row.dataset_kind,
      contentHash: row.content_hash,
      dataScopeKey: request.dataScopeKey,
      datasetScopeKey: request.datasetScopeKey
    } : null;
  }

  async listLineFeatures(request: NetworkBuildRequest): Promise<readonly SourceLineFeature[]> {
    const result = await this.database.query<{
      reference_key: string;
      version: string;
      layer_key: string;
      content_hash: string;
      geometry: { type: string; coordinates: number[][] };
      properties: Record<string, unknown>;
    }>(`SELECT feature.reference_key,feature.version,layer.layer_key,
               feature.content_hash,feature.geometry,feature.properties
        FROM gowm_catalog_v1.feature_version feature
        JOIN gowm_catalog_v1.layer layer ON layer.reference_key=feature.layer_reference_key
        WHERE layer.dataset_reference_key=$1
          AND feature.version=(
            SELECT latest.version FROM gowm_catalog_v1.feature latest
            WHERE latest.reference_key=feature.reference_key
          )
          AND layer.layer_key = ANY($2::text[])
        ORDER BY feature.reference_key`, [request.datasetReferenceKey, request.allowedLayerKeys]);
    return result.rows.map((row) => {
      if (row.geometry?.type !== "LineString") throw new Error("network catalog feature is not a LineString");
      return {
        featureReferenceKey: row.reference_key,
        featureVersion: row.version,
        layerKey: row.layer_key,
        contentHash: row.content_hash,
        coordinates: row.geometry.coordinates.map((coordinate) => {
          const longitude = coordinate[0];
          const latitude = coordinate[1];
          const elevation = coordinate[2];
          if (longitude === undefined || latitude === undefined) throw new Error("network catalog coordinate is incomplete");
          return elevation === undefined ? [longitude, latitude] as const : [longitude, latitude, elevation] as const;
        }),
        properties: row.properties
      };
    });
  }
}
