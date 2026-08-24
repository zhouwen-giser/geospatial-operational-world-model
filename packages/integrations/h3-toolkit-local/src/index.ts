import {
  cellToBoundary,
  cellToChildren,
  cellToParent,
  getResolution,
  gridDisk,
  latLngToCell,
  polygonToCells
} from "h3-js";
import type {
  H3KernelPoint,
  H3KernelPolygonCoordinates,
  H3KernelPort,
  H3KernelPosition
} from "../../../platform/h3-kernel-port/src/index.js";

export const H3_TOOLKIT_SOURCE_REF =
  "zhouwen-giser/h3-spatial-toolkit@74fc8657072dd58a2f8e4317c1caef8bfd10e024";

/**
 * Local integration adapter for the H3 Spatial Toolkit 0.3.0 kernel. It calls
 * the same locked h3-js 4.5.0 engine used by that toolkit; no GOWM grid
 * algorithm is implemented here.
 */
export class H3ToolkitLocalAdapter implements H3KernelPort {
  readonly sourceLock = Object.freeze({
    adapter: "h3-spatial-toolkit-local",
    adapterVersion: "0.2.0",
    engine: "h3-js",
    engineVersion: "4.5.0",
    sourceRef: H3_TOOLKIT_SOURCE_REF
  });

  pointToCell(point: H3KernelPoint, resolution: number): string {
    return latLngToCell(point.latitude, point.longitude, resolution);
  }

  polygonToCells(coordinates: H3KernelPolygonCoordinates, resolution: number): string[] {
    return polygonToCells(coordinates, resolution, true);
  }

  cellToBoundary(cell: string): H3KernelPosition[] {
    return cellToBoundary(cell, true).map(([longitude, latitude]) => [longitude, latitude]);
  }

  cellToParent(cell: string, resolution: number): string {
    return cellToParent(cell, resolution);
  }

  cellToChildren(cell: string, resolution: number): string[] {
    return cellToChildren(cell, resolution);
  }

  cellResolution(cell: string): number {
    return getResolution(cell);
  }

  gridDisk(cell: string, radius: number): string[] {
    return gridDisk(cell, radius);
  }
}
