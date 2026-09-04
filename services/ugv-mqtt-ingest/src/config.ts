import { lstat,readFile,realpath } from "node:fs/promises";
import { DEFAULT_UGV_SAMPLING_POLICY, type UgvSamplingPolicy } from "../../../packages/integrations/ugv-mqtt-ingest-core/src/sampling.js";

export interface UgvIngestConfig {
  databaseUrl: string; mqttUrl: string; clientId: string; username?: string; password?: Buffer;
  ca?: Buffer; cert?: Buffer; key?: Buffer; sessionExpirySeconds: number; keepaliveSeconds: number;
  connectTimeoutMs: number; maxPayloadBytes: number; deviceId: string; dataScopeKey: string;
  originKind: "SIMULATION"; sourceKey: string; producerPipelineKey: string; scenarioId: string;
  worldEpoch: string; trackerSessionKey: string; analysisSpaceKey: string; analysisSrid: number;
  observationApiUrl: string; arrivalUncertaintyMs: number; port: number; codeVersion: string;
  maximumPendingInbox: number; maxTargetsPerFrame: number; httpTimeoutMs: number;
  receiveMaximum: number; processConcurrency: number; deliveryConcurrency: number;
  faultExitAfterInboxCommits?: number;
  samplingPolicy: UgvSamplingPolicy;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function integer(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback),10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
function numeric(name: string,fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}
function optionalPositiveInteger(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer when set`);
  return value;
}
async function optionalFile(name: string): Promise<Buffer | undefined> {
  const path = process.env[name]?.trim();
  if (!path) return undefined;
  if (!path.startsWith("/")) throw new Error(`${name} must be an absolute path`);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must name a regular, non-symlink file`);
  return readFile(await realpath(path));
}

function serviceUrl(name: string,value: string,protocols: string[]): string {
  const parsed = new URL(value);
  if (!protocols.includes(parsed.protocol)) throw new Error(`${name} uses unsupported protocol ${parsed.protocol}`);
  if (parsed.username || parsed.password) throw new Error(`${name} must not embed credentials; use the file-based credential settings`);
  return parsed.toString();
}

export async function loadUgvIngestConfig(): Promise<UgvIngestConfig> {
  const origin = process.env.UGV_ORIGIN_KIND ?? "SIMULATION";
  if (origin !== "SIMULATION") throw new Error("UGV_ORIGIN_KIND must be SIMULATION for this adapter");
  const analysisSrid = integer("UGV_ANALYSIS_SRID",32648);
  if (analysisSrid !== 32648) throw new Error("airport UGV analysis SRID must be EPSG:32648");
  const password = await optionalFile("UGV_MQTT_PASSWORD_FILE");
  const ca = await optionalFile("UGV_MQTT_CA_FILE");
  const cert = await optionalFile("UGV_MQTT_CERT_FILE");
  const key = await optionalFile("UGV_MQTT_KEY_FILE");
  const clientId = process.env.UGV_MQTT_CLIENT_ID ?? "gowm-ugv-ingest-airport-01";
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(clientId)) throw new Error("UGV_MQTT_CLIENT_ID must be a stable literal identifier");
  const maxTargetsPerFrame = integer("UGV_MQTT_MAX_TARGETS_PER_FRAME",256);
  if (maxTargetsPerFrame > 256) throw new Error("UGV_MQTT_MAX_TARGETS_PER_FRAME must not exceed the source contract ceiling of 256");
  const receiveMaximum = integer("UGV_MQTT_RECEIVE_MAXIMUM",1);
  if (receiveMaximum > 65_535) throw new Error("UGV_MQTT_RECEIVE_MAXIMUM must be at most 65535");
  const processConcurrency = integer("UGV_MQTT_PROCESS_CONCURRENCY",8);
  const deliveryConcurrency = integer("UGV_MQTT_DELIVERY_CONCURRENCY",8);
  if (processConcurrency > 64 || deliveryConcurrency > 64) throw new Error("UGV MQTT worker concurrency must not exceed 64");
  const faultExitAfterInboxCommits = optionalPositiveInteger("UGV_MQTT_FAULT_EXIT_AFTER_INBOX_COMMITS");
  const samplingPolicy: UgvSamplingPolicy = {
    version: process.env.UGV_MQTT_SAMPLING_POLICY_VERSION ?? DEFAULT_UGV_SAMPLING_POLICY.version,
    gnssMinimumIntervalMs: integer("UGV_MQTT_GNSS_MIN_INTERVAL_MS",DEFAULT_UGV_SAMPLING_POLICY.gnssMinimumIntervalMs),
    gnssForceDisplacementM: numeric("UGV_MQTT_GNSS_FORCE_DISPLACEMENT_M",DEFAULT_UGV_SAMPLING_POLICY.gnssForceDisplacementM),
    gnssHeartbeatMs: integer("UGV_MQTT_GNSS_HEARTBEAT_MS",DEFAULT_UGV_SAMPLING_POLICY.gnssHeartbeatMs),
    speedMinimumIntervalMs: integer("UGV_MQTT_SPEED_MIN_INTERVAL_MS",DEFAULT_UGV_SAMPLING_POLICY.speedMinimumIntervalMs),
    speedForceDeltaMps: numeric("UGV_MQTT_SPEED_FORCE_DELTA_MPS",DEFAULT_UGV_SAMPLING_POLICY.speedForceDeltaMps),
    platformMinimumIntervalMs: integer("UGV_MQTT_PLATFORM_MIN_INTERVAL_MS",DEFAULT_UGV_SAMPLING_POLICY.platformMinimumIntervalMs),
    chassisProgressDeltaPercent: numeric("UGV_MQTT_CHASSIS_PROGRESS_DELTA_PERCENT",DEFAULT_UGV_SAMPLING_POLICY.chassisProgressDeltaPercent),
    chassisHeartbeatMs: integer("UGV_MQTT_CHASSIS_HEARTBEAT_MS",DEFAULT_UGV_SAMPLING_POLICY.chassisHeartbeatMs),
    reconMinimumIntervalMs: integer("UGV_MQTT_RECON_MIN_INTERVAL_MS",DEFAULT_UGV_SAMPLING_POLICY.reconMinimumIntervalMs),
    reconCoverageDeltaPercent: numeric("UGV_MQTT_RECON_COVERAGE_DELTA_PERCENT",DEFAULT_UGV_SAMPLING_POLICY.reconCoverageDeltaPercent),
    targetMinimumIntervalMs: integer("UGV_MQTT_TARGET_MIN_INTERVAL_MS",DEFAULT_UGV_SAMPLING_POLICY.targetMinimumIntervalMs)
  };
  return {
    databaseUrl: required("DATABASE_URL"),mqttUrl: serviceUrl("UGV_MQTT_URL",required("UGV_MQTT_URL"),["mqtt:","mqtts:","ws:","wss:"]),
    clientId,
    ...(process.env.UGV_MQTT_USERNAME ? { username: process.env.UGV_MQTT_USERNAME } : {}),
    ...(password ? { password } : {}),...(ca ? { ca } : {}),...(cert ? { cert } : {}),...(key ? { key } : {}),
    sessionExpirySeconds: integer("UGV_MQTT_SESSION_EXPIRY_SECONDS",86400),keepaliveSeconds: integer("UGV_MQTT_KEEPALIVE_SECONDS",30),
    connectTimeoutMs: integer("UGV_MQTT_CONNECT_TIMEOUT_MS",5000),maxPayloadBytes: integer("UGV_MQTT_MAX_PAYLOAD_BYTES",1048576),
    deviceId: process.env.UGV_DEVICE_ID ?? "ugv",dataScopeKey: process.env.UGV_DATA_SCOPE_KEY ?? "airport-sim-ugv-01",
    originKind: "SIMULATION",sourceKey: process.env.UGV_SOURCE_KEY ?? "ugv-airport-sim-mqtt",
    producerPipelineKey: process.env.UGV_PRODUCER_PIPELINE_KEY ?? "ugv-airport-sim-mqtt:canonical-v1",
    scenarioId: process.env.UGV_SCENARIO_ID ?? "airport",worldEpoch: required("UGV_WORLD_EPOCH"),
    trackerSessionKey: required("UGV_TRACKER_SESSION_KEY"),analysisSpaceKey: process.env.UGV_ANALYSIS_SPACE_KEY ?? "airport-utm48n",
    analysisSrid,observationApiUrl: serviceUrl("GOWM_OBSERVATION_API_URL",
      process.env.GOWM_OBSERVATION_API_URL ?? "http://observation-ingest:3002",["http:","https:"]),
    arrivalUncertaintyMs: integer("UGV_MQTT_ARRIVAL_TIME_UNCERTAINTY_MS",1000),port: integer("UGV_MQTT_INGEST_PORT",3010),
    codeVersion: process.env.SERVICE_REVISION ?? "dev",maximumPendingInbox: integer("UGV_MQTT_MAX_PENDING_INBOX",10_000),
    maxTargetsPerFrame,httpTimeoutMs: integer("UGV_MQTT_HTTP_TIMEOUT_MS",5_000),receiveMaximum,processConcurrency,deliveryConcurrency,
    ...(faultExitAfterInboxCommits === undefined ? {} : { faultExitAfterInboxCommits }),samplingPolicy
  };
}
