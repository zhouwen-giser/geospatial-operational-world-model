import Fastify, { type FastifyInstance } from "fastify";
import { compareUnicodeCodePoints } from "../../../packages/platform/contract-runtime/src/index.js";
import type { Geometry, LineStringGeometry, PointGeometry, WorldEvent } from "../../../packages/world-model-core/src/types.js";
import {
  AreaQuerySchema,
  DistanceQuerySchema,
  EventSubscriptionFilterSchema,
  GeometrySchema,
  HotspotQuerySchema,
  NearbyQuerySchema,
  RelationCreateSchema,
  RouteQuerySchema,
  TrackQuerySchema,
  WorldObjectCreateSchema,
  WorldObjectPatchSchema
} from "../../../packages/world-model-core/src/schema.js";
import { h3Resolution } from "../../../packages/h3-situation/src/h3.js";
import { validateGeometry } from "../../../packages/spatial-engine/src/geometry.js";
import { distanceTraveledM, detectRouteDeviation, detectStops } from "../../../packages/trajectory-model/src/analytics.js";
import { databasePool } from "../../../packages/runtime/src/db.js";
import { WorldRepository } from "../../../packages/runtime/src/world-repository.js";
import { SpatialRepository } from "../../../packages/runtime/src/spatial-repository.js";
import { SituationRepository } from "../../../packages/runtime/src/situation-repository.js";
import { ObservationRepository } from "../../../packages/runtime/src/observation-repository.js";
import { EventRepository } from "../../../packages/runtime/src/event-repository.js";
import { TrajectoryRepository } from "../../../packages/runtime/src/trajectory-repository.js";
import { WorldEventBus } from "../../../packages/runtime/src/bus.js";
import { timedResponse } from "./response.js";
import {
  applyCompatibilityHeaders,
  createWorldApiCompatibilityRuntime,
  gatewayTransportContext
} from "./compatibility.js";

export function buildWorldApi(): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 10 * 1024 * 1024 });
  const pool = databasePool();
  const world = new WorldRepository(pool);
  const spatial = new SpatialRepository(pool);
  const situation = new SituationRepository(pool);
  const observations = new ObservationRepository(pool);
  const events = new EventRepository(pool);
  const trajectories = new TrajectoryRepository(pool);
  const bus = new WorldEventBus();
  const version = () => world.worldVersion();
  const compatibility = createWorldApiCompatibilityRuntime((evidence) => {
    app.log.info({ compatibilityParity: evidence }, "World API compatibility parity observation");
  });

  app.addHook("onSend", async (request, reply) => {
    applyCompatibilityHeaders(request, reply, compatibility);
  });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as Error & { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    reply.code(statusCode).send({ error: statusCode === 500 ? "internal_error" : "request_error", message });
  });

  app.get("/health", async () => ({ status: "ok", service: "world-api", ...(await world.health()), timestamp: new Date().toISOString() }));

  app.post("/world/objects", async (request, reply) => {
    const parsed = WorldObjectCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_object", issues: parsed.error.issues });
    if (parsed.data.geometry) {
      const issues = validateGeometry(parsed.data.geometry as Geometry);
      if (issues.length) return reply.code(422).send({ error: "invalid_geometry", issues });
    }
    return reply.code(201).send(await world.createObject(parsed.data as Parameters<WorldRepository["createObject"]>[0]));
  });

  app.get("/world/objects/:id", async (request, reply) => {
    const object = await world.getObject((request.params as { id: string }).id);
    return object ? object : reply.code(404).send({ error: "object_not_found" });
  });

  app.patch("/world/objects/:id", async (request, reply) => {
    const parsed = WorldObjectPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_patch", issues: parsed.error.issues });
    if (parsed.data.geometry) {
      const issues = validateGeometry(parsed.data.geometry as Geometry);
      if (issues.length) return reply.code(422).send({ error: "invalid_geometry", issues });
    }
    const object = await world.patchObject((request.params as { id: string }).id, parsed.data as Parameters<WorldRepository["patchObject"]>[1]);
    return object ? object : reply.code(404).send({ error: "object_not_found" });
  });

  app.post("/world/objects/search", async (request) => {
    const body = (request.body ?? {}) as { objectTypes?: string[]; filter?: Record<string, unknown>; query?: string; limit?: number; offset?: number };
    return timedResponse(version, () => world.findObjects(body),
      (facts) => ({ count: facts.length, objectTypes: [...new Set(facts.map((object) => object.type))] }),
      (facts) => facts.map((object) => object.freshnessMs));
  });

  app.post("/world/relations", async (request, reply) => {
    const parsed = RelationCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_relation", issues: parsed.error.issues });
    return reply.code(201).send(await world.createRelation(parsed.data));
  });

  app.get("/world/objects/:id/relations", async (request) => world.getRelations((request.params as { id: string }).id));

  app.post("/spatial/nearby", async (request, reply) => {
    const parsed = NearbyQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_query", issues: parsed.error.issues });
    const point: PointGeometry = { type: "Point", coordinates: [parsed.data.location.lon, parsed.data.location.lat] };
    return compatibility.adapter.execute("spatial.nearby", parsed.data, () => timedResponse(version,
      () => spatial.nearby({
        point,
        radiusM: parsed.data.radiusM,
        filter: parsed.data.filter,
        limit: parsed.data.limit,
        ...(parsed.data.objectTypes ? { objectTypes: parsed.data.objectTypes } : {})
      }),
      (facts) => ({ count: facts.length, nearestDistanceM: facts[0]?.distanceM ?? null, radiusM: parsed.data.radiusM }),
      (facts) => facts.map((entry) => entry.object.freshnessMs)), gatewayTransportContext(request));
  });

  app.post("/spatial/nearest", async (request, reply) => {
    const parsed = NearbyQuerySchema.omit({ radiusM: true }).safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_query", issues: parsed.error.issues });
    const point: PointGeometry = { type: "Point", coordinates: [parsed.data.location.lon, parsed.data.location.lat] };
    return compatibility.adapter.execute("spatial.nearest", parsed.data, () => timedResponse(version, () => spatial.nearest({
      point,
      filter: parsed.data.filter,
      limit: parsed.data.limit,
      ...(parsed.data.objectTypes ? { objectTypes: parsed.data.objectTypes } : {})
    }),
      (facts) => ({ count: facts.length, nearestDistanceM: facts[0]?.distanceM ?? null }),
      (facts) => facts.map((entry) => entry.object.freshnessMs)), gatewayTransportContext(request));
  });

  app.post("/spatial/in-area", async (request, reply) => {
    const parsed = AreaQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_query", issues: parsed.error.issues });
    const geometryIssues = validateGeometry(parsed.data.area as Geometry);
    if (geometryIssues.length) return reply.code(422).send({ error: "invalid_geometry", issues: geometryIssues });
    return compatibility.adapter.execute("spatial.in-area", parsed.data, () => timedResponse(version, () => spatial.within(parsed.data as Parameters<SpatialRepository["within"]>[0]),
      (facts) => ({ count: facts.length, byType: countBy(facts.map((object) => String(object.type))) }),
      (facts) => facts.map((object) => object.freshnessMs)), gatewayTransportContext(request));
  });

  app.post("/spatial/intersections", async (request, reply) => {
    const body = request.body as { geometry?: unknown; objectTypes?: string[]; limit?: number };
    const parsed = GeometrySchema.safeParse(body?.geometry);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_geometry", issues: parsed.error.issues });
    const geometryIssues = validateGeometry(parsed.data as Geometry);
    if (geometryIssues.length) return reply.code(422).send({ error: "invalid_geometry", issues: geometryIssues });
    return compatibility.adapter.execute("spatial.intersections", { ...body, geometry: parsed.data }, () => timedResponse(version,
      () => spatial.intersections({ geometry: parsed.data as Geometry, ...(body.objectTypes ? { objectTypes: body.objectTypes } : {}), limit: body.limit ?? 1_000 }),
      (facts) => ({ count: facts.length })), gatewayTransportContext(request));
  });

  app.post("/spatial/near-route", async (request, reply) => {
    const parsed = RouteQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_query", issues: parsed.error.issues });
    const geometryIssues = validateGeometry(parsed.data.route as Geometry);
    if (geometryIssues.length) return reply.code(422).send({ error: "invalid_geometry", issues: geometryIssues });
    return compatibility.adapter.execute("spatial.near-route", parsed.data,
      () => timedResponse(version, () => spatial.nearRoute(parsed.data as Parameters<SpatialRepository["nearRoute"]>[0]),
        (facts) => ({ count: facts.length, nearestDistanceM: facts[0]?.distanceM ?? null })),
      gatewayTransportContext(request));
  });
  app.post("/spatial/objects-along-route", async (request, reply) => {
    const parsed = RouteQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_query", issues: parsed.error.issues });
    const geometryIssues = validateGeometry(parsed.data.route as Geometry);
    if (geometryIssues.length) return reply.code(422).send({ error: "invalid_geometry", issues: geometryIssues });
    return compatibility.adapter.execute("spatial.objects-along-route", parsed.data,
      () => timedResponse(version, () => spatial.nearRoute(parsed.data as Parameters<SpatialRepository["nearRoute"]>[0]),
        (facts) => ({ count: facts.length, nearestDistanceM: facts[0]?.distanceM ?? null })),
      gatewayTransportContext(request));
  });

  app.post("/spatial/containing-areas", async (request, reply) => {
    const body = request.body as { location?: { lon: number; lat: number }; limit?: number };
    if (!body?.location) return reply.code(422).send({ error: "location_required" });
    const point: PointGeometry = { type: "Point", coordinates: [body.location.lon, body.location.lat] };
    return timedResponse(version, () => spatial.containingAreas(point, body.limit), (facts) => ({ count: facts.length }));
  });

  app.post("/spatial/distance", async (request, reply) => {
    const parsed = DistanceQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_query", issues: parsed.error.issues });
    const distanceM = await spatial.distance(parsed.data.from as PointGeometry, parsed.data.to as PointGeometry);
    return { summary: { distanceM }, facts: { distanceM }, context: { worldVersion: await version(), dataFreshnessMs: null, queryTimeMs: 0 } };
  });

  app.post("/spatial/area-summary", async (request, reply) => {
    const parsed = AreaQuerySchema.pick({ area: true }).safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_query", issues: parsed.error.issues });
    const geometryIssues = validateGeometry(parsed.data.area as Geometry);
    if (geometryIssues.length) return reply.code(422).send({ error: "invalid_geometry", issues: geometryIssues });
    return compatibility.adapter.execute("spatial.area-summary", parsed.data,
      () => timedResponse(version, () => spatial.areaSummary(parsed.data.area as Geometry),
        (facts) => ({ total: Object.values(facts).reduce((sum, value) => sum + value, 0), byType: facts })),
      gatewayTransportContext(request));
  });

  app.get("/situation/cells/:index", async (request, reply) => {
    const index = (request.params as { index: string }).index;
    const cell = await compatibility.adapter.execute("situation.get-cell", { h3Index: index },
      () => situation.getCell(index), gatewayTransportContext(request));
    return cell ? cell : reply.code(404).send({ error: "cell_not_found" });
  });

  app.post("/situation/cells", async (request) => situation.getCells((request.body as { indexes?: string[] }).indexes ?? []));

  app.post("/situation/area", async (request, reply) => {
    const body = request.body as { area?: unknown; resolution?: number };
    const parsed = GeometrySchema.safeParse(body?.area);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_area", issues: parsed.error.issues });
    const geometryIssues = validateGeometry(parsed.data as Geometry);
    if (geometryIssues.length) return reply.code(422).send({ error: "invalid_geometry", issues: geometryIssues });
    const resolution = body.resolution ?? 9;
    if (!Number.isInteger(resolution) || resolution < 7 || resolution > 10) return reply.code(422).send({ error: "resolution_must_be_r7_to_r10" });
    return compatibility.adapter.execute("situation.get-area", { area: parsed.data, resolution },
      () => timedResponse(version, () => situation.areaCells(parsed.data as Geometry, resolution),
        (facts) => ({ cellCount: facts.length, totals: sumSituation(facts) })),
      gatewayTransportContext(request));
  });

  app.get("/situation/cells/:index/neighbors", async (request, reply) => {
    const ring = Number((request.query as { ring?: string }).ring ?? 1);
    if (!Number.isInteger(ring) || ring < 0 || ring > 5) return reply.code(422).send({ error: "ring_must_be_0_to_5" });
    return situation.neighbors((request.params as { index: string }).index, ring);
  });

  app.get("/situation/cells/:index/hierarchy", async (request, reply) => {
    const index = (request.params as { index: string }).index;
    const target = Number((request.query as { resolution?: string }).resolution ?? h3Resolution(index));
    const current = h3Resolution(index);
    if (!Number.isInteger(target) || target < 7 || target > 10 || Math.abs(target - current) > 3) {
      return reply.code(422).send({ error: "resolution_must_be_r7_to_r10_and_within_three_levels" });
    }
    return situation.hierarchy(index, target);
  });

  for (const [path, metric, order] of [
    ["/situation/hotspots", undefined, "DESC"],
    ["/situation/coldspots", undefined, "ASC"],
    ["/situation/activity-map", "activity", "DESC"],
    ["/situation/coverage-map", "coverage", "DESC"],
    ["/situation/risk-map", "risk", "DESC"],
    ["/situation/coverage-gaps", "coverage", "ASC"]
  ] as const) {
    app.post(path, async (request, reply) => {
      const parsed = HotspotQuerySchema.safeParse({ ...(request.body as object), ...(metric ? { metric } : {}) });
      if (!parsed.success) return reply.code(422).send({ error: "invalid_query", issues: parsed.error.issues });
      const legacy = () => timedResponse(version,
        () => situation.ranked({
          resolution: parsed.data.resolution,
          metric: metric ?? parsed.data.metric,
          order,
          limit: parsed.data.limit,
          ...(parsed.data.parentCell ? { parentCell: parsed.data.parentCell } : {})
        }),
        (facts) => ({ count: facts.length, metric: metric ?? parsed.data.metric, resolution: parsed.data.resolution }));
      if (path === "/situation/hotspots") {
        return compatibility.adapter.execute("situation.get-hotspots", parsed.data, legacy, gatewayTransportContext(request));
      }
      if (path === "/situation/coverage-gaps") {
        const { resolution, limit, parentCell } = parsed.data;
        return compatibility.adapter.execute("situation.get-coverage-gaps", {
          resolution,
          limit,
          ...(parentCell === undefined ? {} : { parentCell })
        }, legacy, gatewayTransportContext(request));
      }
      return legacy();
    });
  }

  app.get("/observations", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return observations.query({
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.observerId ? { observerId: query.observerId } : {}),
      ...(query.observationType ? { observationType: query.observationType } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      limit: Number(query.limit ?? 1_000)
    });
  });

  app.get("/events", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return events.list({
      ...(query.eventType ? { eventType: query.eventType } : {}),
      ...(query.objectType ? { objectType: query.objectType } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.areaId ? { areaId: query.areaId } : {}),
      ...(query.sinceWorldVersion ? { sinceWorldVersion: Number(query.sinceWorldVersion) } : {}),
      limit: Number(query.limit ?? 1_000)
    });
  });

  app.get("/events/stream", async (request, reply) => {
    const parsed = EventSubscriptionFilterSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_filter", issues: parsed.error.issues });
    const filter = parsed.data;
    const seen = new Set<string>();
    const buffered = new Map<string, WorldEvent>();
    let replayingBacklog = true;
    const send = (event: WorldEvent) => {
      if (seen.has(event.eventId)) return;
      seen.add(event.eventId);
      reply.raw.write(`id: ${event.eventId}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const eventFilter = {
      ...(filter.objectType ? { objectType: filter.objectType } : {}),
      ...(filter.eventType ? { eventType: filter.eventType } : {}),
      ...(filter.areaId ? { areaId: filter.areaId } : {}),
      ...(filter.sinceWorldVersion !== undefined ? { sinceWorldVersion: filter.sinceWorldVersion } : {})
    };
    const subscription = await bus.subscribeEvents((event) => {
      if (!matchesEvent(event, eventFilter)) return;
      if (replayingBacklog) buffered.set(event.eventId, event);
      else send(event);
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    const initial = await events.list({ ...eventFilter, limit: 10_000 });
    initial.forEach(send);
    replayingBacklog = false;
    [...buffered.values()]
      .sort((left, right) => left.worldVersion - right.worldVersion || compareUnicodeCodePoints(left.timestamp, right.timestamp))
      .forEach(send);
    buffered.clear();
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.on("close", () => { clearInterval(heartbeat); subscription.unsubscribe(); });
  });

  app.get("/trajectory/:entityId/current", async (request, reply) => {
    const point = await trajectories.currentPosition((request.params as { entityId: string }).entityId);
    return point ? point : reply.code(404).send({ error: "position_not_found" });
  });

  app.get("/trajectory/:entityId/mobility", async (request, reply) => {
    const entityId = (request.params as { entityId: string }).entityId;
    const source = (request.query as { source?: string }).source;
    const trajectory = await trajectories.mobilityTrajectory(entityId,source);
    return trajectory
      ? {
          representation: "MOBILITYDB_TGEOMPOINT_SEQUENCESET",
          interpolation: "LINEAR_WITHIN_SEQUENCE_UNKNOWN_BETWEEN_SEQUENCES",
          ...trajectory
        }
      : reply.code(404).send({ error: "mobility_trajectory_not_found" });
  });

  app.get("/trajectory/:entityId/track", async (request, reply) => {
    const parsed = TrackQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_track_query", issues: parsed.error.issues });
    const points = await trajectories.track((request.params as { entityId: string }).entityId, {
      ...(parsed.data.from ? { from: parsed.data.from } : {}),
      ...(parsed.data.to ? { to: parsed.data.to } : {}),
      limit: parsed.data.limit
    });
    return {
      representation: "OBSERVED_MEASUREMENT_COMPATIBILITY_VIEW",
      summary: { pointCount: points.length, distanceTraveledM: distanceTraveledM(points) },
      points
    };
  });

  app.get("/trajectory/:entityId/recent", async (request) => {
    const query = request.query as { durationMs?: string; limit?: string };
    return trajectories.recentTrack((request.params as { entityId: string }).entityId, Number(query.durationMs ?? 300_000), Number(query.limit ?? 10_000));
  });

  app.get("/trajectory/:entityId/stops", async (request) => {
    const query = request.query as { from?: string; to?: string; radiusM?: string; minimumDurationMs?: string };
    const points = await trajectories.track((request.params as { entityId: string }).entityId, { ...query, limit: 100_000 });
    return detectStops(points, Number(query.radiusM ?? 10), Number(query.minimumDurationMs ?? 30_000));
  });

  app.post("/trajectory/:entityId/route-deviation", async (request, reply) => {
    const body = request.body as { route?: unknown; toleranceM?: number; from?: string; to?: string };
    const parsed = GeometrySchema.safeParse(body.route);
    if (!parsed.success || parsed.data.type !== "LineString") return reply.code(422).send({ error: "line_route_required" });
    const geometryIssues = validateGeometry(parsed.data as Geometry);
    if (geometryIssues.length) return reply.code(422).send({ error: "invalid_geometry", issues: geometryIssues });
    const points = await trajectories.track((request.params as { entityId: string }).entityId, { ...(body.from ? { from: body.from } : {}), ...(body.to ? { to: body.to } : {}), limit: 100_000 });
    return detectRouteDeviation(points, parsed.data as LineStringGeometry, body.toleranceM ?? 50);
  });

  app.addHook("onClose", async () => bus.drain());
  return app;
}

function countBy(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function sumSituation(cells: Awaited<ReturnType<SituationRepository["areaCells"]>>): Record<string, number> {
  return cells.reduce<Record<string, number>>((totals, cell) => {
    totals.agents = (totals.agents ?? 0) + cell.metrics.agentCount;
    totals.vehicles = (totals.vehicles ?? 0) + cell.metrics.vehicleCount;
    totals.sensors = (totals.sensors ?? 0) + cell.metrics.sensorCount;
    totals.incidents = (totals.incidents ?? 0) + cell.metrics.incidentCount;
    totals.observations = (totals.observations ?? 0) + cell.metrics.observationCount;
    return totals;
  }, {});
}

function matchesEvent(event: WorldEvent, filter: { objectType?: string; eventType?: string; areaId?: string; sinceWorldVersion?: number }): boolean {
  if (filter.objectType && event.subject.type !== filter.objectType) return false;
  if (filter.eventType && event.eventType !== filter.eventType) return false;
  if (filter.areaId && event.payload.areaId !== filter.areaId) return false;
  if (filter.sinceWorldVersion !== undefined && event.worldVersion <= filter.sinceWorldVersion) return false;
  return true;
}
