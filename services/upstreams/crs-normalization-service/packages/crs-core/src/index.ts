import {
  AXIS_ORDER,
  CrsError,
  TARGET_CRS,
  type CrsWarning,
  type CrsWarningCode,
  type FeatureCollectionNormalizeRequest,
  type FeatureNormalizeRequest,
  type GeoJsonFeature,
  type GeoJsonFeatureCollection,
  type GeoJsonGeometry,
  type GeometryNormalizeRequest,
  type NormalizationMetadata,
  type NormalizedFeatureCollectionResponse,
  type NormalizedFeatureResponse,
  type NormalizedGeometryResponse,
  type NormalizedPointResponse,
  type NormalizedPointsResponse,
  type PointNormalizeRequest,
  type PointsNormalizeRequest,
  type Position,
  type UnifiedNormalizeRequest,
  type UnifiedNormalizeResponse
} from "@geospatial/crs-contract";
import type {
  CoordinateEngine,
  PreparedTransformation
} from "@geospatial/proj-adapter";

export interface CrsNormalizerOptions {
  maxPoints?: number;
  maxVertices?: number;
}

interface CollectedInput {
  readonly positions: Position[];
  readonly hasPreservedDimensions: boolean;
  readonly hasBbox: boolean;
}

interface NormalizationRun {
  readonly positions: Position[];
  readonly metadata: NormalizationMetadata;
}

const DEFAULT_MAX_POINTS = 100_000;
const DEFAULT_MAX_VERTICES = 100_000;

export class CrsNormalizer {
  readonly maxPoints: number;
  readonly maxVertices: number;
  private readonly engine: CoordinateEngine;

  constructor(engine: CoordinateEngine, options: CrsNormalizerOptions = {}) {
    this.engine = engine;
    this.maxPoints = positiveInteger(options.maxPoints ?? DEFAULT_MAX_POINTS, "maxPoints");
    this.maxVertices = positiveInteger(
      options.maxVertices ?? DEFAULT_MAX_VERTICES,
      "maxVertices"
    );
  }

  normalizePoint(sourceCrs: unknown, coordinate: unknown): NormalizedPointResponse {
    const position = validatePosition(coordinate, "coordinate");
    const run = this.run(sourceCrs, {
      positions: [position],
      hasPreservedDimensions: position.length > 2,
      hasBbox: false
    }, this.maxPoints);
    return { coordinate: run.positions[0] as Position, ...run.metadata };
  }

  normalizePoints(sourceCrs: unknown, coordinates: unknown): NormalizedPointsResponse {
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
      throw new CrsError(
        "INVALID_COORDINATE",
        "coordinates must be a non-empty array of positions."
      );
    }
    const positions = coordinates.map((value, index) =>
      validatePosition(value, `coordinates[${index}]`)
    );
    const run = this.run(sourceCrs, {
      positions,
      hasPreservedDimensions: positions.some((position) => position.length > 2),
      hasBbox: false
    }, this.maxPoints);
    return { coordinates: run.positions, ...run.metadata };
  }

  normalizeGeometry(sourceCrs: unknown, geometry: unknown): NormalizedGeometryResponse {
    const collected = collectGeometry(geometry, "geometry");
    const run = this.run(sourceCrs, collected, this.maxVertices);
    let cursor = 0;
    const normalized = rebuildGeometry(geometry, () => run.positions[cursor++] as Position);
    return { geometry: normalized, ...run.metadata };
  }

  normalizeFeature(sourceCrs: unknown, feature: unknown): NormalizedFeatureResponse {
    const collected = collectFeature(feature, "feature");
    const run = this.run(sourceCrs, collected, this.maxVertices);
    let cursor = 0;
    const normalized = rebuildFeature(feature, () => run.positions[cursor++] as Position);
    return { feature: normalized, ...run.metadata };
  }

  normalizeFeatureCollection(
    sourceCrs: unknown,
    featureCollection: unknown
  ): NormalizedFeatureCollectionResponse {
    const collected = collectFeatureCollection(featureCollection, "featureCollection");
    const run = this.run(sourceCrs, collected, this.maxVertices);
    let cursor = 0;
    const normalized = rebuildFeatureCollection(
      featureCollection,
      () => run.positions[cursor++] as Position
    );
    return { featureCollection: normalized, ...run.metadata };
  }

  normalizeUnified(request: unknown): UnifiedNormalizeResponse {
    const value = record(request, "request");
    const kind = value.kind;
    switch (kind) {
      case "point": {
        const input = value as unknown as PointNormalizeRequest;
        return this.normalizePoint(input.sourceCrs, input.coordinate);
      }
      case "points": {
        const input = value as unknown as PointsNormalizeRequest;
        return this.normalizePoints(input.sourceCrs, input.coordinates);
      }
      case "geometry": {
        const input = value as unknown as GeometryNormalizeRequest;
        return this.normalizeGeometry(input.sourceCrs, input.geometry);
      }
      case "feature": {
        const input = value as unknown as FeatureNormalizeRequest;
        return this.normalizeFeature(input.sourceCrs, input.feature);
      }
      case "featureCollection": {
        const input = value as unknown as FeatureCollectionNormalizeRequest;
        return this.normalizeFeatureCollection(input.sourceCrs, input.featureCollection);
      }
      default:
        throw new CrsError(
          "INVALID_GEOMETRY",
          "kind must be point, points, geometry, feature, or featureCollection."
        );
    }
  }

  private run(
    sourceCrs: unknown,
    collected: CollectedInput,
    limit: number
  ): NormalizationRun {
    if (collected.positions.length > limit) {
      throw new CrsError(
        "TOO_MANY_COORDINATES",
        `Request contains ${collected.positions.length} coordinates; the configured limit is ${limit}.`,
        { details: { coordinateCount: collected.positions.length, limit } }
      );
    }

    const prepared = this.engine.prepare(sourceCrs);
    const transformed = collected.positions.map((position) => prepared.transform(position));
    return {
      positions: transformed,
      metadata: metadataFor(prepared, transformed.length, collected)
    };
  }
}

function metadataFor(
  prepared: PreparedTransformation,
  coordinateCount: number,
  collected: CollectedInput
): NormalizationMetadata {
  const warnings: CrsWarning[] = [];
  if (prepared.sourceAlreadyWgs84) {
    warnings.push({
      code: "SOURCE_ALREADY_WGS84",
      message: "The source was already EPSG:4326; validation and axis normalization were applied."
    });
  }
  if (collected.hasPreservedDimensions) {
    warnings.push({
      code: "Z_NOT_TRANSFORMED",
      message: "Only x/y were transformed; all trailing Z/M ordinates were preserved byte-for-number."
    });
  }
  if (collected.hasBbox) {
    warnings.push({
      code: "BBOX_DROPPED",
      message: "Input bbox members were dropped because retaining source-CRS bounds would be incorrect."
    });
  }
  return {
    crs: TARGET_CRS,
    axisOrder: AXIS_ORDER,
    coordinateCount,
    zTransformed: false,
    transformation: prepared.provenance,
    warnings: uniqueWarnings(warnings)
  };
}

function collectGeometry(value: unknown, path: string): CollectedInput {
  const positions: Position[] = [];
  const state = { hasPreservedDimensions: false, hasBbox: false };
  collectGeometryInto(value, path, positions, state);
  return { positions, ...state };
}

function collectGeometryInto(
  value: unknown,
  path: string,
  positions: Position[],
  state: { hasPreservedDimensions: boolean; hasBbox: boolean }
): void {
  const geometry = record(value, path);
  if ("bbox" in geometry) {
    state.hasBbox = true;
  }
  switch (geometry.type) {
    case "Point":
      collectCoordinateTree(geometry.coordinates, 0, `${path}.coordinates`, positions, state);
      return;
    case "MultiPoint":
    case "LineString":
      collectCoordinateTree(geometry.coordinates, 1, `${path}.coordinates`, positions, state);
      return;
    case "MultiLineString":
    case "Polygon":
      collectCoordinateTree(geometry.coordinates, 2, `${path}.coordinates`, positions, state);
      return;
    case "MultiPolygon":
      collectCoordinateTree(geometry.coordinates, 3, `${path}.coordinates`, positions, state);
      return;
    case "GeometryCollection": {
      if (!Array.isArray(geometry.geometries)) {
        throw new CrsError("INVALID_GEOMETRY", `${path}.geometries must be an array.`);
      }
      geometry.geometries.forEach((child, index) =>
        collectGeometryInto(child, `${path}.geometries[${index}]`, positions, state)
      );
      return;
    }
    default:
      throw new CrsError(
        "INVALID_GEOMETRY",
        `${path}.type must be a supported GeoJSON geometry type.`
      );
  }
}

function collectFeature(value: unknown, path: string): CollectedInput {
  const positions: Position[] = [];
  const state = { hasPreservedDimensions: false, hasBbox: false };
  collectFeatureInto(value, path, positions, state);
  return { positions, ...state };
}

function collectFeatureInto(
  value: unknown,
  path: string,
  positions: Position[],
  state: { hasPreservedDimensions: boolean; hasBbox: boolean }
): void {
  const feature = record(value, path);
  if (feature.type !== "Feature") {
    throw new CrsError("INVALID_GEOMETRY", `${path}.type must equal Feature.`);
  }
  if ("bbox" in feature) {
    state.hasBbox = true;
  }
  if (feature.geometry !== null) {
    collectGeometryInto(feature.geometry, `${path}.geometry`, positions, state);
  }
  if (feature.properties !== null && !isRecord(feature.properties)) {
    throw new CrsError("INVALID_GEOMETRY", `${path}.properties must be an object or null.`);
  }
  if (
    feature.id !== undefined &&
    typeof feature.id !== "string" &&
    typeof feature.id !== "number"
  ) {
    throw new CrsError("INVALID_GEOMETRY", `${path}.id must be a string or number.`);
  }
}

function collectFeatureCollection(value: unknown, path: string): CollectedInput {
  const collection = record(value, path);
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new CrsError(
      "INVALID_GEOMETRY",
      `${path} must be a GeoJSON FeatureCollection with a features array.`
    );
  }
  const positions: Position[] = [];
  const state = {
    hasPreservedDimensions: false,
    hasBbox: "bbox" in collection
  };
  collection.features.forEach((feature, index) =>
    collectFeatureInto(feature, `${path}.features[${index}]`, positions, state)
  );
  return { positions, ...state };
}

function collectCoordinateTree(
  value: unknown,
  depth: number,
  path: string,
  positions: Position[],
  state: { hasPreservedDimensions: boolean }
): void {
  if (depth === 0) {
    const position = validatePosition(value, path);
    positions.push(position);
    if (position.length > 2) {
      state.hasPreservedDimensions = true;
    }
    return;
  }
  if (!Array.isArray(value)) {
    throw new CrsError("INVALID_GEOMETRY", `${path} has invalid coordinate nesting.`);
  }
  value.forEach((child, index) =>
    collectCoordinateTree(child, depth - 1, `${path}[${index}]`, positions, state)
  );
}

function rebuildGeometry(value: unknown, next: () => Position): GeoJsonGeometry {
  const geometry = record(value, "geometry");
  const base = withoutBbox(geometry);
  switch (geometry.type) {
    case "Point":
      return { ...base, type: "Point", coordinates: rebuildCoordinateTree(geometry.coordinates, 0, next) as Position };
    case "MultiPoint":
      return { ...base, type: "MultiPoint", coordinates: rebuildCoordinateTree(geometry.coordinates, 1, next) as Position[] };
    case "LineString":
      return { ...base, type: "LineString", coordinates: rebuildCoordinateTree(geometry.coordinates, 1, next) as Position[] };
    case "MultiLineString":
      return { ...base, type: "MultiLineString", coordinates: rebuildCoordinateTree(geometry.coordinates, 2, next) as Position[][] };
    case "Polygon":
      return { ...base, type: "Polygon", coordinates: rebuildCoordinateTree(geometry.coordinates, 2, next) as Position[][] };
    case "MultiPolygon":
      return { ...base, type: "MultiPolygon", coordinates: rebuildCoordinateTree(geometry.coordinates, 3, next) as Position[][][] };
    case "GeometryCollection":
      return {
        ...base,
        type: "GeometryCollection",
        geometries: (geometry.geometries as unknown[]).map((child) => rebuildGeometry(child, next))
      };
    default:
      throw new CrsError("INVALID_GEOMETRY", "Unsupported geometry type during rebuild.");
  }
}

function rebuildFeature(value: unknown, next: () => Position): GeoJsonFeature {
  const feature = record(value, "feature");
  const base = withoutBbox(feature);
  return {
    ...base,
    type: "Feature",
    geometry: feature.geometry === null ? null : rebuildGeometry(feature.geometry, next),
    properties: feature.properties as Record<string, unknown> | null,
    ...(feature.id === undefined ? {} : { id: feature.id as string | number })
  };
}

function rebuildFeatureCollection(
  value: unknown,
  next: () => Position
): GeoJsonFeatureCollection {
  const collection = record(value, "featureCollection");
  const base = withoutBbox(collection);
  return {
    ...base,
    type: "FeatureCollection",
    features: (collection.features as unknown[]).map((feature) => rebuildFeature(feature, next))
  };
}

function rebuildCoordinateTree(value: unknown, depth: number, next: () => Position): unknown {
  if (depth === 0) {
    return next();
  }
  return (value as unknown[]).map((child) => rebuildCoordinateTree(child, depth - 1, next));
}

function validatePosition(value: unknown, path: string): Position {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    throw new CrsError(
      "INVALID_COORDINATE",
      `${path} must contain 2 to 4 numeric ordinates [x, y, z?, m?].`
    );
  }
  const position = value.map((ordinate, index) => {
    if (typeof ordinate !== "number" || !Number.isFinite(ordinate)) {
      throw new CrsError(
        "INVALID_COORDINATE",
        `${path}[${index}] must be a finite number.`
      );
    }
    return ordinate;
  });
  return position;
}

function withoutBbox(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  delete copy.bbox;
  return copy;
}

function uniqueWarnings(warnings: CrsWarning[]): CrsWarning[] {
  const seen = new Set<CrsWarningCode>();
  return warnings.filter((warning) => {
    if (seen.has(warning.code)) {
      return false;
    }
    seen.add(warning.code);
    return true;
  });
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CrsError("INVALID_GEOMETRY", `${path} must be a JSON object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CrsError("INVALID_COORDINATE", `${name} must be a positive safe integer.`);
  }
  return value;
}

export type {
  FeatureCollectionNormalizeRequest,
  FeatureNormalizeRequest,
  GeometryNormalizeRequest,
  PointNormalizeRequest,
  PointsNormalizeRequest,
  UnifiedNormalizeRequest
};
