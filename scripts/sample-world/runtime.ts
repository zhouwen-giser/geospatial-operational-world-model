import { generateKeyPairSync, randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface SampleRuntimePaths {
  root: string;
  runtimeDirectory: string;
  generatedDirectory: string;
  outputDirectory: string;
  dockerConfigDirectory: string;
  envPath: string;
  consumerEnvPath: string;
  privateKeyPath: string;
  publicKeyPath: string;
}

export interface SampleRuntimeEnvironment {
  paths: SampleRuntimePaths;
  values: Record<string, string>;
}

export interface SamplePostgresEndpoint {
  host: string;
  port: number;
}

export const SAMPLE_RUNTIME_SECRET_NAMES = [
  "POSTGRES_PASSWORD",
  "STAS_DB_PASSWORD",
  "GATEWAY_DB_PASSWORD",
  "GATEWAY_REGISTRY_DB_PASSWORD",
  "SPATIAL_DB_PASSWORD",
  "REFERENCE_DB_PASSWORD",
  "CATALOG_DB_PASSWORD",
  "EVIDENCE_DB_PASSWORD",
  "VALIDATION_DB_PASSWORD",
  "SAMPLE_LOADER_DB_PASSWORD",
  "GROUNDING_CURSOR_HMAC_SECRET",
  "SPATIAL_CURSOR_HMAC_SECRET",
  "REFERENCE_CATALOG_PROVIDER_TRANSPORT_TOKEN",
  "DATASET_CATALOG_PROVIDER_TRANSPORT_TOKEN",
  "WORLD_EVIDENCE_PROVIDER_TRANSPORT_TOKEN",
  "SPATIAL_PROVIDER_TRANSPORT_TOKEN",
  "PLATFORM_VALIDATION_PROVIDER_TRANSPORT_TOKEN",
  "CRS_PROVIDER_TRANSPORT_TOKEN",
  "GEOMETRY_PROVIDER_TRANSPORT_TOKEN",
  "H3_ANALYSIS_PROVIDER_TRANSPORT_TOKEN",
  "H3_INTERACTIVE_PROVIDER_TRANSPORT_TOKEN",
  "NETWORK_PROVIDER_TRANSPORT_TOKEN",
  "OPERATIONAL_REALITY_PROVIDER_TRANSPORT_TOKEN",
  "COVERAGE_PROVIDER_TRANSPORT_TOKEN",
  "ROUTE_PROVIDER_TRANSPORT_TOKEN",
  "SITUATION_PROVIDER_TRANSPORT_TOKEN",
  "STAS_PROVIDER_TRANSPORT_TOKEN",
  "GOWM_WSGS_SAMPLE_TOKEN",
  "GOWM_WSGS_HIDDEN_TOKEN"
] as const;

const FIXED_RUNTIME_VALUES: Readonly<Record<string, string>> = {
  COMPOSE_PROJECT_NAME: "gowm-wsgs-sample",
  GATEWAY_BIND_ADDRESS: "127.0.0.1",
  GATEWAY_PORT: "18063",
  POSTGRES_BIND_ADDRESS: "127.0.0.1",
  POSTGRES_PORT: "55463",
  POSTGRES_DB: "gowm_wsgs_sample",
  GATEWAY_AUTH_MODE: "SIGNED_DELEGATION_V1",
  GATEWAY_RUNTIME_PRINCIPAL_REF: "service:wsgs",
  GATEWAY_DATA_SCOPE_CLAIM: "wsgs-demo",
  GATEWAY_DATASET_SCOPE_CLAIM: "wsgs-demo-main",
  GATEWAY_DELEGATION_ISSUER: "https://gowm.local/wsgs-sample",
  GATEWAY_DELEGATION_AUDIENCE: "gowm-world-gateway",
  GATEWAY_DELEGATION_MAX_TTL_SECONDS: "300",
  SAMPLE_WORLD_SEED: "gowm-wsgs-sample-world-v1"
};

export function sampleRuntimePaths(root = process.cwd()): SampleRuntimePaths {
  const runtimeDirectory = resolve(root, ".runtime/wsgs-sample");
  return {
    root: resolve(root),
    runtimeDirectory,
    generatedDirectory: resolve(runtimeDirectory, "generated"),
    outputDirectory: resolve(runtimeDirectory, "output"),
    dockerConfigDirectory: resolve(runtimeDirectory, "docker-config"),
    envPath: resolve(runtimeDirectory, "compose.env"),
    consumerEnvPath: resolve(runtimeDirectory, "wsgs-consumer-host.env"),
    privateKeyPath: resolve(runtimeDirectory, "delegation-private.pem"),
    publicKeyPath: resolve(runtimeDirectory, "delegation-public.pem")
  };
}

export function sampleGatewayBaseUrl(
  runtime: SampleRuntimeEnvironment,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const host = loopbackHost(environment.GATEWAY_BIND_ADDRESS ?? runtime.values.GATEWAY_BIND_ADDRESS ?? "127.0.0.1");
  const port = runtimePort(environment.GATEWAY_PORT ?? runtime.values.GATEWAY_PORT ?? "18063", "GATEWAY_PORT");
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export function samplePostgresEndpoint(
  runtime: SampleRuntimeEnvironment,
  environment: NodeJS.ProcessEnv = process.env
): SamplePostgresEndpoint {
  return {
    host: loopbackHost(environment.POSTGRES_BIND_ADDRESS ?? runtime.values.POSTGRES_BIND_ADDRESS ?? "127.0.0.1"),
    port: runtimePort(environment.POSTGRES_PORT ?? runtime.values.POSTGRES_PORT ?? "55463", "POSTGRES_PORT")
  };
}

export async function ensureSampleRuntimeEnvironment(root = process.cwd()): Promise<SampleRuntimeEnvironment> {
  const paths = sampleRuntimePaths(root);
  await Promise.all([
    mkdir(paths.runtimeDirectory, { recursive: true }),
    mkdir(paths.generatedDirectory, { recursive: true }),
    mkdir(paths.outputDirectory, { recursive: true }),
    mkdir(paths.dockerConfigDirectory, { recursive: true })
  ]);
  if (await exists(paths.envPath)) {
    const values = parseEnv(await readFile(paths.envPath, "utf8"));
    let migrated = false;
    for (const name of SAMPLE_RUNTIME_SECRET_NAMES) {
      if (!values[name]) {
        values[name] = randomBytes(32).toString("base64url");
        migrated = true;
      }
    }
    if (migrated) await writeFile(paths.envPath, serializeEnv(values), { encoding: "utf8", mode: 0o600 });
    validateRuntimeEnvironment(values, paths);
    await Promise.all([access(paths.privateKeyPath), access(paths.publicKeyPath)]);
    await writeConsumerEnvironment(paths, values);
    return { paths, values };
  }
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  await Promise.all([
    writeFile(paths.privateKeyPath, privateKey, { encoding: "utf8", mode: 0o600 }),
    writeFile(paths.publicKeyPath, publicKey, { encoding: "utf8", mode: 0o644 })
  ]);
  const values: Record<string, string> = {
    COMPOSE_PROJECT_NAME: "gowm-wsgs-sample",
    GATEWAY_BIND_ADDRESS: "127.0.0.1",
    GATEWAY_PORT: "18063",
    POSTGRES_BIND_ADDRESS: "127.0.0.1",
    POSTGRES_PORT: "55463",
    POSTGRES_DB: "gowm_wsgs_sample",
    GATEWAY_AUTH_MODE: "SIGNED_DELEGATION_V1",
    GATEWAY_RUNTIME_PRINCIPAL_REF: "service:wsgs",
    GATEWAY_DATA_SCOPE_CLAIM: "wsgs-demo",
    GATEWAY_DATASET_SCOPE_CLAIM: "wsgs-demo-main",
    GATEWAY_DELEGATION_ISSUER: "https://gowm.local/wsgs-sample",
    GATEWAY_DELEGATION_AUDIENCE: "gowm-world-gateway",
    GATEWAY_DELEGATION_MAX_TTL_SECONDS: "300",
    GATEWAY_DELEGATION_PUBLIC_KEY: publicKey.replaceAll("\r", "").replaceAll("\n", "\\n"),
    GOWM_WSGS_DELEGATION_PRIVATE_KEY_PATH: paths.privateKeyPath,
    SAMPLE_WORLD_EPOCH: new Date().toISOString(),
    SAMPLE_WORLD_SEED: "gowm-wsgs-sample-world-v1",
    SPATIAL_POSTGIS_VERSION: "3.6.4"
  };
  for (const name of SAMPLE_RUNTIME_SECRET_NAMES) values[name] = randomBytes(32).toString("base64url");
  validateRuntimeEnvironment(values, paths);
  await writeFile(paths.envPath, serializeEnv(values), { encoding: "utf8", mode: 0o600 });
  await writeConsumerEnvironment(paths, values);
  return { paths, values };
}

async function writeConsumerEnvironment(paths: SampleRuntimePaths, values: Record<string, string>): Promise<void> {
  const consumerValues: Record<string, string> = {
    GOWM_GATEWAY_BASE_URL: "http://127.0.0.1:18063",
    GOWM_GATEWAY_CONTAINER_BASE_URL: "http://host.docker.internal:18063",
    GOWM_WSGS_SAMPLE_TOKEN: values.GOWM_WSGS_SAMPLE_TOKEN!,
    GOWM_WSGS_DELEGATION_PRIVATE_KEY_PATH: paths.privateKeyPath,
    GATEWAY_DELEGATION_ISSUER: values.GATEWAY_DELEGATION_ISSUER!,
    GATEWAY_RUNTIME_PRINCIPAL_REF: values.GATEWAY_RUNTIME_PRINCIPAL_REF!,
    GATEWAY_DELEGATION_AUDIENCE: values.GATEWAY_DELEGATION_AUDIENCE!,
    GATEWAY_DATA_SCOPE_CLAIM: values.GATEWAY_DATA_SCOPE_CLAIM!,
    GATEWAY_DATASET_SCOPE_CLAIM: values.GATEWAY_DATASET_SCOPE_CLAIM!,
    GATEWAY_DELEGATION_MAX_TTL_SECONDS: values.GATEWAY_DELEGATION_MAX_TTL_SECONDS!
  };
  await writeFile(paths.consumerEnvPath, serializeEnv(consumerValues), { encoding: "utf8", mode: 0o600 });
}

export function parseEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("Invalid sample runtime env line");
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function serializeEnv(values: Record<string, string>): string {
  return `${Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
}

export function validateRuntimeEnvironment(
  values: Readonly<Record<string, string>>,
  paths: SampleRuntimePaths = sampleRuntimePaths()
): void {
  const required = [
    ...SAMPLE_RUNTIME_SECRET_NAMES,
    ...Object.keys(FIXED_RUNTIME_VALUES),
    "GATEWAY_DELEGATION_PUBLIC_KEY",
    "GOWM_WSGS_DELEGATION_PRIVATE_KEY_PATH",
    "SAMPLE_WORLD_EPOCH"
  ];
  for (const name of required) if (!values[name]) throw new Error(`Sample runtime env is missing ${name}`);
  for (const [name, expected] of Object.entries(FIXED_RUNTIME_VALUES)) {
    if (values[name] !== expected) {
      throw new Error(`Sample runtime env fixed value mismatch: ${name}`);
    }
  }
  if (resolve(values.GOWM_WSGS_DELEGATION_PRIVATE_KEY_PATH!) !== paths.privateKeyPath) {
    throw new Error("Sample runtime delegation private-key path mismatch");
  }
  if (!values.GATEWAY_DELEGATION_PUBLIC_KEY!.includes("BEGIN PUBLIC KEY")) {
    throw new Error("Sample runtime delegation public key is malformed");
  }
  if (Number.isNaN(Date.parse(values.SAMPLE_WORLD_EPOCH!))) {
    throw new Error("Sample runtime epoch is not a valid date-time");
  }
  const secretValues = SAMPLE_RUNTIME_SECRET_NAMES.map((name) => values[name]!);
  if (secretValues.some((value) => value.length < 32) || new Set(secretValues).size !== secretValues.length) {
    throw new Error("Sample runtime secrets must be unique and at least 32 characters");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function loopbackHost(value: string): string {
  const host = value.trim().toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Sample runtime endpoint overrides must remain loopback-only");
  }
  return host;
}

function runtimePort(value: string, name: string): number {
  if (!/^\d{1,5}$/u.test(value)) throw new Error(`Sample runtime ${name} must be a decimal TCP port`);
  const port = Number(value);
  if (port < 1 || port > 65_535) throw new Error(`Sample runtime ${name} is outside the TCP port range`);
  return port;
}
