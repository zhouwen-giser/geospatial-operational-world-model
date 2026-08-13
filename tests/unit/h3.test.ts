import { describe, expect, it } from "vitest";
import { h3Children, h3Parent, h3Resolution, pointToH3, pointToMultiResolutionH3, polygonToH3Cells } from "../../packages/h3-situation/src/h3.js";

describe("H3 situation index", () => {
  it("projects a point at R7-R10 and preserves hierarchy", () => {
    const projection = pointToMultiResolutionH3({ type: "Point", coordinates: [116.4, 39.9] });
    expect(projection.r7).toBeTruthy();
    expect(h3Parent(projection.r10!, 7)).toBe(projection.r7);
    expect(h3Resolution(projection.r9!)).toBe(9);
    expect(h3Children(projection.r7!, 8)).toContain(projection.r8);
  });

  it("polyfills an operational area", () => {
    const cells = polygonToH3Cells({
      type: "Polygon",
      coordinates: [[[116.39, 39.89], [116.41, 39.89], [116.41, 39.91], [116.39, 39.91], [116.39, 39.89]]]
    }, 9);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells).toContain(pointToH3({ type: "Point", coordinates: [116.4, 39.9] }, 9));
  });
});
