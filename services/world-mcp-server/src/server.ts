import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { loadConfig } from "../../../packages/world-model-core/src/config.js";
import { CanonicalObservationInputSchema } from "../../../packages/world-model-core/src/schema.js";

const PointInput = z.object({ lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) });
const AreaInput = z.object({
  type: z.enum(["Polygon", "MultiPolygon"]),
  coordinates: z.unknown().describe("GeoJSON coordinates in longitude/latitude order")
});

export function createWorldMcpServer(): McpServer {
  const config = loadConfig();
  const server = new McpServer({ name: "gowm-plus-mcp-server", version: "1.2.0" });

  server.registerTool("get_world_state", {
    title: "Get authoritative world state",
    description: "Return current state, geometry, freshness, confidence and provenance for one world object.",
    inputSchema: { objectId: z.string().min(1) },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ objectId }) => safeResult(async () => {
    const started = performance.now();
    const object = await requestJson(`${config.worldApiUrl}/world/objects/${encodeURIComponent(objectId)}`) as Record<string, unknown>;
    return {
      summary: { objectId, type: object.type, stale: object.stale, confidence: object.confidence },
      facts: object,
      context: {
        worldVersion: Number(object.version ?? 0),
        dataFreshnessMs: typeof object.freshnessMs === "number" ? object.freshnessMs : null,
        queryTimeMs: roundMs(performance.now() - started),
        confidence: object.confidence,
        provenance: object.provenance ? [object.provenance] : []
      }
    };
  }));

  server.registerTool("find_nearby_objects", {
    title: "Find nearby world objects",
    description: "Find nearby objects without exposing PostGIS. Results include distance, freshness and world version.",
    inputSchema: {
      location: PointInput,
      objectTypes: z.array(z.string()).optional(),
      radiusM: z.number().positive().max(1_000_000),
      filter: z.record(z.string(), z.unknown()).optional(),
      limit: z.number().int().positive().max(1_000).default(10)
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async (input) => callJson(`${config.worldApiUrl}/spatial/nearby`, {
    method: "POST",
    body: input
  }));

  server.registerTool("find_objects_in_area", {
    title: "Find objects in area",
    description: "Return current objects spatially contained by a GeoJSON polygon.",
    inputSchema: {
      area: AreaInput,
      objectTypes: z.array(z.string()).optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
      limit: z.number().int().positive().max(10_000).default(1_000)
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async (input) => callJson(`${config.worldApiUrl}/spatial/in-area`, { method: "POST", body: input }));

  server.registerTool("get_area_situation", {
    title: "Summarize area situation",
    description: "Return object counts and H3 situation metrics for an operational area.",
    inputSchema: { area: AreaInput, resolution: z.number().int().min(7).max(10).default(9) },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ area, resolution }) => {
    const [objects, situation] = await Promise.all([
      requestJson(`${config.worldApiUrl}/spatial/area-summary`, { method: "POST", body: { area } }),
      requestJson(`${config.worldApiUrl}/situation/area`, { method: "POST", body: { area, resolution } })
    ]);
    return toolResult({ objects, situation });
  });

  server.registerTool("get_h3_situation", {
    title: "Get H3 situation cell",
    description: "Return current pre-aggregated situation metrics and boundary for one H3 cell.",
    inputSchema: { h3Index: z.string().min(1) },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ h3Index }) => safeResult(async () => {
    const started = performance.now();
    const cell = await requestJson(`${config.worldApiUrl}/situation/cells/${encodeURIComponent(h3Index)}`) as Record<string, unknown>;
    const updatedAt = typeof cell.updatedAt === "string" ? Date.parse(cell.updatedAt) : Number.NaN;
    return {
      summary: { h3Index, resolution: cell.resolution, metrics: cell.metrics },
      facts: cell,
      context: {
        worldVersion: Number(cell.worldVersion ?? 0),
        dataFreshnessMs: Number.isFinite(updatedAt) ? Math.max(0, Date.now() - updatedAt) : null,
        queryTimeMs: roundMs(performance.now() - started)
      }
    };
  }));

  server.registerTool("get_h3_hotspots", {
    title: "Get H3 hotspots",
    description: "Find highest activity/risk H3 cells and optionally drill down below a parent cell.",
    inputSchema: {
      resolution: z.number().int().min(7).max(10).default(9),
      metric: z.enum(["activity", "risk", "coverage", "freshness", "observations"]).default("activity"),
      limit: z.number().int().positive().max(1_000).default(10),
      parentCell: z.string().optional()
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async (input) => callJson(`${config.worldApiUrl}/situation/hotspots`, { method: "POST", body: input }));

  server.registerTool("get_object_track", {
    title: "Get object trajectory",
    description: "Return ordered historical positions and distance traveled for an object.",
    inputSchema: {
      objectId: z.string().min(1),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().int().positive().max(100_000).default(10_000)
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ objectId, ...query }) => {
    const search = new URLSearchParams(Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)] as [string, string]));
    return safeResult(async () => {
      const started = performance.now();
      const [track, state] = await Promise.all([
        requestJson(`${config.worldApiUrl}/trajectory/${encodeURIComponent(objectId)}/track?${search}`),
        requestJson(`${config.worldApiUrl}/world/objects/${encodeURIComponent(objectId)}`)
      ]) as [Record<string, unknown>, Record<string, unknown>];
      return {
        summary: track.summary ?? {},
        facts: { points: track.points ?? [] },
        context: {
          worldVersion: Number(state.version ?? 0),
          dataFreshnessMs: typeof state.freshnessMs === "number" ? state.freshnessMs : null,
          queryTimeMs: roundMs(performance.now() - started),
          confidence: state.confidence,
          provenance: state.provenance ? [state.provenance] : []
        }
      };
    });
  });

  server.registerTool("get_mobility_trajectory", {
    title: "Get MobilityDB trajectory",
    description: "Return the current immutable source-local SequenceSet, explicit UNKNOWN gaps and version provenance.",
    inputSchema: { objectId: z.string().min(1), source: z.string().min(1).optional() },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ objectId,source }) => callJson(
    `${config.worldApiUrl}/trajectory/${encodeURIComponent(objectId)}/mobility${source ? `?source=${encodeURIComponent(source)}` : ""}`
  ));

  server.registerTool("publish_observation", {
    title: "Publish world observation",
    description: "Publish an idempotent Observation envelope; it is validated and projected asynchronously into world state.",
    inputSchema: {
      observationId: z.string().min(1),
      observer: z.object({ type: z.string(), id: z.string() }),
      subject: z.object({ type: z.string(), id: z.string() }),
      observationType: z.string().min(1),
      geometry: z.object({ type: z.string(), coordinates: z.unknown() }).optional(),
      value: z.record(z.string(), z.unknown()).default({}),
      confidence: z.number().min(0).max(1),
      observedAt: z.string(),
      receivedAt: z.string().optional(),
      source: z.string(),
      correlationId: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
      schemaVersion: z.literal("1.0").default("1.0")
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async (input) => callJson(`${config.observationApiUrl}/observations`, { method: "POST", body: input }));

  server.registerTool("publish_canonical_observation", {
    title: "Publish canonical GOWM+ observation",
    description: "Publish a v1.2 immutable event with explicit time solution, typed measurements, uncertainty and assertions. The server owns receivedTime.",
    inputSchema: CanonicalObservationInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async (input) => callJson(`${config.observationApiUrl}/observations`, { method: "POST", body: input }));

  return server;
}

async function requestJson(url: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    ...(options.body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options.body)
    })
  });
  const text = await response.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(`World Model API ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function callJson(url: string, options: { method?: string; body?: unknown } = {}) {
  return safeResult(() => requestJson(url, options));
}

async function safeResult(action: () => Promise<unknown>) {
  try { return toolResult(await action()); }
  catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
  }
}

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: isRecord(data) ? data : { result: data }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundMs(value: number): number { return Math.round(value * 100) / 100; }
