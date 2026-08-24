import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { CapabilityResultEnvelope } from "../../../packages/platform/contract-runtime/src/index.js";
import {
  HttpGatewayOperationClient,
  type GatewayOperationClient,
  type GatewayTransportContext
} from "../../../packages/platform/compatibility-runtime/src/index.js";
import { loadConfig } from "../../../packages/world-model-core/src/config.js";
import { CanonicalObservationInputSchema } from "../../../packages/world-model-core/src/schema.js";

const PointInput = z.object({ lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) });
const AreaInput = z.object({
  type: z.enum(["Polygon", "MultiPolygon"]),
  coordinates: z.unknown().describe("GeoJSON coordinates in longitude/latitude order")
});

export interface WorldQueryReadonlyMcpOptions {
  gateway?: GatewayOperationClient;
  gatewayContext?: GatewayTransportContext;
}

export function createWorldQueryReadonlyMcpServer(options: WorldQueryReadonlyMcpOptions = {}): McpServer {
  const gateway = options.gateway ?? new HttpGatewayOperationClient({
    baseUrl: process.env.CAPABILITY_GATEWAY_URL ?? "http://localhost:3010"
  });
  const context = options.gatewayContext ?? gatewayContextFromEnvironment();
  const server = new McpServer({ name: "world-query-mcp-readonly", version: "0.2.0" });

  server.registerTool("find_nearby_objects", {
    title: "Find nearby world objects",
    description: "Execute the fixed spatial.find-nearby capability through the GOWM Capability Gateway.",
    inputSchema: {
      location: PointInput,
      objectTypes: z.array(z.string().min(1)).min(1).max(50).optional(),
      radiusM: z.number().positive().max(20_000_000),
      limit: z.number().int().positive().max(1_000).default(10)
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async (input) => gatewayResult(() => gateway.execute("spatial.find-nearby", {
    location: { longitude: input.location.lon, latitude: input.location.lat },
    radiusM: input.radiusM,
    ...(input.objectTypes === undefined ? {} : { objectTypes: input.objectTypes }),
    limit: input.limit,
    includeGeometry: true,
    crs: "EPSG:4326"
  }, context)));

  server.registerTool("find_objects_in_area", {
    title: "Find objects in area",
    description: "Execute the fixed spatial.find-in-area capability through the GOWM Capability Gateway.",
    inputSchema: {
      area: AreaInput,
      objectTypes: z.array(z.string().min(1)).min(1).max(50).optional(),
      limit: z.number().int().positive().max(1_000).default(1_000)
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async (input) => gatewayResult(() => gateway.execute("spatial.find-in-area", {
    geometry: input.area,
    ...(input.objectTypes === undefined ? {} : { objectTypes: input.objectTypes }),
    limit: input.limit,
    includeGeometry: true,
    crs: "EPSG:4326"
  }, context)));

  server.registerTool("get_area_situation", {
    title: "Summarize area situation",
    description: "Read spatial object counts and GOWM-owned H3 Situation metrics through two fixed Gateway capabilities.",
    inputSchema: {
      area: AreaInput,
      resolution: z.number().int().min(7).max(10).default(9)
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ area, resolution }) => safeResult(async () => {
    const [objects, situation] = await Promise.all([
      gateway.execute("spatial.summarize-area", { geometry: area, groupBy: "objectType", crs: "EPSG:4326" }, context),
      gateway.execute("gowm.situation.h3.get-area", { area, resolution }, context)
    ]);
    return {
      summary: { operations: [objects.operation.operationId, situation.operation.operationId] },
      facts: { objects: outputValue(objects), situation: outputValue(situation) },
      context: gatewayContext([objects, situation])
    };
  }));

  server.registerTool("get_h3_situation", {
    title: "Get GOWM H3 situation",
    description: "Read one scoped GOWM Situation cell and its grounded candidate references through the Gateway.",
    inputSchema: { h3Index: z.string().regex(/^[0-9a-f]{15,16}$/u) },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async ({ h3Index }) => gatewayResult(() => gateway.execute("gowm.situation.h3.get-cell", { h3Index }, context)));

  server.registerTool("get_h3_hotspots", {
    title: "Get GOWM H3 hotspots",
    description: "Read ranked GOWM Situation metrics through the fixed scoped Gateway capability.",
    inputSchema: {
      resolution: z.number().int().min(7).max(10).default(9),
      metric: z.enum(["activity", "risk", "coverage", "freshness", "observations"]).default("activity"),
      limit: z.number().int().positive().max(1_000).default(10),
      parentCell: z.string().regex(/^[0-9a-f]{15,16}$/u).optional()
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async (input) => gatewayResult(() => gateway.execute("gowm.situation.h3.get-hotspots", input, context)));

  server.registerTool("get_h3_coverage_gaps", {
    title: "Get GOWM H3 coverage gaps",
    description: "Read the lowest-coverage GOWM Situation cells through the fixed scoped Gateway capability.",
    inputSchema: {
      resolution: z.number().int().min(7).max(10).default(9),
      limit: z.number().int().positive().max(1_000).default(10),
      parentCell: z.string().regex(/^[0-9a-f]{15,16}$/u).optional()
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, async (input) => gatewayResult(() => gateway.execute("gowm.situation.h3.get-coverage-gaps", input, context)));

  return server;
}

export interface ObservationCommandClient {
  publish(input: unknown): Promise<unknown>;
}

export interface ObservationCommandMcpOptions {
  client?: ObservationCommandClient;
}

export function createObservationCommandMcpServer(options: ObservationCommandMcpOptions = {}): McpServer {
  const client = options.client ?? new HttpObservationCommandClient(loadConfig().observationApiUrl);
  const server = new McpServer({ name: "observation-command-mcp", version: "0.2.0" });

  server.registerTool("publish_observation", {
    title: "Publish world observation",
    description: "Publish an idempotent legacy Observation envelope to the dedicated Observation Ingest command path.",
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
  }, async (input) => safeResult(() => client.publish(input)));

  server.registerTool("publish_canonical_observation", {
    title: "Publish canonical GOWM+ observation",
    description: "Publish the canonical v1.2 command to the dedicated Observation Ingest path.",
    inputSchema: CanonicalObservationInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async (input) => safeResult(() => client.publish(input)));

  return server;
}

export class HttpObservationCommandClient implements ObservationCommandClient {
  private readonly baseUrl: URL;
  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = safeHttpBaseUrl(baseUrl);
  }

  async publish(input: unknown): Promise<unknown> {
    const response = await this.fetchImpl(new URL("/observations", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    const text = await response.text();
    const data = text ? parseJson(text) : null;
    if (!response.ok) throw new Error(`Observation Ingest ${response.status}`);
    return data;
  }
}

async function gatewayResult(action: () => Promise<CapabilityResultEnvelope>) {
  return safeResult(async () => {
    const envelope = await action();
    return {
      summary: { operationId: envelope.operation.operationId, status: envelope.status },
      facts: outputValue(envelope),
      context: gatewayContext([envelope])
    };
  });
}

function outputValue(envelope: CapabilityResultEnvelope): unknown {
  return envelope.output?.value ?? null;
}

function gatewayContext(envelopes: CapabilityResultEnvelope[]): Record<string, unknown> {
  return {
    operations: envelopes.map((envelope) => envelope.operation),
    providers: envelopes.map((envelope) => ({
      providerId: envelope.execution.providerId,
      providerVersion: envelope.execution.providerVersion
    })),
    dataSnapshots: envelopes.flatMap((envelope) => envelope.dataSnapshot ? [envelope.dataSnapshot] : []),
    receipts: envelopes.flatMap((envelope) => envelope.receipts),
    warnings: envelopes.flatMap((envelope) => envelope.warnings)
  };
}

async function safeResult(action: () => Promise<unknown>) {
  try {
    const data = await action();
    return toolResult(data);
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
  }
}

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: isRecord(data) ? data : { result: data }
  };
}

function gatewayContextFromEnvironment(): GatewayTransportContext {
  return {
    ...(process.env.CAPABILITY_GATEWAY_AUTHORIZATION ? { authorization: process.env.CAPABILITY_GATEWAY_AUTHORIZATION } : {}),
    ...(process.env.GOWM_DATA_SCOPE ? { dataScopeClaim: process.env.GOWM_DATA_SCOPE } : {})
  };
}

function safeHttpBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("service base URL must be an HTTP(S) origin without credentials, query or fragment");
  }
  return url;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Observation Ingest returned non-JSON data");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

