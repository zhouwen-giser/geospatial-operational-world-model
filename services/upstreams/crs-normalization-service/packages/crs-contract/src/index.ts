export const TARGET_CRS = "EPSG:4326" as const;
export const AXIS_ORDER = ["longitude", "latitude"] as const;

export type SourceCrs = `EPSG:${number}` | "WGS84" | "WGS 84" | string;
export type Position = number[];

export interface PointGeometry {
  type: "Point";
  coordinates: Position;
  [key: string]: unknown;
}

export interface MultiPointGeometry {
  type: "MultiPoint";
  coordinates: Position[];
  [key: string]: unknown;
}

export interface LineStringGeometry {
  type: "LineString";
  coordinates: Position[];
  [key: string]: unknown;
}

export interface MultiLineStringGeometry {
  type: "MultiLineString";
  coordinates: Position[][];
  [key: string]: unknown;
}

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Position[][];
  [key: string]: unknown;
}

export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: Position[][][];
  [key: string]: unknown;
}

export interface GeometryCollectionGeometry {
  type: "GeometryCollection";
  geometries: GeoJsonGeometry[];
  [key: string]: unknown;
}

export type GeoJsonGeometry =
  | PointGeometry
  | MultiPointGeometry
  | LineStringGeometry
  | MultiLineStringGeometry
  | PolygonGeometry
  | MultiPolygonGeometry
  | GeometryCollectionGeometry;

export interface GeoJsonFeature {
  type: "Feature";
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown> | null;
  id?: string | number;
  [key: string]: unknown;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
  [key: string]: unknown;
}

export type CrsErrorCode =
  | "UNKNOWN_SOURCE_CRS"
  | "INVALID_CRS"
  | "INVALID_COORDINATE"
  | "INVALID_GEOMETRY"
  | "COORDINATE_OUT_OF_RANGE"
  | "GRID_REQUIRED"
  | "GRID_NOT_AVAILABLE"
  | "TRANSFORMATION_UNAVAILABLE"
  | "TRANSFORMATION_FAILED"
  | "TOO_MANY_COORDINATES"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL_ERROR";

export type CrsWarningCode =
  | "SOURCE_ALREADY_WGS84"
  | "GRID_FALLBACK"
  | "LOW_ACCURACY_TRANSFORMATION"
  | "Z_NOT_TRANSFORMED"
  | "BBOX_DROPPED";

export interface CrsWarning {
  code: CrsWarningCode;
  message: string;
}

export interface TransformationProvenance {
  engine: "PROJ";
  engineVersion: string;
  integration: "gdal-async";
  integrationVersion: string;
  sourceCrs: string;
  targetCrs: typeof TARGET_CRS;
  strictBestOperation: true;
  networkEnabled: false;
  cacheHit: boolean;
}

export interface NormalizationMetadata {
  crs: typeof TARGET_CRS;
  axisOrder: typeof AXIS_ORDER;
  coordinateCount: number;
  zTransformed: false;
  transformation: TransformationProvenance;
  warnings: CrsWarning[];
}

export interface NormalizedPointResponse extends NormalizationMetadata {
  coordinate: Position;
}

export interface NormalizedPointsResponse extends NormalizationMetadata {
  coordinates: Position[];
}

export interface NormalizedGeometryResponse extends NormalizationMetadata {
  geometry: GeoJsonGeometry;
}

export interface NormalizedFeatureResponse extends NormalizationMetadata {
  feature: GeoJsonFeature;
}

export interface NormalizedFeatureCollectionResponse extends NormalizationMetadata {
  featureCollection: GeoJsonFeatureCollection;
}

export interface PointNormalizeRequest {
  sourceCrs: SourceCrs;
  coordinate: Position;
}

export interface PointsNormalizeRequest {
  sourceCrs: SourceCrs;
  coordinates: Position[];
}

export interface GeometryNormalizeRequest {
  sourceCrs: SourceCrs;
  geometry: GeoJsonGeometry;
}

export interface FeatureNormalizeRequest {
  sourceCrs: SourceCrs;
  feature: GeoJsonFeature;
}

export interface FeatureCollectionNormalizeRequest {
  sourceCrs: SourceCrs;
  featureCollection: GeoJsonFeatureCollection;
}

export type UnifiedNormalizeRequest =
  | ({ kind: "point" } & PointNormalizeRequest)
  | ({ kind: "points" } & PointsNormalizeRequest)
  | ({ kind: "geometry" } & GeometryNormalizeRequest)
  | ({ kind: "feature" } & FeatureNormalizeRequest)
  | ({ kind: "featureCollection" } & FeatureCollectionNormalizeRequest);

export type UnifiedNormalizeResponse =
  | NormalizedPointResponse
  | NormalizedPointsResponse
  | NormalizedGeometryResponse
  | NormalizedFeatureResponse
  | NormalizedFeatureCollectionResponse;

export interface CheckSourceCrsResponse {
  sourceCrs: string;
  recognized: true;
  kind: "geographic" | "projected";
  traditionalGisInputOrder: ["longitude", "latitude"] | ["easting", "northing"];
  normalizationTarget: typeof TARGET_CRS;
  operationAvailability: "coordinate-and-grid-dependent";
}

export interface CrsErrorBody {
  code: CrsErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  requestId?: string;
}

export interface CrsErrorEnvelope {
  error: CrsErrorBody;
}

const ERROR_STATUS: Record<CrsErrorCode, number> = {
  UNKNOWN_SOURCE_CRS: 422,
  INVALID_CRS: 400,
  INVALID_COORDINATE: 400,
  INVALID_GEOMETRY: 400,
  COORDINATE_OUT_OF_RANGE: 422,
  GRID_REQUIRED: 422,
  GRID_NOT_AVAILABLE: 422,
  TRANSFORMATION_UNAVAILABLE: 422,
  TRANSFORMATION_FAILED: 422,
  TOO_MANY_COORDINATES: 413,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_ERROR: 500
};

export class CrsError extends Error {
  readonly code: CrsErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CrsErrorCode,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "CrsError";
    this.code = code;
    this.status = options.status ?? ERROR_STATUS[code];
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toBody(requestId?: string): CrsErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
        ...(requestId ? { requestId } : {})
      }
    };
  }
}

export function asCrsError(error: unknown): CrsError {
  if (error instanceof CrsError) {
    return error;
  }
  return new CrsError("INTERNAL_ERROR", "An unexpected internal error occurred.", {
    cause: error
  });
}
