import { describe, expect, it } from "vitest";
import { geometryContainsPoint, haversineDistanceM, pointToLineDistanceM, validateGeometry } from "../../packages/spatial-engine/src/geometry.js";
import type { PolygonGeometry } from "../../packages/world-model-core/src/types.js";

describe("spatial geometry", () => {
  it("computes geodetic distance in meters", () => {
    const distance = haversineDistanceM(
      { type: "Point", coordinates: [116.4, 39.9] },
      { type: "Point", coordinates: [116.41, 39.9] }
    );
    expect(distance).toBeGreaterThan(850);
    expect(distance).toBeLessThan(860);
  });

  it("checks polygon containment and holes", () => {
    const area: PolygonGeometry = {
      type: "Polygon",
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
      ]
    };
    expect(geometryContainsPoint(area, { type: "Point", coordinates: [2, 2] })).toBe(true);
    expect(geometryContainsPoint(area, { type: "Point", coordinates: [5, 5] })).toBe(false);
  });

  it("computes point-to-route distance", () => {
    const distance = pointToLineDistanceM(
      { type: "Point", coordinates: [116.4, 39.901] },
      { type: "LineString", coordinates: [[116.39, 39.9], [116.41, 39.9]] }
    );
    expect(distance).toBeGreaterThan(110);
    expect(distance).toBeLessThan(112);
  });

  it("rejects non-closed and self-intersecting polygon rings", () => {
    expect(validateGeometry({
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]]
    })).toContain("Polygon ring must be closed");
    expect(validateGeometry({
      type: "Polygon",
      coordinates: [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]]
    })).toContain("Polygon ring self-intersects");
  });
});
