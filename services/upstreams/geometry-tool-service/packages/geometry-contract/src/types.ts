import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon, Position } from "geojson";

export type SupportedGeometry = Geometry;
export type GeometryInput = Geometry | Feature<Geometry>;
export type CollectionInput = GeometryInput[] | FeatureCollection;
export type CoordinateLayout = "XY" | "XYZ" | "XYM" | "XYZM";
export type ExecutionMode = "strict" | "lenient";
export type OutputFormat = "geojson" | "wkt" | "wkb-hex";

/**
 * Runtime allowlist and TypeScript source of truth for the neutral contract.
 * Boundary requests are intentionally recognized so Geometry Core can return a
 * typed delegation error instead of letting an adapter implement them silently.
 */
export const GEOMETRY_OPERATIONS = [
  "parse_geojson",
  "parse_wkt",
  "parse_wkb",
  "to_geojson",
  "to_wkt",
  "to_wkb",
  "validate",
  "make_valid",
  "remove_repeated_points",
  "normalize",
  "orient_polygon",
  "force_2d",
  "buffer",
  "intersection",
  "union",
  "difference",
  "symmetric_difference",
  "unary_union",
  "coverage_union",
  "equals",
  "disjoint",
  "intersects",
  "touches",
  "crosses",
  "within",
  "contains",
  "overlaps",
  "covers",
  "covered_by",
  "relate",
  "area",
  "length",
  "distance",
  "hausdorff_distance",
  "minimum_clearance",
  "simplify",
  "simplify_preserve_topology",
  "coverage_simplify",
  "snap",
  "reduce_precision",
  "centroid",
  "point_on_surface",
  "bounding_box",
  "convex_hull",
  "concave_hull",
  "line_merge",
  "reverse",
  "substring",
  "interpolate_point",
  "project_point",
  "closest_point",
  "shortest_line",
  "polygonize",
  "boundary",
  "minimum_rotated_rectangle",
  "collect",
  "explode",
  "geometry_hash",
  "reproject",
  "geodesic_distance",
  "geodesic_area",
  "geodesic_length",
  "spatial_join",
  "rasterize",
  "shortest_path",
  "h3_polyfill",
] as const;

export type GeometryOperation = (typeof GEOMETRY_OPERATIONS)[number];

export interface PrecisionOptions {
  gridSize: number;
  keepCollapsed?: boolean;
}

export interface CommonOptions {
  mode?: ExecutionMode;
  repairInvalid?: boolean;
  normalizeOutput?: boolean;
  precision?: PrecisionOptions;
  planar?: boolean;
  outputFormat?: OutputFormat;
}

export interface GeometryEnvelope {
  geometry: GeometryInput;
  srid?: number;
  coordinateLayout?: CoordinateLayout;
  options?: CommonOptions;
}

export interface BinaryGeometryRequest {
  a: GeometryEnvelope;
  b: GeometryEnvelope;
  options?: CommonOptions;
}

export interface BufferOptions extends CommonOptions {
  distance: number;
  quadrantSegments?: number;
  endCapStyle?: "round" | "flat" | "square";
  joinStyle?: "round" | "mitre" | "bevel";
  mitreLimit?: number;
  singleSided?: boolean;
}

export interface BufferRequest {
  input: GeometryEnvelope;
  options: BufferOptions;
}

export interface SimplifyOptions extends CommonOptions {
  tolerance: number;
  preserveTopology?: boolean;
  preserveCoverageBoundary?: boolean;
}

export interface SimplifyRequest {
  input: GeometryEnvelope;
  options: SimplifyOptions;
}

export type PredicateName =
  | "equals"
  | "disjoint"
  | "intersects"
  | "touches"
  | "crosses"
  | "within"
  | "contains"
  | "overlaps"
  | "covers"
  | "covered_by"
  | "relate";

export interface PredicateRequest extends BinaryGeometryRequest {
  predicate: PredicateName;
  pattern?: string;
}

export type MeasureName = "area" | "length" | "distance" | "hausdorff_distance" | "minimum_clearance";

export interface MeasureRequest {
  measure: MeasureName;
  input: GeometryEnvelope;
  other?: GeometryEnvelope;
  options?: CommonOptions;
}

export interface OperationRequest {
  operation: GeometryOperation;
  input?: GeometryEnvelope;
  other?: GeometryEnvelope;
  inputs?: GeometryEnvelope[];
  parameters?: Record<string, unknown>;
  options?: CommonOptions;
}

export type BatchOperationItem = Omit<OperationRequest, "operation"> & { operation?: GeometryOperation };

export interface BatchRequest {
  operation: GeometryOperation;
  items: BatchOperationItem[];
  continueOnError?: boolean;
}

export interface GeometryMetadata {
  type: string;
  empty: boolean;
  valid?: boolean;
  simple?: boolean;
  vertexCount: number;
  coordinateDimension: number;
  srid?: number;
  coordinateLayout?: CoordinateLayout;
  inputType?: string;
  typeChanged?: boolean;
  normalized?: boolean;
  precisionGridSize?: number;
  units?: "coordinate-space" | "coordinate-space-squared" | "dimensionless";
  bbox?: number[];
  area?: number;
  length?: number;
}

export interface ExecutionMetadata {
  engine: string;
  engineVersion: string;
  durationMs: number;
  operation: GeometryOperation;
  deterministicScope: "engine-version-input-options";
}

export interface GeometryResult {
  result: Geometry;
  summary: GeometryMetadata;
  warnings: string[];
  execution: ExecutionMetadata;
}

export interface ScalarResult<T = number | boolean | string> {
  result: T;
  summary: Partial<GeometryMetadata> & { units?: GeometryMetadata["units"] };
  warnings: string[];
  execution: ExecutionMetadata;
}

export interface ValidationDetail {
  valid: boolean;
  reason: string | null;
  location: Geometry | null;
  simple: boolean;
  empty: boolean;
  closed: boolean | null;
  ring: boolean | null;
  rectangle: boolean | null;
}

export interface ValidationResult extends ScalarResult<boolean> {
  result: boolean;
  detail: ValidationDetail;
}

export interface BatchItemSuccess {
  index: number;
  status: "success";
  value: GeometryResult | ScalarResult | ValidationResult;
}

export interface BatchItemFailure {
  index: number;
  status: "error";
  error: GeometryErrorPayload;
}

export interface BatchResult {
  results: Array<BatchItemSuccess | BatchItemFailure>;
  summary: { total: number; succeeded: number; failed: number; inputOrderPreserved: true };
}

export interface GeometryErrorPayload {
  code: GeometryErrorCode;
  message: string;
  operation?: GeometryOperation;
  geometryIndex?: number;
  recoverable: boolean;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export type GeometryErrorCode =
  | "INVALID_GEOMETRY"
  | "UNSUPPORTED_GEOMETRY_TYPE"
  | "INVALID_COORDINATE"
  | "EMPTY_GEOMETRY"
  | "TOO_MANY_VERTICES"
  | "GEOMETRY_TOO_LARGE"
  | "TOO_MANY_GEOMETRIES"
  | "NESTING_TOO_DEEP"
  | "TOPOLOGY_EXCEPTION"
  | "PRECISION_ERROR"
  | "OPERATION_TIMEOUT"
  | "UNSUPPORTED_OPERATION"
  | "ENGINE_ERROR"
  | "RESOURCE_LIMIT"
  | "SRID_MISMATCH"
  | "PLANAR_ACKNOWLEDGEMENT_REQUIRED"
  | "CRS_TRANSFORMATION_UNSUPPORTED"
  | "GEODESIC_OPERATION_UNSUPPORTED"
  | "SPATIAL_DATASET_OPERATION_UNSUPPORTED"
  | "RASTER_OPERATION_UNSUPPORTED"
  | "ROUTING_OPERATION_UNSUPPORTED"
  | "H3_OPERATION_UNSUPPORTED";

export interface ResourceLimits {
  maxBodyBytes: number;
  maxVerticesPerGeometry: number;
  maxTotalVerticesPerBatch: number;
  maxBatchItems: number;
  maxGeometryCollectionDepth: number;
  maxCoordinateNestingDepth: number;
  syncTimeoutMs: number;
}

export interface GeometryInspection {
  geometry: Geometry;
  type: string;
  empty: boolean;
  vertexCount: number;
  coordinateDimension: number;
  collectionDepth: number;
  coordinateNestingDepth: number;
  bbox?: number[];
  samplePosition?: Position;
}

export interface AdapterExecution {
  geometry?: Geometry;
  scalar?: number | boolean | string;
  detail?: ValidationDetail;
  warnings?: string[];
}

export interface GeometryEngineAdapter {
  readonly name: string;
  readonly version: string;
  initialize(): Promise<void>;
  execute(request: OperationRequest): Promise<AdapterExecution>;
  close(): Promise<void>;
}

export type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon, Position };
