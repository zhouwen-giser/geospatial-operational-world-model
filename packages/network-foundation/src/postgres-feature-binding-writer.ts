import type { PoolClient } from "pg";
import { sha256 } from "./canonical.js";
import type { BuiltNetworkTopology } from "./types.js";

type BindingTransaction = Pick<PoolClient, "query">;

export class PostgresNetworkFeatureBindingWriter {
  constructor(private readonly database: BindingTransaction) {}

  async persist(input: {
    readonly graphVersionId: string;
    readonly dataScopeKey: string;
    readonly topology: BuiltNetworkTopology;
    readonly edgeIdsByKey: ReadonlyMap<string, string>;
  }): Promise<void> {
    for (const edge of input.topology.edges) {
      const edgeId = input.edgeIdsByKey.get(edge.edgeKey);
      if (!edgeId) throw new Error("feature binding references an unavailable Edge");
      const source = await this.database.query<{ source_feature_id: string; source_feature_version_id: string }>(
        `SELECT source_feature_id::text,source_feature_version_id::text
         FROM resolve_network_build_source_feature($1,$2,$3)`,
        [input.graphVersionId, edge.sourceFeatureReferenceKey, edge.sourceFeatureVersion]
      );
      const sourceRow = source.rows[0];
      if (!sourceRow) throw new Error("authorized source Feature version is unavailable");
      const binding = {
        graphVersionId: input.graphVersionId,
        edgeKey: edge.edgeKey,
        sourceFeatureReferenceKey: edge.sourceFeatureReferenceKey,
        sourceFeatureVersion: edge.sourceFeatureVersion,
        splitStartPpm: edge.splitStartPpm,
        splitEndPpm: edge.splitEndPpm
      };
      await this.database.query(
        `INSERT INTO network_feature_binding(
           graph_version_id,data_scope_key,edge_id,source_feature_id,source_feature_version_id,
           source_feature_reference_key,binding_kind,split_start_ppm,split_end_ppm,evidence,content_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [input.graphVersionId, input.dataScopeKey, edgeId, sourceRow.source_feature_id,
          sourceRow.source_feature_version_id, edge.sourceFeatureReferenceKey,
          edge.splitStartPpm === 0 && edge.splitEndPpm === 1_000_000 ? "IDENTICAL" : "SPLIT_FROM",
          edge.splitStartPpm, edge.splitEndPpm, JSON.stringify([{ authority: "CatalogFeatureVersion" }]),
          sha256(binding)]
      );
    }
  }
}
