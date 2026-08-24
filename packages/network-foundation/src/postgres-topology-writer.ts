import type { PoolClient } from "pg";
import type { BuiltNetworkTopology, NormalizedPosition } from "./types.js";

type TopologyTransaction = Pick<PoolClient, "query">;

export interface PersistNetworkTopologyRequest {
  readonly graphVersionId: string;
  readonly dataScopeKey: string;
  readonly topology: BuiltNetworkTopology;
}

export interface PersistedNetworkTopology {
  readonly nodeIdsByKey: ReadonlyMap<string, string>;
  readonly edgeIdsByKey: ReadonlyMap<string, string>;
  readonly arcIdsByKey: ReadonlyMap<string, string>;
}

function geoJsonLine(positions: readonly NormalizedPosition[]): string {
  return JSON.stringify({
    type: "LineString",
    coordinates: positions.map((position) => [
      position.longitudeNanodegrees / 1_000_000_000,
      position.latitudeNanodegrees / 1_000_000_000,
      position.elevationMm / 1000
    ])
  });
}

export class PostgresNetworkTopologyWriter {
  constructor(private readonly database: TopologyTransaction) {}

  async persist(request: PersistNetworkTopologyRequest): Promise<PersistedNetworkTopology> {
    const nodeIdsByKey = new Map<string, string>();
    const edgeIdsByKey = new Map<string, string>();
    const arcIdsByKey = new Map<string, string>();
    for (const node of request.topology.nodes) {
      const result = await this.database.query<{ node_id: string }>(
        `INSERT INTO network_node(
           graph_version_id,data_scope_key,node_key,geometry,elevation_mm,topology_identity
         ) VALUES ($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5,$6),4326),$7,$8::jsonb)
         RETURNING node_id::text`,
        [request.graphVersionId, request.dataScopeKey, node.nodeKey,
          node.position.longitudeNanodegrees / 1_000_000_000,
          node.position.latitudeNanodegrees / 1_000_000_000,
          node.position.elevationMm / 1000,
          node.position.elevationMm,
          JSON.stringify({ identity: node.topologyIdentity })]
      );
      const nodeId = result.rows[0]?.node_id;
      if (!nodeId) throw new Error("network node insert did not return an identity");
      nodeIdsByKey.set(node.nodeKey, nodeId);
    }
    for (const edge of request.topology.edges) {
      const sourceNodeId = nodeIdsByKey.get(edge.sourceNodeKey);
      const targetNodeId = nodeIdsByKey.get(edge.targetNodeKey);
      if (!sourceNodeId || !targetNodeId) throw new Error("network edge references an unavailable node");
      const result = await this.database.query<{ edge_id: string }>(
        `INSERT INTO network_edge(
           graph_version_id,data_scope_key,edge_key,source_node_id,target_node_id,
           source_feature_reference_key,geometry,length_mm,road_class,surface,
           is_bridge,is_tunnel,layer_level,oneway
         ) VALUES (
           $1,$2,$3,$4,$5,$6,ST_SetSRID(ST_GeomFromGeoJSON($7),4326),$8,$9,$10,$11,$12,$13,$14
         ) RETURNING edge_id::text`,
        [request.graphVersionId, request.dataScopeKey, edge.edgeKey, sourceNodeId, targetNodeId,
          edge.sourceFeatureReferenceKey, geoJsonLine(edge.positions), edge.lengthMm, edge.roadClass,
          edge.surface ?? null, edge.isBridge, edge.isTunnel, edge.layerLevel, edge.oneway]
      );
      const edgeId = result.rows[0]?.edge_id;
      if (!edgeId) throw new Error("network edge insert did not return an identity");
      edgeIdsByKey.set(edge.edgeKey, edgeId);
    }
    for (const arc of request.topology.arcs) {
      const edgeId = edgeIdsByKey.get(arc.edgeKey);
      const sourceNodeId = nodeIdsByKey.get(arc.sourceNodeKey);
      const targetNodeId = nodeIdsByKey.get(arc.targetNodeKey);
      if (!edgeId || !sourceNodeId || !targetNodeId) throw new Error("network arc references unavailable topology");
      const result = await this.database.query<{ arc_id: string }>(
        `INSERT INTO network_arc(
           graph_version_id,data_scope_key,arc_key,edge_id,source_node_id,target_node_id,
           direction,oriented_geometry,length_mm,default_speed_mm_per_s
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,ST_SetSRID(ST_GeomFromGeoJSON($8),4326),$9,$10
         ) RETURNING arc_id::text`,
        [request.graphVersionId, request.dataScopeKey, arc.arcKey, edgeId, sourceNodeId,
          targetNodeId, arc.direction, geoJsonLine(arc.positions), arc.lengthMm,
          arc.defaultSpeedMmPerS]
      );
      const arcId = result.rows[0]?.arc_id;
      if (!arcId) throw new Error("network arc insert did not return an identity");
      arcIdsByKey.set(arc.arcKey, arcId);
    }
    return { nodeIdsByKey, edgeIdsByKey, arcIdsByKey };
  }
}
