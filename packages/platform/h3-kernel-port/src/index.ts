export interface H3KernelSourceLock {
  adapter: string;
  adapterVersion: string;
  engine: string;
  engineVersion: string;
  sourceRef: string;
}

export interface H3KernelPoint {
  longitude: number;
  latitude: number;
}

export type H3KernelPosition = [number, number] | [number, number, number];
export type H3KernelPolygonCoordinates = H3KernelPosition[][];

/**
 * Port for generic H3 primitives. GOWM Situation owns policy and world metrics;
 * an external/local H3 integration owns every grid algorithm behind this port.
 */
export interface H3KernelPort {
  readonly sourceLock: Readonly<H3KernelSourceLock>;
  pointToCell(point: H3KernelPoint, resolution: number): string;
  polygonToCells(coordinates: H3KernelPolygonCoordinates, resolution: number): string[];
  cellToBoundary(cell: string): H3KernelPosition[];
  cellToParent(cell: string, resolution: number): string;
  cellToChildren(cell: string, resolution: number): string[];
  cellResolution(cell: string): number;
  gridDisk(cell: string, radius: number): string[];
}
