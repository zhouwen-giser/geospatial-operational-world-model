import { describe, expect, it } from "vitest";
import { h3Parent, pointToH3 } from "../../packages/h3-situation/src/h3.js";
import { MemoryWorldModel, makeObservation } from "../../packages/runtime/src/memory-world.js";
import { generatePositionObservations } from "../../simulator/src/generator.js";
import type { PolygonGeometry } from "../../packages/world-model-core/src/types.js";

const baseTime = Date.parse("2026-08-11T00:10:00.000Z");
const now = () => baseTime;
const aoi: PolygonGeometry = {
  type: "Polygon",
  coordinates: [[[116.39, 39.895], [116.41, 39.895], [116.41, 39.91], [116.39, 39.91], [116.39, 39.895]]]
};

function position(id: string, type: string, lon: number, lat: number, status = "AVAILABLE", source = "operator", offsetMs = 0) {
  return makeObservation({
    observationId: `${source}-${id}-${offsetMs}`,
    observer: { type: source === "uav" ? "UAV" : "Camera", id: `${source}-observer` },
    subject: { type, id },
    observationType: "position",
    geometry: { type: "Point", coordinates: [lon, lat] },
    value: { status },
    confidence: source === "camera" ? 0.91 : 0.96,
    observedAt: new Date(baseTime - 5_000 + offsetMs).toISOString(),
    receivedAt: new Date(baseTime - 4_990 + offsetMs).toISOString(),
    source
  });
}

describe("GOWM C1-C10 scenarios", () => {
  it("C1 finds the nearest five available UGVs", () => {
    const model = new MemoryWorldModel({ now });
    for (let index = 0; index < 8; index += 1) {
      model.publishObservation(position(`ugv-${index}`, "UGV", 116.4 + index * 0.002, 39.9, index < 6 ? "AVAILABLE" : "BUSY"));
    }
    const results = model.findNearby({ type: "Point", coordinates: [116.4, 39.9] }, {
      types: ["UGV"], radiusM: 5_000, filter: { status: "AVAILABLE" }, limit: 5
    });
    expect(results).toHaveLength(5);
    expect(results[0]?.object.id).toBe("ugv-0");
  });

  it("C2 combines world, spatial and H3 area situation", () => {
    const model = new MemoryWorldModel({ now });
    model.createObject({ id: "AOI-7", type: "AOI", geometry: aoi });
    model.publishObservation(position("agent-1", "Agent", 116.4, 39.9));
    model.publishObservation(position("vehicle-1", "Vehicle", 116.401, 39.9));
    model.publishObservation(position("incident-1", "Incident", 116.402, 39.9, "OPEN"));
    const objects = model.findInArea(aoi);
    const cell = model.getCell(pointToH3({ type: "Point", coordinates: [116.4, 39.9] }, 7));
    expect(objects.map((object) => object.type)).toEqual(expect.arrayContaining(["Agent", "Vehicle", "Incident"]));
    expect((cell?.metrics.agentCount ?? 0) + (cell?.metrics.vehicleCount ?? 0) + (cell?.metrics.incidentCount ?? 0)).toBeGreaterThanOrEqual(3);
  });

  it("C3 and C9 aggregate hotspots and drill down R7 to R9", () => {
    const model = new MemoryWorldModel({ now });
    for (let index = 0; index < 200; index += 1) {
      model.publishObservation(position(`hot-${index}`, "Vehicle", 116.4 + (index % 4) * 0.0001, 39.9 + (index % 3) * 0.0001, "MOVING", "camera", index));
    }
    for (let index = 0; index < 20; index += 1) {
      model.publishObservation(position(`cold-${index}`, "Vehicle", 116.45 + index * 0.0001, 39.95, "MOVING", "camera", index));
    }
    const r7 = model.hotspots(7, 1)[0];
    expect(r7).toBeTruthy();
    const r9 = model.hotspots(9, 10, r7!.h3Index);
    expect(r9.length).toBeGreaterThan(0);
    expect(r9.every((cell) => h3Parent(cell.h3Index, 7) === r7!.h3Index)).toBe(true);
  });

  it("C4 projects Observation into current state with provenance", () => {
    const model = new MemoryWorldModel({ now });
    const result = model.publishObservation(position("vehicle-8", "Vehicle", 116.4, 39.9));
    const state = model.getObject("vehicle-8");
    expect(result.status).toBe("projected");
    expect(state?.state.position).toEqual({ longitude: 116.4, latitude: 39.9 });
    expect(state?.provenance?.sourceObservationId).toBe("operator-vehicle-8-0");
    expect(state?.freshnessMs).toBe(5_000);
  });

  it("C5 resolves multi-source conflict by priority, confidence and time", () => {
    const model = new MemoryWorldModel({ now, sourcePriorities: { camera: 70, uav: 80 } });
    model.publishObservation(position("vehicle-8", "Vehicle", 116.4, 39.9, "SEEN", "camera", 0));
    model.publishObservation(position("vehicle-8", "Vehicle", 116.405, 39.905, "TRACKED", "uav", 1_000));
    const state = model.getObject("vehicle-8");
    expect(state?.geometry).toEqual({ type: "Point", coordinates: [116.405, 39.905] });
    expect(state?.provenance?.source).toBe("uav");
  });

  it("C6 emits ObjectEnteredArea without agent polling", () => {
    const model = new MemoryWorldModel({ now });
    model.createObject({ id: "AOI-1", type: "Geofence", geometry: aoi });
    model.publishObservation(position("ugv-3", "UGV", 116.38, 39.9, "MOVING", "operator", 0));
    model.publishObservation(position("ugv-3", "UGV", 116.4, 39.9, "MOVING", "operator", 6_000));
    const events = model.getEvents({ eventType: "ObjectEnteredArea", subjectId: "ugv-3", areaId: "AOI-1" });
    expect(events).toHaveLength(1);
  });

  it("C7 ingests 100 moving vehicles and separates current from history", () => {
    const model = new MemoryWorldModel({ now: () => baseTime + 20_000 });
    for (let tick = 0; tick < 10; tick += 1) {
      for (const observation of generatePositionObservations({ vehicleCount: 100, tick, startTimeMs: baseTime })) {
        model.publishObservation(observation);
      }
    }
    expect(model.stats().trajectoryPoints).toBe(1_000);
    expect(model.getTrack("vehicle-sim-00001")).toHaveLength(10);
    expect(model.getObject("vehicle-sim-00001")?.state.position).toBeTruthy();
  });

  it("C10 reconstructs the same state from immutable observations", () => {
    const model = new MemoryWorldModel({ now: () => baseTime + 60_000 });
    for (let tick = 0; tick < 20; tick += 1) {
      for (const observation of generatePositionObservations({ vehicleCount: 10, tick, startTimeMs: baseTime })) model.publishObservation(observation);
    }
    expect(model.replay().equal).toBe(true);
  });
});
