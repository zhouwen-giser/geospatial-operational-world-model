import { POC_OPENAPI_SHA256, POC_SOURCE_ZIP_SHA256 } from "./schemas.js";
import type { GeometryProviderBridgeOptions, Sha256Digest } from "./types.js";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface GeometryBridgeServerConfig {
  host: string;
  port: number;
  transportToken: string;
  provider: GeometryProviderBridgeOptions;
}

export function loadGeometryBridgeServerConfig(env: NodeJS.ProcessEnv = process.env): GeometryBridgeServerConfig {
  if (required(env, "GEOMETRY_BRIDGE_ENDPOINT_APPROVAL_STATUS") !== "APPROVED") {
    throw new Error("GEOMETRY_BRIDGE_ENDPOINT_APPROVAL_STATUS must be APPROVED");
  }
  return {
    host: env.GEOMETRY_BRIDGE_HOST?.trim() || "0.0.0.0",
    port: integer(env.GEOMETRY_BRIDGE_PORT, 8087, "GEOMETRY_BRIDGE_PORT", 1, 65_535),
    transportToken: validateProviderTransportToken(env.PROVIDER_TRANSPORT_SHARED_TOKEN),
    provider: {
      endpoint: {
        endpointId: required(env, "GEOMETRY_BRIDGE_ENDPOINT_ID"),
        baseUrl: required(env, "GEOMETRY_BRIDGE_UPSTREAM_BASE_URL"),
        approvalStatus: "APPROVED",
        configurationDigest: digest(env, "GEOMETRY_BRIDGE_ENDPOINT_CONFIGURATION_DIGEST")
      },
      attestation: {
        sourceZipSha256: POC_SOURCE_ZIP_SHA256,
        openApiSha256: POC_OPENAPI_SHA256,
        engine: "GEOS-WASM-WORKER-POOL",
        geosVersion: required(env, "GEOMETRY_BRIDGE_GEOS_VERSION"),
        integration: "geos-wasm",
        integrationVersion: required(env, "GEOMETRY_BRIDGE_INTEGRATION_VERSION"),
        workerPoolEnabled: true,
        projectLicense: "MIT"
      },
      maximumInFlight: integer(env.GEOMETRY_BRIDGE_MAX_IN_FLIGHT, 32, "GEOMETRY_BRIDGE_MAX_IN_FLIGHT", 1, 1_024),
      maximumQueueSize: integer(env.GEOMETRY_BRIDGE_MAX_QUEUE_SIZE, 128, "GEOMETRY_BRIDGE_MAX_QUEUE_SIZE", 0, 100_000)
    }
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function digest(env: NodeJS.ProcessEnv, name: string): Sha256Digest {
  const value = required(env, name);
  if (!DIGEST.test(value)) throw new Error(`${name} must be a lowercase sha256:<64 hex> digest`);
  return value as Sha256Digest;
}

function integer(raw: string | undefined, fallback: number, name: string, minimum: number, maximum: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
