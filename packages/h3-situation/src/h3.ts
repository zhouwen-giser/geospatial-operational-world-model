import {
  cellToBoundary,
  cellToChildren,
  cellToParent,
  getResolution,
  gridDisk,
  latLngToCell,
  polygonToCells
} from "h3-js";
import type { Geometry, H3Projection, PointGeometry, PolygonGeometry } from "../../world-model-core/src/types.js";

export const SUPPORTED_SITUATION_RESOLUTIONS = [7, 8, 9, 10] as const;

export function pointToH3(point: PointGeometry, resolution: number): string {
  const [lon, lat] = point.coordinates;
  return latLngToCell(lat, lon, resolution);
}

export function pointToMultiResolutionH3(point: PointGeometry): H3Projection {
  return {
    r7: pointToH3(point, 7),
    r8: pointToH3(point, 8),
    r9: pointToH3(point, 9),
    r10: pointToH3(point, 10)
  };
}

export function polygonToH3Cells(polygon: PolygonGeometry, resolution: number): string[] {
  return polygonToCells(polygon.coordinates as number[][][], resolution, true);
}

export function geometryToH3Cells(geometry: Geometry, resolution: number): string[] {
  if (geometry.type === "Point") return [pointToH3(geometry, resolution)];
  if (geometry.type === "Polygon") return polygonToH3Cells(geometry, resolution);
  if (geometry.type === "MultiPolygon") {
    return [...new Set(geometry.coordinates.flatMap((coordinates) => polygonToH3Cells({ type: "Polygon", coordinates }, resolution)))];
  }
  return [...new Set(geometry.coordinates.map((coordinates) => pointToH3({ type: "Point", coordinates }, resolution)))];
}

export function h3Neighbors(index: string, ringSize = 1): string[] {
  return gridDisk(index, ringSize);
}

export function h3Parent(index: string, resolution: number): string {
  return cellToParent(index, resolution);
}

export function h3Children(index: string, resolution: number): string[] {
  return cellToChildren(index, resolution);
}

export function h3Resolution(index: string): number {
  return getResolution(index);
}

export function h3Boundary(index: string): PolygonGeometry {
  const boundary = cellToBoundary(index, true).map(([lon, lat]) => [lon, lat] as [number, number]);
  const first = boundary[0];
  if (first) boundary.push(first);
  return { type: "Polygon", coordinates: [boundary] };
}

export function rollupCell(index: string, targetResolution: number): string {
  const resolution = h3Resolution(index);
  if (targetResolution > resolution) throw new Error("rollup target resolution must be coarser");
  return targetResolution === resolution ? index : h3Parent(index, targetResolution);
}
