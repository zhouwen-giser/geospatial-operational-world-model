import type { Geometry, LineStringGeometry, PointGeometry, PolygonGeometry } from "../../world-model-core/src/types.js";

const EARTH_RADIUS_M = 6_371_008.8;

function radians(value: number): number {
  return (value * Math.PI) / 180;
}

export function haversineDistanceM(a: PointGeometry, b: PointGeometry): number {
  const [lon1, lat1] = a.coordinates;
  const [lon2, lat2] = b.coordinates;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pointInRing(point: PointGeometry, ring: PolygonGeometry["coordinates"][number]): boolean {
  const [x, y] = point.coordinates;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (!pi || !pj) continue;
    const [xi, yi] = pi;
    const [xj, yj] = pj;
    const intersects = (yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(point: PointGeometry, polygon: PolygonGeometry): boolean {
  const [outer, ...holes] = polygon.coordinates;
  return outer !== undefined && pointInRing(point, outer) && !holes.some((ring) => pointInRing(point, ring));
}

export function geometryContainsPoint(area: Geometry, point: PointGeometry): boolean {
  if (area.type === "Polygon") return pointInPolygon(point, area);
  if (area.type === "MultiPolygon") {
    return area.coordinates.some((coordinates) => pointInPolygon(point, { type: "Polygon", coordinates }));
  }
  return false;
}

function localXY(point: PointGeometry, latitudeOrigin: number): [number, number] {
  const [lon, lat] = point.coordinates;
  return [radians(lon) * EARTH_RADIUS_M * Math.cos(radians(latitudeOrigin)), radians(lat) * EARTH_RADIUS_M];
}

export function pointToLineDistanceM(point: PointGeometry, line: LineStringGeometry): number {
  const latitudeOrigin = point.coordinates[1];
  const [px, py] = localXY(point, latitudeOrigin);
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < line.coordinates.length; index += 1) {
    const start = line.coordinates[index - 1];
    const end = line.coordinates[index];
    if (!start || !end) continue;
    const [ax, ay] = localXY({ type: "Point", coordinates: start }, latitudeOrigin);
    const [bx, by] = localXY({ type: "Point", coordinates: end }, latitudeOrigin);
    const dx = bx - ax;
    const dy = by - ay;
    const denominator = dx * dx + dy * dy;
    const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator));
    minimum = Math.min(minimum, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return minimum;
}

export function lineLengthM(line: LineStringGeometry): number {
  let length = 0;
  for (let index = 1; index < line.coordinates.length; index += 1) {
    const start = line.coordinates[index - 1];
    const end = line.coordinates[index];
    if (start && end) {
      length += haversineDistanceM({ type: "Point", coordinates: start }, { type: "Point", coordinates: end });
    }
  }
  return length;
}

export function geometryCentroid(geometry: Geometry): PointGeometry {
  if (geometry.type === "Point") return geometry;
  const positions: Array<[number, number] | [number, number, number]> = [];
  if (geometry.type === "LineString") positions.push(...geometry.coordinates);
  if (geometry.type === "Polygon") positions.push(...(geometry.coordinates[0] ?? []));
  if (geometry.type === "MultiPolygon") positions.push(...(geometry.coordinates[0]?.[0] ?? []));
  if (positions.length === 0) throw new Error("Cannot calculate centroid of empty geometry");
  const [lonSum, latSum] = positions.reduce<[number, number]>((sum, position) => [sum[0] + position[0], sum[1] + position[1]], [0, 0]);
  return { type: "Point", coordinates: [lonSum / positions.length, latSum / positions.length] };
}

export function validateGeometry(geometry: Geometry): string[] {
  const errors: string[] = [];
  const check = (position: readonly number[]) => {
    if (position.length < 2 || position[0] === undefined || position[1] === undefined) errors.push("coordinate requires longitude and latitude");
    else if (position[0] < -180 || position[0] > 180 || position[1] < -90 || position[1] > 90) errors.push("coordinate outside WGS84 bounds");
  };
  if (geometry.type === "Point") check(geometry.coordinates);
  if (geometry.type === "LineString") geometry.coordinates.forEach(check);
  if (geometry.type === "Polygon") {
    geometry.coordinates.flat().forEach(check);
    validatePolygonRings(geometry.coordinates, errors);
  }
  if (geometry.type === "MultiPolygon") {
    geometry.coordinates.flat(2).forEach(check);
    geometry.coordinates.forEach((polygon) => validatePolygonRings(polygon, errors));
  }
  if (geometry.type === "LineString" && distinct2d(geometry.coordinates).size < 2) errors.push("LineString requires two distinct coordinates");
  if (geometry.type !== "Point" && geometryPositions(geometry).some((position) => position.length > 2)) {
    errors.push("PoC supports altitude only for Point geometry");
  }
  return errors;
}

function geometryPositions(geometry: Exclude<Geometry, PointGeometry>): Array<readonly number[]> {
  if (geometry.type === "LineString") return geometry.coordinates;
  if (geometry.type === "Polygon") return geometry.coordinates.flat();
  return geometry.coordinates.flat(2);
}

function validatePolygonRings(rings: PolygonGeometry["coordinates"], errors: string[]): void {
  for (const ring of rings) {
    if (ring.length < 4) {
      errors.push("Polygon ring requires at least four coordinates");
      continue;
    }
    const first = ring[0];
    const last = ring.at(-1);
    if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) errors.push("Polygon ring must be closed");
    if (distinct2d(ring.slice(0, -1)).size < 3) errors.push("Polygon ring requires three distinct vertices");
    if (Math.abs(signedArea(ring)) < 1e-15) errors.push("Polygon ring has zero area");
    if (ringSelfIntersects(ring)) errors.push("Polygon ring self-intersects");
  }
}

function distinct2d(positions: ReadonlyArray<readonly number[]>): Set<string> {
  return new Set(positions.map((position) => `${position[0]},${position[1]}`));
}

function signedArea(ring: PolygonGeometry["coordinates"][number]): number {
  let sum = 0;
  for (let index = 1; index < ring.length; index += 1) {
    const a = ring[index - 1];
    const b = ring[index];
    if (a && b) sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function ringSelfIntersects(ring: PolygonGeometry["coordinates"][number]): boolean {
  const segmentCount = ring.length - 1;
  for (let left = 0; left < segmentCount; left += 1) {
    const a = ring[left];
    const b = ring[left + 1];
    if (!a || !b) continue;
    for (let right = left + 1; right < segmentCount; right += 1) {
      if (right === left || right === left + 1 || (left === 0 && right === segmentCount - 1)) continue;
      const c = ring[right];
      const d = ring[right + 1];
      if (c && d && properIntersection(a, b, c, d)) return true;
    }
  }
  return false;
}

function properIntersection(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): boolean {
  const orient = (p: readonly number[], q: readonly number[], r: readonly number[]) =>
    Math.sign((q[0]! - p[0]!) * (r[1]! - p[1]!) - (q[1]! - p[1]!) * (r[0]! - p[0]!));
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}
