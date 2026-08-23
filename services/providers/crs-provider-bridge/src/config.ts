import { POC_OPENAPI_SHA256, POC_SOURCE_ZIP_SHA256 } from "./schemas.js";
import type { CrsProviderBridgeOptions, Sha256Digest } from "./types.js";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface CrsBridgeServerConfig {
  host: string;
  port: number;
  transportToken: string;
  provider: CrsProviderBridgeOptions;
}

export function loadCrsBridgeServerConfig(env: NodeJS.ProcessEnv = process.env): CrsBridgeServerConfig {
  if (required(env, "CRS_BRIDGE_ENDPOINT_APPROVAL_STATUS") !== "APPROVED") {
    throw new Error("CRS_BRIDGE_ENDPOINT_APPROVAL_STATUS must be APPROVED");
  }
  return {
    host: env.CRS_BRIDGE_HOST?.trim() || "0.0.0.0",
    port: positiveInteger(env.CRS_BRIDGE_PORT, 8086, "CRS_BRIDGE_PORT"),
    transportToken: validateProviderTransportToken(env.PROVIDER_TRANSPORT_SHARED_TOKEN),
    provider: {
      endpoint: {
        endpointId: required(env, "CRS_BRIDGE_ENDPOINT_ID"),
        baseUrl: required(env, "CRS_BRIDGE_UPSTREAM_BASE_URL"),
        approvalStatus: "APPROVED",
        configurationDigest: digest(env, "CRS_BRIDGE_ENDPOINT_CONFIGURATION_DIGEST")
      },
      attestation: {
        sourceZipSha256: POC_SOURCE_ZIP_SHA256,
        openApiSha256: POC_OPENAPI_SHA256,
        projVersion: required(env, "CRS_BRIDGE_PROJ_VERSION"),
        integration: "gdal-async",
        integrationVersion: required(env, "CRS_BRIDGE_INTEGRATION_VERSION"),
        projDbVersion: required(env, "CRS_BRIDGE_PROJ_DB_VERSION"),
        projDbSha256: digest(env, "CRS_BRIDGE_PROJ_DB_SHA256"),
        gridBundleVersion: required(env, "CRS_BRIDGE_GRID_BUNDLE_VERSION"),
        gridBundleSha256: digest(env, "CRS_BRIDGE_GRID_BUNDLE_SHA256"),
        strictBestOperation: true,
        networkEnabled: false
      }
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

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535`);
  }
  return value;
}
