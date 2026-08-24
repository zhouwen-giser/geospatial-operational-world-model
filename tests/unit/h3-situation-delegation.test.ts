import { describe, expect, it, vi } from "vitest";
import type { H3KernelPort } from "../../packages/platform/h3-kernel-port/src/index.js";
import {
  H3SituationIndex,
  h3KernelSourceLock,
  pointToMultiResolutionH3
} from "../../packages/h3-situation/src/h3.js";

describe("GOWM H3 Situation authority boundary", () => {
  it("keeps the GOWM resolution policy while delegating every grid calculation", () => {
    const pointToCell = vi.fn((point: { longitude: number; latitude: number }, resolution: number) =>
      `cell-${point.longitude}-${point.latitude}-${resolution}`
    );
    const kernel: H3KernelPort = {
      sourceLock: {
        adapter: "test-kernel",
        adapterVersion: "1.0.0",
        engine: "test-engine",
        engineVersion: "1.0.0",
        sourceRef: "test@locked"
      },
      pointToCell,
      polygonToCells: vi.fn(() => []),
      cellToBoundary: vi.fn(() => []),
      cellToParent: vi.fn((cell) => cell),
      cellToChildren: vi.fn(() => []),
      cellResolution: vi.fn(() => 9),
      gridDisk: vi.fn(() => [])
    };
    const situation = new H3SituationIndex(kernel);

    expect(situation.pointToMultiResolutionH3({ type: "Point", coordinates: [116.4, 39.9] })).toEqual({
      r7: "cell-116.4-39.9-7",
      r8: "cell-116.4-39.9-8",
      r9: "cell-116.4-39.9-9",
      r10: "cell-116.4-39.9-10"
    });
    expect(pointToCell.mock.calls.map((call) => call[1])).toEqual([7, 8, 9, 10]);
    expect(situation.sourceLock()).toEqual(kernel.sourceLock);
  });

  it("retains compatible exports backed by the locked Toolkit engine", () => {
    const projection = pointToMultiResolutionH3({ type: "Point", coordinates: [116.4, 39.9] });

    expect(projection).toMatchObject({
      r7: expect.any(String),
      r8: expect.any(String),
      r9: expect.any(String),
      r10: expect.any(String)
    });
    expect(h3KernelSourceLock()).toEqual({
      adapter: "h3-spatial-toolkit-local",
      adapterVersion: "0.2.0",
      engine: "h3-js",
      engineVersion: "4.5.0",
      sourceRef: "zhouwen-giser/h3-spatial-toolkit@74fc8657072dd58a2f8e4317c1caef8bfd10e024"
    });
    expect(projection).not.toHaveProperty("worldVersion");
  });
});
