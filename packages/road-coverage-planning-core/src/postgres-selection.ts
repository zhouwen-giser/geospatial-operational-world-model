import { CoveragePlanningError } from "./errors.js";
import type {
  CoverageSelectionCandidate,
  CoverageSelectionRepository,
  CoverageSelectionRequest,
  CoverageSqlClient,
  CoverageSqlPool,
  GeoJsonArea
} from "./types.js";

export interface PostgresCoverageSelectionOptions {
  pool: CoverageSqlPool;
  statementTimeoutMs?: number;
}

export class PostgresCoverageSelectionRepository implements CoverageSelectionRepository {
  readonly #pool: CoverageSqlPool;
  readonly #statementTimeoutMs: number;

  constructor(options: PostgresCoverageSelectionOptions) {
    this.#pool = options.pool;
    this.#statementTimeoutMs = positive(options.statementTimeoutMs ?? 30_000, "statementTimeoutMs");
  }

  async select(request: CoverageSelectionRequest): Promise<CoverageSelectionCandidate[]> {
    const area = resolvedArea(request);
    return this.#transaction(request, async (client, graphVersionId) => {
      const result = await client.query(SELECTION_FUNCTION_SQL, [
        graphVersionId,
        area,
        request.policy.mode,
        request.policy.roadClasses,
        request.policy.minimumSegmentLengthMm,
        request.policy.boundaryToleranceMm ?? 0,
        request.maximumSelectionCandidates + 1,
        null
      ]);
      return result.rows.map(candidateFromRow);
    });
  }

  async validateManual(request: CoverageSelectionRequest, arcKeys: string[]): Promise<CoverageSelectionCandidate[]> {
    const uniqueArcKeys = [...new Set(arcKeys)];
    return this.#transaction(request, async (client, graphVersionId) => {
      const result = await client.query(SELECTION_FUNCTION_SQL, [
        graphVersionId,
        null,
        "MANUAL_OBLIGATIONS",
        request.policy.roadClasses,
        0,
        0,
        uniqueArcKeys.length + 1,
        uniqueArcKeys.map(internalArcKey)
      ]);
      const candidates = result.rows.map(candidateFromRow);
      if (candidates.length !== uniqueArcKeys.length) {
        throw new CoveragePlanningError("VERSION_NOT_FOUND", "one or more manual arcs are outside the pinned graph/scope or not service eligible");
      }
      return candidates;
    });
  }

  async #transaction<T>(
    request: CoverageSelectionRequest,
    operation: (client: CoverageSqlClient, graphVersionId: string) => Promise<T>
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${this.#statementTimeoutMs}ms'`);
      await client.query("SELECT gowm_network_v1.set_scope($1,$2)", [request.dataScopeKey, request.datasetScopeKey]);
      const graph = await client.query(
        "SELECT graph_version_id FROM gowm_network_v1.graph_version " +
          "WHERE graph_version=$1 AND dataset_version=$2 AND content_hash=$3 ORDER BY created_at DESC LIMIT 1",
        [request.routingSnapshot.graphVersion, request.routingSnapshot.networkDatasetVersion, request.routingSnapshot.graphContentHash]
      );
      const graphVersionId = stringValue(graph.rows[0]?.graph_version_id, "graph_version_id");
      const output = await operation(client, graphVersionId);
      await client.query("COMMIT");
      return output;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the primary failure */ }
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }
}

const SELECTION_FUNCTION_SQL = `SELECT * FROM gowm_network_v1.coverage_selection_candidates(
  $1::uuid,$2::jsonb,$3::text,$4::text[],$5::bigint,$6::bigint,$7::integer,$8::text[]
)`;

function candidateFromRow(row: Record<string, unknown>): CoverageSelectionCandidate {
  const internalArcKey = stringValue(row.arc_key, "arc_key");
  const arcKey = internalArcKey.startsWith("ar_") ? `arc_${internalArcKey.slice(3)}` : internalArcKey;
  const direction = row.direction;
  const oneway = row.oneway;
  if (direction !== "FORWARD" && direction !== "REVERSE") throw new Error("invalid arc direction");
  if (oneway !== "BIDIRECTIONAL" && oneway !== "FORWARD_ONLY" && oneway !== "REVERSE_ONLY") throw new Error("invalid edge oneway");
  return {
    graphVersion: stringValue(row.graph_version, "graph_version"),
    edgeKey: stringValue(row.edge_key, "edge_key"),
    arcKey,
    direction,
    oneway,
    startFractionPpm: integer(row.start_fraction_ppm, "start_fraction_ppm"),
    endFractionPpm: integer(row.end_fraction_ppm, "end_fraction_ppm"),
    requiredLengthMm: integer(row.required_length_mm, "required_length_mm"),
    roadClass: stringValue(row.road_class, "road_class"),
    sourceFeatureReferenceId: stringValue(row.source_feature_reference_key, "source_feature_reference_key")
  };
}

function internalArcKey(value: string): string {
  return value.startsWith("arc_") ? `ar_${value.slice(4)}` : value;
}

function resolvedArea(request: CoverageSelectionRequest): GeoJsonArea {
  const value = "type" in request.area ? request.area : request.resolvedArea;
  if (!value) throw new CoveragePlanningError("INVALID_AREA", "area ReferenceKey was not resolved");
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function integer(value: unknown, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function mapDatabaseError(error: unknown): CoveragePlanningError {
  if (error instanceof CoveragePlanningError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (code === "42501") return new CoveragePlanningError("SCOPE_DENIED", "network scope is unavailable", { cause: error });
  if (code === "22023" || code === "XX000") return new CoveragePlanningError("INVALID_AREA", "area geometry is invalid", { cause: error });
  if (code === "57014") return new CoveragePlanningError("RESOURCE_EXHAUSTED", "selection deadline exceeded", { cause: error });
  if (error instanceof Error && error.message === "graph_version_id is required") {
    return new CoveragePlanningError("VERSION_NOT_FOUND", "routing graph snapshot is unavailable in scope", { cause: error });
  }
  return new CoveragePlanningError("DATABASE_UNAVAILABLE", "coverage selection database query failed", { retryable: true, cause: error });
}
