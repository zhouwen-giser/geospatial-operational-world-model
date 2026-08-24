import type { FastifyReply, FastifyRequest } from "fastify";
import {
  compatibilityDeprecationHeaders,
  HttpGatewayOperationClient,
  parseCompatibilityMode,
  parseParityAttestations,
  WorldApiCompatibilityAdapter,
  type GatewayTransportContext
} from "../../../packages/platform/compatibility-runtime/src/index.js";

export interface WorldApiCompatibilityRuntime {
  adapter: WorldApiCompatibilityAdapter;
  sunset: Date;
}

export function createWorldApiCompatibilityRuntime(
  record: (value: unknown) => void
): WorldApiCompatibilityRuntime {
  const mode = parseCompatibilityMode(process.env.WORLD_API_COMPATIBILITY_MODE);
  const gateway = new HttpGatewayOperationClient({
    baseUrl: process.env.CAPABILITY_GATEWAY_URL ?? "http://localhost:3010",
    timeoutMs: integerEnv("WORLD_API_COMPATIBILITY_TIMEOUT_MS", 10_000),
    maximumResultBytes: integerEnv("WORLD_API_COMPATIBILITY_MAX_RESULT_BYTES", 16_777_216)
  });
  return {
    adapter: new WorldApiCompatibilityAdapter({
      mode,
      gateway,
      attestations: parseParityAttestations(process.env.WORLD_API_PARITY_ATTESTATIONS_JSON),
      onEvidence: record
    }),
    sunset: sunsetDate(process.env.WORLD_API_COMPATIBILITY_SUNSET)
  };
}

export function gatewayTransportContext(request: FastifyRequest): GatewayTransportContext {
  return {
    requestId: request.id,
    ...singleHeader(request.headers.authorization, "authorization"),
    ...dataScopeHeader(request.headers["x-gowm-data-scope"])
  };
}

export function applyCompatibilityHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  runtime: WorldApiCompatibilityRuntime
): void {
  const headers = compatibilityDeprecationHeaders({
    path: request.url,
    mode: runtime.adapter.mode,
    sunset: runtime.sunset
  });
  if (!headers) return;
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
}

function singleHeader(
  value: string | string[] | undefined,
  name: "authorization"
): Partial<GatewayTransportContext> {
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized ? { [name]: normalized } : {};
}

function dataScopeHeader(value: string | string[] | undefined): Partial<GatewayTransportContext> {
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized ? { dataScopeClaim: normalized } : {};
}

function sunsetDate(raw: string | undefined): Date {
  const date = raw ? new Date(raw) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000);
  if (Number.isNaN(date.getTime())) throw new Error("WORLD_API_COMPATIBILITY_SUNSET must be a valid HTTP date");
  return date;
}

function integerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

