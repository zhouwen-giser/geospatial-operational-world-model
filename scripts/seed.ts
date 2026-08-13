import { randomUUID } from "node:crypto";
import { databasePool, closeDatabasePool } from "../packages/runtime/src/db.js";
import { WorldRepository } from "../packages/runtime/src/world-repository.js";
import { ObservationRepository } from "../packages/runtime/src/observation-repository.js";
import { ProjectionProcessor } from "../packages/runtime/src/projection.js";
import type { ObservationEnvelope, PointGeometry, PolygonGeometry } from "../packages/world-model-core/src/types.js";
import { normalizeObservationInput } from "../packages/observation-model/src/canonical.js";

const AOI_1: PolygonGeometry = {
  type: "Polygon",
  coordinates: [[
    [116.390, 39.895], [116.410, 39.895], [116.410, 39.910],
    [116.390, 39.910], [116.390, 39.895]
  ]]
};

const AOI_7: PolygonGeometry = {
  type: "Polygon",
  coordinates: [[
    [116.360, 39.875], [116.450, 39.875], [116.450, 39.940],
    [116.360, 39.940], [116.360, 39.875]
  ]]
};

async function main(): Promise<void> {
  const pool = databasePool();
  const world = new WorldRepository(pool);
  const observations = new ObservationRepository(pool);
  const processor = new ProjectionProcessor(pool);
  const seedObservedAtMs = Date.now() - 1_000;

  await ensureObject(world, { id: "AOI-1", type: "Geofence", geometry: AOI_1, state: { status: "ACTIVE" }, properties: { name: "Demo geofence" }, confidence: 1 });
  await ensureObject(world, { id: "AOI-7", type: "AOI", geometry: AOI_7, state: { status: "ACTIVE" }, properties: { name: "Operations area 7" }, confidence: 1 });
  await ensureObject(world, { id: "facility-base-1", type: "Facility", geometry: point(116.400, 39.905), state: { status: "OPERATIONAL" }, properties: { name: "GOWM Base" }, confidence: 1 });

  const assets: Array<{ id: string; type: string; lon: number; lat: number; state: Record<string, unknown>; observer?: string }> = [];
  for (let index = 1; index <= 10; index += 1) {
    assets.push({
      id: `ugv-${String(index).padStart(3, "0")}`,
      type: "UGV",
      lon: 116.38 + index * 0.004,
      lat: 39.89 + (index % 4) * 0.006,
      state: { status: index <= 7 ? "AVAILABLE" : "BUSY", batteryPct: 95 - index * 3 }
    });
  }
  for (let index = 1; index <= 8; index += 1) {
    assets.push({ id: `vehicle-${String(index).padStart(3, "0")}`, type: "Vehicle", lon: 116.37 + index * 0.008, lat: 39.88 + (index % 5) * 0.01, state: { status: "MOVING" } });
  }
  for (let index = 1; index <= 4; index += 1) {
    assets.push({ id: `camera-${String(index).padStart(2, "0")}`, type: "Camera", lon: 116.385 + index * 0.012, lat: 39.89 + index * 0.008, state: { status: "ONLINE" } });
    assets.push({ id: `sensor-${String(index).padStart(2, "0")}`, type: "Sensor", lon: 116.38 + index * 0.014, lat: 39.885 + index * 0.009, state: { status: "ONLINE" } });
  }
  assets.push({ id: "incident-001", type: "Incident", lon: 116.405, lat: 39.902, state: { status: "OPEN", severity: "HIGH" } });

  for (const asset of assets) {
    const id = `seed-position-${asset.id}`;
    await ensureObject(world, { id: asset.id, type: asset.type, state: {}, properties: { seeded: true }, confidence: 1 });
    const observation: ObservationEnvelope = {
      observationId: id,
      observer: { type: "Agent", id: "seed-agent" },
      subject: { type: asset.type, id: asset.id },
      observationType: "position",
      geometry: point(asset.lon, asset.lat),
      value: asset.state,
      confidence: 0.99,
      observedAt: new Date(seedObservedAtMs).toISOString(),
      receivedAt: new Date(seedObservedAtMs + 10).toISOString(),
      source: "operator",
      correlationId: "seed-v1",
      metadata: { seed: true },
      schemaVersion: "1.0"
    };
    const inserted = await observations.insert(normalizeObservationInput(observation, new Date().toISOString()));
    if (inserted.status === "accepted") await processor.process(id);
  }

  const cameraRelations = await world.getRelations("camera-01");
  if (!cameraRelations.some((relation) => relation.relationType === "observes" && relation.toObjectId === "AOI-7")) {
    await world.createRelation({ relationType: "observes", fromObjectId: "camera-01", toObjectId: "AOI-7", persisted: true, properties: { fieldOfView: "AOI" } });
  }

  process.stdout.write(`${JSON.stringify({ status: "seeded", objectCount: assets.length + 3, runId: randomUUID() })}\n`);
}

function point(lon: number, lat: number): PointGeometry {
  return { type: "Point", coordinates: [lon, lat] };
}

async function ensureObject(world: WorldRepository, input: Parameters<WorldRepository["createObject"]>[0]): Promise<void> {
  if (!await world.getObject(input.id, false)) await world.createObject(input);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
