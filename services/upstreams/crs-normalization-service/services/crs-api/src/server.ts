import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { asCrsError, CrsError } from "@geospatial/crs-contract";
import { CrsNormalizer } from "@geospatial/crs-core";
import { ProjAdapter } from "@geospatial/proj-adapter";

const OPENAPI_DOCUMENT = JSON.parse(
  readFileSync(new URL("../../../openapi/openapi.json", import.meta.url), "utf8")
) as unknown;

export interface CrsHttpServerOptions {
  maxPoints?: number;
  maxVertices?: number;
  maxRequestBytes?: number;
  requestTimeoutMs?: number;
  logger?: Pick<Console, "info" | "error">;
}

export interface CrsHttpServer {
  server: Server;
  normalizer: CrsNormalizer;
  adapter: ProjAdapter;
}

export function createCrsHttpServer(options: CrsHttpServerOptions = {}): CrsHttpServer {
  const adapter = new ProjAdapter();
  const normalizer = new CrsNormalizer(adapter, {
    maxPoints: options.maxPoints,
    maxVertices: options.maxVertices
  });
  const maxRequestBytes = options.maxRequestBytes ?? 16 * 1024 * 1024;
  const logger = options.logger ?? console;

  const server = createServer(async (request, response) => {
    const requestId = request.headers["x-request-id"]?.toString().slice(0, 128) ?? randomUUID();
    response.setHeader("x-request-id", requestId);
    try {
      await route(request, response, requestId, normalizer, adapter, maxRequestBytes);
    } catch (error) {
      const crsError = asCrsError(error);
      if (crsError.code === "INTERNAL_ERROR") {
        logger.error(JSON.stringify({ level: "error", requestId, code: crsError.code }));
      }
      sendJson(response, crsError.status, crsError.toBody(requestId));
    }
  });

  server.requestTimeout = options.requestTimeoutMs ?? 30_000;
  server.headersTimeout = Math.min(server.requestTimeout, 20_000);
  server.keepAliveTimeout = 5_000;
  return { server, normalizer, adapter };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  normalizer: CrsNormalizer,
  adapter: ProjAdapter,
  maxRequestBytes: number
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");

  if (method === "GET" && url.pathname === "/health/live") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (method === "GET" && url.pathname === "/health/ready") {
    adapter.checkSourceCrs("EPSG:4326");
    sendJson(response, 200, {
      status: "ready",
      engine: adapter.engineInfo(),
      limits: {
        maxPoints: normalizer.maxPoints,
        maxVertices: normalizer.maxVertices,
        maxRequestBytes
      }
    });
    return;
  }
  if (method === "GET" && url.pathname === "/openapi.json") {
    sendJson(response, 200, OPENAPI_DOCUMENT);
    return;
  }

  const crsMatch = /^\/v1\/crs\/(\d{1,6})$/.exec(url.pathname);
  if (method === "GET" && crsMatch) {
    sendJson(response, 200, adapter.checkSourceCrs(`EPSG:${crsMatch[1]}`));
    return;
  }

  if (method !== "POST") {
    sendJson(response, 404, {
      error: {
        code: "INVALID_GEOMETRY",
        message: "Route not found.",
        retryable: false,
        requestId
      }
    });
    return;
  }

  const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new CrsError("INVALID_GEOMETRY", "Content-Type must be application/json.");
  }
  const body = await readJson(request, maxRequestBytes);
  const value = asRecord(body);

  switch (url.pathname) {
    case "/v1/normalize/point":
      sendJson(response, 200, normalizer.normalizePoint(value.sourceCrs, value.coordinate));
      return;
    case "/v1/normalize/points":
      sendJson(response, 200, normalizer.normalizePoints(value.sourceCrs, value.coordinates));
      return;
    case "/v1/normalize/geometry":
      sendJson(response, 200, normalizer.normalizeGeometry(value.sourceCrs, value.geometry));
      return;
    case "/v1/normalize/feature":
      sendJson(response, 200, normalizer.normalizeFeature(value.sourceCrs, value.feature));
      return;
    case "/v1/normalize/feature-collection":
      sendJson(
        response,
        200,
        normalizer.normalizeFeatureCollection(value.sourceCrs, value.featureCollection)
      );
      return;
    case "/v1/normalize":
      sendJson(response, 200, normalizer.normalizeUnified(value));
      return;
    default:
      sendJson(response, 404, {
        error: {
          code: "INVALID_GEOMETRY",
          message: "Route not found.",
          retryable: false,
          requestId
        }
      });
  }
}

async function readJson(request: IncomingMessage, maxRequestBytes: number): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
    throw new CrsError(
      "PAYLOAD_TOO_LARGE",
      `Request Content-Length exceeds ${maxRequestBytes} bytes.`,
      { details: { maxRequestBytes } }
    );
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxRequestBytes) {
      throw new CrsError(
        "PAYLOAD_TOO_LARGE",
        `Request body exceeds ${maxRequestBytes} bytes.`,
        { details: { maxRequestBytes } }
      );
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new CrsError("INVALID_GEOMETRY", "Request body must be valid JSON.", { cause: error });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CrsError("INVALID_GEOMETRY", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) {
    return;
  }
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store"
  });
  response.end(payload);
}
