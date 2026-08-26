import { isAbsolute } from "node:path";
import {
  APPROVED_H3_TOOLKIT_BINDINGS_ARTIFACT_DIGESTS,
  CompositeH3ToolkitUpstream,
  H3_INTERACTIVE_OPERATION_IDS,
  H3ToolkitHttpClient,
  LockedExternalH3ToolkitAdapter,
  type H3ToolkitBridgeOptions,
  loadVerifiedH3Bindings,
  type Sha256Digest
} from "../../../../packages/integrations/h3-toolkit-bridge/src/index.js";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface H3InteractiveServerConfig {
  host: string;
  port: number;
  transportToken: string;
  provider: H3ToolkitBridgeOptions;
}

export interface H3InteractiveConfigOptions {
  /** Test/deployment-injection seam; production uses the committed empty-by-default approval lock. */
  approvedBindingDigests?: readonly Sha256Digest[];
  temporaryRoot?: string;
}

export async function loadH3InteractiveServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: H3InteractiveConfigOptions = {}
): Promise<H3InteractiveServerConfig> {
  const modulePath = required(env, "H3_TOOLKIT_BINDINGS_MODULE");
  if (!isAbsolute(modulePath)) throw new Error("H3_TOOLKIT_BINDINGS_MODULE must be an absolute deployment path");
  if (!modulePath.toLowerCase().endsWith(".mjs")) throw new Error("H3_TOOLKIT_BINDINGS_MODULE must be a self-contained .mjs artifact");
  const artifactDigest = digest(env, "H3_TOOLKIT_BINDINGS_MODULE_SHA256");
  const approvals = options.approvedBindingDigests ?? APPROVED_H3_TOOLKIT_BINDINGS_ARTIFACT_DIGESTS;
  if (!approvals.includes(artifactDigest)) {
    throw new Error("H3 Toolkit bindings artifact digest is not present in the committed source approval lock");
  }
  const bindings = await loadVerifiedH3Bindings(modulePath, artifactDigest, options.temporaryRoot);
  const http = new H3ToolkitHttpClient(endpoint(env));
  const embedded = new LockedExternalH3ToolkitAdapter(bindings, {
    supportedOperations: H3_INTERACTIVE_OPERATION_IDS,
    artifactDigest
  });
  return {
    host: env.H3_INTERACTIVE_PROVIDER_HOST?.trim() || "0.0.0.0",
    port: tcpPort(env.H3_INTERACTIVE_PROVIDER_PORT, 8088, "H3_INTERACTIVE_PROVIDER_PORT"),
    transportToken: validateProviderTransportToken(env.PROVIDER_TRANSPORT_SHARED_TOKEN),
    provider: { upstream: new CompositeH3ToolkitUpstream([http, embedded]) }
  };
}


function endpoint(env: NodeJS.ProcessEnv) {
  const authorization = env.H3_TOOLKIT_AUTHORIZATION?.trim();
  return {
    endpointId: required(env, "H3_TOOLKIT_ENDPOINT_ID"),
    baseUrl: required(env, "H3_TOOLKIT_BASE_URL"),
    approvalStatus: "APPROVED" as const,
    configurationDigest: digest(env, "H3_TOOLKIT_ENDPOINT_CONFIGURATION_DIGEST"),
    ...(authorization === undefined || authorization === "" ? {} : { authorization })
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
