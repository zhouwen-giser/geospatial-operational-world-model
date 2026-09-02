import { geometrySchema, type Geometry, type Position } from "@geospatial/geometry-contract";

function checked<T extends Geometry>(geometry: T): T {
  return geometrySchema.parse(geometry) as T;
}

export const constructGeometry = {
  point(coordinates: Position): Geometry { return checked({ type: "Point", coordinates }); },
  multiPoint(coordinates: Position[]): Geometry { return checked({ type: "MultiPoint", coordinates }); },
  lineString(coordinates: Position[]): Geometry { return checked({ type: "LineString", coordinates }); },
  multiLineString(coordinates: Position[][]): Geometry { return checked({ type: "MultiLineString", coordinates }); },
  polygon(coordinates: Position[][]): Geometry { return checked({ type: "Polygon", coordinates }); },
  multiPolygon(coordinates: Position[][][]): Geometry { return checked({ type: "MultiPolygon", coordinates }); },
  geometryCollection(geometries: Geometry[]): Geometry { return checked({ type: "GeometryCollection", geometries }); },
  envelope(bbox: [number, number, number, number]): Geometry {
    const [minX, minY, maxX, maxY] = bbox;
    if (![minX, minY, maxX, maxY].every(Number.isFinite) || minX > maxX || minY > maxY) throw new TypeError("Invalid bounding box");
    if (minX === maxX && minY === maxY) return checked({ type: "Point", coordinates: [minX, minY] });
    if (minX === maxX || minY === maxY) return checked({ type: "LineString", coordinates: [[minX, minY], [maxX, maxY]] });
    return checked({ type: "Polygon", coordinates: [[[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY],[minX,minY]]] });
  },
};

export function withSridMetadata(geometry: Geometry, srid: number) {
  if (!Number.isInteger(srid) || srid < 0) throw new TypeError("SRID metadata must be a non-negative integer");
  return { geometry, srid } as const;
}
