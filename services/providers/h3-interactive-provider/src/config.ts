import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import {
  APPROVED_H3_TOOLKIT_BINDINGS_ARTIFACT_DIGESTS,
  CompositeH3ToolkitUpstream,
  H3_INTERACTIVE_OPERATION_IDS,
  H3ToolkitHttpClient,
  LockedExternalH3ToolkitAdapter,
  type H3ToolkitBridgeOptions,
  type LockedExternalH3ToolkitBindings,
  type Sha256Digest
} from "../../../../packages/integrations/h3-toolkit-bridge/src/index.js";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_BINDINGS_MODULE_BYTES = 8 * 1024 * 1024;

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
  const bindings = await loadBindings(modulePath, artifactDigest, options.temporaryRoot);
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

async function loadBindings(
  modulePath: string,
  expectedDigest: Sha256Digest,
  temporaryRoot = tmpdir()
): Promise<LockedExternalH3ToolkitBindings> {
  const bytes = await readVerifiedModule(modulePath, expectedDigest);
  const stagingDirectory = await mkdtemp(join(temporaryRoot, "gowm-h3-bindings-"));
  const stagedPath = join(stagingDirectory, "verified-bindings.mjs");
  let loaded: Record<string, unknown>;
  try {
    await writeFile(stagedPath, bytes, { flag: "wx", mode: 0o500 });
    loaded = await import(`${pathToFileURL(stagedPath).href}?digest=${expectedDigest.slice("sha256:".length)}`) as Record<string, unknown>;
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }
  const factory = loaded.createGowmH3ToolkitBindings;
  const candidate = typeof factory === "function"
    ? await (factory as () => unknown | Promise<unknown>)()
    : loaded.gowmH3ToolkitBindings ?? loaded.default;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("H3 Toolkit bindings module must export createGowmH3ToolkitBindings, gowmH3ToolkitBindings, or default bindings");
  }
  return candidate as LockedExternalH3ToolkitBindings;
}

async function readVerifiedModule(modulePath: string, expectedDigest: Sha256Digest): Promise<Buffer> {
  const pathStat = await lstat(modulePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error("H3 Toolkit bindings artifact must be a regular non-symlink file");
  }
  const noFollow = (constants as unknown as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
  const handle = await open(modulePath, constants.O_RDONLY | noFollow);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size < 1 || openedStat.size > MAX_BINDINGS_MODULE_BYTES) {
      throw new Error(`H3 Toolkit bindings artifact must be 1..${MAX_BINDINGS_MODULE_BYTES} bytes`);
    }
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    let totalBytes = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_BINDINGS_MODULE_BYTES) {
        throw new Error(`H3 Toolkit bindings artifact exceeds ${MAX_BINDINGS_MODULE_BYTES} bytes`);
      }
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      hash.update(chunk);
      chunks.push(chunk);
    }
    const actualDigest = `sha256:${hash.digest("hex")}`;
    if (actualDigest !== expectedDigest) {
      throw new Error("H3 Toolkit bindings artifact digest does not match the approved deployment digest");
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
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
