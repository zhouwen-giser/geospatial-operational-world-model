import { CoveragePlanningError } from "./errors.js";
import type { CoverageEndpointRepository, EndpointCandidate } from "./endpoint.js";
import type {
  CoverageSqlClient,
  CoverageSqlPool,
  GeoJsonArea,
  DirectedState,
  NetworkLocation,
  ReferenceKey,
  RoutingSnapshot
} from "./types.js";

export class PostgresCoverageEndpointRepository implements CoverageEndpointRepository {
  constructor(readonly pool: CoverageSqlPool, readonly statementTimeoutMs = 15_000) {
    if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1) throw new Error("statementTimeoutMs is invalid");
  }

  async resolveLocation(
    location: NetworkLocation,
    snapshot: RoutingSnapshot,
    dataScopeKey: string,
    datasetScopeKey: string,
    _snapToleranceMm: number,
    maximumCandidates: number
  ): Promise<EndpointCandidate[]> {
    return this.#transaction(snapshot, dataScopeKey, datasetScopeKey, async (client, graphVersionId) => {
      if ("arcKey" in location) {
        const result = await client.query(
          `SELECT arc_key,direction,heading_microdegrees FROM gowm_network_v1.arc
           WHERE graph_version_id=$1::uuid AND arc_key=$2 ORDER BY arc_key LIMIT 1`,
          [graphVersionId, internalArcKey(location.arcKey)]
        );
        const row = result.rows[0];
        if (!row || row.direction !== location.direction) return [];
        return [{ state: { ...location }, distanceMm: 0, evidence: {
          method: "PINNED_DIRECTED_STATE", graphVersion: snapshot.graphVersion, arcKey: location.arcKey,
          fractionPpm: location.fractionPpm
        } }];
      }
      if ("coordinates" in location) {
        const [longitude, latitude] = location.coordinates;
        const result = await client.query(
          `SELECT snap.arc_key,snap.fraction_ppm,snap.distance_mm,arc.direction,arc.heading_microdegrees
           FROM gowm_network_v1.snap_candidates_wgs84($1::uuid,$2::float8,$3::float8,$4::integer) snap
           JOIN gowm_network_v1.arc arc ON arc.graph_version_id=$1::uuid AND arc.arc_key=snap.arc_key
           ORDER BY snap.distance_mm,snap.arc_key LIMIT $4::integer`,
          [graphVersionId, longitude, latitude, maximumCandidates]
        );
        return result.rows.map((row) => candidate(row, snapshot, "NETWORK_SNAP_WGS84"));
      }
      if (location.kind !== "LAYER_FEATURE") return [];
      const result = await client.query(
        `SELECT arc.arc_key,0::integer AS fraction_ppm,0::bigint AS distance_mm,arc.direction,arc.heading_microdegrees
         FROM gowm_network_v1.edge edge
         JOIN gowm_network_v1.arc arc ON arc.graph_version_id=edge.graph_version_id AND arc.edge_id=edge.edge_id
         WHERE edge.graph_version_id=$1::uuid AND edge.source_feature_reference_key=$2
         ORDER BY arc.arc_key LIMIT $3::integer`,
        [graphVersionId, location.id, maximumCandidates]
      );
      return result.rows.map((row) => candidate(row, snapshot, "LAYER_FEATURE_REFERENCE", location));
    });
  }

  async boundaryCandidates(
    area: GeoJsonArea,
    snapshot: RoutingSnapshot,
    dataScopeKey: string,
    datasetScopeKey: string,
    kind: "ENTRY" | "EXIT",
    maximumCandidates: number
  ): Promise<EndpointCandidate[]> {
    return this.#transaction(snapshot, dataScopeKey, datasetScopeKey, async (client, graphVersionId) => {
      const classes = await client.query("SELECT DISTINCT road_class FROM gowm_network_v1.edge WHERE graph_version_id=$1::uuid ORDER BY road_class", [graphVersionId]);
      const roadClasses = classes.rows.map((row) => text(row.road_class, "road_class"));
      const result = await client.query(
        `SELECT * FROM gowm_network_v1.coverage_selection_candidates(
          $1::uuid,$2::jsonb,'CLIPPED_INSIDE_AREA',$3::text[],0,0,$4::integer,NULL
        )`,
        [graphVersionId, area, roadClasses, Math.min(100_001, maximumCandidates * 8)]
      );
      return result.rows.flatMap((row) => {
        const fraction = kind === "ENTRY" ? integer(row.start_fraction_ppm) : integer(row.end_fraction_ppm);
        if ((kind === "ENTRY" && fraction === 0) || (kind === "EXIT" && fraction === 1_000_000)) return [];
        const arcKey = externalArcKey(text(row.arc_key, "arc_key"));
        const direction: DirectedState["direction"] = row.direction === "FORWARD" ? "FORWARD" : row.direction === "REVERSE" ? "REVERSE" : invalidDirection();
        return [{
          state: { arcKey, fractionPpm: fraction, direction },
          distanceMm: 0,
          evidence: { method: "POSTGIS_BOUNDARY_CROSSING", kind, graphVersion: snapshot.graphVersion, arcKey, fractionPpm: fraction }
        }];
      }).slice(0, maximumCandidates + 1);
    });
  }

  async #transaction<T>(
    snapshot: RoutingSnapshot,
    dataScopeKey: string,
    datasetScopeKey: string,
    operation: (client: CoverageSqlClient, graphVersionId: string) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`);
      await client.query("SELECT gowm_network_v1.set_scope($1,$2)", [dataScopeKey,datasetScopeKey]);
      const graph = await client.query(
        `SELECT graph_version_id FROM gowm_network_v1.graph_version
         WHERE graph_version=$1 AND dataset_version=$2 AND content_hash=$3 ORDER BY created_at DESC LIMIT 1`,
        [snapshot.graphVersion, snapshot.networkDatasetVersion, snapshot.graphContentHash]
      );
      const graphVersionId = text(graph.rows[0]?.graph_version_id, "graph_version_id");
      const result = await operation(client, graphVersionId);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
      if (error instanceof CoveragePlanningError) throw error;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      if (code === "42501") throw new CoveragePlanningError("SCOPE_DENIED", "endpoint scope is unavailable", { cause: error });
      if (error instanceof Error && error.message === "graph_version_id is required") {
        throw new CoveragePlanningError("VERSION_NOT_FOUND", "endpoint graph snapshot is unavailable", { cause: error });
      }
      throw new CoveragePlanningError("DATABASE_UNAVAILABLE", "endpoint read-contract query failed", { retryable: true, cause: error });
    } finally {
      client.release();
    }
  }
}

function candidate(row: Record<string, unknown>, snapshot: RoutingSnapshot, method: string, reference?: ReferenceKey): EndpointCandidate {
  const direction = row.direction;
  if (direction !== "FORWARD" && direction !== "REVERSE") throw new Error("invalid snap direction");
  const arcKey = externalArcKey(text(row.arc_key, "arc_key"));
  return {
    state: {
      arcKey,
      fractionPpm: integer(row.fraction_ppm),
      direction,
      ...(row.heading_microdegrees === null || row.heading_microdegrees === undefined ? {} : { headingMicrodegrees: integer(row.heading_microdegrees) })
    },
    distanceMm: integer(row.distance_mm),
    evidence: { method, graphVersion: snapshot.graphVersion, arcKey, ...(reference === undefined ? {} : { reference }) }
  };
}

function internalArcKey(value: string): string { return value.startsWith("arc_") ? `ar_${value.slice(4)}` : value; }
function externalArcKey(value: string): string { return value.startsWith("ar_") ? `arc_${value.slice(3)}` : value; }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new Error(`${name} is required`); return value; }
function integer(value: unknown): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("integer value is invalid"); return parsed; }
function invalidDirection(): never { throw new Error("invalid boundary direction"); }
