import { describe, expect, it } from "vitest";
import {
  generateCameraObservations,
  generateIncidentObservations,
  generatePositionObservations,
  generateSensorObservations
} from "../../simulator/src/generator.js";

describe("IoT simulator coverage", () => {
  it("generates Vehicle, UGV, UAV, Camera, Sensor and Incident evidence", () => {
    const start = Date.parse("2026-08-11T00:00:00Z");
    const positions = generatePositionObservations({ vehicleCount: 10, tick: 0, startTimeMs: start });
    const observations = [
      ...positions,
      ...generateSensorObservations(0, start),
      ...generateCameraObservations(0, start),
      ...generateIncidentObservations(0, start)
    ];
    expect(new Set(positions.map((entry) => entry.subject.type))).toEqual(new Set(["Vehicle", "UGV", "UAV"]));
    expect(observations.some((entry) => entry.observer.type === "Camera")).toBe(true);
    expect(observations.some((entry) => entry.observer.type === "Sensor")).toBe(true);
    expect(observations.some((entry) => entry.subject.type === "Incident")).toBe(true);
  });
});
