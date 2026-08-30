import { createHash, randomUUID } from "node:crypto";
import { compareUnicodeCodePoints } from "../../platform/contract-runtime/src/index.js";
import type {
  Geometry,
  H3Projection,
  ObservationEnvelope,
  PointGeometry,
  SituationCell,
  SituationMetrics,
  TrajectoryPoint,
  WorldEvent,
  WorldObject
} from "../../world-model-core/src/types.js";
import { haversineDistanceM, geometryContainsPoint } from "../../spatial-engine/src/geometry.js";
import { pointToMultiResolutionH3, h3Boundary, h3Parent, h3Resolution } from "../../h3-situation/src/h3.js";
import { decideProjection, freshness, validateObservationTime } from "../../observation-model/src/fusion.js";
import { createWorldEvent } from "../../event-model/src/events.js";

interface MutableCell {
  resolution: number;
  metrics: SituationMetrics;
  observers: Set<string>;
  lastObservedAt?: string;
  worldVersion: number;
  updatedAt: string;
}

export interface MemoryWorldOptions {
  staleAfterMs?: number;
  maxFutureSkewMs?: number;
  maxLateArrivalMs?: number;
  sourcePriorities?: Record<string, number>;
  now?: () => number;
}

export class MemoryWorldModel {
  private readonly objects = new Map<string, WorldObject>();
  private readonly observations = new Map<string, ObservationEnvelope>();
  private readonly tracks = new Map<string, TrajectoryPoint[]>();
  private readonly cells = new Map<string, MutableCell>();
  private readonly events: WorldEvent[] = [];
  private readonly memberships = new Map<string, Set<string>>();
  private version = 0;
  private readonly options: Required<MemoryWorldOptions>;

  constructor(options: MemoryWorldOptions = {}) {
    this.options = {
      staleAfterMs: options.staleAfterMs ?? 30_000,
      maxFutureSkewMs: options.maxFutureSkewMs ?? 300_000,
      maxLateArrivalMs: options.maxLateArrivalMs ?? 86_400_000,
      sourcePriorities: options.sourcePriorities ?? { camera: 70, uav: 80, ugv: 75, sensor: 60, operator: 100, simulator: 50 },
      now: options.now ?? Date.now
    };
  }

  createObject(input: {
    id: string;
    type: string;
    subtype?: string;
    geometry?: Geometry;
    state?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    confidence?: number;
  }): WorldObject {
    if (this.objects.has(input.id)) throw new Error(`object already exists: ${input.id}`);
    const now = new Date(this.options.now()).toISOString();
    const object: WorldObject = {
      id: input.id,
      type: input.type,
      ...(input.subtype ? { subtype: input.subtype } : {}),
      ...(input.geometry ? { geometry: input.geometry } : {}),
      ...(input.geometry?.type === "Point" ? { h3: pointToMultiResolutionH3(input.geometry) } : {}),
      state: structuredClone(input.state ?? {}),
      properties: structuredClone(input.properties ?? {}),
      confidence: input.confidence ?? 1,
      updatedAt: now,
      version: ++this.version,
      stale: true
    };
    this.objects.set(object.id, object);
    if (object.h3) this.moveObjectCounters(object.type, undefined, object.h3);
    this.events.push(createWorldEvent({
      eventType: "ObjectCreated", subject: { type: object.type, id: object.id }, worldVersion: object.version,
      correlationId: object.id, causationId: object.id, ...(object.geometry ? { geometry: object.geometry } : {}), payload: {}
    }));
    return structuredClone(object);
  }

  getObject(id: string): WorldObject | undefined {
    const object = this.objects.get(id);
    if (!object) return undefined;
    const age = freshness(object.observedAt, this.options.staleAfterMs, this.options.now());
    return structuredClone({
      ...object,
      ...(age.freshnessMs === null ? {} : { freshnessMs: age.freshnessMs }),
      stale: age.stale
    });
  }

  publishObservation(observation: ObservationEnvelope): { status: "projected" | "duplicate" | "late" | "superseded"; events: WorldEvent[] } {
    if (this.observations.has(observation.observationId)) return { status: "duplicate", events: [] };
    const validation = validateObservationTime(
      observation,
      this.options.now(),
      this.options.maxFutureSkewMs,
      this.options.maxLateArrivalMs
    );
    this.observations.set(observation.observationId, structuredClone(observation));
    const observationEvent = createWorldEvent({
      eventType: "ObservationReceived", subject: observation.subject, worldVersion: this.version,
      correlationId: observation.correlationId, causationId: observation.observationId,
      ...(observation.geometry ? { geometry: observation.geometry } : {}), timestamp: observation.receivedAt,
      payload: { observer: observation.observer, observationType: observation.observationType }
    });
    this.events.push(observationEvent);
    if (!validation.valid) return { status: "late", events: [observationEvent] };
    return this.project(observation, observationEvent);
  }

  private project(observation: ObservationEnvelope, observationEvent?: WorldEvent): { status: "projected" | "superseded"; events: WorldEvent[] } {
    let object = this.objects.get(observation.subject.id);
    const created = !object;
    if (!object) {
      this.createObject({ id: observation.subject.id, type: observation.subject.type });
      object = this.objects.get(observation.subject.id)!;
    }
    const decision = decideProjection(object.provenance ? {
      observedAt: object.provenance.observedAt,
      confidence: object.provenance.confidence,
      source: object.provenance.source,
      sourceObservationId: object.provenance.sourceObservationId
    } : undefined, observation, {
      sourcePriorities: this.options.sourcePriorities,
      conflictWindowMs: 5_000,
      maxOutOfOrderMs: this.options.maxLateArrivalMs
    });
    const produced: WorldEvent[] = observationEvent ? [observationEvent] : [];
    const point = observation.geometry?.type === "Point" ? observation.geometry : undefined;
    const nextH3 = point ? pointToMultiResolutionH3(point) : undefined;
    if (point && nextH3) {
      this.appendTrack(observation, point);
      this.incrementObservationCells(observation, nextH3);
    }
    if (!decision.apply) return { status: "superseded", events: produced };

    const previousH3 = object.h3;
    const positionState = point ? {
      position: {
        longitude: point.coordinates[0], latitude: point.coordinates[1],
        ...(point.coordinates[2] === undefined ? {} : { altitude: point.coordinates[2] })
      }
    } : {};
    const version = ++this.version;
    object = {
      ...object,
      ...(observation.geometry ? { geometry: structuredClone(observation.geometry) } : {}),
      ...(nextH3 ? { h3: nextH3 } : {}),
      state: { ...object.state, ...structuredClone(observation.value), ...positionState, lastObservationType: observation.observationType },
      confidence: observation.confidence,
      observedAt: observation.observedAt,
      updatedAt: new Date(this.options.now()).toISOString(),
      version,
      provenance: {
        confidence: observation.confidence,
        source: observation.source,
        sourceObservationId: observation.observationId,
        observedAt: observation.observedAt,
        receivedAt: observation.receivedAt
      },
      freshnessMs: Math.max(0, this.options.now() - Date.parse(observation.observedAt)),
      stale: false
    };
    this.objects.set(object.id, object);
    if (nextH3) this.moveObjectCounters(object.type, previousH3, nextH3);

    const stateEvent = createWorldEvent({
      eventType: point ? "ObjectMoved" : "ObjectStateChanged", subject: observation.subject,
      worldVersion: version, correlationId: observation.correlationId, causationId: observation.observationId,
      ...(observation.geometry ? { geometry: observation.geometry } : {}), timestamp: observation.observedAt,
      payload: { fusionDecision: decision.reason, source: observation.source, confidence: observation.confidence }
    });
    this.events.push(stateEvent);
    produced.push(stateEvent);
    if (point) {
      const trajectoryEvent = createWorldEvent({
        eventType: "TrajectoryUpdated", subject: observation.subject, worldVersion: version,
        correlationId: observation.correlationId, causationId: observation.observationId,
        geometry: point, timestamp: observation.observedAt, payload: {}
      });
      this.events.push(trajectoryEvent);
      produced.push(trajectoryEvent, ...this.updateGeofences(observation, point, version));
    }
    if (created) {
      // createObject already emitted ObjectCreated; keep deterministic event history.
    }
    return { status: "projected", events: produced };
  }

  private appendTrack(observation: ObservationEnvelope, point: PointGeometry): void {
    const track = this.tracks.get(observation.subject.id) ?? [];
    track.push({
      entityId: observation.subject.id,
      timestamp: observation.observedAt,
      geometry: structuredClone(point),
      latitude: point.coordinates[1],
      longitude: point.coordinates[0],
      ...(point.coordinates[2] === undefined ? {} : { altitude: point.coordinates[2] }),
      ...(typeof observation.value.heading === "number" ? { heading: observation.value.heading } : {}),
      ...(typeof observation.value.speed === "number" ? { speed: observation.value.speed } : {}),
      state: structuredClone(observation.value),
      source: observation.source,
      confidence: observation.confidence,
      observationId: observation.observationId
    });
    track.sort((a, b) => compareUnicodeCodePoints(a.timestamp, b.timestamp) || compareUnicodeCodePoints(a.observationId, b.observationId));
    this.tracks.set(observation.subject.id, track);
  }

  private incrementObservationCells(observation: ObservationEnvelope, h3: H3Projection): void {
    for (const [resolution, index] of h3Entries(h3)) {
      const cell = this.getOrCreateCell(index, resolution);
      cell.metrics.observationCount += 1;
      cell.observers.add(observation.observer.id);
      cell.metrics.coverageScore = Math.min(100, cell.observers.size * 20);
      cell.metrics.activityScore = Math.min(100, Math.log1p(cell.metrics.observationCount) * 12);
      cell.lastObservedAt = maxTime(cell.lastObservedAt, observation.observedAt);
      cell.metrics.freshnessScore = 100;
      cell.metrics.riskScore = Math.min(100, cell.metrics.incidentCount * 20 + cell.metrics.observationCount * 0.02);
      cell.updatedAt = new Date(this.options.now()).toISOString();
      cell.worldVersion = this.version;
    }
  }

  private moveObjectCounters(type: string, previous: H3Projection | undefined, next: H3Projection): void {
    const counter = counterKey(type);
    if (!counter) return;
    const previousMap = new Map(h3Entries(previous ?? {}));
    for (const [resolution, index] of h3Entries(next)) {
      const old = previousMap.get(resolution);
      if (old === index) continue;
      if (old) {
        const previousCell = this.getOrCreateCell(old, resolution);
        previousCell.metrics[counter] = Math.max(0, previousCell.metrics[counter] - 1);
      }
      const cell = this.getOrCreateCell(index, resolution);
      cell.metrics[counter] += 1;
      cell.metrics.riskScore = Math.min(100, cell.metrics.incidentCount * 20 + cell.metrics.observationCount * 0.02);
      cell.worldVersion = this.version;
    }
  }

  private updateGeofences(observation: ObservationEnvelope, point: PointGeometry, version: number): WorldEvent[] {
    const areas = [...this.objects.values()].filter((candidate) =>
      ["Zone", "AOI", "Geofence"].includes(String(candidate.type))
      && candidate.geometry && geometryContainsPoint(candidate.geometry, point)
    );
    const contained = new Set(areas.map((area) => area.id));
    const existing = this.memberships.get(observation.subject.id) ?? new Set<string>();
    const results: WorldEvent[] = [];
    for (const areaId of contained) {
      if (existing.has(areaId)) continue;
      const event = createWorldEvent({
        eventType: "ObjectEnteredArea", subject: observation.subject, worldVersion: version,
        correlationId: observation.correlationId, causationId: observation.observationId,
        geometry: point, timestamp: observation.observedAt, payload: { areaId }
      });
      results.push(event);
      this.events.push(event);
    }
    for (const areaId of existing) {
      if (contained.has(areaId)) continue;
      const event = createWorldEvent({
        eventType: "ObjectExitedArea", subject: observation.subject, worldVersion: version,
        correlationId: observation.correlationId, causationId: observation.observationId,
        geometry: point, timestamp: observation.observedAt, payload: { areaId }
      });
      results.push(event);
      this.events.push(event);
    }
    this.memberships.set(observation.subject.id, contained);
    return results;
  }

  findNearby(point: PointGeometry, options: { types?: string[]; radiusM: number; filter?: Record<string, unknown>; limit?: number }): Array<{ object: WorldObject; distanceM: number }> {
    return [...this.objects.values()]
      .filter((object) => object.geometry?.type === "Point")
      .filter((object) => !options.types?.length || options.types.includes(String(object.type)))
      .filter((object) => matchesFilter(object, options.filter ?? {}))
      .map((object) => ({ object: this.getObject(object.id)!, distanceM: haversineDistanceM(point, object.geometry as PointGeometry) }))
      .filter((entry) => entry.distanceM <= options.radiusM)
      .sort((a, b) => a.distanceM - b.distanceM || compareUnicodeCodePoints(a.object.id, b.object.id))
      .slice(0, options.limit ?? 10);
  }

  findInArea(area: Geometry, types?: string[]): WorldObject[] {
    return [...this.objects.values()]
      .filter((object) => object.geometry?.type === "Point" && geometryContainsPoint(area, object.geometry))
      .filter((object) => !types?.length || types.includes(String(object.type)))
      .map((object) => this.getObject(object.id)!);
  }

  getCell(index: string): SituationCell | undefined {
    const cell = this.cells.get(index);
    if (!cell) return undefined;
    const ageMs = cell.lastObservedAt ? Math.max(0, this.options.now() - Date.parse(cell.lastObservedAt)) : Number.POSITIVE_INFINITY;
    return {
      h3Index: index,
      resolution: cell.resolution,
      metrics: { ...cell.metrics, freshnessScore: Number.isFinite(ageMs) ? Math.max(0, 100 - ageMs / 3_000) : 0 },
      updatedAt: cell.updatedAt,
      worldVersion: cell.worldVersion,
      boundary: h3Boundary(index)
    };
  }

  hotspots(resolution: number, limit: number, parentCell?: string): SituationCell[] {
    const parentResolution = parentCell ? h3Resolution(parentCell) : undefined;
    return [...this.cells.entries()]
      .filter(([, cell]) => cell.resolution === resolution)
      .map(([index]) => this.getCell(index)!)
      .filter((cell) => !parentCell || (parentResolution !== undefined && h3Parent(cell.h3Index, parentResolution) === parentCell))
      .sort((a, b) => b.metrics.activityScore - a.metrics.activityScore || compareUnicodeCodePoints(a.h3Index, b.h3Index))
      .slice(0, limit);
  }

  getTrack(entityId: string): TrajectoryPoint[] {
    return structuredClone(this.tracks.get(entityId) ?? []);
  }

  getEvents(filter: Partial<{ eventType: string; subjectId: string; areaId: string }> = {}): WorldEvent[] {
    return structuredClone(this.events.filter((event) =>
      (!filter.eventType || event.eventType === filter.eventType)
      && (!filter.subjectId || event.subject.id === filter.subjectId)
      && (!filter.areaId || event.payload.areaId === filter.areaId)
    ));
  }

  replay(): { before: string; after: string; equal: boolean } {
    const before = this.stateChecksum();
    const facts = [...this.observations.values()].sort((a, b) =>
      compareUnicodeCodePoints(a.receivedAt, b.receivedAt) || compareUnicodeCodePoints(a.observationId, b.observationId)
    );
    const staticObjects = [...this.objects.values()].filter((object) => ["Zone", "AOI", "Geofence", "Facility", "Road", "RoadSegment"].includes(String(object.type)));
    this.objects.clear();
    this.tracks.clear();
    this.cells.clear();
    this.events.length = 0;
    this.memberships.clear();
    this.version = 0;
    for (const object of staticObjects) {
      this.createObject({
        id: object.id, type: String(object.type), ...(object.subtype ? { subtype: object.subtype } : {}),
        ...(object.geometry ? { geometry: object.geometry } : {}), state: object.state, properties: object.properties, confidence: object.confidence
      });
    }
    for (const observation of facts) this.project(observation);
    const after = this.stateChecksum();
    return { before, after, equal: before === after };
  }

  stateChecksum(): string {
    const canonical = [...this.objects.values()]
      .filter((object) => !["Zone", "AOI", "Geofence", "Facility", "Road", "RoadSegment"].includes(String(object.type)))
      .sort((a, b) => compareUnicodeCodePoints(a.id, b.id))
      .map((object) => ({
        id: object.id, type: object.type, geometry: object.geometry, state: sortObject(object.state),
        confidence: object.confidence, observedAt: object.observedAt,
        sourceObservationId: object.provenance?.sourceObservationId
      }));
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }

  stats(): { objects: number; observations: number; events: number; trajectoryPoints: number; cells: number; worldVersion: number } {
    return {
      objects: this.objects.size,
      observations: this.observations.size,
      events: this.events.length,
      trajectoryPoints: [...this.tracks.values()].reduce((sum, track) => sum + track.length, 0),
      cells: this.cells.size,
      worldVersion: this.version
    };
  }

  private getOrCreateCell(index: string, resolution: number): MutableCell {
    let cell = this.cells.get(index);
    if (!cell) {
      cell = {
        resolution,
        metrics: {
          agentCount: 0, vehicleCount: 0, sensorCount: 0, incidentCount: 0,
          observationCount: 0, riskScore: 0, coverageScore: 0, activityScore: 0, freshnessScore: 0
        },
        observers: new Set(),
        worldVersion: this.version,
        updatedAt: new Date(this.options.now()).toISOString()
      };
      this.cells.set(index, cell);
    }
    return cell;
  }
}

function h3Entries(h3: H3Projection): Array<[number, string]> {
  return [h3.r7 ? [7, h3.r7] : undefined, h3.r8 ? [8, h3.r8] : undefined, h3.r9 ? [9, h3.r9] : undefined, h3.r10 ? [10, h3.r10] : undefined]
    .filter((entry): entry is [number, string] => entry !== undefined);
}

function counterKey(type: string): "agentCount" | "vehicleCount" | "sensorCount" | "incidentCount" | undefined {
  if (type === "Agent") return "agentCount";
  if (["Vehicle", "UGV", "UAV"].includes(type)) return "vehicleCount";
  if (["Device", "Sensor", "Camera"].includes(type)) return "sensorCount";
  if (["Incident", "Alert"].includes(type)) return "incidentCount";
  return undefined;
}

function matchesFilter(object: WorldObject, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => object.state[key] === value || object.properties[key] === value);
}

function maxTime(a: string | undefined, b: string): string {
  return !a || b > a ? b : a;
}

function sortObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareUnicodeCodePoints(a, b)));
}

export function makeObservation(input: Partial<ObservationEnvelope> & Pick<ObservationEnvelope, "observer" | "subject" | "observationType">): ObservationEnvelope {
  const now = new Date().toISOString();
  return {
    observationId: input.observationId ?? randomUUID(),
    observer: input.observer,
    subject: input.subject,
    observationType: input.observationType,
    ...(input.geometry ? { geometry: input.geometry } : {}),
    value: input.value ?? {},
    confidence: input.confidence ?? 1,
    observedAt: input.observedAt ?? now,
    receivedAt: input.receivedAt ?? now,
    source: input.source ?? "simulator",
    correlationId: input.correlationId ?? randomUUID(),
    metadata: input.metadata ?? {},
    schemaVersion: "1.0"
  };
}
