import {
  H3ToolkitHttpClient,
  type H3ToolkitBridgeOptions,
  type Sha256Digest
} from "../../../../packages/integrations/h3-toolkit-bridge/src/index.js";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface H3AnalysisServerConfig {
  host: string;
  port: number;
  transportToken: string;
  provider: H3ToolkitBridgeOptions;
}

export function loadH3AnalysisServerConfig(env: NodeJS.ProcessEnv = process.env): H3AnalysisServerConfig {
  const authorization = env.H3_TOOLKIT_AUTHORIZATION?.trim();
  const upstream = new H3ToolkitHttpClient({
    endpointId: required(env, "H3_TOOLKIT_ENDPOINT_ID"),
    baseUrl: required(env, "H3_TOOLKIT_BASE_URL"),
    approvalStatus: "APPROVED",
    configurationDigest: digest(env, "H3_TOOLKIT_ENDPOINT_CONFIGURATION_DIGEST"),
    ...(authorization === undefined || authorization === "" ? {} : { authorization })
  });
  return {
    host: env.H3_ANALYSIS_PROVIDER_HOST?.trim() || "0.0.0.0",
    port: tcpPort(env.H3_ANALYSIS_PROVIDER_PORT, 8089, "H3_ANALYSIS_PROVIDER_PORT"),
    transportToken: validateProviderTransportToken(env.PROVIDER_TRANSPORT_SHARED_TOKEN),
    provider: { upstream }
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function digest(env: NodeJS.ProcessEnv, name: string): Sha256Digest {
  const value = required(env, name);
  if (!DIGEST.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return value as Sha256Digest;
}

function tcpPort(raw: string | undefined, fallback: number, name: string): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}
