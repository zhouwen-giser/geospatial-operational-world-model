import pg, { type PoolConfig, type QueryResult } from "pg";
import {
  GeometryServiceError,
  asGeometryServiceError,
  unwrapGeometry,
  type AdapterExecution,
  type Geometry,
  type GeometryEngineAdapter,
  type GeometryEnvelope,
  type GeometryOperation,
  type OperationRequest,
} from "@geospatial/geometry-contract";

const { Pool } = pg;

export interface PostgisQueryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  end?(): Promise<void>;
}

export interface PostgisAdapterOptions {
  connectionString?: string;
  poolConfig?: PoolConfig;
  queryable?: PostgisQueryable;
}

export class PostgisAdapter implements GeometryEngineAdapter {
  readonly name = "PostGIS-GEOS";
  version = "uninitialized";
  private readonly database: PostgisQueryable;
  private initialized = false;
  private readonly ownsPool: boolean;

  constructor(options: PostgisAdapterOptions = {}) {
    this.database = options.queryable ?? new Pool({
      ...(options.poolConfig ?? {}),
      connectionString: options.connectionString ?? process.env.POSTGIS_URL ?? "postgresql://geometry:geometry@localhost:5432/geometry",
      max: options.poolConfig?.max ?? 10,
      statement_timeout: options.poolConfig?.statement_timeout ?? 2_000,
      query_timeout: options.poolConfig?.query_timeout ?? 2_500,
    });
    this.ownsPool = !options.queryable;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const result = await this.database.query<{ version: string }>("SELECT postgis_full_version() AS version");
    this.version = result.rows[0]?.version ?? "unknown";
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.database.end?.();
    this.initialized = false;
  }

  async execute(request: OperationRequest): Promise<AdapterExecution> {
    await this.initialize();
    try {
      if (request.operation === "parse_wkt") return this.parseWkt(request);
      if (request.operation === "parse_wkb") return this.parseWkb(request);
      const input = this.requireInput(request.input, request.operation);
      const params = this.inputParameters(input, request.other);
      const a = "(SELECT a FROM inputs)";
      const b = "(SELECT b FROM inputs)";
      const grid = request.options?.precision?.gridSize;

      switch (request.operation) {
        case "parse_geojson":
        case "to_geojson":
          return { geometry: unwrapGeometry(input.geometry) };
        case "to_wkt":
          return { scalar: await this.scalar(`ST_AsText(${a})`, params) as string };
        case "to_wkb":
          return { scalar: await this.scalar(`encode(ST_AsEWKB(${a}), 'hex')`, params) as string };
        case "validate":
          return this.validation(params);
        case "make_valid":
          return this.geometry(`ST_MakeValid(${a})`, params);
        case "remove_repeated_points":
          return this.geometry(`ST_RemoveRepeatedPoints(${a}, $5::float8)`, [...params, this.numberParam(request, "tolerance", 0)]);
        case "normalize":
          return this.geometry(`ST_Normalize(${a})`, params);
        case "force_2d":
          return this.geometry(`ST_Force2D(${a})`, params);
        case "buffer": {
          const distance = this.requiredNumberParam(request, "distance");
          const quad = Math.trunc(this.numberParam(request, "quadrantSegments", 8));
          const endcap = this.stringParam(request, "endCapStyle", "round");
          const join = this.stringParam(request, "joinStyle", "round");
          const mitre = this.numberParam(request, "mitreLimit", 5);
          const side = this.booleanParam(request, "singleSided", false) ? (distance >= 0 ? "left" : "right") : "both";
          return this.geometry(`ST_Buffer(${a}, $5::float8, $6::text)`, [...params, distance, `quad_segs=${quad} endcap=${endcap} join=${join} mitre_limit=${mitre} side=${side}`]);
        }
        case "intersection":
          return this.geometry(grid === undefined ? `ST_Intersection(${a}, ${b})` : `ST_Intersection(${a}, ${b}, $5::float8)`, grid === undefined ? params : [...params, grid]);
        case "union":
          return this.geometry(grid === undefined ? `ST_Union(${a}, ${b})` : `ST_Union(${a}, ${b}, $5::float8)`, grid === undefined ? params : [...params, grid]);
        case "difference":
          return this.geometry(grid === undefined ? `ST_Difference(${a}, ${b})` : `ST_Difference(${a}, ${b}, $5::float8)`, grid === undefined ? params : [...params, grid]);
        case "symmetric_difference":
          return this.geometry(grid === undefined ? `ST_SymDifference(${a}, ${b})` : `ST_SymDifference(${a}, ${b}, $5::float8)`, grid === undefined ? params : [...params, grid]);
        case "unary_union":
          return this.geometry(grid === undefined ? `ST_UnaryUnion(${a})` : `ST_UnaryUnion(${a}, $5::float8)`, grid === undefined ? params : [...params, grid]);
        case "equals": return { scalar: await this.scalar(`ST_Equals(${a}, ${b})`, params) as boolean };
        case "disjoint": return { scalar: await this.scalar(`ST_Disjoint(${a}, ${b})`, params) as boolean };
        case "intersects": return { scalar: await this.scalar(`ST_Intersects(${a}, ${b})`, params) as boolean };
        case "touches": return { scalar: await this.scalar(`ST_Touches(${a}, ${b})`, params) as boolean };
        case "crosses": return { scalar: await this.scalar(`ST_Crosses(${a}, ${b})`, params) as boolean };
        case "within": return { scalar: await this.scalar(`ST_Within(${a}, ${b})`, params) as boolean };
        case "contains": return { scalar: await this.scalar(`ST_Contains(${a}, ${b})`, params) as boolean };
        case "overlaps": return { scalar: await this.scalar(`ST_Overlaps(${a}, ${b})`, params) as boolean };
        case "covers": return { scalar: await this.scalar(`ST_Covers(${a}, ${b})`, params) as boolean };
        case "covered_by": return { scalar: await this.scalar(`ST_CoveredBy(${a}, ${b})`, params) as boolean };
        case "relate": return { scalar: await this.scalar(`ST_Relate(${a}, ${b})`, params) as string };
        case "area": return { scalar: await this.scalar(`ST_Area(${a})`, params) as number };
        case "length": return { scalar: await this.scalar(`ST_Length(${a})`, params) as number };
        case "distance": return { scalar: await this.scalar(`ST_Distance(${a}, ${b})`, params) as number };
        case "hausdorff_distance": return { scalar: await this.scalar(`ST_HausdorffDistance(${a}, ${b})`, params) as number };
        case "minimum_clearance": return { scalar: await this.scalar(`ST_MinimumClearance(${a})`, params) as number };
        case "simplify": return this.geometry(`ST_Simplify(${a}, $5::float8)`, [...params, this.requiredNumberParam(request, "tolerance")]);
        case "simplify_preserve_topology": return this.geometry(`ST_SimplifyPreserveTopology(${a}, $5::float8)`, [...params, this.requiredNumberParam(request, "tolerance")]);
        case "snap": return this.geometry(`ST_Snap(${a}, ${b}, $5::float8)`, [...params, this.requiredNumberParam(request, "tolerance")]);
        case "reduce_precision": return this.geometry(`ST_ReducePrecision(${a}, $5::float8)`, [...params, grid ?? this.requiredNumberParam(request, "gridSize")]);
        case "centroid": return this.geometry(`ST_Centroid(${a})`, params);
        case "point_on_surface": return this.geometry(`ST_PointOnSurface(${a})`, params);
        case "bounding_box": return this.geometry(`ST_Envelope(${a})`, params);
        case "convex_hull": return this.geometry(`ST_ConvexHull(${a})`, params);
        case "concave_hull": return this.geometry(`ST_ConcaveHull(${a}, $5::float8, $6::boolean)`, [...params, this.numberParam(request, "ratio", 0.3), this.booleanParam(request, "allowHoles", false)]);
        case "line_merge": return this.geometry(`ST_LineMerge(${a})`, params);
        case "reverse": return this.geometry(`ST_Reverse(${a})`, params);
        case "substring": return this.geometry(`ST_LineSubstring(${a}, $5::float8, $6::float8)`, [...params, this.requiredNumberParam(request, "startFraction"), this.requiredNumberParam(request, "endFraction")]);
        case "interpolate_point": return this.geometry(`ST_LineInterpolatePoint(${a}, $5::float8)`, [...params, this.requiredNumberParam(request, "distance")]);
        case "project_point": return { scalar: await this.scalar(`ST_LineLocatePoint(${a}, ${b})`, params) as number };
        case "closest_point": return this.geometry(`ST_ClosestPoint(${a}, ${b})`, params);
        case "shortest_line": return this.geometry(`ST_ShortestLine(${a}, ${b})`, params);
        case "boundary": return this.geometry(`ST_Boundary(${a})`, params);
        case "minimum_rotated_rectangle": return this.geometry(`ST_OrientedEnvelope(${a})`, params);
        default:
          throw new GeometryServiceError({ code: "UNSUPPORTED_OPERATION", message: `${request.operation} is not mapped by the PostGIS spike`, operation: request.operation, recoverable: false });
      }
    } catch (error) {
      throw asGeometryServiceError(error, request.operation);
    }
  }

  private inputParameters(input: GeometryEnvelope, other?: GeometryEnvelope): unknown[] {
    return [
      JSON.stringify(unwrapGeometry(input.geometry)), input.srid ?? 0,
      other ? JSON.stringify(unwrapGeometry(other.geometry)) : null, other?.srid ?? input.srid ?? 0,
    ];
  }

  private cte(): string {
    return `WITH inputs AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::json), $2::int) AS a, CASE WHEN $3::json IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($3::json), $4::int) END AS b)`;
  }

  private async geometry(expression: string, params: unknown[]): Promise<AdapterExecution> {
    const result = await this.database.query<{ result: Geometry | null }>(`${this.cte()} SELECT ST_AsGeoJSON(${expression})::json AS result`, params);
    const geometry = result.rows[0]?.result;
    if (!geometry) throw new Error("PostGIS returned no geometry");
    return { geometry };
  }

  private async scalar(expression: string, params: unknown[]): Promise<unknown> {
    const result = await this.database.query<{ result: unknown }>(`${this.cte()} SELECT ${expression} AS result`, params);
    return result.rows[0]?.result;
  }

  private async validation(params: unknown[]): Promise<AdapterExecution> {
    const result = await this.database.query<{
      valid: boolean; reason: string | null; location: Geometry | null; simple: boolean; empty: boolean; closed: boolean | null; ring: boolean | null; rectangle: boolean | null;
    }>(`${this.cte()}
      SELECT d.valid, d.reason, ST_AsGeoJSON(d.location)::json AS location,
        ST_IsSimple(a) AS simple, ST_IsEmpty(a) AS empty,
        CASE WHEN GeometryType(a) IN ('LINESTRING','MULTILINESTRING') THEN ST_IsClosed(a) ELSE NULL END AS closed,
        CASE WHEN GeometryType(a) = 'LINESTRING' THEN ST_IsRing(a) ELSE NULL END AS ring,
        CASE WHEN GeometryType(a) = 'POLYGON' THEN ST_Equals(a, ST_Envelope(a)) ELSE NULL END AS rectangle
      FROM inputs CROSS JOIN LATERAL ST_IsValidDetail(a) d`, params);
    const row = result.rows[0];
    if (!row) throw new Error("PostGIS validation returned no row");
    return { scalar: row.valid, detail: row };
  }

  private async parseWkt(request: OperationRequest): Promise<AdapterExecution> {
    const wkt = request.parameters?.wkt;
    if (typeof wkt !== "string") throw new Error("parse_wkt requires parameters.wkt");
    const result = await this.database.query<{ result: Geometry }>("SELECT ST_AsGeoJSON(ST_GeomFromText($1::text, $2::int))::json AS result", [wkt, Number(request.parameters?.srid ?? 0)]);
    return { geometry: result.rows[0]!.result };
  }

  private async parseWkb(request: OperationRequest): Promise<AdapterExecution> {
    const wkbHex = request.parameters?.wkbHex;
    if (typeof wkbHex !== "string") throw new Error("parse_wkb requires parameters.wkbHex");
    const result = await this.database.query<{ result: Geometry }>("SELECT ST_AsGeoJSON(ST_GeomFromEWKB(decode($1::text, 'hex')))::json AS result", [wkbHex]);
    return { geometry: result.rows[0]!.result };
  }

  private requireInput(input: GeometryEnvelope | undefined, operation: GeometryOperation): GeometryEnvelope {
    if (!input) throw new Error(`${operation} requires input`);
    return input;
  }
  private requiredNumberParam(request: OperationRequest, name: string): number {
    const value = request.parameters?.[name];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${request.operation} requires finite parameters.${name}`);
    return value;
  }
  private numberParam(request: OperationRequest, name: string, fallback: number): number {
    const value = request.parameters?.[name];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }
  private booleanParam(request: OperationRequest, name: string, fallback: boolean): boolean {
    const value = request.parameters?.[name];
    return typeof value === "boolean" ? value : fallback;
  }
  private stringParam(request: OperationRequest, name: string, fallback: string): string {
    const value = request.parameters?.[name];
    return typeof value === "string" ? value : fallback;
  }
}
