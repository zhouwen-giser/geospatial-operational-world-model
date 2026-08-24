import type { H3KernelPort } from "../../platform/h3-kernel-port/src/index.js";
import { H3ToolkitLocalAdapter } from "../../integrations/h3-toolkit-local/src/index.js";
import type { Geometry, H3Projection, PointGeometry, PolygonGeometry } from "../../world-model-core/src/types.js";

export const SUPPORTED_SITUATION_RESOLUTIONS = [7, 8, 9, 10] as const;

/** GOWM-owned Situation policy facade; generic grid computation is delegated. */
export class H3SituationIndex {
  constructor(private readonly kernel: H3KernelPort) {}

  sourceLock(): H3KernelPort["sourceLock"] {
    return this.kernel.sourceLock;
  }

  pointToH3(point: PointGeometry, resolution: number): string {
    const [longitude, latitude] = point.coordinates;
    return this.kernel.pointToCell({ longitude, latitude }, resolution);
  }

  pointToMultiResolutionH3(point: PointGeometry): H3Projection {
    return {
      r7: this.pointToH3(point, 7),
      r8: this.pointToH3(point, 8),
      r9: this.pointToH3(point, 9),
      r10: this.pointToH3(point, 10)
    };
  }

  polygonToH3Cells(polygon: PolygonGeometry, resolution: number): string[] {
    return this.kernel.polygonToCells(polygon.coordinates, resolution);
  }

  geometryToH3Cells(geometry: Geometry, resolution: number): string[] {
    if (geometry.type === "Point") return [this.pointToH3(geometry, resolution)];
    if (geometry.type === "Polygon") return this.polygonToH3Cells(geometry, resolution);
    if (geometry.type === "MultiPolygon") {
      return [...new Set(geometry.coordinates.flatMap((coordinates) =>
        this.polygonToH3Cells({ type: "Polygon", coordinates }, resolution)
      ))];
    }
    return [...new Set(geometry.coordinates.map((coordinates) =>
      this.pointToH3({ type: "Point", coordinates }, resolution)
    ))];
  }

  h3Neighbors(index: string, ringSize = 1): string[] {
    return this.kernel.gridDisk(index, ringSize);
  }

  h3Parent(index: string, resolution: number): string {
    return this.kernel.cellToParent(index, resolution);
  }

  h3Children(index: string, resolution: number): string[] {
    return this.kernel.cellToChildren(index, resolution);
  }

  h3Resolution(index: string): number {
    return this.kernel.cellResolution(index);
  }

  h3Boundary(index: string): PolygonGeometry {
    const boundary = this.kernel.cellToBoundary(index);
    const first = boundary[0];
    if (first) boundary.push(first);
    return { type: "Polygon", coordinates: [boundary] };
  }

  rollupCell(index: string, targetResolution: number): string {
    const resolution = this.h3Resolution(index);
    if (targetResolution > resolution) throw new Error("rollup target resolution must be coarser");
    return targetResolution === resolution ? index : this.h3Parent(index, targetResolution);
  }
}

const situationIndex = new H3SituationIndex(new H3ToolkitLocalAdapter());

// Compatibility exports retained for the v0.1 World/Situation APIs.
export const h3KernelSourceLock = (): H3KernelPort["sourceLock"] => situationIndex.sourceLock();
export const pointToH3 = (point: PointGeometry, resolution: number): string =>
  situationIndex.pointToH3(point, resolution);
export const pointToMultiResolutionH3 = (point: PointGeometry): H3Projection =>
  situationIndex.pointToMultiResolutionH3(point);
export const polygonToH3Cells = (polygon: PolygonGeometry, resolution: number): string[] =>
  situationIndex.polygonToH3Cells(polygon, resolution);
export const geometryToH3Cells = (geometry: Geometry, resolution: number): string[] =>
  situationIndex.geometryToH3Cells(geometry, resolution);
export const h3Neighbors = (index: string, ringSize = 1): string[] =>
  situationIndex.h3Neighbors(index, ringSize);
export const h3Parent = (index: string, resolution: number): string =>
  situationIndex.h3Parent(index, resolution);
export const h3Children = (index: string, resolution: number): string[] =>
  situationIndex.h3Children(index, resolution);
export const h3Resolution = (index: string): number => situationIndex.h3Resolution(index);
export const h3Boundary = (index: string): PolygonGeometry => situationIndex.h3Boundary(index);
export const rollupCell = (index: string, targetResolution: number): string =>
  situationIndex.rollupCell(index, targetResolution);
