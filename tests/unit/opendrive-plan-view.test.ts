import { describe, expect, it } from "vitest";
import { compileLaneGeometry, createAirportGeoreference, evaluateReference, type Lane, type Road } from "../../packages/opendrive-network-compiler/src/index.js";

function road(primitive: Road["geometries"][number]["primitive"]): Road {
  return { id: "test", name: "test", length: 10, junctionId: "-1", geometries: [{ s: 0, x: 0, y: 0, heading: 0, length: 10, primitive }], elevations: [{ s: 0, a: 1, b: 2, c: 0, d: 0 }], laneOffsets: [], laneSections: [], hasLateralProfile: false, objectCount: 0, signalCount: 0 };
}

describe("OpenDRIVE planView evaluation", () => {
  it("evaluates line and elevation polynomials", () => expect(evaluateReference(road({ kind: "line" }), 3)).toMatchObject({ x: 3, y: 0, z: 7, heading: 0 }));
  it("evaluates a circular arc analytically", () => {
    const point = evaluateReference(road({ kind: "arc", curvature: 0.1 }), 10);
    expect(point.x).toBeCloseTo(Math.sin(1) / 0.1, 12); expect(point.y).toBeCloseTo((1 - Math.cos(1)) / 0.1, 12); expect(point.heading).toBeCloseTo(1, 12);
  });
  it("executes a clothoid spiral and converges to the constant-curvature limit", () => {
    const spiral = evaluateReference(road({ kind: "spiral", curvatureStart: 0.1, curvatureEnd: 0.1 }), 10);
    const arc = evaluateReference(road({ kind: "arc", curvature: 0.1 }), 10);
    expect(spiral.x).toBeCloseTo(arc.x, 8); expect(spiral.y).toBeCloseTo(arc.y, 8); expect(spiral.heading).toBeCloseTo(arc.heading, 12);
  });
  it("applies piecewise laneOffset, cubic lane width, and elevation", () => {
    const lane: Lane = { id: -1, type: "driving", travelDirection: "forward", widths: [{ s: 0, a: 2, b: 0, c: 0, d: 0 }, { s: 5, a: 4, b: 0, c: 0, d: 0 }] };
    const source = road({ kind: "line" });
    source.elevations = [{ s: 0, a: 0, b: 1, c: 0, d: 0 }, { s: 5, a: 20, b: 0, c: 0, d: 0 }];
    source.laneOffsets = [{ s: 0, a: 0, b: 0, c: 0, d: 0 }, { s: 5, a: 2, b: 0, c: 0, d: 0 }];
    source.laneSections = [{ s: 0, lanes: [lane] }];
    const geometry = compileLaneGeometry(source, lane, createAirportGeoreference()); const atFive = geometry.localCoordinates.find((coordinate) => coordinate[0] === 5)!;
    expect(geometry.localCoordinates[0]).toEqual([0, -1, 0]); expect(atFive).toEqual([5, 0, 20]); expect(geometry.width).toEqual({ minM: 2, maxM: 4, meanM: 3 });
  });
  it("includes an internal cubic width extremum in exact minimum statistics", () => {
    const lane: Lane = { id: -1, type: "driving", travelDirection: "forward", widths: [{ s: 0, a: 4, b: -2, c: 1, d: 0 }] };
    const source = road({ kind: "line" }); source.laneSections = [{ s: 0, lanes: [lane] }]; source.elevations = [];
    const geometry = compileLaneGeometry(source, lane, createAirportGeoreference());
    expect(geometry.width.minM).toBe(3); expect(geometry.width.maxM).toBe(84); expect(geometry.localCoordinates.some((coordinate) => coordinate[0] === 1)).toBe(true);
  });
});
