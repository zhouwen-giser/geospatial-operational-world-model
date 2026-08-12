import type { ObservationEnvelope } from "../../packages/world-model-core/src/types.js";

export interface SimulationOptions {
  vehicleCount: number;
  tick: number;
  startTimeMs: number;
  centerLon?: number;
  centerLat?: number;
  tickIntervalMs?: number;
}

export function generatePositionObservations(options: SimulationOptions): ObservationEnvelope[] {
  const centerLon = options.centerLon ?? 116.4;
  const centerLat = options.centerLat ?? 39.9;
  const timestamp = new Date(options.startTimeMs + options.tick * (options.tickIntervalMs ?? 1_000)).toISOString();
  return Array.from({ length: options.vehicleCount }, (_, index) => {
    const angle = options.tick * 0.025 + index * 0.37;
    const radius = 0.01 + (index % 20) * 0.0015;
    let lon = centerLon + Math.cos(angle) * radius;
    let lat = centerLat + Math.sin(angle) * radius * 0.7;
    const entityId = index === 2
      ? "ugv-003"
      : index === 3
        ? "uav-sim-001"
        : `vehicle-sim-${String(index + 1).padStart(5, "0")}`;
    const entityType = index === 2 ? "UGV" : index === 3 ? "UAV" : "Vehicle";
    if (index === 2) {
      // Deterministic west-to-east crossing through AOI-1 during ticks 0-40.
      lon = 116.382 + Math.min(50, options.tick) * 0.0007;
      lat = 39.902;
    }
    return {
      observationId: `sim-${entityId}-${options.tick}`,
      observer: { type: "Agent", id: "iot-simulator" },
      subject: { type: entityType, id: entityId },
      observationType: "position",
      geometry: { type: "Point", coordinates: [lon, lat] },
      value: {
        status: "MOVING",
        speed: 4 + (index % 12),
        heading: ((angle * 180) / Math.PI + 90) % 360
      },
      confidence: 0.96,
      observedAt: timestamp,
      receivedAt: new Date(Date.parse(timestamp) + 10 + (index % 5)).toISOString(),
      source: "simulator",
      correlationId: `sim-tick-${options.tick}`,
      metadata: { simulator: "gowm-iot-simulator", tick: options.tick },
      schemaVersion: "1.0"
    } satisfies ObservationEnvelope;
  });
}

export function generateSensorObservations(tick: number, startTimeMs: number, sensorCount = 20, tickIntervalMs = 1_000): ObservationEnvelope[] {
  const timestamp = new Date(startTimeMs + tick * tickIntervalMs).toISOString();
  return Array.from({ length: sensorCount }, (_, index) => ({
    observationId: `sim-sensor-${index + 1}-${tick}`,
    observer: { type: "Sensor", id: `sensor-sim-${String(index + 1).padStart(3, "0")}` },
    subject: { type: "Situation", id: `air-cell-${index % 5}` },
    observationType: "air_quality",
    geometry: {
      type: "Point",
      coordinates: [116.37 + (index % 5) * 0.015, 39.88 + Math.floor(index / 5) * 0.012]
    },
    value: { pm25: 20 + ((tick * 7 + index * 13) % 80) },
    confidence: 0.9,
    observedAt: timestamp,
    receivedAt: new Date(Date.parse(timestamp) + 20).toISOString(),
    source: "sensor",
    correlationId: `sim-sensor-tick-${tick}`,
    metadata: { simulated: true },
    schemaVersion: "1.0"
  } satisfies ObservationEnvelope));
}

export function generateCameraObservations(tick: number, startTimeMs: number, cameraCount = 4, tickIntervalMs = 1_000): ObservationEnvelope[] {
  const positions = generatePositionObservations({ vehicleCount: Math.max(10, cameraCount + 4), tick, startTimeMs, tickIntervalMs });
  return Array.from({ length: cameraCount }, (_, index) => {
    const target = positions[index + 4]!;
    if (!target.geometry) throw new Error("camera simulation target requires geometry");
    return {
      observationId: `sim-camera-${index + 1}-${tick}`,
      observer: { type: "Camera", id: `camera-sim-${String(index + 1).padStart(2, "0")}` },
      subject: target.subject,
      observationType: "position",
      geometry: target.geometry,
      value: { ...target.value, detectedClass: "vehicle" },
      confidence: 0.91,
      observedAt: target.observedAt,
      receivedAt: new Date(Date.parse(target.observedAt) + 35).toISOString(),
      source: "camera",
      correlationId: `sim-camera-frame-${tick}`,
      metadata: { simulated: true, detector: "camera-sim-v1" },
      schemaVersion: "1.0"
    } satisfies ObservationEnvelope;
  });
}

export function generateIncidentObservations(tick: number, startTimeMs: number, tickIntervalMs = 1_000): ObservationEnvelope[] {
  if (tick % 30 !== 0) return [];
  const timestamp = new Date(startTimeMs + tick * tickIntervalMs).toISOString();
  const incidentNumber = Math.floor(tick / 30) + 1;
  return [{
    observationId: `sim-incident-${incidentNumber}-${tick}`,
    observer: { type: "Agent", id: "situation-simulator" },
    subject: { type: "Incident", id: `incident-sim-${String(incidentNumber).padStart(3, "0")}` },
    observationType: "incident_status",
    geometry: { type: "Point", coordinates: [116.405 + (incidentNumber % 3) * 0.004, 39.902] },
    value: { status: "OPEN", severity: incidentNumber % 2 ? "HIGH" : "MEDIUM" },
    confidence: 0.98,
    observedAt: timestamp,
    receivedAt: new Date(Date.parse(timestamp) + 25).toISOString(),
    source: "simulator",
    correlationId: `sim-incident-tick-${tick}`,
    metadata: { simulated: true },
    schemaVersion: "1.0"
  }];
}
