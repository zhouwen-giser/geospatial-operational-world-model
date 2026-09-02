import type { Feature, Geometry, GeometryEnvelope, GeometryInput, GeometryInspection, Position } from "./types.js";

function isFeature(value: GeometryInput): value is Feature<Geometry> {
  return value.type === "Feature";
}

export function unwrapGeometry(input: GeometryInput): Geometry {
  if (isFeature(input)) {
    if (input.geometry === null) throw new TypeError("GeoJSON Feature geometry must not be null");
    return input.geometry;
  }
  return input;
}

function coordinateStats(value: unknown, depth = 0): {
  count: number;
  dimension: number;
  maxDepth: number;
  bbox?: [number, number, number, number];
  sample?: Position;
} {
  if (!Array.isArray(value)) return { count: 0, dimension: 0, maxDepth: depth };
  if (value.length === 0) return { count: 0, dimension: 0, maxDepth: depth };
  if (value.every((item) => typeof item === "number")) {
    const position = value as Position;
    const x = position[0];
    const y = position[1];
    const hasXY = Number.isFinite(x) && Number.isFinite(y);
    return {
      count: 1,
      dimension: position.length,
      maxDepth: depth,
      ...(hasXY ? { bbox: [x!, y!, x!, y!] as [number, number, number, number], sample: position } : {}),
    };
  }
  let count = 0;
  let dimension = 0;
  let maxDepth = depth;
  let bbox: [number, number, number, number] | undefined;
  let sample: Position | undefined;
  for (const item of value) {
    const child = coordinateStats(item, depth + 1);
    count += child.count;
    dimension = Math.max(dimension, child.dimension);
    maxDepth = Math.max(maxDepth, child.maxDepth);
    sample ??= child.sample;
    if (child.bbox) {
      bbox = bbox
        ? [Math.min(bbox[0], child.bbox[0]), Math.min(bbox[1], child.bbox[1]), Math.max(bbox[2], child.bbox[2]), Math.max(bbox[3], child.bbox[3])]
        : [...child.bbox];
    }
  }
  return { count, dimension, maxDepth, ...(bbox ? { bbox } : {}), ...(sample ? { sample } : {}) };
}

export function inspectGeometry(input: GeometryInput): GeometryInspection {
  const geometry = unwrapGeometry(input);
  if (geometry.type === "GeometryCollection") {
    let vertexCount = 0;
    let coordinateDimension = 0;
    let coordinateNestingDepth = 0;
    let collectionDepth = 1;
    let bbox: [number, number, number, number] | undefined;
    let samplePosition: Position | undefined;
    for (const child of geometry.geometries) {
      const inspected = inspectGeometry(child);
      vertexCount += inspected.vertexCount;
      coordinateDimension = Math.max(coordinateDimension, inspected.coordinateDimension);
      coordinateNestingDepth = Math.max(coordinateNestingDepth, inspected.coordinateNestingDepth);
      collectionDepth = Math.max(collectionDepth, inspected.collectionDepth + (child.type === "GeometryCollection" ? 1 : 0));
      samplePosition ??= inspected.samplePosition;
      if (inspected.bbox) {
        const childBox = inspected.bbox as [number, number, number, number];
        bbox = bbox
          ? [Math.min(bbox[0], childBox[0]), Math.min(bbox[1], childBox[1]), Math.max(bbox[2], childBox[2]), Math.max(bbox[3], childBox[3])]
          : [...childBox];
      }
    }
    return {
      geometry,
      type: geometry.type,
      empty: geometry.geometries.length === 0 || vertexCount === 0,
      vertexCount,
      coordinateDimension,
      collectionDepth,
      coordinateNestingDepth,
      ...(bbox ? { bbox } : {}),
      ...(samplePosition ? { samplePosition } : {}),
    };
  }
  const stats = coordinateStats(geometry.coordinates, 1);
  return {
    geometry,
    type: geometry.type,
    empty: stats.count === 0,
    vertexCount: stats.count,
    coordinateDimension: stats.dimension,
    collectionDepth: 0,
    coordinateNestingDepth: stats.maxDepth,
    ...(stats.bbox ? { bbox: stats.bbox } : {}),
    ...(stats.sample ? { samplePosition: stats.sample } : {}),
  };
}

export function isLikelyGeographicSrid(srid: number | undefined): boolean {
  return srid === 4326 || srid === 4269 || srid === 4258;
}

export function getGeometryType(input: GeometryInput): Geometry["type"] {
  return unwrapGeometry(input).type;
}

/** OGC topological dimension: point=0, curve=1, surface=2, empty=-1. */
export function getGeometryDimension(input: GeometryInput): -1 | 0 | 1 | 2 {
  const geometry = unwrapGeometry(input);
  if (inspectGeometry(geometry).empty) return -1;
  if (geometry.type === "Point" || geometry.type === "MultiPoint") return 0;
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") return 1;
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") return 2;
  let dimension: -1 | 0 | 1 | 2 = -1;
  for (const child of geometry.geometries) {
    dimension = Math.max(dimension, getGeometryDimension(child)) as -1 | 0 | 1 | 2;
  }
  return dimension;
}

export function getCoordinateDimension(input: GeometryInput): number {
  return inspectGeometry(input).coordinateDimension;
}

export function getSridMetadata(envelope: GeometryEnvelope): number | undefined {
  return envelope.srid;
}

export function setSridMetadata(envelope: GeometryEnvelope, srid: number): GeometryEnvelope {
  if (!Number.isInteger(srid) || srid < 0) throw new TypeError("SRID metadata must be a non-negative integer");
  return { ...envelope, srid };
}
