import type { LineStringGeometry, TrajectoryPoint } from "../../world-model-core/src/types.js";
import { haversineDistanceM, pointToLineDistanceM } from "../../spatial-engine/src/geometry.js";

export interface StopWindow {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  pointCount: number;
  radiusM: number;
}

export function distanceTraveledM(points: TrajectoryPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous && current) total += haversineDistanceM(previous.geometry, current.geometry);
  }
  return total;
}

export function detectStops(points: TrajectoryPoint[], radiusM = 10, minimumDurationMs = 30_000): StopWindow[] {
  const results: StopWindow[] = [];
  let start = 0;
  for (let index = 1; index <= points.length; index += 1) {
    const anchor = points[start];
    const candidate = points[index];
    const within = anchor && candidate && haversineDistanceM(anchor.geometry, candidate.geometry) <= radiusM;
    if (within) continue;
    const end = points[index - 1];
    if (anchor && end) {
      const durationMs = Date.parse(end.timestamp) - Date.parse(anchor.timestamp);
      if (durationMs >= minimumDurationMs) {
        results.push({ startedAt: anchor.timestamp, endedAt: end.timestamp, durationMs, pointCount: index - start, radiusM });
      }
    }
    start = index;
  }
  return results;
}

export function detectRouteDeviation(points: TrajectoryPoint[], route: LineStringGeometry, toleranceM = 50): Array<{ timestamp: string; distanceM: number }> {
  return points
    .map((point) => ({ timestamp: point.timestamp, distanceM: pointToLineDistanceM(point.geometry, route) }))
    .filter((result) => result.distanceM > toleranceM);
}
